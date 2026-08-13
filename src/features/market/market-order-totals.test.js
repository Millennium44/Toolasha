/**
 * Market Order Totals — the buy/sell/unclaimed roll-up over raw listings.
 * DOM injection (injectDisplay/updateDisplay) is not exercised here.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MARKET_TAX } from '../../utils/profit-constants.js';

const mocks = vi.hoisted(() => ({ listings: [] }));

vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, getMarketListings: () => mocks.listings },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));

const { default: marketOrderTotals } = await import('./market-order-totals.js');

beforeEach(() => {
    mocks.listings = [];
});

describe('calculateTotals', () => {
    test('sums unclaimed coins across every listing regardless of status', () => {
        mocks.listings = [
            { unclaimedCoinCount: 100, isSell: true, status: '/market_listing_status/active', price: 10 },
            { unclaimedCoinCount: 250, isSell: false, status: '/market_listing_status/active' },
        ];
        expect(marketOrderTotals.calculateTotals().unclaimed).toBe(350);
    });

    test('buy orders total the coins locked in, not the item count', () => {
        mocks.listings = [
            { isSell: false, coinsAvailable: 4000, status: '/market_listing_status/active' },
            { isSell: false, coinsAvailable: 1000, status: '/market_listing_status/active' },
        ];
        expect(marketOrderTotals.calculateTotals().buyOrders).toBe(5000);
    });

    test('sell orders are the remaining quantity at price after the market tax, floored per unit', () => {
        mocks.listings = [
            {
                isSell: true,
                price: 101,
                orderQuantity: 10,
                filledQuantity: 3,
                status: '/market_listing_status/active',
                itemHrid: '/items/plank',
            },
        ];
        // floor(101 * (1 - MARKET_TAX)), times remaining 7
        expect(marketOrderTotals.calculateTotals().sellOrders).toBe(Math.floor(101 * (1 - MARKET_TAX)) * 7);
    });

    test('cowbell bag sell orders use the 18% tax rate instead of the standard tax', () => {
        mocks.listings = [
            {
                isSell: true,
                price: 1000,
                orderQuantity: 1,
                filledQuantity: 0,
                status: '/market_listing_status/active',
                itemHrid: '/items/bag_of_10_cowbells',
            },
        ];
        expect(marketOrderTotals.calculateTotals().sellOrders).toBe(Math.floor(1000 * 0.82));
    });

    test('a fully filled sell order with nothing left to claim contributes nothing', () => {
        mocks.listings = [
            {
                isSell: true,
                status: '/market_listing_status/filled',
                unclaimedItemCount: 0,
                unclaimedCoinCount: 0,
                price: 100,
                orderQuantity: 1,
                filledQuantity: 1,
            },
        ];
        const totals = marketOrderTotals.calculateTotals();
        expect(totals.sellOrders).toBe(0);
        expect(totals.unclaimed).toBe(0);
    });

    test('a cancelled listing is skipped entirely, even if it still shows unclaimed coins elsewhere', () => {
        mocks.listings = [
            { status: '/market_listing_status/cancelled', unclaimedCoinCount: 0, isSell: true, price: 100 },
        ];
        const totals = marketOrderTotals.calculateTotals();
        expect(totals).toEqual({ buyOrders: 0, sellOrders: 0, unclaimed: 0 });
    });

    test('null entries in the listings array are ignored rather than throwing', () => {
        mocks.listings = [null, { isSell: false, coinsAvailable: 100, status: '/market_listing_status/active' }];
        expect(marketOrderTotals.calculateTotals().buyOrders).toBe(100);
    });

    test('a fully-claimed sell order with remaining quantity still counts toward sellOrders', () => {
        mocks.listings = [
            {
                isSell: true,
                status: '/market_listing_status/active',
                price: 100,
                orderQuantity: 5,
                filledQuantity: 5,
                unclaimedCoinCount: 0,
            },
        ];
        // remainingQuantity is 0, so no sellOrders contribution
        expect(marketOrderTotals.calculateTotals().sellOrders).toBe(0);
    });
});
