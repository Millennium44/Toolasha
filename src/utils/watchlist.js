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
 * The model is NTally's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/**
 * Put items on the list under a given set.
 *
 * Items already on the list are left where they are rather than moved, so
 * ticking a second set that shares a drop does not take that row's existing
 * home — which is the thing un-ticking relies on.
 *
 * @param {Array<{hrid: string, name: string, source: string|null}>} entries - The list
 * @param {Array<{hrid: string, name: string}>} items - What to add
 * @param {string|null} source - The set adding them, or null when added by hand
 * @returns {Array<Object>} A new list
 */
export function addToWatchlist(entries, items, source = null) {
    const known = new Set((entries || []).map((entry) => entry.hrid));
    const added = [];

    for (const item of items || []) {
        if (!item?.hrid || known.has(item.hrid)) continue;
        known.add(item.hrid);
        added.push({ hrid: item.hrid, name: item.name || item.hrid, source });
    }
    return [...(entries || []), ...added];
}

/**
 * Take one item off, whoever put it there.
 *
 * @param {Array<Object>} entries - The list
 * @param {string} hrid - What to remove
 * @returns {Array<Object>} A new list
 */
export function removeFromWatchlist(entries, hrid) {
    return (entries || []).filter((entry) => entry.hrid !== hrid);
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
 * Price and count every row.
 *
 * The lookups are passed in rather than imported, so the awkward parts — the
 * vendor floor, the multiplication, the totals — are testable without a market.
 *
 * @param {Array<Object>} entries - The list
 * @param {Object} lookups - How to resolve a row
 * @param {Function} lookups.quantityOf - `(hrid) => number`
 * @param {Function} lookups.pricesFor - `(hrid) => {ask, bid}|null`
 * @param {Function} [lookups.vendorOf] - `(hrid) => number`
 * @returns {Array<Object>} Rows with `quantity`, `ask`, `bid`, `flag`, `totalAsk`, `totalBid`
 */
export function valueWatchlist(entries, { quantityOf, pricesFor, vendorOf }) {
    return (entries || []).map((entry) => {
        const quantity = Number(quantityOf?.(entry.hrid)) || 0;
        const prices = pricesFor?.(entry.hrid) || {};
        const ask = Number(prices.ask) || 0;
        const floor = vendorFloor(prices.bid, vendorOf?.(entry.hrid));

        return {
            ...entry,
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
