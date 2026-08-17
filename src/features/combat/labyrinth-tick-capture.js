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

/** Ticks kept before the oldest fall off — far more than one fight, bounded so a tab can't grow forever */
const MAX_TICKS = 8000;

/** A capture nobody stopped stops itself here, so an armed one is never left running */
const MAX_CAPTURE_MS = 15 * 60 * 1000;

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
                stopCapture();
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
    // fight, not the one it opened on
    if (ticks.length > MAX_TICKS) ticks = ticks.slice(ticks.length - MAX_TICKS);
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

    autoStopTimer = setTimeout(() => stopCapture(), MAX_CAPTURE_MS);
}

/** Stop recording. What was captured stays captured, for the file. */
export function stopCapture() {
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    if (handlers) {
        webSocketHook.off('battle_updated', handlers.onBattle);
        webSocketHook.off('new_battle', handlers.onNew);
        handlers = null;
    }
    capturing = false;
}

/** Throw away the captured ticks. */
export function clearCapture() {
    ticks = [];
    startedAt = 0;
    context = null;
    targetMonster = null;
    duplicatesDiscarded = 0;
    lastBattleKey = null;
    savedAt = null;
}

/**
 * How much has been captured, for the button to read.
 * @returns {{capturing: boolean, ticks: number, seconds: number, duplicatesDiscarded: number,
 *   savedAt: number|null}}
 */
export function captureStatus() {
    return {
        capturing,
        ticks: ticks.length,
        seconds: startedAt ? (Date.now() - startedAt) / 1000 : 0,
        duplicatesDiscarded,
        savedAt,
    };
}

/** The script version, when the userscript sandbox is there to ask. */
function scriptVersion() {
    try {
        return typeof GM_info !== 'undefined' ? GM_info?.script?.version || null : null;
    } catch {
        return null;
    }
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
    return {
        format: 'toolasha-labyrinth-tick-capture',
        version: 2,
        toolashaVersion: scriptVersion(),
        host,
        isTestServer: host ? host.includes('test.') : null,
        recordedAt: startedAt || null,
        exportedAt: Date.now(),
        context: context || null,
        duplicatesDiscarded,
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
        const blob = new Blob([JSON.stringify(captureFile())], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `toolasha-labyrinth-ticks-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        // The ticks stay held (the uptime harness reuses a stopped capture),
        // but the button no longer needs to offer this download again
        savedAt = Date.now();
        return true;
    } catch (error) {
        console.error('[LabyrinthTickCapture] Writing the capture failed:', error);
        return false;
    }
}

export default {
    isCapturing,
    startCapture,
    stopCapture,
    clearCapture,
    captureStatus,
    captureFile,
    downloadCapture,
};
