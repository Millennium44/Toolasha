/* global process, setImmediate */
import { describe, test, expect, vi } from 'vitest';

/*
 * Timing harness for an automatic push of a large payload: what runs on the page's thread between storage
 * reads. Reads settle on a macrotask (as IndexedDB's events do), so the longest stretch between two ticks of
 * a timer chain is the longest task the push would put on the page. SYNC_PERF=1 prints the phases and
 * SYNC_PERF_SCALE sizes the fixture. The tests outside that gate count yields against a stepped clock and
 * compare answers with the one-go versions, so they hold on any machine.
 */

const storeState = vi.hoisted(() => ({ stores: {} }));
const macro = () => new Promise((r) => setTimeout(r, 0));

vi.mock('../../core/storage.js', () => ({
    default: {
        listStores: async () => {
            await macro();
            return Object.keys(storeState.stores);
        },
        getAll: async (name) => {
            await macro();
            return structuredClone(storeState.stores[name] || {});
        },
        tryGet: async (key, name) => {
            await macro();
            const store = storeState.stores[name] || {};
            return Object.hasOwn(store, key)
                ? { found: true, value: structuredClone(store[key]) }
                : { found: false, value: null };
        },
        flushAll: async () => {},
    },
}));

// Counted, and passed through: the slicing tests read how often the work handed the page a frame
const yields = vi.hoisted(() => ({ count: 0, onYield: null }));
vi.mock('../../utils/yield-to-browser.js', () => ({
    yieldToBrowser: () => {
        yields.count += 1;
        yields.onYield?.();
        return new Promise((resolve) => setTimeout(resolve, 0));
    },
}));

vi.mock('../../core/settings-storage.js', () => ({
    default: { reconcileKeyMigrationState: async () => {} },
}));

vi.mock('../../utils/full-backup.js', () => ({
    tombstoneCompanionKey: () => null,
    importEverything: async () => ({}),
    stripExcludedKeys: (storeName, entries) => entries,
}));

const { createChunkedHistory } = await import('../../utils/chunked-history.js');
await import('../networth/networth-history.js');
await import('../skills/xp-tracker.js');
const sync = await import('./sync-payload.js');
const { buildPayloadJSON, contentHash } = sync;

// The two chunked histories a played-in character's payload is mostly made of, registered as their owners do
createChunkedHistory({
    storeName: 'alchemyHistory',
    prefix: 'transmuteSessionsRec',
    groupOf: () => 'x',
    compare: (a, b) => (a?.startTime || 0) - (b?.startTime || 0),
    identityOf: (session) => session?.id ?? JSON.stringify(session),
    label: 'Perf alchemy',
});
createChunkedHistory({
    storeName: 'lootLogHistory',
    prefix: 'lootLogRec',
    groupOf: () => 'x',
    compare: (a, b) => Date.parse(b?.startTime) - Date.parse(a?.startTime) || 0,
    identityOf: (entry) => `${entry.actionHrid}|${entry.startTime}`,
    label: 'Perf loot',
});

const CHAR = '123456';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1);

function items(count, seed) {
    const out = {};
    for (let index = 0; index < count; index += 1) out[`/items/item_${seed}_${index}`] = (seed * 31 + index) % 997;
    return out;
}

/** The store sizes sync-pull-perf.test.js takes from a real report: ~1,125 keys, 7 MB at scale 1 */
function buildFixture(scale = 1) {
    const stores = {
        networthHistory: {},
        alchemyHistory: {},
        lootLogHistory: {},
        settings: {},
        guildHistory: {},
        marketListings: {},
        rerollSpending: {},
    };
    for (let index = 0; index < Math.round(300 * scale); index += 1) {
        stores.networthHistory[`networthDetail_${CHAR}_${T0 + index * 3_600_000}`] = {
            t: T0 + index * 3_600_000,
            items: items(400, index),
        };
    }
    for (let month = 0; month < Math.round(43 * scale); month += 1) {
        const points = [];
        for (let hour = 0; hour < 720; hour += 1) points.push({ t: T0 + month * 30 * DAY + hour * 3_600_000, v: hour });
        stores.networthHistory[`networthSeries_${CHAR}_m${month}`] = points;
    }
    for (let day = 0; day < Math.round(226 * scale); day += 1) {
        const sessions = [];
        for (let index = 0; index < 20; index += 1) {
            sessions.push({
                id: `s${day}_${index}`,
                startTime: T0 + day * DAY + index * 60_000,
                totalAttempts: 100 + index,
                outputs: items(12, day + index),
            });
        }
        stores.alchemyHistory[`transmuteSessionsRec_${CHAR}_d${day}`] = sessions;
    }
    for (let chunk = 0; chunk < Math.round(123 * scale); chunk += 1) {
        const entries = [];
        for (let index = 0; index < 30; index += 1) {
            entries.push({
                actionHrid: `/actions/a${index}`,
                startTime: new Date(T0 + chunk * DAY + index * 60_000).toISOString(),
                drops: items(10, chunk + index),
            });
        }
        stores.lootLogHistory[`lootLogRec_${CHAR}_c${chunk}`] = entries;
    }
    for (let index = 0; index < Math.round(193 * scale); index += 1) {
        stores.settings[`setting_${index}`] = items(30, index);
    }
    for (let index = 0; index < 43; index += 1) stores.guildHistory[`g_${index}`] = items(80, index);
    for (let index = 0; index < 95; index += 1) stores.marketListings[`l_${index}`] = items(20, index);
    for (let index = 0; index < 14; index += 1) stores.rerollSpending[`r_${index}`] = items(10, index);
    return stores;
}

function payloadText(stores) {
    return JSON.stringify({
        formatVersion: 1,
        exportedAt: '2026-10-30T00:00:00.000Z',
        syncScope: 'everything',
        stores,
    });
}

/** Runs `work` while a timer chain records the longest gap between ticks */
async function measure(work) {
    let last = performance.now();
    let longest = 0;
    let running = true;
    const tick = () => {
        const now = performance.now();
        longest = Math.max(longest, now - last);
        last = now;
        if (running) setImmediate(tick);
    };
    setImmediate(tick);
    const start = performance.now();
    const result = await work();
    const total = performance.now() - start;
    running = false;
    longest = Math.max(longest, performance.now() - last);
    return { result, total, longest };
}

async function report(label, fn) {
    const { result, total, longest } = await measure(fn);
    console.log(`  ${label}: ${total.toFixed(1)} ms, longest task ${longest.toFixed(1)} ms`);
    return result;
}

const heavy = Boolean(process.env.SYNC_PERF);
const SCALE = Number(process.env.SYNC_PERF_SCALE) || 1;

describe.runIf(heavy)('sync push timing (SYNC_PERF=1)', () => {
    test('phases of an automatic push that finds its histories unmoved', async () => {
        const local = buildFixture(SCALE);
        storeState.stores = structuredClone(local);
        const remote = structuredClone(local);
        remote.rerollSpending.r_0 = { changed: true };
        const remoteText = payloadText(remote);

        // The sliced variants where this build has them, the plain ones where it does not (a run against HEAD)
        const hash = sync.contentHashSliced ?? contentHash;
        const diverge = sync.registeredKeysDivergeSliced ?? sync.registeredKeysDiverge;

        const text = await report('buildPayloadJSON', () => buildPayloadJSON('everything'));
        console.log(`payload: ${(text.length / 1e6).toFixed(2)} MB`);
        await report('contentHash', () => hash(text));
        const baseline = sync.wholeKeyHashes(text);
        // Unmoved: every registered key is hashed and compared, the most this check ever does
        const answer = await report('registeredKeysDiverge', () => diverge(text, baseline));
        expect(answer).toBe(false);
        await report('wholeKeyHashes (sliced)', () => sync.wholeKeyHashesSliced(text));
        await report('wholeKeyHashes (one go, as the push path ran it)', () => sync.wholeKeyHashes(text));
        await report('mergeForUpload (sliced)', () => sync.mergeForUploadSliced(text, remoteText, baseline));
        await report('mergeForUpload (one go, as the push path ran it)', () =>
            sync.mergeForUpload(text, remoteText, baseline)
        );
        await report('addsToRemote (sliced)', () => sync.addsToRemoteSliced(text, remoteText));
        await report('addsToRemote (one go, as the push path ran it)', () => sync.addsToRemote(text, remoteText));
        await report('JSON.parse (for scale)', () => JSON.parse(text));
    }, 300_000);
});

describe('an automatic push of a large payload hands the page a frame as it goes', () => {
    /** A clock that moves 1 ms per reading, so a slice's budget is a count of readings, not a machine's speed */
    function steppedClock() {
        let now = 0;
        return vi.spyOn(performance, 'now').mockImplementation(() => (now += 1));
    }

    test('the build yields inside a store, and writes the same text JSON.stringify would', async () => {
        const stores = buildFixture(0.05);
        // A value JSON leaves out of an object, and odd key text, are both still JSON's call
        stores.guildHistory.left_out = undefined;
        stores.guildHistory['quote"key☃'] = { nested: [1, 'two', null] };
        storeState.stores = stores;
        const clock = steppedClock();
        try {
            yields.count = 0;
            const text = await buildPayloadJSON('everything');
            expect(yields.count).toBeGreaterThan(5);

            const parsed = JSON.parse(text);
            expect(Object.hasOwn(parsed.stores.guildHistory, 'left_out')).toBe(false);
            expect(text).toContain(`"guildHistory":${JSON.stringify(stores.guildHistory)}`);
            expect(text).toContain(`"lootLogHistory":${JSON.stringify(parsed.stores.lootLogHistory)}`);
        } finally {
            clock.mockRestore();
        }
    });

    test('a write landing during the yields does not reach a store already read', async () => {
        storeState.stores = buildFixture(0.05);
        const clock = steppedClock();
        // The first yield falls inside the first store, on the turn it gives the page
        yields.onYield = () => {
            yields.onYield = null;
            storeState.stores.networthHistory.written_during = { late: true };
        };
        try {
            const parsed = JSON.parse(await buildPayloadJSON('everything'));
            expect(storeState.stores.networthHistory.written_during).toEqual({ late: true });
            expect(Object.hasOwn(parsed.stores.networthHistory, 'written_during')).toBe(false);
        } finally {
            yields.onYield = null;
            clock.mockRestore();
        }
    });

    test('the histories check yields, and answers as the one-go version does', async () => {
        const text = payloadText(buildFixture(0.05));
        const unmoved = sync.wholeKeyHashes(text);
        const moved = { ...unmoved };
        const someKey = Object.keys(moved).find((id) => id.includes('lootLogRec'));
        moved[someKey] = 'other-hash';
        const gone = { ...unmoved, 'lootLogHistory\u0000lootLogRec_123456_gone': 'x' };

        const clock = steppedClock();
        try {
            yields.count = 0;
            await expect(sync.registeredKeysDivergeSliced(text, unmoved)).resolves.toBe(false);
            expect(yields.count).toBeGreaterThan(0);
            for (const baseline of [unmoved, moved, gone, null]) {
                const answer = await sync.registeredKeysDivergeSliced(text, baseline);
                expect(answer).toBe(sync.registeredKeysDiverge(text, baseline));
            }
            expect(sync.registeredKeysDiverge(text, moved)).toBe(true);
            expect(sync.registeredKeysDiverge(text, gone)).toBe(true);
            await expect(sync.registeredKeysDivergeSliced('not json', unmoved)).resolves.toBe(false);
        } finally {
            clock.mockRestore();
        }
    });

    test('the fingerprint yields on a large text and comes out the same, down to no text at all', async () => {
        const big = `{"formatVersion":1,"exportedAt":"2026-11-04T00:00:00.000Z","stores":"${'x'.repeat(12_000_000)}"}`;
        const clock = steppedClock();
        try {
            yields.count = 0;
            await expect(sync.contentHashSliced(big)).resolves.toBe(contentHash(big));
            expect(yields.count).toBeGreaterThan(0);
            for (const text of ['', 'a', '{"exportedAt":"x","a":1}']) {
                await expect(sync.contentHashSliced(text)).resolves.toBe(contentHash(text));
            }
        } finally {
            clock.mockRestore();
        }
    });

    test('a hidden tab is not yielded in, where throttled timers would hold the push for minutes', async () => {
        storeState.stores = buildFixture(0.05);
        const hadDocument = 'document' in globalThis;
        globalThis.document = { visibilityState: 'hidden' };
        const clock = steppedClock();
        try {
            yields.count = 0;
            const text = await buildPayloadJSON('everything');
            await sync.registeredKeysDivergeSliced(text, sync.wholeKeyHashes(text));
            await sync.contentHashSliced(text);
            expect(yields.count).toBe(0);
        } finally {
            clock.mockRestore();
            if (!hadDocument) delete globalThis.document;
        }
    });
});
