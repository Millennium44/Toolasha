import { describe, test, expect } from 'vitest';
import { getAlchemyCoinCost, getAlchemyTypeFromActionHrid } from './alchemy-fees.js';

const item = (overrides = {}) => ({
    itemLevel: 10,
    sellPrice: 1000,
    alchemyDetail: { bulkMultiplier: 1 },
    ...overrides,
});

describe('getAlchemyCoinCost', () => {
    test('decompose is priced by item level: (10 + level) × 5', () => {
        expect(getAlchemyCoinCost(item({ itemLevel: 10 }), 'decompose')).toBe(100);
        expect(getAlchemyCoinCost(item({ itemLevel: 90 }), 'decompose')).toBe(500);
    });

    test('decompose ignores sell price — the formula the history viewer used to apply', () => {
        // max(50, 1_000_000 / 5) would be 200_000; the item-level formula charges 100
        expect(getAlchemyCoinCost(item({ itemLevel: 10, sellPrice: 1_000_000 }), 'decompose')).toBe(100);
    });

    test('unrefine is priced like decompose', () => {
        expect(getAlchemyCoinCost(item({ itemLevel: 10 }), 'unrefine')).toBe(100);
    });

    test('transmute is priced by sell price with a floor of 50', () => {
        expect(getAlchemyCoinCost(item({ sellPrice: 1000 }), 'transmute')).toBe(200);
        expect(getAlchemyCoinCost(item({ sellPrice: 10 }), 'transmute')).toBe(50);
    });

    test('coinify is free — items go in, coins come out, no gold fee', () => {
        // The transmute formula would charge 200 here; coinify pays nothing.
        expect(getAlchemyCoinCost(item({ sellPrice: 1000 }), 'coinify')).toBe(0);
        expect(
            getAlchemyCoinCost(item({ sellPrice: 1_000_000, alchemyDetail: { bulkMultiplier: 10 } }), 'coinify')
        ).toBe(0);
    });

    test('the bulk multiplier scales both formulas', () => {
        const bulk = { alchemyDetail: { bulkMultiplier: 10 } };
        expect(getAlchemyCoinCost(item(bulk), 'decompose')).toBe(1000);
        expect(getAlchemyCoinCost(item(bulk), 'transmute')).toBe(2000);
    });

    test('a caller may bill at a recorded bulk size instead of the item current one', () => {
        // History sessions recorded the multiplier in force at the time; it wins.
        const stale = item({ alchemyDetail: { bulkMultiplier: 10 } });
        expect(getAlchemyCoinCost(stale, 'transmute', 3)).toBe(600);
        expect(getAlchemyCoinCost(stale, 'decompose', 3)).toBe(300);
    });

    test('a missing bulk multiplier counts as one', () => {
        expect(getAlchemyCoinCost({ itemLevel: 10, alchemyDetail: {} }, 'decompose')).toBe(100);
        expect(getAlchemyCoinCost({ itemLevel: 10 }, 'decompose')).toBe(100);
    });

    test('an unknown item costs nothing rather than the 50-coin floor', () => {
        expect(getAlchemyCoinCost(null, 'decompose')).toBe(0);
        expect(getAlchemyCoinCost(undefined, 'transmute')).toBe(0);
    });

    test('a level-less item is treated as level 1', () => {
        expect(getAlchemyCoinCost({ sellPrice: 0 }, 'decompose')).toBe(55);
    });
});

describe('getAlchemyTypeFromActionHrid', () => {
    test('names the alchemy type', () => {
        expect(getAlchemyTypeFromActionHrid('/actions/alchemy/decompose')).toBe('decompose');
        expect(getAlchemyTypeFromActionHrid('/actions/alchemy/transmute')).toBe('transmute');
        expect(getAlchemyTypeFromActionHrid('/actions/alchemy/coinify')).toBe('coinify');
        expect(getAlchemyTypeFromActionHrid('/actions/alchemy/unrefine')).toBe('unrefine');
    });

    test('non-alchemy actions have no type', () => {
        expect(getAlchemyTypeFromActionHrid('/actions/enhancing/enhance')).toBeNull();
        expect(getAlchemyTypeFromActionHrid('')).toBeNull();
        expect(getAlchemyTypeFromActionHrid(undefined)).toBeNull();
    });
});
