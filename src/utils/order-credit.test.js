import { describe, test, expect, vi } from 'vitest';
import { buildRestingBuy, buildPartlyFilledBuy, buildCancelledPartlyFilledBuy } from '../__fixtures__/wire/market.js';

vi.mock('../core/data-manager.js', () => ({ default: { getMarketListings: () => [] } }));

const { snapshotOrderCredit, orderCreditState } = await import('./order-credit.js');

const SUGAR = '/items/sugar';

describe('snapshotOrderCredit', () => {
    test('takes the open buy orders for the unenhanced item, with their remainder and fill at the open', () => {
        const listings = [
            buildRestingBuy({ id: 1, orderQuantity: 10, filledQuantity: 3 }),
            buildRestingBuy({ id: 2, isSell: true }),
            buildRestingBuy({ id: 3, enhancementLevel: 2 }),
            buildRestingBuy({ id: 4, status: '/market_listing_status/filled', filledQuantity: 10 }),
            buildPartlyFilledBuy({ id: 5 }),
            // A duplicate row for order 1 is one order
            buildRestingBuy({ id: 1, orderQuantity: 10, filledQuantity: 3 }),
        ];
        expect(snapshotOrderCredit(SUGAR, 7, listings)).toEqual({
            itemHrid: SUGAR,
            orders: [{ id: 1, r0: 7, filled0: 3 }],
            unbacked: 0,
        });
    });

    test('nothing netted is no credit', () => {
        expect(snapshotOrderCredit(SUGAR, 0, [buildRestingBuy()])).toBeNull();
        expect(snapshotOrderCredit(SUGAR, undefined, [buildRestingBuy()])).toBeNull();
    });

    test('units netted that no open order backs are carried as unbacked', () => {
        expect(snapshotOrderCredit(SUGAR, 25, [buildRestingBuy()])).toMatchObject({ unbacked: 15 });
    });

    test('more open orders than were netted credit every order and are never capped', () => {
        const credit = snapshotOrderCredit(SUGAR, 4, [buildRestingBuy({ id: 1 }), buildRestingBuy({ id: 2 })]);
        expect(credit.orders).toHaveLength(2);
        expect(credit.unbacked).toBe(0);
    });
});

describe('orderCreditState', () => {
    const credit = snapshotOrderCredit(SUGAR, 10, [buildRestingBuy()]);

    test('no credit reads as nothing', () => {
        expect(orderCreditState(null, [])).toEqual({ openFilled: 0, addBack: 0 });
        expect(orderCreditState(undefined, [])).toEqual({ openFilled: 0, addBack: 0 });
    });

    test('an open order reports the fills made since the open', () => {
        expect(orderCreditState(credit, [buildRestingBuy()])).toEqual({ openFilled: 0, addBack: 0 });
        expect(orderCreditState(credit, [buildRestingBuy({ filledQuantity: 4 })])).toEqual({
            openFilled: 4,
            addBack: 0,
        });
        expect(orderCreditState(credit, [buildRestingBuy({ filledQuantity: 9 })]).openFilled).toBe(9);
    });

    test('an order that is filled, cancelled, expired or gone is added back whole', () => {
        for (const status of [
            '/market_listing_status/filled',
            '/market_listing_status/cancelled',
            '/market_listing_status/expired',
        ]) {
            expect(orderCreditState(credit, [buildRestingBuy({ status, filledQuantity: 4 })])).toEqual({
                openFilled: 0,
                addBack: 10,
            });
        }
        expect(orderCreditState(credit, [])).toEqual({ openFilled: 0, addBack: 10 });
        expect(orderCreditState(credit, [buildCancelledPartlyFilledBuy({ id: buildRestingBuy().id })]).addBack).toBe(
            10
        );
    });

    test('a duplicate row for one open order reads the larger fill', () => {
        const rows = [buildRestingBuy({ filledQuantity: 2 }), buildRestingBuy({ filledQuantity: 6 })];
        expect(orderCreditState(credit, rows).openFilled).toBe(6);
    });

    test('a fill that began before the open is not this credit’s', () => {
        const partly = snapshotOrderCredit(SUGAR, 7, [buildRestingBuy({ filledQuantity: 3 })]);
        expect(orderCreditState(partly, [buildRestingBuy({ filledQuantity: 5 })]).openFilled).toBe(2);
    });

    test('the unbacked gap is added back for as long as the credit lives', () => {
        const gap = snapshotOrderCredit(SUGAR, 12, [buildRestingBuy()]);
        expect(orderCreditState(gap, [buildRestingBuy()])).toEqual({ openFilled: 0, addBack: 2 });
    });
});
