import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    resolveSellSideValue: vi.fn(),
    labyrinth: vi.fn(),
    task: vi.fn(),
    getItemPrice: vi.fn(),
    ev: { isInitialized: true, initialize: vi.fn() },
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: mocks.ev,
}));
vi.mock('../../utils/token-valuation.js', () => ({
    DUNGEON_TOKEN_HRIDS: new Set([
        '/items/chimerical_token',
        '/items/sinister_token',
        '/items/enchanted_token',
        '/items/pirate_token',
    ]),
    calculateLabyrinthTokenValueDetail: mocks.labyrinth,
}));
vi.mock('../tasks/task-profit-calculator.js', () => ({ calculateTaskTokenValue: mocks.task }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: mocks.getItemPrice }));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price, rate = 0.04) => price * (1 - rate),
}));

import { resolveCurrencyValue, isNonMarketCurrency } from './loot-log-currency.js';

describe('resolveCurrencyValue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.ev.isInitialized = true;
        mocks.ev.resolveSellSideValue = mocks.resolveSellSideValue;
    });

    test('a cowbell is a tenth of the bag after the bag 18% tax, whatever the EV toggle says', () => {
        mocks.getItemPrice.mockReturnValue(1_000_000);
        // The EV chain would answer 0 with its "include cowbells" toggle off; it is not asked
        mocks.resolveSellSideValue.mockReturnValue({ value: 0 });
        expect(resolveCurrencyValue('/items/cowbell')).toBeCloseTo(82_000, 6);
        expect(mocks.getItemPrice).toHaveBeenCalledWith('/items/bag_of_10_cowbells', {
            context: 'profit',
            side: 'sell',
        });
        expect(mocks.resolveSellSideValue).not.toHaveBeenCalled();
    });

    test('a dungeon token is taxed when its valuation says a sale pays tax', () => {
        mocks.resolveSellSideValue.mockReturnValue({ value: 1_500, needsTax: true });
        expect(resolveCurrencyValue('/items/chimerical_token')).toBeCloseTo(1_440, 6);
        mocks.resolveSellSideValue.mockReturnValue({ value: 1_500, needsTax: false });
        expect(resolveCurrencyValue('/items/sinister_token')).toBe(1_500);
    });

    test('a labyrinth token is its best shop reward after market tax', () => {
        mocks.labyrinth.mockReturnValue({ value: 2_000, itemHrid: '/items/x' });
        expect(resolveCurrencyValue('/items/labyrinth_token')).toBeCloseTo(1_920, 6);
    });

    test('task tokens use the task shop valuation, starting the EV calculator if nothing else did', () => {
        mocks.ev.isInitialized = false;
        mocks.task.mockReturnValue({ tokenValue: 30_000 });
        expect(resolveCurrencyValue('/items/task_token')).toBe(30_000);
        expect(mocks.ev.initialize).toHaveBeenCalledTimes(1);
    });

    test('an unpriceable currency is null so the caller falls back, and an ordinary item is not a currency', () => {
        mocks.task.mockReturnValue({ tokenValue: null });
        mocks.getItemPrice.mockReturnValue(null);
        expect(resolveCurrencyValue('/items/task_token')).toBeNull();
        expect(resolveCurrencyValue('/items/cowbell')).toBeNull();
        expect(resolveCurrencyValue('/items/milk')).toBeNull();
        expect(isNonMarketCurrency('/items/milk')).toBe(false);
    });
});
