/**
 * Tests for trade ledger fill detection and aggregation
 */

import { describe, test, expect } from 'vitest';
import {
    detectFills,
    trimLedger,
    repairOverRecorded,
    aggregateLedger,
    weekStartOf,
    fillCoins,
    LEDGER_RECORD_CAP,
} from './trade-ledger.js';
import { MARKET_TAX, COWBELL_BAG_TAX } from './profit-constants.js';

const ACTIVE = '/market_listing_status/active';
const CANCELLED = '/market_listing_status/cancelled';
const FILLED = '/market_listing_status/filled';

/** A wire-shaped listing with overridable fields. */
function listing(overrides = {}) {
    return {
        id: 1,
        itemHrid: '/items/coal',
        enhancementLevel: 0,
        price: 100,
        orderQuantity: 100,
        filledQuantity: 0,
        isSell: false,
        status: ACTIVE,
        ...overrides,
    };
}

describe('fillCoins', () => {
    test('buys spend the full gross', () => {
        expect(fillCoins(false, 40, 100)).toBe(4000);
    });

    test('sells net the market tax', () => {
        expect(fillCoins(true, 40, 100)).toBe(Math.round(4000 * (1 - MARKET_TAX)));
        expect(fillCoins(true, 40, 100)).toBe(3840);
    });

    test('a sold bag of cowbells nets its own tax, not the market rate', () => {
        const bag = { itemHrid: '/items/bag_of_10_cowbells', isSell: true, price: 300000, orderQuantity: 10 };
        const first = detectFills({}, [listing(bag)], { now: 1 });
        const { fills } = detectFills(first.states, [listing({ ...bag, filledQuantity: 10, status: FILLED })], {
            now: 2,
        });

        expect(fills[0].coins).toBe(Math.round(3_000_000 * (1 - COWBELL_BAG_TAX)));
        expect(fillCoins(false, 10, 300000, '/items/bag_of_10_cowbells')).toBe(3_000_000);
    });
});

describe('detectFills', () => {
    test('first sighting establishes a baseline, never a fill', () => {
        const { fills, states } = detectFills({}, [listing({ filledQuantity: 60 })], { now: 1000 });

        expect(fills).toEqual([]);
        expect(states['1']).toMatchObject({ filledQuantity: 60, itemHrid: '/items/coal' });
    });

    test('an increase in filledQuantity is a fill for the delta', () => {
        const first = detectFills({}, [listing({ filledQuantity: 10 })], { now: 1000 });
        const { fills } = detectFills(first.states, [listing({ filledQuantity: 25 })], { now: 2000 });

        expect(fills).toEqual([
            {
                t: 2000,
                itemHrid: '/items/coal',
                enhancementLevel: 0,
                side: 'buy',
                quantity: 15,
                price: 100,
                coins: 1500,
                listingId: 1,
            },
        ]);
    });

    test('sell fills carry coins net of tax', () => {
        const first = detectFills({}, [listing({ isSell: true, filledQuantity: 0 })], { now: 1000 });
        const { fills } = detectFills(first.states, [listing({ isSell: true, filledQuantity: 40 })], { now: 2000 });

        expect(fills).toHaveLength(1);
        expect(fills[0].side).toBe('sell');
        expect(fills[0].coins).toBe(3840);
    });

    test('successive partial fills each produce a record', () => {
        let states = detectFills({}, [listing()], { now: 1 }).states;

        const second = detectFills(states, [listing({ filledQuantity: 10 })], { now: 2 });
        states = second.states;
        const third = detectFills(states, [listing({ filledQuantity: 30 })], { now: 3 });

        expect(second.fills[0].quantity).toBe(10);
        expect(third.fills[0].quantity).toBe(20);
    });

    test('unchanged listings produce nothing and report no change', () => {
        const first = detectFills({}, [listing({ filledQuantity: 10 })], { now: 1 });
        const second = detectFills(first.states, [listing({ filledQuantity: 10 })], { now: 2 });

        expect(second.fills).toEqual([]);
        expect(second.changed).toBe(false);
    });

    test('a cancel after a partial fill still records the fill, then tombstones the state', () => {
        const first = detectFills({}, [listing({ filledQuantity: 5 })], { now: 1 });
        const { fills, states } = detectFills(first.states, [listing({ filledQuantity: 12, status: CANCELLED })], {
            now: 2,
        });

        expect(fills[0].quantity).toBe(7);
        expect(states['1']).toEqual({ done: true });
    });

    test('an instant fill — placed and terminal in one live event — is recorded in full', () => {
        const { fills, states } = detectFills({}, [listing({ isSell: true, filledQuantity: 100, status: FILLED })], {
            now: 1,
        });

        expect(fills).toHaveLength(1);
        expect(fills[0]).toMatchObject({ side: 'sell', quantity: 100 });
        expect(states['1']).toEqual({ done: true });
    });

    test('a listing placed and partly filled at once counts the crossing part when the event reports it', () => {
        const placed = listing({ isSell: true, orderQuantity: 1000, filledQuantity: 300 });
        const { fills, states } = detectFills({}, [placed], { now: 1, changedIds: new Set([1]) });

        expect(fills).toHaveLength(1);
        expect(fills[0]).toMatchObject({ side: 'sell', quantity: 300 });
        // The rest fills later against that baseline, not from zero again
        const later = detectFills(states, [{ ...placed, filledQuantity: 1000, status: FILLED }], { now: 2 });
        expect(later.fills[0].quantity).toBe(700);
    });

    test('an unknown active listing the event did not report changed stays baseline-only', () => {
        const { fills } = detectFills({}, [listing({ id: 2, filledQuantity: 300 })], {
            now: 1,
            changedIds: new Set([1]),
        });

        expect(fills).toEqual([]);
    });

    test('claiming a counted listing does not count it again', () => {
        const first = detectFills({}, [listing({ filledQuantity: 100, status: FILLED })], { now: 1 });
        const { fills, changed } = detectFills(first.states, [listing({ filledQuantity: 100, status: FILLED })], {
            now: 2,
        });

        expect(fills).toEqual([]);
        expect(changed).toBe(false);
    });

    test('a terminal listing first seen on a snapshot is history, not a fill — and stays uncounted', () => {
        const snap = detectFills({}, [listing({ filledQuantity: 100, status: FILLED })], { now: 1, snapshot: true });
        expect(snap.fills).toEqual([]);

        // A later live event for it (the claim) must not invent the fill either
        const live = detectFills(snap.states, [listing({ filledQuantity: 100, status: FILLED })], { now: 2 });
        expect(live.fills).toEqual([]);
    });

    test('snapshot cleanup sweeps tombstones for listings no longer on the wire', () => {
        const first = detectFills({}, [listing({ filledQuantity: 100, status: FILLED })], { now: 1 });
        const { states } = detectFills(first.states, [listing({ id: 2, filledQuantity: 0 })], {
            now: 2,
            snapshot: true,
        });

        expect(states['1']).toBeUndefined();
        expect(states['2']).toBeDefined();
    });

    test('snapshot mode drops stale states without inventing fills', () => {
        const first = detectFills({}, [listing({ id: 1, filledQuantity: 3 }), listing({ id: 2, filledQuantity: 0 })], {
            now: 1,
        });
        const { fills, states, changed } = detectFills(first.states, [listing({ id: 2, filledQuantity: 0 })], {
            now: 2,
            snapshot: true,
        });

        expect(fills).toEqual([]);
        expect(states['1']).toBeUndefined();
        expect(states['2']).toBeDefined();
        expect(changed).toBe(true);
    });

    test('offline fills surface when a snapshot shows more filled than the stored baseline', () => {
        const first = detectFills({}, [listing({ filledQuantity: 4 })], { now: 1 });
        const { fills } = detectFills(first.states, [listing({ filledQuantity: 9 })], { now: 2, snapshot: true });

        expect(fills[0].quantity).toBe(5);
    });

    test('duplicate occurrences of a listing in one batch do not double-count', () => {
        const first = detectFills({}, [listing({ filledQuantity: 0 })], { now: 1 });
        const { fills } = detectFills(
            first.states,
            [listing({ filledQuantity: 10 }), listing({ filledQuantity: 10 })],
            { now: 2 }
        );

        expect(fills).toHaveLength(1);
    });

    test('malformed listings are ignored', () => {
        const { fills, states } = detectFills({}, [null, {}, listing({ id: undefined }), { id: 5, price: 3 }], {
            now: 1,
        });

        expect(fills).toEqual([]);
        expect(states).toEqual({});
    });
});

describe('trimLedger', () => {
    test('keeps everything under the cap', () => {
        const records = [{ t: 1 }, { t: 2 }];
        expect(trimLedger(records, 5)).toEqual(records);
    });

    test('evicts the oldest records first', () => {
        const records = [{ t: 3 }, { t: 1 }, { t: 2 }, { t: 4 }];
        expect(trimLedger(records, 2)).toEqual([{ t: 3 }, { t: 4 }]);
    });

    test('default cap is generous', () => {
        expect(LEDGER_RECORD_CAP).toBeGreaterThanOrEqual(10000);
    });
});

describe('weekStartOf', () => {
    test('timestamps in the same local week share a week start', () => {
        const monday = new Date(2026, 0, 5, 9, 0).getTime(); // Mon Jan 5 2026
        const sunday = new Date(2026, 0, 11, 23, 0).getTime(); // Sun Jan 11 2026
        expect(weekStartOf(monday)).toBe(weekStartOf(sunday));
        expect(weekStartOf(monday)).toBe(new Date(2026, 0, 5, 0, 0).getTime());
    });

    test('the week boundary falls between Sunday and Monday', () => {
        const sunday = new Date(2026, 0, 4, 23, 59).getTime();
        const monday = new Date(2026, 0, 5, 0, 1).getTime();
        expect(weekStartOf(sunday)).not.toBe(weekStartOf(monday));
    });
});

describe('aggregateLedger', () => {
    const t = (day, hour = 12) => new Date(2026, 0, day, hour).getTime();

    /** A fill record as detectFills emits them. */
    function record(overrides = {}) {
        return {
            t: t(5),
            itemHrid: '/items/coal',
            enhancementLevel: 0,
            side: 'buy',
            quantity: 10,
            price: 100,
            coins: 1000,
            listingId: 1,
            ...overrides,
        };
    }

    test('buys and sells aggregate into per-item quantities and averages', () => {
        const { items } = aggregateLedger([
            record({ quantity: 10, coins: 1000 }),
            record({ side: 'sell', quantity: 4, price: 150, coins: 588, t: t(6) }),
        ]);

        expect(items).toHaveLength(1);
        const item = items[0];
        expect(item.boughtQty).toBe(10);
        expect(item.avgBuyPrice).toBe(100);
        expect(item.soldQty).toBe(4);
        expect(item.avgSellNet).toBe(147);
        expect(item.lastActivity).toBe(t(6));
    });

    test('realized profit matches sells against average buy cost', () => {
        // Buy 10 @ 100, then 10 @ 200 → average cost 150. Sell 5 netting 1,000.
        const { items } = aggregateLedger([
            record({ quantity: 10, coins: 1000 }),
            record({ quantity: 10, coins: 2000, t: t(5, 13) }),
            record({ side: 'sell', quantity: 5, coins: 1000, t: t(6) }),
        ]);

        expect(items[0].matchedQty).toBe(5);
        expect(items[0].realizedProfit).toBeCloseTo(1000 - 5 * 150, 6);
    });

    test('sells of items never bought stay revenue, not fake 100% profit', () => {
        const { items, totals } = aggregateLedger([record({ side: 'sell', quantity: 4, coins: 588 })]);

        expect(items[0].realizedProfit).toBeNull();
        expect(items[0].avgBuyPrice).toBeNull();
        expect(items[0].unmatchedRevenue).toBe(588);
        expect(totals.realizedProfit).toBe(0);
        expect(totals.unmatchedRevenue).toBe(588);
    });

    test('a sell larger than the buy pool realizes only the matched slice', () => {
        // Bought 4 @ 100; sold 10 netting 1,960 (196 each). 4 matched, 6 unmatched.
        const { items } = aggregateLedger([
            record({ quantity: 4, coins: 400 }),
            record({ side: 'sell', quantity: 10, coins: 1960, t: t(6) }),
        ]);

        const item = items[0];
        expect(item.matchedQty).toBe(4);
        expect(item.realizedProfit).toBeCloseTo(4 * 196 - 400, 6);
        expect(item.unmatchedRevenue).toBeCloseTo(6 * 196, 6);
    });

    test('enhancement levels are separate items', () => {
        const { items } = aggregateLedger([
            record({ itemHrid: '/items/cheese_sword', enhancementLevel: 0 }),
            record({ itemHrid: '/items/cheese_sword', enhancementLevel: 5, t: t(6) }),
        ]);

        expect(items).toHaveLength(2);
    });

    test('items sort by most recent activity first', () => {
        const { items } = aggregateLedger([
            record({ itemHrid: '/items/coal', t: t(5) }),
            record({ itemHrid: '/items/milk', t: t(9) }),
        ]);

        expect(items[0].itemHrid).toBe('/items/milk');
    });

    test('weeks bucket by local Monday and sort most recent first', () => {
        const { weeks } = aggregateLedger([
            record({ t: t(5) }), // week of Mon Jan 5
            record({ side: 'sell', quantity: 5, coins: 735, t: t(6) }),
            record({ t: t(14) }), // week of Mon Jan 12
        ]);

        expect(weeks).toHaveLength(2);
        expect(weeks[0].weekStart).toBe(weekStartOf(t(14)));
        expect(weeks[1].weekStart).toBe(weekStartOf(t(5)));
        expect(weeks[1].boughtCoins).toBe(1000);
        expect(weeks[1].soldCoinsNet).toBe(735);
    });

    test('a week with sells but no ledger-known cost reports revenue, not profit', () => {
        const { weeks } = aggregateLedger([record({ side: 'sell', quantity: 4, coins: 588 })]);

        expect(weeks[0].realizedProfit).toBeNull();
        expect(weeks[0].soldCoinsNet).toBe(588);
        expect(weeks[0].unmatchedRevenue).toBe(588);
    });

    test('cross-week matching still works: buys one week, sells the next', () => {
        const { weeks } = aggregateLedger([
            record({ quantity: 10, coins: 1000, t: t(5) }),
            record({ side: 'sell', quantity: 10, coins: 1470, t: t(14) }),
        ]);

        const sellWeek = weeks.find((week) => week.weekStart === weekStartOf(t(14)));
        expect(sellWeek.realizedProfit).toBeCloseTo(470, 6);
    });

    test('empty and malformed input aggregates to nothing', () => {
        expect(aggregateLedger([]).items).toEqual([]);
        expect(aggregateLedger(null).items).toEqual([]);
        expect(aggregateLedger([null, {}]).items).toEqual([]);
    });
});

describe('repairOverRecorded', () => {
    const row = (listingId, t, quantity, coins = quantity * 95) => ({
        t,
        itemHrid: '/items/a',
        enhancementLevel: 0,
        side: 'sell',
        quantity,
        price: 100,
        coins,
        listingId,
    });
    const caps = (entries) => new Map(entries);

    test('nothing to do: no caps, an empty ledger, or non-array input', () => {
        const rows = [row(1, 1, 5)];
        expect(repairOverRecorded(rows, new Map()).records).toBe(rows);
        expect(repairOverRecorded([], caps([[1, 5]])).repairedIds.size).toBe(0);
        expect(repairOverRecorded(null, caps([[1, 5]])).records).toEqual([]);
    });

    test('exact and under-recorded listings come back as the same rows', () => {
        const rows = [row(1, 1, 5), row(1, 2, 5), row(2, 3, 4)];
        const result = repairOverRecorded(
            rows,
            caps([
                [1, 10],
                [2, 9],
            ])
        );
        expect(result.records).toBe(rows);
        expect(result.repairedIds.size).toBe(0);
    });

    test('keeps the earliest fills and trims the one the cap falls inside', () => {
        const result = repairOverRecorded(
            [row(1, 30, 4, 380), row(1, 10, 4, 380), row(1, 20, 4, 380), row(2, 15, 9, 855)],
            caps([[1, 10]])
        );
        expect([...result.repairedIds]).toEqual([1]);
        expect(result.records.map((r) => [r.listingId, r.t, r.quantity, r.coins])).toEqual([
            [1, 10, 4, 380],
            [2, 15, 9, 855],
            [1, 20, 4, 380],
            [1, 30, 2, 190],
        ]);
    });

    test('fills at the same millisecond collapse to the smaller, so a returning untrimmed row loses', () => {
        const once = repairOverRecorded([row(1, 1, 4), row(1, 2, 4), row(1, 3, 4)], caps([[1, 10]])).records;
        const back = repairOverRecorded([...once, row(1, 3, 4)], caps([[1, 10]])).records;
        expect(back.map((r) => r.quantity)).toEqual([4, 4, 2]);
        expect(repairOverRecorded(back, caps([[1, 10]])).repairedIds.size).toBe(0);
    });

    test('the trimmed row is marked, and only an untrimmed row beside a trimmed one is dropped', () => {
        const trimmed = repairOverRecorded([row(1, 1, 4), row(1, 2, 4), row(1, 3, 4)], caps([[1, 10]])).records;
        expect(trimmed.map((r) => !!r.trimmed)).toEqual([false, false, true]);
        // Two real fills sharing a millisecond, nothing trimmed there: both stay
        const together = repairOverRecorded([row(2, 1, 3), row(2, 1, 3), row(2, 2, 3)], caps([[2, 6]])).records;
        expect(together.map((r) => [r.t, r.quantity])).toEqual([
            [1, 3],
            [1, 3],
        ]);
    });

    test('is idempotent', () => {
        const c = caps([[1, 7]]);
        const first = repairOverRecorded([row(1, 1, 5), row(1, 2, 5), row(1, 3, 5)], c).records;
        expect(repairOverRecorded(first, c).records).toBe(first);
    });
});
