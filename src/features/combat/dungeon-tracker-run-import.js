/**
 * Lossless export + import for the dungeon tracker's run history.
 *
 * The CSV export the history panel already had (`dungeon-tracker-ui-history.js`)
 * is for spreadsheets: display-shaped values, one row per run, no way back in,
 * and always narrowed to whatever the panel's filters currently allow. This is
 * the other direction — a JSON envelope of the EXACT stored run records this
 * character recorded (`recordedBy` matches it — the same "This character" scope
 * the panel's own character filter uses), unfiltered by the panel's dungeon,
 * tier or team dropdowns, meant as a full-fidelity backup and as the thing a
 * merge (a second device, a friend's export) comes back in through. It is
 * *not* the whole account's history — every character's runs, in one file, are
 * already reachable through the full backup in Settings ("Back Up Everything"),
 * which walks every IndexedDB store rather than one character's slice of one.
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
 * A file bigger than this is refused before it is even read. No genuine
 * export gets remotely close — a realistic run (team, waveTimes, keyCountsMap)
 * is roughly 0.7 KB compact, so 20 MB is about 30,000 runs already, and reading a larger file into memory just to
 * reject it afterwards is the one cost this check exists to avoid paying.
 */
export const MAX_IMPORT_FILE_BYTES = 20 * 1024 * 1024;

/**
 * A backup naming more runs than this is refused outright, checked by array
 * length before a single one is validated. No real account approaches it —
 * the busiest imaginable farming schedule run non-stop for years would not
 * fill a fraction of it — it exists so a hand-edited or corrupted file
 * cannot make the browser tab iterate an unbounded list.
 *
 * 50,000 rather than the 200,000 this started at: the stats path every
 * imported run eventually reaches (`calculateStatsForRuns`,
 * `getAllTeamStats`, chart building — anywhere a dungeon+team group's
 * durations get summarized) now uses {@link minMaxOf: dungeon-tracker-storage.js}
 * instead of spreading into `Math.min`/`Math.max`, which no longer crashes
 * outright at six figures, but keeping the ceiling itself well under that
 * range is the cheaper, harder guarantee — no single group can approach the
 * point where iterating it, however cheaply, is worth doing at all.
 */
export const MAX_IMPORT_RUNS = 50_000;

/**
 * The longest `dungeonName` an imported run may carry. Real names are a few
 * words; the value is copied into filter options, trend labels, group headers
 * and every row, so an unbounded one freezes the tab.
 */
export const MAX_DUNGEON_NAME_CHARS = 200;

/**
 * The longest `teamKey` an imported run may carry. A live key is up to five
 * player names joined by commas (`getTeamKey`); the repo bounds no name length,
 * so this sits far above any plausible five-name key rather than at a guess.
 */
export const MAX_TEAM_KEY_CHARS = 300;

/**
 * @param {*} value - Anything
 * @returns {boolean} Whether it is a plain object (not null, not an array)
 */
function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * A run's duration, normalized onto the `duration` field `runIdentity` and
 * every other reader here look at, and onto an actual `number` — not merely a
 * value `Number()` can make sense of. A legacy websocket-recorded run states
 * its length as `totalTime` instead; a straight validation split between the
 * two fields would agree on "how long did this take" while disagreeing about
 * which property that answer lives on, and the run's identity — computed
 * downstream from `duration` alone — would come out different from what
 * validation checked. Normalizing first means both are answering about the
 * same field.
 *
 * The type matters as much as the field: a hand-edited or exported-elsewhere
 * backup can spell a duration as the *string* `"300000"`, which
 * `Number.isFinite(Number(...))` happily calls usable — every later reducer
 * that sums a group's durations with `+=`, though, sees a `number` for every
 * live run and this one string, and JavaScript's `+` concatenates rather than
 * adds the moment either side is a string. One imported run with a numeric
 * string for a duration would then silently poison every average and median
 * `dungeon-tracker-storage.js` computes over its group. Returns the original
 * object untouched only when `duration` is already a genuine `number`, and a
 * shallow copy otherwise; never mutates the input.
 *
 * @param {Object} run - One entry from the backup's `runs` array
 * @returns {Object} `run`, or a copy of it with `duration` coerced to a real
 *   number (from itself or, failing that, from `totalTime`)
 */
function normalizeImportedRunDuration(run) {
    if (!isPlainObject(run)) return run;
    const duration = Number(run.duration);
    if (Number.isFinite(duration)) {
        return typeof run.duration === 'number' ? run : { ...run, duration };
    }
    const totalTime = Number(run.totalTime);
    if (!Number.isFinite(totalTime)) return run;
    return { ...run, duration: totalTime };
}

/**
 * A validated run's timestamp, replaced with the canonical ISO string every
 * live save stores (`new Date(...).toISOString()` — see `dungeon-tracker.js`,
 * both recording routes stamp a run this way before calling `saveTeamRun`).
 *
 * `Date`'s legacy (non-ISO) parser is far more permissive than the shape it
 * ever produces on write: a string carrying a parenthesized "timezone name"
 * comment can embed arbitrary text — quotes, markup — and still parse to a
 * valid instant. `validateImportedRun` only asks whether a timestamp names a
 * real moment; it says nothing about the literal characters that moment was
 * spelled with, and those are what the run history panel later writes into a
 * `data-run-timestamp` HTML attribute. A run's own stamp was never a place a
 * player expected to inject markup from a shared backup file, so this
 * replaces it outright with what parsing it actually established, rather
 * than trusting the original string past the point it was read.
 *
 * Only ever called on a run {@link validateImportedRun} already accepted, so
 * the parse here cannot fail; call it before, and it hands back an untouched
 * run for {@link validateImportedRun} to reject on its own terms.
 *
 * @param {Object} run - One entry, already duration-normalized
 * @returns {Object} `run`, or a copy of it with `timestamp` canonicalized
 */
function canonicalizeImportedRunTimestamp(run) {
    if (!isPlainObject(run)) return run;
    const time = runTime(run);
    if (time === null) return run;
    const iso = new Date(time).toISOString();
    return run.timestamp === iso ? run : { ...run, timestamp: iso };
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
 * Serialize a backup that this copy's own import will accept.
 *
 * Import refuses a file over {@link MAX_IMPORT_FILE_BYTES} or naming more than
 * {@link MAX_IMPORT_RUNS} runs, so an export that ignored both could write a
 * file its own Import button rejects. When the runs exceed either limit, the
 * NEWEST runs are kept (the oldest are the ones least worth carrying) and the
 * count left out is reported so the caller can say so. Under both limits the
 * runs are written in the order given, untouched.
 *
 * @param {Object} options
 * @param {string|null} options.characterId - The character the runs were read for
 * @param {Array<Object>} options.runs - The stored runs, every field
 * @param {number} [options.now] - Timestamp, injectable for tests
 * @param {number} [options.maxRuns] - Run-count ceiling, injectable for tests
 * @param {number} [options.maxBytes] - File-size ceiling, injectable for tests
 * @returns {{text: string, omitted: number}} The file contents, and how many of
 *   the oldest runs were left out to fit (0 when nothing was)
 */
export function serializeBackupWithinLimits({
    characterId,
    runs,
    now = Date.now(),
    maxRuns = MAX_IMPORT_RUNS,
    maxBytes = MAX_IMPORT_FILE_BYTES,
}) {
    const all = Array.isArray(runs) ? runs : [];
    const encoder = new TextEncoder();
    // Compact: pretty-printing put every team/waveTimes/keyCountsMap element
    // on its own line and cost about half again the bytes for nothing.
    const write = (list) => JSON.stringify(buildDungeonRunsBackupEnvelope({ characterId, runs: list, now }));
    const size = (text) => encoder.encode(text).length;

    let text = write(all);
    if (all.length <= maxRuns && size(text) <= maxBytes) return { text, omitted: 0 };

    // Same parse as the store's own ordering; an unstamped run sorts oldest.
    const stamp = (run) => runTime(run) ?? -Infinity;
    const newestFirst = [...all].sort((a, b) => {
        const [sa, sb] = [stamp(a), stamp(b)];
        return sa === sb ? 0 : sb > sa ? 1 : -1;
    });

    // Size scales with the run count, so aim just under the ceiling and shave
    // 5% at a time until the real serialized size agrees.
    let keep = Math.min(newestFirst.length, maxRuns);
    text = write(newestFirst.slice(0, keep));
    if (size(text) > maxBytes) {
        keep = Math.floor((keep * maxBytes) / size(text));
        for (;;) {
            text = write(newestFirst.slice(0, keep));
            if (keep === 0 || size(text) <= maxBytes) break;
            keep = Math.min(keep - 1, Math.floor(keep * 0.95));
        }
    }
    return { text, omitted: all.length - keep };
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
    // A length check, not a scan — cheap enough to run before anything else
    // touches the list, which is the point: this is what stands between a
    // corrupted or hostile file and iterating it run by run.
    if (envelope.runs.length > MAX_IMPORT_RUNS) {
        return {
            ok: false,
            error: `The backup has too many runs (${envelope.runs.length}; the limit is ${MAX_IMPORT_RUNS}).`,
        };
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
 * Requires a real `duration` field rather than reading `totalTime` as a
 * fallback here: `runIdentity` (`dungeon-tracker-storage.js`) only ever reads
 * `duration`, so a run admitted on its `totalTime` alone would validate
 * successfully and then carry a different, undefined identity into storage
 * than the one just checked. Call {@link planDungeonRunImport}, not this
 * directly, on a legacy websocket-shaped run — it normalizes `totalTime` into
 * `duration` first so the two never disagree.
 *
 * @param {Object} run - One entry from the backup's `runs` array, already
 *   normalized (see {@link planDungeonRunImport})
 * @param {number} [maxRunMs] - The longest a run may plausibly have taken
 * @param {number} [now] - "Now", injectable for tests
 * @returns {{ok: true}|{ok: false, reason: string}}
 */
export function validateImportedRun(run, maxRunMs = MAX_PLAUSIBLE_RUN_MS, now = Date.now()) {
    if (!isPlainObject(run)) return { ok: false, reason: 'not an object' };

    if (typeof run.dungeonName !== 'string' || run.dungeonName.trim() === '') {
        return { ok: false, reason: 'missing dungeon name' };
    }
    if (run.dungeonName.length > MAX_DUNGEON_NAME_CHARS) {
        return { ok: false, reason: `dungeon name longer than ${MAX_DUNGEON_NAME_CHARS} characters` };
    }

    // Every live save writes `teamKey` as either a real (non-empty) string or
    // omits it for a solo run — `groupByTeam` and friends already read a
    // falsy teamKey as "Solo". Anything else — a number, an object, an
    // explicit empty string a live run never produces — is accepted nowhere
    // downstream and is rejected here rather than reaching a `.split(',')`
    // or a stats grouping key that expects one of the two legitimate shapes.
    if (run.teamKey !== undefined && run.teamKey !== null) {
        if (typeof run.teamKey !== 'string' || run.teamKey.trim() === '') {
            return { ok: false, reason: 'teamKey must be a non-empty string, or absent for a solo run' };
        }
        if (run.teamKey.length > MAX_TEAM_KEY_CHARS) {
            return { ok: false, reason: `teamKey longer than ${MAX_TEAM_KEY_CHARS} characters` };
        }
    }

    // Tier is only ever an integer (a known difficulty) or null/absent (not
    // recorded) on a live-saved run — see `saveTeamRun`'s own
    // `Number.isInteger(run.tier) ? run.tier : null`. It later reaches an
    // HTML attribute value verbatim (the tier filter's `<option>`s), so
    // admitting anything else here is the only thing standing between a
    // hostile backup and markup injection at that sink.
    if (run.tier !== undefined && run.tier !== null && !Number.isInteger(run.tier)) {
        return { ok: false, reason: 'tier must be an integer, or absent' };
    }

    const duration = Number(run.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
        return { ok: false, reason: 'non-positive or missing duration' };
    }
    if (duration > maxRunMs) {
        return { ok: false, reason: 'duration exceeds the three-hour plausibility ceiling' };
    }

    const time = runTime(run);
    if (time === null) {
        return { ok: false, reason: 'missing or unusable timestamp' };
    }
    // No tolerance at all, unlike the marker-clock-skew allowance elsewhere in
    // this codebase (`BASELINE_FUTURE_TOLERANCE_MS`) — importing is never
    // live recording, so a run has no clock of its own to have skewed. Any
    // slack here is exactly the loophole "delete all history" cannot close:
    // the clear only drops what is at or before its own epoch, so a run
    // dated even a few minutes ahead of it always reads as newer history the
    // clear was never asked about, and a backup with its timestamps nudged
    // forward by that much sails past a clear that just ran.
    if (time > now) {
        return { ok: false, reason: 'timestamp is in the future' };
    }

    return { ok: true };
}

/**
 * Sort a backup's runs into what may be imported and what must be rejected.
 *
 * Normalizes each run's duration (see {@link normalizeImportedRunDuration})
 * before validating it, so a legacy `totalTime`-only run is judged — and, if
 * it passes, imported — with the same `duration` value its identity will be
 * computed from. A run that passes validation also has its timestamp
 * canonicalized (see {@link canonicalizeImportedRunTimestamp}) before it is
 * admitted, so nothing past this function ever sees the original string a
 * hostile or hand-edited file supplied — only what that string was found to
 * mean. A rejected entry still names the original, unnormalized run, since
 * nothing downstream will ever see it again.
 *
 * @param {Array<Object>} runs - The envelope's `runs` array
 * @param {number} [maxRunMs] - The longest a run may plausibly have taken
 * @param {number} [now] - "Now", injectable for tests
 * @returns {{valid: Array<Object>, rejected: Array<{run: Object, reason: string}>}}
 */
export function planDungeonRunImport(runs, maxRunMs = MAX_PLAUSIBLE_RUN_MS, now = Date.now()) {
    const valid = [];
    const rejected = [];
    for (const raw of Array.isArray(runs) ? runs : []) {
        const run = normalizeImportedRunDuration(raw);
        const result = validateImportedRun(run, maxRunMs, now);
        if (result.ok) valid.push(canonicalizeImportedRunTimestamp(run));
        else rejected.push({ run: raw, reason: result.reason });
    }
    return { valid, rejected };
}

/**
 * The download filename for a run-history backup, timestamped like
 * `csvFilename` (`utils/csv-export.js`) builds the CSV export's — but its own
 * function rather than borrowed through a string replace, since the two
 * formats have no reason to stay in lockstep just because they happen to
 * share a stem-and-stamp shape today.
 *
 * @param {Date} [now] - Injectable for tests
 * @returns {string} e.g. `toolasha-dungeon-runs-backup-20260803-2214.json`
 */
export function dungeonRunsBackupFilename(now = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `toolasha-dungeon-runs-backup-${stamp}.json`;
}

export default {
    DUNGEON_RUNS_BACKUP_FORMAT,
    DUNGEON_RUNS_BACKUP_VERSION,
    MAX_PLAUSIBLE_RUN_MS,
    MAX_IMPORT_FILE_BYTES,
    MAX_IMPORT_RUNS,
    MAX_DUNGEON_NAME_CHARS,
    MAX_TEAM_KEY_CHARS,
    buildDungeonRunsBackupEnvelope,
    serializeBackupWithinLimits,
    parseDungeonRunsJson,
    validateDungeonRunsEnvelope,
    validateImportedRun,
    planDungeonRunImport,
    dungeonRunsBackupFilename,
};
