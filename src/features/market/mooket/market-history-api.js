/**
 * Market History API
 *
 * Fetches an item's price history from the pooled server the mooket project
 * runs, and — when you let it — contributes what your own client sees back.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * The dataset exists because clients report the order books they open, so
 * reading and contributing are one switch rather than two. A version that let
 * you read without ever giving anything back would work perfectly and quietly
 * drain a shared resource — the history is only as good as what people send,
 * and a reader who contributes nothing is someone else's missing data point.
 *
 * Both directions talk to a third party, which is why the switch starts off and
 * why the setting says plainly what each does: reading tells the server which
 * items you look up, contributing tells it the books you opened and when.
 *
 * ## Never from the test server
 *
 * The test server has its own economy, so a book observed there is not a cheap
 * price, it is a wrong one — and once it is in a pooled dataset there is nothing
 * in it that says where it came from. Contributing is therefore off on the test
 * server whatever the setting says, and the socket that carries it is never
 * opened. Reading still works, because a test-server session asking for live
 * history gets live history.
 */

import config from '../../../core/config.js';
import { isTestServer, isPooledDatasetSite } from '../../../utils/game-server.js';

/**
 * The mooket II server (Q7). This is also the pool this client *contributes* to —
 * the order books it uploads always go here, whichever source is being read,
 * because it is the pool Toolasha was built around and the one whose format the
 * reporting socket speaks.
 */
export const HISTORY_HOST = 'https://q7.nainai.eu.org';

/**
 * Where an item's history can be read from. Two community pools, on different
 * servers, in different shapes:
 *
 * - **mooket II (Q7)** returns rows of `{a, b, p, v}` — ask, bid, an average
 *   *transacted* price, and volume. The full picture, and the default.
 * - **mooket I (IOMisaka)** returns only ask and bid series. It carries no
 *   volume, and no transacted average — so its third line is a computed midpoint
 *   of the quotes (labelled "Mid", not "Avg", because it is not evidence of what
 *   anything sold for), and it can bound no liquidity. Its strength is a live
 *   current price, which the freshest sighting of a one-day pull stands in for.
 *
 * Both are normalised to the same `{a, b, p, v, time}` row so everything
 * downstream — the chart, the My Listings refresh, the goal planner — reads one
 * shape and only has to branch on `hasVolume` / `avgLabel` for presentation.
 */
export const SOURCES = {
    mooket2: {
        key: 'mooket2',
        label: 'mooket II (Q7)',
        host: HISTORY_HOST,
        hasVolume: true,
        avgLabel: 'Avg',
    },
    mooket1: {
        key: 'mooket1',
        label: 'mooket I (IOMisaka)',
        host: 'https://mooket.qi-e.top',
        hasVolume: false,
        avgLabel: 'Mid',
    },
};

/** The source assumed when the setting is unset or unrecognised */
export const DEFAULT_SOURCE_KEY = 'mooket2';

/**
 * Fold mooket I's two quote series into the common row shape.
 *
 * The server answers `{ask|asks: [{time, price}], bid|bids: [{time, price}]}`,
 * with the two arrays index-aligned. A non-positive price means that side of the
 * book was empty at that moment, which is `-1` here rather than a price of zero;
 * a moment with neither side quoted carries no information and is dropped. The
 * "average" slot is filled with the midpoint of whatever sides were quoted —
 * mooket I has no transacted price, and the chart draws this as "Mid". Volume is
 * `0` because the server does not report it (and `0` reads correctly everywhere
 * as "no volume known", not "no trades").
 *
 * Pure: server payload in, rows out.
 *
 * @param {Object} data - The mooket I history payload
 * @returns {Array<{a: number, b: number, p: number, v: number, time: number}>}
 */
export function normaliseMooket1Rows(data) {
    const asks = data?.ask || data?.asks || [];
    const bids = data?.bid || data?.bids || [];
    const count = Math.min(asks.length, bids.length);

    const rows = [];
    for (let i = 0; i < count; i += 1) {
        const a = asks[i]?.price > 0 ? asks[i].price : -1;
        const b = bids[i]?.price > 0 ? bids[i].price : -1;
        if (a < 0 && b < 0) continue;

        let p = -1;
        if (a > 0 && b > 0) p = (a + b) / 2;
        else if (a > 0) p = a;
        else if (b > 0) p = b;

        const time = asks[i]?.time ?? bids[i]?.time;
        if (typeof time !== 'number') continue;
        rows.push({ a, b, p, v: 0, time });
    }
    return rows;
}

/** How long a fetched range is reused before asking again */
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * How many item/range answers are held at once.
 *
 * The cache is keyed by source, item, enhancement level and range, so browsing
 * a marketplace session's worth of items at several ranges makes hundreds of
 * entries, each holding every row of its range — and nothing ever took them out
 * again. Expired entries are dropped on every write; this cap is what bounds a
 * session that keeps every entry inside its five minutes.
 */
const CACHE_MAX_ENTRIES = 200;

/** A request that has not answered by now is not going to */
const REQUEST_TIMEOUT_MS = 10_000;

/** How long to wait before reconnecting the reporting socket */
const RECONNECT_DELAY_MS = 30_000;

/**
 * Consecutive fetch failures, module-wide, before the shared cool-down engages.
 *
 * The 429 this pool actually sends back arrives with no CORS headers, so the
 * browser turns it into an opaque `TypeError` on the `fetch()` promise — the
 * real HTTP status never reaches this code, and nothing here can tell "the
 * pool is rate-limiting us" apart from "the network hiccuped" or "the pool is
 * down". Rather than guess at a status that cannot be read, a burst of
 * failures is treated as the signal instead of a single one: a rate-limited
 * sweep fails every request it sends within milliseconds of the last (see
 * `VOLUME_CONCURRENCY` in `market-liquidity.js`), which an ordinary one-off
 * drop does not. Two in a row, counted across every caller rather than per
 * item, catches that burst on its second request while still letting a lone
 * blip pass without punishing every other lookup in the app for it.
 */
const FAILURE_THRESHOLD = 2;

/**
 * The cool-down's first length, and how long it is allowed to grow to.
 *
 * Doubling on every cool-down that is immediately followed by more refusals,
 * capped at ten minutes: this is a community-run server, not infrastructure
 * we control, so the bias is toward asking it less rather than retrying on a
 * fixed clock that would hit it just as hard on day two of an outage as on
 * the first failure. Thirty seconds is short enough that a brief 429 window
 * clears before a player notices the volume figures are stale; ten minutes is
 * a ceiling because an unbounded back-off is its own kind of neglect — a
 * session left open overnight should still recover once the pool is healthy
 * again, not silently give up on it.
 */
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 10 * 60 * 1000;

/**
 * How close together two failures have to be to count as the same burst.
 *
 * {@link FAILURE_THRESHOLD}'s reasoning is about a *burst* — "a rate-limited
 * sweep fails every request it sends within milliseconds of the last, which
 * an ordinary one-off drop does not" — but a bare counter cannot tell the
 * difference, and without a window it does not try: one dropped request while
 * a chart loads at 10:00 and an unrelated one at 15:00 are "two in a row" as
 * far as counting goes, and the second would open a cool-down on the strength
 * of a failure five hours stale. A failure older than this restarts the count
 * at one instead of adding to it.
 */
const FAILURE_WINDOW_MS = COOLDOWN_BASE_MS;

/**
 * The least time between two requests sent to the same pool: five a second.
 *
 * The cool-down above reacts to a refusal after the fact; this is what keeps a
 * sweep from earning one. Callers bound how many requests are *in flight*
 * (`VOLUME_CONCURRENCY` in `market-liquidity.js`), but a bound on concurrency is
 * not a bound on rate: when answers come back quickly, four workers refill their
 * slots as fast as the answers arrive. Adding one Goal Planner goal measured
 * about 168 requests in about five seconds against the test server, three of them
 * failed, and the second failure tripped the thirty-second back-off.
 *
 * **This number is a guess.** The pool's real limit is unknown (its 429s carry no
 * CORS headers, so the status never reaches this code); five a second was chosen
 * only because it clears the measured burst (about 34 requests a second) by a
 * wide margin. Raise it if the pool is shown to tolerate more, lower it if it
 * still refuses.
 *
 * The pace is per pool, like the back-off: the two sources are different hosts,
 * and one host's limit says nothing about the other's. Only a request that
 * actually goes to the network takes a turn; a cached answer or a cool-down
 * answer returns at once, and a lone request after a quiet spell is not delayed.
 */
export const REQUEST_PACE_MS = 200;

/**
 * The Web Lock every tab takes a turn on before sending to a pool (the source key is appended).
 *
 * {@link REQUEST_PACE_MS} spaces one tab's sends, but each tab kept its own clock, so N tabs sweeping at
 * once sent N times the intended rate to the one shared pool. A Web Lock is the one primitive the browser
 * shares between tabs of the origin and hands out in the order asked, so holding it for the pace interval
 * after a send spaces every tab's sends from one queue. A lock dies with its tab, so a closed tab cannot
 * wedge the others.
 */
export const PACE_LOCK_PREFIX = 'toolasha-market-history-pace:';

/**
 * The longest a request waits for its turn behind other tabs before sending anyway.
 *
 * A hidden tab's timers are throttled by the browser, so a turn it holds can outlast the interval by a long
 * way. The wait is bounded so a slow holder can only make the pace looser for a moment, never stop a lookup
 * (the same call the cross-tab price refresh lock makes).
 */
export const PACE_LOCK_MAX_WAIT_MS = 3000;

class MarketHistoryAPI {
    constructor() {
        this.cache = new Map();
        this.socket = null;
        this.reconnectTimer = null;
        this.closing = false;
        /** Which pool the open socket is contributing to, so a source switch can redirect it */
        this.socketSourceKey = null;
        /** Said once. The getter is read on every book, and on every reconnect. */
        this.notedTestServer = false;
        /** Failures since the last success or the last cool-down, shared by every caller */
        this.consecutiveFailures = 0;
        /** `Date.now()` timestamp the shared cool-down lifts, or 0 when not cooling */
        this.cooldownUntil = 0;
        /** How many cool-downs in a row have been triggered with no success between them */
        this.cooldownStreak = 0;
        /** `Date.now()` of the most recent failure, so a stale one cannot pair with a fresh one */
        this.lastFailureAt = 0;
        /**
         * Which source the three counters above describe. They are a verdict
         * on one host's health, and the two sources are different hosts run by
         * different people — mooket II refusing us says nothing about mooket I.
         * Switching the source setting is, among other things, exactly what a
         * player does when one pool is unhealthy, and carrying a ten-minute
         * cool-down across that switch would answer `null` for the whole
         * window from a server that was never asked.
         */
        this.backoffSourceKey = null;
        /** Spacing between sends to one pool; see {@link REQUEST_PACE_MS} */
        this.paceIntervalMs = REQUEST_PACE_MS;
        /** Source key to the `Date.now()` timestamp the next request to that pool may be sent */
        this.paceNextAt = new Map();
        /** Requests waiting for their turn, so a cool-down can end the wait at once */
        this.paceWaiters = new Set();
    }

    /** @returns {boolean} Whether history may be fetched at all */
    get enabled() {
        return config.getSetting('market_pooledHistory') === true;
    }

    /**
     * The source history is currently read from.
     *
     * Read fresh each call rather than cached, so changing the setting takes
     * effect on the next lookup without a reload. Falls back to the default when
     * the setting is unset or names a source that no longer exists.
     *
     * @returns {{key: string, label: string, host: string, hasVolume: boolean, avgLabel: string}}
     */
    currentSource() {
        return SOURCES[config.getSetting('market_historySource')] || SOURCES[DEFAULT_SOURCE_KEY];
    }

    /**
     * @returns {boolean} Whether observed books may be sent back. The same
     *   switch as reading — taking from a pooled dataset without feeding it is
     *   what empties it — except on the test server, where the honest
     *   contribution is none.
     */
    get contributing() {
        if (!this.enabled) return false;

        if (isTestServer()) {
            if (!this.notedTestServer) {
                this.notedTestServer = true;
                console.log('[Mooket] test server — not sending data');
            }
            return false;
        }

        // The pooled dataset is keyed to the www.milkywayidle.com market. Whether
        // the CN mirror shares those order books is unconfirmed, so CN reads
        // work but CN sessions never upload.
        return isPooledDatasetSite();
    }

    /**
     * One item's history over a range of days.
     *
     * @param {string} itemHrid - Item
     * @param {number} enhancementLevel - Enhancement level
     * @param {number} days - How far back
     * @param {Object} [options]
     * @param {boolean} [options.force] - Skip the cached answer and ask the pool
     *   again, e.g. a player-pressed refresh. The fresh answer still overwrites
     *   the cache entry on success, so the *next* ordinary call benefits from it.
     * @param {string} [options.slotFor] - Internal: the source this call already waited its
     *   turn for, set when a paced call comes back through the checks after waiting
     * @returns {Promise<Array<Object>|null>} Rows, or null when unavailable
     */
    async fetchHistory(itemHrid, enhancementLevel, days, { force = false, slotFor = null } = {}) {
        if (!this.enabled || !itemHrid) return null;

        const source = this.currentSource();
        // The source is part of the key: the same item at the same range is a
        // different answer from a different pool, and switching sources must not
        // read the other one's cached rows.
        const key = `${source.key}:${itemHrid}:${enhancementLevel}:${days}`;
        if (!force) {
            const cached = this.cache.get(key);
            if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;
        }

        // A different pool than the one the back-off state is about is a
        // different server's health; it starts clean rather than serving the
        // other one's sentence.
        if (this.backoffSourceKey !== source.key) this.resetBackoff(source.key);

        // The pool refused us recently enough that we are still waiting it out.
        // No request goes out, and this reads exactly like any other unanswered
        // lookup to every caller: `dailyVolume` already settles a null answer as
        // "unknown" rather than "zero traded", which is the correct thing for a
        // cool-down to mean too.
        if (Date.now() < this.cooldownUntil) return null;

        // Pace: a request that is going to the network takes a turn, so a sweep
        // is spread out instead of landing as one burst (see REQUEST_PACE_MS).
        // After the wait everything above is decided again from scratch (the
        // setting, the source, the cache, which a twin queued ahead of this one
        // may have filled, and the cool-down, which may have begun while this
        // waited) because none of it is what it was when the turn was taken.
        // Nothing has been sent at this point, and the timeout below starts
        // only once the request really is.
        if (slotFor !== source.key) {
            const waitMs = this.claimSlot(source.key);
            if (waitMs > 0) {
                await this.waitForSlot(source.key, waitMs);
                return this.fetchHistory(itemHrid, enhancementLevel, days, { force, slotFor: source.key });
            }
        }

        // Cross-tab pace: this tab's own spacing is settled; take the shared turn so the other open tabs' sends
        // and this one's come from one queue (see PACE_LOCK_PREFIX). Everything decided above is decided again
        // after the wait, because other tabs' turns can take a while and none of it is what it was.
        let endTurn = () => {};
        const turn = this.takeSendTurn(source.key);
        if (turn) {
            endTurn = await turn;
            if (!this.enabled || this.currentSource().key !== source.key) {
                endTurn();
                return this.fetchHistory(itemHrid, enhancementLevel, days, { force, slotFor: source.key });
            }
            if (Date.now() < this.cooldownUntil) {
                endTurn();
                return null;
            }
            if (!force) {
                const cached = this.cache.get(key);
                if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
                    endTurn();
                    return cached.rows;
                }
            }
        }

        const url =
            source.key === 'mooket1'
                ? `${source.host}/market/item/history?name=${encodeURIComponent(itemHrid)}` +
                  `&level=${enhancementLevel}&time=${days * 86400}`
                : `${source.host}/api/market/history?item_id=${encodeURIComponent(itemHrid)}` +
                  `&variant=${enhancementLevel}&days=${days}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const request = fetch(url, { signal: controller.signal });
            // Sent: the turn is held for the pace interval from here, not until the answer
            endTurn();
            const response = await request;
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const payload = await response.json();
            // mooket II already speaks the common row shape; mooket I is folded into it
            const rows = source.key === 'mooket1' ? normaliseMooket1Rows(payload) : payload;
            // A 200 carrying something that is not rows — an error object, a
            // wrapper, a changed shape — is no answer. Returning it let every
            // reader's own `Array.isArray` guard turn it into an empty chart
            // with nothing said, and caching it made the next five minutes of
            // retries return the same non-answer without asking the server.
            if (!Array.isArray(rows)) throw new Error('history payload is not an array of rows');
            this.remember(key, rows);
            // A working request is the only evidence the pool is healthy again;
            // both counters exist to be cleared by exactly this.
            this.consecutiveFailures = 0;
            this.cooldownStreak = 0;
            return rows;
        } catch (error) {
            this.noteFailure(error);
            return null;
        } finally {
            clearTimeout(timeout);
            endTurn();
        }
    }

    /**
     * Take the shared turn to send to one pool, across every open tab.
     *
     * Resolves, once it is this request's turn, with `endTurn`: call it when the request has been sent and the
     * turn is held for one pace interval from then (calling it again does nothing). When the turn does not come
     * within {@link PACE_LOCK_MAX_WAIT_MS} it resolves with a no-op and the request goes out on this tab's own
     * pace alone, as it did before the tabs shared one. With no Web Locks there is nothing to wait for and it
     * returns null, so the caller does not even yield.
     *
     * @param {string} sourceKey - The pool
     * @returns {Promise<Function>|null} `endTurn`, or null without Web Locks
     */
    takeSendTurn(sourceKey) {
        const locks = typeof navigator !== 'undefined' ? navigator.locks : null;
        if (typeof locks?.request !== 'function') return null;

        return new Promise((resolve) => {
            const controller = new AbortController();
            const waitTimer = setTimeout(() => controller.abort(), PACE_LOCK_MAX_WAIT_MS);
            let hold = () => {};
            const held = new Promise((release) => {
                hold = release;
            });
            let ended = false;
            const endTurn = () => {
                if (ended) return;
                ended = true;
                if (this.paceIntervalMs > 0) setTimeout(hold, this.paceIntervalMs);
                else hold();
            };
            const taken = locks.request(`${PACE_LOCK_PREFIX}${sourceKey}`, { signal: controller.signal }, () => {
                clearTimeout(waitTimer);
                resolve(endTurn);
                return held;
            });
            // An aborted wait (or a lock that cannot be had) is not a failure of the lookup
            Promise.resolve(taken).catch(() => {
                clearTimeout(waitTimer);
                resolve(() => {});
            });
        });
    }

    /**
     * Take the next turn to send to one pool.
     *
     * @param {string} sourceKey - The pool
     * @returns {number} Milliseconds to wait before sending; 0 when the pool has been quiet
     */
    claimSlot(sourceKey) {
        const now = Date.now();
        const at = Math.max(now, this.paceNextAt.get(sourceKey) ?? 0);
        this.paceNextAt.set(sourceKey, at + this.paceIntervalMs);
        return at - now;
    }

    /**
     * Wait for a turn. Resolves when the time comes or when {@link releasePaceWaiters}
     * ends the wait early; either way the caller re-checks before sending.
     *
     * @param {string} sourceKey - The pool the turn is for
     * @param {number} ms - How long
     * @returns {Promise<void>}
     */
    waitForSlot(sourceKey, ms) {
        return new Promise((resolve) => {
            const waiter = { sourceKey, timer: null, wake: null };
            waiter.wake = () => {
                clearTimeout(waiter.timer);
                this.paceWaiters.delete(waiter);
                resolve();
            };
            waiter.timer = setTimeout(waiter.wake, ms);
            this.paceWaiters.add(waiter);
        });
    }

    /**
     * End every pending wait for one pool and forget its reserved turns. Called when a
     * cool-down begins: the waiting requests wake, find the cool-down, and answer
     * `null` without a request going out and without a timer left running.
     *
     * @param {string|null} sourceKey - The pool
     * @returns {void}
     */
    releasePaceWaiters(sourceKey) {
        for (const waiter of [...this.paceWaiters]) {
            if (waiter.sourceKey === sourceKey) waiter.wake();
        }
        this.paceNextAt.delete(sourceKey);
    }

    /**
     * Count a failed request toward the shared cool-down, and engage it once
     * {@link FAILURE_THRESHOLD} is reached.
     *
     * Concurrent lookups (`VOLUME_CONCURRENCY` in `market-liquidity.js`) can all
     * be in flight when the pool starts refusing, so more than one failure can
     * land here before the first one has had a chance to set `cooldownUntil`.
     * Once it is set, later failures in the same burst are echoes of the burst
     * that already tripped it, not new evidence — they are swallowed rather
     * than restarting the doubling or logging again, which is what would turn
     * one bad run into a wall of "backing off" lines instead of one.
     *
     * @param {Error} error - What the failed request threw
     * @returns {void}
     */
    noteFailure(error) {
        const now = Date.now();
        if (now < this.cooldownUntil) return;

        // Only failures inside the same burst add up — see FAILURE_WINDOW_MS
        if (this.lastFailureAt && now - this.lastFailureAt > FAILURE_WINDOW_MS) this.consecutiveFailures = 0;
        this.lastFailureAt = now;

        this.consecutiveFailures += 1;
        if (this.consecutiveFailures < FAILURE_THRESHOLD) {
            console.error('[MooketHistory] Fetching history failed:', error);
            return;
        }

        this.cooldownStreak += 1;
        const cooldownMs = Math.min(COOLDOWN_BASE_MS * 2 ** (this.cooldownStreak - 1), COOLDOWN_MAX_MS);
        this.cooldownUntil = now + cooldownMs;
        this.consecutiveFailures = 0;
        this.releasePaceWaiters(this.backoffSourceKey);

        console.error(
            `[MooketHistory] The pool is refusing history requests — backing off for ${Math.round(cooldownMs / 1000)}s.`
        );
    }

    /**
     * How long the shared cool-down has left for one source, for a caller that
     * got `null` back from {@link fetchHistory} and needs to say why rather than
     * draw an empty result and leave it unexplained.
     *
     * `fetchHistory` answers `null` for several reasons — the setting is off, no
     * item was given, a lone request failed without tripping the cool-down, or
     * the cool-down is active — and this is what tells the last one apart from
     * the rest: a positive number means the pool is being waited out and roughly
     * how long is left; zero means whatever the `null` was, it was not that.
     *
     * @param {string} [sourceKey] - Which source's back-off to ask about, e.g.
     *   `marketHistoryAPI.currentSource().key`. Defaults to the current source,
     *   so a caller that forgets the argument asks about the pool actually in
     *   use instead of silently comparing against nothing and reading as
     *   healthy during an active cool-down.
     * @returns {number} Milliseconds remaining, or 0 when that source is not cooling down
     */
    cooldownRemainingMs(sourceKey = this.currentSource().key) {
        if (this.backoffSourceKey !== sourceKey) return 0;
        return Math.max(0, this.cooldownUntil - Date.now());
    }

    /**
     * Forget everything known about one pool's health, and start tracking the
     * named one instead. Called when the read source changes under us.
     *
     * @param {string|null} sourceKey - The source the counters now describe
     * @returns {void}
     */
    resetBackoff(sourceKey) {
        this.consecutiveFailures = 0;
        this.cooldownUntil = 0;
        this.cooldownStreak = 0;
        this.lastFailureAt = 0;
        this.backoffSourceKey = sourceKey;
    }

    /**
     * Hold one answer, dropping what has expired and the oldest of what has not.
     *
     * A `Map` keeps insertion order, so the first key is the least recently
     * stored — good enough for a cache whose entries all expire in five minutes
     * anyway, and cheaper than tracking reads.
     *
     * @param {string} key - Cache key
     * @param {Array<Object>} rows - The rows to hold
     * @returns {void}
     */
    remember(key, rows) {
        const now = Date.now();
        for (const [held, entry] of this.cache) {
            if (now - entry.at >= CACHE_TTL_MS) this.cache.delete(held);
        }
        this.cache.set(key, { rows, at: now });
        while (this.cache.size > CACHE_MAX_ENTRIES) {
            const oldest = this.cache.keys().next();
            if (oldest.done) break;
            this.cache.delete(oldest.value);
        }
    }

    /**
     * Open the reporting socket to the selected pool, if contributing is on.
     *
     * You feed the pool you read: the socket goes to whichever source is
     * selected, so switching source moves your contributions with it. Both pools
     * accept the same `market_item_order_books_updated` message on the same
     * `/market/ws` path, so only the host differs.
     *
     * It reconnects on its own because the alternative is a session that stops
     * contributing after the first blip and never says so.
     */
    connect() {
        if (!this.contributing || this.socket) return;

        this.closing = false;
        const source = this.currentSource();
        this.socketSourceKey = source.key;
        const url = `${source.host.replace(/^http/, 'ws')}/market/ws`;

        let socket;
        try {
            socket = new WebSocket(url);
        } catch (error) {
            console.error('[MooketHistory] Opening the reporting socket failed:', error);
            this.socket = null;
            return;
        }
        this.socket = socket;

        socket.addEventListener('close', () => {
            // A socket superseded by a reconnect (e.g. a source switch) must not
            // null out the one that replaced it
            if (this.socket !== socket) return;
            this.socket = null;
            if (this.closing || !this.contributing) return;
            this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
        });
        socket.addEventListener('error', () => {
            // 'close' follows and handles the reconnect; logging both would
            // just double the noise on a server that is simply down
        });
    }

    disconnect() {
        this.closing = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.socket?.close();
        this.socket = null;
        this.socketSourceKey = null;
    }

    /**
     * Send an order-book payload back to the pool.
     * @param {Object} payload - The market_item_order_books_updated message
     */
    report(payload) {
        if (!this.contributing) return;

        // A socket still open to the pool that was selected a moment ago is closed
        // and reopened to the one selected now, so contributions follow the source
        if (this.socket && this.socketSourceKey !== this.currentSource().key) {
            this.disconnect();
        }

        if (!this.socket) {
            this.connect();
            return;
        }
        if (this.socket.readyState !== WebSocket.OPEN) return;

        try {
            this.socket.send(JSON.stringify({ ...payload, time: Math.floor(Date.now() / 1000) }));
        } catch (error) {
            console.error('[MooketHistory] Reporting an order book failed:', error);
        }
    }
}

const marketHistoryAPI = new MarketHistoryAPI();
export default marketHistoryAPI;
