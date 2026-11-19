/**
 * The enhance quote the upgrade advisor and the Skilling Optimizer read: a material nobody prices makes the
 * run unknown (null, which every caller reads as unpriced), never the cost of the materials that have a price.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    materials: { cost: 100, hasCost: true, hasMissingPrices: false },
    protection: { price: 0, itemHrid: null },
    /** The protection answer when the item's own copy is left out (`includeSelf: false`) */
    others: { price: 0, itemHrid: null, partial: false },
    /** The guarded market price of the item itself */
    market: { price: 0, partial: false },
}));

vi.mock('../../utils/tester-shop.js', () => ({ testerShopEnabled: () => false, testerGearPrice: () => null }));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    enhancementParamsFor: () => ({ enhancingLevel: 100, toolBonus: 0, speedBonus: 0, teas: {}, guzzlingBonus: 1 }),
}));
vi.mock('../../utils/enhancement-input-pricing.js', () => ({
    perAttemptMaterialCost: () => state.materials,
    getCheapestProtectionPrice: (hrid, options = {}) =>
        options.includeSelf === false ? state.others : state.protection,
    priceGuarded: () => state.market,
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

describe('quoteDirectEnhancement with the own copy at craft price', () => {
    const MIRROR = '/items/mirror_of_protection';
    const base = (extra = {}) => ({ ...extra });
    beforeEach(() => {
        state.materials = { cost: 100, hasCost: true, hasMissingPrices: false };
        state.protection = { price: 0, itemHrid: null };
        state.others = { price: 0, itemHrid: null, partial: false };
        state.market = { price: 0, partial: false };
    });

    test('a copy cheaper to craft than to buy is spent at craft price, and the crafts are counted', () => {
        state.market = { price: 90_000, partial: false };
        state.others = { price: 80_000, itemHrid: MIRROR, partial: false };
        state.protection = { price: 80_000, itemHrid: MIRROR, partial: false };
        const bought = quoteDirectEnhancement(SWORD, 0, 12, gameData);
        const crafted = quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 100 });
        expect(bought.selfCopyCrafts).toBe(0);
        expect(crafted.protectionItemHrid).toBe(SWORD);
        expect(crafted.selfCopyCrafts).toBeGreaterThan(0);
        expect(crafted.cost).toBeLessThan(bought.cost);
        // The crafts are the protections the plan spends
        expect(crafted.selfCopyCrafts).toBeGreaterThan(0.5);
    });

    test('a market copy cheaper than the craft is bought, and no craft is counted', () => {
        state.market = { price: 50, partial: false };
        state.others = { price: 80_000, itemHrid: MIRROR, partial: false };
        const quote = quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 100 });
        expect(quote.protectionItemHrid).toBe(SWORD);
        expect(quote.selfCopyCrafts).toBe(0);
    });

    test('a tie between market and craft buys the copy: no extra craft time', () => {
        state.market = { price: 100, partial: false };
        state.others = { price: 80_000, itemHrid: MIRROR, partial: false };
        expect(quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 100 }).selfCopyCrafts).toBe(0);
    });

    test('a cheaper mirror still wins over a crafted copy', () => {
        state.market = { price: 90_000, partial: false };
        state.others = { price: 10, itemHrid: MIRROR, partial: false };
        const quote = quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 5_000 });
        expect(quote.protectionItemHrid).toBe(MIRROR);
        expect(quote.selfCopyCrafts).toBe(0);
    });

    test('a market copy that is itself a partial craft bill does not lower the complete craft price', () => {
        state.market = { price: 1, partial: true };
        state.others = { price: 80_000, itemHrid: MIRROR, partial: false };
        const quote = quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 100 });
        // Not priced at the floor of 1: at the complete 100
        const floor = quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 100_000 });
        expect(quote.cost).toBeLessThan(floor.cost);
        expect(quote.selfCopyCrafts).toBeGreaterThan(0);
        const cheap = quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 2 });
        expect(cheap.cost).toBeLessThan(quote.cost);
    });

    test('a partial mirror price is still a floor when the plan spends it, but not when it spends the crafted copy', () => {
        state.market = { price: 90_000, partial: false };
        state.others = { price: 1, itemHrid: MIRROR, partial: true };
        expect(quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 5_000 })).toBeNull();
        state.others = { price: 90_000, itemHrid: MIRROR, partial: true };
        const quote = quoteDirectEnhancement(SWORD, 0, 12, gameData, { selfCopyCraftCost: 100 });
        expect(quote.protectionItemHrid).toBe(SWORD);
        expect(quote.selfCopyCrafts).toBeGreaterThan(0);
    });

    test('no craft price, or none above 0, leaves the old market-only answer', () => {
        state.market = { price: 90_000, partial: false };
        state.protection = { price: 90_000, itemHrid: SWORD, partial: false };
        const plain = quoteDirectEnhancement(SWORD, 0, 12, gameData);
        for (const selfCopyCraftCost of [null, 0, -5, NaN, undefined]) {
            expect(quoteDirectEnhancement(SWORD, 0, 12, gameData, base({ selfCopyCraftCost }))).toEqual(plain);
        }
        expect(plain.selfCopyCrafts).toBe(0);
    });

    test('a run that spends no protection has no crafts', () => {
        state.market = { price: 90_000, partial: false };
        const quote = quoteDirectEnhancement(SWORD, 0, 1, gameData, { selfCopyCraftCost: 100 });
        expect(quote.selfCopyCrafts).toBe(0);
        expect(quote.protectFrom).toBe(0);
    });
});
