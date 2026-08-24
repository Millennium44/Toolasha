/**
 * Tests for guild credit pricing.
 *
 * The whole point of the module is that a credit has no listing of its own, so
 * the cases that matter are: the cheapest conversion wins, the rate accounts for
 * conversions that are not one-for-one, and a credit nothing converts into is
 * reported rather than counted as free.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ clientData: null, prices: {}, estimated: new Set() }));

vi.mock('../core/data-manager.js', () => ({
    default: { getInitClientData: () => mocks.clientData },
}));
vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid) => mocks.prices[hrid] ?? null,
    getItemPriceInfo: (hrid) => {
        const price = mocks.prices[hrid] ?? null;
        // A price the module treats as an estimate is one the value map filled in for an
        // item with no order book — the tests name those in `mocks.estimated`
        const estimated = price !== null && mocks.estimated.has(hrid);
        return { price, source: price === null ? null : estimated ? 'value' : 'book', estimated };
    },
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
    mocks.estimated = new Set();
});

describe('gold per credit', () => {
    test('takes the cheapest conversion, counted per credit rather than per item', () => {
        expect(buildGoldPerCredit()[CREDIT]).toBe(750);
    });

    test('an estimated price cannot set the rate — nobody is actually selling at it', () => {
        // Milk is the cheaper conversion at 750/credit, but its price is the game's
        // official value for an item with an empty book rather than a live listing.
        // "Cheapest item that yields a credit" has to mean an item you could buy.
        mocks.estimated.add('/items/milk');
        expect(buildGoldPerCredit()[CREDIT]).toBe(1000); // cheese, which really is listed

        // With the estimate gone from the picture entirely there is still a rate
        mocks.estimated.add('/items/cheese');
        expect(buildGoldPerCredit()[CREDIT]).toBeUndefined();
    });

    test('an item is priced once however many conversions it publishes', () => {
        let calls = 0;
        const prices = mocks.prices;
        mocks.prices = new Proxy(prices, {
            get(target, key) {
                if (typeof key === 'string') calls++;
                return target[key];
            },
        });
        mocks.clientData.itemDetailMap['/items/cheese'].guildCreditConversions = [
            { creditItemHrid: CREDIT, itemCount: 1, creditCount: 1 },
            { creditItemHrid: OTHER_CREDIT, itemCount: 2, creditCount: 1 },
            { creditItemHrid: OTHER_CREDIT, itemCount: 5, creditCount: 4 },
        ];

        buildGoldPerCredit();
        // One lookup for cheese and one for milk, not one per conversion
        expect(calls).toBe(2);
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

describe('an estimated direct price for the credit item itself', () => {
    test('does not beat the conversion rate it was already rejected for', () => {
        // The value map invents 5 for the credit. Taking the estimate would price a
        // shrine level at a fraction of what the conversions say it actually costs.
        mocks.prices['/items/cheese'] = 1000;
        mocks.prices[CREDIT] = 5;
        mocks.estimated.add(CREDIT);

        const conversionRate = buildGoldPerCredit()[CREDIT];
        const { lines, total } = priceGuildCreditCosts([{ itemHrid: CREDIT, count: 2 }]);

        expect(conversionRate).toBeGreaterThan(5);
        expect(lines[0].goldEach).toBe(conversionRate);
        expect(total).toBe(conversionRate * 2);
    });

    test('a real listing for the credit item is still taken directly', () => {
        mocks.prices['/items/cheese'] = 1000;
        mocks.prices[CREDIT] = 5;

        expect(priceGuildCreditCosts([{ itemHrid: CREDIT, count: 2 }]).lines[0].goldEach).toBe(5);
    });
});
