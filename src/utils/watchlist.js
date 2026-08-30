/**
 * Watchlist
 *
 * A named set of items, what you hold of each, and what it is worth.
 *
 * The list itself is trivial. Two things about it are not, and they are the
 * reason this is a module with tests rather than a few lines inside a panel.
 *
 * ## Un-ticking a set must not take items another set still wants
 *
 * Items go on the list one at a time, or a whole zone's drop table at once, or a
 * whole chest's contents. Zones share drops — Aqua Planet and Jungle Planet have
 * items in common — so removing one set cannot simply remove everything it
 * contributed. Every row remembers which set put it there, and un-ticking a set
 * **re-homes** any of its rows that another still-enabled set also contains,
 * rather than deleting them. Get that wrong and un-ticking one zone silently
 * empties part of another, which reads as the list losing things at random.
 *
 * Rows added by hand have no set, and nothing automatic ever removes them.
 *
 * ## The vendor price is a floor, not a comparison
 *
 * The market bid can sit below what the vendor pays flat. When it does, the bid
 * is not the item's value — it is a number you would be a fool to accept, and
 * showing it as the value quietly advises the worse of two sales. So the row
 * reports the vendor price and says why. The same applies with more force to an
 * item that has no market at all: a bid of zero is the absence of a price, not a
 * value of nothing.
 *
 * ## An enhancement level is part of which item this is
 *
 * A drop table is +0s and a row put on by hand from the upgrade advisor may not
 * be: "Cheese Sword +5" is a different thing to buy, at a different price, from
 * the +0 of the same name. So a row may carry an `enhancementLevel`, and that
 * level is part of its identity — `watchlistKey` — rather than a label on it.
 * Without that, tracking the +5 of something already on the list at +0 does
 * nothing at all, and the row goes on quoting the +0 price for a target it is
 * not about.
 *
 * A row with no level, which is every row a set ever added and every row written
 * before this existed, keys as the bare hrid. That is what keeps the old stored
 * shape, the set algebra and the inventory dot all working unchanged.
 *
 * The model is NTally's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/**
 * What tells one row from another.
 *
 * A +0 keys as the bare hrid, deliberately: every row that predates enhancement
 * levels is a +0, and a scheme that suffixed them all would make each one a new
 * row the next time anything compared keys.
 *
 * @param {string} hrid - The item
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {string} The row's identity
 */
export function watchlistKey(hrid, enhancementLevel = 0) {
    const level = Number(enhancementLevel) || 0;
    return level > 0 ? `${hrid}::${level}` : String(hrid);
}

/**
 * One row's identity.
 * @param {Object} entry - A row
 * @returns {string} From `watchlistKey`
 */
export function entryKey(entry) {
    return watchlistKey(entry?.hrid, entry?.enhancementLevel);
}

/**
 * Put items on the list under a given set.
 *
 * Items already on the list are left where they are rather than moved, so
 * ticking a second set that shares a drop does not take that row's existing
 * home — which is the thing un-ticking relies on.
 *
 * @param {Array<{hrid: string, name: string, source: string|null}>} entries - The list
 * @param {Array<{hrid: string, name: string, enhancementLevel?: number}>} items - What to add
 * @param {string|null} source - The set adding them, or null when added by hand
 * @returns {Array<Object>} A new list
 */
export function addToWatchlist(entries, items, source = null) {
    const known = new Set((entries || []).map(entryKey));
    const added = [];

    for (const item of items || []) {
        if (!item?.hrid) continue;
        const key = entryKey(item);
        if (known.has(key)) continue;
        known.add(key);

        const level = Number(item.enhancementLevel) || 0;
        const row = { hrid: item.hrid, name: item.name || item.hrid, source };
        // Only when there is one: a `enhancementLevel: 0` on every row would be
        // a stored-shape change for every list that never asked for one
        if (level > 0) row.enhancementLevel = level;
        added.push(row);
    }
    return [...(entries || []), ...added];
}

/**
 * Take one item off, whoever put it there.
 *
 * The level is part of what is being removed: taking off the +5 must leave the
 * +0 of the same item where it is, since they are two rows about two purchases.
 *
 * @param {Array<Object>} entries - The list
 * @param {string} hrid - What to remove
 * @param {number} [enhancementLevel] - Which enhancement of it
 * @returns {Array<Object>} A new list
 */
export function removeFromWatchlist(entries, hrid, enhancementLevel = 0) {
    const key = watchlistKey(hrid, enhancementLevel);
    return (entries || []).filter((entry) => entryKey(entry) !== key);
}

/**
 * Un-tick a set, keeping what another still-enabled set also contains.
 *
 * @param {Array<Object>} entries - The list
 * @param {string} source - The set being turned off
 * @param {Array<{id: string, hrids: Iterable<string>}>} stillOn - Sets still enabled, in order
 * @returns {Array<Object>} A new list, with survivors re-homed
 */
export function removeSource(entries, source, stillOn = []) {
    const homes = (stillOn || []).map((set) => ({ id: set.id, hrids: new Set(set.hrids) }));

    return (entries || []).flatMap((entry) => {
        // Added by hand, or by a set that is not the one being turned off
        if (entry.source === null || entry.source === undefined || entry.source !== source) return [entry];

        // First in the given order, so the same list re-homes the same way every
        // time rather than shuffling as sets are toggled
        const home = homes.find((set) => set.hrids.has(entry.hrid));
        return home ? [{ ...entry, source: home.id }] : [];
    });
}

/**
 * The price a row should report, and whether that needs saying out loud.
 *
 * @param {number} bid - Current market bid
 * @param {number} vendor - What the vendor pays flat
 * @returns {{price: number, flag: string|null}} `flag` is `below-vendor`,
 *   `equals-vendor`, `no-market`, or null when the bid stands on its own
 */
export function vendorFloor(bid, vendor) {
    const market = Number(bid) || 0;
    const flat = Number(vendor) || 0;

    if (!(flat > 0)) return { price: market, flag: null };
    // No market at all: the vendor price is the only price, and zero would be a
    // claim that the item is worthless rather than that nobody is buying it
    if (!(market > 0)) return { price: flat, flag: 'no-market' };
    if (market < flat) return { price: flat, flag: 'below-vendor' };
    if (market === flat) return { price: flat, flag: 'equals-vendor' };

    return { price: market, flag: null };
}

/**
 * How many of an item are sitting in your own sell orders.
 *
 * A watchlist that counts only the inventory says you have none of something
 * you have two hundred of — they are just on the market rather than in the bag.
 * That is the difference between "I need to farm this" and "I need to wait", and
 * a collection checklist that cannot tell them apart is worse than no checklist.
 *
 * Unclaimed items from a filled **buy** order count too: they are yours, bought
 * and paid for, and only a click away from the inventory.
 *
 * Keyed by `watchlistKey`, so a listing of the +5 is counted against the +5 row
 * rather than against the +0 of the same name — they are separate books on the
 * market and separate rows here.
 *
 * @param {Array<Object>} listings - The game's `myMarketListings`
 * @returns {Object<string, {listed: number, unclaimed: number}>} By `watchlistKey`
 */
export function listedCounts(listings) {
    const counts = {};
    const bump = (hrid, level, field, amount) => {
        if (!hrid || !(amount > 0)) return;
        const key = watchlistKey(hrid, level);
        counts[key] = counts[key] || { listed: 0, unclaimed: 0 };
        counts[key][field] += amount;
    };

    for (const listing of listings || []) {
        // A listing the game has ended is no longer on the market: whatever it
        // did not sell has moved into `unclaimedItemCount`, so counting the
        // remainder as still listed would count the same items twice
        const ended = listing?.status && listing.status !== '/market_listing_status/active';
        const remaining = ended ? 0 : Math.max(0, (listing?.orderQuantity || 0) - (listing?.filledQuantity || 0));
        // Only a sell order is holding items; a buy order's remainder is coin
        if (listing?.isSell) bump(listing.itemHrid, listing.enhancementLevel, 'listed', remaining);
        bump(listing?.itemHrid, listing?.enhancementLevel, 'unclaimed', listing?.unclaimedItemCount || 0);
    }
    return counts;
}

/**
 * Price and count every row.
 *
 * The lookups are passed in rather than imported, so the awkward parts — the
 * vendor floor, the multiplication, the totals — are testable without a market.
 *
 * @param {Array<Object>} entries - The list
 * @param {Object} lookups - How to resolve a row
 * @param {Function} lookups.quantityOf - `(hrid, enhancementLevel) => number`
 * @param {Function} lookups.pricesFor - `(hrid, enhancementLevel) => {ask, bid}|null`
 * @param {Function} [lookups.vendorOf] - `(hrid) => number`
 * @param {Function} [lookups.listedOf] - `(hrid, enhancementLevel) => {listed, unclaimed}`
 * @returns {Array<Object>} Rows with `held`, `listed`, `unclaimed`, `quantity`,
 *   `ask`, `bid`, `flag`, `totalAsk`, `totalBid`. `quantity` is everything you
 *   own of the item wherever it is sitting; `held` is only the bag.
 */
export function valueWatchlist(entries, { quantityOf, pricesFor, vendorOf, listedOf }) {
    return (entries || []).map((entry) => {
        // The level the row is about, which is what it must be counted and
        // priced at — a +5 row quoting the +0 ask is quoting a different item
        const level = Number(entry.enhancementLevel) || 0;
        const held = Number(quantityOf?.(entry.hrid, level)) || 0;
        const market = listedOf?.(entry.hrid, level) || {};
        const listed = Number(market.listed) || 0;
        const unclaimed = Number(market.unclaimed) || 0;
        // Everything you own of it, wherever it happens to be
        const quantity = held + listed + unclaimed;

        const prices = pricesFor?.(entry.hrid, level) || {};
        const ask = Number(prices.ask) || 0;
        const floor = vendorFloor(prices.bid, vendorOf?.(entry.hrid));

        return {
            ...entry,
            held,
            listed,
            unclaimed,
            quantity,
            ask,
            bid: floor.price,
            flag: floor.flag,
            totalAsk: ask * quantity,
            totalBid: floor.price * quantity,
        };
    });
}

/**
 * What the whole list is worth.
 * @param {Array<Object>} rows - From `valueWatchlist`
 * @returns {{ask: number, bid: number, items: number, held: number}}
 */
export function watchlistTotals(rows) {
    return (rows || []).reduce(
        (totals, row) => ({
            ask: totals.ask + (row.totalAsk || 0),
            bid: totals.bid + (row.totalBid || 0),
            items: totals.items + 1,
            // How many of the tracked items you actually hold any of, which is
            // the "12 / 30" a collection checklist is for
            held: totals.held + (row.quantity > 0 ? 1 : 0),
        }),
        { ask: 0, bid: 0, items: 0, held: 0 }
    );
}

/**
 * Order the rows.
 *
 * By value means by what you hold, not by unit price — a stack of one cheap item
 * is not more valuable than a stack of a thousand. Ties break on name so the
 * order is stable rather than dependent on which sets were ticked first.
 *
 * @param {Array<Object>} rows - From `valueWatchlist`
 * @param {string} by - `name` or `value`
 * @param {string} direction - `asc` or `desc`
 * @returns {Array<Object>} A new array
 */
export function sortRows(rows, by = 'name', direction = 'asc') {
    const sign = direction === 'desc' ? -1 : 1;

    return [...(rows || [])].sort((a, b) => {
        if (by === 'value') {
            const difference = (a.totalAsk || 0) - (b.totalAsk || 0);
            if (difference) return sign * difference;
        }
        return sign * String(a.name).localeCompare(String(b.name));
    });
}
