/**
 * Lossless export + import for the dungeon tracker's run history.
 *
 * The CSV export the history panel already had (`dungeon-tracker-ui-history.js`)
 * is for spreadsheets: display-shaped values, one row per run, no way back in,
 * and always narrowed to whatever the panel's filters currently allow. This is
 * the other direction — a JSON envelope of the EXACT stored run records for the
 * current character, unfiltered, meant as a full-fidelity backup and as the
 * thing a merge (a second device, a friend's export) comes back in through.
 *
 * ## The envelope
 *
 * ```
 * {
 *   format: 'toolasha-dungeon-runs',
 *   version: DUNGEON_RUNS_BACKUP_VERSION,
 *   characterId: string,
 *   exportedAt: number,   // ms since epoch
 *   runs: Array<Object>,  // the stored run records, unmerged, every field
 * }
 * ```
 *
 * `runs` is whatever `dungeonTrackerStorage.getRunsForCharacter('mine')` hands
 * back — every field a stored run carries (`recordedBy`, `waveTimes`,
 * `keyCountsMap`, and so on), not the handful the CSV export picks out.
 *
 * ## Identity and merging
 *
 * A run carries no id of its own. Its identity — `teamKey|timestamp|duration`
 * — is the same triple `dungeon-tracker-storage.js#runIdentity` already uses
 * for the duplicate check the sync fold and the tombstone system both rely on
 * (see `runIdentity` there). Importing the very same file twice, or a file
 * that overlaps the current history, must add nothing for runs already
 * present — merging here reuses that identity rather than inventing a second
 * one, which is what `DungeonTrackerStorage#importRuns` folds on.
 *
 * ## Sanity checks
 *
 * A run is rejected — left out of the import rather than aborting the whole
 * file — when it fails the same rules live banking already enforces: a
 * missing dungeon name, a non-positive duration, or a duration past
 * `MAX_PLAUSIBLE_RUN_MS` (three hours; see `dungeon-tracker.js`, "Two key
 * counts further apart than any run takes are two runs' boundaries, not one
 * run's start and end"). The envelope itself — format, kind, version, `runs`
 * being an array — is checked separately and refuses the whole import when it
 * fails, the same split `alchemy-session-import.js` makes for its own backups.
 */

import { runTime } from './dungeon-tracker-storage.js';

/** Marks a file as one of these backups. */
export const DUNGEON_RUNS_BACKUP_FORMAT = 'toolasha-dungeon-runs';

/**
 * The envelope/run shape this file reads and writes. Bumped only if the shape
 * changes in a way an older reader could misinterpret; an import whose
 * `version` is higher than this is refused rather than guessed at.
 */
export const DUNGEON_RUNS_BACKUP_VERSION = 1;

/**
 * The longest a run may plausibly have taken, mirroring
 * `dungeon-tracker.js#MAX_PLAUSIBLE_RUN_MS` (three hours — "the longest dungeon
 * is 65 waves at about half a minute each... several times any real run, slow
 * party or sleeping computer included"). Kept as its own constant rather than
 * imported: `dungeon-tracker.js` pulls in the websocket hook and the rest of
 * the live tracker's dependency graph, which this module — loaded by the run
 * history panel just to validate a backup file — has no business dragging in.
 */
export const MAX_PLAUSIBLE_RUN_MS = 3 * 60 * 60 * 1000;

/**
 * @param {*} value - Anything
 * @returns {boolean} Whether it is a plain object (not null, not an array)
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build the envelope for a download. Pure — does no I/O.
 *
 * @param {Object} options
 * @param {string|null} options.characterId - The character the runs were read for
 * @param {Array<Object>} options.runs - The stored runs, unmerged, every field
 * @param {number} [options.now] - Timestamp, injectable for tests
 * @returns {Object} The envelope, ready for `JSON.stringify`
 */
export function buildDungeonRunsBackupEnvelope({ characterId, runs, now = Date.now() }) {
    return {
        format: DUNGEON_RUNS_BACKUP_FORMAT,
        version: DUNGEON_RUNS_BACKUP_VERSION,
        characterId: characterId ?? null,
        exportedAt: now,
        runs: Array.isArray(runs) ? runs : [],
    };
}

/**
 * Parse the raw text of an uploaded file into an envelope-shaped object.
 *
 * Only checks that it IS an object — {@link validateDungeonRunsEnvelope} does
 * the rest. Kept separate so a JSON syntax error and a wrong-shape file report
 * distinct, specific messages instead of one catch-all.
 *
 * @param {string} text - File contents
 * @returns {{ok: true, envelope: Object}|{ok: false, error: string}}
 */
export function parseDungeonRunsJson(text) {
    if (typeof text !== 'string' || text.trim() === '') {
        return { ok: false, error: 'The file is empty.' };
    }
    let value;
    try {
        value = JSON.parse(text);
    } catch (error) {
        return { ok: false, error: `The file is not valid JSON (${error.message}).` };
    }
    if (!isPlainObject(value)) {
        return { ok: false, error: 'The file does not contain a backup envelope.' };
    }
    return { ok: true, envelope: value };
}

/**
 * Validate an envelope's own fields: format, version, and that `runs` is at
 * least an array. Does not look inside individual runs — see
 * {@link validateImportedRun} for that.
 *
 * @param {Object} envelope - Parsed JSON
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function validateDungeonRunsEnvelope(envelope) {
    if (!isPlainObject(envelope)) {
        return { ok: false, error: 'The file does not contain a backup envelope.' };
    }
    if (envelope.format !== DUNGEON_RUNS_BACKUP_FORMAT) {
        return {
            ok: false,
            error: `Not a Toolasha dungeon run history backup (unrecognized format "${envelope.format}").`,
        };
    }
    if (!Number.isInteger(envelope.version) || envelope.version < 1) {
        return { ok: false, error: `The backup has no usable version number (got "${envelope.version}").` };
    }
    if (envelope.version > DUNGEON_RUNS_BACKUP_VERSION) {
        return {
            ok: false,
            error:
                `This backup is version ${envelope.version}; this copy of Toolasha reads up to ` +
                `version ${DUNGEON_RUNS_BACKUP_VERSION}. Update Toolasha and try again.`,
        };
    }
    if (!Array.isArray(envelope.runs)) {
        return { ok: false, error: 'The backup has no runs list.' };
    }
    return { ok: true };
}

/**
 * Whether one imported run passes the same sanity rules live banking already
 * enforces, so a hand-edited or corrupted entry cannot poison the median an
 * outlier scrub or a pace estimate is computed from.
 *
 * Deliberately not as strict as `saveTeamRun`'s shape — an imported run is
 * expected to carry fields no live save ever sets (`recordedBy`, historical
 * `tier`s), and the point is to catch a run that would corrupt the store or
 * skew its statistics, not to police every field.
 *
 * @param {Object} run - One entry from the backup's `runs` array
 * @param {number} [maxRunMs] - The longest a run may plausibly have taken
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function validateImportedRun(run, maxRunMs = MAX_PLAUSIBLE_RUN_MS) {
    if (!isPlainObject(run)) return { ok: false, reason: 'not an object' };

    if (typeof run.dungeonName !== 'string' || run.dungeonName.trim() === '') {
        return { ok: false, reason: 'missing dungeon name' };
    }

    const duration = Number(run.duration ?? run.totalTime);
    if (!Number.isFinite(duration) || duration <= 0) {
        return { ok: false, reason: 'non-positive duration' };
    }
    if (duration > maxRunMs) {
        return { ok: false, reason: 'duration exceeds the three-hour plausibility ceiling' };
    }

    if (runTime(run) === null) {
        return { ok: false, reason: 'missing or unusable timestamp' };
    }

    return { ok: true };
}

/**
 * Sort a backup's runs into what may be imported and what must be rejected.
 *
 * @param {Array<Object>} runs - The envelope's `runs` array
 * @param {number} [maxRunMs] - The longest a run may plausibly have taken
 * @returns {{valid: Array<Object>, rejected: Array<{run: Object, reason: string}>}}
 */
export function planDungeonRunImport(runs, maxRunMs = MAX_PLAUSIBLE_RUN_MS) {
    const valid = [];
    const rejected = [];
    for (const run of Array.isArray(runs) ? runs : []) {
        const result = validateImportedRun(run, maxRunMs);
        if (result.ok) valid.push(run);
        else rejected.push({ run, reason: result.reason });
    }
    return { valid, rejected };
}

export default {
    DUNGEON_RUNS_BACKUP_FORMAT,
    DUNGEON_RUNS_BACKUP_VERSION,
    buildDungeonRunsBackupEnvelope,
    parseDungeonRunsJson,
    validateDungeonRunsEnvelope,
    validateImportedRun,
    planDungeonRunImport,
};
