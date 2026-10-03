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
 * @property {number|null} perDay - How many are consumed a day, or null when unknown
 * @property {boolean} rateKnown - Whether consumption is measured or known to be zero
 * @property {number|null} secondsLeft - Until it runs out; `Infinity` when unused, null when unknown
 * @property {number|null} costPerDay - What a day of it costs, or null with no price
 * @property {number|null} price - Price per item, or null
 * @property {{ask: number|null, bid: number|null}} costPerDaySides - A day's cost at each side
 */

/**
 * Normalise one entry of `consumableBreakdown`.
 *
 * @param {Object} entry - From `calculatePlayerStats`
 * @returns {Forecast}
 */
export function forecast(entry, prices = null) {
    const held = Number(entry?.inventoryAmount ?? entry?.currentCount ?? 0) || 0;
    const rawRate = entry?.consumptionRate;
    const rate =
        rawRate !== null && rawRate !== undefined && Number.isFinite(Number(rawRate)) && Number(rawRate) >= 0
            ? Number(rawRate)
            : null;
    const rateKnown = rate !== null;
    const price = Number(entry?.pricePerItem) > 0 ? Number(entry.pricePerItem) : null;

    // Not being used is not the same as lasting forever, but it is the same
    // arithmetic — what keeps them apart is that the headline ignores anything
    // infinite rather than letting it win the minimum
    const secondsLeft = !rateKnown ? null : rate > 0 ? held / rate : Infinity;
    const perDay = rateKnown ? rate * 86400 : null;

    // Both sides, because buying costs ask and the stock you already hold is
    // worth bid — MCS shows the pair and the gap between them is real money
    const side = (value) => (!rateKnown || !(value > 0) ? null : perDay * value);

    return {
        itemHrid: entry?.itemHrid || '',
        name: entry?.itemName || entry?.itemHrid || 'Unknown',
        held,
        rateKnown,
        perDay,
        secondsLeft,
        price,
        costPerDay: !rateKnown || price === null ? null : perDay * price,
        costPerDaySides: { ask: side(prices?.ask), bid: side(prices?.bid) },
    };
}

/**
 * Every consumable in use, soonest to run out first.
 *
 * Ones that are not being consumed sort last rather than being dropped — you
 * still want to see that a slot is filled with something it is not drinking.
 *
 * @param {Array<Object>} breakdown - From `calculatePlayerStats`
 * @param {Function} [pricesFor] - `(itemHrid) => {ask, bid}`, for the two-sided cost
 * @param {Object} [options] - `keepOrder` leaves them in the order given, which is slot order
 * @returns {Forecast[]}
 */
export function forecastAll(breakdown, pricesFor = null, { keepOrder = false } = {}) {
    const list = (breakdown || []).map((entry) => forecast(entry, pricesFor?.(entry?.itemHrid)));

    // The order the game gave them is slot order, which is how they are equipped
    // and therefore how you think about them — the soonest is already marked, so
    // sorting by it as well trades a familiar list for a shuffling one
    return keepOrder
        ? list
        : list.sort((a, b) => {
              if (a.rateKnown !== b.rateKnown) return a.rateKnown ? -1 : 1;
              return (a.secondsLeft ?? Infinity) - (b.secondsLeft ?? Infinity);
          });
}

/**
 * When the character actually stops.
 *
 * The minimum, not the mean — a run ends when its first consumable runs out.
 * Unused and unknown-rate entries are left out: neither has a finite countdown
 * that can be compared honestly with measured use.
 *
 * @param {Forecast[]} forecasts - Normalised consumables
 * @returns {Forecast|null} The one that goes first, or null when no rate is known
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
 * Unpriced and unrated items are excluded from the sum and counted separately,
 * rather than silently making the total look smaller than it is.
 *
 * @param {Forecast[]} forecasts - Normalised consumables
 * @returns {{total: number, unpriced: number, unrated: number}}
 */
export function costPerDay(forecasts) {
    let total = 0;
    let unpriced = 0;
    let unrated = 0;

    for (const entry of forecasts || []) {
        if (!entry.rateKnown) {
            unrated++;
            continue;
        }
        if (entry.costPerDay === null) unpriced++;
        else total += entry.costPerDay;
    }
    return { total, unpriced, unrated };
}

/**
 * How many more of something is needed to last a given time, and what that costs.
 *
 * Rounded **up**: nine and a half drinks is ten drinks, and a refill that leaves
 * you half an item short leaves you stopped.
 *
 * @param {Forecast} entry - Normalised consumable
 * @param {number} seconds - How long it should last
 * @returns {{count: number|null, cost: number|null, rateUnknown?: boolean}} Null count when the rate is unknown
 */
export function refillFor(entry, seconds) {
    if (!entry?.rateKnown) return { count: null, cost: null, rateUnknown: true };
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
 * @returns {{items: number, cost: number, unpriced: number, unrated: number}}
 */
export function refillAll(forecasts, seconds) {
    let items = 0;
    let cost = 0;
    let unpriced = 0;
    let unrated = 0;

    for (const entry of forecasts || []) {
        const need = refillFor(entry, seconds);
        if (need.rateUnknown) {
            unrated++;
            continue;
        }
        if (!need.count) continue;

        items += need.count;
        if (need.cost === null) unpriced++;
        else cost += need.cost;
    }
    return { items, cost, unpriced, unrated };
}

/**
 * A day of everything, at each side of the book.
 *
 * Buying costs ask and selling returns bid, and on a consumable bill of twelve
 * million a day the gap between them is worth seeing rather than averaging away.
 *
 * @param {Forecast[]} forecasts - Normalised consumables
 * @returns {{ask: number|null, bid: number|null, askUnpriced: number, bidUnpriced: number,
 * askUnknown: number, bidUnknown: number}}
 */
export function costPerDaySides(forecasts) {
    const totals = {
        ask: { amount: 0, unpriced: 0 },
        bid: { amount: 0, unpriced: 0 },
        askUnknown: 0,
        bidUnknown: 0,
    };

    for (const entry of forecasts || []) {
        // An unused slot contributes an actual zero, not an unpriced cost.
        // For a consumed item, keep the missing market side visible instead of
        // turning an incomplete total into a plausible-looking free one.
        if (!entry?.rateKnown) {
            totals.askUnknown++;
            totals.bidUnknown++;
            continue;
        }
        if (!(entry.perDay > 0)) continue;

        for (const side of ['ask', 'bid']) {
            const amount = entry.costPerDaySides?.[side];
            if (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0) {
                totals[side].amount += amount;
            } else {
                totals[side].unpriced += 1;
            }
        }
    }

    return {
        ask: (totals.ask.unpriced || totals.askUnknown) && totals.ask.amount === 0 ? null : totals.ask.amount,
        bid: (totals.bid.unpriced || totals.bidUnknown) && totals.bid.amount === 0 ? null : totals.bid.amount,
        askUnpriced: totals.ask.unpriced,
        bidUnpriced: totals.bid.unpriced,
        askUnknown: totals.askUnknown,
        bidUnknown: totals.bidUnknown,
    };
}

/**
 * When you stop, and when the party stops.
 *
 * Two separate answers because they mean different things to act on: your own
 * countdown is what you can do something about right now, and the party's is
 * what ends the run regardless of how well stocked you are. Rolling them into
 * one figure loses whichever of those you needed.
 *
 * The party figure deliberately **excludes you** — it answers "and how is
 * everyone else doing", which is the only part of it you cannot see already.
 *
 * @param {Array<{isCurrent: boolean, name: string, forecasts: Forecast[]}>} players - Per player
 * @returns {{you: Forecast|null, party: Forecast|null, partyName: string|null}}
 */
export function partyOutlook(players) {
    let you = null;
    let party = null;
    let partyName = null;

    for (const player of players || []) {
        const soonest = firstToRunOut(player.forecasts);
        if (!soonest) continue;

        if (player.isCurrent) {
            you = soonest;
            continue;
        }
        if (!party || soonest.secondsLeft < party.secondsLeft) {
            party = soonest;
            partyName = player.name || null;
        }
    }
    return { you, party, partyName };
}

/** The game keeps every duration in nanoseconds */
const NS_PER_SECOND = 1e9;

/**
 * How often a drink is drunk, from the game's own numbers.
 *
 * Drinks do not need measuring. A drink is re-drunk the moment its buff expires,
 * and the combat simulator divides that duration by `1 + drinkConcentration` —
 * so the rate is arithmetic, not observation. Food is the opposite: it is eaten
 * when health or mana crosses a threshold, which depends on what is hitting you,
 * so there is nothing to compute and measurement is the only honest answer.
 *
 * This matters beyond tidiness. The measured rate is capped at a hardcoded
 * 345.6 a day — 300 seconds at the maximum 20% concentration — so anyone with
 * less concentration than the cap assumes was being told they drink faster than
 * they do, and that their stock would last less long than it will.
 *
 * @param {number} durationNs - The buff's base duration, in nanoseconds
 * @param {number} [drinkConcentration] - The player's concentration, as a fraction
 * @returns {number|null} Drinks per day, or null when the duration is unknown
 */
export function drinkRatePerDay(durationNs, drinkConcentration = 0) {
    const seconds = Number(durationNs) / NS_PER_SECOND;
    if (!(seconds > 0)) return null;

    const concentration = Number(drinkConcentration) || 0;
    return 86400 / (seconds / (1 + concentration));
}

/**
 * A breakdown with each drink's rate replaced by the one its buff duration implies.
 *
 * The tracker measures food honestly — it is eaten on a cooldown as the fight demands — but a
 * drink is not consumed by the fight at all: it is re-poured when its buff lapses, so its rate is
 * arithmetic on the duration and the drinker's concentration, not something to be observed. Every
 * surface that shows a drink's runway has to apply this same substitution or the same stock reads
 * as a different number in each place.
 *
 * An entry whose item has no buff duration (all food, and anything unknown) is passed through
 * untouched rather than zeroed.
 *
 * @param {Array<Object>} breakdown - From `calculatePlayerStats`
 * @param {number} [drinkConcentration] - The player's concentration, as a fraction
 * @param {Function} [itemDetails] - `(itemHrid) => itemDetail`, for the buff duration
 * @returns {Array<Object>} The same entries, drinks re-rated
 */
export function exactDrinkRates(breakdown, drinkConcentration = 0, itemDetails = () => null) {
    return (breakdown || []).map((entry) => {
        const duration = itemDetails(entry?.itemHrid)?.consumableDetail?.buffs?.[0]?.duration;
        const perDay = drinkRatePerDay(duration, drinkConcentration);
        if (perDay === null) return entry;

        return { ...entry, consumptionRate: perDay / 86400, consumedPerDay: Math.ceil(perDay) };
    });
}

/**
 * Whether to place a buy order or simply take the ask.
 *
 * The bulk sell assistant's judgement, mirrored: an order at the bid saves the
 * spread but only pays out if it fills, and a fill that arrives after you have
 * already run out has saved you nothing — so urgency beats price. Past urgency
 * the rules are the sell side's, each turned around: a spread that is a sliver
 * of the ask, a saving that is pocket change in absolute coins, or an order so
 * small it is not worth one of the finite order slots, all say pay the ask and
 * be done. What survives every rule is worth queueing for, and the answer
 * carries `savingPerHour` — the saving divided by the expected wait — so
 * callers can rank restocks by what each hour of patience actually pays.
 *
 * @param {Object} input - What is being bought
 * @param {number} input.count - How many are needed
 * @param {number|null} input.ask - Price to buy now
 * @param {number|null} input.bid - Price an order would sit at
 * @param {number} input.secondsLeft - Until the current stock runs out
 * @param {number|null} [input.fillSeconds] - Measured fill time; null falls back to an assumption
 * @param {number} [input.maxSpreadPct] - Buy instantly when the spread is at most
 *   this percentage of the ask (the sell side's spread rule, mirrored). 0 turns it off.
 * @param {number} [input.minSavingCoins] - Buy instantly when the whole order's
 *   saving — (ask − bid) × count — is under this many coins. 0 turns it off.
 * @param {number} [input.minOrderValue] - Buy instantly when the order's total
 *   (bid × count) is under this — too small to be worth an order slot. 0 turns it off.
 * @returns {{mode: string, saving: number, savingPerHour: number|null, measured: boolean, reason: string}}
 *   `order` or `instant`
 */
export function buyStrategy({
    count,
    ask,
    bid,
    secondsLeft,
    fillSeconds = null,
    maxSpreadPct = 2,
    minSavingCoins = 0,
    minOrderValue = 0,
}) {
    // Only reached when no order book has been seen for this item. Six hours is
    // a placeholder, not a measurement, and the caller is told which it got so
    // it can say so rather than presenting a guess as an estimate
    const measured = Number.isFinite(fillSeconds);
    const waitSeconds = measured ? fillSeconds : 6 * 3600;
    if (!(count > 0) || !(ask > 0)) {
        return { mode: 'instant', saving: 0, savingPerHour: null, measured, reason: 'No price to compare.' };
    }
    if (!(bid > 0)) {
        return {
            mode: 'instant',
            saving: 0,
            savingPerHour: null,
            measured,
            reason: 'Nothing bid, so an order has nothing to sit at.',
        };
    }

    const saving = (ask - bid) * count;
    const spreadPct = ((ask - bid) / ask) * 100;
    // What each hour of patience pays. The wait can be zero when the front of
    // the queue is measured as already clearing — that is not an infinite rate,
    // it is a fill so fast the order is as good as instant
    const savingPerHour = waitSeconds > 0 ? saving / (waitSeconds / 3600) : saving;
    const instant = (reason) => ({ mode: 'instant', saving, savingPerHour, measured, reason });

    // Running out before an order would plausibly fill makes the saving
    // theoretical — you cannot spend a discount you did not receive in time
    if (secondsLeft < waitSeconds) {
        const how = measured ? 'the book says it would fill in' : 'an order is assumed to take';
        return instant(`Runs out before ${how} ${formatWait(waitSeconds)}.`);
    }
    if (minOrderValue > 0 && bid * count < minOrderValue) {
        return instant(
            `The whole order is under ${Math.round(minOrderValue).toLocaleString()} coins — not worth an order slot.`
        );
    }
    if (maxSpreadPct > 0 && spreadPct <= maxSpreadPct) {
        return instant(`The spread (${spreadPct.toFixed(1)}%) is too thin to be worth waiting for.`);
    }
    if (minSavingCoins > 0 && saving < minSavingCoins) {
        return instant(
            `Waiting saves only ~${Math.round(saving).toLocaleString()} coins, under the ` +
                `${Math.round(minSavingCoins).toLocaleString()} you asked an order to be worth.`
        );
    }

    const fills = measured ? `Fills in about ${formatWait(waitSeconds)}. ` : 'No order book seen for this item yet. ';
    return {
        mode: 'order',
        saving,
        savingPerHour,
        measured,
        reason:
            `${fills}Saves about ${Math.round(saving).toLocaleString()} ` +
            `(~${Math.round(savingPerHour).toLocaleString()}/hour of waiting).`,
    };
}

/**
 * A wait, in the words you would use for one.
 * @param {number} seconds - How long
 * @returns {string} e.g. `40 minutes`, `3 hours`, `2 days`
 */
function formatWait(seconds) {
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))} minutes`;
    if (seconds < 86400) return `${Math.round(seconds / 3600)} hours`;
    return `${Math.round(seconds / 86400)} days`;
}
