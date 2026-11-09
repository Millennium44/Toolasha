import { describe, test, expect, vi } from 'vitest';
import {
    priceAcquisitionRoute,
    selectAcquisitionRoute,
    chooseCraftAcquisition,
    acquisitionBookPrice,
} from './acquisition-route.js';

const quote = (gross, consumed = [], context = {}) => priceAcquisitionRoute({ id: 'craft', gross, consumed }, context);

describe('explicit acquisition accounting', () => {
    test('keeps cash and real cost separate and never sells a consumed copy twice', () => {
        const context = {
            copies: [
                { id: 'worn', sale: 100 },
                { id: 'spare', sale: 90 },
            ],
            sellIds: ['worn', 'worn'],
        };
        expect(quote(20, [{ id: 'worn' }], context)).toMatchObject({ cash: 20, real: 20, credit: 0 });
        expect(quote(20, [{ id: 'spare' }], context)).toMatchObject({ cash: 0, real: 10, credit: 100 });
        expect(quote(20, [], context)).toMatchObject({ cash: 0, real: -80, credit: 100 });
        expect(quote(20, [{ id: 'worn' }], { ...context, keep: true })).toMatchObject({ cash: 20, real: 120 });
    });
    test('preserves an unknown owned sale instead of making a spare free', () => {
        const context = { copies: [{ id: 'base', sale: null }] };
        expect(quote(20, [{ id: 'base' }], context)).toMatchObject({ cash: 20, real: null, priced: false });
        expect(quote(20, [{ id: 'base' }], { ...context, sellIds: ['base'] })).toMatchObject({ cash: 20, real: 20 });
        expect(quote(20, [], { ...context, sellIds: ['base'] }).warnings).toHaveLength(1);
    });
    test('uses fractional Blessed Tea consumption once, including remaining trade-in', () => {
        const context = { copies: [{ id: 'lower', sale: 100 }], sellIds: ['lower'] };
        expect(quote(40, [{ id: 'lower', share: 0.75 }], context)).toMatchObject({ cash: 15, real: 15, credit: 25 });
        expect(quote(40, [{ id: 'lower', share: 0.75 }], { ...context, keep: true })).toMatchObject({
            cash: 40,
            real: 115,
        });
    });
    test.each([null, undefined, NaN, Infinity, -1])('does not price invalid outlay %s', (gross) => {
        expect(quote(gross).cash).toBeNull();
        expect(quote(gross).real).toBeNull();
    });
    test('permits explicit zero and rejects reused or nonexistent physical copy IDs', () => {
        expect(quote(0)).toMatchObject({ cash: 0, real: 0, priced: true });
        const context = {
            copies: [
                { id: 'one', sale: 3 },
                { id: 'two', sale: 3 },
                { id: 'three', sale: 3 },
            ],
        };
        expect(quote(5, [{ id: 'one' }, { id: 'two' }, { id: 'three' }], context).real).toBe(14);
        expect(quote(5, [{ id: 'one' }, { id: 'one' }], context).real).toBeNull();
        expect(quote(5, [{ id: 'missing' }], context).cash).toBeNull();
        expect(
            quote(5, [], {
                copies: [
                    { id: 'one', sale: 3 },
                    { id: 'one', sale: 3 },
                ],
            }).cash
        ).toBeNull();
    });
    test('does not retain, mutate or mix character snapshots across comparisons', () => {
        const original = { copies: [{ id: 'one', sale: 5 }], sellIds: ['one'] };
        const snapshot = structuredClone(original);
        expect(quote(10, [], original).real).toBe(5);
        expect(quote(10, [], { copies: [], sellIds: [] }).real).toBe(10);
        expect(original).toEqual(snapshot);
    });
});

describe('shared Watch selection policy', () => {
    const routes = [
        { id: 'buy', cash: 170, real: 170, marker: 'buy' },
        { id: 'craft', cash: 100, real: 200, marker: 'owned base' },
        { id: 'mirror', cash: 130, real: 160, marker: 'mirror bill' },
    ];
    test('uses real cost, keeps bills attached and honors preference', () => {
        expect(selectAcquisitionRoute(routes).chosen).toBe(routes[2]);
        expect(selectAcquisitionRoute(routes, { preference: 'craft' }).chosen).toBe(routes[1]);
        expect(selectAcquisitionRoute(routes, { preference: 'mirror', allowMirror: false }).chosen).toBe(routes[0]);
    });
    test('only an explicit pin can use blocked or unknown-real-cost cash', () => {
        const unknown = { id: 'craft', cash: 10, real: null, eligibility: { status: 'blocked' } };
        expect(selectAcquisitionRoute([routes[0], unknown], { preference: 'craft' }).chosen).toBe(routes[0]);
        expect(selectAcquisitionRoute([routes[0], unknown], { pin: 'craft' }).chosen).toBe(unknown);
        expect(selectAcquisitionRoute([unknown]).chosen).toBeNull();
        expect(selectAcquisitionRoute(routes, { pin: 'absent', preference: 'craft' })).toMatchObject({
            chosen: routes[2],
            pinUnavailable: true,
        });
    });
    test('compares bought and owned craft bases by real cost and preserves shopping levels', () => {
        const bought = { cash: 170, real: 170, upgradeBaseLevel: 13 };
        const owned = { cash: 100, real: 200, upgradeBaseLevel: 0 };
        expect(chooseCraftAcquisition([bought, owned])).toBe(bought);
        expect(chooseCraftAcquisition([{ ...owned, real: null }, bought])).toBe(bought);
        expect(
            chooseCraftAcquisition([
                { ...bought, real: null },
                { ...owned, real: null },
            ]).cash
        ).toBe(100);
    });
    test('an unpriced first base cannot hide a later known cash bill with unknown real cost', () => {
        const missing = { cash: null, real: null };
        const cashOnly = { cash: 20, real: null };
        expect(chooseCraftAcquisition([missing, cashOnly])).toBe(cashOnly);
    });
    test('filters blocked bases without losing unknown or pinned hypothetical data', () => {
        const blocked = { cash: 1, real: 1, eligibility: { status: 'blocked' } };
        const known = { cash: 20, real: 20, eligibility: { status: 'available' } };
        expect(chooseCraftAcquisition([blocked, known])).toBe(known);
        expect(chooseCraftAcquisition([blocked])).toBe(blocked);
        expect(chooseCraftAcquisition([blocked], true)).toBeNull();
        expect(chooseCraftAcquisition([])).toBeNull();
    });
    test('keeps route order on ties, and unknown inputs never rank as zero', () => {
        const tied = [routes[0], { id: 'craft', cash: 20, real: 170 }];
        expect(selectAcquisitionRoute(tied).chosen).toBe(tied[0]);
        expect(selectAcquisitionRoute([{ id: 'buy', cash: null, real: null }]).chosen).toBeNull();
    });
    test('uses exactly the requested market side and ticks only live books', () => {
        const tick = vi.fn((value) => value + 1);
        const context = { itemHrid: '/items/test', level: 13, transaction: 'buy', side: 'bid' };
        expect(acquisitionBookPrice({ ask: 100, bid: 80 }, context, tick)).toBe(81);
        expect(tick.mock.calls[0][3]).toMatchObject({ enhancementLevel: 13 });
        expect(acquisitionBookPrice({ ask: 100, bid: 80, bidEstimated: true }, context, tick)).toBe(80);
        expect(acquisitionBookPrice({ ask: 100 }, context, tick)).toBe(0);
        expect(tick).toHaveBeenCalledTimes(1);
    });
});
