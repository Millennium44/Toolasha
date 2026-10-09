/**
 * "Instead of buying" — an unwanted Artisan's Crate bonus drop is valued at the
 * bid after tax, from the order book, whatever the profit pricing mode resolves
 * a sale to (hybrid picks the ask) and whatever a custom price says.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const TARGET = '/items/target';
const SOURCE = '/items/source';
const CONTENT = '/items/crate_content';

const book = vi.hoisted(() => ({}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => 0 } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        currentCharacterId: 'c1',
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/source': { alchemyDetail: { decomposeItems: [{ itemHrid: '/items/target', count: 1 }] } },
            },
            openableLootDropMap: {
                '/items/artisans_crate': [{ itemHrid: '/items/crate_content', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        }),
        getItemDetails: (hrid) => ({
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/target', count: 1 }] },
            hrid,
        }),
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { lastFetchTimestamp: 1 } }));
vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        calculateCandidateResults: () => [
            {
                actionType: 'decompose',
                itemHrid: '/items/source',
                actionsPerHour: 100,
                successRate: 1,
                requirementCosts: [{ itemHrid: '/items/source', count: 1, price: 0 }],
                catalystCostPerHour: 0,
                totalTeaCostPerHour: 0,
                dropRevenues: [{ itemHrid: '/items/artisans_crate', isRare: true, dropsPerHour: 100 }],
            },
        ],
    },
}));
// The sell side resolves to the ask, as the hybrid profit mode does, and wants tax taken off
vi.mock('./expected-value-calculator.js', () => ({
    default: {
        resolveSellSideValue: (hrid) => ({ value: book[hrid]?.ask ?? null, needsTax: true }),
        resolveBuySideValue: (hrid) => ({ value: book[hrid]?.ask ?? null }),
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, { mode }) => ({ price: book[hrid]?.[mode] ?? null, source: book[hrid] ? 'book' : null }),
    withProfitPricingMode: (_mode, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * 0.9 }));

import { liveAlternatives, clearInsteadCache } from './alchemy-instead-of-buying.js';

describe('an unwanted crate in the live valuation', () => {
    beforeEach(() => {
        clearInsteadCache();
        book[TARGET] = { ask: 1000, bid: 900 };
        book[SOURCE] = { ask: 100, bid: 90 };
        book[CONTENT] = { ask: 200, bid: 100 };
    });

    test('credits the contents at the book bid after tax, not the resolved ask', () => {
        const { alternatives } = liveAlternatives(TARGET, new Set());
        expect(alternatives).toHaveLength(1);
        // spend 100 (source ask), one crate per action worth 100 * 0.9 = 90, one target per action
        expect(alternatives[0].costPerUnit).toBeCloseTo(100 - 90, 6);
    });

    test('ignores a content that has no real book price', () => {
        book[CONTENT] = { ask: 200, bid: 100 };
        const priced = liveAlternatives(TARGET, new Set()).alternatives[0].costPerUnit;
        clearInsteadCache();
        book[CONTENT] = undefined;
        const { alternatives } = liveAlternatives(TARGET, new Set());
        expect(alternatives[0].costPerUnit).toBeGreaterThan(priced);
    });
});
