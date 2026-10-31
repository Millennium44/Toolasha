/* global process, setImmediate */
import { describe, test, expect, vi } from 'vitest';

/*
 * Timing harness for a pull of a large gist that this device already mostly holds. Storage reads settle
 * on a macrotask (as IndexedDB's events do), so the longest stretch between two ticks of a timer chain is
 * the longest task the pull would put on the page.
 */

const storeState = vi.hoisted(() => ({ stores: {} }));
// SYNC_PERF_IO=micro settles reads on a microtask instead: the CPU the pull spends, with no I/O in between
const macro = () =>
    globalThis.process?.env?.SYNC_PERF_IO === 'micro' ? Promise.resolve() : new Promise((r) => setTimeout(r, 0));

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
        tryGetMany: async (keys, name) => {
            await macro();
            const store = storeState.stores[name] || {};
            return new Map(
                keys.map((key) => [
                    key,
                    Object.hasOwn(store, key)
                        ? { found: true, value: structuredClone(store[key]) }
                        : { found: false, value: null },
                ])
            );
        },
        beginRestore: async () => {},
        endRestore: async () => {},
        pendingWriteCount: () => 0,
        flushAll: async () => {},
        delete: async (key, name) => {
            await macro();
            delete (storeState.stores[name] || {})[key];
            return true;
        },
        putAll: async (name, entries) => {
            await macro();
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
            return Object.keys(entries).length;
        },
    },
}));

// Counted, and passed through: the slicing tests read how often the pull handed the page a frame
const yields = vi.hoisted(() => ({ count: 0 }));
vi.mock('../../utils/yield-to-browser.js', () => ({
    yieldToBrowser: () => {
        yields.count += 1;
        return new Promise((resolve) => setTimeout(resolve, 0));
    },
}));

vi.mock('../../core/settings-storage.js', () => ({
    default: { reconcileKeyMigrationState: async () => {} },
}));

const imported = vi.hoisted(() => []);
vi.mock('../../utils/full-backup.js', () => ({
    tombstoneCompanionKey: () => null,
    importEverything: async (payload) => {
        imported.push(payload);
        const writtenKeys = {};
        for (const [name, entries] of Object.entries(payload.stores || {})) {
            writtenKeys[name] = Object.keys(entries);
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
        }
        return { restored: {}, expected: {}, failed: [], complete: true, writtenKeys, latched: 0, latchedKeys: [] };
    },
    stripExcludedKeys: (storeName, entries) => entries,
}));

const { createChunkedHistory } = await import('../../utils/chunked-history.js');
await import('../networth/networth-history.js');
await import('../skills/xp-tracker.js');
const sync = await import('./sync-payload.js');
const { applyPayload, buildPayloadJSON, contentHash } = sync;
// The sliced variants where this build has them, the plain ones where it does not (a run against the old code)
const addsToRemote = sync.addsToRemoteSliced ?? sync.addsToRemote;
const mergeForUpload = sync.mergeForUploadSliced ?? sync.mergeForUpload;
const wholeKeyHashes = sync.wholeKeyHashesSliced ?? sync.wholeKeyHashes;

// The two chunked histories the report names, registered the way their owners do
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

/** A gist of ~1,125 keys this device already holds, at the sizes the report's stores run to */
function buildFixture(scale = 1) {
    const stores = {
        networthHistory: {},
        alchemyHistory: {},
        lootLogHistory: {},
        settings: {},
        xpHistory: {},
        guildHistory: {},
        combatExport: {},
        marketListings: {},
        collections: {},
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
    for (let index = 0; index < Math.round(193 * scale); index += 1)
        stores.settings[`setting_${index}`] = items(30, index);
    for (let index = 0; index < 20; index += 1) stores.xpHistory[`xp_${index}`] = items(60, index);
    for (let index = 0; index < 43; index += 1) stores.guildHistory[`g_${index}`] = items(80, index);
    for (let index = 0; index < 31; index += 1) stores.combatExport[`c_${index}`] = items(100, index);
    for (let index = 0; index < 95; index += 1) stores.marketListings[`l_${index}`] = items(20, index);
    for (let index = 0; index < 14; index += 1) stores.collections[`col_${index}`] = items(40, index);
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

describe.runIf(heavy)('sync pull timing (SYNC_PERF=1)', () => {
    test('phases of a pull of a gist this device already holds', async () => {
        const local = buildFixture();
        const remote = structuredClone(local);
        // Two that differ, as in the report
        remote.rerollSpending.r_0 = { changed: true };
        remote.marketListings.l_new = { a: 1 };
        storeState.stores = structuredClone(local);
        const text = payloadText(remote);
        const keyCount = Object.values(remote).reduce((sum, entries) => sum + Object.keys(entries).length, 0);
        console.log(`payload: ${keyCount} keys, ${(text.length / 1e6).toFixed(2)} MB`);

        await report('JSON.parse(payload)', () => JSON.parse(text));
        await report('contentHash(payload)', () => contentHash(text));
        const localText = await report('buildPayloadJSON', () => buildPayloadJSON('everything'));
        await report('_sameContent (2x addsToRemote)', async () => {
            await addsToRemote(text, localText, { forUpload: false });
            return addsToRemote(localText, text);
        });
        const baseline = await report('wholeKeyHashes(local)', () => wholeKeyHashes(localText));

        for (const [mode, base] of [
            ['pull', null],
            ['merge', baseline],
        ]) {
            storeState.stores = structuredClone(local);
            const applied = await report(`applyPayload(${mode})`, () => applyPayload(text, { mode, baseline: base }));
            const unchanged = Object.values(applied.unchanged).reduce((a, b) => a + b, 0);
            console.log(`    unchanged ${unchanged}, written whole ${applied.writtenWholeKeys.length}`);
        }
        await report('wholeKeyHashes(payload)', () => wholeKeyHashes(text));
        await report('addsToRemote(rebuild, payload)', () => addsToRemote(localText, text));
        await report('mergeForUpload(rebuild, payload)', () => mergeForUpload(localText, text, null));
        expect(true).toBe(true);
    }, 120_000);
});

describe('a pull of a large gist hands the page a frame as it goes', () => {
    /** A clock that moves 1 ms per reading, so a slice's budget is a count of readings, not a machine's speed */
    function steppedClock() {
        let now = 0;
        return vi.spyOn(performance, 'now').mockImplementation(() => (now += 1));
    }

    function fixturePair() {
        const local = buildFixture(0.05);
        const remote = structuredClone(local);
        remote.rerollSpending.r_0 = { changed: true };
        remote.marketListings.l_new = { a: 1 };
        return { local, remote, text: payloadText(remote) };
    }

    test('applying it yields between records, in either mode', async () => {
        const { local, text } = fixturePair();
        const clock = steppedClock();
        try {
            for (const mode of ['pull', 'merge']) {
                storeState.stores = structuredClone(local);
                yields.count = 0;
                const result = await applyPayload(text, { mode, baseline: null });
                expect(yields.count).toBeGreaterThan(5);
                expect(result.writtenWholeKeys.map(({ key }) => key).sort()).toEqual(['l_new', 'r_0']);
            }
        } finally {
            clock.mockRestore();
        }
    });

    test('a hidden tab is not yielded in, where throttled timers would hold the restore for minutes', async () => {
        const { local, text } = fixturePair();
        const clock = steppedClock();
        const hadDocument = 'document' in globalThis;
        globalThis.document = { visibilityState: 'hidden' };
        try {
            storeState.stores = structuredClone(local);
            yields.count = 0;
            const result = await applyPayload(text, { mode: 'pull' });
            await sync.addsToRemoteSliced(text, text);
            expect(yields.count).toBe(0);
            expect(result.writtenWholeKeys.map(({ key }) => key).sort()).toEqual(['l_new', 'r_0']);
        } finally {
            if (!hadDocument) delete globalThis.document;
            clock.mockRestore();
        }
    });

    test('the weighing after it yields, and answers as the one-go version does', async () => {
        const { local, text } = fixturePair();
        storeState.stores = structuredClone(local);
        const localText = await buildPayloadJSON('everything');
        const clock = steppedClock();
        try {
            for (const [sliced, plain, args] of [
                [sync.addsToRemoteSliced, sync.addsToRemote, [localText, text]],
                [sync.addsToRemoteSliced, sync.addsToRemote, [text, localText, { forUpload: false }]],
                [sync.wholeKeyHashesSliced, sync.wholeKeyHashes, [text]],
                [sync.exchangeBaselineSliced, sync.exchangeBaseline, [text, localText]],
            ]) {
                yields.count = 0;
                const answer = await sliced(...args);
                expect(yields.count).toBeGreaterThan(0);
                expect(answer).toEqual(plain(...args));
            }
            yields.count = 0;
            const merged = await sync.mergeForUploadSliced(localText, text, null);
            expect(yields.count).toBeGreaterThan(0);
            const plainMerged = sync.mergeForUpload(localText, text, null);
            const unstamped = (result) => ({ ...result, text: result.text.replace(/"exportedAt":"[^"]*"/, '') });
            expect(unstamped(merged)).toEqual(unstamped(plainMerged));
        } finally {
            clock.mockRestore();
        }
    });
});
