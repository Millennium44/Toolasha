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
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import { FINGERPRINT_SPEC } from './labyrinth-recommendation.js';
import { scriptVersion } from '../../utils/script-version.js';

/** Ticks kept before the oldest fall off — far more than one fight, bounded so a tab can't grow forever */
const MAX_TICKS = 8000;

/**
 * Where an unsaved capture is autosaved, scoped per character so a crash or a
 * reload does not cost the ticks a Save dialog never confirmed.
 */
const AUTOSAVE_KEY = 'labyrinthTickCaptureAutosave';
const AUTOSAVE_STORE = 'labyrinth';

/**
 * How often the tick loop writes the autosave while ticks are accumulating.
 * `captureFile()` walks every retained tick for its gap stats, so writing it
 * on every tick would cost real time on the socket handler; ten seconds bounds
 * the loss to at most this long of ticks, which a reload recovers the rest of.
 */
const AUTOSAVE_INTERVAL_MS = 10_000;

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
/**
 * 'manual' | 'auto_max_duration' | 'left_monster' | 'page_reload' (recovered
 * from the autosave, whichever way it really ended), or null while running /
 * before any stop.
 */
let stoppedReason = null;
/** Monotonic tail for captureId, so two starts in one millisecond still differ */
let captureSeq = 0;
/** The last capture written out as a file, for exports to pair against; survives clear/start */
let lastSavedRef = null;
let initialClientBuild = null;
/**
 * Which character the held ticks belong to, fixed at the moment the capture
 * started — never re-read from `dataManager` while ticks are held, so a
 * character switch mid-capture cannot move the autosave under the arriving
 * character's key (the capture-identity-before-the-await bug class). Null
 * when nothing is held.
 */
let autosaveOwnerId = null;
/** `Date.now()` of the last autosave write, so the tick loop is not slowed by writing every tick */
let lastAutosaveAt = 0;
/**
 * A restored capture's recorded span, in ms — the last tick's own `at` (already
 * elapsed-since-start), read once at restore time. Null for a live capture,
 * whose `seconds` is measured off `startedAt` and the real clock instead.
 * `startedAt` on a restored capture is the ORIGINAL session's wall-clock start
 * (kept for `recordedAt`'s sake), which can be hours or days behind `Date.now()`
 * by the time it is recovered — `captureStatus().seconds` must not compute off
 * that gap, which is elapsed *wall time since the original capture*, not the
 * capture's own duration.
 */
let restoredDurationMs = null;

/** The autosave key for one character, mirroring `character-key.js`'s `${base}_${id}` idiom. */
function autosaveKey(ownerId) {
    return `${AUTOSAVE_KEY}_${ownerId || 'default'}`;
}

/**
 * Persist the held ticks so a crash, a closed tab, or a Save dialog the user
 * cancelled does not cost them. Fire-and-forget: a lost autosave write costs
 * at most one interval of ticks, not the run, and the tick loop must not wait
 * on IndexedDB.
 *
 * Kept regardless of `savedAt` — a click on Save is not proof the file landed
 * (Firefox's Save dialog can be cancelled), so the autosave outlives it and is
 * only ever cleared by an explicit Discard or a confirmed new capture.
 *
 * @param {boolean} [immediate=false] - Skip `storage.set`'s debounce. The
 *   periodic in-progress write (`maybeAutosave`) leaves it debounced — a burst
 *   of ticks near the interval boundary should still coalesce into one write —
 *   but the on-stop write (`endCapture`) and the post-download refresh pass
 *   `true`: those are the moments most likely to be followed by a crash or a
 *   closed tab, and a debounced write queued right before either is lost.
 */
function writeAutosave(immediate = false) {
    if (!ticks.length || !autosaveOwnerId) return;
    // Recorders of bulky history stand down under quota pressure rather than
    // spend every write failing the same way; this is that same convention.
    if (storage.isQuotaExceeded?.()) return;
    lastAutosaveAt = Date.now();
    try {
        Promise.resolve(storage.set(autosaveKey(autosaveOwnerId), captureFile(), AUTOSAVE_STORE, immediate)).catch(
            (error) => console.error('[LabyrinthTickCapture] Autosaving the capture failed:', error)
        );
    } catch (error) {
        console.error('[LabyrinthTickCapture] Autosaving the capture failed:', error);
    }
}

/** Throttled autosave for the tick loop — at most once per {@link AUTOSAVE_INTERVAL_MS}. */
function maybeAutosave() {
    if (Date.now() - lastAutosaveAt < AUTOSAVE_INTERVAL_MS) return;
    writeAutosave();
}

/** Drop one character's autosaved copy. Fire-and-forget, like {@link writeAutosave}. */
function clearAutosave(ownerId) {
    if (!ownerId) return;
    Promise.resolve(storage.delete(autosaveKey(ownerId), AUTOSAVE_STORE)).catch((error) =>
        console.error('[LabyrinthTickCapture] Clearing the autosaved capture failed:', error)
    );
}

/** A detached, identity-free view of the build the client currently knows. */
function clientBuild() {
    return {
        equipment: Array.from(dataManager.getEquipment(), ([slot, item]) => ({
            slot,
            itemHrid: item.itemHrid,
            enhancementLevel: item.enhancementLevel || 0,
        })),
        abilities: (dataManager.getEquippedAbilities?.() || []).map((ability) => ({
            abilityHrid: ability.abilityHrid,
            level: ability.level,
            slotNumber: ability.slotNumber,
        })),
    };
}

/** The first monster in a `new_battle` payload, or null. */
function firstMonster(payload) {
    const monsters = Array.isArray(payload?.monsters) ? payload.monsters : Object.values(payload?.monsters || {});
    return monsters[0] || null;
}

/** The first monster's hrid in a `new_battle` payload, or null. */
function firstMonsterHrid(payload) {
    return firstMonster(payload)?.hrid || null;
}

/**
 * This fight's own labyrinth room level, read straight off its monster's
 * scaled combat level — not assumed from the capture's start-of-run context,
 * which is only ever the level the capture *started* at and goes stale the
 * instant a capture follows the player into a different room ("All rooms").
 * Measured: a labyrinth monster's `combatDetails.combatLevel` (and
 * `staminaLevel`, which the labyrinth scales identically) equals the room
 * level directly — no base-stat lookup or inverse formula needed. Null for a
 * payload that carries no such field (a non-labyrinth fight, or a payload
 * shape too old to have one).
 * @param {Object} payload - A `new_battle` payload
 * @returns {number|null}
 */
function fightRoomLevel(payload) {
    const level = Number(firstMonster(payload)?.combatDetails?.combatLevel);
    return Number.isFinite(level) && level > 0 ? level : null;
}

/** @returns {boolean} Whether a capture is running */
export function isCapturing() {
    return capturing;
}

/**
 * How many ticks are currently held — running or stopped, saved or not.
 *
 * A Save click is not consent to discard: `downloadCapture()` stamps
 * `savedAt` the moment the download link is clicked, before the browser's own
 * Save dialog has necessarily done anything, and that dialog can be
 * cancelled. So "already saved" is not a safe reason to let a fresh capture
 * silently replace what is held — only an explicit Discard (`clearCapture()`)
 * or a caller passing `force` to {@link startCapture} after getting the
 * user's own go-ahead may do that. Every path that can start or reset a
 * capture (the harness rerun, the Capture button, anything future) must
 * check this first and route through Save/Discard when it is non-zero.
 * @returns {number}
 */
export function heldTickCount() {
    return ticks.length;
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
function push(type, payload, build = null) {
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
        // A new fight breaks adjacency, even when battleId is absent and its
        // first update happens to match the previous fight's last update.
        lastBattleKey = null;
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
    ticks.push({
        at: Date.now() - startedAt,
        type,
        payload,
        // Tagged on the tick itself, not only in the capture-wide context: a
        // capture that follows the player across rooms ("All rooms") has one
        // room level per fight, and the context is only ever the first one.
        ...(type === 'new_battle' ? { roomLevel: fightRoomLevel(payload) } : {}),
        ...(build ? { clientBuild: build } : {}),
    });
    // Keep the newest: a long capture that overflows should hold the recent
    // fight, not the one it opened on. Counted, so an overflowed capture's file
    // says it is a window, not the whole feed.
    if (ticks.length > MAX_TICKS) {
        ticksDropped += ticks.length - MAX_TICKS;
        ticks = ticks.slice(ticks.length - MAX_TICKS);
    }
    maybeAutosave();
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
 * @param {boolean} [opts.force=false] - Start even while {@link heldTickCount}
 *   is non-zero, discarding the held ticks. Only for a caller that has already
 *   gotten the user's explicit go-ahead (e.g. its own Discard button) — never
 *   the default for a path that would otherwise reset silently, and a Save
 *   click is not that go-ahead (see {@link heldTickCount}).
 * @returns {{started: boolean, heldTicks?: number}} `started: false` means
 *   nothing changed — the caller must not assume a capture is now running.
 */
export function startCapture(ctx = null, { stopOnLeave = true, force = false } = {}) {
    if (!force) {
        const held = heldTickCount();
        if (held > 0) return { started: false, heldTicks: held };
    }
    // Stop first: `endCapture` below autosaves whatever the previous capture
    // still held (a normal, harmless write — see `writeAutosave`). Clearing
    // is ordered AFTER it so that write cannot resurrect what this start is
    // about to replace: `storage.delete` cancels a same-key write still in
    // its debounce window, but only if it runs after that write was queued.
    stopCapture();
    if (autosaveOwnerId) clearAutosave(autosaveOwnerId);
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
    initialClientBuild = clientBuild();
    autosaveOwnerId = dataManager.getCurrentCharacterId() || 'default';
    lastAutosaveAt = 0;
    restoredDurationMs = null;

    // Both sides' health/mana/counters, and the message that names the units and
    // their abilities. `battle_updated` is trimmed to what a fight reads; the
    // rest (chat, ids) is noise a capture does not need.
    const onBattle = (data) => push('battle_updated', { pMap: data?.pMap, mMap: data?.mMap, battleId: data?.battleId });
    // These snapshots answer whether the client applied a room's automatic
    // loadout swap before the fight opened. Array order is client receipt order,
    // not a claim about simultaneous events inside a server tick.
    const onNew = (data) => push('new_battle', data, clientBuild());
    const onItems = (data) => {
        const equipment = (data?.endCharacterItems || [])
            .filter((item) => item.itemLocationHrid !== '/item_locations/inventory')
            .map((item) => ({
                itemHrid: item.itemHrid,
                itemLocationHrid: item.itemLocationHrid,
                enhancementLevel: item.enhancementLevel || 0,
                count: item.count,
            }));
        if (equipment.length) push('items_updated', { equipment }, clientBuild());
    };
    const onAbilities = () => push('abilities_updated', {}, clientBuild());

    webSocketHook.on('battle_updated', onBattle);
    webSocketHook.on('new_battle', onNew);
    webSocketHook.on('items_updated', onItems);
    webSocketHook.on('abilities_updated', onAbilities);
    handlers = { onBattle, onNew, onItems, onAbilities };

    autoStopTimer = setTimeout(() => endCapture('auto_max_duration'), MAX_CAPTURE_MS);
    return { started: true };
}

/**
 * The one stop path, so the file can say how the capture ended. Only a running
 * capture takes the reason — a redundant stop must not relabel a finished one.
 * @param {string} reason - 'manual' | 'auto_max_duration' | 'left_monster'
 *   (never 'page_reload' — that reason is only ever set by {@link loadAutosave})
 */
function endCapture(reason) {
    if (autoStopTimer) {
        clearTimeout(autoStopTimer);
        autoStopTimer = null;
    }
    if (handlers) {
        webSocketHook.off('battle_updated', handlers.onBattle);
        webSocketHook.off('new_battle', handlers.onNew);
        webSocketHook.off('items_updated', handlers.onItems);
        webSocketHook.off('abilities_updated', handlers.onAbilities);
        handlers = null;
    }
    if (capturing) stoppedReason = reason;
    capturing = false;
    // Beyond the throttled per-tick writes: a stop is exactly the moment the
    // held ticks stop changing and are least likely to be autosaved again
    // soon, so this writes now rather than waiting for the next tick that may
    // never come — and skips storage's own debounce too, so a crash right
    // after stopping cannot lose a write that was still queued.
    writeAutosave(true);
}

/** Stop recording. What was captured stays captured, for the file. */
export function stopCapture() {
    endCapture('manual');
}

/**
 * Forget the held capture in memory without touching its autosave — for a
 * character switch, so the departing character's capture is not shown to
 * whoever logs in next. The autosave `endCapture` just wrote (this always
 * follows a `stopCapture`) is what lets that character find it again on
 * their own next login; this only clears what a different character must
 * never see.
 */
export function forgetForCharacterSwitch() {
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
    initialClientBuild = null;
    autosaveOwnerId = null;
    lastAutosaveAt = 0;
    restoredDurationMs = null;
}

/** Stop, throw away the captured ticks, and clear their autosave. The ref to the last saved file survives. */
export function clearCapture() {
    stopCapture();
    if (autosaveOwnerId) clearAutosave(autosaveOwnerId);
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
    initialClientBuild = null;
    autosaveOwnerId = null;
    lastAutosaveAt = 0;
    restoredDurationMs = null;
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
        // A restored capture's `startedAt` is the ORIGINAL session's wall
        // clock, which can be hours or days behind `Date.now()` by the time
        // it is recovered — computing off that gap reads as an absurd
        // duration. Its own recorded span (the last tick's own `at`) is what
        // this asks for instead.
        seconds:
            restoredDurationMs !== null ? restoredDurationMs / 1000 : startedAt ? (Date.now() - startedAt) / 1000 : 0,
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
 *
 * Version 4: every `new_battle` tick carries its own `roomLevel`, read from
 * that fight's own monster data (see `fightRoomLevel`) — a capture followed
 * across rooms ("All rooms") can hold fights at several levels, and
 * `context.roomLevel` is only ever the level the capture started at. Additive
 * and optional, so nothing that read version 3 breaks; `lastFightRoomLevel`
 * falls back to `context.roomLevel` for a file that predates it.
 * @returns {Object}
 */
export function captureFile() {
    const host = typeof location !== 'undefined' ? location.hostname || null : null;
    // Stalls in the retained feed: a reader trusting tick cadence needs to know
    // where the stream went quiet (tab throttled, connection dropped). One O(n)
    // pass here, not per-tick bookkeeping.
    let maxGapMs = null;
    let gapsOver5s = 0;
    // Equipment/ability markers say nothing about combat-feed cadence. A marker
    // halfway through a stalled battle stream must not conceal the gap.
    const battleTicks = ticks.filter((tick) => tick.type === 'battle_updated' || tick.type === 'new_battle');
    for (let i = 1; i < battleTicks.length; i++) {
        const gap = battleTicks[i].at - battleTicks[i - 1].at;
        if (maxGapMs === null || gap > maxGapMs) maxGapMs = gap;
        if (gap > 5000) gapsOver5s++;
    }
    return {
        format: 'toolasha-labyrinth-tick-capture',
        version: 4,
        toolashaVersion: scriptVersion(),
        host,
        isTestServer: host ? host.includes('test.') : null,
        recordedAt: startedAt || null,
        exportedAt: Date.now(),
        savedAt,
        captureId,
        context: context || null,
        initialClientBuild,
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
        // Refresh the autosave with the now-stamped savedAt, immediately: not
        // proof the click actually landed on disk (the Save dialog can still
        // be cancelled), so this does not stop the autosave — only Discard or
        // a confirmed new capture does that — but the copy should carry the
        // freshest state either way, and this is another moment a crash right
        // after should not be able to lose a still-queued debounced write.
        writeAutosave(true);
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

/**
 * The room level of a capture's most recent fight, read from that fight's own
 * `new_battle` tick — not `context.roomLevel`, which is only ever the level
 * the capture started at. A capture followed across rooms ("All rooms") can
 * hold fights at several levels; this is the one to compare against whatever
 * is on screen right now. Falls back to `context.roomLevel` for a legacy
 * capture whose ticks predate per-fight tagging (no tick carries `roomLevel`
 * at all), and to `null` when neither is known.
 * @param {{ticks?: Array<Object>, context?: {roomLevel?: number}}} file - A
 *   `captureFile()`-shaped object (or the file as downloaded and re-parsed)
 * @returns {number|null}
 */
export function lastFightRoomLevel(file) {
    const fights = (file?.ticks || []).filter((tick) => tick?.type === 'new_battle');
    for (let i = fights.length - 1; i >= 0; i--) {
        const level = Number(fights[i].roomLevel);
        if (Number.isFinite(level) && level > 0) return level;
    }
    const legacy = Number(file?.context?.roomLevel);
    return Number.isFinite(legacy) && legacy > 0 ? legacy : null;
}

/**
 * Restore an autosaved capture from a previous session, if this character has
 * one held. Call once, from the room-log feature's `initialize()`, after the
 * current character is known (the same timing as `labFightRecorder.load()`).
 *
 * A crash, a closed tab, or a Save dialog the user cancelled leaves ticks that
 * were never written to a file, but the autosave still has them; this hands
 * them back as a stopped, held capture — exactly the "Save capture" state a
 * capture that stopped itself is already in — rather than losing them with
 * the page. Never overwrites a capture already running or held in this
 * session: this is page-load recovery, not a merge.
 *
 * Guards the character identity across the read, not only whether anything is
 * armed: `dataManager.getCurrentCharacterId()` is captured before the await
 * and checked again after it, so a switch landing while the read is in flight
 * cannot hand character B a read that was made for character A. The caller
 * (`labyrinth-room-logs.js`'s `initialize()`) additionally gates its own use
 * of the result with an ownership ticket, for the same reason `record.load()`
 * and `labFightRecorder.load()` do — this recheck protects this module's own
 * state; the ticket protects what the caller does with a `true` result.
 * @returns {Promise<boolean>} Whether a capture was recovered
 */
export async function loadAutosave() {
    if (capturing || ticks.length) return false;
    const ownerId = dataManager.getCurrentCharacterId() || 'default';
    let stored;
    try {
        stored = await storage.get(autosaveKey(ownerId), AUTOSAVE_STORE, null);
    } catch (error) {
        console.error('[LabyrinthTickCapture] Reading the autosaved capture failed:', error);
        return false;
    }
    // Nothing armed while the read was in flight, AND still the same
    // character — a switch mid-read must not hand the departing character's
    // ticks to whoever has arrived, even if nothing else claimed them first.
    if (capturing || ticks.length) return false;
    if ((dataManager.getCurrentCharacterId() || 'default') !== ownerId) return false;
    if (!stored || !Array.isArray(stored.ticks) || !stored.ticks.length) return false;

    ticks = stored.ticks;
    context = stored.context || null;
    captureId = stored.captureId || null;
    // Kept as the true original wall-clock start, for `recordedAt` — but see
    // `restoredDurationMs` below for why `captureStatus().seconds` must not
    // be computed from it.
    startedAt = Number(stored.recordedAt) || 0;
    duplicatesDiscarded = Number(stored.duplicatesDiscarded) || 0;
    ticksDropped = Number(stored.ticksDropped) || 0;
    // Always presented as unsaved: a stored `savedAt` is not proof the file
    // actually reached disk (the Save dialog can be cancelled), so a
    // recovered capture always asks again rather than risk staying silent.
    savedAt = null;
    stoppedReason = stored.stoppedReason || 'page_reload';
    initialClientBuild = stored.initialClientBuild || null;
    targetMonster = null;
    lastBattleKey = null;
    capturing = false;
    autosaveOwnerId = ownerId;
    lastAutosaveAt = Date.now();
    // The recorded span, in ms: the last tick's own `at`, which is already
    // elapsed-since-the-original-start. `Date.now() - startedAt` would
    // instead measure wall time since that original session, which can be
    // hours or days by the time a reload recovers this.
    const last = ticks[ticks.length - 1];
    restoredDurationMs = Number.isFinite(Number(last?.at)) ? Number(last.at) : 0;
    return true;
}

export default {
    isCapturing,
    heldTickCount,
    startCapture,
    stopCapture,
    clearCapture,
    forgetForCharacterSwitch,
    loadAutosave,
    captureStatus,
    captureFile,
    downloadCapture,
    lastCaptureRef,
    lastFightRoomLevel,
};
