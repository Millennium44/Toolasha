/**
 * A production cost follows the Artisan Tea discount, and the discount follows whether the slotted
 * tea is in stock. Real DataManager, action-context, artisan-bonus and enhancement-pricing: only the
 * game's market and websocket are faked. The inventory arrives as the game sends it (items_updated).
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const handlers = vi.hoisted(() => new Map());

vi.mock('../core/websocket.js', () => ({
    default: {
        on: vi.fn((event, handler) => handlers.set(event, handler)),
        off: vi.fn(),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
        saveCombatSimSnapshot: vi.fn(() => true),
    },
}));
vi.mock('../core/storage.js', () => ({
    default: { get: vi.fn(), set: vi.fn(), getJSON: vi.fn(), setJSON: vi.fn(), flushAll: vi.fn() },
}));
vi.mock('../api/marketplace.js', () => ({ default: { on: () => {}, priceVersion: 0 } }));
vi.mock('../features/settings/custom-price-overrides.js', () => ({ getCustomPriceVersion: () => 0 }));
vi.mock('./market-data.js', () => ({
    getItemPrices: () => null,
    getItemPrice: (hrid) => (hrid === '/items/iron_ore' ? 100 : 0),
}));
vi.mock('../features/combat/loadout-snapshot.js', () => ({
    default: { getSnapshotDrinksForSkill: () => null, getSnapshotForSkill: () => null },
}));

const INV = '/item_locations/inventory';
const TEA = '/items/artisan_tea';
const itemDetailMap = {
    '/items/iron_ore': { name: 'Iron Ore', categoryHrid: '/item_categories/resource' },
    '/items/iron_bar': { name: 'Iron Bar', categoryHrid: '/item_categories/resource' },
    [TEA]: {
        name: 'Artisan Tea',
        categoryHrid: '/item_categories/drink',
        consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
    },
};
const actionDetailMap = {
    '/actions/crafting/iron_bar': {
        type: '/action_types/crafting',
        inputItems: [{ itemHrid: '/items/iron_ore', count: 3 }],
        outputItems: [{ itemHrid: '/items/iron_bar', count: 1 }],
    },
};

const { default: dataManager } = await import('../core/data-manager.js');
const { getProductionCostDetailed, getProductionChainTime } = await import('./enhancement-pricing.js');

function stock(id, itemHrid, count, itemLocationHrid = INV) {
    handlers.get('items_updated')({ endCharacterItems: [{ id, itemHrid, itemLocationHrid, count }] });
}
const cost = () => getProductionCostDetailed('/items/iron_bar').cost;

beforeEach(() => {
    dataManager.initClientData = { itemDetailMap, actionDetailMap, enhancementLevelTotalBonusMultiplierTable: [0] };
    dataManager.characterItems = [
        { id: 1, itemHrid: '/items/iron_ore', itemLocationHrid: INV, count: 500 },
        { id: 2, itemHrid: TEA, itemLocationHrid: INV, count: 5 },
    ];
    dataManager._itemIndexById = null;
    dataManager.characterEquipment = new Map();
    // Slotted, with no cup running
    dataManager.actionTypeDrinkSlotsMap = new Map([
        ['/action_types/crafting', [{ itemHrid: TEA, isActive: false, duration: 0 }]],
    ]);
    dataManager.buffStateVersion++;
});

describe('Artisan Tea stock and the production cost memo', () => {
    test('discount while in stock, gone at zero, back on restock; an unrelated item does not recompute', () => {
        expect(cost()).toBeCloseTo(270, 9);

        const before = dataManager.getBuffStateVersion();
        stock(1, '/items/iron_ore', 0); // an unrelated item hitting zero is not a drink
        stock(1, '/items/iron_ore', 500);
        stock(3, '/items/iron_bar', 4);
        stock(2, TEA, 4); // 5 -> 4 changes nothing
        expect(dataManager.getBuffStateVersion()).toBe(before);
        expect(cost()).toBeCloseTo(270, 9);

        stock(2, TEA, 0); // last cup gone: the row is removed
        expect(dataManager.getBuffStateVersion()).toBe(before + 1);
        expect(cost()).toBe(300);

        stock(2, TEA, 0); // a repeat of the same zero adds no churn
        expect(dataManager.getBuffStateVersion()).toBe(before + 1);

        stock(4, TEA, 12); // restocked as a new row
        expect(dataManager.getBuffStateVersion()).toBe(before + 2);
        expect(cost()).toBeCloseTo(270, 9);
    });

    test('a cup still running keeps the discount at zero stock', () => {
        dataManager.actionTypeDrinkSlotsMap.set('/action_types/crafting', [
            { itemHrid: TEA, isActive: true, duration: 120 },
        ]);
        dataManager.buffStateVersion++;
        expect(cost()).toBeCloseTo(270, 9);
        stock(2, TEA, 0);
        expect(cost()).toBeCloseTo(270, 9);
    });

    test('the chain-time memo shares the key, and an action_completed stock change bumps too', () => {
        expect(getProductionChainTime('/items/iron_bar')).toBeDefined();
        const before = dataManager.getBuffStateVersion();
        handlers.get('action_completed')({
            endCharacterAction: { id: 9, isDone: true, actionHrid: '/actions/crafting/iron_bar' },
            endCharacterItems: [{ id: 2, itemHrid: TEA, itemLocationHrid: INV, count: 0 }],
        });
        expect(dataManager.getBuffStateVersion()).toBe(before + 1);
        expect(cost()).toBe(300);
    });
});
