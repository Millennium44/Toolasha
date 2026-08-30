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

import { formatKMB, formatRelativeTime } from '../../../utils/formatters.js';

/**
 * A reading older than this is stale enough to flag visually, not just say so
 * in the tooltip. The pooled dataset updates on the community's own trading
 * activity rather than a fixed clock, so a quiet item can go a while between
 * readings without anything being wrong — ten minutes is long enough that a
 * chip flagged this way is worth a second look before acting on it.
 */
export const STALE_PRICE_MS = 10 * 60 * 1000;

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
export function addWatched(watchlist, key, price, target = null) {
    const list = watchlist || [];
    if (list.some((entry) => entry.key === key)) return list;
    if (list.length >= MAX_WATCHED) return list;

    const entry = { key, ask: price?.ask ?? -1, bid: price?.bid ?? -1, at: price?.at ?? 0 };
    const wanted = normaliseTarget(target);
    if (wanted) entry.target = wanted;
    return [...list, entry];
}

/**
 * The two sides a target can watch, and what reaching one means.
 *
 * An `ask` target is a buyer's: it is reached when somebody is selling at or
 * under the price you named. A `bid` target is a seller's, and is reached when
 * somebody is buying at or above it. Both are "the market came to me", which is
 * why one word for the side is enough to say which comparison applies.
 */
export const TARGET_SIDES = ['ask', 'bid'];

/**
 * A target, or nothing, from whatever was stored or typed.
 *
 * A price that is not a positive number is not a target: zero would be reached
 * by an empty book and a negative one never at all, and both would be a pin
 * quietly carrying a rule nobody could have meant. Rejecting them here is what
 * lets every caller treat "has a target" as a single truthy check.
 *
 * @param {*} raw - A stored target, or a pair typed into the chip's editor
 * @returns {{side: 'ask'|'bid', price: number}|null} The target, or null
 */
export function normaliseTarget(raw) {
    const price = Number(raw?.price);
    if (!Number.isFinite(price) || !(price > 0)) return null;
    return { side: raw?.side === 'bid' ? 'bid' : 'ask', price };
}

/**
 * Set, change or clear one pin's target.
 *
 * A null (or unusable) target removes the field rather than storing an empty
 * one, so a pin that has never had a target and a pin whose target was cleared
 * read identically everywhere downstream — including in the alert, where the
 * absence of a target is what makes a pin silent.
 *
 * @param {Array<Object>} watchlist - Current entries
 * @param {string} key - itemHrid:enhancementLevel
 * @param {Object|null} target - `{side, price}`, or null to clear
 * @returns {Array<Object>} A new list
 */
export function setWatchedTarget(watchlist, key, target) {
    const wanted = normaliseTarget(target);

    return (watchlist || []).map((entry) => {
        if (entry?.key !== key) return entry;
        if (!wanted) {
            const { target: _cleared, ...rest } = entry;
            return rest;
        }
        return { ...entry, target: wanted };
    });
}

/**
 * Whether a price has come to where a target asked it to.
 *
 * Three answers rather than two, and the third is the one that keeps the alert
 * honest: a side the market is not quoting is *unknown*, not "not reached", and
 * treating it as the latter would re-arm a target every time the book emptied.
 * The same distinction `listingBeaten` draws about a missing best price.
 *
 * @param {Object|null} target - The pin's target
 * @param {Object|null} price - A reading carrying `ask` and `bid`
 * @returns {boolean|null} True when reached, false when not, null when unpriced
 */
export function targetMet(target, price) {
    const wanted = normaliseTarget(target);
    if (!wanted) return null;

    const value = wanted.side === 'bid' ? price?.bid : price?.ask;
    if (!Number.isFinite(value) || !(value > 0)) return null;

    return wanted.side === 'bid' ? value >= wanted.price : value <= wanted.price;
}

/**
 * A target in words, for a chip label or a tooltip line.
 *
 * "under" and "over" rather than the operators: the chip is read at a glance
 * beside a price, and `≤ 4.2M ask` invites the reader to work out which way the
 * comparison runs at exactly the moment they do not want to.
 *
 * @param {Object|null} target - The pin's target
 * @returns {string} e.g. `under 4.2M ask`, empty when there is no target
 */
export function describeTarget(target) {
    const wanted = normaliseTarget(target);
    if (!wanted) return '';
    return `${wanted.side === 'bid' ? 'over' : 'under'} ${formatKMB(wanted.price)} ${wanted.side}`;
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
 * How long a move may have taken and still be a move.
 *
 * `foldPrice` measures every stored reading against the one it replaced, and
 * the pooled dataset updates on the community's trading activity rather than on
 * a clock: two readings of a heavily traded item are minutes apart, two readings
 * of something nobody buys can be a week apart. A 2% move over three hours is
 * news; the same 2% over nine days is the market drifting, and drawing the two
 * identically would be the chip's worst possible lie.
 *
 * Six hours, because that is about the longest gap over which the move still
 * describes one market rather than several — a session, a night, a server reset.
 * Beyond it the chip shows nothing at all rather than a number it would have to
 * qualify away, which is the same choice `savingsProgress` makes about an
 * unpriced target: no figure beats a figure that has to be disbelieved.
 */
export const MAX_MOVE_SPAN_MS = 6 * 60 * 60 * 1000;

/**
 * A move smaller than this rounds to "0.0%" at one decimal place, which is a
 * chip saying nothing while taking up room to say it.
 */
export const MIN_MOVE_PERCENT = 0.05;

/**
 * How long a move took, in the fewest characters that still say it.
 *
 * Minutes and hours only: anything a chip will actually draw is inside
 * {@link MAX_MOVE_SPAN_MS}, and a span under a minute reads as `1m` rather than
 * as seconds, because the difference between forty seconds and ninety is not
 * something the chip is claiming to know.
 *
 * @param {number} spanMs - Milliseconds between the two readings
 * @returns {string} e.g. `3h`, `12m`
 */
export function formatMoveSpan(spanMs) {
    const minutes = Math.max(1, Math.round(spanMs / 60000));
    if (minutes < 60) return `${minutes}m`;
    return `${Math.round(minutes / 60)}h`;
}

/**
 * The move chip: how far the last reading moved the price, and over how long.
 *
 * Distinct from {@link watchedChange}, which measures against the price the item
 * was *pinned* at — a baseline the reader chose, and one that only grows more
 * distant. This is the market's own last step, which is what says whether
 * anything is happening right now.
 *
 * Nothing is returned rather than a qualified figure in three cases: a move with
 * no span behind it (a first reading, or an entry stored before spans were
 * kept), a span longer than {@link MAX_MOVE_SPAN_MS}, and a move too small to
 * survive rounding.
 *
 * @param {number|null|undefined} rise - Fractional move, as `foldPrice` stores it
 * @param {number|null|undefined} spanMs - How long it took
 * @param {number} [maxSpanMs] - The sanity bound, injectable for tests
 * @returns {{percent: number, text: string}|null} The chip, or null for no chip
 */
export function describeMove(rise, spanMs, maxSpanMs = MAX_MOVE_SPAN_MS) {
    const percent = Number(rise) * 100;
    if (!Number.isFinite(percent)) return null;
    if (!(spanMs > 0) || spanMs > maxSpanMs) return null;
    if (Math.abs(percent) < MIN_MOVE_PERCENT) return null;

    const arrow = percent > 0 ? '▲' : '▼';
    return { percent, text: `${arrow}${Math.abs(percent).toFixed(1)}% / ${formatMoveSpan(spanMs)}` };
}

/**
 * How stale a chip's reading is, worded for its tooltip.
 *
 * The chip shows the last price the pooled dataset reported, not a live quote,
 * so a reader deciding whether to trust it needs to know when that was — a
 * price with no reading yet says so honestly rather than claiming an age of zero.
 *
 * @param {number|null|undefined} at - When the price was last recorded (ms), or unset
 * @param {number} [now] - Current time (ms), injectable for tests
 * @returns {string} e.g. "Updated 5m ago", "Updated just now", "Updated —"
 */
export function describeUpdateAge(at, now = Date.now()) {
    if (!(at > 0)) return 'Updated —';
    const age = formatRelativeTime(now - at);
    return age === 'Just now' ? 'Updated just now' : `Updated ${age} ago`;
}

/**
 * Whether a chip's reading is old enough to flag visually.
 *
 * A price never read at all (`at` unset) counts as stale too — there is
 * nothing fresher to justify showing it as trustworthy.
 *
 * @param {number|null|undefined} at - When the price was last recorded (ms), or unset
 * @param {number} [now] - Current time (ms), injectable for tests
 * @param {number} [thresholdMs] - How old counts as stale
 * @returns {boolean}
 */
export function isStalePrice(at, now = Date.now(), thresholdMs = STALE_PRICE_MS) {
    if (!(at > 0)) return true;
    return now - at > thresholdMs;
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
