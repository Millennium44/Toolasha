import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
    ironCow: { value: false },
    dungeon: vi.fn(),
    labyrinth: vi.fn(),
    getItemPrice: vi.fn(),
}));

vi.mock('../../utils/ironcow-valuation.js', () => ({
    isIronCowCharacter: () => mocks.ironCow.value,
    getIronCowValue: () => null,
    ironCowBook: () => null,
}));
vi.mock('../market/expected-value-calculator.js', () => ({ default: { isInitialized: true } }));
vi.mock('../../utils/token-valuation.js', () => ({
    DUNGEON_TOKEN_HRIDS: new Set(['/items/chimerical_token']),
    calculateDungeonTokenValue: mocks.dungeon,
    calculateLabyrinthTokenValueDetail: mocks.labyrinth,
}));
vi.mock('../tasks/task-profit-calculator.js', () => ({
    calculateTaskTokenValue: vi.fn(),
    // Mirrors the real valueTaskRewards (covered in task-profit-calculator.test.js)
    valueTaskRewards: (data, { tokens = 0 } = {}) =>
        !data || data.error || !Number.isFinite(data.tokenValue)
            ? null
            : tokens * data.tokenValue + tokens * (Number.isFinite(data.giftPerTaskPoint) ? data.giftPerTaskPoint : 0),
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: mocks.getItemPrice }));

import { resolveCurrencyValue } from './loot-log-currency.js';

/** The real tax helper is in play here: an Iron Cow character pays no market or bag tax on any currency. */
describe('resolveCurrencyValue for an Iron Cow character', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.getItemPrice.mockReturnValue(1_000_000);
        mocks.dungeon.mockReturnValue(1_500);
        mocks.labyrinth.mockReturnValue({ value: 2_000, itemHrid: 'x' });
    });

    test('is untaxed on every currency', () => {
        mocks.ironCow.value = true;
        expect(resolveCurrencyValue('/items/cowbell', 'ask')).toBeCloseTo(100_000, 6);
        expect(resolveCurrencyValue('/items/chimerical_token', 'ask')).toBe(1_500);
        expect(resolveCurrencyValue('/items/labyrinth_token', 'ask')).toBe(2_000);
    });

    test('a market character pays the bag tax and the market tax', () => {
        mocks.ironCow.value = false;
        expect(resolveCurrencyValue('/items/cowbell', 'ask')).toBeCloseTo(82_000, 6);
        expect(resolveCurrencyValue('/items/chimerical_token', 'ask')).toBeCloseTo(1_440, 6);
        expect(resolveCurrencyValue('/items/labyrinth_token', 'ask')).toBeCloseTo(1_920, 6);
    });
});
