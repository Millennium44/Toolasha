/**
 * Tab Census
 *
 * Request/reply over a `BroadcastChannel`. Every game tab joins the channel and
 * answers a `poll` with a small summary of itself, from the message handler:
 * one listener, no timer, and nothing runs until someone asks. That matters
 * because a hidden tab's timers are throttled to about once a minute, while
 * its message handlers still run on time.
 *
 * Only a tab whose panel is open with the extras on polls, from its own
 * (visible) timer. It lists the tabs that answered either of the last two
 * polls, so a reply that arrives a poll late still counts and a tab that
 * misses two in a row drops out.
 *
 * Nothing here is persisted.
 */

import { createTimerRegistry } from './timer-registry.js';

/** BroadcastChannel name. Toolasha-scoped; nothing else should post on it. */
export const TAB_CENSUS_CHANNEL = 'toolasha-tab-census';

/** How often a polling tab asks. Run from the poller's own (visible) timer. */
export const TAB_CENSUS_POLL_MS = 10000;

/** Wire format version, so a future change can be told from this one. */
const WIRE_VERSION = 1;

/** Peers kept at once; a runaway sender cannot grow the map without bound. */
const MAX_PEERS = 32;

/**
 * A random id for this page load.
 * @returns {string} Short random id
 */
function newTabId() {
    return Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3);
}

/**
 * Whether BroadcastChannel exists here. Absent in old browsers and in tests.
 * @returns {boolean} True when a channel can be opened
 */
export function broadcastChannelSupported() {
    return typeof BroadcastChannel === 'function';
}

/**
 * This tab's summary at this moment. Every field is read now, not cached, so a
 * character switch shows up on the next publish.
 * @param {Object} deps - Sources to read
 * @param {Object|null} deps.dataManager - Gives the current character
 * @param {Object|null} deps.monitor - The performance monitor, for the stall ledger
 * @param {Function} deps.getTraffic - Returns the GM traffic summary
 * @param {Function} [deps.heapBytes] - Returns bytes in use, or null where unreadable
 * @returns {Object} Plain, structured-cloneable summary
 */
export function buildTabSummary({ dataManager, monitor, getTraffic, heapBytes }) {
    let characterId = null;
    let characterName = null;
    try {
        characterId = dataManager?.getCurrentCharacterId?.() ?? null;
        characterName = dataManager?.getCurrentCharacterName?.() ?? null;
    } catch {
        // A character read that throws leaves the tab unnamed rather than unlisted
    }

    // Stalls are only watched while the panel has measuring on, so a tab whose
    // panel is closed reports null rather than a zero that reads like "no stalls"
    let stalls = null;
    try {
        if (monitor?.enabled && typeof monitor.getStallAttribution === 'function') {
            const session = monitor.getStallAttribution(Infinity);
            stalls = {
                count: session.stalls,
                totalMs: Math.round(session.totalMs),
                worstMs: Math.round(monitor.getWorstStallMs?.() || 0),
            };
        }
    } catch {
        stalls = null;
    }

    let heap = null;
    try {
        heap = heapBytes?.() ?? null;
    } catch {
        heap = null;
    }

    return {
        characterId,
        characterName,
        uptimeMs: typeof performance !== 'undefined' ? Math.round(performance.now()) : 0,
        traffic: getTraffic(),
        heapMb: typeof heap === 'number' ? heap / 1048576 : null,
        stalls,
    };
}

/**
 * Join the census channel, answer polls, and optionally poll the others.
 *
 * @param {Object} options - Configuration
 * @param {Function} options.getSummary - Builds this tab's summary on demand
 * @param {number} [options.pollMs] - Poll cadence while polling
 * @param {string} [options.tabId] - Fixed id, for tests
 * @param {Function} [options.createChannel] - `(name) => channel`, for tests
 * @returns {{start: Function, stop: Function, startPolling: Function, stopPolling: Function, pollNow: Function,
 *   getTabs: Function, isRunning: Function, isPolling: Function, tabId: string, supported: boolean}} The census
 */
export function createTabCensus({ getSummary, pollMs = TAB_CENSUS_POLL_MS, tabId = newTabId(), createChannel }) {
    const open = createChannel || (broadcastChannelSupported() ? (name) => new BroadcastChannel(name) : null);
    const supported = open !== null;
    /** @type {Map<string, {summary: Object, round: number}>} */
    const peers = new Map();
    let channel = null;
    let timers = null;
    let running = false;
    let polling = false;
    let round = 0;

    const send = (message) => {
        try {
            channel?.postMessage({ v: WIRE_VERSION, tabId, ...message });
            return true;
        } catch {
            // A closed channel or an uncloneable summary skips this message only
            return false;
        }
    };

    const onMessage = (event) => {
        const message = event?.data;
        if (!message || message.v !== WIRE_VERSION || typeof message.tabId !== 'string' || message.tabId === tabId) {
            return;
        }
        if (message.type === 'poll') {
            // Answered from the handler, not a timer, so a throttled hidden tab still replies on time
            send({ type: 'summary', replyTo: message.tabId, round: message.round, summary: getSummary() });
            return;
        }
        if (message.type === 'bye') {
            peers.delete(message.tabId);
            return;
        }
        // Replies to other tabs' polls are broadcast to everyone; only ours count
        if (message.type !== 'summary' || message.replyTo !== tabId || !polling) return;
        if (!message.summary || typeof message.summary !== 'object' || !Number.isInteger(message.round)) return;
        if (!peers.has(message.tabId) && peers.size >= MAX_PEERS) return;
        const known = peers.get(message.tabId);
        if (known && known.round > message.round) return;
        peers.set(message.tabId, { summary: message.summary, round: message.round });
    };

    const onPageHide = () => send({ type: 'bye' });

    /**
     * Join the channel and start answering polls. Idempotent. Without
     * BroadcastChannel it does nothing and `getTabs()` still returns this tab.
     */
    const start = () => {
        if (running || !open) return;
        try {
            channel = open(TAB_CENSUS_CHANNEL);
        } catch {
            channel = null;
            return;
        }
        running = true;
        channel.onmessage = onMessage;
        // Say goodbye on unload so a closing tab leaves the list at once
        if (typeof window !== 'undefined') window.addEventListener('pagehide', onPageHide);
    };

    /** Ask every tab for its summary now. */
    const pollNow = () => {
        if (!running) return;
        round += 1;
        send({ type: 'poll', round });
    };

    /** Begin polling on a timer and poll once at once. Idempotent. */
    const startPolling = () => {
        if (!running || polling) return;
        polling = true;
        // Rounds stay monotonic across restarts: a reply to an earlier session's poll can still be in
        // flight, and a reset counter would accept it and then refuse every fresh reply until caught up
        timers = createTimerRegistry();
        timers.registerInterval(setInterval(pollNow, pollMs), 'tabCensus.poll');
        pollNow();
    };

    /** Stop polling and forget what was heard; the tab still answers others. Idempotent. */
    const stopPolling = () => {
        if (!polling) return;
        polling = false;
        timers?.clearAll();
        timers = null;
        peers.clear();
    };

    /** Stop polling, say goodbye, close the channel. Idempotent. */
    const stop = () => {
        if (!running) return;
        stopPolling();
        send({ type: 'bye' });
        running = false;
        if (typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
        if (channel) {
            channel.onmessage = null;
            try {
                channel.close();
            } catch {
                // Already closed
            }
        }
        channel = null;
    };

    /**
     * This tab, then every tab that answered either of the last two polls.
     * Own row is built now rather than from a message.
     * @returns {Array<{tabId: string, self: boolean, summary: Object}>} Own tab first
     */
    const getTabs = () => {
        const tabs = [{ tabId, self: true, summary: getSummary() }];
        for (const [id, peer] of peers) {
            if (peer.round < round - 1) {
                peers.delete(id);
                continue;
            }
            tabs.push({ tabId: id, self: false, summary: peer.summary });
        }
        return tabs;
    };

    return {
        start,
        stop,
        startPolling,
        stopPolling,
        pollNow,
        getTabs,
        isRunning: () => running,
        isPolling: () => polling,
        tabId,
        supported,
    };
}
