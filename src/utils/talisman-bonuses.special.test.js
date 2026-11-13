/**
 * Copies of a Special line count once in the skilling/shared bonus path and the dead-copy finder, and in the loadout
 * check (measured on the test server 2026-11-13: Fortify G2 at power 0.15 reads 0.01725 with one copy or two).
 */
import { describe, test, expect, vi } from 'vitest';
import { BELT_ITEMS } from '../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../__fixtures__/talisman-full-modifiers.js';

vi.mock('./game-server.js', () => ({ isTestServer: () => true }));

const { computeTalismanBonuses, deadSpecialLines } = await import('./talisman-bonuses.js');
const { checkLoadoutTalismans } = await import('./loadout-talisman-check.js');

const H = (key) => `/talisman_modifiers/${key}`;
const line = (key, grade) => ({ hrid: H(key), grade });
const talisman = (slotIndex, ...modifiers) => ({
    id: 100 + slotIndex,
    talismanTypeHrid: '/talisman_types/combat',
    modifiers,
    slotIndex,
});
const medium = { itemHrid: '/items/medium_talisman_belt', enhancementLevel: 0 };
const bonuses = (talismans) =>
    computeTalismanBonuses({
        talismans,
        belt: medium,
        itemDetailMap: BELT_ITEMS,
        modifierDetailMap: FULL_MODIFIER_DETAILS,
        enhancementTable: [],
    });

describe('computeTalismanBonuses', () => {
    test('a Special on two talismans counts once at the higher grade; the regular line sums', () => {
        const out = bonuses([
            talisman(1, line('fortify', 2), line('healing_amplify', 2)),
            talisman(2, line('fortify', 4), line('healing_amplify', 2)),
        ]);
        expect(out.combat.fortify).toBeCloseTo(0.025 * 1.15, 10);
        expect(out.combat.healingAmplify).toBeCloseTo(2 * 0.015 * 1.15, 10);
    });
});

describe('deadSpecialLines', () => {
    test('equal grades: the first slot counts; different grades: the higher counts', () => {
        expect(
            deadSpecialLines([talisman(1, line('fortify', 2)), talisman(2, line('fortify', 2))], FULL_MODIFIER_DETAILS)
        ).toEqual([{ slotIndex: 2, lineIndex: 0, hrid: H('fortify'), winnerSlot: 1 }]);
        expect(
            deadSpecialLines([talisman(1, line('fortify', 2)), talisman(2, line('fortify', 4))], FULL_MODIFIER_DETAILS)
        ).toEqual([{ slotIndex: 1, lineIndex: 0, hrid: H('fortify'), winnerSlot: 2 }]);
    });

    test('three copies leave two dead; regular lines and different Specials leave none', () => {
        const three = [talisman(1, line('smite', 1)), talisman(2, line('smite', 3)), talisman(3, line('smite', 2))];
        expect(deadSpecialLines(three, FULL_MODIFIER_DETAILS).map((d) => d.slotIndex)).toEqual([1, 3]);
        expect(
            deadSpecialLines(
                [
                    talisman(1, line('fortify', 2), line('healing_amplify', 2)),
                    talisman(2, line('echo', 2), line('healing_amplify', 2)),
                ],
                FULL_MODIFIER_DETAILS
            )
        ).toEqual([]);
    });

    test('a slot the belt lacks is not worn, so it kills nothing', () => {
        const list = [talisman(1, line('fortify', 2)), talisman(3, line('fortify', 6))];
        expect(deadSpecialLines(list, FULL_MODIFIER_DETAILS, 2)).toEqual([]);
    });
});

describe('loadout check: duplicate Special', () => {
    const BELT_LOC = '/item_locations/belt';
    const owned = [
        talisman(0, line('fortify', 2)),
        { ...talisman(0, line('fortify', 3)), id: 7 },
        { ...talisman(0, line('smite', 3)), id: 8 },
        { ...talisman(0, line('fortify', 2)), id: 9, talismanTypeHrid: '/talisman_types/skilling' },
    ];
    owned[0].id = 6;
    const loadout = (idMap, over = {}) => ({
        name: 'L',
        actionTypeHrid: '/action_types/combat',
        wearableMap: { [BELT_LOC]: '/items/large_talisman_belt::/item_locations/belt::0' },
        talismanIdMap: idMap,
        ...over,
    });
    const run = (l) =>
        checkLoadoutTalismans({
            loadout: l,
            ownedTalismans: owned,
            itemDetailMap: BELT_ITEMS,
            modifierDetailMap: FULL_MODIFIER_DETAILS,
        });

    test('two slots carrying the same Special warn on the weaker slot', () => {
        const warnings = run(loadout({ 1: 6, 2: 7, 3: 0 }));
        expect(warnings.map((w) => `${w.code}${w.slot}`)).toEqual(['duplicate1']);
        expect(warnings[0].text).toContain('Fortify');
        expect(warnings[0].text).toContain('slot 2');
    });

    test('different Specials, and a missing modifier map, warn about nothing', () => {
        expect(run(loadout({ 1: 6, 2: 8, 3: 0 }))).toEqual([]);
        expect(
            checkLoadoutTalismans({
                loadout: loadout({ 1: 6, 2: 7 }),
                ownedTalismans: owned,
                itemDetailMap: BELT_ITEMS,
            })
        ).toEqual([]);
    });

    test('a copy on a talisman that does nothing here (wrong type, or a slot the belt lacks) is not blamed', () => {
        // The skilling talisman is already reported as `type`; it must not also make the combat Fortify "duplicate"
        expect(run(loadout({ 1: 6, 2: 9 })).map((w) => w.code)).toEqual(['type']);
        const small = loadout(
            { 1: 6, 2: 7 },
            { wearableMap: { [BELT_LOC]: '/items/small_talisman_belt::/item_locations/belt::0' } }
        );
        expect(run(small).map((w) => w.code)).toEqual(['slot']);
    });
});

describe('one rule for Special', () => {
    test('a mechanic modifier with no groupHrid is Special everywhere', async () => {
        const { isSpecialModifierDetail } = await import('./talisman-bonuses.js');
        const bare = { ...FULL_MODIFIER_DETAILS[H('fortify')], groupHrid: undefined };
        const map = { ...FULL_MODIFIER_DETAILS, [H('fortify')]: bare };
        expect(isSpecialModifierDetail(bare)).toBe(true);
        expect(isSpecialModifierDetail(FULL_MODIFIER_DETAILS[H('critical_damage')])).toBe(false);
        expect(deadSpecialLines([talisman(1, line('fortify', 2)), talisman(2, line('fortify', 2))], map)).toHaveLength(
            1
        );
        const out = computeTalismanBonuses({
            talismans: [talisman(1, line('fortify', 2)), talisman(2, line('fortify', 2))],
            belt: medium,
            itemDetailMap: BELT_ITEMS,
            modifierDetailMap: map,
            enhancementTable: [],
        });
        expect(out.combat.fortify).toBeCloseTo(0.01725, 10);
    });
});
