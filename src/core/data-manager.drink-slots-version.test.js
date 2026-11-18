/**
 * The buff state version moves when a drink slot changes what it buffs, not each time the game resends the map.
 *
 * `action_type_consumable_slots_updated` streams the whole drink map every time a drink is used, with only the
 * countdowns moved (seen on the test server 2026-11-18: one per completed action while foraging). Every copy used
 * to bump the version, which threw away each figure keyed on it, the Best Items own-stock rows among them.
 * The rows below are the shape that message carries.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./websocket.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
        saveCombatSimSnapshot: vi.fn(() => true),
    },
}));
vi.mock('./storage.js', () => ({
    default: {
        getJSON: async (_key, _store, fallback) => fallback,
        setJSON: async () => true,
        get: async (_key, _store, fallback = null) => fallback,
        set: async () => true,
        flushAll: async () => {},
    },
}));

let dataManager;

/** One slot row as the game sends it */
const slot = (actionTypeHrid, slotIndex, itemHrid, { isActive = true, duration = 0 } = {}) => ({
    characterID: 30404,
    actionTypeHrid,
    consumableSlotTypeHrid: '/consumable_slot_types/drink',
    slotIndex,
    itemHrid,
    isActive,
    duration,
});

function drinkMap({ foragingTea = '/items/gathering_tea', duration = 0, isActive = true } = {}) {
    return {
        '/action_types/alchemy': [
            slot('/action_types/alchemy', 0, '/items/wisdom_tea', { duration }),
            slot('/action_types/alchemy', 1, '/items/catalytic_tea', { duration }),
            null,
        ],
        '/action_types/foraging': [
            slot('/action_types/foraging', 0, foragingTea, { duration, isActive }),
            slot('/action_types/foraging', 1, '/items/efficiency_tea', { duration }),
            null,
        ],
    };
}

beforeEach(async () => {
    ({ default: dataManager } = await import('./data-manager.js'));
    dataManager.actionTypeDrinkSlotsMap.clear();
    dataManager.updateDrinkSlotsMap(drinkMap());
});

describe('updateDrinkSlotsMap and the buff state version', () => {
    test('the same drinks resent with moved countdowns leave the version alone, but the map is refreshed', () => {
        const before = dataManager.getBuffStateVersion();
        dataManager.updateDrinkSlotsMap(drinkMap({ duration: 240_000_000_000 }));
        dataManager.updateDrinkSlotsMap(drinkMap({ duration: 120_000_000_000 }));
        expect(dataManager.getBuffStateVersion()).toBe(before);
        expect(dataManager.actionTypeDrinkSlotsMap.get('/action_types/foraging')[0].duration).toBe(120_000_000_000);
    });

    test('a different drink in a slot moves the version', () => {
        const before = dataManager.getBuffStateVersion();
        dataManager.updateDrinkSlotsMap(drinkMap({ foragingTea: '/items/processing_tea' }));
        expect(dataManager.getBuffStateVersion()).toBe(before + 1);
    });

    test('a drink turned off (or back on) moves the version', () => {
        const before = dataManager.getBuffStateVersion();
        dataManager.updateDrinkSlotsMap(drinkMap({ isActive: false }));
        expect(dataManager.getBuffStateVersion()).toBe(before + 1);
        dataManager.updateDrinkSlotsMap(drinkMap({ isActive: true }));
        expect(dataManager.getBuffStateVersion()).toBe(before + 2);
    });

    test('a slot emptied, or an action type added, moves the version', () => {
        const before = dataManager.getBuffStateVersion();
        const emptied = drinkMap();
        emptied['/action_types/foraging'][1] = null;
        dataManager.updateDrinkSlotsMap(emptied);
        expect(dataManager.getBuffStateVersion()).toBe(before + 1);
        dataManager.updateDrinkSlotsMap({
            ...emptied,
            '/action_types/milking': [slot('/action_types/milking', 0, '/items/gathering_tea')],
        });
        expect(dataManager.getBuffStateVersion()).toBe(before + 2);
    });

    test('a missing map changes nothing', () => {
        const before = dataManager.getBuffStateVersion();
        dataManager.updateDrinkSlotsMap(null);
        expect(dataManager.getBuffStateVersion()).toBe(before);
        expect(dataManager.actionTypeDrinkSlotsMap.size).toBe(2);
    });
});
