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
    id: 'market123',
    characterData: {},
    personalWisdom: 0,
    personalSpeed: 0,
    achievementFlat: {},
}));

/** Every (settingId, fallback) pair the module hands to config — the shipped defaults */
const recordedFallbacks = vi.hoisted(() => new Map());

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => {
            recordedFallbacks.set(key, fallback);
            return key in character.settings ? character.settings[key] : fallback;
        },
        isFeatureEnabled: () => false,
    },
}));

// settings-schema pulls these in for unrelated settings groups; neither matters here
vi.mock('./bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
vi.mock('./game-server.js', () => ({ isTestServer: () => false }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getSkills: () => character.skills,
        getInitClientData: () => ({ itemDetailMap: {} }),
        getHouseRoomLevel: () => character.observatoryLevel,
        getHouseRooms: () => new Map(),
        getCommunityBuffLevel: () => character.communityBuffLevel,
        getAchievementBuffFlatBoost: (_action, buff) => character.achievementFlat[buff] || 0,
        getAchievementBuffRatioBoost: () => character.achievementSuccessRatio,
        getActionDrinkSlots: () => character.drinks,
        getEquipment: () => character.equipment,
        getCurrentCharacterId: () => character.id,
        getPersonalBuffFlatBoost: (_action, buff) =>
            buff === '/buff_types/wisdom'
                ? character.personalWisdom
                : buff === '/buff_types/action_speed'
                  ? character.personalSpeed
                  : 0,
        get characterData() {
            return character.characterData;
        },
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
    character.id = 'market123';
    character.characterData = {};
    character.personalWisdom = 0;
    character.achievementFlat = {};
    character.personalSpeed = 0;
});

// The values the settings panel ships with — a professional enhancer, not this character
const SHIPPED = {
    enhanceSim_enhancingLevel: 140,
    enhanceSim_houseLevel: 8,
    enhanceSim_tea: 'ultra',
    enhanceSim_gear_enhancer: { enabled: true, tier: 'celestial', level: 15 },
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
        expect(params.manualOverrides).toEqual([]);
    });

    test('the bench is tagged manual even when every field was answered from detection', () => {
        // The numbers are the character's, field by field — that is what keeps a never-opened
        // panel from quoting a stranger. The *bench* is still the manual panel's, and used to be
        // tagged 'auto' whenever the override list was empty, which let two surfaces print
        // "Yours" for two different benches.
        expect(getEnhancingParams().paramsSource).toBe('manual');
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

    test('says so for a manual bench with no field worth naming', () => {
        expect(describeParamsSource({ paramsSource: 'manual', manualOverrides: [] })).toContain('manual params');
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
        // Loading mathjs and running the first chain takes ~1 s alone and well over vitest's
        // 5 s default when the whole suite is contending for the CPU
    }, 30_000);
});

/**
 * The detection memo is there because a networth or inventory sweep asks once per item and the
 * character cannot re-gear between two items of the same sweep. A character *switch* is exactly
 * that re-gearing, though, and keying the memo on the clock alone handed the departing
 * character's enhancing level, enhancer and teas to everything that asked for up to a second
 * afterwards — which is the whole of a sweep kicked off by the arrival.
 */
describe('the detection memo across a character switch', () => {
    // An untouched manual panel: every field still holds what it shipped with, so every field
    // is answered from detection — which is what the memo holds
    beforeEach(() => {
        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED };
    });

    test('the arriving character is detected at once, not a second later', () => {
        character.skills = [{ skillHrid: '/skills/enhancing', level: 42 }];
        expect(getEnhancingParams().enhancingLevel).toBe(42);

        // The switch: a different character, well inside the memo's one-second window
        character.id = 'iron456';
        character.skills = [{ skillHrid: '/skills/enhancing', level: 91 }];

        expect(getEnhancingParams().enhancingLevel).toBe(91);
    });

    test('the same character inside the window is still answered from the memo', () => {
        character.skills = [{ skillHrid: '/skills/enhancing', level: 42 }];
        expect(getEnhancingParams().enhancingLevel).toBe(42);

        // No switch, so the sweep that follows re-inspects nothing — the point of the memo
        character.skills = [{ skillHrid: '/skills/enhancing', level: 91 }];
        expect(getEnhancingParams().enhancingLevel).toBe(42);
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

describe('shipped defaults versus the settings schema', () => {
    // "Reset to pro defaults" (settings-ui) writes each schema `default` into the manual bench,
    // and getProRatesParams() answers from the shipped table below instead. If the two tables
    // disagree, the reset bench differs from the Pro chip's quote, and a bench freshly reset to
    // "pro defaults" reads as a hand-edited one (stored value ≠ the resolver's shipped value).
    // Audit round 24 found exactly that: the enhancer (13 vs 15), gloves (10 vs 12), cape
    // (normal +5 vs refined +10) and achievement (off vs on) had drifted after a schema change.
    test('every enhanceSim field the resolver reads ships the schema default', async () => {
        const { getSettingDefinition } = await import('../core/settings-schema.js');

        recordedFallbacks.clear();
        character.settings = { enhanceSim_autoDetect: false };
        resetDetectedSettingsCache();
        getEnhancingParams();

        const keys = [...recordedFallbacks.keys()].filter((key) => key.startsWith('enhanceSim_'));
        // The whole bench, not a lucky subset: level, house, tea ×2, achievement, ten gear
        // slots, community buff, and the auto-detect switch itself
        expect(keys.length).toBeGreaterThanOrEqual(16);

        for (const key of keys) {
            const definition = getSettingDefinition(key);
            expect(definition, `${key} has no settings-schema definition`).toBeTruthy();
            expect(
                { key, shipped: recordedFallbacks.get(key) },
                `${key}: resolver's shipped default drifted from the schema default`
            ).toEqual({ key, shipped: definition.default });
        }
    });
});

describe('buffs the game applies beyond gear, house, tea and community', () => {
    const enhancing = (buffs) => ({ '/action_types/enhancing': buffs });

    beforeEach(() => {
        character.settings = { enhanceSim_autoDetect: true };
        character.characterData = {
            mooPassActionTypeBuffsMap: enhancing([{ typeHrid: '/buff_types/wisdom', flatBoost: 0.05 }]),
            guildActionTypeBuffsMap: enhancing([{ typeHrid: '/buff_types/action_speed', flatBoost: 0.03 }]),
        };
        character.personalWisdom = 0.2;
    });

    test('detected params count the MooPass and Scroll of Wisdom wisdom and a guild speed buff', () => {
        const params = getAutoDetectedParams();
        expect(params.experienceBonus).toBeCloseTo(25, 9);
        expect(params.otherWisdomBonus).toBeCloseTo(25, 9);
        expect(params.speedBonus).toBeCloseTo(3 + params.houseSpeedBonus, 9);
        expect(params.otherSpeedBonus).toBeCloseTo(3, 9);
    });

    test('the manual bench counts them too, they are the character not the kit', () => {
        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED };
        const params = getEnhancingParams();
        expect(params.otherWisdomBonus).toBeCloseTo(25, 9);
        expect(params.otherSpeedBonus).toBeCloseTo(3, 9);
    });

    test('the pro bench leaves them out', () => {
        const params = getProRatesParams();
        expect(params.otherWisdomBonus).toBe(0);
        expect(params.otherSpeedBonus).toBe(0);
    });
});

describe('the manual bench Achievement toggle', () => {
    beforeEach(() => {
        character.achievementSuccessRatio = 0.002;
        character.achievementFlat = { '/buff_types/wisdom': 0.02, '/buff_types/action_speed': 0.01 };
    });

    test('off, it removes every achievement buff: success, wisdom and speed', () => {
        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED, enhanceSim_achievement: false };
        const params = getEnhancingParams();
        expect(params.achievementSuccessBonus).toBe(0);
        expect(params.achievementWisdomBonus).toBe(0);
        expect(params.otherSpeedBonus).toBe(0);
        expect(params.experienceBonus).toBe(0);
    });

    test('on, all three count', () => {
        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED, enhanceSim_achievement: true };
        const params = getEnhancingParams();
        expect(params.achievementSuccessBonus).toBeCloseTo(0.2, 9);
        expect(params.achievementWisdomBonus).toBeCloseTo(2, 9);
        expect(params.otherSpeedBonus).toBeCloseTo(1, 9);
    });

    test('auto-detect is not governed by the toggle', () => {
        character.settings = { enhanceSim_autoDetect: true, enhanceSim_achievement: false };
        const params = getAutoDetectedParams();
        expect(params.achievementWisdomBonus).toBeCloseTo(2, 9);
        expect(params.otherSpeedBonus).toBeCloseTo(1, 9);
    });
});

describe('a Labyrinth Action Speed scroll', () => {
    beforeEach(() => {
        character.personalSpeed = 0.15;
    });

    test('is in the detected bench speed, and named as its own part', () => {
        character.settings = { enhanceSim_autoDetect: true };
        const params = getAutoDetectedParams();
        expect(params.personalSpeedBonus).toBeCloseTo(15, 9);
        expect(params.speedBonus).toBeCloseTo(15 + params.houseSpeedBonus, 9);
    });

    test('is in the manual bench speed', () => {
        character.settings = { enhanceSim_autoDetect: false, ...SHIPPED };
        const params = getEnhancingParams();
        expect(params.personalSpeedBonus).toBeCloseTo(15, 9);
        expect(params.speedBonus - params.equipmentSpeedBonus - params.houseSpeedBonus).toBeCloseTo(
            15 + params.communitySpeedBonus + params.teaSpeedBonus,
            9
        );
    });

    test('is not part of the pro kit', () => {
        expect(getProRatesParams().personalSpeedBonus).toBe(0);
    });
});
