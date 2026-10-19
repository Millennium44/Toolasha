/**
 * The enhance quote the upgrade advisor and the Skilling Optimizer read: a material nobody prices makes the
 * run unknown (null, which every caller reads as unpriced), never the cost of the materials that have a price.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    materials: { cost: 100, hasCost: true, hasMissingPrices: false },
}));

vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    enhancementParamsFor: () => ({ enhancingLevel: 100, toolBonus: 0, speedBonus: 0, teas: {}, guzzlingBonus: 1 }),
}));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({
    perAttemptMaterialCost: () => state.materials,
    getCheapestProtectionPrice: () => ({ price: 0, itemHrid: null }),
}));

const { calculateDirectEnhancementCost } = await import('./direct-enhancement-cost.js');

const SWORD = '/items/cheese_sword';
const gameData = {
    itemDetailMap: {
        [SWORD]: { itemLevel: 10, enhancementCosts: [{ itemHrid: '/items/unpriced_thing', count: 2 }] },
    },
};

describe('calculateDirectEnhancementCost', () => {
    beforeEach(() => {
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: false };
    });

    test('a fully priced run is a number', () => {
        expect(calculateDirectEnhancementCost(SWORD, 0, 3, gameData)).toBeGreaterThan(0);
    });

    test('a material with no price makes the whole quote unknown, not the priced materials alone', () => {
        // One of two materials priced: the sum is real but partial
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: true };
        expect(calculateDirectEnhancementCost(SWORD, 0, 3, gameData)).toBeNull();
    });

    test('nothing priced at all is unknown too', () => {
        state.materials = { cost: 0, hasCost: false, hasMissingPrices: true };
        expect(calculateDirectEnhancementCost(SWORD, 0, 3, gameData)).toBeNull();
    });

    test('no enhancement to do is still a free no-op, and a missing recipe still unknown', () => {
        state.materials = { cost: 0, hasCost: false, hasMissingPrices: true };
        expect(calculateDirectEnhancementCost(SWORD, 3, 3, gameData)).toBe(0);
        expect(calculateDirectEnhancementCost('/items/nothing', 0, 3, { itemDetailMap: {} })).toBeNull();
    });
});
