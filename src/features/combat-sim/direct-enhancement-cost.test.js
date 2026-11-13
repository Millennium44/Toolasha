/**
 * The enhance quote the upgrade advisor and the Skilling Optimizer read: a material nobody prices makes the
 * run unknown (null, which every caller reads as unpriced), never the cost of the materials that have a price.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    materials: { cost: 100, hasCost: true, hasMissingPrices: false },
    protection: { price: 0, itemHrid: null },
}));

vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    enhancementParamsFor: () => ({ enhancingLevel: 100, toolBonus: 0, speedBonus: 0, teas: {}, guzzlingBonus: 1 }),
}));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({
    perAttemptMaterialCost: () => state.materials,
    getCheapestProtectionPrice: () => state.protection,
}));

const { calculateDirectEnhancementCost, quoteDirectEnhancement } = await import('./direct-enhancement-cost.js');

const SWORD = '/items/cheese_sword';
const gameData = {
    itemDetailMap: {
        [SWORD]: { itemLevel: 10, enhancementCosts: [{ itemHrid: '/items/unpriced_thing', count: 2 }] },
    },
};

describe('calculateDirectEnhancementCost', () => {
    beforeEach(() => {
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: false };
        state.protection = { price: 0, itemHrid: null };
    });

    test('a fully priced run is a number', () => {
        expect(calculateDirectEnhancementCost(SWORD, 0, 3, gameData)).toBeGreaterThan(0);
    });

    test('a material with no price makes the whole quote unknown, not the priced materials alone', () => {
        // One of two materials priced: the sum is real but partial
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: true };
        expect(calculateDirectEnhancementCost(SWORD, 0, 3, gameData)).toBeNull();
    });

    test('a craft-priced material with an unpriced input is a partial bill: unknown too', () => {
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: false, hasPartialPrices: true };
        expect(calculateDirectEnhancementCost(SWORD, 0, 3, gameData)).toBeNull();
    });

    test('a partial protection price makes the quote unknown only when the cheapest plan spends it', () => {
        // Too dear to be worth using: the cheapest plan is unprotected, so the quote is complete
        state.protection = { price: 5_000_000, itemHrid: '/items/mirror_of_protection', partial: true };
        expect(calculateDirectEnhancementCost(SWORD, 0, 3, gameData)).toBeGreaterThan(0);
        // Cheap enough to be spent on a long run: the figure is a floor, so unknown
        state.protection = { price: 1, itemHrid: '/items/mirror_of_protection', partial: true };
        expect(calculateDirectEnhancementCost(SWORD, 0, 12, gameData)).toBeNull();
        state.protection = { price: 1, itemHrid: '/items/mirror_of_protection', partial: false };
        expect(calculateDirectEnhancementCost(SWORD, 0, 12, gameData)).toBeGreaterThan(0);
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

describe('quoteDirectEnhancement', () => {
    beforeEach(() => {
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: false };
        state.protection = { price: 0, itemHrid: null };
    });

    test('the cost is the same figure calculateDirectEnhancementCost answers, with the seconds and XP of that plan', () => {
        const quote = quoteDirectEnhancement(SWORD, 0, 3, gameData);
        expect(quote.cost).toBe(calculateDirectEnhancementCost(SWORD, 0, 3, gameData));
        expect(quote.seconds).toBeGreaterThan(0);
        expect(quote.xp).toBeGreaterThan(0);
        expect(quote.xpKnown).toBe(true);
    });

    test('the bench handed in is used instead of the surface resolver, and its wisdom raises the XP', () => {
        const own = { enhancingLevel: 100, toolBonus: 0, speedBonus: 0, teas: {}, guzzlingBonus: 1 };
        const plain = quoteDirectEnhancement(SWORD, 0, 3, gameData, { params: own });
        const wise = quoteDirectEnhancement(SWORD, 0, 3, gameData, { params: { ...own, experienceBonus: 50 } });
        expect(wise.xp).toBeGreaterThan(plain.xp);
        // Wisdom changes nothing about what the run costs
        expect(wise.cost).toBe(plain.cost);
        // A faster bench is quoted as faster
        const quick = quoteDirectEnhancement(SWORD, 0, 3, gameData, { params: { ...own, speedBonus: 100 } });
        expect(quick.seconds).toBeLessThan(plain.seconds);
    });

    test('an unpriced material is null, a no-op is free with no time, a missing recipe is null', () => {
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: true };
        expect(quoteDirectEnhancement(SWORD, 0, 3, gameData)).toBeNull();
        expect(quoteDirectEnhancement(SWORD, 3, 3, gameData)).toEqual(
            expect.objectContaining({ cost: 0, seconds: 0, xp: 0 })
        );
        expect(quoteDirectEnhancement('/items/nothing', 0, 3, { itemDetailMap: {} })).toBeNull();
    });
});
