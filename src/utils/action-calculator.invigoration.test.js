/**
 * Invigoration (talisman Special line) on the shared action stats. The line is a chance p to double the active
 * drinks' effects on a cooking or brewing action (on top of Drink Concentration), so there are two outcomes, each worked
 * out whole and weighted (1 - p) and p: level efficiency is clamped at 0, which an averaged drink cannot see.
 * Large belt +10 is Talisman Power 0.258; Invigoration G4 (0.075) is 0.075 x 1.258 = 0.09435.
 */

import { describe, test, expect, vi } from 'vitest';
import { attachTalismanBonuses } from './talisman-bonuses.js';

const seen = vi.hoisted(() => ({ efficiency: [], actionLevel: [], dc: 0 }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getPersonalBuffFlatBoost: () => 0,
        getAchievementBuffFlatBoost: () => 0,
        characterData: {},
        isTaskAction: () => false,
    },
}));
vi.mock('./equipment-parser.js', () => ({
    parseEquipmentSpeedBonuses: () => 0,
    parseEquipmentEfficiencyBonuses: () => 0,
}));
vi.mock('./tea-parser.js', () => ({
    getDrinkConcentration: () => seen.dc,
    // an Artisan-style tea: +5 Action Level and +10% efficiency, both scaled by the concentration it is read with
    parseActionLevelBonus: (_d, _m, dc) => {
        seen.actionLevel.push(dc);
        return 5 * (1 + dc);
    },
    parseActionLevelBonusBreakdown: () => [],
    parseTeaSkillLevelBonus: () => 0,
    parseTeaEfficiency: (_t, _d, _m, dc) => {
        seen.efficiency.push(dc);
        return 10 * (1 + dc);
    },
    parseTeaEfficiencyBreakdown: () => [],
}));
vi.mock('./house-efficiency.js', () => ({ calculateHouseEfficiency: () => 0, calculateHouseActionSpeed: () => 0 }));
vi.mock('./community-buffs.js', () => ({ getCommunityProductionEfficiency: () => 0 }));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));

const { calculateActionStats } = await import('./action-calculator.js');

const wearing = (noncombat) => attachTalismanBonuses(new Map(), { noncombat, buffs: {}, combat: {} });
const run = (type, equipment, skillLevel, extra = {}) =>
    calculateActionStats(
        { type, baseTimeCost: 6e9, levelRequirement: { level: 50 } },
        {
            skills: [{ skillHrid: `/skills/${type.replace('/action_types/', '')}`, level: skillLevel }],
            equipment,
            actionContext: { equipment, drinks: [{ itemHrid: '/items/tea' }], ...extra },
            itemDetailMap: {},
        }
    );

describe('calculateActionStats with Invigoration', () => {
    test('at the clamp: skill 56, requirement 50, a +5 Action Level drink, 12% chance, is 0.88% efficiency, not 0.4%', () => {
        seen.dc = 0;
        // chance 0.12 is the stat as the engine reads it (the belt power is already inside it)
        const stats = run('/action_types/cooking', wearing({ invigoration: 0.12 }), 56);
        // normal: 56 - (50 + 5) = 1 level of efficiency; doubled: 56 - (50 + 10) clamps to 0
        // tea efficiency is not in level efficiency: 10 x 1 normal and 10 x 2 doubled
        const levelOnly = 0.88 * 1 + 0.12 * 0;
        const tea = 0.88 * 10 + 0.12 * 20;
        expect(stats.totalEfficiency).toBeCloseTo(levelOnly + tea, 10);
        // averaging the drinks first would have read +5.6 Action Level: 56 - 55.6 = 0.4
        expect(stats.totalEfficiency).not.toBeCloseTo(0.4 + 10 * 1.12, 6);
    });

    test('away from the clamp the outcomes agree with averaging: skill 80 gives 24.4 level efficiency either way', () => {
        seen.dc = 0;
        const stats = run('/action_types/brewing', wearing({ invigoration: 0.12 }), 80);
        // normal 80 - 55 = 25, doubled 80 - 60 = 20: 0.88 x 25 + 0.12 x 20 = 24.4 = 80 - (50 + 5.6)
        expect(stats.totalEfficiency).toBeCloseTo(24.4 + (0.88 * 10 + 0.12 * 20), 10);
    });

    test('the doubled outcome reads (1 + DC) x 2 - 1 on top of Drink Concentration', () => {
        seen.dc = 0.1;
        seen.efficiency = [];
        run('/action_types/cooking', wearing({ invigoration: 0.12 }), 80);
        expect(seen.efficiency.sort()).toEqual([0.1, 1.2000000000000002].sort());
    });

    test('another skill is read once, with the plain Drink Concentration', () => {
        seen.dc = 0.1;
        seen.efficiency = [];
        run('/action_types/woodcutting', wearing({ invigoration: 0.12 }), 80);
        expect(seen.efficiency).toEqual([0.1]);
    });
});
