/**
 * Consumable Forecast
 *
 * When the food and drinks run out, and what it costs to keep them topped up.
 *
 * This is the figure that decides whether a run survives the night. Everything
 * else on the overlay tells you how well the run is going; this tells you how
 * long it will still be going, which is the only one you can act on before it is
 * too late to act on it.
 *
 * ## The one that matters is the soonest
 *
 * A character stops when its **first** consumable runs out, not its average one.
 * So the headline is a minimum, not a mean, and a consumable that is not being
 * used at all has to be kept out of that minimum rather than counted as lasting
 * forever and quietly winning it.
 *
 * Kept pure and apart from the panel because the arithmetic has several answers
 * that look right: a rate of zero that means "not used" against one that means
 * "not measured yet", a stock of zero that means "ran out" against one that
 * means "never had any", and a refill figure that has to be rounded up, since
 * nine and a half drinks is ten drinks.
 */

/**
 * One consumable, normalised out of the combat stats breakdown.
 *
 * @typedef {Object} Forecast
 * @property {string} itemHrid - The item
 * @property {string} name - Display name
 * @property {number} held - How many are in the inventory
 * @property {number} perDay - How many are consumed a day
 * @property {number} secondsLeft - Until it runs out; `Infinity` when it is not being used
 * @property {number|null} costPerDay - What a day of it costs, or null with no price
 * @property {number|null} price - Price per item, or null
 */

/**
 * Normalise one entry of `consumableBreakdown`.
 *
 * @param {Object} entry - From `calculatePlayerStats`
 * @returns {Forecast}
 */
export function forecast(entry) {
    const held = Number(entry?.inventoryAmount ?? entry?.currentCount ?? 0) || 0;
    const rate = Number(entry?.consumptionRate) || 0;
    const price = Number(entry?.pricePerItem) > 0 ? Number(entry.pricePerItem) : null;

    // Not being used is not the same as lasting forever, but it is the same
    // arithmetic — what keeps them apart is that the headline ignores anything
    // infinite rather than letting it win the minimum
    const secondsLeft = rate > 0 ? held / rate : Infinity;
    const perDay = rate * 86400;

    return {
        itemHrid: entry?.itemHrid || '',
        name: entry?.itemName || entry?.itemHrid || 'Unknown',
        held,
        perDay,
        secondsLeft,
        price,
        costPerDay: price === null ? null : perDay * price,
    };
}

/**
 * Every consumable in use, soonest to run out first.
 *
 * Ones that are not being consumed sort last rather than being dropped — you
 * still want to see that a slot is filled with something it is not drinking.
 *
 * @param {Array<Object>} breakdown - From `calculatePlayerStats`
 * @returns {Forecast[]}
 */
export function forecastAll(breakdown) {
    return (breakdown || []).map(forecast).sort((a, b) => a.secondsLeft - b.secondsLeft);
}

/**
 * When the character actually stops.
 *
 * The minimum, not the mean — a run ends when its first consumable runs out.
 * Anything not being used is left out entirely, because "never" is not a
 * candidate for "soonest" however the arithmetic is written.
 *
 * @param {Forecast[]} forecasts - Normalised consumables
 * @returns {Forecast|null} The one that goes first, or null when nothing is being used
 */
export function firstToRunOut(forecasts) {
    let soonest = null;
    for (const entry of forecasts || []) {
        if (!Number.isFinite(entry.secondsLeft)) continue;
        if (!soonest || entry.secondsLeft < soonest.secondsLeft) soonest = entry;
    }
    return soonest;
}

/**
 * What a day of every consumable costs.
 *
 * Unpriced items are counted as nothing and reported separately, rather than
 * silently making the total look smaller than it is.
 *
 * @param {Forecast[]} forecasts - Normalised consumables
 * @returns {{total: number, unpriced: number}}
 */
export function costPerDay(forecasts) {
    let total = 0;
    let unpriced = 0;

    for (const entry of forecasts || []) {
        if (entry.costPerDay === null) unpriced++;
        else total += entry.costPerDay;
    }
    return { total, unpriced };
}

/**
 * How many more of something is needed to last a given time, and what that costs.
 *
 * Rounded **up**: nine and a half drinks is ten drinks, and a refill that leaves
 * you half an item short leaves you stopped.
 *
 * @param {Forecast} entry - Normalised consumable
 * @param {number} seconds - How long it should last
 * @returns {{count: number, cost: number|null}} Zero when there is already enough
 */
export function refillFor(entry, seconds) {
    // Something not being consumed needs nothing, however long the target
    if (!(entry?.perDay > 0) || !(seconds > 0)) return { count: 0, cost: 0 };

    const wanted = Math.ceil((entry.perDay * seconds) / 86400);
    const count = Math.max(0, wanted - Math.floor(entry.held));

    return { count, cost: entry.price === null ? null : count * entry.price };
}

/**
 * What it costs to bring everything up to a given duration.
 *
 * @param {Forecast[]} forecasts - Normalised consumables
 * @param {number} seconds - Target duration
 * @returns {{items: number, cost: number, unpriced: number}}
 */
export function refillAll(forecasts, seconds) {
    let items = 0;
    let cost = 0;
    let unpriced = 0;

    for (const entry of forecasts || []) {
        const need = refillFor(entry, seconds);
        if (!need.count) continue;

        items += need.count;
        if (need.cost === null) unpriced++;
        else cost += need.cost;
    }
    return { items, cost, unpriced };
}
