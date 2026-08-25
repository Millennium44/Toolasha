/**
 * Tests for custom tabs loadout binding sync
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
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

const {
    syncLoadoutBinding,
    cleanOrphanedBindings,
    getBaseHrid,
    collectItemsAboveTab,
    LINEBREAK_HRID,
    TOMBSTONE_MAX_AGE_MS,
    loadConfig,
    saveConfig,
    flushConfigWrites,
    addTab,
    removeTab,
    renameTab,
    setTabColor,
    moveTab,
    addItem,
    insertItem,
    moveItem,
    addLineBreak,
    reorderItem,
    removeItem,
    removeItemAtIndex,
    setTabOpen,
    setAllTabsOpen,
    findTab,
} = await import('./custom-tabs-data.js');

function buildConfig(tab) {
    return {
        version: 1,
        selectedTabId: null,
        tabs: [{ children: [], ...tab }],
    };
}

describe('getBaseHrid', () => {
    test('strips numeric enhancement suffix', () => {
        expect(getBaseHrid('/items/sword+7')).toBe('/items/sword');
    });

    test('leaves plain hrids untouched', () => {
        expect(getBaseHrid('/items/sword')).toBe('/items/sword');
    });
});

describe('collectItemsAboveTab', () => {
    const config = {
        version: 1,
        selectedTabId: null,
        tabs: [
            { id: 'currency', items: ['/items/token', LINEBREAK_HRID], children: [] },
            {
                id: 'loot',
                items: ['/items/hat'],
                children: [{ id: 'loot-child', items: ['/items/ring+5'], children: [] }],
            },
            { id: 'resources', items: ['/items/log'], children: [] },
            { id: 'junk', items: ['/items/scrap'], children: [] },
        ],
    };

    test('collects items from every tab above, not the tab itself or tabs below', () => {
        const above = collectItemsAboveTab(config, 'resources');
        expect(above).toEqual(new Set(['/items/token', '/items/hat', '/items/ring+5']));
    });

    test('a child tab sees its parent and earlier tabs as above', () => {
        const above = collectItemsAboveTab(config, 'loot-child');
        expect(above).toEqual(new Set(['/items/token', '/items/hat']));
    });

    test('the first tab has nothing above it', () => {
        expect(collectItemsAboveTab(config, 'currency').size).toBe(0);
    });

    test('excludes line break sentinels', () => {
        expect(collectItemsAboveTab(config, 'loot').has(LINEBREAK_HRID)).toBe(false);
    });
});

describe('syncLoadoutBinding', () => {
    test('removes an item replaced in the loadout', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/ring_a+5', '/items/hat'],
            loadoutBindings: { Zone1: ['/items/ring_a+5', '/items/hat'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', [
            '/items/ring_b+5',
            '/items/hat',
        ]);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).not.toContain('/items/ring_a+5');
        expect(next.tabs[0].items).toContain('/items/ring_b+5');
    });

    test('keeps a replaced item still referenced by another binding on the tab', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/ring_a+5', '/items/hat'],
            loadoutBindings: {
                Zone1: ['/items/ring_a+5', '/items/hat'],
                Zone2: ['/items/ring_a+5'],
            },
        });

        // Zone1 replaces ring_a with ring_b; Zone2 still uses ring_a
        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', [
            '/items/ring_b+5',
            '/items/hat',
        ]);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/ring_a+5');
        expect(next.tabs[0].items).toContain('/items/ring_b+5');
        expect(next.tabs[0].loadoutBindings.Zone2).toContain('/items/ring_a+5');
    });

    test('keeps an old enhancement level still referenced by another binding', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8'],
            loadoutBindings: {
                Zone1: ['/items/sword+8'],
                Zone2: ['/items/sword+8'],
            },
        });

        // Zone1 bumps the sword to +10; Zone2 still uses the +8
        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/sword+8');
        expect(next.tabs[0].items).toContain('/items/sword+10');
    });

    test('swaps enhancement level in place when no other binding references it', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8'],
            loadoutBindings: { Zone1: ['/items/sword+8'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/sword+10']);
    });

    test('does not duplicate when the new level already exists in the tab', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/sword+8', '/items/sword+10'],
            loadoutBindings: { Zone1: ['/items/sword+8'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/sword+10']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/sword+10']);
    });

    test('appends items newly added to the loadout', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat'],
            loadoutBindings: { Zone1: ['/items/hat'] },
        });

        const { config: next, changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/hat', '/items/boots+3']);

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toContain('/items/boots+3');
        expect(next.tabs[0].loadoutBindings.Zone1).toEqual(['/items/hat', '/items/boots+3']);
    });

    test('reports no change when the snapshot matches the binding', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat'],
            loadoutBindings: { Zone1: ['/items/hat'] },
        });

        const { changed } = syncLoadoutBinding(config, 'tab1', 'Zone1', ['/items/hat']);

        expect(changed).toBe(false);
    });
});

describe('cleanOrphanedBindings', () => {
    test('removes orphaned binding items unless still bound elsewhere', () => {
        const config = buildConfig({
            id: 'tab1',
            items: ['/items/hat', '/items/ring_a+5'],
            loadoutBindings: {
                Deleted: ['/items/hat', '/items/ring_a+5'],
                Kept: ['/items/hat'],
            },
        });

        const { config: next, changed } = cleanOrphanedBindings(config, 'tab1', new Set(['Kept']));

        expect(changed).toBe(true);
        expect(next.tabs[0].items).toEqual(['/items/hat']);
        expect(next.tabs[0].loadoutBindings.Deleted).toBeUndefined();
        expect(next.tabs[0].loadoutBindings.Kept).toEqual(['/items/hat']);
    });
});

describe('the stored config', () => {
    const KEY = 'char1_inventoryTabs_config';
    const stored = () => storageMock.storeFor('settings').get(KEY);
    const tab = (id, items = []) => ({ id, name: id, items, children: [] });

    beforeEach(() => {
        storageMock.reset();
    });

    test('lives under the key it has always had, and reads back what was saved', async () => {
        await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: 'a' });
        await flushConfigWrites();
        expect(stored().tabs.map((t) => t.id)).toEqual(['a']);

        const config = await loadConfig('char1');
        expect(config).toEqual({ version: 1, tabs: [tab('a')], selectedTabId: 'a' });
    });

    test('a character with nothing stored starts from the default', async () => {
        expect(await loadConfig('char1')).toEqual({ version: 1, tabs: [], selectedTabId: null });
        expect(await loadConfig('')).toEqual({ version: 1, tabs: [], selectedTabId: null });
    });

    test('a load that cannot be made keeps the config in hand rather than blanking it', async () => {
        storageMock.storeFor('settings').set(KEY, { version: 1, tabs: [tab('a')], selectedTabId: null });
        const first = await loadConfig('char1');
        expect(first.tabs).toHaveLength(1);

        storageMock.unavailable = true;
        const again = await loadConfig('char1');
        expect(again.tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('a save over a store that cannot be read is skipped, and what is stored stays', async () => {
        storageMock.storeFor('settings').set(KEY, { version: 1, tabs: [tab('a')], selectedTabId: null });
        storageMock.unavailable = true;
        await loadConfig('char1');
        expect(await saveConfig('char1', { version: 1, tabs: [], selectedTabId: null })).toBe(false);

        storageMock.unavailable = false;
        expect(stored().tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('a save before the config was read back loses no stored tab', async () => {
        storageMock.storeFor('settings').set(KEY, { version: 1, tabs: [tab('a')], selectedTabId: null });
        storageMock.unavailable = true;
        await loadConfig('char1');
        storageMock.unavailable = false;

        // Built against an empty-looking config, because the read never landed
        await saveConfig('char1', { version: 1, tabs: [tab('b')], selectedTabId: 'b' });
        await flushConfigWrites();

        expect(
            stored()
                .tabs.map((t) => t.id)
                .sort()
        ).toEqual(['a', 'b']);
        expect(stored().selectedTabId).toBe('b');
    });

    test('after a readable load a removed tab stays removed', async () => {
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            tabs: [tab('a'), tab('b')],
            selectedTabId: null,
        });
        const config = await loadConfig('char1');
        await saveConfig('char1', { ...config, tabs: config.tabs.filter((t) => t.id !== 'a') });
        await flushConfigWrites();

        expect(stored().tabs.map((t) => t.id)).toEqual(['b']);
    });

    test('once storage is back, the next save lands', async () => {
        storageMock.unavailable = true;
        await loadConfig('char1');
        expect(await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: null })).toBe(false);

        storageMock.unavailable = false;
        expect(await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: null })).toBe(true);
        expect(stored().tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('each character has its own config', async () => {
        await saveConfig('char1', { version: 1, tabs: [tab('a')], selectedTabId: null });
        await saveConfig('char2', { version: 1, tabs: [tab('z')], selectedTabId: null });
        await flushConfigWrites();

        expect((await loadConfig('char1')).tabs.map((t) => t.id)).toEqual(['a']);
        expect((await loadConfig('char2')).tabs.map((t) => t.id)).toEqual(['z']);
        expect(storageMock.storeFor('settings').has('char2_inventoryTabs_config')).toBe(true);
    });
});

describe('the sync merge', () => {
    test('a pull folds the gist copy in instead of replacing the key', async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        const registration = mergeForKey('settings', 'char1_inventoryTabs_config');
        expect(registration).toBeTruthy();

        const local = {
            version: 1,
            selectedTabId: 'b',
            tabs: [
                { id: 'a', name: 'Ores (renamed here)', items: ['/items/iron_ore'] },
                { id: 'b', name: 'New tab the gist never saw', items: [] },
            ],
        };
        const incoming = {
            version: 1,
            selectedTabId: 'a',
            tabs: [
                { id: 'a', name: 'Ores', items: [] },
                { id: 'c', name: 'Tab only the other device has', items: [] },
            ],
        };

        const merged = registration.merge(local, incoming);
        const ids = merged.tabs.map((tab) => tab.id).sort();

        // Union keeps everything either side has; the local copy wins per id
        expect(ids).toEqual(['a', 'b', 'c']);
        expect(merged.tabs.find((tab) => tab.id === 'a').name).toBe('Ores (renamed here)');
        expect(merged.selectedTabId).toBe('b');
    });

    test('a blank local side adopts the gist copy whole', async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        const registration = mergeForKey('settings', 'char9_inventoryTabs_config');

        const merged = registration.merge(
            { version: 1, tabs: [], selectedTabId: null },
            { version: 1, tabs: [{ id: 'x', name: 'Kept', items: [] }], selectedTabId: 'x' }
        );

        expect(merged.tabs.map((tab) => tab.id)).toEqual(['x']);
        expect(merged.selectedTabId).toBe('x');
    });
});

describe('modification stamps', () => {
    const node = (id, extra = {}) => ({
        id,
        name: id,
        color: null,
        open: false,
        items: [],
        children: [],
        ...extra,
    });
    const base = () => ({
        version: 1,
        selectedTabId: null,
        tabs: [node('a', { items: ['/items/hat', '/items/boots'] }), node('b')],
    });
    const stampOf = (config, id) => findTab(config, id)?.tab.updatedAt;

    test.each([
        ['renameTab', (c) => renameTab(c, 'a', 'Renamed')],
        ['setTabColor', (c) => setTabColor(c, 'a', '#fff')],
        ['addItem', (c) => addItem(c, 'a', '/items/ore')],
        ['insertItem', (c) => insertItem(c, 'a', '/items/ore', 0)],
        ['addLineBreak', (c) => addLineBreak(c, 'a')],
        ['reorderItem', (c) => reorderItem(c, 'a', 0, 1)],
        ['removeItem', (c) => removeItem(c, 'a', '/items/hat')],
        ['removeItemAtIndex', (c) => removeItemAtIndex(c, 'a', 0)],
    ])('%s stamps the tab it changed', (_name, mutate) => {
        const before = Date.now();
        const next = mutate(base());
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
        // Untouched tabs stay as they were
        expect(stampOf(next, 'b')).toBeUndefined();
    });

    test('addTab stamps the new tab, and its parent when it is nested', () => {
        const before = Date.now();
        const { config: rooted, tabId } = addTab(base(), null, 'Root tab');
        expect(stampOf(rooted, tabId)).toBeGreaterThanOrEqual(before);
        expect(stampOf(rooted, 'a')).toBeUndefined();

        const { config: nested, tabId: childId } = addTab(base(), 'a', 'Child');
        expect(stampOf(nested, childId)).toBeGreaterThanOrEqual(before);
        expect(stampOf(nested, 'a')).toBeGreaterThanOrEqual(before);
    });

    test('moveItem stamps both the source and the target tab', () => {
        const before = Date.now();
        const next = moveItem(base(), 'a', 'b', '/items/hat');
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
        expect(stampOf(next, 'b')).toBeGreaterThanOrEqual(before);
    });

    test('an edit to a nested tab stamps the root that carries it', () => {
        const { config, tabId } = addTab(base(), 'a', 'Child');
        const before = Date.now();
        const next = renameTab({ ...config, tabs: config.tabs.map((t) => ({ ...t })) }, tabId, 'New name');
        expect(stampOf(next, tabId)).toBeGreaterThanOrEqual(before);
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
    });

    test('moveTab stamps the list, not the tab', () => {
        const before = Date.now();
        const next = moveTab(base(), 'b', 0);
        expect(next.tabs.map((t) => t.id)).toEqual(['b', 'a']);
        expect(next.orderUpdatedAt).toBeGreaterThanOrEqual(before);
        expect(stampOf(next, 'a')).toBeUndefined();
        expect(stampOf(next, 'b')).toBeUndefined();
    });

    test('opening and closing tabs is not a modification', () => {
        const opened = setTabOpen(base(), 'a', true);
        expect(opened.tabs[0].open).toBe(true);
        expect(stampOf(opened, 'a')).toBeUndefined();
        expect(opened.orderUpdatedAt).toBeUndefined();

        const all = setAllTabsOpen(base(), true);
        expect(all.tabs.every((t) => t.updatedAt === undefined)).toBe(true);
    });

    test('removeTab records a tombstone for the tab and its descendants', () => {
        const { config: withChild, tabId: childId } = addTab(base(), 'a', 'Child');
        const before = Date.now();
        const next = removeTab(withChild, 'a');

        expect(next.tabs.map((t) => t.id)).toEqual(['b']);
        expect(next.removed.a).toBeGreaterThanOrEqual(before);
        expect(next.removed[childId]).toBeGreaterThanOrEqual(before);
        expect(next.removed.b).toBeUndefined();
    });

    test('removeTab of a nested tab stamps the parent that lost it', () => {
        const { config: withChild, tabId: childId } = addTab(base(), 'a', 'Child');
        const before = Date.now();
        const next = removeTab(withChild, childId);
        expect(findTab(next, childId)).toBeNull();
        expect(stampOf(next, 'a')).toBeGreaterThanOrEqual(before);
        expect(next.removed[childId]).toBeGreaterThanOrEqual(before);
    });

    test('a re-created id outlives its own tombstone', () => {
        const removedConfig = removeTab(base(), 'a');
        const { config, tabId } = addTab(removedConfig, null, 'Fresh');
        expect(config.removed[tabId]).toBeUndefined();
        expect(config.removed.a).toBeDefined();
    });
});

describe('the merge with stamps and tombstones', () => {
    const tab = (id, extra = {}) => ({ id, name: id, items: [], children: [], ...extra });

    let merge;
    beforeEach(async () => {
        const { mergeForKey } = await import('../../../utils/sync-merge-registry.js');
        // The registry hands (local, incoming) and local is the side that wins ties
        merge = mergeForKey('settings', 'char1_inventoryTabs_config').merge;
    });

    test('a newer remote rename beats an older local copy', () => {
        const local = { version: 1, tabs: [tab('a', { name: 'Here', updatedAt: 100 })], selectedTabId: null };
        const incoming = { version: 1, tabs: [tab('a', { name: 'There', updatedAt: 200 })], selectedTabId: null };
        expect(merge(local, incoming).tabs[0].name).toBe('There');
    });

    test('an older remote rename loses', () => {
        const local = { version: 1, tabs: [tab('a', { name: 'Here', updatedAt: 300 })], selectedTabId: null };
        const incoming = { version: 1, tabs: [tab('a', { name: 'There', updatedAt: 200 })], selectedTabId: null };
        expect(merge(local, incoming).tabs[0].name).toBe('Here');
    });

    test('a stamped copy beats an unstamped one, whichever side it is on', () => {
        const stamped = { version: 1, tabs: [tab('a', { name: 'Stamped', updatedAt: 5 })], selectedTabId: null };
        const bare = { version: 1, tabs: [tab('a', { name: 'Bare' })], selectedTabId: null };
        expect(merge(bare, stamped).tabs[0].name).toBe('Stamped');
        expect(merge(stamped, bare).tabs[0].name).toBe('Stamped');
    });

    test('two unstamped copies keep ours', () => {
        const local = { version: 1, tabs: [tab('a', { name: 'Ours' })], selectedTabId: null };
        const incoming = { version: 1, tabs: [tab('a', { name: 'Theirs' })], selectedTabId: null };
        expect(merge(local, incoming).tabs[0].name).toBe('Ours');
    });

    test('a deletion newer than the tab sticks, in both directions', () => {
        const deleted = { version: 1, tabs: [], selectedTabId: null, removed: { a: 500 } };
        const carrier = { version: 1, tabs: [tab('a', { updatedAt: 100 })], selectedTabId: null };

        // Deleted locally, the other device still carries it
        const kept = merge(deleted, carrier);
        expect(kept.tabs).toEqual([]);
        expect(kept.removed).toEqual({ a: 500 });

        // Deleted remotely, this device still carries it — same answer
        const swapped = merge(carrier, deleted);
        expect(swapped.tabs).toEqual([]);
        expect(swapped.removed).toEqual({ a: 500 });
    });

    test('a tab edited after the deletion survives and drops the tombstone', () => {
        const deleted = { version: 1, tabs: [], selectedTabId: null, removed: { a: 500 } };
        const revived = { version: 1, tabs: [tab('a', { name: 'Back', updatedAt: 900 })], selectedTabId: null };

        for (const merged of [merge(deleted, revived), merge(revived, deleted)]) {
            expect(merged.tabs.map((t) => t.id)).toEqual(['a']);
            expect(merged.tabs[0].name).toBe('Back');
            expect(merged.removed).toBeUndefined();
        }
    });

    test('a tombstone reaches a nested tab too', () => {
        const carrier = {
            version: 1,
            selectedTabId: null,
            tabs: [tab('root', { updatedAt: 900, children: [tab('kid', { updatedAt: 100 })] })],
        };
        const deleted = { version: 1, tabs: [], selectedTabId: null, removed: { kid: 500 } };
        const merged = merge(carrier, deleted);
        expect(merged.tabs.map((t) => t.id)).toEqual(['root']);
        expect(merged.tabs[0].children).toEqual([]);
    });

    test('tombstones union to the newest deletion per id', () => {
        const older = { version: 1, tabs: [], selectedTabId: null, removed: { a: 100, b: 700 } };
        const newer = { version: 1, tabs: [], selectedTabId: null, removed: { a: 400 } };
        expect(merge(older, newer).removed).toEqual({ a: 400, b: 700 });
    });

    test('order comes from the side with the newer orderUpdatedAt', () => {
        const local = {
            version: 1,
            selectedTabId: null,
            orderUpdatedAt: 100,
            tabs: [tab('a'), tab('b'), tab('c')],
        };
        const incoming = {
            version: 1,
            selectedTabId: null,
            orderUpdatedAt: 900,
            tabs: [tab('c'), tab('b'), tab('a'), tab('d')],
        };

        const merged = merge(local, incoming);
        // Remote reordered last, and the id only it has appends after
        expect(merged.tabs.map((t) => t.id)).toEqual(['c', 'b', 'a', 'd']);
        expect(merged.orderUpdatedAt).toBe(900);

        // The other way round: local reordered last
        const localLatest = { ...local, orderUpdatedAt: 1000 };
        expect(merge(localLatest, incoming).tabs.map((t) => t.id)).toEqual(['a', 'b', 'c', 'd']);
    });

    test('without orderUpdatedAt the order is stored-then-new, as it always was', () => {
        const local = { version: 1, selectedTabId: null, tabs: [tab('b'), tab('z')] };
        const incoming = { version: 1, selectedTabId: null, tabs: [tab('a'), tab('b')] };
        // mergeConfigs(incoming, local): incoming is "stored", so its order leads
        expect(merge(local, incoming).tabs.map((t) => t.id)).toEqual(['a', 'b', 'z']);
    });

    test('selectedTabId falls back when its tab was tombstoned', () => {
        const local = { version: 1, selectedTabId: 'a', tabs: [tab('a', { updatedAt: 100 })] };
        const incoming = { version: 1, selectedTabId: 'b', tabs: [tab('b')], removed: { a: 500 } };
        expect(merge(local, incoming).selectedTabId).toBe('b');

        const nothingLeft = { version: 1, selectedTabId: 'b', tabs: [], removed: { a: 500, b: 500 } };
        expect(merge(local, nothingLeft).selectedTabId).toBeNull();
    });

    test('a config with none of the new fields merges to exactly the old shape', () => {
        const local = {
            version: 1,
            selectedTabId: 'b',
            tabs: [
                { id: 'a', name: 'Ores (renamed here)', items: ['/items/iron_ore'] },
                { id: 'b', name: 'New tab the gist never saw', items: [] },
            ],
        };
        const incoming = {
            version: 1,
            selectedTabId: 'a',
            tabs: [
                { id: 'a', name: 'Ores', items: [] },
                { id: 'c', name: 'Tab only the other device has', items: [] },
            ],
        };

        const merged = merge(local, incoming);
        expect(merged).toEqual({
            version: 1,
            selectedTabId: 'b',
            // Stored order leads, ids only the local side has append after
            tabs: [local.tabs[0], incoming.tabs[1], local.tabs[1]],
        });
        expect(Object.keys(merged).sort()).toEqual(['selectedTabId', 'tabs', 'version']);
    });
});

describe('tombstone pruning', () => {
    const KEY = 'char1_inventoryTabs_config';

    beforeEach(() => {
        storageMock.reset();
    });

    test('a load forgets deletions older than the max age and keeps the rest', async () => {
        const now = Date.now();
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [],
            removed: { stale: now - TOMBSTONE_MAX_AGE_MS - 1000, fresh: now - 1000 },
        });

        const config = await loadConfig('char1');
        expect(config.removed).toEqual({ fresh: now - 1000 });
    });

    test('a load with every tombstone expired drops the map entirely', async () => {
        const now = Date.now();
        storageMock.storeFor('settings').set(KEY, {
            version: 1,
            selectedTabId: null,
            tabs: [],
            removed: { stale: now - TOMBSTONE_MAX_AGE_MS - 1 },
        });

        expect(await loadConfig('char1')).toEqual({ version: 1, selectedTabId: null, tabs: [] });
    });
});
