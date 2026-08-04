/**
 * Tests for the shared action-time and efficiency calculation.
 *
 * Every non-combat panel that quotes an actions-per-hour figure gets it from here, so the
 * arithmetic is worth pinning even though each individual step is small. The parsers this file
 * calls out to — equipment, tea, house — are mocked, because what is under test is how their
 * answers combine, not how each is read.
 *
 * Two things in particular are easy to get wrong and are asserted directly: speed bonuses stack
 * additively inside one divisor while the task bonus applies multiplicatively on top of it, and
 * efficiency does not shorten an action at all — it is a separate multiplier on output.
 *
 * Expected values are hand-computed in comments.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const character = vi.hoisted(() => ({
    /** `${actionType}|${buffType}` → flat boost, as the decimal the game reports */
    personalBuffs: {},
    /** `${actionType}|${buffType}` → flat boost */
    achievementBuffs: {},
    guildBuffs: {},
    communityBuffLevels: {},
    taskActions: new Set(),
    taskSpeedBonus: 0,
}));

const parsers = vi.hoisted(() => ({
    equipmentSpeed: 0,
    equipmentEfficiency: 0,
    houseEfficiency: 0,
    teaEfficiency: 0,
    teaEfficiencyBreakdown: [],
    drinkConcentration: 0,
    actionLevelBonus: 0,
    actionLevelBreakdown: [],
    teaSkillLevelBonus: 0,
    drinks: [],
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return { guildActionTypeBuffsMap: character.guildBuffs };
        },
        getPersonalBuffFlatBoost: (type, buff) => character.personalBuffs[`${type}|${buff}`] || 0,
        getAchievementBuffFlatBoost: (type, buff) => character.achievementBuffs[`${type}|${buff}`] || 0,
        getCommunityBuffLevel: (hrid) => character.communityBuffLevels[hrid] || 0,
        isTaskAction: (hrid) => character.taskActions.has(hrid),
        getTaskSpeedBonus: () => character.taskSpeedBonus,
    },
}));

vi.mock('./equipment-parser.js', () => ({
    parseEquipmentSpeedBonuses: () => parsers.equipmentSpeed,
    parseEquipmentEfficiencyBonuses: () => parsers.equipmentEfficiency,
}));

vi.mock('./tea-parser.js', () => ({
    parseTeaEfficiency: () => parsers.teaEfficiency,
    parseTeaEfficiencyBreakdown: () => parsers.teaEfficiencyBreakdown,
    getDrinkConcentration: () => parsers.drinkConcentration,
    parseActionLevelBonus: () => parsers.actionLevelBonus,
    parseActionLevelBonusBreakdown: () => parsers.actionLevelBreakdown,
    parseTeaSkillLevelBonus: () => parsers.teaSkillLevelBonus,
}));

vi.mock('./house-efficiency.js', () => ({
    calculateHouseEfficiency: () => parsers.houseEfficiency,
}));

vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: [], drinks: parsers.drinks }),
}));

const { calculateActionStats } = await import('./action-calculator.js');

const CHEESESMITHING = '/action_types/cheesesmithing';

/**
 * A 20-second cheesesmithing action requiring level 30.
 * @param {Object} [overrides]
 * @returns {Object}
 */
const action = (overrides = {}) => ({
    type: CHEESESMITHING,
    baseTimeCost: 20e9,
    levelRequirement: { level: 30 },
    ...overrides,
});

/** @param {number} level @returns {Array} */
const skillsAt = (level) => [{ skillHrid: '/skills/cheesesmithing', level }];

beforeEach(() => {
    character.personalBuffs = {};
    character.achievementBuffs = {};
    character.guildBuffs = {};
    character.communityBuffLevels = {};
    character.taskActions = new Set();
    character.taskSpeedBonus = 0;

    parsers.equipmentSpeed = 0;
    parsers.equipmentEfficiency = 0;
    parsers.houseEfficiency = 0;
    parsers.teaEfficiency = 0;
    parsers.teaEfficiencyBreakdown = [];
    parsers.drinkConcentration = 0;
    parsers.actionLevelBonus = 0;
    parsers.actionLevelBreakdown = [];
    parsers.teaSkillLevelBonus = 0;
    parsers.drinks = [];
});

describe('action time', () => {
    test('base time comes from nanoseconds, with no bonuses applied', () => {
        const stats = calculateActionStats(action(), { skills: skillsAt(30), equipment: [] });

        expect(stats.actionTime).toBeCloseTo(20, 9);
    });

    test('speed bonuses divide the base time', () => {
        // 20 / (1 + 0.25) = 16
        parsers.equipmentSpeed = 0.25;

        expect(calculateActionStats(action(), { skills: skillsAt(30), equipment: [] }).actionTime).toBeCloseTo(16, 9);
    });

    test('equipment, personal, and guild speed all share one divisor', () => {
        // 20 / (1 + 0.25 + 0.05 + 0.10) = 20 / 1.4 = 14.2857
        // Stacking them multiplicatively would give 20/1.25/1.05/1.10 = 13.85 — noticeably faster
        parsers.equipmentSpeed = 0.25;
        character.personalBuffs[`${CHEESESMITHING}|/buff_types/action_speed`] = 0.05;
        character.guildBuffs[CHEESESMITHING] = [{ typeHrid: '/buff_types/action_speed', flatBoost: 0.1 }];

        expect(calculateActionStats(action(), { skills: skillsAt(30), equipment: [] }).actionTime).toBeCloseTo(
            20 / 1.4,
            9
        );
    });

    test('a guild buff’s flat and ratio parts both count', () => {
        // 20 / (1 + 0.06 + 0.04) = 20 / 1.1
        character.guildBuffs[CHEESESMITHING] = [
            { typeHrid: '/buff_types/action_speed', flatBoost: 0.06, ratioBoost: 0.04 },
        ];

        expect(calculateActionStats(action(), { skills: skillsAt(30), equipment: [] }).actionTime).toBeCloseTo(
            20 / 1.1,
            9
        );
    });

    test('guild buffs for other action types are ignored', () => {
        character.guildBuffs['/action_types/cooking'] = [{ typeHrid: '/buff_types/action_speed', flatBoost: 5 }];

        expect(calculateActionStats(action(), { skills: skillsAt(30), equipment: [] }).actionTime).toBeCloseTo(20, 9);
    });

    test('the task speed bonus applies on top, multiplicatively', () => {
        // 20 / (1 + 0.25) = 16, then 16 / 1.15 = 13.913
        // Folded into the same divisor it would come out 20/1.40 = 14.286 instead
        parsers.equipmentSpeed = 0.25;
        character.taskActions.add('/actions/cheesesmithing/cheese_gauntlets');
        character.taskSpeedBonus = 15;

        const stats = calculateActionStats(action(), {
            skills: skillsAt(30),
            equipment: [],
            actionHrid: '/actions/cheesesmithing/cheese_gauntlets',
        });

        expect(stats.actionTime).toBeCloseTo(16 / 1.15, 9);
    });

    test('the task bonus is skipped for an action that is not the active task', () => {
        character.taskSpeedBonus = 15;

        const stats = calculateActionStats(action(), {
            skills: skillsAt(30),
            equipment: [],
            actionHrid: '/actions/cheesesmithing/cheese_gauntlets',
        });

        expect(stats.actionTime).toBeCloseTo(20, 9);
    });

    test('the game’s three-second floor is enforced', () => {
        // 20 / 21 = 0.95s, which the server would never honour
        parsers.equipmentSpeed = 20;

        expect(calculateActionStats(action(), { skills: skillsAt(30), equipment: [] }).actionTime).toBe(3);
    });
});

describe('efficiency', () => {
    test('efficiency is one percent per level above the requirement', () => {
        // Level 45 on a level-30 action → 15%
        const stats = calculateActionStats(action(), { skills: skillsAt(45), equipment: [] });

        expect(stats.totalEfficiency).toBeCloseTo(15, 9);
    });

    test('being under-levelled gives no efficiency, never a negative one', () => {
        // The action is still runnable at level, and a negative would subtract from the other sources
        const stats = calculateActionStats(action(), { skills: skillsAt(20), equipment: [] });

        expect(stats.totalEfficiency).toBe(0);
    });

    test('every source stacks additively', () => {
        // level 15 + house 8 + equipment 4 + tea 10 + achievement 3 + personal 2 + guild 5 = 47
        parsers.houseEfficiency = 8;
        parsers.equipmentEfficiency = 4;
        parsers.teaEfficiency = 10;
        character.achievementBuffs[`${CHEESESMITHING}|/buff_types/efficiency`] = 0.03;
        character.personalBuffs[`${CHEESESMITHING}|/buff_types/efficiency`] = 0.02;
        character.guildBuffs[CHEESESMITHING] = [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.05 }];

        const stats = calculateActionStats(action(), { skills: skillsAt(45), equipment: [] });

        expect(stats.totalEfficiency).toBeCloseTo(47, 9);
    });

    test('achievement and personal buffs arrive as decimals and are read as percentages', () => {
        // 0.05 from the game means 5%, not 0.05%
        character.achievementBuffs[`${CHEESESMITHING}|/buff_types/efficiency`] = 0.05;

        expect(calculateActionStats(action(), { skills: skillsAt(30), equipment: [] }).totalEfficiency).toBeCloseTo(
            5,
            9
        );
    });

    test('tea action-level bonus raises the requirement, cutting level efficiency', () => {
        // Requirement 30 + 8 = 38, level 45 → 7% instead of 15%
        parsers.actionLevelBonus = 8;

        expect(calculateActionStats(action(), { skills: skillsAt(45), equipment: [] }).totalEfficiency).toBeCloseTo(
            7,
            9
        );
    });

    test('the action-level bonus is kept fractional, as the game keeps it', () => {
        // 30 + 7.5 = 37.5 against level 45 → 7.5%, not 8% from a floored bonus
        parsers.actionLevelBonus = 7.5;

        expect(calculateActionStats(action(), { skills: skillsAt(45), equipment: [] }).totalEfficiency).toBeCloseTo(
            7.5,
            9
        );
    });

    test('tea skill-level bonus raises the player’s level instead of the requirement', () => {
        // Level 45 + 8 = 53 against requirement 30 → 23%
        parsers.teaSkillLevelBonus = 8;

        expect(calculateActionStats(action(), { skills: skillsAt(45), equipment: [] }).totalEfficiency).toBeCloseTo(
            23,
            9
        );
    });

    test('a level override replaces the action’s own requirement', () => {
        // Alchemy charges by item level, not by the action's nominal requirement
        const stats = calculateActionStats(action(), {
            skills: skillsAt(45),
            equipment: [],
            levelRequirementOverride: 40,
        });

        expect(stats.totalEfficiency).toBeCloseTo(5, 9);
    });

    test('an action with no stated requirement is treated as level 1', () => {
        const stats = calculateActionStats(action({ levelRequirement: undefined }), {
            skills: skillsAt(45),
            equipment: [],
        });

        expect(stats.totalEfficiency).toBeCloseTo(44, 9);
    });

    test('an unknown skill counts as level 1 rather than crashing', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
        const stats = calculateActionStats(action(), { skills: [], equipment: [] });

        expect(stats.totalEfficiency).toBe(0);
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });

    test('combat and labyrinth actions get no level efficiency at all', () => {
        // They do not map to one skill, so scaling off "the" skill level would be meaningless
        for (const type of ['/action_types/combat', '/action_types/labyrinth']) {
            const stats = calculateActionStats(action({ type, levelRequirement: { level: 1 } }), {
                skills: skillsAt(99),
                equipment: [],
            });
            expect(stats.totalEfficiency).toBe(0);
        }
    });
});

describe('community buff efficiency', () => {
    test('it is off unless asked for', () => {
        character.communityBuffLevels['/community_buff_types/production_efficiency'] = 1;

        expect(calculateActionStats(action(), { skills: skillsAt(30), equipment: [] }).totalEfficiency).toBe(0);
    });

    test('level 1 is 14%, and each level after adds 0.3%', () => {
        // (0.14 + (level − 1)·0.003) × 100
        const at = (level) => {
            character.communityBuffLevels['/community_buff_types/production_efficiency'] = level;
            return calculateActionStats(action(), {
                skills: skillsAt(30),
                equipment: [],
                includeCommunityBuff: true,
            }).totalEfficiency;
        };

        expect(at(1)).toBeCloseTo(14, 9);
        expect(at(2)).toBeCloseTo(14.3, 9);
        expect(at(20)).toBeCloseTo(19.7, 9);
    });

    test('an inactive buff contributes nothing', () => {
        character.communityBuffLevels['/community_buff_types/production_efficiency'] = 0;

        const stats = calculateActionStats(action(), {
            skills: skillsAt(30),
            equipment: [],
            includeCommunityBuff: true,
        });

        expect(stats.totalEfficiency).toBe(0);
    });

    test('it applies to the production skills and alchemy, and to nothing else', () => {
        character.communityBuffLevels['/community_buff_types/production_efficiency'] = 1;
        const efficiencyFor = (type) =>
            calculateActionStats(action({ type, levelRequirement: { level: 1 } }), {
                skills: [{ skillHrid: type.replace('/action_types/', '/skills/'), level: 1 }],
                equipment: [],
                includeCommunityBuff: true,
            }).totalEfficiency;

        for (const type of [
            '/action_types/alchemy',
            '/action_types/brewing',
            '/action_types/cheesesmithing',
            '/action_types/cooking',
            '/action_types/crafting',
            '/action_types/tailoring',
        ]) {
            expect(efficiencyFor(type)).toBeCloseTo(14, 9);
        }

        for (const type of ['/action_types/milking', '/action_types/foraging', '/action_types/woodcutting']) {
            expect(efficiencyFor(type)).toBe(0);
        }
    });
});

describe('breakdown', () => {
    test('it is absent unless asked for', () => {
        const stats = calculateActionStats(action(), { skills: skillsAt(45), equipment: [] });

        expect(stats.efficiencyBreakdown).toBeUndefined();
        expect(Object.keys(stats)).toEqual(['actionTime', 'totalEfficiency']);
    });

    test('the parts add up to the total', () => {
        parsers.houseEfficiency = 8;
        parsers.equipmentEfficiency = 4;
        parsers.teaEfficiencyBreakdown = [
            { name: 'Cheesesmithing Tea', efficiency: 6 },
            { name: 'Super Cheesesmithing Tea', efficiency: 4 },
        ];
        character.communityBuffLevels['/community_buff_types/production_efficiency'] = 1;

        const stats = calculateActionStats(action(), {
            skills: skillsAt(45),
            equipment: [],
            includeBreakdown: true,
            includeCommunityBuff: true,
        });
        const parts = stats.efficiencyBreakdown;
        const summed =
            parts.levelEfficiency +
            parts.houseEfficiency +
            parts.equipmentEfficiency +
            parts.teaEfficiency +
            parts.communityEfficiency +
            parts.achievementEfficiency +
            parts.personalEfficiency +
            parts.guildEfficiency;

        expect(summed).toBeCloseTo(stats.totalEfficiency, 9);
    });

    test('the tea total is the sum of the itemised teas', () => {
        parsers.teaEfficiencyBreakdown = [
            { name: 'Cheesesmithing Tea', efficiency: 6 },
            { name: 'Super Cheesesmithing Tea', efficiency: 4 },
        ];
        // The non-breakdown path would report this, and the two must not disagree
        parsers.teaEfficiency = 999;

        const stats = calculateActionStats(action(), {
            skills: skillsAt(30),
            equipment: [],
            includeBreakdown: true,
        });

        expect(stats.efficiencyBreakdown.teaEfficiency).toBeCloseTo(10, 9);
        expect(stats.totalEfficiency).toBeCloseTo(10, 9);
    });

    test('it reports the requirement it actually used', () => {
        parsers.actionLevelBonus = 7.5;
        parsers.teaSkillLevelBonus = 3;

        const parts = calculateActionStats(action(), {
            skills: skillsAt(45),
            equipment: [],
            includeBreakdown: true,
        }).efficiencyBreakdown;

        expect(parts.baseRequirement).toBe(30);
        expect(parts.actionLevelBonus).toBe(7.5);
        expect(parts.effectiveRequirement).toBeCloseTo(37.5, 9);
        expect(parts.skillLevel).toBe(45);
        // 45 + 3 − 37.5 = 10.5
        expect(parts.levelEfficiency).toBeCloseTo(10.5, 9);
    });
});

describe('failure handling', () => {
    test('a malformed action is logged and returns null rather than throwing', () => {
        const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(calculateActionStats(null, { skills: skillsAt(30), equipment: [] })).toBeNull();
        expect(logged).toHaveBeenCalled();
        logged.mockRestore();
    });
});
