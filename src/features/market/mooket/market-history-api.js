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
import { isTestServer } from '../../../utils/game-server.js';

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

        return true;
    }

    /**
     * One item's history over a range of days.
     *
     * @param {string} itemHrid - Item
     * @param {number} enhancementLevel - Enhancement level
     * @param {number} days - How far back
     * @returns {Promise<Array<Object>|null>} Rows, or null when unavailable
     */
    async fetchHistory(itemHrid, enhancementLevel, days) {
        if (!this.enabled || !itemHrid) return null;

        const source = this.currentSource();
        // The source is part of the key: the same item at the same range is a
        // different answer from a different pool, and switching sources must not
        // read the other one's cached rows.
        const key = `${source.key}:${itemHrid}:${enhancementLevel}:${days}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;

        const url =
            source.key === 'mooket1'
                ? `${source.host}/market/item/history?name=${encodeURIComponent(itemHrid)}` +
                  `&level=${enhancementLevel}&time=${days * 86400}`
                : `${source.host}/api/market/history?item_id=${encodeURIComponent(itemHrid)}` +
                  `&variant=${enhancementLevel}&days=${days}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, { signal: controller.signal });
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
            return rows;
        } catch (error) {
            console.error('[MooketHistory] Fetching history failed:', error);
            return null;
        } finally {
            clearTimeout(timeout);
        }
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
