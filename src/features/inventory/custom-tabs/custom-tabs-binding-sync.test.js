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
        getItemDetails: () => null,
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
    default: { currentInventoryElem: null, onRepriced: () => () => {}, renderAllBadges: vi.fn(async () => {}) },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: loadoutSnapshotMock }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async (id) => id,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');
const { addItem, removeItem, flushConfigWrites } = await import('./custom-tabs-data.js');

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

describe('removing a loadout-bound item by hand', () => {
    const SHIELD = '/items/shield';

    beforeEach(async () => {
        ui.cleanup();
        storageMock.reset();
        const config = boundConfig();
        config.tabs[0].items = [`${SWORD}+5`, SHIELD];
        config.tabs[0].loadoutBindings = { Boss: [`${SWORD}+5`, SHIELD] };
        storageMock.storeFor('settings').set('char1_inventoryTabs_config', config);
        loadoutSnapshotMock.snapshots.s1.equipment.push({ itemHrid: SHIELD, enhancementLevel: 0 });
        ui = new CustomTabsUI();
        await ui.initialize();
    });

    test('stays removed when the loadout snapshot next syncs', () => {
        // The binding is the loadout as last seen, not the player's selection: dropping the item
        // from it made the next sync read the shield as newly added to the loadout
        const list = document.createElement('div');
        document.body.appendChild(list);
        ui._renderAssignedItems(list, 'gear');
        const shieldRow = [...list.querySelectorAll('.toolasha-ct-assigned-item')][1];
        shieldRow.querySelector('button[title="Remove"]').click();
        expect(ui._config.tabs[0].items).toEqual([`${SWORD}+5`]);

        ui._onLoadoutSnapshotUpdate();

        expect(ui._config.tabs[0].items).toEqual([`${SWORD}+5`]);
        list.remove();
    });

    /** Remove the shield by hand, then have the loadout drop it too */
    function removeByHandThenFromLoadout() {
        ui._config = removeItem(ui._config, 'gear', SHIELD);
        loadoutSnapshotMock.snapshots.s1.equipment = [{ itemHrid: SWORD, enhancementLevel: 5 }];
        ui._onLoadoutSnapshotUpdate();
    }

    test('the loadout dropping a hand-removed item is remembered, so adding it back counts as new', async () => {
        removeByHandThenFromLoadout();
        expect(ui._config.tabs[0].loadoutBindings.Boss).toEqual([`${SWORD}+5`]);
        await flushConfigWrites();
        const stored = storageMock.storeFor('settings').get('char1_inventoryTabs_config');
        expect(stored.tabs[0].loadoutBindings.Boss).toEqual([`${SWORD}+5`]);

        loadoutSnapshotMock.snapshots.s1.equipment.push({ itemHrid: SHIELD, enhancementLevel: 0 });
        ui._onLoadoutSnapshotUpdate();
        expect(ui._config.tabs[0].items).toEqual([`${SWORD}+5`, SHIELD]);
    });

    test('an item added back by hand after the loadout dropped it stays', () => {
        removeByHandThenFromLoadout();
        ui._config = addItem(ui._config, 'gear', SHIELD);

        ui._onLoadoutSnapshotUpdate();
        expect(ui._config.tabs[0].items).toEqual([`${SWORD}+5`, SHIELD]);
    });
});
