/**
 * Tests for guild credit pricing.
 *
 * The whole point of the module is that a credit has no listing of its own, so
 * the cases that matter are: the cheapest conversion wins, the rate accounts for
 * conversions that are not one-for-one, and a credit nothing converts into is
 * reported rather than counted as free.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ clientData: null, prices: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: { getInitClientData: () => mocks.clientData },
}));
vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid) => mocks.prices[hrid] ?? null,
}));

const { buildGoldPerCredit, priceGuildCreditCosts } = await import('./guild-credit-pricing.js');

const CREDIT = '/items/guild_credit_1';
const OTHER_CREDIT = '/items/guild_credit_2';

beforeEach(() => {
    mocks.clientData = {
        itemDetailMap: {
            [CREDIT]: { name: 'Guild Credit 1' },
            [OTHER_CREDIT]: { name: 'Guild Credit 2' },
            '/items/cheese': {
                name: 'Cheese',
                guildCreditConversions: [{ creditItemHrid: CREDIT, itemCount: 1, creditCount: 1 }],
            },
            '/items/milk': {
                name: 'Milk',
                // Ten milk for four credits: 500 each works out cheaper per credit
                guildCreditConversions: [{ creditItemHrid: CREDIT, itemCount: 10, creditCount: 4 }],
            },
        },
    };
    mocks.prices = { '/items/cheese': 1000, '/items/milk': 300 };
});

describe('gold per credit', () => {
    test('takes the cheapest conversion, counted per credit rather than per item', () => {
        expect(buildGoldPerCredit()[CREDIT]).toBe(750);
    });

    test('an item with no price cannot set the rate', () => {
        mocks.prices = { '/items/cheese': 1000 };
        expect(buildGoldPerCredit()[CREDIT]).toBe(1000);
    });

    test('a credit nothing converts into has no rate', () => {
        expect(buildGoldPerCredit()[OTHER_CREDIT]).toBeUndefined();
    });
});

describe('pricing a level cost', () => {
    test('multiplies the rate by the count', () => {
        const { lines, total, unpriced } = priceGuildCreditCosts([{ itemHrid: CREDIT, count: 20 }]);
        expect(total).toBe(15_000);
        expect(unpriced).toEqual([]);
        expect(lines[0]).toMatchObject({ name: 'Guild Credit 1', count: 20, goldEach: 750 });
    });

    test('a credit with a listing of its own is taken at that price', () => {
        mocks.prices[CREDIT] = 100;
        expect(priceGuildCreditCosts([{ itemHrid: CREDIT, count: 3 }]).total).toBe(300);
    });

    test('an unpriced credit blanks the total instead of being counted as free', () => {
        const { total, unpriced, lines } = priceGuildCreditCosts([
            { itemHrid: CREDIT, count: 1 },
            { itemHrid: OTHER_CREDIT, count: 5 },
        ]);
        expect(total).toBeNull();
        expect(unpriced).toEqual(['Guild Credit 2']);
        expect(lines[1].gold).toBeNull();
    });

    test('nothing to price is free, not unknown', () => {
        expect(priceGuildCreditCosts([]).total).toBe(0);
        expect(priceGuildCreditCosts(undefined).total).toBe(0);
    });
});
