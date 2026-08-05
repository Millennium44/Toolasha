/**
 * Drop Luck
 *
 * Where a session's takings sit in the distribution of takings it could have had.
 *
 * "Expected value" answers the wrong question after a bad run. Toolasha already
 * computes what a zone pays on average — but a session that came in 30% under
 * average is either routine or remarkable depending on the shape of the tail, and
 * an average cannot tell the two apart. A zone whose income is mostly a common
 * drop and a zone whose income is mostly one rare drop have the same mean and
 * nothing else in common. This gives the percentile: the fraction of runs that
 * would have done worse.
 *
 * ## How
 *
 * Total income is a sum of independent contributions — every drop of every
 * monster in every wave. Summing distributions directly means convolving them,
 * which is quadratic and gets worse with every drop added. In the frequency
 * domain a convolution is a plain product, so each drop contributes one
 * characteristic function, they all multiply together, and one inverse transform
 * at the end turns the product back into a distribution. Repetition becomes a
 * power rather than a repeated convolution, which is what makes a thousand waves
 * cost the same as one.
 *
 * The awkward part is that the transform needs a finite window and the true
 * support of the sum is not known in advance. Too narrow and the far tail wraps
 * around onto the near one; too wide and the resolution is spent on income
 * nobody will ever see. `invertToCDF` searches for a window instead of guessing,
 * shrinking it until the distribution nearly fills it.
 *
 * ## What this file does not do
 *
 * Pure computation only — it takes drop tables and prices and returns numbers.
 * Reading the current zone, pricing items, and counting what actually dropped are
 * not here. Nothing in Toolasha calls this yet.
 *
 * Ported from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`.
 */

import {
    cMul,
    cDiv,
    cPow,
    vecConstant,
    vecMulEq,
    vecScaleEq,
    vecAddMulEq,
    unitPowers,
    fftInPlace,
    binarySearch,
} from './complex-fft.js';

/**
 * A characteristic function, as this file represents one: given a sample count
 * and a frequency scale, it returns the function evaluated at that many evenly
 * spaced frequencies.
 * @typedef {(samples: number, scale: number) => Array<[number, number]>} CharacteristicFunction
 */

/** Knobs for the transform. Defaults chosen to be accurate rather than quick. */
export const LUCK_DEFAULTS = {
    /** Frequencies sampled for the final answer. Powers of two only. */
    samples: 4096,
    /** Frequencies sampled while searching for the window — cheap and rough. */
    searchSamples: 64,
    /** How much of the window the distribution should fill before the search stops */
    fillTarget: 0.9,
    /** Tail mass allowed outside the window */
    tailTolerance: 1e-4,
    /** Give up shrinking once a step buys less than this */
    shrinkTolerance: 1e-4,
    /** Cap on shrink steps */
    maxIterations: 30,
    /** Fraction of the transform reserved as a guard band against wrap-around */
    guardBand: 0.4,
};

/**
 * A characteristic function that is identically one — the sum of nothing.
 * @param {number} [value] - The constant
 * @returns {CharacteristicFunction}
 */
export function constantCF(value = 1) {
    return (samples) => vecConstant(samples, value);
}

/**
 * The characteristic function of a sum, which is the product of the parts.
 * @param {CharacteristicFunction[]} functions - The independent contributions
 * @returns {CharacteristicFunction}
 */
export function multiplyCFs(functions) {
    if (!functions.length) return constantCF(1);

    return (samples, scale) => {
        const product = functions[0](samples, scale);
        for (let i = 1; i < functions.length; i++) {
            vecMulEq(product, functions[i](samples, scale));
        }
        return product;
    };
}

/**
 * The characteristic function of `n` independent repeats of something.
 *
 * A power, not `n` multiplications — which is the whole reason a long session is
 * no more expensive to analyse than a short one. `n` need not be a whole number;
 * a fractional exponent interpolates between wave counts.
 *
 * @param {CharacteristicFunction} cf - One repeat
 * @param {number} n - How many
 * @returns {CharacteristicFunction}
 */
export function powCF(cf, n) {
    return (samples, scale) => {
        const values = cf(samples, scale);
        for (let i = 0; i < samples; i++) values[i] = cPow(values[i], n);
        return values;
    };
}

/**
 * The characteristic function of one drop's contribution to income.
 *
 * A drop is "with probability `dropRate`, a count uniform on [minCount, maxCount],
 * each worth `price`". The count is continuous in the game's data but only whole
 * items can drop, so the uniform range is first pushed onto the integers — mass
 * between two integers splits between them in proportion to how close it is,
 * which is what makes a range like 1.5–2.5 pay 2 on average rather than rounding
 * to a fixed 2.
 *
 * Three cases, because the arithmetic collapses differently in each:
 *
 * - The range spans no integer, or is a single point: the count is one of two
 *   adjacent integers, and the whole thing is two terms.
 * - The range spans exactly one integer: that integer plus a symmetric spill to
 *   its neighbours.
 * - The range spans several: the interior is a run of equally likely integers,
 *   which sums in closed form as a geometric series, plus a partial integer at
 *   each end.
 *
 * @param {Object} drop - `{ minCount, maxCount, dropRate, price }`
 * @returns {CharacteristicFunction}
 */
export function dropCF(drop) {
    const { minCount, maxCount, dropRate, price } = drop;
    const epsilon = 1e-8;
    const low = Math.ceil(minCount);
    const high = Math.floor(maxCount);
    const miss = 1 - dropRate;

    // No whole count strictly inside the range, so it is one of two neighbours
    if (low > high || maxCount - minCount < epsilon) {
        const fraction = (minCount + maxCount) / 2 - high;
        const upper = fraction * dropRate;
        const lower = (1 - fraction) * dropRate;

        return (samples, scale) => {
            const base = 2 * Math.PI * scale * price;
            const [cosHigh1, sinHigh1] = unitPowers(base * (high + 1), samples);
            const [cosHigh, sinHigh] = unitPowers(base * high, samples);

            const values = new Array(samples);
            for (let i = 0; i < samples; i++) {
                values[i] = [cosHigh1[i] * upper + cosHigh[i] * lower + miss, sinHigh1[i] * upper + sinHigh[i] * lower];
            }
            return values;
        };
    }

    // Exactly one whole count inside, with a spill to each side
    if (low === high) {
        const spillLow = (dropRate * (low - minCount) * (low - minCount)) / ((maxCount - minCount) * 2);
        const spillHigh = (dropRate * (maxCount - high) * (maxCount - high)) / ((maxCount - minCount) * 2);

        return (samples, scale) => {
            const base = 2 * Math.PI * scale * price;
            const [cos, sin] = unitPowers(base, samples);
            const [cosHigh, sinHigh] = unitPowers(base * high, samples);

            const values = new Array(samples);
            for (let i = 0; i < samples; i++) {
                const shape = [dropRate + (spillLow + spillHigh) * (cos[i] - 1), (spillHigh - spillLow) * sin[i]];
                values[i] = cMul([cosHigh[i], sinHigh[i]], shape);
                values[i][0] += miss;
            }
            return values;
        };
    }

    // A run of whole counts, plus a partial one at each end
    const lowPart = low - minCount;
    const highPart = maxCount - high;
    const lowPart2 = lowPart * lowPart;
    const highPart2 = highPart * highPart;
    const density = dropRate / (maxCount - minCount);

    return (samples, scale) => {
        const base = 2 * Math.PI * scale * price;
        const [cos, sin] = unitPowers(base, samples);
        const [cosHigh, sinHigh] = unitPowers(base * high, samples);
        const [cosLow, sinLow] = unitPowers(base * low, samples);

        const values = new Array(samples);
        for (let i = 0; i < samples; i++) {
            const halfCosStep = (cos[i] - 1) / 2;
            const halfSinStep = sin[i] / 2;
            const atLow = [cosLow[i], sinLow[i]];
            const atHigh = [cosHigh[i], sinHigh[i]];

            const endLow = cMul([lowPart + lowPart2 * halfCosStep, -lowPart2 * halfSinStep], atLow);
            const endHigh = cMul([highPart + highPart2 * halfCosStep, highPart2 * halfSinStep], atHigh);

            // The interior sums as a geometric series, except at zero frequency
            // where the ratio is one and the closed form divides by nothing
            const atZeroFrequency = halfCosStep > -epsilon && Math.abs(halfSinStep) < epsilon;
            const interior = atZeroFrequency
                ? [(high - low) * atLow[0], (high - low) * (atLow[1] + halfSinStep * (high - low - 1))]
                : cDiv([atHigh[0] - atLow[0], atHigh[1] - atLow[1]], [halfCosStep * 2, halfSinStep * 2]);
            const middle = cMul(interior, [1 + halfCosStep, halfSinStep]);

            values[i] = [
                miss + density * (endLow[0] + endHigh[0] + middle[0]),
                density * (endLow[1] + endHigh[1] + middle[1]),
            ];
        }
        return values;
    };
}

/**
 * Invert a characteristic function over a fixed window into a CDF on [0, 1].
 *
 * The transform is periodic, so probability past the end of the window reappears
 * at the start of it. A guard band leaves part of the window empty and the result
 * is re-based against it, which turns wrap-around into a known offset instead of
 * corruption at both ends.
 *
 * The three passes afterwards each fix something the transform does badly at its
 * own resolution: a short moving median removes the ringing that a hard window
 * edge puts into the tails, re-basing pins the guard band back to one, and a
 * running maximum restores monotonicity, since a CDF that dips is worse than a
 * CDF that is slightly wrong.
 *
 * @param {CharacteristicFunction} cf - What to invert
 * @param {number} samples - Frequencies to sample; a power of two
 * @param {number} scale - Reciprocal of the window width
 * @param {Object} [options] - Overrides for `LUCK_DEFAULTS`
 * @returns {(x: number) => number} CDF over the fraction of the window
 */
function invertOverWindow(cf, samples, scale, options = {}) {
    const { guardBand } = { ...LUCK_DEFAULTS, ...options };
    const padding = 2;
    const n = samples * padding;

    const values = cf(samples, scale * (1 - guardBand));
    const re = new Array(n).fill(0);
    const im = new Array(n).fill(0);
    for (let i = 0; i < samples; i++) {
        if (!Number.isFinite(values[i][0]) || !Number.isFinite(values[i][1])) {
            throw new Error('Characteristic function produced a non-finite value');
        }
        re[i] = values[i][0];
        im[i] = values[i][1];
    }

    fftInPlace(re, im);

    // The zero frequency carries the whole mass and would swamp everything else;
    // removing a half from every bin is the discrete form of dropping it
    for (let i = 0; i < n; i++) re[i] -= 0.5;
    const total = re.reduce((sum, x) => sum + x, 0);
    if (Math.abs(total) < 1e-10) throw new Error('Transform came back empty');
    for (let i = 0; i < n; i++) re[i] /= total;

    const cdf = new Array(n);
    cdf[0] = (re[0] + re[n - 1]) / 2;
    for (let i = 1; i < n; i++) cdf[i] = cdf[i - 1] + (re[i] + re[i - 1]) / 2;

    const smoothed = circularMovingMedian(cdf, padding);
    const offset = smoothed[Math.floor(n * (1 - guardBand))] - 1;
    for (let i = 0; i < n; i++) smoothed[i] -= offset;
    for (let i = 1; i < n; i++) if (smoothed[i] < smoothed[i - 1]) smoothed[i] = smoothed[i - 1];

    return (x) => interpolateCDF(smoothed, x, guardBand);
}

/**
 * A moving median that wraps, treating the sequence as one period of something
 * that climbs by one each time round — which is what a CDF read off a periodic
 * transform is.
 * @param {number[]} values - The sequence
 * @param {number} radius - Half-width of the window
 * @returns {number[]} Smoothed copy
 */
function circularMovingMedian(values, radius) {
    const n = values.length;
    const out = new Array(n);

    for (let i = 0; i < n; i++) {
        const window = [];
        for (let j = i - radius + 1; j <= i + radius; j++) {
            const wrapped = values[((j % n) + n) % n];
            window.push(j < 0 ? wrapped - 1 : j >= n ? wrapped + 1 : wrapped);
        }
        window.sort((a, b) => a - b);
        out[i] = (window[radius - 1] + window[radius]) / 2;
    }
    return out;
}

/**
 * Read a CDF between its samples.
 *
 * Cubic rather than linear because the answer is a percentile, and linear
 * interpolation of a curve this smooth leaves visible steps in one.
 *
 * @param {number[]} cdf - Sampled CDF
 * @param {number} x - Position in [0, 1] across the usable part of the window
 * @param {number} guardBand - Fraction reserved against wrap-around
 * @returns {number} Probability in [0, 1]
 */
function interpolateCDF(cdf, x, guardBand) {
    if (x < 0) return 0;
    if (x >= 1) return 1;

    const n = cdf.length;
    const position = x * (1 - guardBand) * n - 0.5;
    const index = Math.round(position);
    const t = position - index;

    // Neighbours wrap, and a wrap crosses one whole step of the CDF
    const before = index - 1 < 0 ? cdf[index + n - 1] - 1 : cdf[index - 1];
    const after = index + 1 >= n ? cdf[index - n + 1] + 1 : cdf[index + 1];
    const midBefore = (cdf[index] + before) / 2;
    const midAfter = (cdf[index] + after) / 2;
    const slopeBefore = cdf[index] - before;
    const slopeAfter = after - cdf[index];

    const value =
        2 * (t + 1) * (t - 0.5) * (t - 0.5) * midBefore +
        2 * (1 - t) * (t + 0.5) * (t + 0.5) * midAfter +
        (t * t - 0.25) * ((t - 0.5) * slopeBefore + (t + 0.5) * slopeAfter);

    return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Invert a characteristic function into a CDF over actual income.
 *
 * The window has to hold the distribution but not dwarf it, and its width is not
 * known before the distribution is computed. So a cheap, coarse inversion runs
 * first and reports where the mass actually ends; the window shrinks to that and
 * the check repeats. Each round is a few dozen samples, and the accurate
 * inversion runs once at the end.
 *
 * @param {CharacteristicFunction} cf - What to invert
 * @param {number} startingLimit - First guess at the largest plausible income
 * @param {Object} [options] - Overrides for `LUCK_DEFAULTS`
 * @returns {{limit: number, cdf: (income: number) => number}} The window that was
 *   settled on, and the CDF over income
 */
export function invertToCDF(cf, startingLimit, options = {}) {
    const settings = { ...LUCK_DEFAULTS, ...options };
    let limit = startingLimit;

    for (let i = 0; i < settings.maxIterations; i++) {
        const rough = invertOverWindow(cf, settings.searchSamples, 1 / limit, settings);

        // Already loose enough that the tail is nowhere near the edge
        if (rough(settings.fillTarget) < 1 - settings.tailTolerance) break;

        const reaches = binarySearch(rough, 0, 1, 1 - settings.tailTolerance);
        const shrink = reaches / settings.fillTarget;
        if (shrink > 1 - settings.shrinkTolerance) break;
        limit *= shrink;
    }

    const accurate = invertOverWindow(cf, settings.samples, 1 / limit, settings);
    return { limit, cdf: (income) => accurate(income / limit) };
}

/**
 * Every path a wave can take through its spawn table, as a graph.
 *
 * The same states as `spawn-expectation.js` — strength spent, monsters drawn —
 * but keeping the edges rather than just the totals, because the income of a wave
 * depends on which monsters appeared together and not only on how many of each
 * appeared on average.
 *
 * Each node records the probability the wave ends there, which is the weight of
 * the draws that would not fit.
 *
 * @param {Object} spawnInfo - `{ spawns, maxSpawnCount, maxTotalStrength }`
 * @returns {Array<{stop: number, edges: Array<{to: number, hrid: string}>}>} Nodes,
 *   with the starting state first
 */
function spawnGraph(spawnInfo) {
    const { spawns, maxSpawnCount, maxTotalStrength } = spawnInfo;
    const ids = new Map();
    const nodes = [];

    const idFor = (strength, count) => {
        const key = strength * (maxSpawnCount + 1) + count;
        if (!ids.has(key)) {
            ids.set(key, nodes.length);
            nodes.push({ stop: 0, edges: [] });
        }
        return ids.get(key);
    };

    idFor(0, 0);
    for (let strength = 0; strength <= maxTotalStrength; strength++) {
        for (let count = 0; count <= maxSpawnCount; count++) {
            const key = strength * (maxSpawnCount + 1) + count;
            if (!ids.has(key)) continue;
            const id = ids.get(key);

            for (const monster of spawns) {
                const nextStrength = strength + (monster.strength || 0);
                const nextCount = count + 1;
                if (nextStrength > maxTotalStrength || nextCount > maxSpawnCount) {
                    nodes[id].stop += monster.rate || 0;
                    continue;
                }
                nodes[id].edges.push({
                    to: idFor(nextStrength, nextCount),
                    hrid: monster.combatMonsterHrid || monster.hrid,
                });
            }
        }
    }
    return nodes;
}

/**
 * The characteristic function of one wave's income.
 *
 * Walking the graph backwards means every node's successors are already solved
 * when it is reached, so the whole wave resolves in one pass: a node's value is
 * the chance it stops there, plus each outgoing draw weighted by that monster's
 * rate and its own drops.
 *
 * @param {Object} spawnInfo - `{ spawns, maxSpawnCount, maxTotalStrength }`
 * @param {Object<string, Object[]>} monsterDrops - Monster hrid → its drops
 * @returns {CharacteristicFunction}
 */
export function waveCF(spawnInfo, monsterDrops) {
    const spawns = spawnInfo?.spawns || [];
    if (!spawns.length) return constantCF(1);

    const totalWeight = spawns.reduce((sum, spawn) => sum + (spawn.rate || 0), 0);
    if (totalWeight <= 0) return constantCF(1);

    const perMonster = {};
    for (const monster of spawns) {
        const hrid = monster.combatMonsterHrid || monster.hrid;
        perMonster[hrid] = multiplyCFs((monsterDrops[hrid] || []).map(dropCF));
    }

    // Rates are weights, and the graph reads them as probabilities
    const normalised = {
        ...spawnInfo,
        spawns: spawns.map((spawn) => ({ ...spawn, rate: (spawn.rate || 0) / totalWeight })),
    };
    const graph = spawnGraph(normalised);
    const rateOf = new Map(normalised.spawns.map((spawn) => [spawn.combatMonsterHrid || spawn.hrid, spawn.rate]));

    return (samples, scale) => {
        const weighted = {};
        for (const hrid of Object.keys(perMonster)) {
            weighted[hrid] = vecScaleEq(perMonster[hrid](samples, scale), rateOf.get(hrid));
        }

        const values = new Array(graph.length);
        for (let id = graph.length - 1; id >= 0; id--) {
            values[id] = vecConstant(samples, graph[id].stop);
            for (const edge of graph[id].edges) {
                vecAddMulEq(values[id], values[edge.to], weighted[edge.hrid]);
            }
        }
        return values[0];
    };
}

/**
 * The characteristic function of a whole session's income.
 * @param {Object} session - Session shape
 * @param {Object} session.spawnInfo - The zone's random spawn table
 * @param {Object<string, Object[]>} session.monsterDrops - Monster hrid → its drops
 * @param {Object<string, Object[]>} [session.bossDrops] - Boss key → its drops
 * @param {number} session.normalCount - Normal waves fought
 * @param {number} [session.bossCount] - Boss waves fought
 * @returns {CharacteristicFunction}
 */
export function sessionCF({ spawnInfo, monsterDrops, bossDrops = {}, normalCount, bossCount = 0 }) {
    const normal = powCF(waveCF(spawnInfo, monsterDrops), normalCount);
    const boss = powCF(multiplyCFs(Object.values(bossDrops).map((drops) => multiplyCFs(drops.map(dropCF)))), bossCount);
    return multiplyCFs([normal, boss]);
}

/**
 * How lucky a session's takings were.
 *
 * @param {Object} session - As `sessionCF` takes
 * @param {number} income - What the session actually paid
 * @param {Object} [options] - Overrides for `LUCK_DEFAULTS`
 * @returns {{percentile: number, limit: number, cdf: (income: number) => number}}
 *   `percentile` is the fraction of sessions that would have done worse — so 0.5
 *   is exactly typical, 0.99 is a session in a hundred, and 0.01 is a session in
 *   a hundred the other way. `cdf` answers the same question for any other
 *   income, and `limit` is the window that was settled on.
 */
export function sessionLuck(session, income, options = {}) {
    const waves = (session.normalCount || 0) + (session.bossCount || 0);

    // Opening guess: generous enough that the search shrinks onto the answer
    // rather than having to widen, which it cannot do
    const startingLimit = Math.max(1e8, 2e5 * Math.max(waves, 1));

    const { limit, cdf } = invertToCDF(sessionCF(session), startingLimit, options);
    return { percentile: cdf(income), limit, cdf };
}
