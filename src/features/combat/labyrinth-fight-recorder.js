/**
 * Labyrinth fight recorder
 *
 * The calibration replay needs several fights of one monster to measure a rate.
 * The labyrinth hands out random rooms and only lets you fight one again by
 * failing it, so there is no farming a monster to a sample on demand. The way to
 * a sample is to stop trying to force one: keep every combat fight's damage
 * exchange, across runs and reloads, and let the ones you happen to meet often
 * accumulate.
 *
 * So this is passive and persistent. Every resolved combat fight is kept — no
 * arming, no targeting — with the gross damage each side dealt (summed from the
 * health that fell, so regen is not subtracted) and the gear it was fought in.
 * The replay pools whatever has piled up for the gear you are wearing now, which
 * is why each attempt carries a fingerprint: a gear change starts a fresh pool
 * rather than comparing fights fought on different gear against one sim.
 *
 * ## Why gross, and why fingerprinted
 *
 * Gross because the sim reports damage gross; net-of-regen made the monster look
 * weaker than it hit. Fingerprinted because the replay re-simulates with your
 * current loadout, and a fight fought on last week's gear is a fight against a
 * different character — pooling it would compare the sim to the wrong fights.
 *
 * ## Bounded
 *
 * Five hundred fights, oldest dropped. That is many runs of history, small
 * enough to hold and write without thinking about it.
 */

import { createPersistedRecord, mergeById } from '../../utils/persisted-record.js';
import { scriptVersion } from '../../utils/script-version.js';

/** The labyrinth store, shared with the sim cache — this is labyrinth history */
const STORE = 'labyrinth';
const KEY = 'labyrinthFightRecorder';

/** Fights kept before the oldest fall off — many runs of history, still small */
const MAX_ATTEMPTS = 500;

/** A fight shorter than this is an abandon, not a fight, and says nothing about a rate */
const MIN_FIGHT_SECONDS = 3;

/**
 * What makes two stored attempts the same fight.
 *
 * Attempts recorded from here on carry their own `recordId`. Older ones do
 * not, and are told apart by the fight's own clock and its measurements —
 * two real fights never share all of those, so only a genuine duplicate
 * collapses.
 * @param {Object} attempt - A stored attempt
 * @returns {string}
 */
export function attemptIdentity(attempt) {
    if (attempt?.recordId) return String(attempt.recordId);
    return [
        'legacy',
        attempt?.monsterHrid,
        attempt?.roomLevel,
        attempt?.battleStartedAt,
        attempt?.resolvedAt,
        attempt?.seconds,
        attempt?.outcome,
        attempt?.monsterHpEnd,
        attempt?.playerHpEnd,
        attempt?.monsterDamage,
        attempt?.playerDamageTaken,
    ].join('|');
}

/** An id no other tab or session will mint */
function newRecordId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * The pool, kept through the shared load/save discipline: a read that could
 * not be made keeps the fights in memory, a save folds in what another tab
 * stored, and the ring cap is applied to the union (oldest fall off first).
 */
const record = createPersistedRecord({
    base: KEY,
    store: STORE,
    empty: () => [],
    merge: (stored, memory) => mergeById(attemptIdentity)(stored, memory).slice(-MAX_ATTEMPTS),
    label: 'LabyrinthFightRecorder',
});

let attempts = record.get();
let loading = null;

/**
 * The sim-model marker stamped on every attempt recorded from here on.
 *
 * The sim switched every labyrinth path to full monster abilities, so a
 * prediction made before that switch came from a different model. Attempts
 * without this marker are that legacy cohort, and the accuracy views must not
 * pool their predictions with new ones.
 * @returns {{fullKit: boolean, version: string|null}}
 */
function modelMarker() {
    return { fullKit: true, version: scriptVersion() };
}

/**
 * Read the accumulated fights back from storage, once.
 *
 * Called from the room-log feature's initialize so the pool survives a reload.
 * Idempotent, and safe to call before it has resolved — the in-memory list is
 * simply empty until it does.
 *
 * @returns {Promise<Array<Object>>}
 */
export async function load() {
    if (record.isLoaded()) return attempts;
    if (loading) return loading;
    loading = (async () => {
        try {
            record.set(attempts);
            await record.load();
            attempts = record.get();
        } catch (error) {
            console.error('[LabyrinthFightRecorder] Reading the fight pool failed:', error);
        }
        loading = null;
        return attempts;
    })();
    return loading;
}

/**
 * Forget the pool in memory without touching storage — for a character
 * switch, so the next load reads the arriving character's pool rather than
 * writing the departing one's under their key.
 */
export function forget() {
    record.reset();
    attempts = record.get();
    loading = null;
}

/**
 * Write the pool out. Fire-and-forget: a lost write costs one fight, not the
 * run. Skipped when storage cannot be read first, so the pool on disk is never
 * blindly overwritten.
 * @returns {Promise<boolean>} Whether a write landed
 */
function persist() {
    record.set(attempts);
    return record
        .save()
        .then((landed) => {
            attempts = record.get();
            return landed;
        })
        .catch((error) => {
            console.error('[LabyrinthFightRecorder] Writing the fight pool failed:', error);
            return false;
        });
}

/**
 * Keep one resolved fight, if it can support a rate.
 *
 * @param {Object} attempt
 * @param {string} attempt.monsterHrid - Which monster
 * @param {string} [attempt.monsterName] - For the file and the display
 * @param {number} attempt.roomLevel - The room's level, which scales the monster
 * @param {number} attempt.seconds - How long the fight ran
 * @param {string} attempt.outcome - clear | death | timeout | unknown
 * @param {boolean} attempt.cleared - The floor's word on whether the room cleared
 * @param {number} attempt.monsterMaxHp - The monster's maximum health
 * @param {number} attempt.monsterHpEnd - Its health on the last tick seen
 * @param {number} attempt.playerMaxHp - Your maximum health
 * @param {number} attempt.playerHpStart - Your health when the fight began
 * @param {number} attempt.playerHpEnd - Your health on the last tick seen
 * @param {number} [attempt.monsterDamage] - Gross damage you dealt (summed drops)
 * @param {number} [attempt.playerDamageTaken] - Gross damage you took (summed drops)
 * @param {number} [attempt.monsterHpStart] - The monster's health when the fight
 *   began — the new_battle snapshot's figure when the start was caught
 * @param {number} [attempt.monsterHealed] - Health the monster restored mid-fight
 * @param {number} [attempt.unattributedDealt] - Endpoint-reconciled damage the
 *   tick-summed figure missed; negative when the ticks carried more than the
 *   endpoints — stored as-is either way, it is a data-quality reading
 * @param {number} [attempt.playerHits] - Your swings that landed on the monster
 * @param {number} [attempt.playerMisses] - Your swings that missed
 * @param {number} [attempt.playerCrits] - Your landed swings that critted
 * @param {number} [attempt.battleStartedAt] - When the fight opened (ms epoch)
 * @param {number} [attempt.firstUpdateAt] - First battle_updated processed
 * @param {number} [attempt.lastTickAt] - Last battle_updated processed
 * @param {number} [attempt.resolvedAt] - When the attempt was filed
 * @param {string} [attempt.resolveReason] - What ended the watch ('new_battle',
 *   'new_fight', 'stale', 'room_switch', 'left_labyrinth', 'feature_disabled')
 * @param {boolean} [attempt.complete] - Whole fight measured: seeded from its
 *   new_battle snapshot and resolved to a known outcome. Defaults false.
 * @param {string} [attempt.fingerprint] - The gear the fight was fought in
 * @param {number} [attempt.predicted] - The cached clear chance in effect when the
 *   fight was recorded (0..1), or absent when no sim had run for the room
 */
export function noteAttempt(attempt) {
    if (!attempt || !attempt.monsterHrid) return;

    const seconds = Number(attempt.seconds) || 0;
    const monsterMaxHp = Number(attempt.monsterMaxHp) || 0;
    const playerMaxHp = Number(attempt.playerMaxHp) || 0;
    if (seconds < MIN_FIGHT_SECONDS || monsterMaxHp <= 0 || playerMaxHp <= 0) return;
    if (attempt.outcome === 'unknown') return;

    const grossDealt = Number(attempt.monsterDamage);
    const grossTaken = Number(attempt.playerDamageTaken);
    const playerHits = Number(attempt.playerHits);
    const playerMisses = Number(attempt.playerMisses);
    const playerCrits = Number(attempt.playerCrits);
    const predicted = Number(attempt.predicted);
    // Null when not measured, so a reader can tell "absent" from zero
    const nonNegOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : null;
    };
    // unattributedDealt is a signed residual and stays signed
    const numOrNull = (v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };

    attempts.push({
        recordId: newRecordId(),
        monsterHrid: String(attempt.monsterHrid),
        monsterName: attempt.monsterName ? String(attempt.monsterName) : null,
        roomLevel: Math.max(0, Math.floor(Number(attempt.roomLevel) || 0)),
        seconds,
        outcome: String(attempt.outcome || 'unknown'),
        cleared: Boolean(attempt.cleared),
        monsterMaxHp,
        monsterHpEnd: Math.max(0, Number(attempt.monsterHpEnd) || 0),
        playerMaxHp,
        playerHpStart: Math.max(0, Number(attempt.playerHpStart) || 0),
        playerHpEnd: Math.max(0, Number(attempt.playerHpEnd) || 0),
        monsterDamage: Number.isFinite(grossDealt) && grossDealt >= 0 ? grossDealt : null,
        playerDamageTaken: Number.isFinite(grossTaken) && grossTaken >= 0 ? grossTaken : null,
        // The endpoint reconciliation, absent on recordings made before the
        // fight's start was caught from its new_battle snapshot
        monsterHpStart: nonNegOrNull(attempt.monsterHpStart),
        monsterHealed: nonNegOrNull(attempt.monsterHealed),
        unattributedDealt: numOrNull(attempt.unattributedDealt),
        // The fight's own clock — measured in-fight time, not the wall-clock
        // of the resolution that filed it
        battleStartedAt: nonNegOrNull(attempt.battleStartedAt),
        firstUpdateAt: nonNegOrNull(attempt.firstUpdateAt),
        lastTickAt: nonNegOrNull(attempt.lastTickAt),
        resolvedAt: nonNegOrNull(attempt.resolvedAt),
        resolveReason: attempt.resolveReason ? String(attempt.resolveReason).slice(0, 32) : null,
        // Whole fight measured: opened at its new_battle snapshot and resolved
        // to a known outcome. False on partial fights and on the legacy path
        // that joins at the first retained tick.
        complete: attempt.complete === true,
        // Null on recordings made before hit-rate was tracked, so the replay can
        // tell "no swing data" from "zero hits landed"
        playerHits: Number.isFinite(playerHits) && playerHits >= 0 ? playerHits : null,
        playerMisses: Number.isFinite(playerMisses) && playerMisses >= 0 ? playerMisses : null,
        // Null on recordings from before crits were tracked, so a rate reads as
        // "unknown" rather than "zero crits"
        playerCrits: Number.isFinite(playerCrits) && playerCrits >= 0 ? playerCrits : null,
        fingerprint: attempt.fingerprint ? String(attempt.fingerprint) : null,
        // The clear chance the sim was claiming when the fight was recorded —
        // the prediction at entry, not one recomputed later by a newer engine.
        // Null when no sim had run for the room; old records lack the field.
        predicted: Number.isFinite(predicted) && predicted >= 0 && predicted <= 1 ? predicted : null,
        // Attempts without this marker predate the full-kit sim model and are
        // the legacy cohort — kept, but never pooled with current predictions
        model: modelMarker(),
    });

    if (attempts.length > MAX_ATTEMPTS) attempts = attempts.slice(attempts.length - MAX_ATTEMPTS);
    persist();
}

/**
 * The accumulated fights, optionally only those fought in one gear.
 *
 * @param {string} [fingerprint] - Keep only fights carrying this gear fingerprint
 * @returns {Array<Object>}
 */
export function recordedAttempts(fingerprint) {
    const list = fingerprint ? attempts.filter((a) => a.fingerprint === fingerprint) : attempts;
    return list.map((a) => ({ ...a }));
}

/**
 * How much has accumulated, for the gear given.
 *
 * @param {string} [fingerprint] - Count only fights carrying this gear fingerprint
 * @returns {{attempts: number, total: number, monsters: number}}
 */
export function recordingStatus(fingerprint) {
    const list = fingerprint ? attempts.filter((a) => a.fingerprint === fingerprint) : attempts;
    return { attempts: list.length, total: attempts.length, monsters: new Set(list.map((a) => a.monsterHrid)).size };
}

/** Throw away every accumulated fight. */
export function clearRecording() {
    attempts = [];
    record.clear().catch((error) => console.error('[LabyrinthFightRecorder] Clearing the fight pool failed:', error));
}

/**
 * The pool in a shape safe to write out and read back.
 *
 * `extra` is folded in first, so a caller can embed the replay comparison
 * alongside the raw attempts without clobbering the format tag or the attempts.
 *
 * @param {Object} [extra] - Extra top-level fields to embed, e.g. `{ replay }`
 * @returns {Object}
 */
export function recordingFile(extra = {}) {
    // Which script produced the file and against which server — live and test
    // do not share balance, so a reader has to know which one it is looking at
    const host = typeof location !== 'undefined' ? location.hostname || null : null;
    return {
        ...extra,
        format: 'toolasha-labyrinth-recording',
        version: 3,
        exportedAt: Date.now(),
        toolashaVersion: scriptVersion(),
        host,
        isTestServer: host ? host.includes('test.') : null,
        // The sim model this build records under; attempts carry their own marker
        fullKit: true,
        attempts: recordedAttempts(),
    };
}

/**
 * Write the pool out as a file.
 * @param {Object} [extra] - Extra top-level fields to embed
 * @returns {boolean} Whether there was anything to write
 */
export function downloadRecording(extra = {}) {
    if (!attempts.length) return false;
    try {
        const blob = new Blob([JSON.stringify(recordingFile(extra))], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `toolasha-labyrinth-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        return true;
    } catch (error) {
        console.error('[LabyrinthFightRecorder] Writing the recording failed:', error);
        return false;
    }
}

export default {
    load,
    forget,
    noteAttempt,
    recordedAttempts,
    recordingStatus,
    clearRecording,
    recordingFile,
    downloadRecording,
};
