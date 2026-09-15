import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameMode: 'ironcow', valuation: 'market', alchemyLevel: 100, items: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterGameMode: () => state.gameMode,
        getSkills: () => [{ skillHrid: '/skills/alchemy', level: state.alchemyLevel }],
        getItemDetails: (hrid) => state.items[hrid] ?? null,
    },
}));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key === 'profitCalc_ironCowValuation' ? state.valuation : fallback),
    },
}));

import {
    getIronCowValue,
    getIronCowValuationMode,
    ironCowBook,
    isIronCowCharacter,
    coinifySuccessRate,
    coinifyUnitValue,
} from './ironcow-valuation.js';

const ITEMS = {
    // Vendor price only: cannot be coinified
    '/items/vendor_only': { sellPrice: 40, itemLevel: 1 },
    // Coinifiable at a level the character clears: 100 × 5 × 0.7 = 350 beats 100
    '/items/coinify_wins': { sellPrice: 100, itemLevel: 10, alchemyDetail: { isCoinifiable: true, bulkMultiplier: 3 } },
    // Coinifiable far above the character's alchemy level: the penalty sinks it under vendor
    '/items/vendor_wins': { sellPrice: 100, itemLevel: 90, alchemyDetail: { isCoinifiable: true, bulkMultiplier: 1 } },
    // Neither figure exists
    '/items/worthless': { sellPrice: 0 },
};

beforeEach(() => {
    state.gameMode = 'ironcow';
    state.valuation = 'market';
    state.alchemyLevel = 20;
    state.items = ITEMS;
});

describe('coinify value', () => {
    test('base rate at or above the item level', () => {
        expect(coinifySuccessRate(10, 20)).toBe(0.7);
        expect(coinifyUnitValue(ITEMS['/items/coinify_wins'], 20)).toBeCloseTo(350);
    });

    test('the bulk multiplier cancels out of a per-item value', () => {
        const single = { ...ITEMS['/items/coinify_wins'], alchemyDetail: { isCoinifiable: true, bulkMultiplier: 1 } };
        expect(coinifyUnitValue(single, 20)).toBeCloseTo(coinifyUnitValue(ITEMS['/items/coinify_wins'], 20));
    });

    test('the under-level penalty is 0.9 / itemLevel per missing level', () => {
        // 0.7 × (1 + 0.01 × (20 − 90)) = 0.7 × 0.3 = 0.21
        expect(coinifySuccessRate(90, 20)).toBeCloseTo(0.21);
        // 100 × 5 × 0.21
        expect(coinifyUnitValue(ITEMS['/items/vendor_wins'], 20)).toBeCloseTo(105);
    });

    test('an item that cannot be coinified has no coinify value', () => {
        expect(coinifyUnitValue(ITEMS['/items/vendor_only'], 20)).toBeNull();
    });
});

describe('each option on an Iron Cow character', () => {
    test("'market' values nothing here, so the market path runs", () => {
        for (const hrid of Object.keys(ITEMS)) {
            expect(getIronCowValue(hrid)).toBeNull();
        }
    });

    test("'vendor' uses the vendor price everywhere it exists", () => {
        state.valuation = 'vendor';
        expect(getIronCowValue('/items/vendor_only')).toEqual({ price: 40, source: 'vendor' });
        expect(getIronCowValue('/items/coinify_wins')).toEqual({ price: 100, source: 'vendor' });
        expect(getIronCowValue('/items/vendor_wins')).toEqual({ price: 100, source: 'vendor' });
    });

    test("'best' takes the higher of vendor and coinify", () => {
        state.valuation = 'best';
        expect(getIronCowValue('/items/vendor_only')).toEqual({ price: 40, source: 'vendor' });
        const coinify = getIronCowValue('/items/coinify_wins');
        expect(coinify.source).toBe('coinify');
        expect(coinify.price).toBeCloseTo(350);
        // At level 10: 0.7 × (1 + 0.01 × (10 − 90)) = 0.14, so 100 × 5 × 0.14 = 70 < 100
        state.alchemyLevel = 10;
        expect(getIronCowValue('/items/vendor_wins')).toEqual({ price: 100, source: 'vendor' });
    });

    test('an item with neither figure keeps the market path', () => {
        state.valuation = 'best';
        expect(getIronCowValue('/items/worthless')).toBeNull();
        expect(getIronCowValue('/items/unknown')).toBeNull();
    });

    test('coins stay at 1', () => {
        state.valuation = 'best';
        expect(getIronCowValue('/items/coin')).toEqual({ price: 1, source: 'vendor' });
    });

    test('enhanced items keep the market path', () => {
        state.valuation = 'vendor';
        expect(getIronCowValue('/items/vendor_only', 3)).toBeNull();
    });

    test('the book shape carries one value on both sides', () => {
        state.valuation = 'vendor';
        expect(ironCowBook('/items/vendor_only')).toEqual({ ask: 40, bid: 40, source: 'vendor' });
    });

    test('an unknown stored value is treated as market', () => {
        state.valuation = 'nonsense';
        expect(getIronCowValuationMode()).toBe('market');
    });

    test('legacy Iron Cow characters count too', () => {
        state.gameMode = 'legacy_ironcow';
        expect(isIronCowCharacter()).toBe(true);
    });
});

describe('a normal character', () => {
    test('ignores the option entirely', () => {
        state.gameMode = 'standard';
        for (const valuation of ['vendor', 'best']) {
            state.valuation = valuation;
            expect(getIronCowValuationMode()).toBe('market');
            expect(getIronCowValue('/items/vendor_only')).toBeNull();
            expect(ironCowBook('/items/coin')).toBeNull();
        }
    });

    test('an unknown game mode is not Iron Cow', () => {
        state.gameMode = null;
        state.valuation = 'vendor';
        expect(isIronCowCharacter()).toBe(false);
        expect(getIronCowValue('/items/vendor_only')).toBeNull();
    });
});
