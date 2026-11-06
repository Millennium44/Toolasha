/**
 * A sync pull of `<characterId>_inventoryTabs_config` that changes nothing this device holds.
 *
 * The key is deliberately not live-safe, so a pull that writes it latches it and advises a reload. These run the
 * real registry, the real fold and the real `applyPayload` (only storage and the importer are stood in for) and
 * look at what the pull would write: a fold that differs from the stored copy only in defaults or in which tab
 * was selected is left out of the write, and so latches nothing. Anything that is news is still written.
 */

import { afterEach, describe, test, expect, beforeEach, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: {}, pending: [] }));
const importedPayloads = vi.hoisted(() => []);

const storageMock = vi.hoisted(() => {
    const map = (name) => (storeState.stores[name] ||= {});
    const has = (name, key) => Object.prototype.hasOwnProperty.call(map(name), key);
    const read = (key, name) =>
        has(name, key) ? { found: true, value: structuredClone(map(name)[key]) } : { found: false, value: null };
    return {
        listStores: async () => Object.keys(storeState.stores),
        getAll: async (name) => structuredClone(map(name)),
        get: async (key, name, fallback = null) => (has(name, key) ? structuredClone(map(name)[key]) : fallback),
        tryGet: async (key, name) => read(key, name),
        tryGetMany: async (keys, name) => new Map(keys.map((key) => [key, read(key, name)])),
        tryGetAllKeys: async (name) => Object.keys(map(name)),
        getAllKeys: async (name) => Object.keys(map(name)),
        set: async (key, value, name) => {
            map(name)[key] = structuredClone(value);
            return true;
        },
        delete: async (key, name) => {
            delete map(name)[key];
            return true;
        },
        putAll: async (name, entries) => {
            Object.assign(map(name), structuredClone(entries));
            return Object.keys(entries).length;
        },
        isQuotaExceeded: () => false,
        // The real hold lands the debounce queue first: what the panel saved a moment ago is stored by the read
        beginRestore: async () => {
            for (const [key, value] of storeState.pending.splice(0)) map('settings')[key] = structuredClone(value);
        },
        endRestore: async () => {},
        pendingWriteCount: () => 0,
        flushAll: async () => {},
    };
});

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/settings-storage.js', () => ({
    default: { reconcileKeyMigrationState: vi.fn(async () => {}) },
}));
vi.mock('../../../utils/full-backup.js', () => ({
    tombstoneCompanionKey: () => null,
    importEverything: async (payload) => {
        importedPayloads.push(payload);
        return { restored: {}, failed: [], complete: true };
    },
    stripExcludedKeys: (_store, entries) => entries,
}));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'c1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../../core/data-manager.js', () => ({
    default: { characterData: {}, on: () => {}, off: () => {}, getCurrentCharacterId: () => 'c1' },
}));
vi.mock('../../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, onSettingsLoaded: () => () => {} },
}));

await import('./custom-tabs-data.js');
const { applyPayload, resetLeftOutLogForTests } = await import('../../sync/sync-payload.js');

const STORE = 'settings';
const KEY = '603281_inventoryTabs_config';
const OTHER_KEY = '777_inventoryTabs_config';
const tab = (id, extra = {}) => ({ id, name: id, items: ['/items/a'], children: [], updatedAt: 5, ...extra });
const payloadOf = (entries) =>
    JSON.stringify({ formatVersion: 1, exportedAt: '2026-08-20T00:00:00.000Z', stores: { [STORE]: entries } });
const written = () => importedPayloads[0].stores[STORE];

beforeEach(() => {
    resetLeftOutLogForTests();
    importedPayloads.length = 0;
    storeState.stores = { [STORE]: {} };
    storeState.pending = [];
});

afterEach(() => vi.restoreAllMocks());

describe('a pull whose fold is the config this device holds', () => {
    test('identical copies are not written', async () => {
        const config = { version: 1, tabs: [tab('a'), tab('b')], selectedTabId: 'a' };
        storeState.stores[STORE][KEY] = structuredClone(config);

        const result = await applyPayload(payloadOf({ [KEY]: structuredClone(config) }));

        expect(written()).toEqual({});
        expect(result.merged).toEqual([]);
        expect(result.unchanged[STORE]).toBe(1);
    });

    test('a gist that only selected a tab this device has none selected is not news', async () => {
        storeState.stores[STORE][KEY] = { version: 1, tabs: [tab('a'), tab('b')], selectedTabId: null };

        const result = await applyPayload(
            payloadOf({ [KEY]: { version: 1, tabs: [tab('a'), tab('b')], selectedTabId: 'b' } })
        );

        expect(written()).toEqual({});
        expect(result.merged).toEqual([]);
        expect(storeState.stores[STORE][KEY].selectedTabId).toBeNull();
    });

    test('defaults the fold adds (version, selectedTabId, empty items and tombstone maps) are not news', async () => {
        // Stored by an older build or the upstream script: no version, no selection, a tab with no items list
        storeState.stores[STORE][KEY] = { tabs: [{ id: 'a', name: 'a' }] };

        const result = await applyPayload(
            payloadOf({
                [KEY]: {
                    version: 1,
                    tabs: [{ id: 'a', name: 'a' }],
                    selectedTabId: null,
                    removed: {},
                    removedItems: {},
                },
            })
        );

        expect(written()).toEqual({});
        expect(result.merged).toEqual([]);
        expect(result.unchanged[STORE]).toBe(1);
    });

    test('a gist that lacks a tab this device added keeps the tab and writes nothing', async () => {
        const local = { version: 1, tabs: [tab('a'), tab('mine', { updatedAt: 9 })], selectedTabId: null };
        storeState.stores[STORE][KEY] = structuredClone(local);

        await applyPayload(payloadOf({ [KEY]: { version: 1, tabs: [tab('a')], selectedTabId: null } }));

        expect(written()).toEqual({});
        expect(storeState.stores[STORE][KEY]).toEqual(local);
    });

    test('an edit the panel saved just before the pull is read after the queue lands, and survives', async () => {
        storeState.stores[STORE][KEY] = { version: 1, tabs: [tab('a')], selectedTabId: null };
        // Held by the panel and queued behind the debounce when the pull started
        const held = { version: 1, tabs: [tab('a', { name: 'renamed here', updatedAt: 20 })], selectedTabId: 'a' };
        storeState.pending.push([KEY, held]);

        await applyPayload(payloadOf({ [KEY]: { version: 1, tabs: [tab('a')], selectedTabId: null } }));

        // The gist's older copy is nothing against the held one: not written, so not written over it
        expect(written()).toEqual({});
        expect(storeState.stores[STORE][KEY]).toEqual(held);
    });
});

describe('a pull whose fold is news', () => {
    test('a tab only the gist has is written, with this device’s tabs kept', async () => {
        storeState.stores[STORE][KEY] = { version: 1, tabs: [tab('a')], selectedTabId: null };

        const result = await applyPayload(
            payloadOf({ [KEY]: { version: 1, tabs: [tab('a'), tab('theirs')], selectedTabId: null } })
        );

        expect(written()[KEY].tabs.map((entry) => entry.id)).toEqual(['a', 'theirs']);
        expect(result.merged.map((entry) => entry.key)).toEqual([KEY]);
    });

    test('a newer rename, a deletion record, an extra item and a reorder are each written', async () => {
        const base = { version: 1, tabs: [tab('a'), tab('b')], selectedTabId: null };
        const variants = {
            rename: { ...base, tabs: [tab('a', { name: 'new', updatedAt: 9 }), tab('b')] },
            tombstone: { ...base, removed: { gone: 1 } },
            item: { ...base, tabs: [tab('a', { items: ['/items/a', '/items/b'] }), tab('b')] },
            order: { ...base, tabs: [tab('b'), tab('a')], orderUpdatedAt: 9 },
        };
        for (const [name, incoming] of Object.entries(variants)) {
            importedPayloads.length = 0;
            storeState.stores[STORE][KEY] = structuredClone(base);
            await applyPayload(payloadOf({ [KEY]: structuredClone(incoming) }));
            expect(Object.keys(written()), name).toEqual([KEY]);
        }
    });

    test('a device holding no config takes the gist copy', async () => {
        const incoming = { version: 1, tabs: [tab('a')], selectedTabId: 'a' };

        await applyPayload(payloadOf({ [KEY]: structuredClone(incoming) }));

        expect(written()[KEY]).toEqual(incoming);
    });

    test('of two characters, only the one with news is written', async () => {
        const same = { version: 1, tabs: [tab('a')], selectedTabId: null };
        storeState.stores[STORE][KEY] = structuredClone(same);
        storeState.stores[STORE][OTHER_KEY] = structuredClone(same);

        const result = await applyPayload(
            payloadOf({
                [KEY]: { ...structuredClone(same), selectedTabId: 'a' },
                [OTHER_KEY]: { ...structuredClone(same), tabs: [tab('a'), tab('new')] },
            })
        );

        expect(Object.keys(written())).toEqual([OTHER_KEY]);
        expect(result.merged.map((entry) => entry.key)).toEqual([OTHER_KEY]);
        expect(result.unchanged[STORE]).toBe(1);
    });
});
