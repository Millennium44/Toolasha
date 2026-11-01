import { describe, test, expect, vi, beforeEach } from 'vitest';

import dataManager from '../core/data-manager.js';
import loadoutSnapshot from '../features/combat/loadout-snapshot.js';
import { resolveActionContext, resolveLoadoutContext } from './action-context.js';

vi.mock('../core/data-manager.js', () => ({
    default: {
        getEquipment: vi.fn(),
        getActionDrinkSlots: vi.fn(),
        getInventory: vi.fn(),
    },
}));

vi.mock('../features/combat/loadout-snapshot.js', () => ({
    default: {
        getSnapshotForSkill: vi.fn(),
        getSnapshotDrinksForSkill: vi.fn(),
        getSnapshotById: vi.fn(),
        resolveEquipment: vi.fn(),
    },
}));

const TYPE = '/action_types/cooking';
const CURRENT_EQ = new Map([['/item_locations/main_hand', { itemHrid: '/items/current_pan' }]]);
const CURRENT_DRINKS = [{ itemHrid: '/items/current_tea' }];
const SNAPSHOT_EQ = new Map([['/item_locations/main_hand', { itemHrid: '/items/snapshot_pan' }]]);
const SNAPSHOT_DRINKS = [{ itemHrid: '/items/snapshot_tea' }];

describe('resolveActionContext', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        dataManager.getEquipment.mockReturnValue(CURRENT_EQ);
        dataManager.getActionDrinkSlots.mockReturnValue(CURRENT_DRINKS);
        // Inventory contains all test drinks so the stock filter passes them through
        dataManager.getInventory.mockReturnValue([
            { itemHrid: '/items/current_tea', count: 5 },
            { itemHrid: '/items/snapshot_tea', count: 3 },
        ]);
    });

    test('uses snapshot equipment and drinks when both exist', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(SNAPSHOT_EQ);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(SNAPSHOT_DRINKS);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(SNAPSHOT_EQ);
        expect(result.drinks).toEqual(SNAPSHOT_DRINKS);
    });

    test('falls back to current equipment and drinks when no snapshot exists', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(null);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(CURRENT_EQ);
        expect(result.drinks).toEqual(CURRENT_DRINKS);
        expect(dataManager.getEquipment).toHaveBeenCalled();
        expect(dataManager.getActionDrinkSlots).toHaveBeenCalledWith(TYPE);
    });

    test('falls back per-field when only equipment snapshot exists', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(SNAPSHOT_EQ);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(SNAPSHOT_EQ);
        expect(result.drinks).toEqual(CURRENT_DRINKS);
    });

    test('falls back per-field when only drinks snapshot exists', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(null);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(SNAPSHOT_DRINKS);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(CURRENT_EQ);
        expect(result.drinks).toEqual(SNAPSHOT_DRINKS);
    });

    test('passes the action type through to both lookups', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(null);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);

        resolveActionContext(TYPE);

        expect(loadoutSnapshot.getSnapshotForSkill).toHaveBeenCalledWith(TYPE);
        expect(loadoutSnapshot.getSnapshotDrinksForSkill).toHaveBeenCalledWith(TYPE);
    });
});

describe('a tea whose stack has run out', () => {
    test('is dropped once the buff it left behind has expired', () => {
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);
        dataManager.getActionDrinkSlots.mockReturnValue([{ itemHrid: '/items/empty_tea', isActive: false }]);
        dataManager.getInventory.mockReturnValue([]);

        expect(resolveActionContext(TYPE).drinks).toEqual([]);
    });

    test('is kept while the buff from the last cup is still running', () => {
        // The bag is empty but the tea is still in effect — the game says so, with an
        // active slot and time left on it. Dropping the slot the moment the count hit
        // zero made every prediction jump minutes before the buff actually ended.
        const stillBrewing = { itemHrid: '/items/empty_tea', isActive: true, duration: 90_000 };
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);
        dataManager.getActionDrinkSlots.mockReturnValue([stillBrewing]);
        dataManager.getInventory.mockReturnValue([]);

        expect(resolveActionContext(TYPE).drinks).toEqual([stillBrewing]);
    });

    test('an active slot with no time left is over, and goes', () => {
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);
        dataManager.getActionDrinkSlots.mockReturnValue([
            { itemHrid: '/items/empty_tea', isActive: true, duration: 0 },
        ]);
        dataManager.getInventory.mockReturnValue([]);

        expect(resolveActionContext(TYPE).drinks).toEqual([]);
    });

    test('stock alone is still enough, with no buff running', () => {
        const slot = { itemHrid: '/items/current_tea' };
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);
        dataManager.getActionDrinkSlots.mockReturnValue([slot]);
        dataManager.getInventory.mockReturnValue([{ itemHrid: '/items/current_tea', count: 2 }]);

        expect(resolveActionContext(TYPE).drinks).toEqual([slot]);
    });
});

describe("resolveLoadoutContext (a queued action's own loadout)", () => {
    const SAVED = {
        id: 30284,
        equipment: [
            { itemHrid: '/items/saved_pan', itemLocationHrid: '/item_locations/main_hand', enhancementLevel: 0 },
        ],
        drinks: [{ itemHrid: '/items/snapshot_tea' }],
    };

    beforeEach(() => {
        vi.clearAllMocks();
        dataManager.getEquipment.mockReturnValue(CURRENT_EQ);
        dataManager.getActionDrinkSlots.mockReturnValue(CURRENT_DRINKS);
        dataManager.getInventory.mockReturnValue([
            { itemHrid: '/items/current_tea', count: 5 },
            { itemHrid: '/items/snapshot_tea', count: 3 },
        ]);
        // A default loadout exists for the skill: what a fresh action would pick
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(SNAPSHOT_EQ);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(SNAPSHOT_DRINKS);
        loadoutSnapshot.getSnapshotById.mockImplementation((id) => (id === 30284 ? SAVED : null));
        loadoutSnapshot.resolveEquipment.mockImplementation((snap) => snap.equipment);
    });

    test('id 0 (No Loadout) is the worn gear, not the skill default loadout', () => {
        const result = resolveLoadoutContext(TYPE, 0);

        expect(result.equipment).toBe(CURRENT_EQ);
        expect(result.drinks).toEqual(CURRENT_DRINKS);
    });

    test('a saved id is that loadout, not the skill default', () => {
        const result = resolveLoadoutContext(TYPE, 30284);

        expect([...result.equipment.values()].map((e) => e.itemHrid)).toEqual(['/items/saved_pan']);
        expect(result.drinks).toEqual(SAVED.drinks);
    });

    test('a saved loadout with no drinks keeps the current drinks', () => {
        loadoutSnapshot.getSnapshotById.mockReturnValue({ ...SAVED, drinks: [{ itemHrid: '' }] });

        expect(resolveLoadoutContext(TYPE, 30284).drinks).toEqual(CURRENT_DRINKS);
    });

    test('an unknown saved id or a missing id falls back to the per-skill resolution', () => {
        expect(resolveLoadoutContext(TYPE, 99999).equipment).toBe(SNAPSHOT_EQ);
        expect(resolveLoadoutContext(TYPE, undefined).equipment).toBe(SNAPSHOT_EQ);
    });
});
