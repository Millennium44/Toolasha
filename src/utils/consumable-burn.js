/**
 * Consumable burn against the sim's assumption
 *
 * The combat sim decides a zone is worth running partly on what it thinks the
 * zone will eat: its profit figure subtracts a food and drink bill it predicted
 * from simulated triggers. Nothing has ever checked that prediction against the
 * run itself, so a zone whose food bill the sim underestimates by half quietly
 * carries that error into every downstream number — profit per hour, the
 * all-zones ranking, the "best zone" verdict.
 *
 * This is the check: measured items per hour against simmed items per hour, as
 * one ratio per category.
 *
 * ## Why a ratio and not a difference
 *
 * The two sides are counts of different things — the sim's loadout and the
 * player's are not required to match, and often do not, because the sim is
 * where you try the loadout you have not bought yet. Subtracting them produces
 * a figure in "items", which is meaningless across two different foods.
 * Dividing produces "the sim was out by this much", which is the same statement
 * whatever is in the slots, and is exactly what the profit error scales by.
 *
 * ## Why the raw measurement, not the displayed rate
 *
 * The collector's `consumptionRate` is a 90/10 blend of the observed rate with a
 * seeded baseline, capped at the game's theoretical maximum. That blend exists
 * to stop a fresh session showing "runs out in 4 seconds", and it is the right
 * figure for a run-out clock. It is the wrong figure here: comparing a
 * partly-assumed rate against an assumption measures the two assumptions
 * against each other. So this reads `actualConsumed` over `elapsedSeconds` —
 * events counted, seconds elapsed, nothing else.
 *
 * ## What it refuses to say
 *
 * - Nothing at all under `MIN_MEASURED_SECONDS`. Ten minutes of a food that
 *   fires on a health trigger is one unlucky wave away from double its rate.
 * - Nothing when the sim record is for a different zone or tier. A zone's
 *   appetite is the whole point; borrowing another zone's would be a number
 *   with nothing behind it.
 * - Nothing for a category where both sides are zero. "0× sim" for a party
 *   member who eats nothing and was simmed eating nothing is noise.
 */

/** Below this much measured time the ratio is one unlucky wave, not a reading */
export const MIN_MEASURED_SECONDS = 30 * 60;

/** How far either side may drift before the line is worth colouring */
export const BURN_BAND = 0.25;

/** The tones a comparison can carry, and what they mean */
export const BURN_COLORS = {
    flat: 'rgba(232, 236, 245, 0.55)',
    high: '#ff6b6b',
    low: '#51cf66',
};

/**
 * How bad each tone is, so a line carrying two of them takes the worst.
 *
 * Overeating moves the profit figure the wrong way and is the finding worth
 * colouring; undereating is a pleasant surprise; agreement is nothing.
 */
export const BURN_TONE_RANK = { flat: 0, low: 1, high: 2 };

/**
 * Is this consumable a drink?
 *
 * The same test the collector's rate cap and the sim adapter's slot split both
 * use — hrid first, then the item's own category — so a slot lands in the same
 * category everywhere or the comparison would be comparing two different splits.
 *
 * @param {string} itemHrid - The consumable
 * @param {Object} [itemDetail] - Its entry in `itemDetailMap`, when available
 * @returns {boolean}
 */
export function isDrinkConsumable(itemHrid, itemDetail = null) {
    const hrid = String(itemHrid || '');
    if (!hrid) return false;
    if (hrid.includes('/drinks/') || hrid.includes('coffee')) return true;
    return Boolean(itemDetail?.categoryHrid?.includes('drink'));
}

/**
 * What the run actually ate, per hour, split food from drinks.
 *
 * @param {Array<Object>} consumables - The collector's `consumables` (or the
 *   calculator's `consumableBreakdown`, which carries the same three fields)
 * @param {Function} [itemDetailFor] - `(itemHrid) => itemDetail`, for the category test
 * @returns {{food: number, drinks: number, measuredSeconds: number}} Counts per
 *   hour; `measuredSeconds` is the longest window any slot was watched for
 */
export function measuredBurnPerHour(consumables, itemDetailFor = null) {
    let food = 0;
    let drinks = 0;
    let measuredSeconds = 0;

    for (const entry of consumables || []) {
        const elapsed = Number(entry?.elapsedSeconds) || 0;
        if (elapsed <= 0) continue;

        measuredSeconds = Math.max(measuredSeconds, elapsed);

        const consumed = Number(entry?.actualConsumed) || 0;
        if (consumed <= 0) continue;

        const perHour = (consumed / elapsed) * 3600;
        if (isDrinkConsumable(entry?.itemHrid, itemDetailFor?.(entry?.itemHrid))) drinks += perHour;
        else food += perHour;
    }

    return { food, drinks, measuredSeconds };
}

/**
 * What the sim assumed, per hour, split the same way.
 *
 * @param {Object} perHour - A sim record's `perHour` map, itemHrid → count/hour
 * @param {Function} [itemDetailFor] - `(itemHrid) => itemDetail`
 * @returns {{food: number, drinks: number}}
 */
export function simBurnPerHour(perHour, itemDetailFor = null) {
    let food = 0;
    let drinks = 0;

    for (const [itemHrid, count] of Object.entries(perHour || {})) {
        const rate = Number(count);
        if (!(rate > 0)) continue;
        if (isDrinkConsumable(itemHrid, itemDetailFor?.(itemHrid))) drinks += rate;
        else food += rate;
    }

    return { food, drinks };
}

/**
 * One category's verdict, or null when there is nothing honest to say.
 *
 * A sim rate of zero cannot be divided into, so it is reported as unratable
 * rather than as infinity — except when the measurement is also zero, in which
 * case the two agree and there is simply no line to draw.
 *
 * @param {number} measured - Items per hour, measured
 * @param {number} sim - Items per hour, simmed
 * @param {number} [band] - Drift tolerated before colouring
 * @returns {{ratio: number|null, measured: number, sim: number, tone: string,
 *   reason: string|null}|null} `ratio` is null when the sim filled nothing to
 *   divide by; null altogether only when both sides are zero
 */
export function compareCategory(measured, sim, band = BURN_BAND) {
    const observed = Number(measured) || 0;
    const assumed = Number(sim) || 0;

    // Nothing simmed is not "infinitely over" — it is a slot the sim never
    // filled, and dividing by it would manufacture a verdict out of a gap.
    // But it is not "the two agree" either: eating something the sim budgeted
    // nothing for is the largest error this comparison can find, and returning
    // null made it indistinguishable from a category nobody touched
    if (assumed <= 0) {
        if (observed <= 0) return null;
        return {
            ratio: null,
            measured: observed,
            sim: 0,
            tone: 'high',
            reason: 'the sim assumed none of this',
        };
    }

    const ratio = observed / assumed;
    let tone = 'flat';
    if (ratio > 1 + band) tone = 'high';
    else if (ratio < 1 - band) tone = 'low';

    return { ratio, measured: observed, sim: assumed, tone, reason: null };
}

/**
 * The whole comparison for one run against one sim record.
 *
 * The zone check is deliberate and strict: a sim of a different zone, or the
 * same zone at a different tier, is not evidence about this run.
 *
 * @param {Object} input - What is being compared
 * @param {Array<Object>} input.consumables - The run's measured consumables
 * @param {Object|null} input.simRecord - `{zoneHrid, difficultyTier, perHour, savedAt}`
 * @param {string|null} input.actionHrid - The zone the run is in
 * @param {number} [input.difficultyTier] - Its tier
 * @param {Function} [input.itemDetailFor] - `(itemHrid) => itemDetail`
 * @param {number} [input.minSeconds] - Override the measurement floor, for tests
 * @param {number} [input.band] - Override the colour band
 * @returns {{food: Object|null, drinks: Object|null, measuredSeconds: number,
 *   simmedAt: number|null, reason: string|null}} `reason` names why there is
 *   nothing to show, and is null when there is
 */
export function compareBurnToSim({
    consumables,
    simRecord,
    actionHrid,
    difficultyTier = 0,
    itemDetailFor = null,
    minSeconds = MIN_MEASURED_SECONDS,
    band = BURN_BAND,
} = {}) {
    const empty = { food: null, drinks: null, measuredSeconds: 0, simmedAt: null, reason: null };

    if (!simRecord?.perHour) return { ...empty, reason: 'no sim on record for this zone' };
    if (!actionHrid || simRecord.zoneHrid !== actionHrid) {
        return { ...empty, reason: 'no sim on record for this zone' };
    }
    if ((simRecord.difficultyTier ?? 0) !== (difficultyTier ?? 0)) {
        return { ...empty, reason: 'the sim on record is for a different tier' };
    }

    const measured = measuredBurnPerHour(consumables, itemDetailFor);
    if (measured.measuredSeconds < minSeconds) {
        return { ...empty, measuredSeconds: measured.measuredSeconds, reason: 'not measured for long enough yet' };
    }

    const sim = simBurnPerHour(simRecord.perHour, itemDetailFor);

    return {
        food: compareCategory(measured.food, sim.food, band),
        drinks: compareCategory(measured.drinks, sim.drinks, band),
        measuredSeconds: measured.measuredSeconds,
        simmedAt: Number(simRecord.savedAt) || null,
        reason: null,
    };
}

/**
 * The comparison as the one line it is meant to be.
 *
 * "food 1.8× sim · drinks 1.0× sim (2h measured)" — and the tone is the worst
 * of the two, because one category being out is enough to move the profit.
 *
 * @param {Object} comparison - From `compareBurnToSim`
 * @param {Function} [formatDuration] - Seconds to something readable
 * @returns {{text: string, tone: string, color: string, note: string}|null} Null
 *   when neither category could be rated
 */
export function formatBurnLine(comparison, formatDuration = null) {
    const parts = [];
    let tone = 'flat';

    for (const [label, entry] of [
        ['food', comparison?.food],
        ['drinks', comparison?.drinks],
    ]) {
        if (!entry) continue;
        parts.push(entry.ratio === null ? `${label} — ${entry.reason}` : `${label} ${entry.ratio.toFixed(1)}× sim`);
        // The worst of the two, not the last of the two: a run eating half the
        // simmed drinks and twice the simmed food was being coloured green
        // purely because drinks are read second
        if (BURN_TONE_RANK[entry.tone] > BURN_TONE_RANK[tone]) tone = entry.tone;
    }

    if (!parts.length) return null;

    const seconds = Number(comparison?.measuredSeconds) || 0;
    const measured = formatDuration ? formatDuration(seconds) : `${Math.round(seconds / 3600)}h`;

    return {
        text: `${parts.join(' · ')} (${measured} measured)`,
        tone,
        color: BURN_COLORS[tone] || BURN_COLORS.flat,
        note:
            'What this run actually ate per hour against what the sim assumed for this zone and tier, from ' +
            "counted uses over measured time. The sim's consumable bill feeds its profit figure, so every " +
            'profit number below inherits this gap — a food line at 1.8× means the simmed profit is ' +
            'overstated by 0.8 of a food bill an hour.',
    };
}

export default {
    MIN_MEASURED_SECONDS,
    BURN_BAND,
    BURN_COLORS,
    BURN_TONE_RANK,
    isDrinkConsumable,
    measuredBurnPerHour,
    simBurnPerHour,
    compareCategory,
    compareBurnToSim,
    formatBurnLine,
};
