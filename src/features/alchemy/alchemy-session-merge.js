/**
 * Rejoining the sessions a page reload split.
 *
 * ## Why history arrives in pieces
 *
 * All three alchemy trackers wire `init_character_data` to `handleReconnect()`,
 * which ends the open session. Every page load is a fresh `init_character_data`,
 * so every reload closes the run and the next action opens a new one. Five
 * consecutive Gatherer Cape sessions in the maintainer's history correspond
 * exactly to five reloads during one grind: the same item, the same catalyst,
 * one continuous run, five records.
 *
 * ## The threshold, and why it is the one that is measured
 *
 * The danger in merging is the opposite of the danger in splitting. The game
 * keeps acting while the client is away, so merging across a real absence would
 * staple a later run onto an earlier one while the attempts made in between were
 * never recorded — the merged record would then show the same cost spread over
 * fewer attempts and read as cheaper than it was. That is the failure mode that
 * has to be impossible, not merely unlikely.
 *
 * So the question is never "was the gap short?" but "could a completed action
 * have hidden inside it?". `lastActivityTime` is the moment the previous run's
 * last action *completed*, so the next action starts exactly then and can only
 * complete one full action duration later. A gap shorter than one action
 * duration therefore cannot contain a completed action, and nothing can have
 * been missed.
 *
 * The action duration is not taken from game data, because game data would have
 * to be corrected for haste, teas, levels and the house — every one of which can
 * make the real action shorter than the base figure, and an over-long threshold
 * is precisely the error that must not happen. Each session measures its own
 * pace instead:
 *
 *     pace = (lastActivityTime - startTime) / totalAttempts
 *
 * That is an *under*-estimate of the action duration, and deliberately so:
 * efficiency procs pack several attempts into one action, so the average time
 * per attempt is shorter than the time per action, often several times shorter.
 * Using it as the threshold means some genuine reload splits are left unmerged —
 * a visible, harmless outcome — while a merge across a gap that could have
 * hidden an action is arithmetically ruled out.
 *
 * The threshold for a pair is the smaller of the two sessions' own paces, and a
 * session that cannot measure a pace (no `lastActivityTime`, no attempts, no
 * elapsed time — every session recorded before `lastActivityTime` existed) is
 * never merged at all.
 *
 * ## Read-time only
 *
 * Nothing here is written back. `loadSessions()` merges for readers; the
 * trackers persist through the unmerged load, so the stored history stays
 * exactly as the wire produced it and a future change of mind costs nothing.
 * A merged record names its parts in `mergedFrom`, which is how a viewer's
 * single-row delete is mapped back onto the stored records.
 */

import { mergedTrackerVersion } from './alchemy-tracker-version.js';

/**
 * @param {*} value - Anything
 * @returns {number} The finite number in it, or 0
 */
function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

/**
 * @param {*} value - Anything
 * @returns {boolean} Whether it is a usable timestamp
 */
function isTime(value) {
    return value !== null && value !== '' && Number.isFinite(Number(value)) && Number(value) >= 0;
}

/**
 * What this session measured as its own time per attempt.
 *
 * @param {Object} session - A stored alchemy session
 * @returns {number|null} Milliseconds per attempt, or null when it cannot be measured
 */
export function sessionPaceMs(session) {
    if (!isTime(session?.startTime) || !isTime(session?.lastActivityTime)) return null;
    const span = Number(session.lastActivityTime) - Number(session.startTime);
    const attempts = num(session.totalAttempts);
    if (!(span > 0) || !(attempts > 0)) return null;
    return span / attempts;
}

/**
 * The run's identity: two sessions are the same run only if these all agree.
 *
 * `bulkMultiplier` and `coinsPerSuccess` are recorded per session precisely
 * because the game can change them, and two sessions recorded under different
 * ones are not the same run whatever their timestamps say.
 *
 * @param {Object} session - A stored alchemy session
 * @returns {string} The identity key
 */
function runKey(session) {
    return [
        session?.inputItemHrid ?? '',
        session?.enhancementLevel ?? '',
        session?.bulkMultiplier ?? '',
        session?.coinsPerSuccess ?? '',
    ].join('|');
}

/**
 * Whether `next` is the continuation of `previous` interrupted by nothing but a
 * reload.
 *
 * @param {Object} previous - The last recorded part of the run so far
 * @param {Object} next - The candidate continuation
 * @returns {boolean} True when the gap is too short to have hidden an action
 */
export function isReloadSplit(previous, next) {
    if (!previous || !next) return false;
    if (runKey(previous) !== runKey(next)) return false;
    if (!previous.inputItemHrid) return false;

    if (!isTime(previous.lastActivityTime) || !isTime(next.startTime)) return false;
    const gap = Number(next.startTime) - Number(previous.lastActivityTime);
    if (gap < 0) return false;

    const pacePrevious = sessionPaceMs(previous);
    const paceNext = sessionPaceMs(next);
    if (pacePrevious === null || paceNext === null) return false;

    return gap < Math.min(pacePrevious, paceNext);
}

/**
 * Add the numeric fields either side actually carries.
 *
 * Only fields already present are summed, so a tracker that has no
 * `totalCoinsEarned` does not acquire one.
 *
 * @param {Object} target - The merged session being built, mutated
 * @param {Object} a - The accumulated side
 * @param {Object} b - The session being folded in
 * @returns {void}
 */
function sumCounters(target, a, b) {
    const fields = [
        'totalAttempts',
        'totalSuccesses',
        'totalCoinsEarned',
        'catalystOfCoinificationUsed',
        'catalystOfDecompositionUsed',
        'primeCatalystUsed',
    ];

    for (const field of fields) {
        if (a?.[field] === undefined && b?.[field] === undefined) continue;
        target[field] = num(a?.[field]) + num(b?.[field]);
    }
}

/**
 * Merge two `{ hrid: count }` catalyst records.
 *
 * @param {Object|undefined} a - The accumulated record
 * @param {Object|undefined} b - The next session's record
 * @returns {Object|undefined} The sum, or undefined when neither had one
 */
function mergeCatalystsUsed(a, b) {
    if (!a && !b) return undefined;
    const out = {};
    for (const [hrid, count] of Object.entries(a || {})) out[hrid] = num(out[hrid]) + num(count);
    for (const [hrid, count] of Object.entries(b || {})) out[hrid] = num(out[hrid]) + num(count);
    return out;
}

/**
 * Merge two result maps, summing counts and values per output item.
 *
 * A derived count stays derived, and `recordedCount` — what the buggy tracker
 * originally wrote — is summed alongside so the repair stays visible in the
 * merged row rather than being quietly averaged away.
 *
 * @param {Object|undefined} a - The accumulated results
 * @param {Object|undefined} b - The next session's results
 * @returns {Object|undefined} The merged results, or undefined when neither had any
 */
function mergeResults(a, b) {
    if (!a && !b) return undefined;
    const out = {};

    for (const [hrid, result] of Object.entries(a || {})) out[hrid] = { ...result };

    for (const [hrid, result] of Object.entries(b || {})) {
        const current = out[hrid];
        if (!current) {
            out[hrid] = { ...result };
            continue;
        }

        const merged = {
            ...current,
            ...result,
            count: num(current.count) + num(result.count),
            totalValue: num(current.totalValue) + num(result.totalValue),
            // The later price is the one the later items were valued at; the
            // totals above already hold each part's own valuation
            priceEach: result.priceEach ?? current.priceEach,
            isSelfReturn: Boolean(current.isSelfReturn || result.isSelfReturn),
        };
        if (current.countBasis === 'derived' || result.countBasis === 'derived') merged.countBasis = 'derived';
        if (current.recordedCount !== undefined || result.recordedCount !== undefined) {
            merged.recordedCount =
                num(current.recordedCount ?? current.count) + num(result.recordedCount ?? result.count);
        }
        out[hrid] = merged;
    }

    return out;
}

/**
 * Carry a repair or unreliable stamp into the merged record.
 *
 * Merging must never launder an untrustworthy part into a clean-looking whole,
 * so any stamp among the parts survives, and an `unreliable` outcome wins over
 * a plain repair.
 *
 * @param {Object|undefined} a - The accumulated stamp
 * @param {Object|undefined} b - The next session's stamp
 * @returns {Object|undefined} The stamp to carry
 */
function mergeRepairStamp(a, b) {
    if (a?.outcome === 'unreliable') return a;
    if (b?.outcome === 'unreliable') return b;
    return a ?? b;
}

/**
 * Fold one session into the accumulated merge.
 *
 * @param {Object} accumulated - The merged record so far
 * @param {Object} next - The session to fold in
 * @returns {Object} A new merged record
 */
function foldSession(accumulated, next) {
    const merged = { ...accumulated };

    sumCounters(merged, accumulated, next);

    merged.lastActivityTime = Math.max(num(accumulated.lastActivityTime), num(next.lastActivityTime));

    const results = mergeResults(accumulated.results, next.results);
    if (results) merged.results = results;

    const catalystsUsed = mergeCatalystsUsed(accumulated.catalystsUsed, next.catalystsUsed);
    if (catalystsUsed) merged.catalystsUsed = catalystsUsed;

    const repair = mergeRepairStamp(accumulated.repair, next.repair);
    if (repair) merged.repair = repair;
    if (accumulated.unreliable || next.unreliable) merged.unreliable = true;

    // The stamp is the model this run was predicted against. If the parts were
    // predicted differently — a catalyst swapped between reloads, say — no one
    // rate describes the whole, and a merged session judged against either would
    // be a fabricated calibration point. It is dropped rather than picked.
    if ((accumulated.predictedRate ?? null) !== (next.predictedRate ?? null)) {
        merged.predictedRate = null;
        merged.predictedAt = null;
        merged.predictedCatalystHrid = null;
    }

    // A merged record is counted under the oldest rules among its parts, and
    // a part with no stamp predates the stamp entirely
    const trackerVersion = mergedTrackerVersion(accumulated, next);
    if (trackerVersion === null) delete merged.trackerVersion;
    else merged.trackerVersion = trackerVersion;

    merged.mergedFrom = [...(accumulated.mergedFrom || [accumulated.id]), next.id];

    return merged;
}

/**
 * Rejoin sessions that a page reload split, without touching what is stored.
 *
 * @param {Array<Object>} sessions - A character's stored sessions for one tracker
 * @returns {Array<Object>} The same sessions, with reload splits merged
 */
export function mergeReloadSplitSessions(sessions) {
    const list = Array.isArray(sessions) ? sessions.filter(Boolean) : [];
    if (list.length < 2) return Array.isArray(sessions) ? sessions : [];

    const ordered = [...list].sort((a, b) => num(a.startTime) - num(b.startTime));

    const out = [];
    // The merged record accumulates, but every gap test is made against the last
    // ORIGINAL part rather than the accumulation: the accumulation's pace has the
    // merged-over gaps baked into it, and a chain of merges would then loosen its
    // own threshold a little at every step.
    let lastPart = null;
    let merged = false;

    for (const session of ordered) {
        const open = out[out.length - 1];

        if (open && lastPart && isReloadSplit(lastPart, session)) {
            const candidate = foldSession(open, session);
            // Cheap guard on the invariant every reader depends on. Each part
            // satisfies it, so the sums do too — unless a stored record was
            // already inconsistent, in which case the split is left alone.
            if (num(candidate.totalSuccesses) <= num(candidate.totalAttempts)) {
                out[out.length - 1] = candidate;
                lastPart = session;
                merged = true;
                continue;
            }
        }

        out.push(session);
        lastPart = session;
    }

    return merged ? out : sessions;
}

/**
 * Map a reader's kept sessions back onto the stored records behind them.
 *
 * A viewer's single-row delete hands back the merged array it was showing; the
 * rows it dropped stand for every part that went into them.
 *
 * @param {Array<Object>} kept - Sessions the reader wants to keep, possibly merged
 * @param {Array<Object>} stored - The unmerged sessions as they are on disk
 * @returns {Array<Object>} The stored sessions to keep
 */
export function expandKeptSessions(kept, stored) {
    const keepIds = new Set();
    for (const session of kept || []) {
        if (session?.id !== undefined) keepIds.add(session.id);
        for (const id of session?.mergedFrom || []) keepIds.add(id);
    }

    return (stored || []).filter((session) => keepIds.has(session?.id));
}

export default { mergeReloadSplitSessions, expandKeptSessions, isReloadSplit, sessionPaceMs };
