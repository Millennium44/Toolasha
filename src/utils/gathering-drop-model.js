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
 * ## Floors
 *
 * Mirroring `buildCombatSession`: no completed actions, no drop table (which is
 * what production and combat actions look like here), or nothing in the table
 * that resolves to a price — each returns null, and null means no verdict
 * rather than a made-up one.
 */

import { multiplyCFs, powCF, dropCF, invertToCDF } from './drop-luck.js';

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
 * @returns {{drops: Array<Object>, actionCount: number}|null} A session, or null
 *   when the run cannot be modelled — no drop table, no completed actions, or
 *   nothing in the table with a price
 */
export function buildGatheringSession({ actionDetail, actionCount, priceOf }) {
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
        });
    }
    if (!drops.length) return null;

    return { drops, actionCount };
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

    let total = 0;
    for (const [hrid, count] of Object.entries(drops || {})) {
        const baseHrid = hrid.replace(/::\d+$/, '');
        const price = priceByItem.get(baseHrid);
        if (price > 0) total += price * (count || 0);
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
        (sum, drop) => sum + drop.dropRate * (((drop.minCount || 0) + (drop.maxCount || 0)) / 2) * drop.price,
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
    const cf = powCF(multiplyCFs(session.drops.map(dropCF)), session.actionCount);

    // Opening guess: generous enough that the search shrinks onto the answer
    // rather than having to widen, which it cannot do — same reasoning and same
    // scale as `sessionLuck`, with actions standing in for waves
    const startingLimit = Math.max(1e8, 2e5 * Math.max(session.actionCount, 1));

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
