/**
 * The running action's own loadout: while an action of the asked-for type runs, resolveActionContext,
 * resolveActionTalismans and describeActionContextSource answer with the loadout it was started with
 * (`characterLoadoutID`, 0 for No Loadout), never the skill default.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

import dataManager from '../core/data-manager.js';
import loadoutSnapshot from '../features/combat/loadout-snapshot.js';
import { buildCharacterAction } from '../__fixtures__/wire/character-actions.js';
import {
    describeActionContextSource,
    resolveActionContext,
    resolveActionTalismans,
    resolveLoadoutContext,
} from './action-context.js';

vi.mock('../core/data-manager.js', () => ({
    default: {
        getEquipment: vi.fn(),
        getActionDrinkSlots: vi.fn(),
        getInventory: vi.fn(),
        getCurrentActions: vi.fn(),
        getActionDetails: vi.fn(),
        getSlottedTalismans: vi.fn(),
        getCharacterTalismans: vi.fn(),
    },
}));

vi.mock('../features/combat/loadout-snapshot.js', () => ({
    default: {
        getSnapshotForSkill: vi.fn(),
        getSnapshotDrinksForSkill: vi.fn(),
        findSnapshotForSkill: vi.fn(),
        getSnapshotById: vi.fn(),
        equipmentMapOf: vi.fn(),
        resolveEquipment: vi.fn(),
    },
}));

const ENHANCING = '/action_types/enhancing';
const FORAGING = '/action_types/foraging';
const ACTION_TYPES = {
    '/actions/enhancing/enhance': ENHANCING,
    '/actions/foraging/farmland': FORAGING,
};

const WORN_EQ = new Map([['/item_locations/hands', { itemHrid: '/items/worn_gloves', enhancementLevel: 5 }]]);
const DEFAULT_EQ = new Map([['/item_locations/hands', { itemHrid: '/items/default_gloves', enhancementLevel: 0 }]]);
const LOADOUT_EQ = new Map([['/item_locations/hands', { itemHrid: '/items/loadout_gloves', enhancementLevel: 10 }]]);
const WORN_DRINKS = [{ itemHrid: '/items/worn_tea' }];
const DEFAULT_DRINKS = [{ itemHrid: '/items/default_tea' }];

// The All Skills default (no talismans) and a saved enhancing loadout (one talisman), as the store holds them
const ALL_SKILLS_DEFAULT = {
    name: 'All Skills',
    isDefault: true,
    actionTypeHrid: '',
    equipment: [{ itemLocationHrid: '/item_locations/hands', itemHrid: '/items/default_gloves' }],
    drinks: [{ itemHrid: '/items/default_tea' }],
};
const SAVED = {
    name: 'Enhance Kit',
    isDefault: false,
    actionTypeHrid: ENHANCING,
    equipment: [{ itemLocationHrid: '/item_locations/hands', itemHrid: '/items/loadout_gloves' }],
    drinks: [{ itemHrid: '/items/loadout_tea' }],
    talismanIdMap: { 1: 7001 },
};

const SLOTTED = [{ id: 7002, talismanTypeHrid: '/talisman_types/skilling', slotIndex: 1, modifiers: [] }];
const OWNED = [
    { id: 7001, talismanTypeHrid: '/talisman_types/skilling', modifiers: [{ hrid: '/m/conservation', grade: 3 }] },
    ...SLOTTED,
];

/** The queue as the game sends it: the running action is the lowest ordinal */
function queue(...actions) {
    dataManager.getCurrentActions.mockReturnValue(actions);
}

beforeEach(() => {
    vi.clearAllMocks();
    dataManager.getEquipment.mockReturnValue(WORN_EQ);
    dataManager.getActionDrinkSlots.mockReturnValue(WORN_DRINKS);
    dataManager.getInventory.mockReturnValue([
        { itemHrid: '/items/worn_tea', count: 5 },
        { itemHrid: '/items/default_tea', count: 5 },
        { itemHrid: '/items/loadout_tea', count: 5 },
    ]);
    dataManager.getActionDetails.mockImplementation((hrid) => ({ hrid, type: ACTION_TYPES[hrid] }));
    dataManager.getSlottedTalismans.mockReturnValue(SLOTTED);
    dataManager.getCharacterTalismans.mockReturnValue(OWNED);
    dataManager.getCurrentActions.mockReturnValue([]);

    loadoutSnapshot.getSnapshotForSkill.mockReturnValue(DEFAULT_EQ);
    loadoutSnapshot.getSnapshotDrinksForSkill.mockReturnValue(DEFAULT_DRINKS);
    loadoutSnapshot.findSnapshotForSkill.mockReturnValue(ALL_SKILLS_DEFAULT);
    loadoutSnapshot.getSnapshotById.mockImplementation((id) => (id === 39840 ? SAVED : null));
    loadoutSnapshot.equipmentMapOf.mockImplementation((snap) => (snap === SAVED ? LOADOUT_EQ : null));
});

describe('a running action of the same type', () => {
    test('No Loadout (0): the worn gear, live drinks and slotted talismans', () => {
        queue(buildCharacterAction({ actionHrid: '/actions/enhancing/enhance', characterLoadoutID: 0 }));

        const context = resolveActionContext(ENHANCING);
        expect(context.equipment).toBe(WORN_EQ);
        expect(context.drinks).toEqual(WORN_DRINKS);
        expect(resolveActionTalismans(ENHANCING)).toBe(SLOTTED);
        expect(describeActionContextSource(ENHANCING)).toEqual({
            key: `running:${ENHANCING}:0`,
            label: 'No loadout: the gear you wear now',
        });
    });

    test('a saved loadout id: that loadout, with its own talismans and drinks', () => {
        queue(buildCharacterAction({ actionHrid: '/actions/enhancing/enhance', characterLoadoutID: 39840 }));

        const context = resolveActionContext(ENHANCING);
        expect(context.equipment).toBe(LOADOUT_EQ);
        expect(context.drinks).toEqual([{ itemHrid: '/items/loadout_tea' }]);
        expect(resolveActionTalismans(ENHANCING)).toEqual([{ ...OWNED[0], slotIndex: 1 }]);
        const source = describeActionContextSource(ENHANCING);
        expect(source.key).toBe(`running:${ENHANCING}:39840:Enhance Kit`);
        expect(source.label).toBe('Enhance Kit (the loadout the running action uses)');
    });

    test('an id this build has no loadout for: the skill default, as before', () => {
        queue(buildCharacterAction({ actionHrid: '/actions/enhancing/enhance', characterLoadoutID: 99999 }));

        expect(resolveActionContext(ENHANCING).equipment).toBe(DEFAULT_EQ);
        expect(resolveActionTalismans(ENHANCING)).toEqual([]);
        expect(describeActionContextSource(ENHANCING).key).toBe(`skill:${ENHANCING}:All Skills`);
    });

    test('a saved loadout that names no gear runs on the worn kit and its slotted talismans', () => {
        loadoutSnapshot.getSnapshotById.mockReturnValue({ ...SAVED, equipment: [] });
        queue(buildCharacterAction({ actionHrid: '/actions/enhancing/enhance', characterLoadoutID: 39840 }));

        expect(resolveActionContext(ENHANCING).equipment).toBe(WORN_EQ);
        expect(resolveActionTalismans(ENHANCING)).toBe(SLOTTED);
        expect(describeActionContextSource(ENHANCING).label).toBe('No loadout: the gear you wear now');
    });

    test('an action with no numeric id (an older row) keeps the skill default', () => {
        const action = buildCharacterAction({ actionHrid: '/actions/enhancing/enhance' });
        delete action.characterLoadoutID;
        queue(action);

        expect(resolveActionContext(ENHANCING).equipment).toBe(DEFAULT_EQ);
    });
});

describe('the skill default is kept', () => {
    test('when the running action is of another type', () => {
        queue(buildCharacterAction({ actionHrid: '/actions/foraging/farmland', characterLoadoutID: 0 }));

        expect(resolveActionContext(ENHANCING).equipment).toBe(DEFAULT_EQ);
        expect(resolveActionContext(ENHANCING).drinks).toEqual(DEFAULT_DRINKS);
        expect(resolveActionTalismans(ENHANCING)).toEqual([]);
        expect(describeActionContextSource(ENHANCING).key).toBe(`skill:${ENHANCING}:All Skills`);
    });

    test('when nothing runs', () => {
        queue();

        expect(resolveActionContext(ENHANCING).equipment).toBe(DEFAULT_EQ);
        expect(describeActionContextSource(ENHANCING).label).toBe('All Skills ★ (the loadout this skill equips)');
    });

    test('for a queued action at position 0 that is not the running one', () => {
        // Position 0 holds a queued enhance (higher ordinal); the foraging action runs
        queue(
            buildCharacterAction({
                id: 2,
                actionHrid: '/actions/enhancing/enhance',
                characterLoadoutID: 0,
                ordinal: 5,
            }),
            buildCharacterAction({ id: 1, actionHrid: '/actions/foraging/farmland', characterLoadoutID: 0, ordinal: 1 })
        );

        expect(resolveActionContext(ENHANCING).equipment).toBe(DEFAULT_EQ);
        expect(resolveActionTalismans(ENHANCING)).toEqual([]);
    });
});

describe('a queued row passes its own id', () => {
    test('resolveLoadoutContext with an unknown id falls back to the skill default, not the running pick', () => {
        queue(buildCharacterAction({ actionHrid: '/actions/enhancing/enhance', characterLoadoutID: 0 }));

        expect(resolveLoadoutContext(ENHANCING, 99999).equipment).toBe(DEFAULT_EQ);
        expect(resolveLoadoutContext(ENHANCING, undefined).equipment).toBe(DEFAULT_EQ);
    });
});

describe('the source key moves with the running id', () => {
    test('default, 0 and N each give a different key', () => {
        queue();
        const idle = describeActionContextSource(ENHANCING).key;
        queue(buildCharacterAction({ actionHrid: '/actions/enhancing/enhance', characterLoadoutID: 0 }));
        const worn = describeActionContextSource(ENHANCING).key;
        queue(buildCharacterAction({ actionHrid: '/actions/enhancing/enhance', characterLoadoutID: 39840 }));
        const saved = describeActionContextSource(ENHANCING).key;

        expect(new Set([idle, worn, saved]).size).toBe(3);
    });
});
