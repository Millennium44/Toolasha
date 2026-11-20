/**
 * Invigoration (talisman Special line) on the shared action stats: on a cooking or brewing action the drinks'
 * effects (tea efficiency, tea skill level, Action Level) are read with a concentration (1 + DC) x (1 + chance) - 1,
 * so efficiency, queue times and XP/hr agree with the profit math. Large belt +10 is Talisman Power 0.258;
 * Invigoration G3 is 0.06 x 1.258 = 0.07548.
 */

import { describe, test, expect, vi } from 'vitest';
import { attachTalismanBonuses } from './talisman-bonuses.js';

const seen = vi.hoisted(() => ({ efficiency: null, level: null, actionLevel: null }));

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
    getDrinkConcentration: () => 0.1,
    parseActionLevelBonus: (_d, _m, dc) => {
        seen.actionLevel = dc;
        return 0;
    },
    parseActionLevelBonusBreakdown: () => [],
    parseTeaSkillLevelBonus: (_t, _d, _m, dc) => {
        seen.level = dc;
        return 0;
    },
    parseTeaEfficiency: (_t, _d, _m, dc) => {
        seen.efficiency = dc;
        return 10 * (1 + dc);
    },
    parseTeaEfficiencyBreakdown: () => [],
}));
vi.mock('./house-efficiency.js', () => ({ calculateHouseEfficiency: () => 0, calculateHouseActionSpeed: () => 0 }));
vi.mock('./community-buffs.js', () => ({ getCommunityProductionEfficiency: () => 0 }));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));

const { calculateActionStats } = await import('./action-calculator.js');

const wearing = (noncombat) => attachTalismanBonuses(new Map(), { noncombat, buffs: {}, combat: {} });
const action = (type) => ({ type, baseTimeCost: 6e9, levelRequirement: { level: 1 } });
const run = (type, equipment) =>
    calculateActionStats(action(type), {
        skills: [{ skillHrid: `/skills/${type.replace('/action_types/', '')}`, level: 1 }],
        equipment,
        actionContext: { equipment, drinks: [{ itemHrid: '/items/efficiency_tea' }] },
        itemDetailMap: {},
    });

describe('calculateActionStats with Invigoration', () => {
    test('cooking reads the drinks at (1 + 0.1) x (1 + 0.07548) - 1', () => {
        const stats = run('/action_types/cooking', wearing({ invigoration: 0.06 * 1.258 }));
        const expected = 1.1 * (1 + 0.06 * 1.258) - 1;
        expect(seen.efficiency).toBeCloseTo(expected, 12);
        expect(seen.level).toBeCloseTo(expected, 12);
        expect(seen.actionLevel).toBeCloseTo(expected, 12);
        expect(stats.totalEfficiency).toBeCloseTo(10 * (1 + expected), 10);
    });

    test('another skill reads the plain Drink Concentration, with the stat worn or not', () => {
        run('/action_types/woodcutting', wearing({ invigoration: 0.06 * 1.258 }));
        expect(seen.efficiency).toBeCloseTo(0.1, 12);
        run('/action_types/brewing', new Map());
        expect(seen.efficiency).toBeCloseTo(0.1, 12);
    });
});
