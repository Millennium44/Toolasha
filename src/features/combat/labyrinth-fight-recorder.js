/**
 * Labyrinth fight recorder
 *
 * The combat recorder keeps the raw feed of a normal fight so attribution can be
 * argued with evidence. The labyrinth needs the same thing for a different
 * question — not "who did what damage" but "does the sim's clear chance match
 * reality" — and it cannot reuse that recorder, because the labyrinth never
 * emits `new_battle`. The combat recorder counts fights on `new_battle`, so a
 * labyrinth recording through it is one unbounded battle that never closes.
 *
 * So this records per **attempt** rather than per tick, off the fight-boundary
 * detection the room log already does (`battle_updated` health that went up, or
 * an attack counter that reset — see labyrinth-room-logs). Each attempt keeps the
 * endpoints the replay needs: how much of the monster you destroyed, how much
 * health you lost, and how long it took. That is enough to measure your damage
 * rate and the monster's, which is the decomposition the clear-rate alone cannot
 * give: a room that times out and a room that kills you are both "lost", and only
 * the rates say which.
 *
 * ## Why endpoints and not ticks
 *
 * A tick buffer would be megabytes for a question two numbers answer. The
 * labyrinth gives no food or drink, so player health only falls (the sim nulls
 * them too, so the two agree), and a fresh monster always starts at full — so the
 * damage each side dealt over an attempt is the difference between where it
 * started and where the last tick left it. The rate is that over the duration,
 * and a rate is invariant to the health you walked in carrying, which the
 * per-fight duration is not — which is why the replay leans on the rates.
 *
 * ## Armed, not passive
 *
 * The room log records every fight's outcome already; this is the extra capture
 * you turn on for a calibration sitting and turn off again, because it is read by
 * the replay against the loadout you are wearing *now* and a recording left
 * running across a gear change would be compared against the wrong character.
 */

/** Attempts kept before the oldest fall off. A calibration sitting is tens, not thousands. */
const MAX_LAB_ATTEMPTS = 400;

/** An attempt shorter than this is an abandon, not a fight, and says nothing about a rate */
const MIN_FIGHT_SECONDS = 3;

let recording = false;
let recordedAt = 0;
let attempts = [];
let truncated = false;

/** @returns {boolean} Whether a recording is in progress */
export function isRecording() {
    return recording;
}

/**
 * Start a fresh recording.
 *
 * Anything previously captured is dropped: a recording is one sitting, and the
 * replay reads whatever is held now against the current loadout.
 */
export function startRecording() {
    recording = true;
    recordedAt = Date.now();
    attempts = [];
    truncated = false;
}

/** Stop recording. What was captured stays captured, for the replay to read. */
export function stopRecording() {
    recording = false;
}

/** Throw away the recording. */
export function clearRecording() {
    attempts = [];
    truncated = false;
    recordedAt = 0;
}

/**
 * Note one resolved attempt, if a recording is running.
 *
 * Called by the room log when it files a fight, with the endpoints read off the
 * last `battle_updated` tick plus the outcome the floor confirmed.
 *
 * @param {Object} attempt
 * @param {string} attempt.monsterHrid - Which monster
 * @param {string} [attempt.monsterName] - For the file, so it reads without a lookup
 * @param {number} attempt.roomLevel - The room's level, which scales the monster
 * @param {number} attempt.seconds - How long the fight ran
 * @param {string} attempt.outcome - clear | death | timeout | unknown
 * @param {boolean} attempt.cleared - The floor's word on whether the room cleared
 * @param {number} attempt.monsterMaxHp - The monster's maximum health
 * @param {number} attempt.monsterHpEnd - Its health on the last tick seen
 * @param {number} attempt.playerMaxHp - Your maximum health
 * @param {number} attempt.playerHpStart - Your health when the fight began
 * @param {number} attempt.playerHpEnd - Your health on the last tick seen
 */
export function noteAttempt(attempt) {
    if (!recording) return;
    if (!attempt || !attempt.monsterHrid) return;

    const seconds = Number(attempt.seconds) || 0;
    const monsterMaxHp = Number(attempt.monsterMaxHp) || 0;
    const playerMaxHp = Number(attempt.playerMaxHp) || 0;
    // A fight with no duration or no scale to it is an abandon or a bad read, and
    // a rate computed from it is a division by nearly nothing
    if (seconds < MIN_FIGHT_SECONDS || monsterMaxHp <= 0 || playerMaxHp <= 0) return;
    if (attempt.outcome === 'unknown') return;

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
    });

    if (attempts.length > MAX_LAB_ATTEMPTS) {
        truncated = true;
        attempts = attempts.slice(attempts.length - MAX_LAB_ATTEMPTS);
    }
}

/**
 * A copy of the attempts captured so far.
 * @returns {Array<Object>}
 */
export function recordedAttempts() {
    return attempts.map((attempt) => ({ ...attempt }));
}

/**
 * How much has been captured, for the button to read.
 * @returns {{recording: boolean, attempts: number, monsters: number, truncated: boolean, recordedAt: number}}
 */
export function recordingStatus() {
    const monsters = new Set(attempts.map((a) => a.monsterHrid));
    return { recording, attempts: attempts.length, monsters: monsters.size, truncated, recordedAt };
}

/**
 * The recording in a shape safe to write out and read back.
 * @returns {Object}
 */
export function recordingFile() {
    return {
        format: 'toolasha-labyrinth-recording',
        version: 1,
        recordedAt: recordedAt || null,
        exportedAt: Date.now(),
        truncated,
        attempts: recordedAttempts(),
    };
}

/**
 * Write the recording out as a file.
 * @returns {boolean} Whether there was anything to write
 */
export function downloadRecording() {
    if (!attempts.length) return false;
    try {
        const blob = new Blob([JSON.stringify(recordingFile())], { type: 'application/json' });
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
    isRecording,
    startRecording,
    stopRecording,
    clearRecording,
    noteAttempt,
    recordedAttempts,
    recordingStatus,
    recordingFile,
    downloadRecording,
};
