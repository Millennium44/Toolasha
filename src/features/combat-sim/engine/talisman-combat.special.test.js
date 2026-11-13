/**
 * Special lines in the sim's talisman stats. Measured on the test server 2026-11-13 (belt power 0.15): Fortify G2
 * (0.015) reads combatStats.fortify = 0.01725 with one talisman slotted and the same with both, while Healing Amplify
 * (a regular line on both) rose by 0.01725 for the second.
 */
import { describe, test, expect } from 'vitest';
import { computeTalismanCombat, TALISMAN_MECHANICS } from './talisman-combat.js';
import { BELT_ITEMS } from '../../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../../__fixtures__/talisman-full-modifiers.js';

const H = (key) => `/talisman_modifiers/${key}`;
const MODELED = new Set(['healingAmplify', 'criticalDamage', 'physicalAmplify']);

const gameData = {
    talismansEnabled: true,
    talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
    itemDetailMap: BELT_ITEMS,
    enhancementLevelTotalBonusMultiplierTable: [],
};
// Medium belt, +0: 2 slots, power 0.15
const MEDIUM = { hrid: '/items/medium_talisman_belt', enhancementLevel: 0 };
const LARGE = { hrid: '/items/large_talisman_belt', enhancementLevel: 0 };

const line = (key, grade) => ({ hrid: H(key), grade });
const talisman = (slotIndex, ...modifiers) => ({
    id: slotIndex,
    talismanTypeHrid: '/talisman_types/combat',
    modifiers,
    slotIndex,
});
const run = (talismans, belt = MEDIUM) => computeTalismanCombat({ talismans, belt, gameData, modeledStats: MODELED });

describe('Special lines count once', () => {
    test('the measured case: Fortify G2 at power 0.15 is 0.01725 with one copy or two', () => {
        const one = run([talisman(1, line('fortify', 2))]);
        const two = run([talisman(1, line('fortify', 2)), talisman(2, line('fortify', 2))]);
        expect(one.mechanics.fortify).toBeCloseTo(0.01725, 10);
        expect(two.mechanics.fortify).toBeCloseTo(0.01725, 10);
    });

    test('a regular line on both talismans still sums, beside a special that does not', () => {
        const out = run([
            talisman(1, line('fortify', 2), line('healing_amplify', 2)),
            talisman(2, line('fortify', 2), line('healing_amplify', 2)),
        ]);
        const heal = FULL_MODIFIER_DETAILS[H('healing_amplify')].gradeValues[1];
        expect(out.stats.healingAmplify).toBeCloseTo(2 * heal * 1.15, 10);
        expect(out.mechanics.fortify).toBeCloseTo(0.01725, 10);
    });

    test('different grades: the higher grade counts, in either slot order', () => {
        const g4 = FULL_MODIFIER_DETAILS[H('fortify')].gradeValues[3] * 1.15;
        expect(run([talisman(1, line('fortify', 2)), talisman(2, line('fortify', 4))]).mechanics.fortify).toBeCloseTo(
            g4,
            10
        );
        expect(run([talisman(1, line('fortify', 4)), talisman(2, line('fortify', 2))]).mechanics.fortify).toBeCloseTo(
            g4,
            10
        );
    });

    test('three copies on a Large belt: still one, at the best grade', () => {
        const out = run(
            [talisman(1, line('smite', 1)), talisman(2, line('smite', 3)), talisman(3, line('smite', 2))],
            LARGE
        );
        expect(out.mechanics.smite).toBeCloseTo(0.06 * 1.2, 10);
    });

    test('one special plus a different special: both count', () => {
        const out = run([talisman(1, line('fortify', 2)), talisman(2, line('echo', 3))]);
        expect(out.mechanics.fortify).toBeCloseTo(0.015 * 1.15, 10);
        expect(out.mechanics.echo).toBeCloseTo(0.06 * 1.15, 10);
    });

    test('belt power scales the one counted copy', () => {
        const pair = [talisman(1, line('fortify', 2)), talisman(2, line('fortify', 2))];
        expect(run(pair).mechanics.fortify).toBeCloseTo(0.015 * 1.15, 10);
        expect(run(pair, LARGE).mechanics.fortify).toBeCloseTo(0.015 * 1.2, 10);
    });

    test('a mechanic is a Special even if the table carries no group label', () => {
        const stripped = {};
        for (const [hrid, d] of Object.entries(FULL_MODIFIER_DETAILS)) stripped[hrid] = { ...d, groupHrid: undefined };
        const out = computeTalismanCombat({
            talismans: [talisman(1, line('fortify', 2)), talisman(2, line('fortify', 2))],
            belt: MEDIUM,
            gameData: { ...gameData, talismanModifierDetailMap: stripped },
            modeledStats: MODELED,
        });
        expect(TALISMAN_MECHANICS).toContain('fortify');
        expect(out.mechanics.fortify).toBeCloseTo(0.01725, 10);
    });
});
