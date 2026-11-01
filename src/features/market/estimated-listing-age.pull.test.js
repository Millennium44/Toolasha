/**
 * @vitest-environment happy-dom
 *
 * A sync pull never removes a row from this device's log.
 *
 * The log registered only `merge`, so the sync used it for a pull as well, and turned it round when the gist
 * was unmoved since the last exchange but this device had moved: the "incoming" side was then this device's
 * log, and the retention it applies to that side dropped this device's old rows with no archive write behind
 * it, including rows a failed archive write left in the log on purpose. The log now registers its own `pull`.
 * These tests drive `applyPayload` itself, with a baseline saying exactly that.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: {} }));
const imported = vi.hoisted(() => []);

vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(),
        listStores: async () => Object.keys(storeState.stores),
        getAll: async (name) => ({ ...(storeState.stores[name] || {}) }),
        tryGet: async (key, name) => {
            const store = storeState.stores[name] || {};
            return Object.hasOwn(store, key) ? { found: true, value: store[key] } : { found: false, value: null };
        },
        beginRestore: async () => {},
        endRestore: async () => {},
        putAll: async (name, entries) => {
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
            return Object.keys(entries).length;
        },
        get: async () => null,
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
        tryGetAllKeys: async () => [],
        getMany: async () => new Map(),
    },
}));
vi.mock('../../core/settings-storage.js', () => ({ default: { reconcileKeyMigrationState: async () => {} } }));
vi.mock('../../utils/full-backup.js', () => ({
    tombstoneCompanionKey: () => null,
    importEverything: async (payload) => {
        imported.push(payload);
        for (const [name, entries] of Object.entries(payload.stores || {})) {
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
        }
        return { restored: {}, expected: {}, failed: [], complete: true };
    },
    stripExcludedKeys: (storeName, entries) => entries,
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: () => {},
        off: () => {},
        getMarketListings: () => [],
        getCurrentCharacterId: () => 'c1',
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { updatePrice: vi.fn(), updatePrices: vi.fn() } }));

await import('./estimated-listing-age.js');
const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
const { applyPayload, wholeKeyHashes } = await import('../sync/sync-payload.js');
const { mergeListingLogsForPull, LISTING_RETENTION_MS } = await import('./estimated-listing-age.js');

const KEY = 'marketListingTimestamps_c1';
const DAY = 24 * 60 * 60 * 1000;
const NEWEST = Date.UTC(2026, 9, 30, 12);

const row = (id, timestamp, extra = {}) => ({
    id,
    timestamp,
    createdTimestamp: new Date(timestamp).toISOString(),
    itemHrid: '/items/holy_sword',
    enhancementLevel: 2,
    price: 1000,
    orderQuantity: 1,
    filledQuantity: 1,
    isSell: true,
    status: 'filled',
    ...extra,
});
const payloadOf = (log) =>
    JSON.stringify({
        formatVersion: 1,
        exportedAt: '2026-10-31T00:00:00.000Z',
        syncScope: 'everything',
        stores: { marketListings: { [KEY]: log } },
    });
const hashOf = (log) => Object.values(wholeKeyHashes(payloadOf(log)))[0];
const idOf = (log) => Object.keys(wholeKeyHashes(payloadOf(log)))[0];

beforeEach(() => {
    imported.length = 0;
    storeState.stores = { marketListings: {} };
});

describe('a pull in the orientation where only this device moved', () => {
    // The gist: a recent log. This device: the same plus an old row a failed archive write left in the log
    const recent = row(300, NEWEST);
    const stale = row(100, NEWEST - LISTING_RETENTION_MS - 30 * DAY);
    const gist = [recent];
    const local = [stale, recent];

    test('keeps this device’s old row, which only the archive move may take out of the log', async () => {
        storeState.stores.marketListings[KEY] = local;
        // The exchange left the gist ahead of this device (a merged upload), and this device has moved since
        const baseline = { [idOf(gist)]: { gist: hashOf(gist), local: hashOf([row(299, NEWEST - DAY)]) } };

        await applyPayload(payloadOf(gist), { mode: 'merge', baseline });

        const written = storeState.stores.marketListings[KEY];
        expect(written.map((entry) => entry.id)).toEqual([100, 300]);
    });

    test('the registered pull is not turned round: the incoming side alone is trimmed', () => {
        const registration = mergeForKey('marketListings', KEY);
        expect(registration.mergeForPull).not.toBe(registration.merge);

        // A gist that carries a row outside its own window: declined. This device's own old row: kept
        const gistOld = row(50, NEWEST - LISTING_RETENTION_MS - 60 * DAY);
        const folded = registration.mergeForPull(local, [gistOld, recent]);
        expect(folded.map((entry) => entry.id)).toEqual([100, 300]);
    });

    test('where both sides hold an id, the copy further along stands whichever moved', () => {
        const mine = row(300, NEWEST, { status: 'filled', filledQuantity: 5 });
        const theirs = row(300, NEWEST, { status: 'active', filledQuantity: 0 });

        expect(mergeListingLogsForPull([mine], [theirs])[0].status).toBe('filled');
        expect(mergeListingLogsForPull([theirs], [mine])[0].status).toBe('filled');
        // Equal: the incoming copy, as the union always did
        const same = row(300, NEWEST, { price: 999 });
        expect(mergeListingLogsForPull([theirs], [{ ...theirs, price: 5 }])[0].price).toBe(5);
        expect(mergeListingLogsForPull([same], [{ ...same, price: 7 }])[0].price).toBe(7);
    });
});
