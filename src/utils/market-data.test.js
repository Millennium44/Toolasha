import { describe, test, expect, vi, beforeEach } from 'vitest';

import marketAPI from '../api/marketplace.js';
import { getCustomPrice } from '../features/settings/custom-price-overrides.js';
import config from '../core/config.js';
import {
    isPriceOverridden,
    isPriceEstimated,
    getItemPrice,
    getItemPriceInfo,
    getPriceAgeString,
    getPricingMode,
    withProfitPricingMode,
} from './market-data.js';

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

// The reconciler is exercised in its own tests; here it is the thing under control, so a
// test can say "this side came off the order book, that one was filled in from the value map"
const reconciled = vi.hoisted(() => ({ result: null }));
vi.mock('./market-values.js', () => ({
    refreshMarketValues: vi.fn(),
    reconcileBook: (ask, bid) =>
        reconciled.result ?? {
            ask,
            bid,
            askSource: typeof ask === 'number' ? 'book' : null,
            bidSource: typeof bid === 'number' ? 'book' : null,
        },
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

describe('price provenance', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        reconciled.result = null;
        getCustomPrice.mockReturnValue(null);
        config.getSettingValue.mockReturnValue('ask');
    });

    test('an order-book price is reported as one', () => {
        marketAPI.getPrice.mockReturnValue({ ask: 500, bid: 400 });

        expect(getItemPriceInfo('/items/cheese', { mode: 'ask' })).toEqual({
            price: 500,
            source: 'book',
            estimated: false,
        });
        expect(isPriceEstimated('/items/cheese', { mode: 'ask' })).toBe(false);
    });

    test('a side filled in from the official value is marked as an estimate', () => {
        // Since the marketplace patch an item with an empty book is still priced, from the
        // game's value map. Every "no market data" signal downstream stopped firing the day
        // that landed, because the price was no longer null — this is how they get it back.
        marketAPI.getPrice.mockReturnValue({ ask: null, bid: 400 });
        reconciled.result = { ask: 1000, bid: 400, askSource: 'value', bidSource: 'book' };

        expect(getItemPriceInfo('/items/cheese', { mode: 'ask' })).toEqual({
            price: 1000,
            source: 'value',
            estimated: true,
        });
        expect(getItemPriceInfo('/items/cheese', { mode: 'bid' }).estimated).toBe(false);
        expect(isPriceEstimated('/items/cheese', { mode: 'ask' })).toBe(true);
    });

    test('an average is only as solid as its weaker half', () => {
        marketAPI.getPrice.mockReturnValue({ ask: null, bid: 400 });
        reconciled.result = { ask: 1000, bid: 400, askSource: 'value', bidSource: 'book' };

        const info = getItemPriceInfo('/items/cheese', { mode: 'average' });
        expect(info.price).toBe(700);
        expect(info.estimated).toBe(true);
    });

    test('a custom override is neither book nor estimate', () => {
        getCustomPrice.mockReturnValue(1234);

        expect(getItemPriceInfo('/items/cheese', { mode: 'ask' })).toEqual({
            price: 1234,
            source: 'custom',
            estimated: false,
        });
    });

    test('no price at all is null with no source', () => {
        marketAPI.getPrice.mockReturnValue(null);

        expect(getItemPriceInfo('/items/cheese', { mode: 'ask' })).toEqual({
            price: null,
            source: null,
            estimated: false,
        });
        expect(getItemPrice('/items/cheese', { mode: 'ask' })).toBeNull();
    });

    test('getItemPrice still answers with a bare number', () => {
        marketAPI.getPrice.mockReturnValue({ ask: 500, bid: 400 });

        expect(getItemPrice('/items/cheese', { mode: 'bid' })).toBe(400);
    });

    test('an unrecognised pricing mode is unpriced, not the ask and not zero', () => {
        // A mode nobody recognises is a bug; answering it with a plausible number hides
        // the bug behind an invented price that then flows into a profit figure
        marketAPI.getPrice.mockReturnValue({ ask: 500, bid: 400 });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(getItemPrice('/items/cheese', { mode: 'nonsense' })).toBeNull();

        warn.mockRestore();
    });
});
