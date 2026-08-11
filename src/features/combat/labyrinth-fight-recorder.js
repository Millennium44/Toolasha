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

import { readScoped, writeScoped } from '../../utils/character-key.js';

/** The labyrinth store, shared with the sim cache — this is labyrinth history */
const STORE = 'labyrinth';
const KEY = 'labyrinthFightRecorder';

/** Fights kept before the oldest fall off — many runs of history, still small */
const MAX_ATTEMPTS = 500;

/** A fight shorter than this is an abandon, not a fight, and says nothing about a rate */
const MIN_FIGHT_SECONDS = 3;

let attempts = [];
let loaded = false;
let loading = null;

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
    if (loaded) return attempts;
    if (loading) return loading;
    loading = (async () => {
        try {
            const stored = await readScoped(KEY, STORE, null);
            if (Array.isArray(stored)) attempts = stored.slice(-MAX_ATTEMPTS);
        } catch (error) {
            console.error('[LabyrinthFightRecorder] Reading the fight pool failed:', error);
        }
        loaded = true;
        loading = null;
        return attempts;
    })();
    return loading;
}

/** Write the pool out. Fire-and-forget: a lost write costs one fight, not the run. */
function persist() {
    Promise.resolve(writeScoped(KEY, attempts, STORE)).catch((error) =>
        console.error('[LabyrinthFightRecorder] Writing the fight pool failed:', error)
    );
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
 * @param {string} [attempt.fingerprint] - The gear the fight was fought in
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

    attempts.push({
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
        fingerprint: attempt.fingerprint ? String(attempt.fingerprint) : null,
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
    persist();
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
    return {
        ...extra,
        format: 'toolasha-labyrinth-recording',
        version: 1,
        exportedAt: Date.now(),
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
    noteAttempt,
    recordedAttempts,
    recordingStatus,
    clearRecording,
    recordingFile,
    downloadRecording,
};
