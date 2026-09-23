/**
 * Lossless backup export + import for the three alchemy history windows.
 *
 * The CSV export the viewers already had is for spreadsheets: display strings,
 * one row per session, no way back in. This is the other direction — a JSON
 * envelope of the EXACT stored session records, meant to be hand-edited (to
 * correct a session a bug or a mis-read miscounted) and re-imported.
 *
 * ## The envelope
 *
 * ```
 * {
 *   format: 'toolasha-alchemy-history',
 *   kind: 'transmute' | 'coinify' | 'decompose',
 *   version: ALCHEMY_BACKUP_VERSION,
 *   characterId: string,
 *   exportedAt: number,      // ms since epoch
 *   sessions: Array<Object>, // the stored session records, unmerged, as-is
 * }
 * ```
 *
 * `sessions` is whatever `<kind>HistoryTracker.loadStoredSessions()` returns —
 * the UNMERGED per-run records the tracker actually persists. Nothing is
 * recomputed for the export and nothing is stripped: what a hand edit changes
 * here is exactly what the next load reads back.
 *
 * ## Authoritative vs derived fields, per kind
 *
 * A field the tracker or viewer recomputes on every read is not worth
 * hand-editing — the next render overwrites it with the current answer. What
 * is safe, and meaningful, to edit is whatever the trackers themselves treat
 * as the recorded fact.
 *
 * Common to all three kinds:
 *   - AUTHORITATIVE (edit these): `id`, `startTime`, `lastActivityTime`,
 *     `inputItemHrid`, `totalAttempts`, `totalSuccesses`, `bulkMultiplier`,
 *     `catalystsUsed` (hrid → count actually observed being spent),
 *     `predictedRate` / `predictedAt` / `predictedCatalystHrid` (the model's
 *     forecast for this run, taken at session start — edit only if you are
 *     correcting what was actually predicted, not the outcome).
 *   - DERIVED, never stored on the session (recomputed on every read from
 *     current market prices, so there is nothing to edit): `profit`,
 *     `revenue`, `inputCost`, `coinCost`, `netConsumed`, and every other
 *     field `computeSessionProfit` returns. `mergedFrom` is likewise never
 *     stored — it only exists on the reload-merged view a viewer builds at
 *     read time (`alchemy-session-merge.js`), so it never appears in an
 *     exported (stored, unmerged) session either.
 *
 * Transmute only:
 *   - AUTHORITATIVE: `results` (hrid → `{count, totalValue, priceEach,
 *     isSelfReturn, unpriced, countBasis, recordedCount}` — `count` is the
 *     number of actions that produced this output; a self-return entry has
 *     `isSelfReturn: true` and is never priced, so its `totalValue`/
 *     `priceEach` stay 0).
 *   - `repair` is an ANNOTATION, not a fact about the run: it says the
 *     self-return count was derived from `totalSuccesses` rather than
 *     observed on the wire (see `transmute-session-repair.js`). If you hand-
 *     correct `results`/`totalSuccesses` so the numbers are now consistent
 *     and observed, remove `repair` — leaving it describes a discrepancy that
 *     no longer exists, and the viewer and totals table both read it to decide
 *     whether to trust the session.
 *
 *   Worked example — a transmute session recorded 1 success / 2 failures (3
 *   attempts) that should have been 2 self-return successes / 1 failure:
 *     - `totalSuccesses`: 1 → 2 (`totalAttempts` stays 3 — attempts are what
 *       the wire actually ran, and that count is not in question)
 *     - `results[inputItemHrid]`: create or update the self-return entry to
 *       `{ count: 2, totalValue: 0, priceEach: 0, isSelfReturn: true,
 *       unpriced: false }` (2, not 2 × bulkMultiplier — `count` counts
 *       producing actions, matching how the tracker writes it)
 *     - remove `repair` if present — the corrected numbers are no longer a
 *       discrepancy to flag
 *
 * Coinify only:
 *   - AUTHORITATIVE: `enhancementLevel`, `totalCoinsEarned`, `coinsPerSuccess`
 *     (the payout the run was made at — the game can change this later),
 *     `catalystOfCoinificationUsed`, `primeCatalystUsed` (legacy per-catalyst
 *     counters, kept alongside `catalystsUsed` for older sessions).
 *
 * Decompose only:
 *   - AUTHORITATIVE: `enhancementLevel`, `results` (same shape as transmute's,
 *     without `isSelfReturn` — decompose has no self-return path),
 *     `catalystOfDecompositionUsed`, `primeCatalystUsed`.
 */

/** Marks a file as one of these backups, distinct from the CSV export. */
export const ALCHEMY_BACKUP_FORMAT = 'toolasha-alchemy-history';

/**
 * The envelope/session shape this file reads and writes. Bumped only if the
 * shape changes in a way an older reader could misinterpret; an import whose
 * `version` is higher than this is refused rather than guessed at.
 */
export const ALCHEMY_BACKUP_VERSION = 1;

const KINDS = new Set(['transmute', 'coinify', 'decompose']);

/**
 * @param {*} value - Anything
 * @returns {boolean} Whether it is a finite number
 */
function isFiniteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

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
 * @param {'transmute'|'coinify'|'decompose'} options.kind - Which tracker
 * @param {string|null} options.characterId - The scope the sessions were read for
 * @param {Array<Object>} options.sessions - The stored (unmerged) sessions
 * @param {number} [options.now] - Timestamp, injectable for tests
 * @returns {Object} The envelope, ready for `JSON.stringify`
 */
export function buildAlchemyBackupEnvelope({ kind, characterId, sessions, now = Date.now() }) {
    return {
        format: ALCHEMY_BACKUP_FORMAT,
        kind,
        version: ALCHEMY_BACKUP_VERSION,
        characterId: characterId ?? null,
        exportedAt: now,
        sessions: Array.isArray(sessions) ? sessions : [],
    };
}

/**
 * Parse the raw text of an uploaded file into an envelope-shaped object.
 *
 * Only checks that it IS an object — `validateAlchemyBackupEnvelope` does the
 * rest. Kept separate so a JSON syntax error and a wrong-shape file report
 * distinct, specific messages instead of one catch-all.
 *
 * @param {string} text - File contents
 * @returns {{ok: true, envelope: Object}|{ok: false, error: string}}
 */
export function parseAlchemyBackupJson(text) {
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
 * Validate an envelope's own fields: format, kind, version, and that
 * `sessions` is at least an array. Does not look inside individual sessions —
 * see `validateAlchemySession` for that.
 *
 * @param {Object} envelope - Parsed JSON
 * @param {Object} options
 * @param {'transmute'|'coinify'|'decompose'} options.kind - The window doing the import
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function validateAlchemyBackupEnvelope(envelope, { kind }) {
    if (!isPlainObject(envelope)) {
        return { ok: false, error: 'The file does not contain a backup envelope.' };
    }
    if (envelope.format !== ALCHEMY_BACKUP_FORMAT) {
        return {
            ok: false,
            error: `Not a Toolasha alchemy history backup (unrecognized format "${envelope.format}").`,
        };
    }
    if (!KINDS.has(envelope.kind)) {
        return { ok: false, error: `Unrecognized history kind "${envelope.kind}" in the backup.` };
    }
    if (envelope.kind !== kind) {
        return {
            ok: false,
            error:
                `This backup is ${envelope.kind} history, not ${kind} history — ` +
                `open it from the ${envelope.kind} History window instead.`,
        };
    }
    if (!Number.isInteger(envelope.version) || envelope.version < 1) {
        return { ok: false, error: `The backup has no usable version number (got "${envelope.version}").` };
    }
    if (envelope.version > ALCHEMY_BACKUP_VERSION) {
        return {
            ok: false,
            error:
                `This backup is version ${envelope.version}; this copy of Toolasha reads up to ` +
                `version ${ALCHEMY_BACKUP_VERSION}. Update Toolasha and try again.`,
        };
    }
    if (!Array.isArray(envelope.sessions)) {
        return { ok: false, error: 'The backup has no sessions list.' };
    }
    return { ok: true };
}

/**
 * Validate one result-map entry (`transmute`/`decompose` sessions only).
 * @param {string} hrid - The result's key
 * @param {*} result - The value under it
 * @returns {string|null} An error, or null when it is well-formed
 */
function validateResultEntry(hrid, result) {
    if (!isPlainObject(result)) return `has a non-object result entry for "${hrid}"`;
    if (!isFiniteNumber(result.count)) return `has a non-numeric result count for "${hrid}"`;
    if (result.totalValue !== undefined && !isFiniteNumber(result.totalValue)) {
        return `has a non-numeric totalValue for "${hrid}"`;
    }
    if (result.priceEach !== undefined && !isFiniteNumber(result.priceEach)) {
        return `has a non-numeric priceEach for "${hrid}"`;
    }
    if (result.recordedCount !== undefined && !isFiniteNumber(result.recordedCount)) {
        return `has a non-numeric recordedCount for "${hrid}"`;
    }
    if (result.isSelfReturn !== undefined && typeof result.isSelfReturn !== 'boolean') {
        return `has a non-boolean isSelfReturn for "${hrid}"`;
    }
    if (result.unpriced !== undefined && typeof result.unpriced !== 'boolean') {
        return `has a non-boolean unpriced for "${hrid}"`;
    }
    return null;
}

/**
 * Validate one session against the same shape checks the trackers themselves
 * rely on — an id to upsert by, a start time to sort by, an input item, and
 * attempt/success counts that are not internally impossible. Deliberately not
 * as strict as it could be: a hand-edited file is expected to differ from
 * what the tracker would have produced, and the point is to catch a session
 * that would corrupt the store or crash a reader, not to police every value.
 *
 * @param {'transmute'|'coinify'|'decompose'} kind - Which tracker's shape
 * @param {Object} session - One entry from the backup's `sessions` array
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function validateAlchemySession(kind, session) {
    const label = session?.id ?? '(no id)';
    if (!isPlainObject(session)) return { ok: false, error: `Session ${label} is not an object.` };
    if (typeof session.id !== 'string' || session.id.trim() === '') {
        return { ok: false, error: 'A session is missing a usable id.' };
    }
    if (!isFiniteNumber(session.startTime) || session.startTime < 0) {
        return { ok: false, error: `Session ${label} has no usable startTime.` };
    }
    if (typeof session.inputItemHrid !== 'string' || !session.inputItemHrid.startsWith('/items/')) {
        return { ok: false, error: `Session ${label} has no usable inputItemHrid.` };
    }
    if (!isFiniteNumber(session.totalAttempts) || session.totalAttempts < 0) {
        return { ok: false, error: `Session ${label} has a non-numeric or negative totalAttempts.` };
    }
    if (!isFiniteNumber(session.totalSuccesses) || session.totalSuccesses < 0) {
        return { ok: false, error: `Session ${label} has a non-numeric or negative totalSuccesses.` };
    }
    if (session.totalSuccesses > session.totalAttempts) {
        return { ok: false, error: `Session ${label} has more successes (${session.totalSuccesses}) than attempts.` };
    }
    if (session.lastActivityTime !== undefined) {
        if (!isFiniteNumber(session.lastActivityTime) || session.lastActivityTime < session.startTime) {
            return { ok: false, error: `Session ${label} has a lastActivityTime before its startTime.` };
        }
    }
    if (
        session.bulkMultiplier !== undefined &&
        (!isFiniteNumber(session.bulkMultiplier) || session.bulkMultiplier <= 0)
    ) {
        return { ok: false, error: `Session ${label} has a non-numeric bulkMultiplier.` };
    }
    if (session.catalystsUsed !== undefined) {
        if (!isPlainObject(session.catalystsUsed)) {
            return { ok: false, error: `Session ${label} has a non-object catalystsUsed.` };
        }
        for (const [hrid, count] of Object.entries(session.catalystsUsed)) {
            if (!isFiniteNumber(count) || count < 0) {
                return { ok: false, error: `Session ${label} has a bad catalystsUsed count for "${hrid}".` };
            }
        }
    }

    if (kind === 'transmute' || kind === 'decompose') {
        if (session.results !== undefined) {
            if (!isPlainObject(session.results)) {
                return { ok: false, error: `Session ${label} has a non-object results.` };
            }
            for (const [hrid, result] of Object.entries(session.results)) {
                const error = validateResultEntry(hrid, result);
                if (error) return { ok: false, error: `Session ${label} ${error}.` };
            }
        }
    }

    if (kind === 'coinify' || kind === 'decompose') {
        if (session.enhancementLevel !== undefined) {
            if (!isFiniteNumber(session.enhancementLevel) || session.enhancementLevel < 0) {
                return { ok: false, error: `Session ${label} has a non-numeric enhancementLevel.` };
            }
        }
    }

    if (kind === 'coinify') {
        for (const field of [
            'totalCoinsEarned',
            'coinsPerSuccess',
            'catalystOfCoinificationUsed',
            'primeCatalystUsed',
        ]) {
            if (session[field] !== undefined && (!isFiniteNumber(session[field]) || session[field] < 0)) {
                return { ok: false, error: `Session ${label} has a non-numeric ${field}.` };
            }
        }
    }

    if (kind === 'decompose') {
        for (const field of ['catalystOfDecompositionUsed', 'primeCatalystUsed']) {
            if (session[field] !== undefined && (!isFiniteNumber(session[field]) || session[field] < 0)) {
                return { ok: false, error: `Session ${label} has a non-numeric ${field}.` };
            }
        }
    }

    return { ok: true };
}

/**
 * Validate every session in a backup, stopping at the first problem.
 *
 * @param {'transmute'|'coinify'|'decompose'} kind - Which tracker's shape
 * @param {Array<Object>} sessions - The backup's sessions array
 * @returns {{ok: true}|{ok: false, error: string}}
 */
export function validateAlchemySessions(kind, sessions) {
    for (const session of sessions || []) {
        const result = validateAlchemySession(kind, session);
        if (!result.ok) return result;
    }
    return { ok: true };
}

/**
 * Merge an imported sessions array onto the stored (unmerged) ones by id.
 *
 * An imported id already in storage REPLACES that record whole — this is how
 * a hand-corrected session goes back in. An imported id storage has never
 * seen is added. A stored session absent from the file is left exactly as it
 * is; import is additive/corrective, never a wholesale replace.
 *
 * @param {Array<Object>} stored - The character's stored sessions, unmerged
 * @param {Array<Object>} imported - The backup's sessions array
 * @returns {{merged: Array<Object>, replacedIds: Array<string>, addedIds: Array<string>,
 *   replaced: number, added: number, unchanged: number}} The result to write, and a summary
 */
export function planAlchemyImportMerge(stored, imported) {
    const storedList = Array.isArray(stored) ? stored : [];
    const importedList = Array.isArray(imported) ? imported : [];

    const importedById = new Map();
    for (const session of importedList) {
        if (session && typeof session.id === 'string') importedById.set(session.id, session);
    }

    const replacedIds = [];
    const merged = storedList.map((existing) => {
        const incoming = importedById.get(existing?.id);
        if (incoming === undefined) return existing;
        importedById.delete(existing.id);
        replacedIds.push(existing.id);
        return incoming;
    });

    const addedIds = [];
    for (const [id, incoming] of importedById) {
        merged.push(incoming);
        addedIds.push(id);
    }

    return {
        merged,
        replacedIds,
        addedIds,
        replaced: replacedIds.length,
        added: addedIds.length,
        unchanged: storedList.length - replacedIds.length,
    };
}

export default {
    ALCHEMY_BACKUP_FORMAT,
    ALCHEMY_BACKUP_VERSION,
    buildAlchemyBackupEnvelope,
    parseAlchemyBackupJson,
    validateAlchemyBackupEnvelope,
    validateAlchemySession,
    validateAlchemySessions,
    planAlchemyImportMerge,
};
