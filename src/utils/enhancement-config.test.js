/**
 * Tests for enhancing parameter resolution.
 *
 * The question these answer is whose character the numbers describe. The manual fields ship
 * loaded with a professional enhancer's kit, so a player who never opened the settings panel
 * used to be quoted somebody else's costs on their own item. Detection has to win by default,
 * and an edit has to survive.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const character = vi.hoisted(() => ({
    // What the player actually has: a mid-game character with none of the shipped kit
    skills: [{ skillHrid: '/skills/enhancing', level: 42 }],
    observatoryLevel: 3,
    equipment: new Map(),
    drinks: [],
    communityBuffLevel: 0,
    achievementSuccessRatio: 0,
    settings: {},
}));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key in character.settings ? character.settings[key] : fallback),
        isFeatureEnabled: () => false,
    },
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getSkills: () => character.skills,
        getInitClientData: () => ({ itemDetailMap: {} }),
        getHouseRoomLevel: () => character.observatoryLevel,
        getHouseRooms: () => new Map(),
        getCommunityBuffLevel: () => character.communityBuffLevel,
        getAchievementBuffFlatBoost: () => 0,
        getAchievementBuffRatioBoost: () => character.achievementSuccessRatio,
        getActionDrinkSlots: () => character.drinks,
        getEquipment: () => character.equipment,
    },
}));

vi.mock('./action-context.js', () => ({
    resolveActionContext: () => ({ equipment: character.equipment, drinks: character.drinks }),
}));

const {
    getEnhancingParams,
    getAutoDetectedParams,
    getProRatesParams,
    describeParamsSource,
    resetDetectedSettingsCache,
} = await import('./enhancement-config.js');

beforeEach(() => {
    // Detection is memoised for a second in production; each test edits the character
    resetDetectedSettingsCache();
    character.achievementSuccessRatio = 0;
    character.communityBuffLevel = 0;
});

// The values the settings panel ships with — a professional enhancer, not this character
const SHIPPED = {
    enhanceSim_enhancingLevel: 140,
    enhanceSim_houseLevel: 8,
    enhanceSim_tea: 'ultra',
    enhanceSim_gear_enhancer: { enabled: true, tier: 'celestial', level: 13 },
};

describe('getEnhancingParams with auto-detect off', () => {
    beforeEach(() => {
        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED };
    });

    test('an untouched panel quotes the character, not the shipped professional kit', () => {
        const params = getEnhancingParams();

        // Level 42 with no tea, not the shipped 140 with ultra tea
        expect(params.enhancingLevel).toBe(42);
        expect(params.houseLevel).toBe(character.observatoryLevel);
        expect(params.paramsSource).toBe('auto');
        expect(params.manualOverrides).toEqual([]);
    });

    test('the shipped celestial enhancer does not grant a success bonus the player lacks', () => {
        const params = getEnhancingParams();
        const detected = getAutoDetectedParams();

        expect(params.equipmentSuccessBonus).toBe(detected.equipmentSuccessBonus);
        expect(params.toolBonus).toBeCloseTo(detected.toolBonus, 9);
    });

    test('an achievement the character has not earned contributes nothing', () => {
        character.settings.enhanceSim_achievement = true;
        character.achievementSuccessRatio = 0;

        expect(getEnhancingParams().achievementSuccessBonus).toBe(0);
    });

    test('an achievement the character has earned is worth what the game says', () => {
        character.settings.enhanceSim_achievement = true;
        character.achievementSuccessRatio = 0.005;

        expect(getEnhancingParams().achievementSuccessBonus).toBeCloseTo(0.5, 9);
    });

    test('an edited field overrides detection and is named as an override', () => {
        character.settings.enhanceSim_enhancingLevel = 175;

        const params = getEnhancingParams();

        expect(params.enhancingLevel).toBe(175);
        expect(params.paramsSource).toBe('manual');
        expect(params.manualOverrides).toContain('Enhancing level');
    });

    test('editing one field does not turn the rest into the shipped professional kit', () => {
        character.settings.enhanceSim_enhancingLevel = 175;

        const params = getEnhancingParams();

        expect(params.houseLevel).toBe(character.observatoryLevel);
        expect(params.manualOverrides).toEqual(['Enhancing level']);
    });

    test('with no character loaded, detection is skipped rather than reporting an empty one', () => {
        character.skills = [];
        try {
            const params = getEnhancingParams();
            expect(params.enhancingLevel).toBeGreaterThanOrEqual(140);
        } finally {
            character.skills = [{ skillHrid: '/skills/enhancing', level: 42 }];
        }
    });
});

describe('getEnhancingParams with auto-detect on', () => {
    test('detection is used and reports no overrides', () => {
        character.settings = { enhanceSim_autoDetect: true, ...SHIPPED };

        const params = getEnhancingParams();

        expect(params.enhancingLevel).toBe(42);
        expect(params.paramsSource).toBe('auto');
        expect(describeParamsSource(params)).toBeNull();
    });
});

describe('describeParamsSource', () => {
    test('says nothing when the params describe the character', () => {
        expect(describeParamsSource({ paramsSource: 'auto', manualOverrides: [] })).toBeNull();
        expect(describeParamsSource(undefined)).toBeNull();
    });

    test('names the overridden fields', () => {
        const note = describeParamsSource({ manualOverrides: ['Enhancing level', 'Enhancer'] });
        expect(note).toBe('manual params: Enhancing level, Enhancer');
    });

    test('summarises a long list rather than printing all of it', () => {
        const note = describeParamsSource({ manualOverrides: ['A', 'B', 'C', 'D', 'E'] });
        expect(note).toBe('manual params: A, B, C +2 more');
    });
});

describe('detected stats reaching a prediction surface', () => {
    test('the Markov chain a surface runs is driven by the detected level, not the shipped one', async () => {
        const mathjs = await import('mathjs');
        globalThis.math = mathjs;
        const { calculateEnhancement } = await import('./enhancement-calculator.js');

        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED };
        resetDetectedSettingsCache();
        const params = getEnhancingParams();

        // An item at the character's own level: level 42 has no advantage over it, while the
        // shipped level 140 would have handed the run a large one
        const run = calculateEnhancement({
            enhancingLevel: params.enhancingLevel,
            toolBonus: params.toolBonus,
            speedBonus: params.speedBonus,
            itemLevel: 42,
            targetLevel: 2,
            blessedTea: params.teas.blessed,
            guzzlingBonus: params.guzzlingBonus,
            blessedTeaBonus: params.blessedTeaBonus,
        });

        // Only the character's own Observatory (level 3 → +0.15%) contributes
        expect(run.successMultiplier).toBeCloseTo(1.0015, 9);
        // The shipped level 140 against a level 42 item would have been +4.9% of advantage
        // on top of a level 8 Observatory — an entirely different run
        expect(run.successMultiplier).toBeLessThan(1.05);
    });
});

describe('getProRatesParams', () => {
    beforeEach(() => {
        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED };
    });

    test('quotes the shipped professional kit, not this character', () => {
        const pro = getProRatesParams();

        // 140 plus the ultra tea's +8, which is the kit the settings panel ships with
        expect(pro.enhancingLevel).toBe(148);
        expect(pro.houseLevel).toBe(8);
        expect(pro.teas.ultraEnhancing).toBe(true);
        expect(pro.teas.blessed).toBe(true);
    });

    test('is unmoved by what the player saved or detection found', () => {
        const before = getProRatesParams();

        character.settings.enhanceSim_enhancingLevel = 60;
        character.settings.enhanceSim_tea = 'none';
        character.skills = [{ skillHrid: '/skills/enhancing', level: 7 }];
        character.observatoryLevel = 0;
        resetDetectedSettingsCache();

        const after = getProRatesParams();

        expect(after.enhancingLevel).toBe(before.enhancingLevel);
        expect(after.houseLevel).toBe(before.houseLevel);
        expect(after.teas).toEqual(before.teas);

        // Put the character back for anything that runs after this
        character.skills = [{ skillHrid: '/skills/enhancing', level: 42 }];
        character.observatoryLevel = 3;
        resetDetectedSettingsCache();
    });

    test('is tagged as pro, with nothing to report as a manual override', () => {
        const pro = getProRatesParams();

        expect(pro.paramsSource).toBe('pro');
        expect(pro.manualOverrides).toEqual([]);
        expect(describeParamsSource(pro)).toBeNull();
    });

    test('differs from what this character would actually spend', () => {
        const yours = getEnhancingParams();
        const pro = getProRatesParams();

        expect(pro.enhancingLevel).toBeGreaterThan(yours.enhancingLevel);
        expect(pro.paramsSource).not.toBe(yours.paramsSource);
    });
});
