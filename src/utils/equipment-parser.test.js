/**
 * Tests for Equipment Parser Utility
 */
import { describe, test, expect } from 'vitest';
import {
    parseEquipmentSpeedBonuses,
    parseEquipmentEfficiencyBonuses,
    parseEssenceFindBonus,
    parseGatheringQuantityBonus,
    parseRareFindBonus,
    parseEquipmentEfficiencyBreakdown,
    parseRareFindBreakdown,
    debugEquipmentSpeedBonuses,
} from './equipment-parser.js';

const cheesePot = {
    name: 'Cheese Pot',
    equipmentDetail: {
        type: '/equipment_types/main_hand',
        noncombatStats: { brewingSpeed: 0.15 },
    },
};
const philoNecklace = {
    name: "Philosopher's Necklace",
    equipmentDetail: {
        type: '/equipment_types/neck',
        noncombatStats: { skillingEfficiency: 0.02, skillingSpeed: 0.01 },
    },
};
const essenceRing = {
    name: 'Ring of Essence Find',
    equipmentDetail: {
        type: '/equipment_types/ring',
        noncombatStats: { skillingEssenceFind: 0.15 },
    },
};
const gatheringGlove = {
    name: 'Gathering Gloves',
    equipmentDetail: {
        type: '/equipment_types/hands',
        noncombatStats: { gatheringQuantity: 0.02 },
    },
};

const itemDetailMap = {
    '/items/cheese_pot': cheesePot,
    '/items/philo_necklace': philoNecklace,
    '/items/essence_ring': essenceRing,
    '/items/gathering_gloves': gatheringGlove,
};

describe('parseEquipmentSpeedBonuses', () => {
    test('returns 0 with no equipment', () => {
        expect(parseEquipmentSpeedBonuses(new Map(), '/action_types/brewing', itemDetailMap)).toBe(0);
        expect(parseEquipmentSpeedBonuses(null, '/action_types/brewing', itemDetailMap)).toBe(0);
    });

    test('reads skill-specific speed field at +0 enhancement', () => {
        const equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/cheese_pot' }]]);
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/brewing', itemDetailMap)).toBeCloseTo(0.15, 9);
    });

    test('scales with enhancement level using the slot multiplier (weapon = 1x)', () => {
        const equipment = new Map([
            ['/item_locations/main_hand', { itemHrid: '/items/cheese_pot', enhancementLevel: 10 }],
        ]);
        // base 0.15 * (1 + 0.29 * 1) = 0.1935
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/brewing', itemDetailMap)).toBeCloseTo(0.1935, 6);
    });

    test('adds generic skillingSpeed from any slot', () => {
        const equipment = new Map([['/item_locations/neck', { itemHrid: '/items/philo_necklace' }]]);
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/brewing', itemDetailMap)).toBeCloseTo(0.01, 9);
    });

    test('does not attribute a speed field belonging to a different skill', () => {
        const equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/cheese_pot' }]]);
        expect(parseEquipmentSpeedBonuses(equipment, '/action_types/cooking', itemDetailMap)).toBe(0);
    });
});

describe('parseEquipmentEfficiencyBonuses', () => {
    test('converts total to percentage and applies neck 5x multiplier', () => {
        const equipment = new Map([
            ['/item_locations/neck', { itemHrid: '/items/philo_necklace', enhancementLevel: 10 }],
        ]);
        // skillingEfficiency 0.02 * (1 + 0.29*5) = 0.02 * 2.45 = 0.049 -> 4.9%
        const result = parseEquipmentEfficiencyBonuses(equipment, '/action_types/brewing', itemDetailMap);
        expect(result).toBeCloseTo(4.9, 6);
    });
});

describe('parseEssenceFindBonus', () => {
    test('scales essence find with the accessory 5x slot multiplier', () => {
        const equipment = new Map([
            ['/item_locations/ring', { itemHrid: '/items/essence_ring', enhancementLevel: 10 }],
        ]);
        // 0.15 * (1 + 0.29*5) = 0.3675 -> 36.75%
        expect(parseEssenceFindBonus(equipment, itemDetailMap)).toBeCloseTo(36.75, 6);
    });

    test('returns 0 with no equipment', () => {
        expect(parseEssenceFindBonus(new Map(), itemDetailMap)).toBe(0);
    });
});

describe('parseGatheringQuantityBonus', () => {
    test('sums gatheringQuantity as a decimal (not percentage)', () => {
        const equipment = new Map([['/item_locations/hands', { itemHrid: '/items/gathering_gloves' }]]);
        expect(parseGatheringQuantityBonus(equipment, itemDetailMap)).toBeCloseTo(0.02, 9);
    });
});

describe('parseRareFindBonus', () => {
    test('returns 0 for missing itemDetailMap', () => {
        expect(parseRareFindBonus(new Map([['a', { itemHrid: 'x' }]]), '/action_types/brewing', null)).toBe(0);
    });
});

describe('parseEquipmentEfficiencyBreakdown / parseRareFindBreakdown', () => {
    test('efficiency breakdown reports per-item contribution', () => {
        const equipment = new Map([['/item_locations/neck', { itemHrid: '/items/philo_necklace' }]]);
        const breakdown = parseEquipmentEfficiencyBreakdown(equipment, '/action_types/brewing', itemDetailMap);
        expect(breakdown).toHaveLength(1);
        expect(breakdown[0].name).toBe("Philosopher's Necklace");
        expect(breakdown[0].value).toBeCloseTo(2, 6); // 0.02 * 100
    });

    test('rare find breakdown is empty when nothing contributes', () => {
        const equipment = new Map([['/item_locations/main_hand', { itemHrid: '/items/cheese_pot' }]]);
        expect(parseRareFindBreakdown(equipment, '/action_types/brewing', itemDetailMap)).toEqual([]);
    });
});

describe('debugEquipmentSpeedBonuses', () => {
    test('lists every stat ending in Speed with its scaled value', () => {
        const equipment = new Map([
            ['/item_locations/main_hand', { itemHrid: '/items/cheese_pot', enhancementLevel: 10 }],
        ]);
        const bonuses = debugEquipmentSpeedBonuses(equipment, itemDetailMap);
        expect(bonuses).toHaveLength(1);
        expect(bonuses[0].speedType).toBe('brewingSpeed');
        expect(bonuses[0].scaledBonus).toBeCloseTo(0.1935, 6);
    });

    test('returns empty array with no equipment', () => {
        expect(debugEquipmentSpeedBonuses(new Map(), itemDetailMap)).toEqual([]);
    });
});
