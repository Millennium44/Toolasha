/**
 * A tab deleted by hand stays deleted when another copy still holds it UNSTAMPED (pre-3.22.0).
 *
 * The tombstone alone lost this: `applyTombstones` keeps an unstamped tab and drops the tombstone, so a pull of a
 * gist (or another device's copy) still holding the tab unstamped re-added it next to its stamped twin, and every
 * character switch (which pulls) brought the duplicates back. `removeTab` now also writes a removal record that names
 * exactly the removed ids, and the fold deletes every copy of them stamped before it, unstamped ones included.
 *
 * The worst failure is the opposite one: a tab the player did not delete going missing. Those cases are tested here
 * too, and a duplicate surviving is the mild outcome.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const land = ({ key, value, store, fold }) => {
        const map = storeFor(store);
        const stored = map.has(key) ? structuredClone(map.get(key)) : undefined;
        map.set(key, structuredClone(fold ? fold(stored, value) : value));
    };
    return {
        stores,
        storeFor,
        reset: () => stores.clear(),
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings', _immediate = false, options = {}) => {
            land({ key, value, store, fold: options?.fold ?? null });
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1', getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { loadConfig, saveConfig, adoptConfigBaseline, flushConfigWrites, removeTab, importLayout, _resetConfigRecords } =
    await import('./custom-tabs-data.js');
const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');

const KEY = 'char1_inventoryTabs_config';
const registration = mergeForKey('settings', KEY);
const T0 = Date.now() - 24 * 60 * 60 * 1000;

/** A tab as stored; `stamp: null` is a pre-3.22.0 tab with no `updatedAt` */
function tab(id, name, { stamp = T0, items = [], children = [] } = {}) {
    const out = { id, name, color: null, open: false, items, children };
    if (stamp !== null) out.updatedAt = stamp;
    return out;
}

const cfg = (tabs, extra = {}) => ({ version: 1, selectedTabId: null, tabs, ...extra });
const write = (config) => storageMock.storeFor('settings').set(KEY, structuredClone(config));
const stored = () => structuredClone(storageMock.storeFor('settings').get(KEY));
const ids = (config) => (config?.tabs || []).map((t) => t.id);

/** The panel's start-up: load, then take what it read as the copy it holds */
async function panelLoads() {
    const config = await loadConfig('char1');
    adoptConfigBaseline('char1', config);
    return config;
}

/** A fresh page load: no record held over from the session that wrote the store */
async function reload() {
    _resetConfigRecords();
    return loadConfig('char1');
}

// Two same-named copies: A1 written before stamps existed, A2 a stamped one (the duplicate the player sees)
const A1 = () => tab('a1', 'Gear', { stamp: null, items: ['/items/sword'] });
const A2 = () => tab('a2', 'Gear', { items: ['/items/sword'] });

beforeEach(() => {
    storageMock.reset();
    _resetConfigRecords();
});

describe('a hand deletion of an unstamped tab', () => {
    test('survives the next pull of a gist that still holds it unstamped', async () => {
        write(cfg([A1(), A2()]));
        const held = await panelLoads();
        await saveConfig('char1', removeTab(held, 'a1'));
        await flushConfigWrites();
        expect(ids(stored())).toEqual(['a2']);

        // The pull on the next character switch: the gist still has the copy from before the deletion
        const gist = cfg([A1(), A2()]);
        write(registration.foldPull(stored(), gist));

        expect(ids(await reload())).toEqual(['a2']);
        // And the deletion is still on file for the pull after that
        write(registration.foldPull(stored(), structuredClone(gist)));
        expect(ids(await reload())).toEqual(['a2']);
    });

    test('reaches the other device when this one pushes and that one pulls', async () => {
        // The other device's copy (and the gist it last pushed) holds A1 unstamped
        const otherDevice = cfg([A1(), A2()]);
        write(cfg([A1(), A2()]));
        const held = await panelLoads();
        await saveConfig('char1', removeTab(held, 'a1'));
        await flushConfigWrites();

        // The push folds this device's copy over the gist's, in either argument order
        const uploaded = registration.merge(structuredClone(otherDevice), stored());
        expect(ids(uploaded)).toEqual(['a2']);
        expect(ids(registration.merge(stored(), structuredClone(otherDevice)))).toEqual(['a2']);

        // The other device pulls it over its own copy
        storageMock.reset();
        write(registration.foldPull(structuredClone(otherDevice), uploaded));
        expect(ids(await reload())).toEqual(['a2']);
    });

    test('takes the nested tabs of a removed unstamped parent with it', async () => {
        const parent = () => tab('p', 'Parent', { stamp: null, children: [tab('k', 'Kid', { stamp: null })] });
        write(cfg([parent(), A2()]));
        const held = await panelLoads();
        await saveConfig('char1', removeTab(held, 'p'));
        await flushConfigWrites();

        write(registration.foldPull(stored(), cfg([parent(), A2()])));
        expect(ids(await reload())).toEqual(['a2']);
    });
});

describe('what the player did not delete is never lost', () => {
    test('an unstamped tab only the remote has is kept', async () => {
        write(cfg([A1(), A2()]));
        const held = await panelLoads();
        await saveConfig('char1', removeTab(held, 'a1'));
        await flushConfigWrites();

        const remote = cfg([A1(), A2(), tab('c', 'Cheese', { stamp: null, items: ['/items/cheese'] })]);
        write(registration.foldPull(stored(), remote));
        const after = await reload();
        expect(ids(after)).toEqual(['a2', 'c']);
        expect(after.tabs.find((t) => t.id === 'c').items).toEqual(['/items/cheese']);
    });

    test('a copy edited on another device after the deletion survives it', async () => {
        write(cfg([A1(), A2()]));
        const held = await panelLoads();
        await saveConfig('char1', removeTab(held, 'a1'));
        await flushConfigWrites();

        const edited = { ...A1(), name: 'Gear (renamed later)', updatedAt: Date.now() + 60_000 };
        write(registration.foldPull(stored(), cfg([edited, A2()])));
        expect(ids(await reload()).sort()).toEqual(['a1', 'a2']);
    });

    test('a removal record names only the removed subtree', () => {
        const before = cfg([A1(), A2(), tab('b', 'Bars', { stamp: null })]);
        const after = removeTab(before, 'a1');
        const records = Object.values(after.clearedAll);
        expect(records).toHaveLength(1);
        expect(records[0].ids).toEqual(['a1']);
        expect(records[0].prior).toEqual([]);
        // A second removal adds its own record rather than editing the first
        const twice = removeTab(after, 'b');
        expect(Object.values(twice.clearedAll).map((r) => r.ids)).toEqual([['a1'], ['b']]);
    });

    test('a bare tombstone map naming most tabs is still refused by the mass-delete cap', () => {
        const now = Date.now();
        const local = cfg(['w', 'x', 'y', 'z'].map((id) => tab(id, id.toUpperCase())));
        const incoming = cfg([], { removed: { w: now, x: now, y: now } });
        expect(ids(registration.foldPull(local, incoming))).toEqual(['w', 'x', 'y', 'z']);
    });

    test('a bare tombstone still spares an unstamped tab (peer tombstones are not trusted with legacy tabs)', () => {
        const local = cfg([A1(), A2()]);
        const incoming = cfg([A2()], { removed: { a1: Date.now() } });
        expect(ids(registration.foldPull(local, incoming)).sort()).toEqual(['a1', 'a2']);
    });
});

describe('an import over an existing layout', () => {
    test('a fold with the pre-import copy leaves only the imported set', async () => {
        const preImport = cfg([A1(), tab('b', 'Bars', { items: ['/items/bar'] })]);
        write(preImport);
        const held = await panelLoads();
        const file = cfg([A1(), tab('b', 'Bars', { stamp: null, items: ['/items/bar'] })]);
        const imported = importLayout(held, file);
        expect(ids(imported)).not.toContain('a1');
        await saveConfig('char1', imported);
        await flushConfigWrites();

        const names = (config) => config.tabs.map((t) => t.name);
        for (const folded of [
            registration.foldPull(stored(), structuredClone(preImport)),
            registration.merge(structuredClone(preImport), stored()),
            registration.merge(stored(), structuredClone(preImport)),
        ]) {
            expect(names(folded)).toEqual(['Gear', 'Bars']);
            expect(ids(folded)).toEqual(ids(imported));
        }
    });

    test('keeps the replaced layout’s own deletions', () => {
        const removedAt = Date.now() - 1000;
        const current = cfg([A2()], { removed: { gone: removedAt } });
        const imported = importLayout(current, cfg([tab('n', 'New')]));
        expect(imported.removed.gone).toBe(removedAt);
        expect(imported.removed.a2).toBeGreaterThan(0);
        // The file's own tabs are named by no record
        const named = Object.values(imported.clearedAll).flatMap((r) => r.ids);
        for (const id of ids(imported)) expect(named).not.toContain(id);
    });

    test('over no layout at all is just the sanitized file', () => {
        const imported = importLayout(null, cfg([tab('n', 'New')]));
        expect(imported.tabs.map((t) => t.name)).toEqual(['New']);
        expect(imported.clearedAll).toBeUndefined();
    });
});
