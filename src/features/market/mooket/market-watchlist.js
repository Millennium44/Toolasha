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
 * The target's life is recorded alongside it when the caller supplies a clock
 * and the price at that moment: set-at with the price then, and cleared-unreached
 * when a target is dropped without ever having fired. Both are additive — a
 * caller that passes no context stores nothing, and every pin written before this
 * existed reads back unchanged.
 *
 * @param {Array<Object>} watchlist - Current entries
 * @param {string} key - itemHrid:enhancementLevel
 * @param {Object|null} target - `{side, price}`, or null to clear
 * @param {Object} [context] - `{at, price}` — when this happened and the reading then
 * @returns {Array<Object>} A new list
 */
export function setWatchedTarget(watchlist, key, target, { at = null, price = null } = {}) {
    const wanted = normaliseTarget(target);

    return (watchlist || []).map((entry) => {
        if (entry?.key !== key) return entry;
        const had = normaliseTarget(entry.target);

        if (!wanted) {
            const { target: _cleared, ...rest } = entry;
            // A target that is being cleared having never fired is the one
            // outcome nothing else records — the pin simply stops having a
            // target, and "I gave up on that price" is exactly as informative
            // about the price as "it came to me" is
            if (!had || !at) return rest;
            return noteTargetEvent(rest, {
                kind: 'cleared',
                at,
                side: had.side,
                price: sidePrice(price, had.side),
                unreached: !targetReachedSinceSet(entry),
            });
        }

        const next = { ...entry, target: wanted };
        // Re-setting the identical target is not a new intention and does not
        // start a new life; changing either half is
        if (!at || (had && had.side === wanted.side && had.price === wanted.price)) return next;
        return noteTargetEvent(next, { kind: 'set', at, side: wanted.side, price: sidePrice(price, wanted.side) });
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

/**
 * How many events one pin's target history keeps.
 *
 * A ring, oldest dropped, and small on purpose. The value of this record is
 * entirely in the last handful of targets — "the last few times I named a
 * price, was naming it a good idea" — and a pin somebody retargets weekly for a
 * year must not quietly grow into a kilobyte of watchlist that has to be read,
 * written and synced on every edit. Twelve events is three or four complete
 * target lives, which is as far back as an aftermath reading is worth pooling
 * anyway: a price target set eight months ago was set about a different market.
 */
export const TARGET_LIFE_MAX = 12;

/** The three things that can happen to a target, in the order they can happen */
export const TARGET_EVENTS = ['set', 'reached', 'cleared'];

/**
 * The price a reading carries on one side.
 * @param {Object|null} price - A reading carrying `ask` and `bid`
 * @param {'ask'|'bid'} side - Which side
 * @returns {number|null} The price, or null when that side was empty
 */
function sidePrice(price, side) {
    const value = side === 'bid' ? price?.bid : price?.ask;
    return Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The median of a list of numbers.
 *
 * Local rather than imported from `market-history-data.js`, which pulls the
 * history API client in with it — this module is pure state-in/state-out and is
 * imported by the notification path, which must not acquire a transitive
 * dependency on a third-party HTTP client to compare two numbers.
 *
 * @param {number[]} values - At least one
 * @returns {number}
 */
function medianOf(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * Add one event to a pin's target history.
 *
 * Additive in the storage sense: an entry that has never had an event has no
 * `life` field at all, so every pin stored before this existed reads back
 * exactly as it did, and a pin that has one carries a plain array of small
 * objects that older code ignores.
 *
 * The price is recorded as "the price then" on whichever side the target
 * watches, because that is the only side the target was ever a claim about. A
 * side the market was not quoting stores null rather than zero — the same
 * distinction `targetMet` draws — so an aftermath reading can tell "the book was
 * empty" from "it was free".
 *
 * @param {Object} entry - A watchlist entry
 * @param {Object} event - `{kind, at, price, side}`; `kind` must be in {@link TARGET_EVENTS}
 * @param {number} [max] - Ring size, injectable for tests
 * @returns {Object} A new entry, unchanged when the event is unusable
 */
export function noteTargetEvent(entry, event, max = TARGET_LIFE_MAX) {
    if (!entry) return entry;
    const kind = event?.kind;
    if (!TARGET_EVENTS.includes(kind)) return entry;

    const at = Number(event?.at);
    if (!Number.isFinite(at) || at <= 0) return entry;

    const price = Number(event?.price);
    const record = { kind, at, price: Number.isFinite(price) && price > 0 ? price : null };
    if (event?.side === 'ask' || event?.side === 'bid') record.side = event.side;
    // Only ever set on a clear, and only when true: a cleared target that had
    // fired is already described by the `reached` event sitting before it, and
    // storing `unreached: false` beside it would be the same fact twice
    if (kind === 'cleared' && event?.unreached === true) record.unreached = true;

    const life = [...(Array.isArray(entry.life) ? entry.life : []), record];
    const bound = Math.max(1, Math.floor(max) || 1);
    return { ...entry, life: life.length > bound ? life.slice(life.length - bound) : life };
}

/**
 * Whether the newest target on a pin has been reached since it was set.
 *
 * Read backwards from the end of the ring: the first `set` found ends the
 * search, and a `reached` seen before it belongs to the target now in force.
 * A ring that has dropped its oldest events therefore answers "not reached"
 * where it cannot tell, which is the safe direction — it under-claims rather
 * than crediting the current target with a reach that belonged to an older one.
 *
 * @param {Object|null} entry - A watchlist entry
 * @returns {boolean}
 */
export function targetReachedSinceSet(entry) {
    const life = Array.isArray(entry?.life) ? entry.life : [];
    for (let i = life.length - 1; i >= 0; i--) {
        if (life[i]?.kind === 'set') return false;
        if (life[i]?.kind === 'reached') return true;
    }
    return false;
}

/**
 * Record that a pin's target was reached, at a dated price.
 *
 * Only ever called from the alert path, which fires on a pooled sighting
 * carrying the time it was actually seen. The panel's own chip also knows when
 * a target is met, against its cached price — and that reading is deliberately
 * not recorded, because a chip is allowed to be approximate about *when* and an
 * aftermath measured from an approximate moment is not a measurement.
 *
 * @param {Array<Object>} watchlist - Current entries
 * @param {string} key - itemHrid:enhancementLevel
 * @param {Object} sighting - `{at, price}` — the sighting that reached it
 * @returns {Array<Object>} A new list, unchanged when there is nothing to record
 */
export function noteTargetReached(watchlist, key, { at, price } = {}) {
    const list = watchlist || [];
    const entry = list.find((watched) => watched?.key === key);
    const target = normaliseTarget(entry?.target);
    if (!entry || !target) return list;
    // One reach per arming. The armed bit upstream already guarantees this, but
    // the ring is storage: a duplicate event would double-count in the pool
    if (targetReachedSinceSet(entry)) return list;

    const noted = noteTargetEvent(entry, {
        kind: 'reached',
        at,
        side: target.side,
        price: sidePrice(price, target.side),
    });
    if (noted === entry) return list;
    return list.map((watched) => (watched === entry ? noted : watched));
}

/**
 * How long after a reach an aftermath reading is taken.
 *
 * A day and three days: the first asks "did it keep going for the rest of the
 * session", the second "was that actually the bottom of the move". Longer
 * windows stop being about the target at all.
 */
export const AFTERMATH_HOURS = [24, 72];

/**
 * How far from the nominal moment a sighting may sit and still be read as that
 * moment's price.
 *
 * The pooled dataset updates on the community's trading rather than on a clock,
 * so demanding a sighting at exactly +24h would answer "no data" for everything.
 * Six hours either side is close enough that the reading is still about that
 * point in the move, and narrow enough that a week-old quote cannot stand in for
 * it — the same judgement {@link MAX_MOVE_SPAN_MS} makes about a move's span.
 */
export const AFTERMATH_TOLERANCE_MS = 6 * 60 * 60 * 1000;

/**
 * History rows as timestamped sightings, in milliseconds.
 *
 * Rows carry seconds (or a date string); everything here compares against event
 * timestamps, which are milliseconds. A row whose side was empty carries null
 * rather than zero, for the reason `freshestSighting` gives.
 *
 * @param {Array<Object>|null} rows - Rows from the history API
 * @returns {Array<{time: number, ask: number|null, bid: number|null}>} Oldest first
 */
export function sightingsFromRows(rows) {
    if (!Array.isArray(rows)) return [];
    const out = [];
    for (const row of rows) {
        const raw = typeof row?.time === 'number' ? row.time : new Date(row?.time).getTime() / 1000;
        if (!Number.isFinite(raw) || raw <= 0) continue;
        out.push({
            time: raw * 1000,
            ask: row?.a > 0 ? row.a : null,
            bid: row?.b > 0 ? row.b : null,
        });
    }
    return out.sort((a, b) => a.time - b.time);
}

/**
 * The price on one side a given number of hours after a moment, or nothing.
 *
 * "Nothing" is the important half. The pooled dataset has gaps — an item nobody
 * traded for two days simply has no sighting in that stretch — and the obvious
 * thing to do about a gap is to draw a line between the readings either side of
 * it and read off the middle. That would be inventing a price and presenting it
 * as an observation, in a feature whose entire claim is "here is what actually
 * happened next". So a gap returns null and the caller says "no follow-up
 * reading".
 *
 * @param {Array<Object>} sightings - From {@link sightingsFromRows}
 * @param {number} fromMs - The moment to measure from
 * @param {number} hours - How far after
 * @param {'ask'|'bid'} side - Which side to read
 * @param {number} [toleranceMs] - How far off the nominal moment is acceptable
 * @returns {{price: number, at: number, offsetMs: number}|null} Null for a gap
 */
export function aftermathReading(sightings, fromMs, hours, side, toleranceMs = AFTERMATH_TOLERANCE_MS) {
    const target = Number(fromMs) + hours * 60 * 60 * 1000;
    if (!Number.isFinite(target)) return null;

    let best = null;
    for (const sighting of sightings || []) {
        const price = side === 'bid' ? sighting?.bid : sighting?.ask;
        if (!Number.isFinite(price) || !(price > 0)) continue;
        const offset = Math.abs(sighting.time - target);
        if (offset > toleranceMs) continue;
        if (!best || offset < best.offsetMs) best = { price, at: sighting.time, offsetMs: offset };
    }
    return best;
}

/**
 * What happened after each of a pin's target reaches — "when it fired, was that
 * the bottom?"
 *
 * Every reach in the ring is measured against the price recorded at the moment
 * it fired, and the moves are pooled as a median rather than a mean, because one
 * reach that happened to precede a crash would otherwise be the whole answer
 * over three reaches.
 *
 * The sign is left as a raw move rather than being turned into "good" or "bad":
 * whether a price falling further after a buy target fired is bad news depends
 * on whether you bought, and this does not know that.
 *
 * @param {Object|null} entry - A watchlist entry carrying a `life` ring
 * @param {Array<Object>} sightings - From {@link sightingsFromRows}
 * @param {Object} [options] - Overrides
 * @param {Array<number>} [options.hours] - Which windows to read
 * @param {number} [options.toleranceMs] - Passed to {@link aftermathReading}
 * @returns {{reaches: number, windows: Array<{hours: number, readings: number,
 *   gaps: number, medianPercent: number|null}>}} `reaches` is 0 when the pin has
 *   never fired, which is the caller's cue to draw nothing at all
 */
export function targetAftermath(
    entry,
    sightings,
    { hours = AFTERMATH_HOURS, toleranceMs = AFTERMATH_TOLERANCE_MS } = {}
) {
    const life = Array.isArray(entry?.life) ? entry.life : [];
    const reaches = life.filter((event) => event?.kind === 'reached' && event.price > 0);

    const windows = hours.map((window) => {
        const moves = [];
        let gaps = 0;
        for (const reach of reaches) {
            const side = reach.side === 'bid' ? 'bid' : 'ask';
            const later = aftermathReading(sightings, reach.at, window, side, toleranceMs);
            if (!later) {
                gaps += 1;
                continue;
            }
            moves.push(((later.price - reach.price) / reach.price) * 100);
        }
        return {
            hours: window,
            readings: moves.length,
            gaps,
            medianPercent: moves.length ? medianOf(moves) : null,
        };
    });

    return { reaches: reaches.length, windows };
}

/**
 * The aftermath as the line the history panel draws, or nothing.
 *
 * A window whose reaches all fall in sighting gaps says so in words rather than
 * being dropped: "no follow-up reading" is a fact about the pooled data that the
 * reader should see, and an omitted window would read as a window nobody thought
 * to measure.
 *
 * @param {Object} aftermath - From {@link targetAftermath}
 * @returns {string} Empty when the pin has never fired
 */
export function describeAftermath(aftermath) {
    if (!aftermath?.reaches) return '';

    const parts = [];
    for (const window of aftermath.windows) {
        if (window.medianPercent === null) {
            parts.push(`${window.hours}h no follow-up reading`);
            continue;
        }
        const signed = `${window.medianPercent >= 0 ? '+' : '−'}${Math.abs(window.medianPercent).toFixed(1)}%`;
        const missing = window.gaps ? `, ${window.gaps} with no follow-up reading` : '';
        parts.push(`${window.hours}h ${signed} (n=${window.readings}${missing})`);
    }

    const fired = `fired ${aftermath.reaches} time${aftermath.reaches === 1 ? '' : 's'}`;
    return `After the target ${fired}: ${parts.join(' · ')}`;
}
