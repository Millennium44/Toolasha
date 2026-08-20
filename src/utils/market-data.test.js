import { describe, test, expect, vi, beforeEach } from 'vitest';

import marketAPI from '../api/marketplace.js';
import { getCustomPrice } from '../features/settings/custom-price-overrides.js';
import config from '../core/config.js';
import { isPriceOverridden, getPriceAgeString, getPricingMode, withProfitPricingMode } from './market-data.js';

vi.mock('../api/marketplace.js', () => ({
    default: {
        getPrice: vi.fn(),
        getDataAge: vi.fn(),
    },
}));

vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: vi.fn(),
    },
}));

vi.mock('../features/settings/custom-price-overrides.js', () => ({
    getCustomPrice: vi.fn(),
}));

describe('isPriceOverridden', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns false for an invalid itemHrid', () => {
        expect(isPriceOverridden(null)).toBe(false);
        expect(isPriceOverridden(undefined)).toBe(false);
        expect(isPriceOverridden(42)).toBe(false);
        expect(getCustomPrice).not.toHaveBeenCalled();
    });

    test('returns true when a custom price override exists', () => {
        getCustomPrice.mockReturnValue(1234);

        expect(isPriceOverridden('/items/cheese', 0, 'sell')).toBe(true);
        expect(getCustomPrice).toHaveBeenCalledWith('/items/cheese', 0, 'sell');
    });

    test('returns false when no override exists', () => {
        getCustomPrice.mockReturnValue(null);

        expect(isPriceOverridden('/items/cheese', 3, 'buy')).toBe(false);
    });

    test('defaults enhancementLevel and side when omitted', () => {
        getCustomPrice.mockReturnValue(null);

        isPriceOverridden('/items/cheese');

        expect(getCustomPrice).toHaveBeenCalledWith('/items/cheese', 0, 'sell');
    });
});

describe('getPriceAgeString', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('returns null when no market data has been loaded', () => {
        marketAPI.getDataAge.mockReturnValue(null);

        expect(getPriceAgeString()).toBeNull();
    });

    test('reports data as just updated when under a minute old', () => {
        marketAPI.getDataAge.mockReturnValue(30_000); // 30s

        expect(getPriceAgeString()).toBe('prices updated just now');
    });

    test('reports minutes old for typical cache ages', () => {
        marketAPI.getDataAge.mockReturnValue(4 * 60_000); // 4 minutes

        expect(getPriceAgeString()).toBe('prices 4m old');
    });

    test('reports hours old once past the hour mark', () => {
        marketAPI.getDataAge.mockReturnValue(2 * 60 * 60_000 + 5 * 60_000); // 2h 5m

        expect(getPriceAgeString()).toBe('prices 2h 5m old');
    });
});

describe('withProfitPricingMode', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        config.getSettingValue.mockReturnValue('optimistic');
    });

    test("pins the profit context's mode for the duration of the call", () => {
        // Optimistic is bid-in/ask-out; conservative is the insta flow
        expect(getPricingMode('profit', 'buy')).toBe('bid');

        withProfitPricingMode('conservative', () => {
            expect(getPricingMode('profit', 'buy')).toBe('ask');
            expect(getPricingMode('profit', 'sell')).toBe('bid');
        });

        expect(getPricingMode('profit', 'buy')).toBe('bid');
    });

    test('restores the previous override rather than clearing it, so nesting works', () => {
        withProfitPricingMode('conservative', () => {
            withProfitPricingMode('patientBuy', () => {
                expect(getPricingMode('profit', 'buy')).toBe('bid');
            });
            expect(getPricingMode('profit', 'buy')).toBe('ask');
        });
    });

    test('a throwing callback still gives the setting back', () => {
        expect(() =>
            withProfitPricingMode('conservative', () => {
                throw new Error('boom');
            })
        ).toThrow('boom');

        expect(getPricingMode('profit', 'buy')).toBe('bid');
    });

    test('leaves other contexts alone', () => {
        config.getSettingValue.mockReturnValue('bid');
        withProfitPricingMode('conservative', () => {
            expect(getPricingMode('networth')).toBe('bid');
        });
    });

    test('returns what the callback returns', () => {
        expect(withProfitPricingMode('conservative', () => 42)).toBe(42);
    });
});
