/**
 * Gathering Drop Model
 *
 * Turning a loot-log entry for a non-combat run into the shape `drop-luck.js`
 * analyses — the skilling counterpart of `combat-drop-model.js`.
 *
 * A gathering run is far simpler than a combat session: there is no spawn
 * graph, no boss cadence, no party split. Every action rolls the same static
 * drop table once, independently, so the whole session is one characteristic
 * function raised to the number of actions. What the FFT machinery buys here is
 * exactly the case an average cannot handle: a table whose value rides on one
 * rare entry. Over a run the rare lands a handful of whole times or not at all,
 * so income is a few discrete lumps — a normal approximation would call a
 * zero-rare run a disaster when it is in fact the most common outcome, and only
 * the exact distribution knows the difference.
 *
 * ## What is modelled, and what is deliberately not
 *
 * The model covers the action's own `dropTable` — the same table
 * `loot-log-stats.calculateExpectedRunValue()` builds its expectation from, so
 * the two figures beside each other in the loot log describe the same run.
 * Essence and rare-find tables are **not** modelled: their realised rates
 * depend on find bonuses the loot log does not capture, and a model that reads
 * their base rates would quietly call every buffed character permanently lucky
 * — the exact failure `combat-drop-model.js` warns about. They are therefore
 * left out of both sides: out of the distribution, and out of the income
 * measured against it (`gatheringLootValue` only counts modelled items).
 *
 * The same goes for unpriced drops, mirroring the combat model: an item with no
 * market price is dropped from the model and from the income, so the comparison
 * stays like for like.
 *
 * ## Gathering quantity and Processing
 *
 * The game rolls a whole count uniformly over `minCount..maxCount`, multiplies
 * it by `1 + gathering quantity` and rounds the result stochastically (measured
 * 2026-09-23). Every buffed character — the community buff alone is +20% —
 * therefore gathers more than the bare table, and a model that ignored it read
 * every run as lucky. The caller passes the quantity the character gathers at;
 * each drop's count distribution is built from it exactly, one whole outcome
 * at a time, rather than from a continuous range.
 *
 * Processing Tea turns part of a raw stack into its processed item, so the log
 * shows Cheese where the model rolled Milk. `processedFrom` names those
 * conversions, and the income counts a processed item as the raw items it was
 * made from — the model is about how much dropped, not what it was turned into.
 *
 * ## Floors
 *
 * Mirroring `buildCombatSession`: no completed actions, no drop table (which is
 * what production and combat actions look like here), or nothing in the table
 * that resolves to a price — each returns null, and null means no verdict
 * rather than a made-up one.
 */

import { multiplyCFs, powCF, dropCF, invertToCDF } from './drop-luck.js';
import { unitPowers } from './complex-fft.js';

/** Above this is a good run, below the mirror of it a bad one */
const LUCKY_PERCENTILE = 0.75;
const UNLUCKY_PERCENTILE = 0.25;

/**
 * Build the session `gatheringSessionLuck` analyses from an action and a count.
 *
 * Priced here rather than downstream, for the same reason `buildCombatSession`
 * does it: the analysis works in coins, and an item with no price has to leave
 * the model and the income together or the comparison measures pricing gaps
 * rather than luck.
 *
 * @param {Object} input - Everything the model needs
 * @param {Object} input.actionDetail - The action's `actionDetailMap` entry
 * @param {number} input.actionCount - Actions completed in the run
 * @param {Function} input.priceOf - `(itemHrid) => number|null`
 * @param {number} [input.gatheringQuantity=0] - The character's gathering quantity, as a
 *   decimal (0.35 for +35%)
 * @param {Object<string, {rawHrid: string, ratio: number}>} [input.processedFrom] - Processing
 *   conversions, processed item hrid → the raw item and how many of it one takes
 * @returns {{drops: Array<Object>, actionCount: number, processedFrom: Object}|null} A session,
 *   or null when the run cannot be modelled — no drop table, no completed actions, or nothing
 *   in the table with a price
 */
export function buildGatheringSession({ actionDetail, actionCount, priceOf, gatheringQuantity = 0, processedFrom }) {
    const dropTable = actionDetail?.dropTable;
    if (!dropTable?.length) return null;
    if (!(actionCount > 0)) return null;

    const drops = [];
    for (const drop of dropTable) {
        const rate = drop.dropRate || 0;
        const maxCount = drop.maxCount || 0;
        if (rate <= 0 || maxCount <= 0) continue;

        const price = priceOf(drop.itemHrid);
        if (!(price > 0)) continue;

        drops.push({
            itemHrid: drop.itemHrid,
            minCount: drop.minCount || 0,
            maxCount,
            dropRate: Math.min(rate, 1),
            price,
            quantity: Math.max(0, Number(gatheringQuantity) || 0),
        });
    }
    if (!drops.length) return null;

    // Only conversions of something the model rolls can be counted back
    const modelled = new Set(drops.map((drop) => drop.itemHrid));
    const conversions = {};
    for (const [processedHrid, conversion] of Object.entries(processedFrom || {})) {
        if (modelled.has(conversion?.rawHrid) && conversion.ratio > 0) conversions[processedHrid] = conversion;
    }

    return { drops, actionCount, processedFrom: conversions };
}

/**
 * The whole counts one drop can pay and how likely each is, the way the game
 * rolls them: a whole count uniform over `minCount..maxCount`, times
 * `1 + quantity`, rounded up with probability equal to the fraction left over.
 * Null when the range is not whole, which no gathering table has.
 * @param {Object} drop - A session drop
 * @returns {Map<number, number>|null} Count → probability, the miss included
 */
export function gatheringCountOutcomes(drop) {
    const { minCount, maxCount, dropRate } = drop;
    if (!Number.isInteger(minCount) || !Number.isInteger(maxCount) || maxCount < minCount) return null;

    const multiplier = 1 + (drop.quantity || 0);
    const each = dropRate / (maxCount - minCount + 1);
    const outcomes = new Map([[0, 1 - dropRate]]);
    const add = (count, probability) => {
        if (probability > 0) outcomes.set(count, (outcomes.get(count) || 0) + probability);
    };
    for (let count = minCount; count <= maxCount; count++) {
        const boosted = count * multiplier;
        const whole = Math.floor(boosted);
        const fraction = boosted - whole;
        add(whole, each * (1 - fraction));
        add(whole + 1, each * fraction);
    }
    return outcomes;
}

/**
 * One drop's characteristic function from its whole-count outcomes; falls back
 * to `dropCF`'s continuous range, scaled by the quantity, if the table is not whole.
 * @param {Object} drop - A session drop
 * @returns {import('./drop-luck.js').CharacteristicFunction}
 */
function gatheringDropCF(drop) {
    const outcomes = gatheringCountOutcomes(drop);
    if (!outcomes) {
        const multiplier = 1 + (drop.quantity || 0);
        return dropCF({ ...drop, minCount: drop.minCount * multiplier, maxCount: drop.maxCount * multiplier });
    }

    return (samples, scale) => {
        const base = 2 * Math.PI * scale * drop.price;
        const values = Array.from({ length: samples }, () => [0, 0]);
        for (const [count, probability] of outcomes) {
            const [cos, sin] = unitPowers(base * count, samples);
            for (let i = 0; i < samples; i++) {
                values[i][0] += probability * cos[i];
                values[i][1] += probability * sin[i];
            }
        }
        return values;
    };
}

/**
 * What a run's loot was worth, by the model's own prices.
 *
 * Only items the session models are counted — an essence or rare-find drop in
 * the loot map has no counterpart in the distribution, and income the model
 * never rolls for would read as luck. Prices come off the session itself rather
 * than being looked up again, so the two sides cannot drift apart.
 *
 * @param {Object} session - From `buildGatheringSession`
 * @param {Object<string, number>} drops - The log entry's drops, item hrid → count
 *   (hrids may carry an `::N` enhancement suffix)
 * @returns {number} Total value in coins
 */
export function gatheringLootValue(session, drops) {
    const priceByItem = new Map(session.drops.map((drop) => [drop.itemHrid, drop.price]));
    const processedFrom = session.processedFrom || {};

    let total = 0;
    for (const [hrid, count] of Object.entries(drops || {})) {
        const baseHrid = hrid.replace(/::\d+$/, '');
        const price = priceByItem.get(baseHrid);
        if (price > 0) {
            total += price * (count || 0);
            continue;
        }
        // A processed item is the raw items Processing made it from
        const conversion = processedFrom[baseHrid];
        const rawPrice = conversion && priceByItem.get(conversion.rawHrid);
        if (rawPrice > 0) total += rawPrice * conversion.ratio * (count || 0);
    }
    return total;
}

/**
 * What a run was owed on average, in closed form.
 *
 * The mean of a sum is the sum of the means whatever the shape, so this costs
 * nothing where the percentile costs an inversion — and it is the same
 * arithmetic as `calculateExpectedRunValue`, restricted to the priced drops the
 * distribution is built from.
 *
 * @param {Object} session - From `buildGatheringSession`
 * @returns {number} Expected income in coins
 */
export function gatheringSessionMean({ drops, actionCount }) {
    const perAction = drops.reduce(
        (sum, drop) =>
            sum +
            drop.dropRate *
                (((drop.minCount || 0) + (drop.maxCount || 0)) / 2) *
                (1 + (drop.quantity || 0)) *
                drop.price,
        0
    );
    return perAction * actionCount;
}

/**
 * How lucky a run's takings were.
 *
 * Each action rolls every drop in the table once, independently, so one
 * action's characteristic function is the product of its drops' and the run's
 * is that raised to the action count — a power, which is why fifty thousand
 * actions cost the same to analyse as fifty.
 *
 * @param {Object} session - From `buildGatheringSession`
 * @param {number} income - What the run actually paid, from `gatheringLootValue`
 * @param {Object} [options] - Overrides for `LUCK_DEFAULTS` in `drop-luck.js`
 * @returns {{percentile: number, limit: number, cdf: (income: number) => number}}
 *   `percentile` is the fraction of runs that would have done worse — 0.5 is
 *   exactly typical, 0.99 a run in a hundred, 0.01 a run in a hundred the other
 *   way. `cdf` answers the same question for any other income, and `limit` is
 *   the window the inversion settled on.
 */
export function gatheringSessionLuck(session, income, options = {}) {
    const cf = powCF(multiplyCFs(session.drops.map(gatheringDropCF)), session.actionCount);

    // Opening guess: generous enough that the search shrinks onto the answer
    // rather than having to widen, which it cannot do — same reasoning as
    // `sessionLuck`, floored at the session's own theoretical maximum payout
    // (and the observed income) so one expensive drop table cannot alias the
    // transform into a window smaller than the values it must represent
    const maxPossible =
        session.actionCount *
        session.drops.reduce(
            (sum, drop) => sum + Math.ceil(drop.maxCount * (1 + (drop.quantity || 0))) * drop.price,
            0
        );
    const startingLimit = Math.max(1e8, 2e5 * Math.max(session.actionCount, 1), maxPossible * 1.5, (income || 0) * 1.5);

    const { limit, cdf } = invertToCDF(cf, startingLimit, options);
    return { percentile: cdf(income), limit, cdf };
}

/**
 * A percentile as a rank, so it reads as a position rather than a probability.
 * @param {number} percentile - In [0, 1]
 * @returns {string} e.g. "73rd"
 */
export function formatOrdinal(percentile) {
    const rank = Math.min(Math.max(Math.round(percentile * 100), 1), 99);
    const lastTwo = rank % 100;
    const suffix = lastTwo >= 11 && lastTwo <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[rank % 10] || 'th';
    return `${rank}${suffix}`;
}

/**
 * How a percentile should read to someone who just finished the run.
 *
 * Wording and thresholds mirror `describeLuck` in
 * `features/combat/combat-drop-luck.js` — the combat verdict and this one must
 * read the same, and the combat one lives in a different library bundle, so the
 * phrasing is pinned here by test rather than shared by import.
 *
 * @param {number} percentile - In [0, 1]
 * @returns {{text: string, tone: string}} Wording and which of lucky/unlucky/normal
 */
export function describeRunLuck(percentile) {
    const better = Math.round((1 - percentile) * 100);
    const text = `${formatOrdinal(percentile)} percentile — ${better} runs in 100 beat it`;

    if (percentile >= LUCKY_PERCENTILE) return { text, tone: 'lucky' };
    if (percentile <= UNLUCKY_PERCENTILE) return { text, tone: 'unlucky' };
    return { text, tone: 'normal' };
}
