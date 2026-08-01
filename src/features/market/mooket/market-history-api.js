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
 */

import config from '../../../core/config.js';

/** The mooket project's server */
export const HISTORY_HOST = 'https://q7.nainai.eu.org';

/** How long a fetched range is reused before asking again */
const CACHE_TTL_MS = 5 * 60 * 1000;

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
    }

    /** @returns {boolean} Whether history may be fetched at all */
    get enabled() {
        return config.getSetting('market_pooledHistory') === true;
    }

    /**
     * @returns {boolean} Whether observed books may be sent back. The same
     *   switch as reading: taking from a pooled dataset without feeding it is
     *   what empties it.
     */
    get contributing() {
        return this.enabled;
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

        const key = `${itemHrid}:${enhancementLevel}:${days}`;
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.rows;

        const url =
            `${HISTORY_HOST}/api/market/history?item_id=${encodeURIComponent(itemHrid)}` +
            `&variant=${enhancementLevel}&days=${days}`;

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const rows = await response.json();
            this.cache.set(key, { rows, at: Date.now() });
            return rows;
        } catch (error) {
            console.error('[MooketHistory] Fetching history failed:', error);
            return null;
        } finally {
            clearTimeout(timeout);
        }
    }

    /**
     * Open the reporting socket, if contributing is on.
     *
     * It reconnects on its own because the alternative is a session that stops
     * contributing after the first blip and never says so.
     */
    connect() {
        if (!this.contributing || this.socket) return;

        this.closing = false;
        const url = `${HISTORY_HOST.replace(/^http/, 'ws')}/market/ws`;

        try {
            this.socket = new WebSocket(url);
        } catch (error) {
            console.error('[MooketHistory] Opening the reporting socket failed:', error);
            this.socket = null;
            return;
        }

        this.socket.addEventListener('close', () => {
            this.socket = null;
            if (this.closing || !this.contributing) return;
            this.reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
        });
        this.socket.addEventListener('error', () => {
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
    }

    /**
     * Send an order-book payload back to the pool.
     * @param {Object} payload - The market_item_order_books_updated message
     */
    report(payload) {
        if (!this.contributing) return;
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
