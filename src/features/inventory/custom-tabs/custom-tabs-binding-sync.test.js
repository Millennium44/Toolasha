/**
 * @vitest-environment happy-dom
 *
 * The binding-enhancement sync scans `dataManager.characterItems` for the
 * highest copy of a bound item. Equipped copies sit in that array without a
 * reliable `count` field, and the scan used to require `count > 0` — so the
 * actually-worn +20 was invisible, and a lower duplicate in the bag decided
 * what level the bindings (and, through updateEnhancementLevel, the stored
 * snapshot) were synced to. Same family as the highestOwnedEnhancements fix in
 * loadout-snapshot.js: only an explicit zero (a consumed stack) is a non-owner.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        storeFor,
        reset() {
            stores.clear();
        },
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
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async () => true),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const dm = vi.hoisted(() => {
    const listeners = new Map();
    return {
        charId: 'char1',
        characterItems: [],
        getCurrentCharacterId: () => dm.charId,
        getCurrentCharacterName: () => null,
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({}),
        on: (event, fn) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(fn);
        },
        off: (event, fn) => listeners.get(event)?.delete(fn),
        listeners,
    };
});

const loadoutSnapshotMock = vi.hoisted(() => ({
    snapshots: {},
    onUpdate: vi.fn(),
    offUpdate: vi.fn(),
    updateEnhancementLevel: vi.fn(),
}));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({ default: dm }));
vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: { onModeChange: () => () => {} } }));
vi.mock('../inventory-badge-manager.js', () => ({
    default: { currentInventoryElem: null, renderAllBadges: vi.fn(async () => {}) },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: loadoutSnapshotMock }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async (id) => id,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');

const SWORD = '/items/sword';

/** A stored config with one tab whose binding holds the sword at +5 */
function boundConfig() {
    return {
        version: 1,
        selectedTabId: null,
        tabs: [
            {
                id: 'gear',
                name: 'Gear',
                children: [],
                items: [`${SWORD}+5`],
                loadoutBindings: { Boss: [`${SWORD}+5`] },
                updatedAt: Date.now(),
            },
        ],
    };
}

let ui;

beforeEach(async () => {
    storageMock.reset();
    dm.listeners.clear();
    dm.charId = 'char1';
    dm.characterItems = [];
    loadoutSnapshotMock.updateEnhancementLevel.mockClear();
    loadoutSnapshotMock.snapshots = {
        s1: {
            name: 'Boss',
            useExactEnhancement: false,
            equipment: [{ itemHrid: SWORD, enhancementLevel: 5 }],
        },
    };
    storageMock.storeFor('settings').set('char1_inventoryTabs_config', boundConfig());
    ui = new CustomTabsUI();
    await ui.initialize();
});

afterEach(() => {
    ui?.cleanup();
    ui = null;
    loadoutSnapshotMock.snapshots = {};
});

describe('binding enhancement sync vs equipped copies', () => {
    test('an equipped copy with no count field still decides the highest owned', () => {
        // The worn +20 has no count; a +5 duplicate sits in the bag. The sync
        // must follow the worn copy, not the duplicate.
        dm.characterItems = [
            { itemHrid: SWORD, enhancementLevel: 20, itemLocationHrid: '/item_locations/main_hand' },
            { itemHrid: SWORD, enhancementLevel: 5, count: 1 },
        ];

        ui._checkBindingEnhancements({ endCharacterItems: [{ itemHrid: SWORD, enhancementLevel: 20 }] });

        expect(loadoutSnapshotMock.updateEnhancementLevel).toHaveBeenCalledWith(SWORD, 20);
        expect(ui._config.tabs[0].loadoutBindings.Boss).toContain(`${SWORD}+20`);
    });

    test('an explicit zero count is still a consumed stack, not an owner', () => {
        dm.characterItems = [
            { itemHrid: SWORD, enhancementLevel: 20, count: 0 },
            { itemHrid: SWORD, enhancementLevel: 7, count: 1 },
        ];

        ui._checkBindingEnhancements({ endCharacterItems: [{ itemHrid: SWORD, enhancementLevel: 7 }] });

        expect(loadoutSnapshotMock.updateEnhancementLevel).toHaveBeenCalledWith(SWORD, 7);
        expect(loadoutSnapshotMock.updateEnhancementLevel).not.toHaveBeenCalledWith(SWORD, 20);
    });
});
