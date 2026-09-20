/**
 * The measurements that say why an operation did not come back.
 *
 * The live report these exist for: timeouts on four object stores at once, with
 * reconnects interleaved, while another program on the machine was saturating
 * every core — and nobody able to say afterwards whether the game tab was in
 * front. Two explanations fit that equally well and have different fixes. A
 * page that is not running (frozen in the background, or starved of CPU in the
 * foreground) delivers neither IndexedDB's success event nor the watchdog's own
 * timeout, and on resume the expired timeout wins the race against a healthy
 * transaction. Real contention on one store looks nothing like that.
 *
 * So each timeout is recorded with both signals — what `visibilityState` said,
 * and how much wall time the heartbeat found missing — and these tests are that
 * the record is actually taken and is readable. They prove nothing about which
 * explanation is true in the field; that is what the panel is for.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const { default: storage } = await import('./storage.js');

/** The heartbeat's own interval, in milliseconds — a beat this late is on time */
const HEARTBEAT_INTERVAL = 1000;

/** A connection whose transactions never fire an event of any kind. @returns {object} A fake IDBDatabase */
function createWedgedDb() {
    return {
        objectStoreNames: ['settings'],
        version: 20,
        transaction() {
            const store = {
                get: () => ({ onsuccess: null, onerror: null }),
                put: () => ({ onsuccess: null, onerror: null }),
            };
            return { objectStore: () => store, onabort: null, onerror: null, oncomplete: null };
        },
        close() {},
    };
}

/**
 * A connection that answers from a map, on the microtask queue.
 * @param {Record<string, *>} data - Seed data for the `settings` store
 * @returns {object} A fake IDBDatabase
 */
function createHealthyDb(data = {}) {
    const store = new Map(Object.entries(data));
    return {
        objectStoreNames: ['settings'],
        version: 20,
        transaction() {
            const pending = [];
            const objectStore = {
                get(key) {
                    const request = { onsuccess: null, onerror: null, result: undefined };
                    pending.push(() => {
                        request.result = store.get(key);
                        request.onsuccess?.();
                    });
                    return request;
                },
                put(value, key) {
                    const request = { onsuccess: null, onerror: null };
                    pending.push(() => {
                        store.set(key, value);
                        request.onsuccess?.();
                    });
                    return request;
                },
            };
            const txn = { objectStore: () => objectStore, onabort: null, onerror: null, oncomplete: null };
            queueMicrotask(() => {
                for (const run of pending) run();
                queueMicrotask(() => txn.oncomplete?.());
            });
            return txn;
        },
        close() {},
    };
}

describe('what storage records when an operation does not come back', () => {
    beforeEach(() => {
        storage.db = null;
        storage._dbNulledReason = null;
        storage._reconnecting = false;
        storage._recovering = null;
        storage._lastReconnectFailureAt = Date.now(); // No reopen: this is about the record, not the recovery
        storage._readTimeouts = 0;
        storage._writeTimeouts = 0;
        storage._timeoutEvents = [];
        storage._lostWindows = [];
        storage._lostMsTotal = 0;
        storage._durations = new Map();
        storage._outstanding = new Map();
        storage._writeCounts = new Map();
        storage._estimateAtFirstTimeout = null;
        storage.readTimeoutMs = 30;
        storage.writeTimeoutMs = 30;
        vi.spyOn(console, 'error').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.restoreAllMocks();
        storage.stopInstrumentation();
        storage.db = null;
        storage.readTimeoutMs = 10_000;
        storage.writeTimeoutMs = 15_000;
        storage._lastReconnectFailureAt = 0;
    });

    test('a timed-out read carries both signals, not just a counter', async () => {
        storage.db = createWedgedDb();

        await storage.get('script_settingsMap_32326', 'settings', 'fallback');

        const [event] = storage.diagnostics().recentTimeouts;
        expect(event).toMatchObject({ kind: 'read', op: 'get', storeName: 'settings' });
        expect(event.waitedMs).toBeGreaterThanOrEqual(25);
        // Both, always: a 'visible' reading is not an alibi on a starved
        // machine, and a lost-time reading of zero is not one on a tab that was
        // backgrounded a moment ago.
        expect(event).toHaveProperty('visibilityState');
        expect(event).toHaveProperty('msSinceVisibilityChange');
        expect(event).toHaveProperty('lostMs');
        expect(event.outstanding).toBeGreaterThan(0);
    });

    test('a timed-out write is recorded the same way', async () => {
        storage.db = createWedgedDb();

        await storage.set('k', 'v', 'settings', true);

        const [event] = storage.diagnostics().recentTimeouts;
        expect(event).toMatchObject({ kind: 'write', op: 'set', target: 'k', storeName: 'settings' });
    });

    test('lost wall time is measured from the heartbeat, including the part still unfolding', () => {
        storage.startInstrumentation();
        // A beat that came back three seconds late: two seconds of wall time
        // the page cannot account for.
        const before = storage._now();
        storage._heartbeatAt = storage._now() - 3000;
        storage._beat();

        const lost = storage._lostSince(before - 1);
        expect(lost.windows).toBe(1);
        expect(lost.lostMs).toBeGreaterThanOrEqual(1900);
        expect(storage.diagnostics().lostTime.totalMs).toBeGreaterThanOrEqual(1900);

        // And a stall that has not been beaten through yet still counts: the
        // expired timeout often runs before the expired interval does.
        storage._heartbeatAt = storage._now() - 5000;
        expect(storage._lostSince(storage._now() - 10).overdueMs).toBeGreaterThanOrEqual(3900);
    });

    test('ordinary scheduling jitter is not recorded as lost time', () => {
        storage.startInstrumentation();
        // A hundred milliseconds late is a busy main thread, not a page that stopped.
        storage._heartbeatAt = storage._now() - (HEARTBEAT_INTERVAL + 100);
        storage._beat();
        expect(storage.diagnostics().lostTime.windows).toHaveLength(0);
    });

    test('durations are kept per store, which is the shape of the contention question', async () => {
        storage.db = createHealthyDb({ a: '1' });

        await storage.get('a', 'settings', null);
        await storage.set('a', '2', 'settings', true);

        const [row] = storage.diagnostics().durations;
        expect(row.storeName).toBe('settings');
        expect(row.reads).toBe(1);
        expect(row.writes).toBe(1);
        expect(row.readCounts.reduce((sum, count) => sum + count, 0)).toBe(1);
        expect(storage.diagnostics().durationBuckets.length).toBeGreaterThan(0);
    });

    test('an operation in flight is in the census, with its age, and leaves when it settles', async () => {
        storage.db = createWedgedDb();

        const read = storage.get('slow', 'settings', 'fallback');
        await Promise.resolve();

        const census = storage.diagnostics().outstanding;
        expect(census).toHaveLength(1);
        expect(census[0]).toMatchObject({ kind: 'read', op: 'get', target: 'slow', storeName: 'settings' });
        expect(census[0].ageMs).toBeGreaterThanOrEqual(0);

        await read;
        expect(storage.diagnostics().outstanding).toHaveLength(0);
    });

    test('the busiest keys by transaction are named, so write amplification shows', async () => {
        storage.db = createHealthyDb();

        for (let i = 0; i < 4; i += 1) await storage.set('chatHistory', String(i), 'settings', true);
        await storage.set('quiet', 'x', 'settings', true);

        const [busiest] = storage.diagnostics().writeRates;
        expect(busiest).toEqual({ key: 'settings:chatHistory', count: 4 });
        expect(storage.diagnostics().writeRates).toHaveLength(2);
    });

    test('the heartbeat runs without a document, and stops when asked', () => {
        expect(typeof document).toBe('undefined');
        storage.startInstrumentation();
        expect(storage.diagnostics().lostTime.running).toBe(true);
        storage.stopInstrumentation();
        expect(storage.diagnostics().lostTime.running).toBe(false);
    });
});
