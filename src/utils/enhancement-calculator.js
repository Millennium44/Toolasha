/**
 * Enhancement Calculator
 *
 * Uses Markov Chain matrix math to calculate exact expected values for enhancement attempts.
 * Based on the original MWI Tools Enhancelate() function.
 *
 * Math.js library is loaded via userscript @require header.
 */

import { MIN_ACTION_TIME_SECONDS } from './profit-constants.js';
import matrixMath from './matrix-inverse.js';

/**
 * Base success rates by enhancement level (before bonuses)
 */
export const BASE_SUCCESS_RATES = [
    50, // +1
    45, // +2
    45, // +3
    40, // +4
    40, // +5
    40, // +6
    35, // +7
    35, // +8
    35, // +9
    35, // +10
    30, // +11
    30, // +12
    30, // +13
    30, // +14
    30, // +15
    30, // +16
    30, // +17
    30, // +18
    30, // +19
    30, // +20
];

/**
 * Blessed Tea's base chance to skip an extra level on success, as a decimal.
 * Used when the caller has no live consumable data to read the real flatBoost from.
 */
export const BLESSED_TEA_BASE_CHANCE = 0.01;

/**
 * Build the enhancement Markov transition matrix.
 *
 * This body is the single source of the chain. The networth and enhancement worker pools run
 * inside blob workers that cannot import a module, so their managers serialise this function
 * with `toString()` and drop the identical text into their worker scripts — which is why it
 * takes `math` and the base rates as arguments and closes over nothing. Any module-scope name
 * read from here would not exist in the worker, and the two copies would drift apart again.
 *
 * `math` used to be the math.js global pulled in by a `@require`; it is now the tiny namespace
 * from `matrix-inverse.js`, which the workers serialise the same way.
 *
 * @param {Object} math - Matrix namespace (a parameter, not a module import, so this can be serialised)
 * @param {Object} options - Chain parameters
 * @param {number[]} options.baseSuccessRates - Base success rate per level, as percentages
 * @param {number} options.successMultiplier - Multiplier applied to the base rates
 * @param {number} options.targetLevel - Absorbing state
 * @param {number} [options.protectFrom=0] - Level from which a failure drops one level instead of to 0
 * @param {boolean} [options.blessedTea=false] - Whether Blessed Tea is active
 * @param {number} [options.guzzlingBonus=1.0] - Drink concentration multiplier
 * @param {number} [options.blessedTeaBonus=0.01] - Blessed Tea double-jump chance as a decimal
 * @returns {Object} 20×20 transition matrix
 */
export function buildEnhancementMarkov(math, options) {
    const {
        baseSuccessRates,
        successMultiplier,
        targetLevel,
        protectFrom = 0,
        blessedTea = false,
        guzzlingBonus = 1.0,
        blessedTeaBonus = 0.01,
    } = options;

    const markov = math.zeros(20, 20);

    for (let i = 0; i < targetLevel; i++) {
        const baseSuccessRate = baseSuccessRates[i] / 100.0;
        // A big enough success multiplier pushes the raw product past 1, which would hand the
        // failure row a negative probability and quietly corrupt the whole chain.
        const successChance = Math.min(1, baseSuccessRate * successMultiplier);

        // Where do we go on failure?
        // Protection only applies when protectFrom > 0 AND we're at or above that level
        const failureDestination = protectFrom > 0 && i >= protectFrom ? i - 1 : 0;

        if (blessedTea) {
            // Blessed Tea: base chance to jump +2 (read from item data when available),
            // scaled by guzzling bonus. Remaining success chance goes to +1.
            const skipChance = successChance * blessedTeaBonus * guzzlingBonus;
            const remainingSuccess = successChance * (1 - blessedTeaBonus * guzzlingBonus);

            // A jump from the last transient level lands past the absorbing state, which is
            // outside the matrix. It is already absorbed either way, so drop it.
            if (i + 2 <= targetLevel) {
                markov.set([i, i + 2], skipChance);
            }
            markov.set([i, i + 1], remainingSuccess);
            markov.set([i, failureDestination], 1 - successChance);
        } else {
            // Normal: Success goes to +1, failure goes to destination
            markov.set([i, i + 1], successChance);
            markov.set([i, failureDestination], 1.0 - successChance);
        }
    }

    // Absorbing state at target level
    markov.set([targetLevel, targetLevel], 1.0);

    return markov;
}

/**
 * Fold Philosopher's Mirror combinations into a per-level cost array.
 *
 * A mirror welds a +(n−1) and a +(n−2) into a +n, so a level can always be bought either the
 * hard way or as two cheaper items plus one mirror. Sweeping upwards once is enough: by the
 * time level n is considered, n−1 and n−2 already hold the cheapest way to reach them, so the
 * comparison is against the best available and not against a stale figure.
 *
 * The sweep starts at **3**. The game will not run a mirror on anything below +2: with a
 * Philosopher's Mirror selected and the item at +0 or +1, the client disables both Start and
 * Add to Queue and warns "Item Must Be +2 Or Higher" (`philosophersMirrorMinLevelWarning`,
 * gated on `primaryItem.enhancementLevel < 2`). So the first level a mirror can make is +3,
 * from a +2 and a +1; a +2 is only ever built the hard way.
 *
 * Like `buildEnhancementMarkov`, this closes over nothing: the networth worker serialises it
 * with `toString()`, so a module-scope read from here would not exist inside the worker.
 *
 * **Blessed Tea.** A mirror step is guaranteed to succeed, but Blessed Tea can still make that
 * success +2 (measured 2026-09-27), with the same chance `b` the calculator gives an ordinary
 * success. A +2 lands on n+1 instead of n, so the *next* mirror step of the same chain, the one
 * that would have built n+1, never has to be run. The model keeps the array a cost-to-reach-at-
 * least-n figure: let `e[n]` be the probability the chain lands exactly on n (1 for a level that
 * is not mirror-built, `(1−b)·e[n−1] + b·e[n−2]` for one that is, the second term only when
 * n−1 is itself mirror-built). A step into n is only run when the chain stands on n−1, so
 *
 *   cost[n] = cost[n−1] + e[n−1] · (cost[n−2] + mirrorPrice)
 *
 * which is the old `cost[n−2] + cost[n−1] + mirrorPrice` when `b` is 0. Copies are approximated
 * as following the same chain. Closed over nothing, because the networth worker serialises this
 * function with `toString()`.
 *
 * @param {number[]} targetCosts - Cost to reach each level, index 0 being the unenhanced item.
 *   Mutated in place, each entry lowered to the mirror price when mirroring is cheaper.
 * @param {number} mirrorPrice - Coins one Philosopher's Mirror costs; a non-positive price
 *   means mirroring is not available and nothing is changed
 * @param {number} [blessedChance=0] - Chance a mirror success is +2 (Blessed Tea's chance times
 *   the guzzling bonus, as a decimal); 0 without Blessed Tea
 * @returns {boolean[]} Per-level flag, true where the mirror combination won
 */
export function applyMirrorOptimization(targetCosts, mirrorPrice, blessedChance = 0) {
    const usedMirror = new Array(targetCosts.length).fill(false);
    if (!(mirrorPrice > 0)) return usedMirror;

    const b = blessedChance > 0 ? Math.min(1, blessedChance) : 0;
    // Chance the chain lands exactly on each level; a level not built by a mirror is taken as
    // always landed on. That is an approximation: a traditionally built level under Blessed Tea
    // can overshoot (+2 past the target), landing exactly with 1 - M[0][t-1] * skipChance(t-1)
    // in the Markov chain. Using it would mean threading the chosen strategy's fundamental
    // matrix out of three separate producers (tooltip, profile score, the networth worker) into
    // this sweep; the error is at most the overshoot odds (blessed chance times the success rate
    // times the visits to the last transient level, a percent or two) and an overshoot is not
    // wasted, it lands on the next level up. So the simple 1 is kept deliberately.
    const landing = new Array(targetCosts.length).fill(1);

    for (let level = 3; level < targetCosts.length; level++) {
        const mirrorCost = targetCosts[level - 1] + landing[level - 1] * (targetCosts[level - 2] + mirrorPrice);
        if (mirrorCost < targetCosts[level]) {
            usedMirror[level] = true;
            targetCosts[level] = mirrorCost;
            landing[level] = (1 - b) * landing[level - 1] + (usedMirror[level - 1] ? b * landing[level - 2] : 0);
        }
    }

    return usedMirror;
}

/**
 * The chance a mirror chain lands exactly on each level, given which levels were mirror-built.
 * The same recursion {@link applyMirrorOptimization} runs, for a caller that needs the numbers
 * to expand the plan into expected item counts.
 *
 * @param {boolean[]} usedMirror - Per-level mirror decisions
 * @param {number} blessedChance - Chance a mirror success is +2
 * @returns {number[]} Landing probability per level; 1 where the level is not mirror-built
 */
export function mirrorLandingOdds(usedMirror, blessedChance) {
    const b = blessedChance > 0 ? Math.min(1, blessedChance) : 0;
    const landing = new Array(usedMirror.length).fill(1);
    for (let level = 3; level < usedMirror.length; level++) {
        if (!usedMirror[level]) continue;
        landing[level] = (1 - b) * landing[level - 1] + (usedMirror[level - 1] ? b * landing[level - 2] : 0);
    }
    return landing;
}

/**
 * Walk the mirror DP back from the target level to the items the plan actually builds.
 *
 * The DP decides mirror-or-not level by level, and those decisions are not necessarily a clean
 * run: +6 can mirror while +5 does not. Assuming a contiguous block from the first mirrored
 * level and expanding it with Fibonacci quantities invents items the plan never buys. Walking
 * the decisions backwards from the target instead yields exactly the leaves it does buy.
 *
 * @param {number} targetLevel - Level the plan is building
 * @param {boolean[]} usedMirror - Per-level mirror decisions from the DP
 * @param {number} [blessedChance=0] - Chance a mirror success is +2 under Blessed Tea. A step
 *   into level n is only run when the chain stands on n-1, which happens with probability
 *   `landing[n-1]` (see applyMirrorOptimization), so mirror operations and the copies they
 *   consume are expected counts and may be fractional
 * @returns {{leaves: Array<{level: number, quantity: number, primary: boolean}>,
 *   mirrorOperations: Array<{level: number, quantity: number, primary: boolean}>,
 *   mirrorCount: number, mirrorStartLevel: number|null}} Leaves are levels bought traditionally,
 *   highest first; mirror operations record the guaranteed enhancements in the selected route
 * Self-contained on purpose (the landing odds are computed inline, not through `mirrorLandingOdds`):
 * the net-worth worker is built by serialising this function's source.
 */
export function expandMirrorPlan(targetLevel, usedMirror, blessedChance = 0) {
    const b = blessedChance > 0 ? Math.min(1, blessedChance) : 0;
    const landing = new Array(usedMirror.length).fill(1);
    for (let level = 3; level < usedMirror.length; level++) {
        if (!usedMirror[level]) continue;
        landing[level] = (1 - b) * landing[level - 1] + (usedMirror[level - 1] ? b * landing[level - 2] : 0);
    }
    // Two demands, because a mirror step is not symmetric: the primary item —
    // the one being upgraded, which for a refined piece is the refined one —
    // carries on at level-1, and what is consumed beside it is a *copy of the
    // base item* at level-2, which need not be refined. The primary lineage
    // is one chain; everything it consumes, and everything those copies
    // consume in turn, is a plain copy
    const needPrimary = new Array(targetLevel + 1).fill(0);
    const needCopy = new Array(targetLevel + 1).fill(0);
    needPrimary[targetLevel] = 1;

    let mirrorCount = 0;
    let mirrorStartLevel = null;
    const mirrorOperations = [];

    // High to low: a level is only expanded once every demand for it is known
    for (let level = targetLevel; level >= 2; level--) {
        if (!usedMirror[level]) continue;
        const primary = needPrimary[level];
        const copies = needCopy[level];
        if (!primary && !copies) continue;

        // The step into this level only runs when the chain stands on level-1
        const stepOdds = landing[level - 1];
        const primarySteps = primary * stepOdds;
        const copySteps = copies * stepOdds;

        mirrorCount += primarySteps + copySteps;
        mirrorStartLevel = level; // Lowest mirrored level reached, since we descend
        if (primarySteps > 0) mirrorOperations.push({ level, quantity: primarySteps, primary: true });
        if (copySteps > 0) mirrorOperations.push({ level, quantity: copySteps, primary: false });
        if (primary) {
            needPrimary[level - 1] += primary;
            needCopy[level - 2] += primarySteps;
            needPrimary[level] = 0;
        }
        if (copies) {
            needCopy[level - 1] += copies;
            needCopy[level - 2] += copySteps;
            needCopy[level] = 0;
        }
    }

    const leaves = [];
    for (let level = targetLevel; level >= 0; level--) {
        if (needPrimary[level] > 0) leaves.push({ level, quantity: needPrimary[level], primary: true });
        if (needCopy[level] > 0) leaves.push({ level, quantity: needCopy[level], primary: false });
    }

    return { leaves, mirrorCount, mirrorStartLevel, mirrorOperations };
}

/**
 * Chance a Philosopher's Mirror success is +2, from the enhancing parameters.
 * @param {{teas?: {blessed?: boolean}, blessedTea?: boolean, guzzlingBonus?: number,
 *   blessedTeaBonus?: number}} params - Enhancing parameters, either shape
 * @returns {number} Decimal chance, 0 without Blessed Tea
 */
export function blessedMirrorChance(params) {
    const active = Boolean(params?.teas?.blessed ?? params?.blessedTea);
    if (!active) return 0;
    const chance = (params.blessedTeaBonus ?? BLESSED_TEA_BASE_CHANCE) * (params.guzzlingBonus ?? 1);
    return chance > 0 ? Math.min(1, chance) : 0;
}

/**
 * Variance of the number of attempts an enhancement run takes.
 *
 * The expected count on its own says nothing about the spread, and for this chain the spread is
 * most of the story: a run that averages 40 attempts is not a run that takes 40 attempts, it is
 * one that takes 12 if it goes well and 150 if it does not. Quoting only the mean turns a
 * gamble into a price list.
 *
 * From the fundamental matrix M already computed, with t = M·1 the expected attempts from each
 * state, the standard absorbing-chain result is
 *
 *   var = (2M − I)·t − t∘t
 *
 * taken at the starting state's row. Nothing extra is inverted — this is a second read of the
 * matrix the expected count already came from, so the two can never disagree.
 *
 * Takes the matrix rather than the chain parameters so it stays a pure function of M, which is
 * what lets a caller that already has one avoid rebuilding it.
 *
 * @param {Object} M - Fundamental matrix (I − Q)^-1, or anything with .get([i,j])
 * @param {number} targetLevel - Absorbing state, so the transient block is 0..targetLevel−1
 * @param {number} [startLevel=0] - State the run starts from
 * @returns {number} Variance in attempts, never negative
 */
export function absorptionVariance(M, targetLevel, startLevel = 0) {
    const expectedFrom = [];
    for (let i = 0; i < targetLevel; i++) {
        let rowSum = 0;
        for (let j = 0; j < targetLevel; j++) {
            rowSum += M.get([i, j]);
        }
        expectedFrom.push(rowSum);
    }

    let secondMoment = 0;
    for (let j = 0; j < targetLevel; j++) {
        // (2M − I) is the identity subtracted from twice M, which only touches the diagonal
        const coefficient = 2 * M.get([startLevel, j]) - (j === startLevel ? 1 : 0);
        secondMoment += coefficient * expectedFrom[j];
    }

    const mean = expectedFrom[startLevel] ?? 0;
    // Floating-point error on a near-deterministic run can push this a hair below zero, and a
    // negative variance would propagate as NaN through every standard deviation taken from it
    return Math.max(0, secondMoment - mean * mean);
}

/**
 * The standard normal quantile, to about seven decimal places.
 *
 * Acklam's rational approximation. Needed because the cost percentiles below are read off a
 * fitted distribution, and there is no inverse normal in the language.
 *
 * @param {number} p - Probability in (0, 1)
 * @returns {number} z such that Φ(z) = p
 */
function normalQuantile(p) {
    if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;

    const a = [
        -39.6968302866538, 220.946098424521, -275.928510446969, 138.357751867269, -30.6647980661472, 2.50662827745924,
    ];
    const b = [-54.4760987982241, 161.585836858041, -155.698979859887, 66.8013118877197, -13.2806815528857];
    const c = [
        -0.00778489400243029, -0.322396458041136, -2.40075827716184, -2.54973253934373, 4.37466414146497,
        2.93816398269878,
    ];
    const d = [0.00778469570904146, 0.32246712907004, 2.445134137143, 3.75440866190742];

    const low = 0.02425;
    const high = 1 - low;

    if (p < low) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        );
    }
    if (p > high) {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -(
            (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
            ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
        );
    }

    const q = p - 0.5;
    const r = q * q;
    return (
        ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) /
        (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
    );
}

/**
 * The standard normal CDF, via the Abramowitz & Stegun error-function approximation.
 * @param {number} z - Standard score
 * @returns {number} Φ(z)
 */
function normalCdf(z) {
    const t = 1 / (1 + 0.2316419 * Math.abs(z));
    const density = Math.exp((-z * z) / 2) / Math.sqrt(2 * Math.PI);
    const poly = t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
    const upper = density * poly;
    return z >= 0 ? 1 - upper : upper;
}

/**
 * Turn an attempt count and its variance into what a run costs.
 *
 * Everything an enhancement consumes is either paid once — the base item — or paid per attempt:
 * materials, and the protection items whose expected count is itself proportional to attempts.
 * So the cost is an affine function of the attempt count, and its distribution is the attempt
 * distribution scaled and shifted. That is the whole reason the variance is worth computing:
 * once it exists, the cost spread follows without simulating anything.
 *
 * @param {Object} attempts - { attempts, attemptsVariance, minAttempts } from calculateEnhancement
 * @param {Object} prices - Cost model
 * @param {number} [prices.costPerAttempt=0] - Coins each attempt burns (materials, protection)
 * @param {number} [prices.fixedCost=0] - Coins paid once, whatever happens (the base item)
 * @returns {Object} { expected, variance, stdDev, minimum } in coins
 */
export function costStats(attempts, prices = {}) {
    const perAttempt = Number(prices.costPerAttempt) || 0;
    const fixed = Number(prices.fixedCost) || 0;
    const mean = Number(attempts?.attempts) || 0;
    const variance = Math.max(0, Number(attempts?.attemptsVariance) || 0);
    const minimum = Math.max(0, Number(attempts?.minAttempts) || 0);

    return {
        expected: fixed + perAttempt * mean,
        variance: variance * perAttempt * perAttempt,
        stdDev: Math.sqrt(variance) * Math.abs(perAttempt),
        minimum: fixed + perAttempt * minimum,
    };
}

/**
 * Percentiles of a run's cost.
 *
 * Fitted as a *shifted* gamma rather than a normal, because the attempt count is neither
 * symmetric nor unbounded below. A normal fit on a run whose standard deviation approaches its
 * mean — which is the ordinary case here — puts its tenth percentile below zero, which is not a
 * cheap run, it is an impossible one. The shift is the fewest attempts the run could physically
 * take, and the gamma matched on the remaining mean and the variance carries the long right tail
 * that makes enhancing feel the way it does.
 *
 * Quantiles come from the Wilson–Hilferty cube-root transform, which is closed form and good to
 * a few parts in a thousand over the range worth quoting. Below the shift is impossible, so
 * every answer is clamped there.
 *
 * @param {Object} cost - Result of costStats
 * @param {number[]} [probabilities=[0.1, 0.5, 0.9]] - Probabilities to report
 * @returns {Object} { p10, p50, p90, values } — values pairs each probability with its cost,
 *   and the named fields are present only when their probability was asked for
 */
export function costPercentiles(cost, probabilities = [0.1, 0.5, 0.9]) {
    const expected = Number(cost?.expected) || 0;
    const variance = Math.max(0, Number(cost?.variance) || 0);
    const minimum = Math.min(Number(cost?.minimum) || 0, expected);
    const spread = expected - minimum;

    const quantile = (p) => {
        if (!(p > 0) || !(p < 1)) return expected;
        // A run with no spread costs what it costs; fitting a distribution to it would only
        // introduce error
        if (variance <= 0 || spread <= 0) return expected;

        const shape = (spread * spread) / variance;
        const scale = variance / spread;
        const z = normalQuantile(p);
        const factor = 1 - 1 / (9 * shape) + z / (3 * Math.sqrt(shape));
        return Math.max(minimum, minimum + shape * scale * Math.max(0, factor) ** 3);
    };

    const values = probabilities.map((p) => ({ p, cost: quantile(p) }));
    const named = {};
    for (const entry of values) {
        const label = `p${Math.round(entry.p * 100)}`;
        named[label] = entry.cost;
    }
    return { ...named, values };
}

/**
 * The chance a run costs more than some threshold — the sale proceeds, usually.
 *
 * The same fitted distribution read the other way round. It is the figure that decides whether
 * an enhance-to-sell is a trade or a bet: a median profit means nothing if two runs in five lose
 * money.
 *
 * @param {Object} cost - Result of costStats
 * @param {number} threshold - Coins to compare against
 * @returns {number} Probability in [0, 1]
 */
export function costExceedanceProbability(cost, threshold) {
    const expected = Number(cost?.expected) || 0;
    const variance = Math.max(0, Number(cost?.variance) || 0);
    const minimum = Math.min(Number(cost?.minimum) || 0, expected);
    const spread = expected - minimum;
    const limit = Number(threshold) || 0;

    if (variance <= 0 || spread <= 0) return expected > limit ? 1 : 0;
    if (limit <= minimum) return 1;

    const shape = (spread * spread) / variance;
    const scale = variance / spread;
    // Wilson–Hilferty inverted: the cube root of a gamma is very nearly normal
    const standardised = (limit - minimum) / (scale * shape);
    const z = 3 * Math.sqrt(shape) * (Math.cbrt(standardised) - 1 + 1 / (9 * shape));
    return Math.min(1, Math.max(0, 1 - normalCdf(z)));
}

/**
 * Calculate total success rate bonus multiplier
 * @param {Object} params - Enhancement parameters
 * @param {number} params.enhancingLevel - Effective enhancing level (base + tea bonus)
 * @param {number} params.toolBonus - Tool success bonus % (already includes equipment + house bonus)
 * @param {number} params.itemLevel - Item level being enhanced
 * @returns {number} Success rate multiplier (e.g., 1.0519 = 105.19% of base rates)
 */
export function calculateSuccessMultiplier(params) {
    const { enhancingLevel, toolBonus, itemLevel } = params;

    // Total bonus calculation
    // toolBonus already includes equipment + house success bonus from config
    // We only need to add level advantage here

    let totalBonus;

    if (enhancingLevel >= itemLevel) {
        // Above or at item level: +0.05% per level above item level
        const levelAdvantage = 0.05 * (enhancingLevel - itemLevel);
        totalBonus = 1 + (toolBonus + levelAdvantage) / 100;
    } else {
        // Below item level: Penalty based on level deficit
        totalBonus = 1 - 0.5 * (1 - enhancingLevel / itemLevel) + toolBonus / 100;
    }

    return totalBonus;
}

/**
 * Calculate per-action time for enhancement
 * Simple calculation that doesn't require Markov chain analysis
 * @param {number} enhancingLevel - Effective enhancing level (includes tea bonus)
 * @param {number} itemLevel - Item level being enhanced
 * @param {number} speedBonus - Speed bonus % (for action time calculation)
 * @returns {number} Per-action time in seconds
 */
export function calculatePerActionTime(enhancingLevel, itemLevel, speedBonus = 0) {
    const baseActionTime = 12; // seconds
    let speedMultiplier;

    if (enhancingLevel > itemLevel) {
        // Above item level: Get speed bonus from level advantage + equipment + house
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
    } else {
        // Below item level: Only equipment + house speed bonus
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + speedBonus / 100;
    }

    return Math.max(MIN_ACTION_TIME_SECONDS, baseActionTime / speedMultiplier);
}

/**
 * Calculate enhancement statistics using Markov Chain matrix inversion
 * @param {Object} params - Enhancement parameters
 * @param {number} params.enhancingLevel - Effective enhancing level (includes tea bonus)
 * @param {number} params.houseLevel - Observatory house room level (used for speed calculation only)
 * @param {number} params.toolBonus - Tool success bonus % (already includes equipment + house success bonus from config)
 * @param {number} params.speedBonus - Speed bonus % (for action time calculation)
 * @param {number} params.itemLevel - Item level being enhanced
 * @param {number} params.targetLevel - Target enhancement level (1-20)
 * @param {number} params.startLevel - Starting enhancement level (0-19, default 0)
 * @param {number} params.protectFrom - Start using protection items at this level (0 = never)
 * @param {boolean} params.blessedTea - Whether Blessed Tea is active (1% double jump)
 * @param {number} params.guzzlingBonus - Drink concentration multiplier (1.0 = no bonus, scales blessed tea)
 * @param {number} [params.blessedTeaBonus] - Blessed Tea double-jump chance as a decimal (default 1%)
 * @param {number} [params.perActionTimeOverride] - Per-action time in seconds measured from the
 *   game's buff maps. When supplied it replaces the formula below, so a tracker reading the live
 *   buff maps and a prediction built here share one time base.
 * @returns {Object} Enhancement statistics
 */
export function calculateEnhancement(params) {
    const {
        enhancingLevel,
        _houseLevel,
        toolBonus,
        speedBonus = 0,
        itemLevel,
        targetLevel,
        startLevel = 0,
        protectFrom = 0,
        blessedTea = false,
        guzzlingBonus = 1.0,
        blessedTeaBonus = BLESSED_TEA_BASE_CHANCE,
        perActionTimeOverride = 0,
    } = params;

    // Validate inputs
    if (targetLevel < 1 || targetLevel > 20) {
        throw new Error('Target level must be between 1 and 20');
    }
    if (protectFrom < 0 || protectFrom > targetLevel) {
        throw new Error('Protection level must be between 0 and target level');
    }

    // Calculate success rate multiplier
    const successMultiplier = calculateSuccessMultiplier({
        enhancingLevel,
        toolBonus,
        itemLevel,
    });

    // Build Markov Chain transition matrix (20×20) — shared with the worker pools
    const markov = buildEnhancementMarkov(matrixMath, {
        baseSuccessRates: BASE_SUCCESS_RATES,
        successMultiplier,
        targetLevel,
        protectFrom,
        blessedTea,
        guzzlingBonus,
        blessedTeaBonus,
    });

    // Extract transient matrix Q (all states before target)
    const Q = markov.subset(matrixMath.index(matrixMath.range(0, targetLevel), matrixMath.range(0, targetLevel)));

    // Fundamental matrix: M = (I - Q)^-1
    const I = matrixMath.identity(targetLevel);
    const M = matrixMath.inv(matrixMath.subtract(I, Q));

    // Expected attempts from startLevel to target.
    // This is the full row sum of the fundamental matrix: a failure below startLevel drops the
    // item back to states the run started above, and every visit there costs an attempt too.
    // Summing only from startLevel up would silently discount those.
    let attempts = 0;
    for (let i = 0; i < targetLevel; i++) {
        attempts += M.get([startLevel, i]);
    }

    // How far a run can stray from that expectation. Read off the same M, so the two figures
    // are one measurement rather than two that have to be kept in step.
    const attemptsVariance = absorptionVariance(M, targetLevel, startLevel);

    // Expected protection item uses
    let protects = 0;
    if (protectFrom > 0 && protectFrom < targetLevel) {
        for (let i = protectFrom; i < targetLevel; i++) {
            const timesAtLevel = M.get([startLevel, i]);
            const failureChance = markov.get([i, i - 1]);
            protects += timesAtLevel * failureChance;
        }
    }

    // Action time calculation
    const baseActionTime = 12; // seconds
    let speedMultiplier;

    if (enhancingLevel > itemLevel) {
        // Above item level: Get speed bonus from level advantage + equipment + house
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + (enhancingLevel - itemLevel + speedBonus) / 100;
    } else {
        // Below item level: Only equipment + house speed bonus
        // Note: speedBonus already includes house level bonus (1% per level)
        speedMultiplier = 1 + speedBonus / 100;
    }

    // A caller that can read the game's own buff maps knows the real per-action time; prefer it
    // over the formula so predictions and live tracking never disagree about the time base.
    const perActionTime =
        perActionTimeOverride > 0
            ? perActionTimeOverride
            : Math.max(MIN_ACTION_TIME_SECONDS, baseActionTime / speedMultiplier);
    const totalTime = perActionTime * attempts;

    // The fewest attempts the run could physically take: one per level, or one per two levels
    // when Blessed Tea can double-jump. Nothing below this is possible, which is what stops a
    // fitted cost distribution quoting a tenth percentile nobody could ever hit.
    const levelsToClimb = Math.max(0, targetLevel - startLevel);
    const minAttempts = blessedTea ? Math.ceil(levelsToClimb / 2) : levelsToClimb;

    return {
        attempts: attempts, // Keep exact decimal value for calculations
        attemptsRounded: Math.round(attempts), // Rounded for display
        // The spread around that expectation — see absorptionVariance
        attemptsVariance,
        attemptsStdDev: Math.sqrt(attemptsVariance),
        minAttempts,
        protectionCount: protects, // Keep decimal precision
        perActionTime: perActionTime,
        totalTime: totalTime,
        successMultiplier: successMultiplier,

        // Detailed success rates for each level
        successRates: BASE_SUCCESS_RATES.slice(0, targetLevel).map((base, i) => {
            return {
                level: i + 1,
                baseRate: base,
                actualRate: Math.min(100, base * successMultiplier),
            };
        }),

        // Expected number of times each state is visited (from fundamental matrix M)
        visitCounts: Array.from({ length: targetLevel }, (_, i) => M.get([startLevel, i])),
    };
}
