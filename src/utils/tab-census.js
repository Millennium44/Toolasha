/**
 * Tab Census
 *
 * Every game tab publishes a small summary of itself on a `BroadcastChannel`
 * every few seconds, and listens for the others'. The PFormance panel lists the
 * tabs it has heard from, so one open panel shows what all of the tabs are
 * costing the userscript manager side by side.
 *
 * Nothing here is persisted. A summary lives in a Map for as long as it is
 * fresh, and a tab that goes quiet drops out of the list after `staleMs`.
 */

import { createTimerRegistry } from './timer-registry.js';

/** BroadcastChannel name. Toolasha-scoped; nothing else should post on it. */
export const TAB_CENSUS_CHANNEL = 'toolasha-tab-census';

/** How often a tab publishes. */
export const TAB_CENSUS_INTERVAL_MS = 10000;

/** How long a silent tab stays listed: three missed publishes. */
export const TAB_CENSUS_STALE_MS = 30000;

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
 * Publish this tab and hear the others.
 *
 * @param {Object} options - Configuration
 * @param {Function} options.getSummary - Builds this tab's summary on demand
 * @param {number} [options.intervalMs] - Publish cadence
 * @param {number} [options.staleMs] - How long a silent tab stays listed
 * @param {Function} [options.now] - Clock, for tests
 * @param {string} [options.tabId] - Fixed id, for tests
 * @param {Function} [options.createChannel] - `(name) => channel`, for tests
 * @returns {{start: Function, stop: Function, getTabs: Function, isRunning: Function, tabId: string,
 *   supported: boolean}} The census
 */
export function createTabCensus({
    getSummary,
    intervalMs = TAB_CENSUS_INTERVAL_MS,
    staleMs = TAB_CENSUS_STALE_MS,
    now = Date.now,
    tabId = newTabId(),
    createChannel,
}) {
    const open = createChannel || (broadcastChannelSupported() ? (name) => new BroadcastChannel(name) : null);
    const supported = open !== null;
    /** @type {Map<string, {summary: Object, heardAt: number}>} */
    const peers = new Map();
    let channel = null;
    let timers = null;
    let running = false;

    const publish = () => {
        if (!channel) return;
        try {
            channel.postMessage({ v: WIRE_VERSION, type: 'summary', tabId, summary: getSummary() });
        } catch {
            // A closed channel or an uncloneable summary skips this beat only
        }
    };

    const onMessage = (event) => {
        const message = event?.data;
        if (!message || message.v !== WIRE_VERSION || typeof message.tabId !== 'string' || message.tabId === tabId) {
            return;
        }
        if (message.type === 'hello') {
            // A tab that just started asks for everyone's summary rather than
            // waiting out a publish interval to fill its list
            publish();
            return;
        }
        if (message.type === 'bye') {
            peers.delete(message.tabId);
            return;
        }
        if (message.type !== 'summary' || !message.summary || typeof message.summary !== 'object') return;
        if (!peers.has(message.tabId) && peers.size >= MAX_PEERS) return;
        peers.set(message.tabId, { summary: message.summary, heardAt: now() });
    };

    /**
     * Start publishing and listening. Idempotent. Without BroadcastChannel it
     * does nothing and `getTabs()` still returns this tab alone.
     */
    const start = () => {
        if (running || !open) return;
        running = true;
        try {
            channel = open(TAB_CENSUS_CHANNEL);
        } catch {
            channel = null;
            running = false;
            return;
        }
        channel.onmessage = onMessage;
        timers = createTimerRegistry();
        timers.registerInterval(setInterval(publish, intervalMs), 'tabCensus.publish');
        // Publish at once and ask the others to do the same, so a newly started
        // tab fills its list in a beat rather than after a full interval
        publish();
        try {
            channel.postMessage({ v: WIRE_VERSION, type: 'hello', tabId });
        } catch {
            // The next interval's beats fill the list instead
        }
    };

    /** Say goodbye, stop the timer, close the channel and forget the peers. Idempotent. */
    const stop = () => {
        if (!running) return;
        running = false;
        try {
            channel?.postMessage({ v: WIRE_VERSION, type: 'bye', tabId });
        } catch {
            // Peers will age this tab out after staleMs
        }
        timers?.clearAll();
        timers = null;
        if (channel) {
            channel.onmessage = null;
            try {
                channel.close();
            } catch {
                // Already closed
            }
        }
        channel = null;
        peers.clear();
    };

    /**
     * Every tab heard from within `staleMs`, plus this one, newest summary
     * first for peers. This tab's row is built now rather than from a message.
     * @returns {Array<{tabId: string, self: boolean, ageMs: number, summary: Object}>} Own tab first
     */
    const getTabs = () => {
        const at = now();
        const tabs = [{ tabId, self: true, ageMs: 0, summary: getSummary() }];
        for (const [id, peer] of peers) {
            const ageMs = at - peer.heardAt;
            if (ageMs > staleMs) {
                peers.delete(id);
                continue;
            }
            tabs.push({ tabId: id, self: false, ageMs, summary: peer.summary });
        }
        return [...tabs.slice(0, 1), ...tabs.slice(1).sort((a, b) => a.ageMs - b.ageMs)];
    };

    return { start, stop, getTabs, isRunning: () => running, tabId, supported };
}
