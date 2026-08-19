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
    loadConfig,
    saveConfig,
    flushConfigWrites,
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
