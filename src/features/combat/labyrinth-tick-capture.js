/**
 * Labyrinth tick capture
 *
 * The fight recorder keeps endpoints — how much damage, how long — which is
 * enough to measure a rate and say the sim is over- or under-crediting a side.
 * It is not enough to say *why*. "The monster's stun is under-modelled" is a
 * claim about the moment-to-moment feed: how often your attack counter stalls,
 * how often the monster casts, how much each hit lands for. Those live in the
 * ticks, not in the totals.
 *
 * So this keeps the ticks. It records the ordered `battle_updated` stream — both
 * sides' health, mana and counters, three times a second — and the `new_battle`
 * that names the units and their abilities, exactly as they arrive, timestamped
 * so a replay can reconstruct the timeline. It is the raw feed the console
 * `Toolasha.Debug.captureLab` produced, as a button and a downloadable file.
 *
 * Bounded, because ticks arrive several times a second and an armed capture left
 * running is a tab that grows until it falls over — and time-bounded too, so a
 * capture nobody stopped stops itself. One fight is ~360 ticks; the cap holds
 * tens of fights, and past it the oldest ticks fall off so the recent fight is
 * always the one kept.
 */

import webSocketHook from '../../core/websocket.js';
import { FINGERPRINT_SPEC } from './labyrinth-recommendation.js';
import { scriptVersion } from '../../utils/script-version.js';

/** Ticks kept before the oldest fall off — far more than one fight, bounded so a tab can't grow forever */
const MAX_TICKS = 8000;

/**
 * A capture nobody stopped stops itself here, so an armed one is never left running.
 * Sized so the harness can collect enough fights for its cadence/hit-rate verdicts
 * to firm up (15 min gave ~40 casts of each special — ~2σ territory); the 8000-tick
 * ring holds ~95 min at observed lab tick rates, so an hour never drops ticks.
 */
const MAX_CAPTURE_MS = 60 * 60 * 1000;

let capturing = false;
let startedAt = 0;
let ticks = [];
let context = null;
let handlers = null;
let autoStopTimer = null;
/** The monster this capture is for; a fresh fight against a different one ends it */
let targetMonster = null;
/**
 * Adjacent battle_updated ticks whose payload was byte-identical to the one
 * before them, dropped rather than kept. The websocket hook no longer echoes
 * every message twice, so what lands here now is the game server genuinely
 * repeating a tick — worth counting either way, because a capture that silently
 * contains doubles reads as twice the cadence it really had.
 */
let duplicatesDiscarded = 0;
/** The last battle_updated payload kept, serialized, for the adjacency check */
let lastBattleKey = null;
/**
 * When the held ticks were last written out, or null while unsaved. The room-log
 * button reads this to tell "stopped, holding an unsaved capture" (offer Save)
 * from "stopped and already saved" (offer a fresh Capture) — without it a saved
 * capture would sit offering the same download forever.
 */
let savedAt = null;
/**
 * Names this capture in exports, so an accuracy file can say which tick file it
 * pairs with. New on every start, stable for the capture's whole life.
 */
let captureId = null;
/** Ticks the ring buffer trimmed away — 0 means the file holds everything heard */
let ticksDropped = 0;
/** 'manual' | 'auto_max_duration' | 'left_monster', or null while running / before any stop */
let stoppedReason = null;
/** Monotonic tail for captureId, so two starts in one millisecond still differ */
let captureSeq = 0;
/** The last capture written out as a file, for exports to pair against; survives clear/start */
let lastSavedRef = null;

/** The first monster's hrid in a `new_battle` payload, or null. */
function firstMonsterHrid(payload) {
    const monsters = Array.isArray(payload?.monsters) ? payload.monsters : Object.values(payload?.monsters || {});
    return monsters[0]?.hrid || null;
}

/** @returns {boolean} Whether a capture is running */
export function isCapturing() {
    return capturing;
}

/**
 * Fill the monster into the capture's context from a `new_battle`, so the file
 * says what it is even when the caller had no room context to pass — the panel's
 * labyrinth grid is not always populated when Capture is pressed, but the fight
 * itself always names its monster.
 * @param {Object} payload - A new_battle payload
 */
function labelFromBattle(payload) {
    if (context && context.monsterHrid) return;
    const monsters = Array.isArray(payload?.monsters) ? payload.monsters : Object.values(payload?.monsters || {});
    const monster = monsters[0];
    if (monster?.hrid) {
        context = { ...(context || {}), monsterHrid: monster.hrid, monsterName: monster.name || null };
    }
}

/**
 * One tick, timestamped from the capture's start so a replay reproduces timing.
 * @param {string} type - Which message
 * @param {Object} payload - What it carried, trimmed to what a fight needs
 */
function push(type, payload) {
    if (!capturing) return;
    if (type === 'new_battle') {
        // End the capture when the fight moves off the monster it is for. Clearing
        // the room (or dying out of the labyrinth) sends you to the next fight — a
        // different monster, or your main-game action — and recording that pollutes
        // the file with a fight the harness is not comparing against. The fights
        // captured so far are kept; retries against the same monster keep recording.
        if (targetMonster) {
            const hrid = firstMonsterHrid(payload);
            if (hrid && hrid !== targetMonster) {
                endCapture('left_monster');
                return;
            }
        }
        labelFromBattle(payload);
    }
    if (type === 'battle_updated') {
        // Drop an exact repeat of the tick before it. Only battle_updated:
        // two identical new_battle messages are two real fights, never noise.
        // battle_updated carries no timestamp or sequence number, so payload
        // identity is the only key there is.
        let key = null;
        try {
            key = JSON.stringify(payload);
        } catch {
            // Unserializable payload: keep it rather than guess
        }
        if (key !== null && key === lastBattleKey) {
            duplicatesDiscarded++;
            return;
        }
        if (key !== null) lastBattleKey = key;
    }
    ticks.push({ at: Date.now() - startedAt, type, payload });
    // Keep the newest: a long capture that overflows should hold the recent
    // fight, not the one it opened on. Counted, so an overflowed capture's file
    // says it is a window, not the whole feed.
    if (ticks.length > MAX_TICKS) {
        ticksDropped += ticks.length - MAX_TICKS;
        ticks = ticks.slice(ticks.length - MAX_TICKS);
    }
}

/**
 * Start recording the raw combat feed.
 *
 * @param {Object} [ctx] - What is being fought, for the file —
 *   `{ monsterHrid, roomLevel, fingerprint }`. `fingerprint` is the gear/build
 *   fingerprint the fight is fought in (the fight recorder's), kept in the
 *   file's context so the uptime harness can refuse to compare ticks from one
 *   build against a sim of another.
 * @param {Object} [opts]
 * @param {boolean} [opts.stopOnLeave=true] - End the capture when a fight against
 *   a different monster begins (so clearing the room doesn't record what comes
 *   after). Only applies when `ctx.monsterHrid` is set; a general capture with no
 *   target monster records until stopped.
 */
export function startCapture(ctx = null, { stopOnLeave = true } = {}) {
    stopCapture();
    capturing = true;
    startedAt = Date.now();
    ticks = [];
    duplicatesDiscarded = 0;
    lastBattleKey = null;
    savedAt = null;
    captureId = `${Date.now().toString(36)}-${(captureSeq++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    ticksDropped = 0;
    stoppedReason = null;
    context = ctx || null;
    targetMonster = stopOnLeave ? ctx?.monsterHrid || null : null;

    // Both sides' health/mana/counters, and the message that names the units and
    // their abilities. `battle_updated` is trimmed to what a fight reads; the
    // rest (chat, ids) is noise a capture does not need.
    const onBattle = (data) => push('battle_updated', { pMap: data?.pMap, mMap: data?.mMap, battleId: data?.battleId });
    const onNew = (data) => push('new_battle', data);

    webSocketHook.on('battle_updated', onBattle);
    webSocketHook.on('new_battle', onNew);
    handlers = { onBattle, onNew };

    autoStopTimer = setTimeout(() => endCapture('auto_max_duration'), MAX_CAPTURE_MS);
}

/**
 * The one stop path, so the file can say how the capture ended. Only a running
 * capture takes the reason — a redundant stop must not relabel a finished one.
 * @param {string} reason - 'manual' | 'auto_max_duration' | 'left_monster'
 */
function endCapture(reason) {
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    if (handlers) {
        webSocketHook.off('battle_updated', handlers.onBattle);
        webSocketHook.off('new_battle', handlers.onNew);
        handlers = null;
    }
    if (capturing) stoppedReason = reason;
    capturing = false;
}

/** Stop recording. What was captured stays captured, for the file. */
export function stopCapture() {
    endCapture('manual');
}

/** Throw away the captured ticks. The ref to the last saved file survives. */
export function clearCapture() {
    ticks = [];
    startedAt = 0;
    context = null;
    targetMonster = null;
    duplicatesDiscarded = 0;
    lastBattleKey = null;
    savedAt = null;
    captureId = null;
    ticksDropped = 0;
    stoppedReason = null;
}

/**
 * How much has been captured, for the button to read.
 * @returns {{capturing: boolean, ticks: number, seconds: number, duplicatesDiscarded: number,
 *   savedAt: number|null, captureId: string|null, ticksDropped: number, stoppedReason: string|null}}
 */
export function captureStatus() {
    return {
        capturing,
        ticks: ticks.length,
        seconds: startedAt ? (Date.now() - startedAt) / 1000 : 0,
        duplicatesDiscarded,
        savedAt,
        captureId,
        ticksDropped,
        stoppedReason,
    };
}

/**
 * The capture in a shape safe to write out and read back.
 *
 * Carries what a reader needs to reproduce the run: which script produced it,
 * against which server (live and test do not share balance), and how many
 * repeated ticks were dropped — a capture whose duplicates were silently kept
 * would read as twice the cadence it really had.
 * @returns {Object}
 */
export function captureFile() {
    const host = typeof location !== 'undefined' ? location.hostname || null : null;
    // Stalls in the retained feed: a reader trusting tick cadence needs to know
    // where the stream went quiet (tab throttled, connection dropped). One O(n)
    // pass here, not per-tick bookkeeping.
    let maxGapMs = null;
    let gapsOver5s = 0;
    for (let i = 1; i < ticks.length; i++) {
        const gap = ticks[i].at - ticks[i - 1].at;
        if (maxGapMs === null || gap > maxGapMs) maxGapMs = gap;
        if (gap > 5000) gapsOver5s++;
    }
    return {
        format: 'toolasha-labyrinth-tick-capture',
        version: 2,
        toolashaVersion: scriptVersion(),
        host,
        isTestServer: host ? host.includes('test.') : null,
        recordedAt: startedAt || null,
        exportedAt: Date.now(),
        savedAt,
        captureId,
        context: context || null,
        fingerprintSpec: FINGERPRINT_SPEC,
        duplicatesDiscarded,
        ticksDropped,
        stoppedReason,
        maxGapMs,
        gapsOver5s,
        ticks: ticks.map((tick) => ({ ...tick })),
    };
}

/**
 * Write the capture out as a file.
 * @returns {boolean} Whether there was anything to write
 */
export function downloadCapture() {
    if (!ticks.length) return false;
    try {
        // Stamped into the file itself, so what is on disk agrees with the
        // savedAt an accuracy export quotes for it — not only the in-memory copy
        const now = Date.now();
        const blob = new Blob([JSON.stringify({ ...captureFile(), savedAt: now })], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `toolasha-labyrinth-ticks-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        // The ticks stay held (the uptime harness reuses a stopped capture),
        // but the button no longer needs to offer this download again
        savedAt = now;
        // The written file is now the one exports can pair against, so the ref
        // outlives the clear-after-save the button does next
        lastSavedRef = {
            captureId,
            savedAt,
            monsterHrid: context?.monsterHrid ?? null,
            roomLevel: context?.roomLevel ?? null,
        };
        return true;
    } catch (error) {
        console.error('[LabyrinthTickCapture] Writing the capture failed:', error);
        return false;
    }
}

/**
 * The most recently saved capture file, so an accuracy/replay export can name
 * the tick file it pairs with. Null until a capture has been downloaded;
 * survives clearCapture and later starts — it describes the file on disk, not
 * the ticks in memory.
 * @returns {{captureId: string|null, savedAt: number, monsterHrid: string|null,
 *   roomLevel: number|null}|null}
 */
export function lastCaptureRef() {
    return lastSavedRef ? { ...lastSavedRef } : null;
}

export default {
    isCapturing,
    startCapture,
    stopCapture,
    clearCapture,
    captureStatus,
    captureFile,
    downloadCapture,
    lastCaptureRef,
};
