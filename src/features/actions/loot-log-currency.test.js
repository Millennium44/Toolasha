import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    resolveSellSideValue: vi.fn(),
    labyrinth: vi.fn(),
    task: vi.fn(),
}));

vi.mock('../market/expected-value-calculator.js', () => ({
    default: { resolveSellSideValue: mocks.resolveSellSideValue },
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

import { resolveCurrencyValue, isNonMarketCurrency } from './loot-log-currency.js';

describe('resolveCurrencyValue', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('cowbells and dungeon tokens go through the drop-valuation chain', () => {
        mocks.resolveSellSideValue.mockImplementation((hrid) => ({
            value: hrid === '/items/cowbell' ? 90_000 : 1_500,
        }));
        expect(resolveCurrencyValue('/items/cowbell')).toBe(90_000);
        expect(resolveCurrencyValue('/items/chimerical_token')).toBe(1_500);
        expect(resolveCurrencyValue('/items/sinister_token')).toBe(1_500);
    });

    test('labyrinth tokens use the labyrinth shop valuation', () => {
        mocks.labyrinth.mockReturnValue({ value: 2_000, itemHrid: '/items/x' });
        expect(resolveCurrencyValue('/items/labyrinth_token')).toBe(2_000);
    });

    test('task tokens use the task shop valuation', () => {
        mocks.task.mockReturnValue({ tokenValue: 30_000 });
        expect(resolveCurrencyValue('/items/task_token')).toBe(30_000);
    });

    test('an unpriceable currency is null so the caller falls back, and an ordinary item is not a currency', () => {
        mocks.task.mockReturnValue({ tokenValue: null });
        mocks.resolveSellSideValue.mockReturnValue(null);
        expect(resolveCurrencyValue('/items/task_token')).toBeNull();
        expect(resolveCurrencyValue('/items/cowbell')).toBeNull();
        expect(resolveCurrencyValue('/items/milk')).toBeNull();
        expect(isNonMarketCurrency('/items/milk')).toBe(false);
    });
});
