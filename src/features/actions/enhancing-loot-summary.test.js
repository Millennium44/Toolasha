import { describe, test, expect } from 'vitest';
import {
    reconstructEnhancingRun,
    countProtections,
    computeEnhancingSummary,
    mergeEnhancingSummaries,
} from './enhancing-loot-summary.js';

describe('reconstructEnhancingRun', () => {
    test('reads item, target, success and attempts from level-keyed drops', () => {
        // The Advanced Intelligence Charm run: 13 at +0, 5 at +1, 1 at +3.
        const drops = {
            '/items/advanced_intelligence_charm::0': 13,
            '/items/advanced_intelligence_charm::1': 5,
            '/items/advanced_intelligence_charm::3': 1,
            '/items/enhancing_essence': 4,
            '/items/coin': 100,
        };
        const run = reconstructEnhancingRun(drops, 19);
        expect(run.baseHrid).toBe('/items/advanced_intelligence_charm');
        expect(run.maxLevel).toBe(3);
        expect(run.targetLevel).toBe(3);
        expect(run.success).toBe(true);
        expect(run.attempts).toBe(19);
    });

    test('a highest level with count > 1 means it failed one short', () => {
        const run = reconstructEnhancingRun({ '/items/foo::0': 10, '/items/foo::2': 3 }, 13);
        expect(run.maxLevel).toBe(2);
        expect(run.targetLevel).toBe(3);
        expect(run.success).toBe(false);
    });

    test('ignores enhancing essence and unleveled items', () => {
        const run = reconstructEnhancingRun(
            { '/items/foo::0': 5, '/items/foo::1': 1, '/items/enhancing_essence': 99 },
            6
        );
        expect(run.baseHrid).toBe('/items/foo');
    });

    test('falls back to summed counts when actionCount is missing', () => {
        const run = reconstructEnhancingRun({ '/items/foo::0': 4, '/items/foo::1': 1 }, 0);
        expect(run.attempts).toBe(5);
    });

    test('returns null without level-keyed drops', () => {
        expect(reconstructEnhancingRun({ '/items/coin': 100 }, 5)).toBeNull();
        expect(reconstructEnhancingRun(null, 5)).toBeNull();
    });
});

describe('countProtections', () => {
    test('zero when never protecting', () => {
        expect(countProtections({ 5: 3 }, 0, 7, true)).toBe(0);
    });

    test('sums protect-parity levels, less the successful passes', () => {
        // protectFrom 5, target 7 (parity odd): count +5 and +7 drops, minus 2 passes on success.
        expect(countProtections({ 5: 3, 6: 1, 7: 1 }, 5, 7, true)).toBe(3 + 1 - 2);
    });

    test('no pass subtraction on a failed run', () => {
        expect(countProtections({ 5: 3, 7: 0 }, 5, 7, false)).toBe(3);
    });

    test('never negative', () => {
        expect(countProtections({ 5: 0 }, 5, 5, true)).toBe(0);
    });
});

describe('computeEnhancingSummary', () => {
    const itemDetails = {
        itemLevel: 10,
        enhancementCosts: [{ itemHrid: '/items/prime_catalyst', count: 1 }],
        protectionItemHrids: ['/items/mirror_of_protection'],
    };
    // Prime catalyst 1000/unit; cheapest protection 5000; +0 charm sells 500,
    // +3 sells 100000.
    const materialPrice = (hrid) => (hrid === '/items/prime_catalyst' ? 1000 : hrid === '/items/coin' ? 1 : 0);
    const protectionPrice = () => 5000;
    const itemValue = (hrid, level) =>
        hrid === '/items/advanced_intelligence_charm' ? (level >= 3 ? 100000 : 500) : 0;
    const deps = { materialPrice, protectionPrice, itemValue };
    // Fake Markov: 10 expected attempts, 0 protects, regardless of protectFrom.
    const calculateEnhancement = () => ({ attempts: 10, protectionCount: 0 });

    const run = {
        baseHrid: '/items/advanced_intelligence_charm',
        levelCounts: { 0: 13, 1: 5, 3: 1 },
        maxLevel: 3,
        targetLevel: 3,
        success: true,
        attempts: 19,
    };

    test('computes expected vs actual material cost and the luck diff', () => {
        const s = computeEnhancingSummary(run, { calculateEnhancement, params: {}, ...deps, itemDetails });
        expect(s.materialExpected).toBe(10 * 1000); // 10 expected attempts × 1000
        expect(s.materialActual).toBe(19 * 1000); // 19 actual attempts × 1000
        expect(s.totalExpected).toBe(10000);
        expect(s.totalActual).toBe(19000);
        expect(s.diff).toBe(9000); // above expected (unlucky)
    });

    test('worth-it profit = +N value after fee − base after fee − spent', () => {
        const s = computeEnhancingSummary(run, {
            calculateEnhancement,
            params: {},
            ...deps,
            itemDetails,
            marketTax: 0.02,
        });
        // 100000×0.98 − 500×0.98 − 19000 = 98000 − 490 − 19000.
        expect(s.finalValue).toBe(100000);
        expect(s.profit).toBeCloseTo(100000 * 0.98 - 500 * 0.98 - 19000, 3);
    });

    test('a failed run values the item at the base price', () => {
        const failed = { ...run, success: false, targetLevel: 4, maxLevel: 3, levelCounts: { 0: 15, 3: 4 } };
        const s = computeEnhancingSummary(failed, { calculateEnhancement, params: {}, ...deps, itemDetails });
        expect(s.finalValue).toBe(500); // base bid
        expect(s.success).toBe(false);
    });

    test('returns null when a dependency is missing', () => {
        expect(computeEnhancingSummary(run, { params: {}, ...deps, itemDetails })).toBeNull();
        expect(computeEnhancingSummary(null, { calculateEnhancement, params: {}, ...deps, itemDetails })).toBeNull();
    });

    test('says so when a material has no price, instead of costing it at zero', () => {
        // materialPrice falls back through market, production cost and NPC; a
        // zero after all that is unknown, not free, and every cost below is
        // then an understatement the reader has to be told about.
        const withUnpriced = {
            ...itemDetails,
            enhancementCosts: [
                { itemHrid: '/items/prime_catalyst', count: 1 },
                { itemHrid: '/items/unlisted_thing', count: 2 },
            ],
        };
        const s = computeEnhancingSummary(run, {
            calculateEnhancement,
            params: {},
            ...deps,
            itemDetails: withUnpriced,
        });
        expect(s.materialsUnpriced).toBe(true);
        // Still the priced part only — the marker is the honest half, not a guess
        expect(s.materialActual).toBe(19 * 1000);
    });

    test('a fully priced run carries no understatement marker', () => {
        const s = computeEnhancingSummary(run, { calculateEnhancement, params: {}, ...deps, itemDetails });
        expect(s.materialsUnpriced).toBe(false);
    });

    test('a zero-count material is not an unpriced one', () => {
        const withZeroCount = {
            ...itemDetails,
            enhancementCosts: [
                { itemHrid: '/items/prime_catalyst', count: 1 },
                { itemHrid: '/items/unlisted_thing', count: 0 },
            ],
        };
        const s = computeEnhancingSummary(run, {
            calculateEnhancement,
            params: {},
            ...deps,
            itemDetails: withZeroCount,
        });
        expect(s.materialsUnpriced).toBe(false);
    });
});

describe('mergeEnhancingSummaries', () => {
    const s = (over = {}) => ({
        materialActual: 1000,
        materialExpected: 800,
        protectActual: 100,
        protectExpected: 50,
        totalActual: 1100,
        totalExpected: 850,
        actualAttempts: 19,
        expectedAttempts: 14,
        actualProtects: 2,
        expectedProtects: 1,
        profit: 500,
        success: true,
        ...over,
    });

    test('sums costs, counts and profit across runs', () => {
        const m = mergeEnhancingSummaries([s(), s({ profit: 300, success: false })]);
        expect(m.runs).toBe(2);
        expect(m.successes).toBe(1);
        expect(m.totalActual).toBe(2200);
        expect(m.totalExpected).toBe(1700);
        expect(m.diff).toBe(500);
        expect(m.actualAttempts).toBe(38);
        expect(m.profit).toBe(800);
    });

    test('one un-priced run makes the merged profit unknown', () => {
        const m = mergeEnhancingSummaries([s(), s({ profit: null })]);
        expect(m.profit).toBeNull();
    });

    test('one understated run understates the merged total, and says so', () => {
        expect(mergeEnhancingSummaries([s(), s()]).materialsUnpriced).toBe(false);
        expect(mergeEnhancingSummaries([s(), s({ materialsUnpriced: true })]).materialsUnpriced).toBe(true);
    });

    test('returns null for an empty list', () => {
        expect(mergeEnhancingSummaries([])).toBeNull();
        expect(mergeEnhancingSummaries(null)).toBeNull();
    });
});
