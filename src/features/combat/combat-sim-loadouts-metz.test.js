/**
 * Tests for the Metz saved-loadouts builder and its GM publisher. The fixtures follow the shape
 * the Loadout Snapshots store produces (`id`, hrid-keyed equipment locations, `{abilityHrid, slot}`
 * abilities, `{itemHrid}` consumables); the expected output is the shape the Metz loadout picker
 * takes (upstream's contract).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { resolveEnhancementLevel, highestOwnedEnhancements } from '../../utils/loadout-equipment.js';

const mocks = vi.hoisted(() => ({
    snapshots: [],
    abilities: [],
    items: [],
    characterId: 'char-1',
    ready: true,
    listeners: new Set(),
    characterListeners: new Set(),
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return { characterAbilities: mocks.abilities };
        },
        get characterItems() {
            return mocks.items;
        },
        getCurrentCharacterId: vi.fn(() => mocks.characterId),
        on: vi.fn((event, fn) => mocks.characterListeners.add(fn)),
        off: vi.fn((event, fn) => mocks.characterListeners.delete(fn)),
    },
}));

vi.mock('./loadout-snapshot.js', () => ({
    default: {
        get snapshotsReady() {
            return mocks.ready;
        },
        getAllSnapshots: vi.fn(() => mocks.snapshots),
        resolveEquipment: vi.fn((snapshot) => {
            const owned = highestOwnedEnhancements(mocks.items);
            return (snapshot.equipment || []).map((equip) => ({
                ...equip,
                enhancementLevel: resolveEnhancementLevel(snapshot, equip, owned),
            }));
        }),
        whenReady: vi.fn(() => Promise.resolve(true)),
        onUpdate: vi.fn((fn) => mocks.listeners.add(fn)),
        offUpdate: vi.fn((fn) => mocks.listeners.delete(fn)),
    },
}));

import {
    buildMetzLoadouts,
    collectMetzLoadouts,
    getMetzLoadouts,
    startMetzLoadoutPublisher,
    stopMetzLoadoutPublisher,
} from './combat-sim-loadouts-metz.js';

const T = (dependencyHrid, conditionHrid, comparatorHrid, value) => ({
    dependencyHrid,
    conditionHrid,
    comparatorHrid,
    value,
});
const HP_BELOW_60 = T(
    '/combat_trigger_dependencies/self',
    '/combat_trigger_conditions/current_hp',
    '/combat_trigger_comparators/less_than_equal',
    0.6
);
const ENEMIES_2 = T(
    '/combat_trigger_dependencies/all_enemies',
    '/combat_trigger_conditions/number_of_active_units',
    '/combat_trigger_comparators/greater_than_equal',
    2
);

const piece = (location, itemHrid, enhancementLevel) => ({
    itemLocationHrid: `/item_locations/${location}`,
    itemHrid: `/items/${itemHrid}`,
    enhancementLevel,
});

/** A stab/ranged/nature set with refined (+N) items, tool slots and spare map keys. */
const MELEE_SET = {
    id: '12',
    name: 'Dungeon',
    actionTypeHrid: '/action_types/combat',
    isDefault: false,
    useExactEnhancement: false,
    ordinal: 3,
    equipment: [
        piece('main_hand', 'holy_spear', 12),
        piece('off_hand', 'cursed_bow', 0),
        piece('body', 'rainbow_plate_body', 7),
        piece('legs', 'rainbow_plate_legs', 5),
        piece('back', 'chimerical_quiver', 4),
        piece('charm', 'sundering_charm', 3),
        piece('enhancing_tool', 'celestial_enhancer', 10),
        piece('foraging_tool', 'celestial_hatchet', 8),
    ],
    abilities: [
        { abilityHrid: '/abilities/flame_blast', slot: 2 },
        { abilityHrid: '/abilities/pierce', slot: 1 },
        { abilityHrid: '/abilities/nature_strike', slot: 5 },
    ],
    food: [{ itemHrid: '/items/spaceberry_cake' }, { itemHrid: '' }, { itemHrid: '' }],
    drinks: [{ itemHrid: '/items/ultra_ranged_coffee' }, { itemHrid: '/items/wisdom_coffee' }, { itemHrid: '' }],
    abilityCombatTriggersMap: { '/abilities/flame_blast': [ENEMIES_2], '/abilities/poke': [ENEMIES_2] },
    consumableCombatTriggersMap: { '/items/spaceberry_cake': [HP_BELOW_60] },
    savedAt: 1,
};

describe('buildMetzLoadouts', () => {
    test('shape matches the Metz picker contract for a refined multi-style set', () => {
        const levels = { '/abilities/pierce': 120, '/abilities/flame_blast': 95, '/abilities/nature_strike': 88 };

        expect(buildMetzLoadouts([MELEE_SET], levels)).toEqual([
            {
                id: '12',
                name: 'Dungeon',
                equipment: [
                    piece('main_hand', 'holy_spear', 12),
                    piece('off_hand', 'cursed_bow', 0),
                    piece('body', 'rainbow_plate_body', 7),
                    piece('legs', 'rainbow_plate_legs', 5),
                    piece('back', 'chimerical_quiver', 4),
                    piece('charm', 'sundering_charm', 3),
                ],
                abilities: [
                    { abilityHrid: '/abilities/pierce', level: 120 },
                    { abilityHrid: '/abilities/flame_blast', level: 95 },
                    { abilityHrid: '/abilities/nature_strike', level: 88 },
                ],
                food: [{ itemHrid: '/items/spaceberry_cake' }],
                drinks: [{ itemHrid: '/items/ultra_ranged_coffee' }, { itemHrid: '/items/wisdom_coffee' }],
                triggerMap: {
                    '/abilities/pierce': null,
                    '/abilities/flame_blast': [ENEMIES_2],
                    '/abilities/nature_strike': null,
                    '/items/spaceberry_cake': [HP_BELOW_60],
                    '/items/ultra_ranged_coffee': null,
                    '/items/wisdom_coffee': null,
                },
            },
        ]);
    });

    test('tool slots dropped, non-combat loadouts excluded, ordinal order, empty loadouts left out', () => {
        const combat = (id, ordinal, extra = {}) => ({ ...MELEE_SET, id, name: `L${id}`, ordinal, ...extra });
        const result = buildMetzLoadouts([
            combat('b', 2),
            combat('skill', 0, { actionTypeHrid: '/action_types/enhancing' }),
            combat('a', 1),
            combat('empty', 5, { equipment: [piece('enhancing_tool', 'celestial_enhancer', 10)], abilities: [] }),
            combat('blank-type', 4, { actionTypeHrid: '' }),
        ]);

        expect(result.map((l) => l.id)).toEqual(['a', 'b']);
        expect(JSON.stringify(result)).not.toContain('_tool');
    });

    test('defensive: junk entries, missing id and name, duplicate ability, malformed trigger row, empty input', () => {
        const defensive = {
            actionTypeHrid: '/action_types/combat',
            equipment: [
                { itemLocationHrid: '/item_locations/head', itemHrid: '/items/cotton_hat', enhancementLevel: '4' },
            ],
            abilities: [
                { abilityHrid: '/abilities/poke', slot: 4 },
                { abilityHrid: '/abilities/poke', slot: 1 },
                { abilityHrid: '', slot: 2 },
            ],
            abilityCombatTriggersMap: {
                '/abilities/poke': [ENEMIES_2, { conditionHrid: 'half a trigger' }, 'not a trigger'],
            },
        };

        expect(buildMetzLoadouts([null, 'junk', { actionTypeHrid: '/action_types/combat' }, defensive], null)).toEqual([
            {
                id: '1',
                name: 'Loadout 1',
                equipment: [piece('head', 'cotton_hat', 4)],
                abilities: [{ abilityHrid: '/abilities/poke', level: 1 }],
                food: [],
                drinks: [],
                triggerMap: { '/abilities/poke': [ENEMIES_2] },
            },
        ]);
        expect(buildMetzLoadouts(undefined)).toEqual([]);
        expect(buildMetzLoadouts([], {})).toEqual([]);
    });

    test('the input is never mutated', () => {
        const before = JSON.stringify(MELEE_SET);
        buildMetzLoadouts([MELEE_SET], { '/abilities/pierce': 3 });
        expect(JSON.stringify(MELEE_SET)).toBe(before);
    });
});

describe('collect, stored copy and publisher', () => {
    beforeEach(() => {
        vi.useRealTimers();
        mocks.snapshots = [];
        mocks.abilities = [];
        mocks.items = [];
        mocks.ready = true;
        mocks.characterId = 'char-1';
        mocks.listeners.clear();
        mocks.characterListeners.clear();
        delete globalThis.GM_getValue;
        delete globalThis.GM_setValue;
        stopMetzLoadoutPublisher();
    });

    const ownedFor = (set) =>
        set.equipment.map((equip) => ({
            itemHrid: equip.itemHrid,
            enhancementLevel: equip.enhancementLevel,
            count: 1,
        }));

    test('collect resolves each piece to the highest owned level unless the loadout pins exact levels', () => {
        mocks.snapshots = [MELEE_SET, { ...MELEE_SET, id: '13', useExactEnhancement: true, ordinal: 4 }];
        mocks.items = [
            ...ownedFor(MELEE_SET),
            { itemHrid: '/items/holy_spear', enhancementLevel: 15, count: 1 },
            { itemHrid: '/items/holy_spear', enhancementLevel: 2, count: 3 },
        ];

        const [free, exact] = collectMetzLoadouts();

        expect(free.equipment.find((e) => e.itemHrid === '/items/holy_spear').enhancementLevel).toBe(15);
        expect(exact.equipment.find((e) => e.itemHrid === '/items/holy_spear').enhancementLevel).toBe(12);
    });

    test('collect skips a loadout needing gear no longer owned, but keeps it when no inventory is loaded', () => {
        mocks.snapshots = [
            MELEE_SET,
            { ...MELEE_SET, id: '14', ordinal: 4, equipment: [piece('body', 'gone_body', 3)] },
        ];
        mocks.abilities = [{ abilityHrid: '/abilities/pierce', level: 120 }];
        mocks.items = ownedFor(MELEE_SET);

        const loadouts = collectMetzLoadouts();

        expect(loadouts.map((l) => l.id)).toEqual(['12']);
        expect(loadouts[0].abilities.find((a) => a.abilityHrid === '/abilities/pierce').level).toBe(120);

        mocks.items = [];
        expect(collectMetzLoadouts().map((l) => l.id)).toEqual(['12', '14']);
    });

    test('getMetzLoadouts falls back to the stored copy for the same character only', () => {
        const stored = [{ id: '1', name: 'Stored' }];
        globalThis.GM_getValue = vi.fn(() => JSON.stringify({ characterId: 'char-1', loadouts: stored }));

        expect(getMetzLoadouts('char-1')).toEqual(stored);
        expect(getMetzLoadouts('char-2')).toEqual([]);
    });

    test('getMetzLoadouts prefers the live store over storage', () => {
        mocks.snapshots = [MELEE_SET];
        globalThis.GM_getValue = vi.fn(() => JSON.stringify({ characterId: 'char-1', loadouts: [{ id: 'old' }] }));

        expect(getMetzLoadouts('char-1').map((l) => l.id)).toEqual(['12']);
    });

    test('the publisher writes once, and not again when the list is unchanged', async () => {
        vi.useFakeTimers();
        globalThis.GM_getValue = vi.fn(() => null);
        globalThis.GM_setValue = vi.fn();
        mocks.snapshots = [MELEE_SET];

        await startMetzLoadoutPublisher();
        vi.advanceTimersByTime(2100);
        expect(globalThis.GM_setValue).toHaveBeenCalledTimes(1);
        expect(globalThis.GM_setValue.mock.calls[0][0]).toBe('toolasha_metz_loadouts');
        const payload = JSON.parse(globalThis.GM_setValue.mock.calls[0][1]);
        expect(payload.characterId).toBe('char-1');
        expect(payload.loadouts.map((l) => l.id)).toEqual(['12']);

        [...mocks.listeners][0]();
        vi.advanceTimersByTime(2100);
        expect(globalThis.GM_setValue).toHaveBeenCalledTimes(1);

        mocks.snapshots = [MELEE_SET, { ...MELEE_SET, id: '15', ordinal: 9 }];
        [...mocks.listeners][0]();
        vi.advanceTimersByTime(2100);
        expect(globalThis.GM_setValue).toHaveBeenCalledTimes(2);

        stopMetzLoadoutPublisher();
        expect(mocks.listeners.size).toBe(0);
        expect(mocks.characterListeners.size).toBe(0);
    });

    test('a fresh page does not rewrite a copy that is already stored', async () => {
        vi.useFakeTimers();
        mocks.snapshots = [MELEE_SET];
        const stored = JSON.stringify({ characterId: 'char-1', loadouts: collectMetzLoadouts() });
        globalThis.GM_getValue = vi.fn(() => stored);
        globalThis.GM_setValue = vi.fn();

        await startMetzLoadoutPublisher();
        vi.advanceTimersByTime(2100);

        expect(globalThis.GM_setValue).not.toHaveBeenCalled();
    });

    test('nothing is written before the store has loaded, and a stopped publisher stays silent', async () => {
        vi.useFakeTimers();
        globalThis.GM_getValue = vi.fn(() => null);
        globalThis.GM_setValue = vi.fn();
        mocks.ready = false;

        await startMetzLoadoutPublisher();
        vi.advanceTimersByTime(2100);
        expect(globalThis.GM_setValue).not.toHaveBeenCalled();

        mocks.ready = true;
        [...mocks.listeners][0]();
        stopMetzLoadoutPublisher();
        vi.advanceTimersByTime(2100);
        expect(globalThis.GM_setValue).not.toHaveBeenCalled();
    });

    test('a character switch republishes once the re-initialized store is ready', async () => {
        vi.useFakeTimers();
        globalThis.GM_getValue = vi.fn(() => null);
        globalThis.GM_setValue = vi.fn();
        mocks.snapshots = [MELEE_SET];
        await startMetzLoadoutPublisher();
        vi.advanceTimersByTime(2100);

        mocks.characterId = 'char-2';
        mocks.snapshots = [];
        await [...mocks.characterListeners][0]();
        vi.advanceTimersByTime(2100);

        expect(globalThis.GM_setValue).toHaveBeenCalledTimes(2);
        expect(JSON.parse(globalThis.GM_setValue.mock.calls[1][1])).toEqual({ characterId: 'char-2', loadouts: [] });
    });
});
