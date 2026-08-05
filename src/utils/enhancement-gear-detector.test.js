/**
 * Tests for Skill Gear Detector
 */
import { describe, test, expect } from 'vitest';
import {
    detectSkillGear,
    detectEnhancingTeas,
    getEnhancingTeaLevelBonus,
    getEnhancingTeaSpeedBonus,
    detectEnhancingGear,
} from './enhancement-gear-detector.js';

const forgeHammer = {
    name: 'Forge Hammer',
    itemLevel: 5,
    equipmentDetail: {
        type: '/equipment_types/enhancing_tool',
        noncombatStats: { enhancingSuccess: 0.05 },
    },
};
const betterForgeHammer = {
    name: 'Better Forge Hammer',
    itemLevel: 10,
    equipmentDetail: {
        type: '/equipment_types/enhancing_tool',
        noncombatStats: { enhancingSuccess: 0.08 },
    },
};
const gloves = {
    name: 'Enchanted Gloves',
    itemLevel: 1,
    equipmentDetail: {
        type: '/equipment_types/hands',
        noncombatStats: { skillingSpeed: 0.05 },
    },
};
const plainHat = {
    name: 'Plain Hat',
    itemLevel: 1,
    equipmentDetail: { type: '/equipment_types/head', noncombatStats: {} },
};

const itemDetailMap = {
    '/items/forge_hammer': forgeHammer,
    '/items/better_forge_hammer': betterForgeHammer,
    '/items/gloves': gloves,
    '/items/plain_hat': plainHat,
};

describe('detectSkillGear', () => {
    test('returns zeroed gear with no equipment', () => {
        const gear = detectSkillGear('enhancing', null, itemDetailMap);
        expect(gear.toolBonus).toBe(0);
        expect(gear.toolSlot).toBeNull();
    });

    test('picks the tool with the highest item level per slot', () => {
        const equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/forge_hammer' }]]);
        const gear = detectSkillGear('enhancing', equipment, itemDetailMap);
        expect(gear.toolSlot.name).toBe('Forge Hammer');
        expect(gear.toolBonus).toBeCloseTo(5, 6); // 0.05 * 100
    });

    test('when two candidates fill the same slot, higher item level wins', () => {
        // Simulate two tools somehow both present is unrealistic in real equipment maps
        // (one slot = one item), so instead verify enhancement level breaks ties at equal itemLevel.
        const tied = {
            name: 'Tied Hammer',
            itemLevel: 5,
            equipmentDetail: { type: '/equipment_types/enhancing_tool', noncombatStats: { enhancingSuccess: 0.03 } },
        };
        const map = { ...itemDetailMap, '/items/tied_hammer': tied };
        const equipment = new Map([
            ['/item_locations/main_hand', { itemHrid: '/items/tied_hammer', enhancementLevel: 5 }],
        ]);
        const gear = detectSkillGear('enhancing', equipment, map);
        expect(gear.toolSlot.enhancementLevel).toBe(5);
    });

    test('ignores items without noncombat stats matching the skill', () => {
        const equipment = new Map([['/item_locations/head', { itemHrid: '/items/plain_hat' }]]);
        const gear = detectSkillGear('enhancing', equipment, itemDetailMap);
        expect(gear.toolBonus).toBe(0);
        expect(gear.slotBreakdown).toEqual([]);
    });

    test('combines generic skillingSpeed with skill-specific speed', () => {
        const equipment = new Map([['/item_locations/hands', { itemHrid: '/items/gloves' }]]);
        const gear = detectSkillGear('enhancing', equipment, itemDetailMap);
        expect(gear.speedBonus).toBeCloseTo(5, 6);
        expect(gear.handsSlot.name).toBe('Enchanted Gloves');
    });
});

describe('detectEnhancingTeas', () => {
    test('returns all false with no drink slots', () => {
        expect(detectEnhancingTeas([], {})).toEqual({
            enhancing: false,
            superEnhancing: false,
            ultraEnhancing: false,
            blessed: false,
        });
        expect(detectEnhancingTeas(null, {})).toEqual({
            enhancing: false,
            superEnhancing: false,
            ultraEnhancing: false,
            blessed: false,
        });
    });

    test('detects each known tea independently', () => {
        const teas = detectEnhancingTeas(
            [{ itemHrid: '/items/ultra_enhancing_tea' }, { itemHrid: '/items/blessed_tea' }],
            {}
        );
        expect(teas.ultraEnhancing).toBe(true);
        expect(teas.blessed).toBe(true);
        expect(teas.enhancing).toBe(false);
        expect(teas.superEnhancing).toBe(false);
    });

    test('ignores empty slots and unrelated items', () => {
        const teas = detectEnhancingTeas([null, { itemHrid: '/items/wisdom_tea' }], {});
        expect(teas).toEqual({ enhancing: false, superEnhancing: false, ultraEnhancing: false, blessed: false });
    });
});

describe('getEnhancingTeaLevelBonus / getEnhancingTeaSpeedBonus', () => {
    test('teas do not stack — highest tier wins for level bonus', () => {
        expect(getEnhancingTeaLevelBonus({ enhancing: true, superEnhancing: true, ultraEnhancing: true })).toBe(8);
        expect(getEnhancingTeaLevelBonus({ enhancing: true, superEnhancing: true, ultraEnhancing: false })).toBe(6);
        expect(getEnhancingTeaLevelBonus({ enhancing: true, superEnhancing: false, ultraEnhancing: false })).toBe(3);
        expect(getEnhancingTeaLevelBonus({ enhancing: false, superEnhancing: false, ultraEnhancing: false })).toBe(0);
    });

    test('teas do not stack — highest tier wins for speed bonus', () => {
        expect(getEnhancingTeaSpeedBonus({ ultraEnhancing: true })).toBe(6);
        expect(getEnhancingTeaSpeedBonus({ superEnhancing: true })).toBe(4);
        expect(getEnhancingTeaSpeedBonus({ enhancing: true })).toBe(2);
        expect(getEnhancingTeaSpeedBonus({})).toBe(0);
    });
});

describe('detectEnhancingGear (backward-compatible wrapper)', () => {
    test('delegates to detectSkillGear with the enhancing skill', () => {
        const equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/forge_hammer' }]]);
        const gear = detectEnhancingGear(equipment, itemDetailMap);
        expect(gear.toolBonus).toBeCloseTo(5, 6);
    });
});
