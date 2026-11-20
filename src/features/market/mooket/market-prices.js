/**
 * Market Prices
 *
 * A price cache that remembers how much was resting at the top of each book,
 * not just what it cost.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * The game's marketplace.json publishes a best ask and a best bid and nothing
 * else — no size. That is enough to say what an item is worth and useless for
 * saying whether you can trade it: a 40k spread with one unit at the ask is a
 * curiosity, the same spread with eight hundred is a trade. The order books the
 * game pushes when you open an item do carry size, so a sighting seen that way
 * is kept with its quantities. Readings are folded newest-wins by timestamp,
 * though: a fresher marketplace.json snapshot (which carries no size) replaces
 * an older order-book reading and resets its sizes to zero, so a stored size
 * lasts only until the next snapshot re-reads that item. Consumers that need
 * depth must treat a zero size as "unknown", not "none listed".
 *
 * Depth lives apart from these entries, in its own device-only record
 * (`mooketDepth`, see market-price-store.js), keyed by {@link priceKey}:
 * `{askLevels, bidLevels, depthAt}`, up to {@link DEPTH_LEVELS} price levels per
 * side (best first, each `{price, quantity}`, quantities of one price summed)
 * and the time of the book they came from. It is not part of the synced price
 * entries, so their shape never changes. A missing record means depth UNKNOWN;
 * an empty array means that side was seen empty. Readers must also check that
 * `levels[0].price` equals the current best ask / bid before trusting it: when
 * it does not, the price has moved since `depthAt`.
 *
 * Pure: entries in, entries out. Storage and sockets live in the feature module.
 */

/** Entries untouched for this long are dropped rather than kept forever */
export const PRICE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The key one price is held under. An enhanced item is a different market from
 * its plain form and never shares a price with it.
 * @param {string} itemHrid - Item
 * @param {number} [enhancementLevel=0] - Enhancement level
 * @returns {string}
 */
export function priceKey(itemHrid, enhancementLevel = 0) {
    return `${itemHrid}:${Math.max(0, Math.floor(Number(enhancementLevel) || 0))}`;
}

/**
 * Read one side of an order book into a price and the size resting at it.
 * @param {Array<Object>} orders - Orders, best first
 * @returns {{price: number, quantity: number}} price is -1 when the side is empty
 */
export function topOfSide(orders) {
    const list = (Array.isArray(orders) ? orders : []).filter(Boolean);
    if (!list.length) return { price: -1, quantity: 0 };

    const price = list[0].price;
    const quantity = list
        .filter((order) => order.price === price)
        .reduce((sum, order) => sum + Math.max(0, Number(order.quantity) || 0), 0);
    return { price, quantity };
}

/**
 * Fold one order book into an entry.
 * @param {Object|null} book - { asks, bids }
 * @param {number} at - Timestamp (ms)
 * @returns {Object} { ask, bid, askQty, bidQty, at }
 */
export function entryFromBook(book, at) {
    const ask = topOfSide(book?.asks);
    const bid = topOfSide(book?.bids);
    return { ask: ask.price, bid: bid.price, askQty: ask.quantity, bidQty: bid.quantity, at };
}

/**
 * Take a newer reading of one item, if it is in fact newer.
 *
 * The percentage move is kept against the reading it replaced, which is what a
 * watchlist chip shows. Measured on ask plus bid rather than either alone: a
 * book whose ask vanishes and returns would otherwise report a move of hundreds
 * of percent with nothing having happened.
 *
 * How long that move took is kept beside it, because a percentage on its own is
 * not a move. The pooled dataset updates on the community's trading activity
 * rather than a clock, so the gap between two readings of a busy item is
 * minutes and the gap between two readings of a quiet one can be days — and
 * "2.1%" means opposite things across those two spans. A reader shown the
 * figure without the span has no way to tell which they are looking at, so the
 * span rides with it and the chip declines to draw a move it cannot date.
 *
 * @param {Object|undefined} existing - What is held now
 * @param {Object} next - The new reading
 * @returns {Object|null} The entry to store, or null when the reading is not newer
 */
export function foldPrice(existing, next) {
    // A clock that has run backwards is more likely wrong than the data, so a
    // stored reading from the future is replaced rather than trusted
    if (existing && existing.at >= next.at && existing.at <= Date.now()) return null;

    let rise = 0;
    // Zero rather than null for a first reading, matching `rise`: there is no
    // move yet, so there is no span for one either
    let riseSpanMs = 0;
    if (existing) {
        // Only sides quoted in BOTH readings count. `-1` is "nobody is on this
        // side", not a price, and summing it in made an emptying book look like
        // a crash: 120/100 followed by -1/100 folded to 89/190, a chip reading
        // "▼53.2%" with the bid untouched. Both sides gone was worse still —
        // -2 as a denominator prints thousands of percent, with a sign flip.
        let before = 0;
        let after = 0;
        for (const side of ['ask', 'bid']) {
            if (existing[side] > 0 && next[side] > 0) {
                before += existing[side];
                after += next[side];
            }
        }
        // No side common to the two readings is no move at all, and so no span:
        // `describeMove` declines to draw a move it cannot date, which is the
        // right outcome for a step that was never measured.
        if (before > 0) {
            rise = after / before - 1;
            riseSpanMs = Math.max(0, next.at - existing.at);
        }
    }

    return { ...next, rise, riseSpanMs };
}

/**
 * Prices the game does not quote but that are known anyway.
 *
 * Coins are worth a coin. A single cowbell is not traded — only bags of ten
 * are — so its price is the bag's, divided, which is the figure any calculation
 * about cowbells actually needs.
 *
 * @param {string} itemHrid - Item
 * @param {Function} lookup - (key) => entry, for prices derived from another item
 * @param {number} at - Timestamp
 * @returns {Object|null}
 */
export function specialPrice(itemHrid, lookup, at) {
    if (itemHrid === '/items/coin') return { ask: 1, bid: 1, askQty: 0, bidQty: 0, rise: 0, at };

    if (itemHrid === '/items/cowbell') {
        const bag = lookup(priceKey('/items/bag_of_10_cowbells'));
        if (!bag) return null;
        return { ...bag, ask: bag.ask / 10, bid: bag.bid / 10 };
    }

    return null;
}

/**
 * Drop entries older than the cutoff.
 * @param {Object} entries - Keyed entries
 * @param {number} cutoff - Timestamp (ms); anything older goes
 * @returns {Object} A new object
 */
export function pruneStale(entries, cutoff) {
    return Object.fromEntries(Object.entries(entries || {}).filter(([, entry]) => entry?.at >= cutoff));
}

/** Price levels kept per side of a book */
export const DEPTH_LEVELS = 5;

/**
 * The first levels of one side, in the order the game sends them (best
 * first), with the quantities of orders at one price summed.
 * @param {Array<Object>} orders - Orders, best first
 * @param {number} [max=DEPTH_LEVELS] - Levels to keep
 * @returns {Array<{price: number, quantity: number}>} Empty for an empty side
 */
export function levelsOfSide(orders, max = DEPTH_LEVELS) {
    const levels = [];
    const seen = new Map();
    for (const order of Array.isArray(orders) ? orders : []) {
        if (!order || !Number.isFinite(order.price)) continue;
        const quantity = Math.max(0, Number(order.quantity) || 0);
        const held = seen.get(order.price);
        if (held) {
            held.quantity += quantity;
        } else if (levels.length < max) {
            const level = { price: order.price, quantity };
            seen.set(order.price, level);
            levels.push(level);
        }
    }
    return levels;
}

/**
 * @param {*} levels - Candidate list of levels
 * @returns {boolean} True when every level has a numeric price and quantity
 */
function validLevels(levels) {
    return (
        Array.isArray(levels) &&
        levels.every((level) => level && Number.isFinite(level.price) && Number.isFinite(level.quantity))
    );
}

/**
 * Whether a depth record is one a reader can use: both sides, a time for it,
 * and that time not in the future (a clock that ran ahead is more likely wrong
 * than the book, as with {@link foldPrice}).
 * @param {Object|null|undefined} record - { askLevels, bidLevels, depthAt }
 * @param {number} now - Current time (ms)
 * @returns {boolean}
 */
export function hasDepth(record, now) {
    return (
        !!record &&
        validLevels(record.askLevels) &&
        validLevels(record.bidLevels) &&
        Number.isFinite(record.depthAt) &&
        record.depthAt <= now
    );
}

/**
 * The depth record of one order book.
 * @param {Object|null} book - { asks, bids }
 * @param {number} at - Timestamp (ms)
 * @returns {{askLevels: Array, bidLevels: Array, depthAt: number}}
 */
export function depthFromBook(book, at) {
    return { askLevels: levelsOfSide(book?.asks), bidLevels: levelsOfSide(book?.bids), depthAt: at };
}

/**
 * Take a depth reading if it is newer than what is held. A held record that is
 * unusable (malformed, or timed in the future) is replaced by any reading.
 * @param {Object|undefined} existing - Held record
 * @param {Object} next - New record
 * @param {number} now - Current time (ms)
 * @returns {Object|null} The record to store, or null when not newer
 */
export function foldDepth(existing, next, now) {
    if (hasDepth(existing, now) && existing.depthAt >= next.depthAt) return null;
    return next;
}

/**
 * Fold a stored depth map under the one in memory: per item the newer depthAt
 * wins (memory on a tie), unusable records go, and anything whose book is older
 * than the cutoff goes. Age is the book's, not the price entry's: a snapshot
 * refreshes the entry's `at` and says nothing new about depth.
 * @param {Object} stored - key -> record, as read back
 * @param {Object} memory - key -> record, as held
 * @param {number} cutoff - Timestamp (ms); a book older than this goes
 * @param {number} now - Current time (ms)
 * @returns {Object} A new object
 */
export function mergeDepth(stored, memory, cutoff, now) {
    const merged = {};
    for (const source of [stored, memory]) {
        if (!source || typeof source !== 'object') continue;
        for (const [key, record] of Object.entries(source)) {
            if (!hasDepth(record, now) || record.depthAt < cutoff) continue;
            const held = merged[key];
            if (!held || record.depthAt >= held.depthAt) merged[key] = record;
        }
    }
    return merged;
}

/** Snapshots kept per item and enhancement level in the depth history */
export const HISTORY_MAX = 12;
/** A book equal to the last snapshot is only added again once it is this much newer (ms) */
export const HISTORY_MIN_GAP_MS = 10 * 60 * 1000;

function sameLevels(a, b) {
    return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Add a depth snapshot to an item's series (oldest first, newest last). Skipped when it is not newer
 * than the last one, or when it shows the same book as the last one and is less than
 * {@link HISTORY_MIN_GAP_MS} newer, so a book the game re-sends seconds apart is stored once.
 * Never mutates the series it is given.
 * @param {Array|undefined} series - Held snapshots
 * @param {Object} snapshot - { askLevels, bidLevels, depthAt }
 * @returns {Array|null} The new series, or null when nothing was added
 */
export function appendDepthSnapshot(series, snapshot) {
    const held = Array.isArray(series) ? series : [];
    const last = held[held.length - 1];
    if (last && snapshot.depthAt <= last.depthAt) return null;
    if (
        last &&
        snapshot.depthAt - last.depthAt < HISTORY_MIN_GAP_MS &&
        sameLevels(last.askLevels, snapshot.askLevels) &&
        sameLevels(last.bidLevels, snapshot.bidLevels)
    ) {
        return null;
    }
    return [...held, snapshot].slice(-HISTORY_MAX);
}

/**
 * Fold a stored depth history under the one in memory: per item the union of both series by depthAt
 * (memory wins an equal depthAt), unusable snapshots and those older than the cutoff go, and only the
 * newest {@link HISTORY_MAX} stay. Neither side loses a snapshot the other lacks unless it is past
 * the cap or the cutoff.
 * @param {Object} stored - key -> snapshots, as read back
 * @param {Object} memory - key -> snapshots, as held
 * @param {number} cutoff - Timestamp (ms); a snapshot older than this goes
 * @param {number} now - Current time (ms)
 * @returns {Object} A new object
 */
export function mergeDepthHistory(stored, memory, cutoff, now) {
    const byKey = {};
    for (const source of [stored, memory]) {
        if (!source || typeof source !== 'object') continue;
        for (const [key, series] of Object.entries(source)) {
            if (!Array.isArray(series)) continue;
            const at = (byKey[key] ||= new Map());
            for (const snap of series) {
                if (!hasDepth(snap, now) || snap.depthAt < cutoff) continue;
                at.set(snap.depthAt, snap);
            }
        }
    }
    const merged = {};
    for (const [key, at] of Object.entries(byKey)) {
        const sorted = [...at.values()].sort((a, b) => a.depthAt - b.depthAt).slice(-HISTORY_MAX);
        if (sorted.length) merged[key] = sorted;
    }
    return merged;
}
