/**
 * enhancement-xp: the buff sources the game sums for an enhancing action.
 *
 * The client builds an action's buffs from eight maps (calcSkillingActionTypeBuffsDict: MooPass,
 * community, house, guild, achievement, consumable, equipment, personal) and its success XP is
 * 1.4 × (1 + Σ wisdom) × (enhancementLevel + 1) × (10 + itemLevel). Reading only some of the maps
 * drops the MooPass's wisdom and a Scroll of Wisdom from every XP figure.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    characterData: null,
    personal: {},
    achievement: {},
    manualOverrides: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return state.characterData;
        },
        getInitClientData: () => ({
            itemDetailMap: { '/items/test_sword': { itemLevel: 50 } },
        }),
        getActionDetails: () => ({ baseTimeCost: 12e9 }),
        getPersonalBuffFlatBoost: (_action, buff) => state.personal[buff] || 0,
        getAchievementBuffFlatBoost: (_action, buff) => state.achievement[buff] || 0,
        getAchievementBuffRatioBoost: () => 0,
    },
}));

vi.mock('../../utils/enhancement-config.js', () => ({
    getEnhancingParams: () => ({
        enhancingLevel: 60,
        toolBonus: 0,
        speedBonus: 0,
        guzzlingBonus: 1,
        teas: { blessed: false },
        manualOverrides: state.manualOverrides,
    }),
    describeParamsSource: () => null,
}));

import { calculateEnhancementPredictions, calculateSuccessXP, getEnhancingActionTime } from './enhancement-xp.js';

const enhancing = (buffs) => ({ '/action_types/enhancing': buffs });

beforeEach(() => {
    state.manualOverrides = [];
    state.personal = {};
    state.achievement = {};
    state.characterData = {
        characterSkills: [{ skillHrid: '/skills/enhancing', level: 60 }],
    };
});

describe('calculateSuccessXP', () => {
    test('counts the MooPass wisdom the game applies', () => {
        state.characterData.mooPassActionTypeBuffsMap = enhancing([
            { typeHrid: '/buff_types/wisdom', flatBoost: 0.05, ratioBoost: 0 },
        ]);
        // 1.4 × 1.05 × (0 + 1) × (10 + 50) = 88.2
        expect(calculateSuccessXP(0, '/items/test_sword')).toBe(Math.floor(1.4 * 1.05 * 60));
    });

    test('counts a Scroll of Wisdom (personal buff) alongside the other sources', () => {
        state.characterData.equipmentActionTypeBuffsMap = enhancing([
            { typeHrid: '/buff_types/wisdom', flatBoost: 0.1, ratioBoost: 0 },
        ]);
        state.personal['/buff_types/wisdom'] = 0.2;
        state.achievement['/buff_types/wisdom'] = 0.02;
        // At +3: 1.4 × (1 + 0.32) × 4 × 60
        expect(calculateSuccessXP(3, '/items/test_sword')).toBe(Math.floor(1.4 * 1.32 * 4 * 60));
    });
});

describe('getEnhancingActionTime', () => {
    test('sums action speed from every source and boosts the level with every enhancing_level buff', () => {
        state.characterData.houseActionTypeBuffsMap = enhancing([
            { typeHrid: '/buff_types/action_speed', flatBoost: 0.08, ratioBoost: 0 },
        ]);
        state.characterData.mooPassActionTypeBuffsMap = enhancing([
            { typeHrid: '/buff_types/action_speed', flatBoost: 0.02, ratioBoost: 0 },
        ]);
        state.achievement['/buff_types/action_speed'] = 0.03;
        state.characterData.consumableActionTypeBuffsMap = enhancing([
            { typeHrid: '/buff_types/enhancing_level', flatBoost: 8.8, ratioBoost: 0 },
            { typeHrid: '/buff_types/action_speed', flatBoost: 0.066, ratioBoost: 0 },
        ]);

        // Boosted level 68.8 against item level 50 adds 18.8% speed
        const speed = 0.08 + 0.02 + 0.03 + 0.066 + 0.188;
        expect(getEnhancingActionTime('/items/test_sword')).toBeCloseTo(12 / (1 + speed), 9);
    });
});

describe('calculateEnhancementPredictions', () => {
    test('says whether the bench it predicted on was edited, so calibration can decline it', () => {
        expect(calculateEnhancementPredictions('/items/test_sword', 0, 3, 0).benchEdited).toBe(false);
        state.manualOverrides = ['Enhancing level'];
        expect(calculateEnhancementPredictions('/items/test_sword', 0, 3, 0).benchEdited).toBe(true);
    });
});

describe('XP for a hypothetical bench', () => {
    test('uses the wisdom it is handed, not the live MooPass, scroll or achievement buffs', () => {
        state.characterData.mooPassActionTypeBuffsMap = enhancing([
            { typeHrid: '/buff_types/wisdom', flatBoost: 0.05, ratioBoost: 0 },
        ]);
        state.personal['/buff_types/wisdom'] = 0.2;
        state.achievement['/buff_types/wisdom'] = 0.02;
        expect(calculateSuccessXP(2, '/items/test_sword', 0.1)).toBe(Math.floor(1.4 * 1.1 * 3 * 60));
        expect(calculateSuccessXP(2, '/items/test_sword', 0)).toBe(Math.floor(1.4 * 3 * 60));
        // Session tracking passes nothing and reads the character
        expect(calculateSuccessXP(2, '/items/test_sword')).toBe(Math.floor(1.4 * 1.27 * 3 * 60));
    });
});
