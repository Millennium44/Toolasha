/**
 * Market Watchlist
 *
 * Which items are pinned, in what order, and how much of each one to show.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * Order is the whole point of the data structure. A watchlist you cannot arrange
 * is a list you have to read all of every time, so the entries are kept as an
 * array rather than the keyed object the rest of this feature uses — an object's
 * key order is technically preserved for string keys but relying on that to hold
 * a user's arrangement is relying on an implementation detail to store intent.
 *
 * Pure: state in, state out.
 */

/**
 * How much of each pinned item to show. Cycling through these is one button
 * rather than a settings page, because the right amount of detail depends on how
 * many items are pinned and that changes constantly.
 */
export const DISPLAY_MODES = ['icon', 'iconChange', 'iconPrice', 'iconBoth', 'namePrice', 'full', 'hidden'];

/** More than this and the row of chips stops being readable at any size */
export const MAX_WATCHED = 99;

/**
 * Add an item, remembering the price it was pinned at so the chip can show a
 * move from a point you chose rather than from whenever the cache happened to
 * last update.
 *
 * @param {Array<Object>} watchlist - Current entries
 * @param {string} key - itemHrid:enhancementLevel
 * @param {Object|null} price - The price now, if known
 * @returns {Array<Object>} A new list, unchanged when full or already present
 */
export function addWatched(watchlist, key, price) {
    const list = watchlist || [];
    if (list.some((entry) => entry.key === key)) return list;
    if (list.length >= MAX_WATCHED) return list;

    return [...list, { key, ask: price?.ask ?? -1, bid: price?.bid ?? -1, at: price?.at ?? 0 }];
}

/**
 * @param {Array<Object>} watchlist - Current entries
 * @param {string} key - itemHrid:enhancementLevel
 * @returns {Array<Object>} A new list
 */
export function removeWatched(watchlist, key) {
    return (watchlist || []).filter((entry) => entry.key !== key);
}

/**
 * Move one entry a step along.
 * @param {Array<Object>} watchlist - Current entries
 * @param {string} key - Entry to move
 * @param {number} direction - -1 earlier, 1 later
 * @returns {Array<Object>} A new list, unchanged at either end
 */
export function moveWatched(watchlist, key, direction) {
    const list = [...(watchlist || [])];
    const from = list.findIndex((entry) => entry.key === key);
    if (from < 0) return watchlist || [];

    const to = from + (direction < 0 ? -1 : 1);
    if (to < 0 || to >= list.length) return watchlist || [];

    [list[from], list[to]] = [list[to], list[from]];
    return list;
}

/**
 * The next display mode in the cycle.
 * @param {string} mode - Current mode
 * @returns {string}
 */
export function nextDisplayMode(mode) {
    const index = DISPLAY_MODES.indexOf(mode);
    return DISPLAY_MODES[(index + 1) % DISPLAY_MODES.length];
}

/**
 * How far one pinned item has moved since it was pinned.
 *
 * Reported per side, and only where both readings exist. A side that was empty
 * when the item was pinned has no baseline, and inventing one — treating "nobody
 * was selling" as a price of zero — would report an infinite rise the moment
 * somebody listed.
 *
 * @param {Object} entry - Watchlist entry, carrying the price it was pinned at
 * @param {Object|null} price - The price now
 * @returns {{ask: number|null, bid: number|null, askChange: number|null, bidChange: number|null}}
 */
export function watchedChange(entry, price) {
    const percent = (before, after) => {
        if (!(before > 0) || !(after > 0)) return null;
        return ((after - before) / before) * 100;
    };

    return {
        ask: price?.ask > 0 ? price.ask : null,
        bid: price?.bid > 0 ? price.bid : null,
        askChange: percent(entry?.ask, price?.ask),
        bidChange: percent(entry?.bid, price?.bid),
    };
}

/**
 * Bring a watchlist read from storage back to a usable shape.
 *
 * Earlier versions kept it as a keyed object. Reading one of those back as an
 * array would silently drop everything pinned, so the older shape is converted
 * rather than rejected.
 *
 * @param {*} stored - Whatever was in storage
 * @returns {Array<Object>}
 */
export function normaliseWatchlist(stored) {
    if (Array.isArray(stored)) return stored.filter((entry) => entry?.key);
    if (stored && typeof stored === 'object') {
        return Object.entries(stored).map(([key, value]) => ({ key, ...value }));
    }
    return [];
}
