import { describe, test, expect, vi, beforeEach } from 'vitest';
import {
    BELT_ITEMS,
    MODIFIER_DETAILS,
    TALISMAN_ENHANCEMENT_TABLE,
    talisman,
} from '../__fixtures__/talisman-bonuses.js';

const server = vi.hoisted(() => ({ test: true }));
vi.mock('./game-server.js', () => ({ isTestServer: () => server.test }));

const {
    computeTalismanBonuses,
    computeLoadoutTalismanBonuses,
    getTalismanPower,
    resolveLoadoutTalismans,
    attachTalismanBonuses,
    talismanBonusesOf,
    talismanStat,
    talismanBuff,
} = await import('./talisman-bonuses.js');

const base = {
    itemDetailMap: BELT_ITEMS,
    modifierDetailMap: MODIFIER_DETAILS,
    enhancementTable: TALISMAN_ENHANCEMENT_TABLE,
};
const large10 = { itemHrid: '/items/large_talisman_belt', enhancementLevel: 10 };

beforeEach(() => {
    server.test = true;
});

describe('talisman power', () => {
    test('a Large belt +10 is 0.2 + 0.004 x 14.5 = 0.258 (the table counts steps, not fractions)', () => {
        expect(getTalismanPower(large10, BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE)).toBeCloseTo(0.258, 10);
    });

    test('a +0 belt is its base, and no belt is nothing', () => {
        expect(
            getTalismanPower({ itemHrid: '/items/small_talisman_belt' }, BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE)
        ).toBe(0.1);
        expect(getTalismanPower(null, BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE)).toBe(0);
    });
});

describe('computeTalismanBonuses', () => {
    test('Milking Speed G2 under a Large belt +10 is 0.045 x 1.258 = 0.05661 (measured on the server)', () => {
        const out = computeTalismanBonuses({
            ...base,
            belt: large10,
            talismans: [talisman(1, 1, [['milking_speed', 2]])],
        });
        expect(out.noncombat.milkingSpeed).toBeCloseTo(0.05661, 10);
    });

    test('two talismans with the same modifier stack', () => {
        const out = computeTalismanBonuses({
            ...base,
            belt: large10,
            talismans: [talisman(1, 1, [['milking_speed', 2]]), talisman(2, 2, [['milking_speed', 2]])],
        });
        expect(out.noncombat.milkingSpeed).toBeCloseTo(2 * 0.05661, 10);
    });

    test('a universal Skilling Speed line is stored as skillingSpeed, which every skill reads', () => {
        const out = computeTalismanBonuses({
            ...base,
            belt: large10,
            talismans: [
                talisman(1, 1, [
                    ['skilling_speed', 1],
                    ['milking_speed', 1],
                ]),
            ],
        });
        expect(out.noncombat.skillingSpeed).toBeCloseTo(0.01 * 1.258, 10);
        expect(out.noncombat.milkingSpeed).toBeCloseTo(0.03 * 1.258, 10);
    });

    test('Gourmet and Processing land in buffs under their buff type hrids', () => {
        const out = computeTalismanBonuses({
            ...base,
            belt: large10,
            talismans: [
                talisman(1, 1, [
                    ['gourmet', 3],
                    ['processing', 1],
                ]),
            ],
        });
        expect(out.buffs['/buff_types/gourmet']).toBeCloseTo(0.02 * 1.258, 10);
        expect(out.buffs['/buff_types/processing']).toBeCloseTo(0.02 * 1.258, 10);
        expect(out.noncombat).toEqual({});
    });

    test('combat lines are computed apart, and a multi-key line gives every key the full value', () => {
        const out = computeTalismanBonuses({
            ...base,
            belt: large10,
            talismans: [
                talisman(
                    1,
                    1,
                    [
                        ['armor', 1],
                        ['melee_damage', 2],
                    ],
                    '/talisman_types/combat'
                ),
            ],
        });
        expect(out.combat.armor).toBeCloseTo(2.516, 10);
        for (const key of ['stabDamage', 'slashDamage', 'smashDamage']) {
            expect(out.combat[key]).toBeCloseTo(0.045 * 1.258, 10);
        }
        expect(out.noncombat).toEqual({});
    });

    test('a talisman in slot 3 under a Medium belt (2 slots) is ignored, as is an unslotted one', () => {
        const medium = { itemHrid: '/items/medium_talisman_belt', enhancementLevel: 0 };
        const out = computeTalismanBonuses({
            ...base,
            belt: medium,
            talismans: [
                talisman(1, 1, [['milking_speed', 1]]),
                talisman(2, 3, [['skilling_speed', 6]]),
                talisman(3, 0, [['skilling_speed', 6]]),
            ],
        });
        expect(out.noncombat.skillingSpeed).toBeUndefined();
        expect(out.noncombat.milkingSpeed).toBeCloseTo(0.03 * 1.15, 10);
    });

    test('no belt gives nothing, however many talismans are slotted', () => {
        const talismans = [talisman(1, 1, [['milking_speed', 6]])];
        expect(computeTalismanBonuses({ ...base, belt: null, talismans })).toEqual({
            noncombat: {},
            buffs: {},
            combat: {},
        });
    });

    test('off the test server gives nothing even with a belt and talismans', () => {
        server.test = false;
        const out = computeTalismanBonuses({
            ...base,
            belt: large10,
            talismans: [talisman(1, 1, [['milking_speed', 6]])],
        });
        expect(out).toEqual({ noncombat: {}, buffs: {}, combat: {} });
    });

    test('unknown modifiers and out-of-range grades are skipped, not zeroed into NaN', () => {
        const out = computeTalismanBonuses({
            ...base,
            belt: large10,
            talismans: [
                {
                    ...talisman(1, 1, [['milking_speed', 7]]),
                    modifiers: [
                        { hrid: '/talisman_modifiers/not_a_thing', grade: 1 },
                        { hrid: '/talisman_modifiers/milking_speed', grade: 7 },
                        { hrid: '/talisman_modifiers/milking_speed', grade: 0 },
                        { hrid: '/talisman_modifiers/skilling_speed', grade: 1 },
                    ],
                },
            ],
        });
        expect(Object.keys(out.noncombat)).toEqual(['skillingSpeed']);
    });
});

describe('a loadout', () => {
    const owned = [talisman(2624, 0, [['milking_speed', 2]]), talisman(9, 0, [['skilling_speed', 2]])];
    const equipment = [{ itemHrid: large10.itemHrid, enhancementLevel: 10, itemLocationHrid: '/item_locations/belt' }];

    test('resolves ids against owned talismans, skips zeros and deleted ids, and takes the loadout slot', () => {
        const resolved = resolveLoadoutTalismans({ 1: 9, 2: 0, 3: 777 }, owned);
        expect(resolved.map((t) => [t.id, t.slotIndex])).toEqual([[9, 1]]);
    });

    test('uses the loadout belt and its own talismans, whatever the character wears now', () => {
        const out = computeLoadoutTalismanBonuses({
            ...base,
            talismanIdMap: { 1: 2624, 2: 0, 3: 777 },
            equipment,
            ownedTalismans: owned,
        });
        expect(out.noncombat.milkingSpeed).toBeCloseTo(0.05661, 10);
        expect(out.noncombat.skillingSpeed).toBeUndefined();
    });

    test('a loadout with no talismanIdMap counts no talismans, and one with no belt counts none either', () => {
        expect(
            computeLoadoutTalismanBonuses({ ...base, talismanIdMap: undefined, equipment, ownedTalismans: owned })
        ).toEqual({ noncombat: {}, buffs: {}, combat: {} });
        expect(
            computeLoadoutTalismanBonuses({ ...base, talismanIdMap: { 1: 2624 }, equipment: [], ownedTalismans: owned })
        ).toEqual({ noncombat: {}, buffs: {}, combat: {} });
    });
});

describe('riding on an equipment Map', () => {
    test('a Map carries its set; a copy of it, or a Map never given one, carries nothing', () => {
        const map = new Map([['/item_locations/belt', large10]]);
        const bonuses = {
            noncombat: { milkingSpeed: 0.05, skillingSpeed: 0.01 },
            buffs: { '/buff_types/gourmet': 0.02 },
            combat: {},
        };
        attachTalismanBonuses(map, bonuses);
        expect(talismanStat(map, 'milkingSpeed', 'skillingSpeed', null)).toBeCloseTo(0.06, 10);
        expect(talismanBuff(map, '/buff_types/gourmet')).toBe(0.02);
        expect(talismanStat(new Map(map), 'milkingSpeed')).toBe(0);
        expect(talismanBonusesOf(undefined)).toEqual({ noncombat: {}, buffs: {}, combat: {} });
    });
});
