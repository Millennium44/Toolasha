/**
 * Verify engine: re-measure the answers the Combat Sim and Lab Sim analyses gave, on seeds they never saw.
 *
 * An analysis picks its winners out of dozens of candidates on one shared seed, so the top row is partly the
 * luckiest one (the winner's curse), and its error bar is an unpaired upper bound. Verifying re-runs a short
 * list of rows against a fresh block of seeds, longer than the original, and judges each row on the paired
 * per-seed differences (candidate minus baseline, both on the same seed), the same rule the trigger tuner's
 * final check uses. Nothing here changes the engine or its RNG; it only calls the runners.
 *
 * Pairing rule: seed and worker count together decide the random stream, so every baseline/candidate pair
 * runs `{ workers: 1, preempt: false }` (see the note in upgrade-advisor.js on the baseline call).
 *
 * Every function returns plain data (no Infinity, no class instances), safe to remember. An `abortSignal` is a
 * function returning true once the user pressed Stop (the convention of upgrade-advisor.js), not an
 * AbortSignal.
 */

import { buildGameDataPayload } from './combat-sim-adapter.js';
import { runSimulation, runLabyrinthSimulation } from './combat-sim-runner.js';
import { TASK_DAMAGE_OFF } from './engine/task-damage-mode.js';
import { deriveSeed, randomSeed } from './engine/rng.js';
import { applyTriggerRows } from './lab-condition-search.js';
import { labSampleFromResults, labTrials } from './lab-trigger-optimizer.js';
import { concurrency, createLimiter, sampleFromResult } from './trigger-optimizer.js';
import {
    CONFIRM_SEEDS_MIN,
    DEFAULT_PRECISION,
    LAB_OBJECTIVE,
    PRECISIONS,
    ROUND_GROWTH,
    applyTriggerValues,
    balancedScore,
    mean,
    objectiveScore,
    pairedDiff,
    profitValuation,
    scopeMetrics,
    tCritical,
} from './trigger-tuning.js';
import {
    PAIRED_TIME_HEADROOM,
    applyCandidateToDTO,
    applyCommunityBuffCandidate,
    buildModifiedCombatBuffs,
    candidateAssignmentKey,
    computeDeltas,
    computeMetrics,
    expectedFightAttempts,
    pairedTrialRule,
} from './upgrade-advisor.js';

/**
 * Defaults for a verify run: seeds per row, how many times longer than the analysis it simulates in total,
 * and how many top rows a UI verifies when it picks them itself.
 */
export const VERIFY_DEFAULTS = { seeds: 8, hoursMultiplier: 4, top: 3 };

/** The metrics a combat verify can judge on (the Ability order section's Rank-by keys) */
export const VERIFY_METRICS = ['profit', 'xp', 'dps', 'eph', 'balanced'];

/** Simulated-time ceiling per labyrinth attempt, as the Lab trigger tuner sizes its runs (a fight times out at 120 s) */
const CEILING_SECONDS_PER_TRIAL = 240;

/** The three combat axes a row's `significantBy` and `noise` carry */
const COMBAT_AXES = ['dps', 'profit', 'xp'];

/**
 * Whether a paired difference clears the 95% t bound for its own number of seeds, in either direction.
 * The same rule as the trigger tuner's `accepts`, less its minimum gain.
 * @param {Object} params
 * @param {number} params.mean - Mean paired difference (candidate minus baseline)
 * @param {number} params.se - Its standard error
 * @param {number} params.seeds - Seeds the difference was measured on
 * @param {boolean} [params.betterIsHigher] - False when a lower figure is the improvement (expected attempts)
 * @returns {'confirmed'|'worse'|'not-confirmed'} Confirmed better, confirmed worse, or neither (including
 *   fewer than two seeds or a non-finite error, which prove nothing)
 */
export function classifyVerdict({ mean: diff, se, seeds, betterIsHigher = true }) {
    if (!Number.isFinite(diff) || !Number.isFinite(se) || !(seeds >= 2)) return 'not-confirmed';
    const gain = betterIsHigher ? diff : -diff;
    const bound = tCritical(seeds - 1) * se;
    if (gain > 0 && gain > bound) return 'confirmed';
    if (gain < 0 && -gain > bound) return 'worse';
    return 'not-confirmed';
}

/**
 * Whether an analysis row is a close call: worth spending a verify run on. True when its improvement is
 * positive but the analysis did not call it significant, or when its delta is within twice its own noise.
 *
 * Two row shapes. A Lab row has `attemptsDelta` / `attemptsDeltaNoise` / `significant` (lower attempts is the
 * improvement). A Combat row has percentage `deltas`, `noise` and `significantBy` per axis; the axis judged is
 * `options.metric` (profit, xp, dps, eph) or, when not given, the axis with the largest gain.
 * @param {Object} row - An analysis result row
 * @param {Object} [options]
 * @param {string} [options.metric] - A VERIFY_METRICS key; absent means "best axis"
 * @param {{gain: number, noise: number|null, within: boolean}} [options.score] - The row's gain on the scale its
 *   table ranks it by, that gain's error in the same unit and whether the gain sits inside the significance
 *   bound, as the Ability order section judges them (balanced: score points with the deaths error; profit: gold
 *   against the gross-scaled error). When given it decides, whatever the metric. Without it `balanced` means
 *   "best axis"
 * @returns {boolean}
 */
export function isCloseCall(row, { metric, score } = {}) {
    if (!row || typeof row !== 'object') return false;

    // A caller that ranked the row on its own scale (balanced score points, profit in gold against the gross-scaled
    // error) judges it on that, not on the row's percentage deltas: a profit delta is a percent of net profit, which
    // near break-even makes any gain look significant
    if (score && Number.isFinite(score.gain)) {
        if (score.gain > 0 && score.within) return true;
        return Number.isFinite(score.noise) && Math.abs(score.gain) <= 2 * score.noise;
    }

    if (Number.isFinite(row.attemptsDelta)) {
        const improvement = -row.attemptsDelta;
        const noise = row.attemptsDeltaNoise;
        if (improvement > 0 && row.significant === false) return true;
        return Number.isFinite(noise) && Math.abs(row.attemptsDelta) <= 2 * noise;
    }

    const deltas = row.deltas;
    if (!deltas) return false;
    const axisOf = { profit: 'profit', xp: 'xp', dps: 'dps', eph: 'encounters' };
    let axis = axisOf[metric];
    if (!axis) {
        axis = COMBAT_AXES.reduce((best, a) => ((deltas[a] ?? -Infinity) > (deltas[best] ?? -Infinity) ? a : best));
    }
    const delta = deltas[axis];
    if (!Number.isFinite(delta)) return false;
    if (delta > 0 && row.significantBy?.[axis] === false) return true;
    const noise = row.noise?.[axis];
    return Number.isFinite(noise) && Math.abs(delta) <= 2 * noise;
}

/**
 * A fresh seed block base, never equal to the analysis' own seed (which may be null when shared seeds are off).
 * @param {...(number|null|undefined)} avoid - Seeds the block must differ from
 * @returns {number}
 */
function freshSeed(...avoid) {
    let seed = randomSeed();
    // A 31-bit collision is vanishingly rare, but the guard keeps a mocked generator from looping forever on it
    for (let tries = 0; tries < 8 && avoid.includes(seed); tries++) seed = randomSeed();
    return seed;
}

/** Plain-data number: an unusable figure (NaN, Infinity) becomes null so it survives JSON */
const plain = (value) => (Number.isFinite(value) ? value : null);

/** The error text of anything thrown */
const messageOf = (error) => (error instanceof Error ? error.message : String(error));

/**
 * Whether a thrown error is only a simulation THIS verify's own Stop terminated: after Stop it means "did not
 * finish", not "broke". A cancel with no Stop of ours (another simulator calling `cancelActiveSimulations()`) is a
 * real failure: swallowing it would leave a partial result that reads as a completed verification.
 * @param {*} _error - What was thrown (not inspected: only our own stop signal tells a cancel from a failure)
 * @param {Function} stopped - `() => boolean`, true once the run was asked to stop
 * @returns {boolean}
 */
const isCancel = (_error, stopped) => stopped();

/**
 * Turn per-seed paired differences into one row result.
 * @param {string} key - Row key
 * @param {Array<number>} diffs - One difference per completed seed
 * @param {boolean} betterIsHigher
 * @param {number} requestedSeeds - Seeds the run was asked for; a row that finished fewer (a stopped run) can never
 *   be `confirmed` or `worse`, because the standard error it was judged on was never the one that was asked for
 * @returns {{key: string, mean: number|null, se: number|null, seeds: number, verdict: string}}
 */
function rowFromDiffs(key, diffs, betterIsHigher, requestedSeeds) {
    const paired = pairedDiff(
        diffs,
        diffs.map(() => 0)
    );
    const judged = classifyVerdict({ mean: paired.mean, se: paired.se, seeds: paired.n, betterIsHigher });
    const verdict = paired.n < requestedSeeds ? 'not-confirmed' : judged;
    return {
        key,
        mean: paired.n > 0 ? plain(paired.mean) : null,
        se: plain(paired.se),
        seeds: paired.n,
        verdict,
    };
}

/** A candidate's stable key, falling back to what the row itself carries */
function rowKey(row, index) {
    try {
        if (row?.candidate) return candidateAssignmentKey(row.candidate);
    } catch {
        // fall through to the description
    }
    return row?.key ?? row?.candidate?.description ?? `row-${index}`;
}

/**
 * The ranked gain of one candidate on one seed, in the unit the Ability order section's Rank-by shows: gold for
 * profit, percent for xp / dps / eph, score points for balanced.
 * @param {string} metric - A VERIFY_METRICS key
 * @param {Object} base - `computeMetrics` of the baseline on this seed
 * @param {Object} cand - `computeMetrics` of the candidate on the same seed
 * @param {boolean} [withProfit] - False when profit could not be valued: balanced then leaves its profit term out
 * @returns {number}
 */
function combatGain(metric, base, cand, withProfit = true) {
    if (metric === 'profit') return (cand.profitPerHour ?? NaN) - (base.profitPerHour ?? NaN);
    const deltas = computeDeltas(base, cand);
    if (metric === 'xp') return deltas.xp;
    if (metric === 'dps') return deltas.dps;
    if (metric === 'eph') return deltas.encounters;
    const asScore = (m) => ({
        xp: m?.xpPerHour,
        profit: m?.profitPerHour,
        // Gross revenue and cost let profitScale size the profit term against cash flow, not net profit
        revenue: m?.revenuePerHour,
        cost: m?.costPerHour,
        dps: m?.dps,
        encounters: m?.encountersPerHour,
        deaths: m?.deathsPerHour,
    });
    return balancedScore(asScore(cand), asScore(base), { withProfit });
}

const UNIT_OF = { profit: 'gold/hr', xp: '%', dps: '%', eph: '%', balanced: 'points' };

/**
 * Re-measure Combat Sim upgrade rows on a fresh seed block.
 *
 * For each of `seeds` fresh seeds the baseline runs once and every row's candidate runs on that same seed
 * (`workers: 1`, `preempt: false`, no precision), each for `context.hours * hoursMultiplier / seeds` simulated
 * hours, so the total is `hoursMultiplier` times the analysis' own. The per-seed gain (candidate minus baseline,
 * on the metric's own scale) feeds `pairedDiff`; the verdict is `classifyVerdict`. Ability-order rows use the
 * same candidate path. Simulations go through one limiter at the analysis' concurrency.
 * @param {Object} params
 * @param {Object} params.context - `context` from `runUpgradeAnalysis`
 * @param {Array<Object>} params.rows - Analysis result rows (each carries `candidate`)
 * @param {number} [params.seeds] - Seeds per row; fewer than 2 is refused (a standard error needs two)
 * @param {number} [params.hoursMultiplier] - Total simulated time as a multiple of `context.hours`
 * @param {string} [params.metric] - A VERIFY_METRICS key
 * @param {Function} [params.abortSignal] - `() => boolean`, true once the run should stop
 * @param {Function} [params.onProgress] - Called with `{ current, total, description }`
 * @returns {Promise<{rows: Array<Object>, metric: string, unit: string, seeds: number, hoursPerSeed: number,
 *   stopped: boolean, refused?: string, error?: string}>} Rows are `{ key, description, mean, se, seeds,
 *   verdict, error? }` with verdict `confirmed` | `worse` | `not-confirmed` | `error`; `mean` and `se` are in
 *   `unit`. `stopped` means Stop cut the run short and rows carry only the seeds that finished (a row with
 *   fewer than two is `not-confirmed`). `refused` is `seeds`, `rows`, `metric` or `context` when nothing ran.
 *   A row whose baseline or candidate valuation counted an unpriced item at zero carries `profitLeftOut: true`
 *   and `unpriced`: on profit it is `not-confirmed` with no figure, on balanced it was judged without profit
 */
export async function verifyCombatCandidates({
    context,
    rows,
    seeds = VERIFY_DEFAULTS.seeds,
    hoursMultiplier = VERIFY_DEFAULTS.hoursMultiplier,
    metric = 'profit',
    abortSignal,
    onProgress,
}) {
    const unit = UNIT_OF[metric] ?? '';
    const empty = (extra) => ({ rows: [], metric, unit, seeds, hoursPerSeed: 0, stopped: false, ...extra });
    if (!VERIFY_METRICS.includes(metric)) return empty({ refused: 'metric' });
    if (!Number.isInteger(seeds) || seeds < 2) return empty({ refused: 'seeds' });
    if (!Array.isArray(rows) || rows.length === 0) return empty({ refused: 'rows' });
    const { gameData, playerDTOs, playerIndex, playerHrid, zoneHrid, difficultyTier, hours, communityBuffs } =
        context || {};
    if (!gameData || !playerDTOs?.[playerIndex] || !(hours > 0)) return empty({ refused: 'context' });

    const hoursPerSeed = (hours * hoursMultiplier) / seeds;
    const fresh = freshSeed(context.seed);
    const seedOf = (k) => deriveSeed(fresh, k);
    const limit = createLimiter(concurrency());
    const stopped = () => Boolean(abortSignal?.());
    const total = seeds * (rows.length + 1);
    const tally = { done: 0 };
    const report = (description) => onProgress?.({ current: Math.min(tally.done, total), total, description });
    // One set of held prices for the baseline and every candidate: a market or custom-price update partway through
    // the run cannot read as a gain (the trigger optimizer does the same)
    const priceCache = new Map();

    const simulate = (dtos, buffs, seed) =>
        limit(async () => {
            if (stopped()) return null;
            const result = await runSimulation(
                {
                    gameData,
                    playerDTOs: dtos,
                    zoneHrid,
                    difficultyTier,
                    hours: hoursPerSeed,
                    communityBuffs: buffs,
                    seed,
                    taskDamageMode: TASK_DAMAGE_OFF,
                },
                null,
                { preempt: false, workers: 1 }
            );
            tally.done++;
            return result;
        });

    report('Verify: baseline');
    // Enqueued before any candidate, so with a single lane the baselines are the first to run
    const baselines = Array.from({ length: seeds }, (_, k) =>
        simulate(playerDTOs, communityBuffs, seedOf(k)).then((result) => {
            report('Verify: baseline');
            return result ? computeMetrics(result, gameData, playerHrid, hoursPerSeed, { priceCache }) : null;
        })
    );
    // A baseline that throws takes the whole verify down: nothing can be paired to it. Awaiting them all here
    // keeps a rejection from going unhandled while candidates are still queued
    const baselineOutcome = await Promise.allSettled(baselines);
    const failedBaseline = baselineOutcome.find((o) => o.status === 'rejected');
    if (failedBaseline) {
        // Stop terminates the baseline in flight: that is a stop with nothing measured, not a failure
        if (baselineOutcome.every((o) => o.status !== 'rejected' || isCancel(o.reason, stopped))) {
            return { ...empty({}), hoursPerSeed, stopped: true };
        }
        const error = messageOf(failedBaseline.reason);
        console.error('[VerifyRunner] Baseline failed:', failedBaseline.reason);
        return {
            ...empty({}),
            hoursPerSeed,
            error,
            rows: rows.map((row, i) => ({
                key: rowKey(row, i),
                description: row?.candidate?.description ?? null,
                mean: null,
                se: null,
                seeds: 0,
                verdict: 'error',
                error,
            })),
        };
    }
    const baseMetrics = baselineOutcome.map((o) => o.value);
    // Items the baseline's profit counted at zero: with any, no row's profit gain is a figure
    const baselineUnpriced = new Set(baseMetrics.flatMap((m) => m?.unpriced || []));

    const results = rows.map(async (row, i) => {
        const key = rowKey(row, i);
        const description = row?.candidate?.description ?? null;
        const failure = (error) => ({
            key,
            description,
            mean: null,
            se: null,
            seeds: 0,
            verdict: 'error',
            error: messageOf(error),
        });
        let dto;
        let buffs;
        try {
            if (!row?.candidate) throw new Error('Row has no candidate');
            dto = applyCandidateToDTO(playerDTOs[playerIndex], row.candidate);
            buffs = applyCommunityBuffCandidate(communityBuffs, row.candidate);
        } catch (error) {
            console.error('[VerifyRunner] Could not apply candidate:', error);
            // Its seeds will never run; count them so the bar still fills
            tally.done += seeds;
            return failure(error);
        }
        const dtos = playerDTOs.map((player, index) => (index === playerIndex ? dto : player));
        const state = { failed: null };
        // Every seed's candidate metrics are kept: whether profit can be valued is known only once all of them are
        const measured = await Promise.all(
            Array.from({ length: seeds }, async (_, k) => {
                if (state.failed || stopped() || !baseMetrics[k]) return null;
                try {
                    const result = await simulate(dtos, buffs, seedOf(k));
                    if (!result) return null;
                    report(`Verify: ${description ?? key}`);
                    return {
                        base: baseMetrics[k],
                        cand: computeMetrics(result, gameData, playerHrid, hoursPerSeed, { priceCache }),
                    };
                } catch (error) {
                    // A simulation Stop terminated is a seed that did not finish, not a broken candidate
                    if (isCancel(error, stopped)) return null;
                    console.error('[VerifyRunner] Candidate simulation failed:', error);
                    state.failed = state.failed || error;
                    return null;
                }
            })
        );
        if (state.failed) return failure(state.failed);
        // An unpriced drop, consumable or key counts as zero, so a profit built on any of them (either side) is a floor
        const unpriced = new Set(baselineUnpriced);
        for (const m of measured) for (const item of m?.cand?.unpriced || []) unpriced.add(item);
        const profitLeftOut = unpriced.size > 0;
        const gains = measured.map((m) => {
            if (!m) return null;
            const gain = combatGain(metric, m.base, m.cand, !profitLeftOut);
            return Number.isFinite(gain) ? gain : null;
        });
        const finished = gains.filter((g) => g !== null);
        // Every gain unusable (non-finite) on a run nobody stopped: nothing was measured, which is a failure
        if (finished.length === 0 && !stopped()) return failure(new Error('No seed produced a usable result'));
        const out = { ...rowFromDiffs(key, finished, true, seeds), description };
        if (!profitLeftOut) return out;
        out.profitLeftOut = true;
        out.unpriced = [...unpriced].sort();
        // A profit gain on a floor proves nothing either way; balanced already judged without its profit term
        if (metric === 'profit') return { ...out, mean: null, se: null, verdict: 'not-confirmed' };
        return out;
    });

    const settled = await Promise.all(results);
    return { rows: settled, metric, unit, seeds, hoursPerSeed, stopped: stopped() };
}

/** Win rate of a labyrinth sim: wins over attempts played */
const winRateOf = (result) => (Number(result?.encounters) || 0) / (Number(result?.labyAttemptCount) || 1);

/**
 * Re-measure Lab Sim all-fights rows on a fresh seed block, on expected attempts to clear (lower is better).
 *
 * For each fresh seed `k` and fight `i` the baseline runs first, with the fight's own seed
 * `deriveSeed(deriveSeed(fresh, k), i)`, for `context.hours * hoursMultiplier / seeds` hours and no precision;
 * its attempt count becomes the trial count every candidate on that fight and seed must match
 * (`pairedTrialRule`), so the pairing is taken from this new baseline and never from the analysis' old
 * `pairing.rules`. A row's per-seed figure is the sum, over the fights it applies to, of the change in expected
 * attempts. Rows may be several-fights-per-loadout rows or Ability order rows; a fight a row does not apply to
 * contributes nothing and is not simulated. Token buff rows and combat-level rows (with their `alongside`
 * boosts) are rebuilt as the analysis built them.
 * @param {Object} params
 * @param {Object} params.context - `context` from `runLabyrinthAllFightsAnalysis`
 *   (`{ fights, crates, hours, communityBuffs, labyrinthCombatBuffs }`)
 * @param {Object} [params.pairing] - `pairing` from the same analysis. Only its `seed` is read, to keep the
 *   fresh block distinct from it; its `rules` are deliberately ignored
 * @param {Array<Object>} params.rows - All-fights result rows (each carries `candidate` and `fights[i].applied`)
 * @param {number} [params.seeds] - Seeds per row; fewer than 2 is refused
 * @param {number} [params.hoursMultiplier] - Total simulated time as a multiple of `context.hours`
 * @param {Function} [params.abortSignal] - `() => boolean`, true once the run should stop
 * @param {Function} [params.onProgress] - Called with `{ current, total, description }`
 * @returns {Promise<{rows: Array<Object>, metric: string, unit: string, seeds: number, hoursPerSeed: number,
 *   stopped: boolean, refused?: string, error?: string}>} Rows as in `verifyCombatCandidates`; `mean` is the
 *   change in expected attempts (negative is better)
 */
export async function verifyLabCandidates({
    context,
    pairing,
    rows,
    seeds = VERIFY_DEFAULTS.seeds,
    hoursMultiplier = VERIFY_DEFAULTS.hoursMultiplier,
    abortSignal,
    onProgress,
}) {
    const metric = 'attempts';
    const unit = 'attempts';
    const empty = (extra) => ({ rows: [], metric, unit, seeds, hoursPerSeed: 0, stopped: false, ...extra });
    if (!Number.isInteger(seeds) || seeds < 2) return empty({ refused: 'seeds' });
    if (!Array.isArray(rows) || rows.length === 0) return empty({ refused: 'rows' });
    const { fights, crates, hours, communityBuffs, labyrinthCombatBuffs = [] } = context || {};
    const gameData = context?.gameData ?? buildGameDataPayload();
    if (!gameData || !Array.isArray(fights) || fights.length === 0 || !(hours > 0)) {
        return empty({ refused: 'context' });
    }

    const zoneHrid =
        Object.keys(gameData.actionDetailMap || {}).find((k) => k.includes('/actions/combat/')) ||
        '/actions/combat/fly';
    const hoursPerSeed = (hours * hoursMultiplier) / seeds;
    const fresh = freshSeed(pairing?.seed);
    const seedOf = (k, i) => deriveSeed(deriveSeed(fresh, k), i);
    const limit = createLimiter(concurrency());
    const stopped = () => Boolean(abortSignal?.());

    // Which fights each row reaches, by what the analysis recorded for it
    const appliedOf = (row) =>
        fights.map((_, i) => Boolean(row?.fights?.[i]?.applied ?? row?.candidate?.appliesTo?.[i]));
    const reach = rows.map(appliedOf);
    const needed = fights.map((_, i) => reach.some((r) => r[i]));
    const total = needed.filter(Boolean).length * seeds + reach.flat().filter(Boolean).length * seeds;
    const tally = { done: 0 };
    const report = (description) => onProgress?.({ current: Math.min(tally.done, total), total, description });

    const simulate = (dto, fight, seed, hoursRun, precision, buffs) =>
        limit(async () => {
            if (stopped()) return null;
            const result = await runLabyrinthSimulation({
                gameData,
                playerDTOs: [dto],
                zoneHrid,
                monsterHrid: fight.monsterHrid,
                roomLevel: fight.roomLevel,
                crates,
                hours: hoursRun,
                precision,
                communityBuffs,
                labyrinthCombatBuffs: buffs,
                seed,
            });
            tally.done++;
            return result;
        });

    report('Verify: baseline fights');
    // baselines[k][i]: the new baseline run of fight i on seed k. Enqueued before every candidate
    const baselines = Array.from({ length: seeds }, (_, k) =>
        fights.map((fight, i) => {
            if (!needed[i]) return Promise.resolve(null);
            const run = simulate(fight.dto, fight, seedOf(k, i), hoursPerSeed, null, labyrinthCombatBuffs);
            // A rejected baseline is read (and reported) by every candidate waiting on it
            return run;
        })
    );
    const baselineFailure = { error: null };
    for (const row of baselines)
        for (const promise of row) {
            promise.catch((e) => {
                if (!isCancel(e, stopped)) baselineFailure.error = baselineFailure.error || e;
            });
        }

    const results = rows.map(async (row, r) => {
        const key = rowKey(row, r);
        const description = row?.candidate?.description ?? null;
        const failure = (error) => ({
            key,
            description,
            mean: null,
            se: null,
            seeds: 0,
            verdict: 'error',
            error: messageOf(error),
        });
        const candidate = row?.candidate;
        if (!candidate) return failure(new Error('Row has no candidate'));
        const isToken = candidate.type === 'labyrinth_buff';
        let buffs;
        const dtoFor = new Map();
        try {
            buffs = isToken ? buildModifiedCombatBuffs(labyrinthCombatBuffs, candidate) : labyrinthCombatBuffs;
            for (const [i, fight] of fights.entries()) {
                if (!reach[r][i]) continue;
                const dto = isToken ? fight.dto : applyCandidateToDTO(fight.dto, candidate);
                if (!isToken && candidate.type === 'combat_level') {
                    // The grind also trains the weapon's own skill; the analysis simulated the pair
                    for (const along of row.alongside || []) {
                        dto[along.skillKey] = Math.max(dto[along.skillKey] || 0, along.upgradeLevel);
                    }
                }
                dtoFor.set(i, dto);
            }
        } catch (error) {
            console.error('[VerifyRunner] Could not apply candidate:', error);
            tally.done += reach[r].filter(Boolean).length * seeds;
            return failure(error);
        }

        const state = { failed: null };
        const diffs = await Promise.all(
            Array.from({ length: seeds }, async (_, k) => {
                const deltas = await Promise.all(
                    fights.map(async (fight, i) => {
                        if (!reach[r][i]) return 0;
                        if (state.failed || stopped()) return null;
                        try {
                            const base = await baselines[k][i];
                            if (!base || stopped()) return null;
                            const rule = pairedTrialRule(base);
                            const result = await simulate(
                                dtoFor.get(i),
                                fight,
                                seedOf(k, i),
                                hoursPerSeed * PAIRED_TIME_HEADROOM,
                                rule,
                                buffs
                            );
                            if (!result) return null;
                            report(`Verify: ${description ?? key}`);
                            return expectedFightAttempts(winRateOf(result)) - expectedFightAttempts(winRateOf(base));
                        } catch (error) {
                            if (isCancel(error, stopped)) return null;
                            console.error('[VerifyRunner] Lab simulation failed:', error);
                            state.failed = state.failed || error;
                            return null;
                        }
                    })
                );
                // A seed counts only when every fight the row reaches finished on it
                return deltas.some((d) => d === null) ? null : deltas.reduce((sum, d) => sum + d, 0);
            })
        );
        if (state.failed) return failure(state.failed);
        return {
            ...rowFromDiffs(
                key,
                diffs.filter((d) => d !== null),
                false,
                seeds
            ),
            description,
        };
    });

    const settled = await Promise.all(results);
    if (baselineFailure.error && settled.every((row) => row.verdict === 'error')) {
        return {
            ...empty({}),
            hoursPerSeed,
            stopped: stopped(),
            error: messageOf(baselineFailure.error),
            rows: settled,
        };
    }
    return { rows: settled, metric, unit, seeds, hoursPerSeed, stopped: stopped() };
}

/**
 * Whether a trigger tuner result can be verified. A result remembered across sessions (`compactTriggerResult`)
 * carries no players or tunables, so it cannot; only a result fresh from `runTriggerOptimization` or
 * `runLabTriggerOptimization` can.
 * @param {Object|null} result - A tuner result (a Lab group's `result` for the Lab Sim)
 * @returns {boolean}
 */
export function canVerifyTriggerResult(result) {
    const ctx = result?.verifyContext;
    return Boolean(ctx && Array.isArray(ctx.tunables) && (ctx.playerDTOs || ctx.fights));
}

/**
 * The trigger setting to re-measure: the recommended changes (thresholds and, when present, new conditions) as
 * one setup, or the best row found when nothing was recommended.
 * @param {Object} result - A tuner result
 * @param {Object|null} conditions - The condition search's result (defaults to `result.conditions`)
 * @returns {{basis: string, overrides: Object, edits: Object}|null} Null when there is nothing to try
 */
function proposedSetting(result, conditions) {
    const cond = conditions ?? result.conditions ?? null;
    const overrides = Object.fromEntries((result.changes || []).map((c) => [c.key, c.to]));
    const edits = Object.fromEntries((cond?.changes || []).map((c) => [c.key, c.toRows]));
    if (Object.keys(overrides).length > 0 || Object.keys(edits).length > 0) {
        return { basis: 'recommended', overrides, edits };
    }
    if (result.bestMeasured?.key !== undefined) {
        return { basis: 'best-found', overrides: { [result.bestMeasured.key]: result.bestMeasured.to }, edits: {} };
    }
    const best = (cond?.bestMeasured || [])[0];
    if (best) return { basis: 'best-found', overrides: {}, edits: { [best.key]: best.toRows } };
    return null;
}

/**
 * Re-measure a trigger tuner's answer against the original setup on a fresh seed stream, longer than the
 * tuner's own confirmation. Works for a Combat Sim result and for one Lab Sim group's result (both carry
 * `verifyContext`); a remembered result does not, see `canVerifyTriggerResult`.
 *
 * Both setups run on each of `seeds` fresh seeds. The score is the tuner's own: `objectiveScore` against the
 * original's mean (profit counted only when both sides valued completely), or the drop in expected attempts for
 * the Lab Sim. The verdict is `classifyVerdict` on the paired per-seed scores. Per-seed hours are the tuner's
 * confirmation hours times `hoursMultiplier`, scaled by its confirm seed count over `seeds`, so the total is
 * `hoursMultiplier` times the tuner's own confirmation.
 * @param {Object} params
 * @param {Object} params.result - A tuner result carrying `verifyContext`, `changes`, `precision`
 * @param {Object} [params.conditions] - The Lab group's condition search result (the Combat Sim keeps its own in
 *   `result.conditions`)
 * @param {number} [params.seeds] - Fresh seeds; fewer than 2 is refused
 * @param {number} [params.hoursMultiplier] - Multiple of the tuner's confirmation time
 * @param {Function} [params.abortSignal] - `() => boolean`, true once the run should stop
 * @param {Function} [params.onProgress] - Called with `{ current, total, description }`
 * @returns {Promise<{rows: Array<Object>, metric: string, unit: string, seeds: number, hoursPerSeed: number,
 *   stopped: boolean, basis?: string, refused?: string, error?: string}>} One row, key `triggers`, with
 *   `mean`/`se` in score points (Combat) or attempts saved (Lab), `meetsMinGain`, and `deltaXp` / `deltaProfit` /
 *   `deltaDeaths` for the Combat Sim. `refused` is `unavailable`, `nothing` or `seeds` when nothing ran
 */
export async function verifyTriggerChanges({
    result,
    conditions = null,
    seeds = VERIFY_DEFAULTS.seeds,
    hoursMultiplier = VERIFY_DEFAULTS.hoursMultiplier,
    abortSignal,
    onProgress,
}) {
    const objectiveKey = result?.objective ?? null;
    const lab = result?.verifyContext?.kind === 'lab';
    const metric = lab ? LAB_OBJECTIVE : (objectiveKey ?? 'balanced');
    const unit = lab ? 'attempts' : 'points';
    const empty = (extra) => ({ rows: [], metric, unit, seeds, hoursPerSeed: 0, stopped: false, ...extra });
    if (!canVerifyTriggerResult(result)) return empty({ refused: 'unavailable' });
    if (!Number.isInteger(seeds) || seeds < 2) return empty({ refused: 'seeds' });
    const setting = proposedSetting(result, conditions);
    if (!setting) return empty({ refused: 'nothing' });

    const ctx = result.verifyContext;
    const precision = PRECISIONS[result.precision] || PRECISIONS[DEFAULT_PRECISION];
    const confirmSeeds = Math.max(CONFIRM_SEEDS_MIN, precision.seeds);
    const confirmHours = (precision.pointHours / precision.seeds) * ROUND_GROWTH * ROUND_GROWTH;
    const hoursPerSeed = confirmHours * hoursMultiplier * (confirmSeeds / seeds);
    const fresh = freshSeed(result.baseSeed);
    const limit = createLimiter(concurrency());
    const stopped = () => Boolean(abortSignal?.());
    const fightCount = lab ? ctx.fights.length : 1;
    const total = seeds * 2 * fightCount;
    const tally = { done: 0 };
    const report = (description) => onProgress?.({ current: Math.min(tally.done, total), total, description });

    let outcome;
    try {
        outcome = lab
            ? await measureLabTriggers({ ctx, setting, seeds, hoursPerSeed, fresh, limit, stopped, tally, report })
            : await measureCombatTriggers({
                  ctx,
                  result,
                  setting,
                  seeds,
                  hoursPerSeed,
                  fresh,
                  limit,
                  stopped,
                  tally,
                  report,
              });
    } catch (error) {
        // Stop terminates the sims in flight: a stop with nothing measured, not a failure
        if (isCancel(error, stopped)) return empty({ hoursPerSeed, basis: setting.basis, stopped: true });
        console.error('[VerifyRunner] Trigger verify failed:', error);
        return empty({
            hoursPerSeed,
            basis: setting.basis,
            error: messageOf(error),
            rows: [
                {
                    key: 'triggers',
                    mean: null,
                    se: null,
                    seeds: 0,
                    verdict: 'error',
                    error: messageOf(error),
                },
            ],
        });
    }

    // No seed finished on both setups: after Stop that is a stop with nothing measured; on a run nobody stopped (every
    // simulation cancelled from elsewhere) nothing was measured, which is a failure. Never a verdict on zero seeds
    if (outcome.scoreDiffs.length === 0) {
        if (stopped()) return empty({ hoursPerSeed, basis: setting.basis, stopped: true });
        const error = 'No seed produced a usable result';
        return empty({
            hoursPerSeed,
            basis: setting.basis,
            error,
            rows: [{ key: 'triggers', mean: null, se: null, seeds: 0, verdict: 'error', error }],
        });
    }
    const scored = rowFromDiffs('triggers', outcome.scoreDiffs, true, seeds);
    const row = {
        ...scored,
        meetsMinGain: Number.isFinite(result.minGain) && scored.mean !== null ? scored.mean >= result.minGain : null,
        ...outcome.extra,
    };
    return { rows: [row], metric, unit, seeds, hoursPerSeed, stopped: stopped(), basis: setting.basis };
}

/**
 * The Combat Sim half of `verifyTriggerChanges`: both setups on each fresh seed, scored as the tuner scores.
 * @private
 */
async function measureCombatTriggers({
    ctx,
    result,
    setting,
    seeds,
    hoursPerSeed,
    fresh,
    limit,
    stopped,
    tally,
    report,
}) {
    const {
        gameData,
        playerDTOs,
        playerIndex,
        zoneHrid,
        difficultyTier,
        communityBuffs,
        scopeHrids,
        allHrids,
        tunables,
    } = ctx;
    const tunedDtos = (() => {
        const dtos = applyTriggerValues(playerDTOs, tunables, setting.overrides);
        if (Object.keys(setting.edits).length === 0) return dtos;
        return dtos.map((dto, i) => (i === playerIndex ? applyTriggerRows(dto, setting.edits) : dto));
    })();
    // One read per price for the whole verify, like the tuner: a price update mid-run must not look like an effect
    const priceCache = new Map();

    const sampleOn = (dtos, seed) =>
        limit(async () => {
            if (stopped()) return null;
            let simResult;
            try {
                simResult = await runSimulation(
                    {
                        gameData,
                        playerDTOs: dtos,
                        zoneHrid,
                        difficultyTier,
                        hours: hoursPerSeed,
                        communityBuffs,
                        seed,
                        taskDamageMode: TASK_DAMAGE_OFF,
                    },
                    null,
                    { preempt: false, workers: 1 }
                );
            } catch (error) {
                // Stop terminates the sims in flight: this seed did not finish, and the seeds that did still count
                if (isCancel(error, stopped)) return null;
                throw error;
            }
            tally.done++;
            report('Verify: triggers');
            return sampleFromResult(simResult, gameData, allHrids, hoursPerSeed, { priceCache });
        });

    const pairs = await Promise.all(
        Array.from({ length: seeds }, async (_, k) => {
            const seed = deriveSeed(fresh, k);
            const [orig, tuned] = await Promise.all([sampleOn(playerDTOs, seed), sampleOn(tunedDtos, seed)]);
            return orig && tuned ? { orig, tuned } : null;
        })
    );
    const done = pairs.filter(Boolean);
    const origSamples = done.map((p) => p.orig);
    const tunedSamples = done.map((p) => p.tuned);
    const origMetrics = origSamples.map((s) => scopeMetrics(s, scopeHrids));
    const tunedMetrics = tunedSamples.map((s) => scopeMetrics(s, scopeHrids));
    const baseScope = {};
    for (const key of ['xp', 'profit', 'revenue', 'cost', 'deaths', 'dps', 'encounters', 'attempts']) {
        baseScope[key] = mean(origMetrics.map((m) => m[key]));
    }
    const objective = result.objective ?? 'balanced';
    const withProfit =
        profitValuation([origSamples], scopeHrids).complete && profitValuation([tunedSamples], scopeHrids).complete;
    const scoreDiffs = tunedMetrics.map(
        (m, i) =>
            objectiveScore(m, baseScope, objective, { withProfit }) -
            objectiveScore(origMetrics[i], baseScope, objective, { withProfit })
    );
    return {
        scoreDiffs,
        extra: {
            objective,
            profitLeftOut: !withProfit,
            deltaXp: plain(mean(tunedMetrics.map((m) => m.xp)) - baseScope.xp),
            deltaProfit: plain(mean(tunedMetrics.map((m) => m.profit)) - baseScope.profit),
            deltaDeaths: plain(mean(tunedMetrics.map((m) => m.deaths)) - baseScope.deaths),
        },
    };
}

/**
 * The Lab Sim half of `verifyTriggerChanges`: every fight of the group on each fresh seed, both setups playing
 * the same fixed attempt count, scored as the drop in expected attempts.
 * @private
 */
async function measureLabTriggers({ ctx, setting, seeds, hoursPerSeed, fresh, limit, stopped, tally, report }) {
    const { gameData, fights, hrid, zoneHrid, crates, communityBuffs, labyrinthCombatBuffs, tunables } = ctx;
    const trials = labTrials(hoursPerSeed);
    const ceiling = (trials * CEILING_SECONDS_PER_TRIAL) / 3600;
    const tuned = fights.map((fight) => {
        const dto = applyTriggerValues([fight.dto], tunables, setting.overrides)[0];
        return Object.keys(setting.edits).length > 0 ? applyTriggerRows(dto, setting.edits) : dto;
    });

    const runFight = (dto, fight, seed) =>
        limit(async () => {
            if (stopped()) return null;
            let simResult;
            try {
                simResult = await runLabyrinthSimulation({
                    gameData,
                    playerDTOs: [dto],
                    zoneHrid,
                    monsterHrid: fight.monsterHrid,
                    roomLevel: fight.roomLevel,
                    crates,
                    hours: ceiling,
                    // A fixed count, so both setups on this seed play the same attempts
                    precision: { minTrials: trials, maxTrials: trials },
                    communityBuffs,
                    labyrinthCombatBuffs,
                    seed,
                });
            } catch (error) {
                // Stop terminates the sims in flight: this seed did not finish, and the seeds that did still count
                if (isCancel(error, stopped)) return null;
                throw error;
            }
            tally.done++;
            report('Verify: triggers');
            return simResult;
        });

    const sampleOn = async (dtoOf, k) => {
        const seed = deriveSeed(fresh, k);
        const results = await Promise.all(fights.map((fight, i) => runFight(dtoOf(i), fight, deriveSeed(seed, i))));
        return results.some((r) => !r) ? null : labSampleFromResults(results, hrid, trials);
    };
    const pairs = await Promise.all(
        Array.from({ length: seeds }, async (_, k) => {
            const [orig, tunedSample] = await Promise.all([
                sampleOn((i) => fights[i].dto, k),
                sampleOn((i) => tuned[i], k),
            ]);
            return orig && tunedSample ? { orig, tuned: tunedSample } : null;
        })
    );
    const done = pairs.filter(Boolean);
    const origMetrics = done.map((p) => scopeMetrics(p.orig, [hrid]));
    const baseScope = { attempts: mean(origMetrics.map((m) => m.attempts)) };
    const scoreDiffs = done.map(
        (p, i) =>
            objectiveScore(scopeMetrics(p.tuned, [hrid]), baseScope, LAB_OBJECTIVE) -
            objectiveScore(origMetrics[i], baseScope, LAB_OBJECTIVE)
    );
    return {
        scoreDiffs,
        extra: {
            objective: LAB_OBJECTIVE,
            trials,
            baselineAttempts: plain(baseScope.attempts),
            tunedAttempts: plain(mean(done.map((p) => p.tuned.attempts))),
        },
    };
}
