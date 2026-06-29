import { describe, test, expect, vi, beforeEach } from 'vitest';

import dataManager from '../core/data-manager.js';
import loadoutSnapshot from '../features/combat/loadout-snapshot.js';
import { resolveActionContext } from './action-context.js';

vi.mock('../core/data-manager.js', () => ({
    default: {
        getEquipment: vi.fn(),
        getActionDrinkSlots: vi.fn(),
    },
}));

vi.mock('../features/combat/loadout-snapshot.js', () => ({
    default: {
        getSnapshotForSkill: vi.fn(),
        getSnapshotDrinksForSkill: vi.fn(),
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
    });

    test('uses snapshot equipment and drinks when both exist', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(SNAPSHOT_EQ);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(SNAPSHOT_DRINKS);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(SNAPSHOT_EQ);
        expect(result.drinks).toBe(SNAPSHOT_DRINKS);
    });

    test('falls back to current equipment and drinks when no snapshot exists', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(null);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(CURRENT_EQ);
        expect(result.drinks).toBe(CURRENT_DRINKS);
        expect(dataManager.getEquipment).toHaveBeenCalled();
        expect(dataManager.getActionDrinkSlots).toHaveBeenCalledWith(TYPE);
    });

    test('falls back per-field when only equipment snapshot exists', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(SNAPSHOT_EQ);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(SNAPSHOT_EQ);
        expect(result.drinks).toBe(CURRENT_DRINKS);
    });

    test('falls back per-field when only drinks snapshot exists', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(null);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(SNAPSHOT_DRINKS);

        const result = resolveActionContext(TYPE);

        expect(result.equipment).toBe(CURRENT_EQ);
        expect(result.drinks).toBe(SNAPSHOT_DRINKS);
    });

    test('passes the action type through to both lookups', () => {
        loadoutSnapshot.getSnapshotForSkill.mockReturnValue(null);
        loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(null);

        resolveActionContext(TYPE);

        expect(loadoutSnapshot.getSnapshotForSkill).toHaveBeenCalledWith(TYPE);
        expect(loadoutSnapshot.getSnapshotDrinksForSkill).toHaveBeenCalledWith(TYPE);
    });
});
