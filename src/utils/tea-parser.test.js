/**
 * Tests for Tea Buff Parser Utility
 */
import { describe, test, expect } from 'vitest';
import {
    parseTeaEfficiency,
    parseTeaEfficiencyBreakdown,
    getDrinkConcentration,
    parseArtisanBonus,
    parseGourmetBonus,
    parseProcessingBonus,
    parseActionLevelBonus,
    parseActionLevelBonusBreakdown,
    parseGatheringBonus,
    parseTeaSkillLevelBonus,
} from './tea-parser.js';

const efficiencyTea = {
    consumableDetail: { buffs: [{ typeHrid: '/buff_types/efficiency', flatBoost: 0.1 }] },
};
const cheeseTea = {
    consumableDetail: { buffs: [{ typeHrid: '/buff_types/cheesesmithing_level', flatBoost: 6 }] },
};
const artisanTea = { consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] } };
const gourmetTea = { consumableDetail: { buffs: [{ typeHrid: '/buff_types/gourmet', flatBoost: 0.12 }] } };
const processingTea = { consumableDetail: { buffs: [{ typeHrid: '/buff_types/processing', flatBoost: 0.15 }] } };
const artisanActionLevelTea = { consumableDetail: { buffs: [{ typeHrid: '/buff_types/action_level', flatBoost: 5 }] } };
const gatheringTea = { consumableDetail: { buffs: [{ typeHrid: '/buff_types/gathering', flatBoost: 0.18 }] } };

const itemDetailMap = {
    '/items/efficiency_tea': efficiencyTea,
    '/items/ultra_cheesesmithing_tea': cheeseTea,
    '/items/artisan_tea': artisanTea,
    '/items/gourmet_tea': gourmetTea,
    '/items/processing_tea': processingTea,
    '/items/gathering_tea': gatheringTea,
};

describe('parseTeaEfficiency', () => {
    test('returns 0 with no active drinks or missing data', () => {
        expect(parseTeaEfficiency('/action_types/cheesesmithing', [], itemDetailMap, 0)).toBe(0);
        expect(parseTeaEfficiency(null, [{ itemHrid: '/items/efficiency_tea' }], itemDetailMap, 0)).toBe(0);
    });

    test('scales efficiency tea by drink concentration', () => {
        const result = parseTeaEfficiency(
            '/action_types/cheesesmithing',
            [{ itemHrid: '/items/efficiency_tea' }],
            itemDetailMap,
            0.12
        );
        expect(result).toBeCloseTo(11.2, 6); // 10% * 1.12
    });

    test('ignores empty slots and unknown items', () => {
        const result = parseTeaEfficiency(
            '/action_types/cheesesmithing',
            [null, { itemHrid: '/items/unknown' }],
            itemDetailMap,
            0.12
        );
        expect(result).toBe(0);
    });

    test('does not count skill level buffs as tea efficiency', () => {
        const result = parseTeaEfficiency(
            '/action_types/cheesesmithing',
            [{ itemHrid: '/items/ultra_cheesesmithing_tea' }],
            itemDetailMap,
            0
        );
        expect(result).toBe(0);
    });
});

describe('parseTeaEfficiencyBreakdown', () => {
    test('only includes teas that contribute efficiency', () => {
        const breakdown = parseTeaEfficiencyBreakdown(
            '/action_types/cheesesmithing',
            [{ itemHrid: '/items/efficiency_tea' }, { itemHrid: '/items/ultra_cheesesmithing_tea' }],
            itemDetailMap,
            0.12
        );
        expect(breakdown).toHaveLength(1);
        expect(breakdown[0].baseEfficiency).toBeCloseTo(10, 6);
        expect(breakdown[0].efficiency).toBeCloseTo(11.2, 6);
        expect(breakdown[0].dcContribution).toBeCloseTo(1.2, 6);
    });

    test('returns empty array with no active drinks', () => {
        expect(parseTeaEfficiencyBreakdown('/action_types/cheesesmithing', [], itemDetailMap, 0)).toEqual([]);
    });
});

describe('getDrinkConcentration', () => {
    test('sums drink concentration across equipped items, applying enhancement scaling', () => {
        const pouch = {
            equipmentDetail: { type: '/equipment_types/pouch', noncombatStats: { drinkConcentration: 0.1 } },
        };
        const equipment = new Map([['/item_locations/pouch', { itemHrid: '/items/guzzling_pouch', enhancementLevel: 10 }]]);
        const map = { '/items/guzzling_pouch': pouch };
        // pouch is 1x slot: enhancement level 10 => multiplier 1.29
        expect(getDrinkConcentration(equipment, map)).toBeCloseTo(0.1 * 1.29, 6);
    });

    test('returns 0 with no equipment or missing item data', () => {
        expect(getDrinkConcentration(new Map(), {})).toBe(0);
        expect(getDrinkConcentration(null, {})).toBe(0);
        expect(getDrinkConcentration(new Map([['a', { itemHrid: 'x' }]]), null)).toBe(0);
    });

    test('skips items without drink concentration stat', () => {
        const equipment = new Map([['/item_locations/head', { itemHrid: '/items/hat' }]]);
        const map = { '/items/hat': { equipmentDetail: { noncombatStats: {} } } };
        expect(getDrinkConcentration(equipment, map)).toBe(0);
    });
});

describe('parseArtisanBonus / parseGourmetBonus / parseProcessingBonus / parseGatheringBonus', () => {
    test('scale their respective buff types with drink concentration', () => {
        expect(parseArtisanBonus([{ itemHrid: '/items/artisan_tea' }], itemDetailMap, 0.12)).toBeCloseTo(0.112, 6);
        expect(parseGourmetBonus([{ itemHrid: '/items/gourmet_tea' }], itemDetailMap, 0.12)).toBeCloseTo(0.1344, 6);
        expect(parseProcessingBonus([{ itemHrid: '/items/processing_tea' }], itemDetailMap, 0.12)).toBeCloseTo(0.168, 6);
        expect(parseGatheringBonus([{ itemHrid: '/items/gathering_tea' }], itemDetailMap, 0.12)).toBeCloseTo(0.2016, 6);
    });

    test('cross-buff types are not conflated (artisan tea contributes nothing to gourmet)', () => {
        expect(parseGourmetBonus([{ itemHrid: '/items/artisan_tea' }], itemDetailMap, 0.12)).toBe(0);
    });
});

describe('parseActionLevelBonus / parseActionLevelBonusBreakdown', () => {
    const map = { '/items/artisan_tea_lvl': artisanActionLevelTea };

    test('scales action level bonus with drink concentration', () => {
        const result = parseActionLevelBonus([{ itemHrid: '/items/artisan_tea_lvl' }], map, 0.129);
        expect(result).toBeCloseTo(5.645, 6);
    });

    test('breakdown reports base value and DC contribution separately', () => {
        const breakdown = parseActionLevelBonusBreakdown([{ itemHrid: '/items/artisan_tea_lvl' }], map, 0.129);
        expect(breakdown).toHaveLength(1);
        expect(breakdown[0].baseActionLevel).toBe(5);
        expect(breakdown[0].actionLevel).toBeCloseTo(5.645, 6);
        expect(breakdown[0].dcContribution).toBeCloseTo(0.645, 6);
    });
});

describe('parseTeaSkillLevelBonus', () => {
    test('matches the skill-specific level buff for the given action type', () => {
        const result = parseTeaSkillLevelBonus(
            '/action_types/cheesesmithing',
            [{ itemHrid: '/items/ultra_cheesesmithing_tea' }],
            itemDetailMap,
            0.129
        );
        expect(result).toBeCloseTo(6.774, 6); // 6 * 1.129
    });

    test('does not match a different skill action type', () => {
        const result = parseTeaSkillLevelBonus(
            '/action_types/tailoring',
            [{ itemHrid: '/items/ultra_cheesesmithing_tea' }],
            itemDetailMap,
            0.129
        );
        expect(result).toBe(0);
    });
});
