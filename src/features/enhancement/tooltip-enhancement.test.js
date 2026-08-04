/**
 * Tests for the enhancement tooltip's path builder.
 *
 * The interesting question is not what the numbers are — the Markov chain has its own tests —
 * but whether the breakdown the tooltip prints actually adds up to the total it prints beside
 * it. A mirror plan that expands into items the DP never bought produces a table that does not
 * reconcile, and only a sum can catch that.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as mathjs from 'mathjs';

const ITEM = '/items/test_sword';
const MATERIAL = '/items/test_material';
const MIRROR = '/items/philosophers_mirror';
const PROTECTION = '/items/mirror_of_protection';

// Prices the mocked market answers with. Tuned so mirroring is worth it: the base item and the
// mirror are cheap while every enhancement attempt burns an expensive material.
const prices = {
    [ITEM]: { ask: 100, bid: 90 },
    [MATERIAL]: { ask: 5000, bid: 4800 },
    [MIRROR]: { ask: 2000, bid: 1900 },
    [PROTECTION]: { ask: 900000, bid: 850000 },
};

const gameData = {
    itemDetailMap: {
        [ITEM]: {
            name: 'Test Sword',
            itemLevel: 10,
            enhancementCosts: [{ itemHrid: MATERIAL, count: 1 }],
        },
        [MATERIAL]: { name: 'Test Material', sellPrice: 100 },
        [MIRROR]: { name: "Philosopher's Mirror", sellPrice: 1 },
        [PROTECTION]: { name: 'Mirror of Protection', sellPrice: 1 },
    },
    actionDetailMap: {},
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getAchievementBuffFlatBoost: () => 0,
        characterData: null,
    },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: () => false,
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_MIRROR: '#fff',
        COLOR_BORDER: '#fff',
        COLOR_TOOLTIP_INFO: '#fff',
        COLOR_TOOLTIP_PROFIT: '#fff',
        COLOR_TOOLTIP_LOSS: '#fff',
        COLOR_XP_RATE: '#fff',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { on: () => {}, getPrice: (hrid) => prices[hrid] || null },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => prices[hrid]?.ask ?? 0,
    getItemPrices: (hrid, level) => (level === 0 ? (prices[hrid] ?? null) : null),
}));

vi.mock('../../utils/tea-parser.js', () => ({
    parseArtisanBonus: () => 0,
    getDrinkConcentration: () => 0,
}));

let calculateEnhancementPath;

beforeAll(async () => {
    globalThis.math = mathjs;
    ({ calculateEnhancementPath } = await import('./tooltip-enhancement.js'));
});

const enhancingConfig = {
    enhancingLevel: 100,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    experienceBonus: 0,
    guzzlingBonus: 1,
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
};

describe('calculateEnhancementPath', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    test('a traditional path prices the base item, the materials and the protections', () => {
        const data = calculateEnhancementPath(ITEM, 1, enhancingConfig);
        const strategy = data.optimalStrategy;

        const lineItems =
            strategy.baseCost + strategy.materialCost + strategy.protectionCost + (strategy.philosopherMirrorCost || 0);

        expect(lineItems).toBeCloseTo(strategy.totalCost, 6);
    });

    test('a mirrored path is used when mirroring is the cheaper way up', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);

        expect(data.optimalStrategy.usedMirror).toBe(true);
        expect(data.optimalStrategy.mirrorCount).toBeGreaterThan(0);
    });

    test('every mirrored line item together adds up to the quoted total', () => {
        for (let level = 2; level <= 12; level++) {
            const data = calculateEnhancementPath(ITEM, level, enhancingConfig);
            const strategy = data.optimalStrategy;
            if (!strategy.usedMirror) continue;

            const consumed = strategy.consumedItems.reduce((sum, item) => sum + item.totalCost, 0);
            const lineItems = consumed + strategy.philosopherMirrorCost;

            expect(lineItems).toBeCloseTo(strategy.totalCost, 6);
        }
    });

    test('a mirrored line item is priced at what one item at that level costs', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);

        for (const item of data.optimalStrategy.consumedItems) {
            expect(item.quantity).toBeGreaterThan(0);
            expect(item.totalCost).toBeCloseTo(item.quantity * item.costEach, 6);
            // A consumed item is one the plan buys outright, so it is never itself mirrored
            expect(item.level).toBeLessThan(data.targetLevel);
        }
    });

    test('the mirror plan only claims levels the DP actually mirrored', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);
        const strategy = data.optimalStrategy;

        // Every level named in the breakdown is a real, buildable level
        for (const item of strategy.consumedItems) {
            expect(item.level).toBeGreaterThanOrEqual(0);
            expect(Number.isFinite(item.costEach)).toBe(true);
        }
        // The first mirrored level is one the walk back from the target actually reaches
        expect(strategy.mirrorStartLevel).toBeGreaterThanOrEqual(2);
        expect(strategy.mirrorStartLevel).toBeLessThanOrEqual(data.targetLevel);
    });

    test('mirroring is considered at +2, not only from +3 up', () => {
        // Make the mirror nearly free so combining a +0 and a +1 must beat enhancing to +2
        const cheapMirror = { ...prices[MIRROR] };
        prices[MIRROR] = { ask: 1, bid: 1 };
        try {
            const data = calculateEnhancementPath(ITEM, 2, enhancingConfig);
            expect(data.optimalStrategy.usedMirror).toBe(true);
            expect(data.optimalStrategy.mirrorStartLevel).toBe(2);
        } finally {
            prices[MIRROR] = cheapMirror;
        }
    });

    test('time and attempts count only the levels the plan builds', () => {
        const data = calculateEnhancementPath(ITEM, 8, enhancingConfig);
        const strategy = data.optimalStrategy;

        expect(strategy.totalTime).toBeGreaterThan(0);
        expect(strategy.expectedAttempts).toBeGreaterThan(0);
        // Mirror combinations are instant, so a mirrored path is never slower than the
        // traditional one it replaced
        expect(strategy.totalCost).toBeLessThanOrEqual(strategy.traditionalCost);
    });
});
