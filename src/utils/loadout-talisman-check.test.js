import { describe, test, expect, beforeEach, vi } from 'vitest';
import { BELT_ITEMS } from '../__fixtures__/talisman-bonuses.js';

const game = vi.hoisted(() => ({ server: true }));
vi.mock('./game-server.js', () => ({ isTestServer: () => game.server }));

const { checkLoadoutTalismans, commonWarnings } = await import('./loadout-talisman-check.js');

const BELT_LOC = '/item_locations/belt';
const wear = (hrid) => `${hrid}::${BELT_LOC}::0`;
const owned = [
    { id: 11, talismanTypeHrid: '/talisman_types/combat', slotIndex: 1, modifiers: [] },
    { id: 12, talismanTypeHrid: '/talisman_types/combat', slotIndex: 0, modifiers: [] },
    { id: 21, talismanTypeHrid: '/talisman_types/skilling', slotIndex: 0, modifiers: [] },
];
const loadout = (over = {}) => ({
    name: 'L',
    actionTypeHrid: '/action_types/combat',
    wearableMap: { [BELT_LOC]: wear('/items/large_talisman_belt') },
    talismanIdMap: { 1: 0, 2: 0, 3: 0 },
    ...over,
});
const run = (l, list = owned) => checkLoadoutTalismans({ loadout: l, ownedTalismans: list, itemDetailMap: BELT_ITEMS });
const codes = (l, list) => run(l, list).map((w) => `${w.code}${w.slot}`);

describe('checkLoadoutTalismans', () => {
    beforeEach(() => {
        game.server = true;
    });

    test('no talismans, a missing map, or a list not delivered: nothing', () => {
        expect(run(loadout())).toEqual([]);
        expect(run(loadout({ talismanIdMap: undefined }))).toEqual([]);
        expect(run(loadout({ talismanIdMap: { 1: 99 } }), null)).toEqual([]);
    });

    test('all fine: same talisman in two loadouts and a full belt report nothing', () => {
        const a = loadout({ talismanIdMap: { 1: 11, 2: 12, 3: 0 } });
        expect(run(a)).toEqual([]);
        expect(run(loadout({ talismanIdMap: { 1: 11, 2: 0, 3: 0 } }))).toEqual([]);
    });

    test('deleted', () => {
        expect(codes(loadout({ talismanIdMap: { 1: 99, 2: 12, 3: 0 } }))).toEqual(['deleted1']);
        // an empty owned list (a character with none) is "loaded and empty": the id is gone
        expect(codes(loadout({ talismanIdMap: { 2: 12 } }), [])).toEqual(['deleted2']);
    });

    test('slot the belt lacks', () => {
        const small = loadout({
            wearableMap: { [BELT_LOC]: wear('/items/small_talisman_belt') },
            talismanIdMap: { 1: 11, 2: 12, 3: 0 },
        });
        expect(codes(small)).toEqual(['slot2']);
        // no belt in the loadout, or a belt the item data does not describe: undecidable, no warning
        expect(run(loadout({ wearableMap: {}, talismanIdMap: { 3: 12 } }))).toEqual([]);
        expect(
            run(loadout({ wearableMap: { [BELT_LOC]: wear('/items/unknown_belt') }, talismanIdMap: { 3: 12 } }))
        ).toEqual([]);
    });

    test('type mismatch both ways', () => {
        expect(codes(loadout({ talismanIdMap: { 1: 21 } }))).toEqual(['type1']);
        const skilling = loadout({ actionTypeHrid: '/action_types/woodcutting', talismanIdMap: { 1: 11, 2: 21 } });
        expect(codes(skilling)).toEqual(['type1']);
        // a type this code does not know is not judged
        expect(run(loadout({ talismanIdMap: { 1: 5 } }), [{ id: 5, talismanTypeHrid: '/talisman_types/x' }])).toEqual(
            []
        );
    });

    test('several warnings at once, ordered by slot; one talisman can carry two', () => {
        const small = loadout({
            wearableMap: { [BELT_LOC]: wear('/items/small_talisman_belt') },
            talismanIdMap: { 1: 99, 2: 21, 3: 12 },
        });
        expect(codes(small)).toEqual(['deleted1', 'slot2', 'type2', 'slot3']);
    });

    test('live server: nothing', () => {
        game.server = false;
        expect(run(loadout({ talismanIdMap: { 1: 99 } }))).toEqual([]);
    });

    test('commonWarnings keeps only what every namesake agrees on', () => {
        const a = run(loadout({ talismanIdMap: { 1: 99 } }));
        const b = run(loadout({ talismanIdMap: { 1: 11 } }));
        expect(commonWarnings([a, b])).toEqual([]);
        expect(commonWarnings([a, a]).map((w) => w.code)).toEqual(['deleted']);
        expect(commonWarnings([])).toEqual([]);
    });

    test('commonWarnings drops a shared code and slot whose reasons differ (Small vs Medium belt)', () => {
        const small = [
            { code: 'slot', slot: 3, text: "Slot 3: this loadout's belt has 1 slot, so this talisman does nothing." },
        ];
        const medium = [
            { code: 'slot', slot: 3, text: "Slot 3: this loadout's belt has 2 slots, so this talisman does nothing." },
        ];
        expect(commonWarnings([small, medium])).toEqual([]);
        expect(commonWarnings([medium, medium])).toEqual(medium);
    });
});
