import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    dungeon: vi.fn(),
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
    calculateDungeonTokenValue: mocks.dungeon,
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
    });

    test('a cowbell is a tenth of the bag after the bag 18% tax, whatever the EV toggle says', () => {
        mocks.getItemPrice.mockReturnValue(1_000_000);
        expect(resolveCurrencyValue('/items/cowbell', 'ask')).toBeCloseTo(82_000, 6);
        expect(mocks.getItemPrice).toHaveBeenCalledWith('/items/bag_of_10_cowbells', { mode: 'ask' });
    });

    test('the ask and bid columns quote their own side of the book, whatever the pricing mode', () => {
        // Each side is read as an exact book side; the book is richer at the ask
        mocks.getItemPrice.mockImplementation((hrid, { mode }) => (mode === 'ask' ? 1_000_000 : 800_000));
        expect(resolveCurrencyValue('/items/cowbell', 'ask')).toBeCloseTo(82_000, 6);
        expect(resolveCurrencyValue('/items/cowbell', 'bid')).toBeCloseTo(65_600, 6);

        mocks.dungeon.mockImplementation((hrid, a, b, side) => (side === 'ask' ? 1_500 : 1_200));
        expect(resolveCurrencyValue('/items/chimerical_token', 'ask')).toBe(1_500);
        expect(resolveCurrencyValue('/items/chimerical_token', 'bid')).toBe(1_200);

        mocks.labyrinth.mockImplementation((a, b, side) => ({ value: side === 'ask' ? 2_000 : 1_000, itemHrid: 'x' }));
        expect(resolveCurrencyValue('/items/labyrinth_token', 'ask')).toBeCloseTo(1_920, 6);
        expect(resolveCurrencyValue('/items/labyrinth_token', 'bid')).toBeCloseTo(960, 6);
    });

    test('a task token has one valuation, so both sides share it', () => {
        mocks.task.mockReturnValue({ tokenValue: 30_000 });
        expect(resolveCurrencyValue('/items/task_token', 'ask')).toBe(30_000);
        expect(resolveCurrencyValue('/items/task_token', 'bid')).toBe(30_000);
    });

    test('a dungeon token is its best shop line, untaxed as the expected-value chain has it', () => {
        mocks.dungeon.mockReturnValue(1_500);
        expect(resolveCurrencyValue('/items/sinister_token', 'ask')).toBe(1_500);
        expect(mocks.dungeon).toHaveBeenCalledWith('/items/sinister_token', undefined, undefined, 'ask');
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
