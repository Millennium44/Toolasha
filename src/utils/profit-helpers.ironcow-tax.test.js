/**
 * An Iron Cow character has no market access, so nothing it realizes as output revenue —
 * a vendor sale, a coinify, or the game's value-map fallback for an item with neither —
 * ever pays the marketplace fee. `outputTaxRate` is the one place that decision is made;
 * `calculatePriceAfterTax` goes through it so every output-revenue call site picks the
 * fix up automatically. `profit-helpers.test.js` covers the ordinary (non-Iron-Cow)
 * behavior of both functions; these tests cover the Iron Cow branch.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameMode: 'standard' }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterGameMode: () => state.gameMode,
    },
}));
vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => fallback },
}));
vi.mock('./market-data.js', () => ({
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
    getPricingMode: () => 'ask',
}));
vi.mock('../features/settings/custom-price-overrides.js', () => ({ getCustomPrice: () => null }));
vi.mock('./game-lookups.js', () => ({ getShopCoinCost: () => 0 }));
vi.mock('../features/enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const { calculatePriceAfterTax, outputTaxRate } = await import('./profit-helpers.js');
const { MARKET_TAX } = await import('./profit-constants.js');

beforeEach(() => {
    state.gameMode = 'standard';
});

describe('outputTaxRate', () => {
    test('a market character pays the given rate', () => {
        expect(outputTaxRate(0.05)).toBe(0.05);
        expect(outputTaxRate()).toBe(MARKET_TAX);
    });

    test('an Iron Cow character pays nothing, regardless of the rate asked for', () => {
        state.gameMode = 'ironcow';
        expect(outputTaxRate(0.05)).toBe(0);
        expect(outputTaxRate(MARKET_TAX)).toBe(0);
        expect(outputTaxRate(0.18)).toBe(0); // e.g. the Cowbell Bag's higher rate
    });

    test('legacy_ironcow is Iron Cow too', () => {
        state.gameMode = 'legacy_ironcow';
        expect(outputTaxRate()).toBe(0);
    });
});

describe('calculatePriceAfterTax on an Iron Cow character', () => {
    test('returns the price untouched — no market cut on a vendor/coinify/fallback value', () => {
        state.gameMode = 'ironcow';
        expect(calculatePriceAfterTax(1000)).toBe(1000);
        expect(calculatePriceAfterTax(1000, 0.05)).toBe(1000);
        expect(calculatePriceAfterTax(1000, 0.18)).toBe(1000); // Cowbell Bag's rate too
    });

    test('a market character is unaffected — still taxed at the given rate', () => {
        state.gameMode = 'standard';
        expect(calculatePriceAfterTax(1000)).toBe(1000 * (1 - MARKET_TAX));
        expect(calculatePriceAfterTax(1000, 0.18)).toBeCloseTo(820, 6);
    });
});
