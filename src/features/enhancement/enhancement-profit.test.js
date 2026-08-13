import { describe, test, expect } from 'vitest';
import { costVsExpected, valueVsCost, MARKET_SELL_TAX } from './enhancement-profit.js';

/** A session with 20 attempts costing 100 each in materials, no protection. */
function session(overrides = {}) {
    return {
        itemHrid: '/items/advanced_intelligence_charm',
        currentLevel: 3,
        targetLevel: 3,
        totalAttempts: 20,
        totalCost: 2000,
        coinCost: 0,
        protectionCost: 0,
        protectionCount: 0,
        materialCosts: { '/items/prime_catalyst': { count: 20, totalCost: 2000 } },
        predictions: { expectedAttempts: 14, expectedProtections: 0 },
        ...overrides,
    };
}

describe('costVsExpected', () => {
    test('returns null without a prediction or attempts', () => {
        expect(costVsExpected(session({ predictions: null }))).toBeNull();
        expect(costVsExpected(session({ totalAttempts: 0 }))).toBeNull();
    });

    test('returns null for a multi-leg (extended) session', () => {
        // The prediction covers only the last leg; cost covers all legs.
        expect(costVsExpected(session(), { attempts: 6, protections: 0 })).toBeNull();
    });

    test('scales expected cost by expected attempts at this run’s unit price', () => {
        const c = costVsExpected(session(), { attempts: 20, protections: 0 });
        // 20 attempts cost 2000 → 100/attempt; expected 14 attempts → 1400.
        expect(c.expectedCost).toBe(1400);
        expect(c.actualCost).toBe(2000);
        expect(c.diff).toBe(-600); // 600 above expected (unlucky)
        expect(c.factor).toBeCloseTo(2000 / 1400, 5);
    });

    test('adds protection cost at the actual unit price × expected protects', () => {
        const c = costVsExpected(
            session({
                protectionCost: 500,
                protectionCount: 5, // 100 per protect
                totalCost: 2500,
                predictions: { expectedAttempts: 14, expectedProtections: 4 },
            }),
            { attempts: 20, protections: 5 }
        );
        // material expected 1400 + protection 100×4 = 400 → 1800.
        expect(c.expectedCost).toBe(1800);
        expect(c.actualCost).toBe(2500);
        expect(c.hasProt).toBe(true);
    });

    test('positive diff means below expected (lucky)', () => {
        const c = costVsExpected(
            session({ totalAttempts: 10, totalCost: 1000, materialCosts: { x: { count: 10, totalCost: 1000 } } }),
            { attempts: 10, protections: 0 }
        );
        // 100/attempt × 14 expected = 1400 vs actual 1000 → +400 below.
        expect(c.diff).toBe(400);
    });
});

describe('valueVsCost', () => {
    const prices = (n) => (hrid, level) => (level === 0 ? { bid: 0, ask: 0 } : { bid: n, ask: n });

    test('returns null before the item is enhanced', () => {
        expect(valueVsCost(session({ currentLevel: 0 }), prices(100))).toBeNull();
        expect(valueVsCost({ currentLevel: 3 }, prices(100))).toBeNull();
    });

    test('net = +N value after fee − base value after fee − spent', () => {
        const v = valueVsCost(session({ totalCost: 2000 }), prices(10000));
        // valueN 10000 × 0.98 − value0 0 − 2000 = 7800.
        expect(v.valueN).toBe(10000);
        expect(v.net).toBeCloseTo(10000 * (1 - MARKET_SELL_TAX) - 2000, 5);
        expect(v.sellTax).toBe(MARKET_SELL_TAX);
    });

    test('subtracts the base value given up', () => {
        const getPrices = (hrid, level) => (level === 0 ? { bid: 1000 } : { bid: 10000 });
        const v = valueVsCost(session({ totalCost: 2000 }), getPrices);
        // (10000 − 1000) after fee − 2000.
        expect(v.net).toBeCloseTo(9000 * (1 - MARKET_SELL_TAX) - 2000, 5);
    });

    test('net is null when the +N level has no market price', () => {
        const getPrices = (hrid, level) => (level === 0 ? { bid: 1000 } : null);
        const v = valueVsCost(session(), getPrices);
        expect(v.valueN).toBeNull();
        expect(v.net).toBeNull();
    });
});
