/**
 * "Instead of buying" — an unwanted Artisan's Crate bonus drop is valued at the
 * bid after tax, from the order book, whatever the profit pricing mode resolves
 * a sale to (hybrid picks the ask) and whatever a custom price says.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const TARGET = '/items/target';
const SOURCE = '/items/source';
const CONTENT = '/items/crate_content';
const CRATE = '/items/artisans_crate';

/** One catalyst/tea setup; `overhead` is what the setup costs per hour */
const setup = (overhead, dropRevenues = []) => ({
    actionType: 'decompose',
    itemHrid: SOURCE,
    actionsPerHour: 100,
    successRate: 1,
    requirementCosts: [{ itemHrid: SOURCE, count: 1, price: 0 }],
    catalystCostPerHour: overhead,
    totalTeaCostPerHour: 0,
    dropRevenues,
    overhead,
});

const book = vi.hoisted(() => ({}));
/** Buy-side custom overrides: the calculator costs a catalyst or tea with these */
const buyOverride = vi.hoisted(() => ({}));
const setups = vi.hoisted(() => ({ list: [] }));
const DECOMPOSE = vi.hoisted(() => [
    { itemHrid: '/items/target', count: 1 },
    { itemHrid: '/items/unpriced', count: 1 },
]);

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => 0 } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        currentCharacterId: 'c1',
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/source': { alchemyDetail: { decomposeItems: DECOMPOSE } },
            },
            openableLootDropMap: {
                '/items/artisans_crate': [{ itemHrid: '/items/crate_content', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        }),
        getItemDetails: (hrid) => ({
            alchemyDetail: { decomposeItems: DECOMPOSE },
            hrid,
        }),
        getActionDrinkSlots: () => [],
        getInventory: () => [],
        getEquipment: () => new Map(),
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { lastFetchTimestamp: 1 } }));
vi.mock('./alchemy-profit-calculator.js', () => ({
    default: {
        calculateCandidateResults: () => setups.list,
    },
}));
// The sell side resolves to the ask, as the hybrid profit mode does, and wants tax taken off
vi.mock('./expected-value-calculator.js', () => ({
    default: {
        resolveSellSideValue: (hrid) => ({ value: book[hrid]?.ask ?? null, needsTax: true }),
        // A custom override: no listing behind it
        resolveBuySideValue: () => ({ value: 50 }),
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, { mode, side = 'sell' }) =>
        side === 'buy' && buyOverride[hrid] !== undefined
            ? { price: buyOverride[hrid], source: 'custom' }
            : { price: book[hrid]?.[mode] ?? null, source: book[hrid] ? 'book' : null },
    withProfitPricingMode: (_mode, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * 0.9 }));

import { liveAlternatives, clearInsteadCache } from './alchemy-instead-of-buying.js';

describe('an unwanted crate in the live valuation', () => {
    beforeEach(() => {
        clearInsteadCache();
        setups.list = [setup(0, [{ itemHrid: CRATE, isRare: true, dropsPerHour: 100 }])];
        book[TARGET] = { ask: 1000, bid: 900 };
        book[SOURCE] = { ask: 100, bid: 90 };
        book[CONTENT] = { ask: 200, bid: 100 };
        for (const hrid of Object.keys(buyOverride)) delete buyOverride[hrid];
    });

    test('a setup whose catalyst has only a buy-side override is not buyable', () => {
        const CATALYST = '/items/catalyst';
        book[CATALYST] = { ask: 500, bid: 400 };
        buyOverride[CATALYST] = 1;
        setups.list = [{ ...setup(0), winningCatalystHrid: CATALYST }];
        expect(liveAlternatives(TARGET, new Set()).alternatives).toHaveLength(0);
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

    test('a kept crate is opened at real book asks, not a custom or estimated price', () => {
        const { alternatives } = liveAlternatives(TARGET, new Set([CRATE]));
        // one crate per action, its content at the book ask of 200: 100 - 200
        expect(alternatives[0].costPerUnit).toBeCloseTo(100 - 200, 6);
    });

    test('a kept crate content with no book ask is unpriced', () => {
        book[CONTENT] = undefined;
        const { alternatives } = liveAlternatives(TARGET, new Set([CRATE]));
        expect(alternatives[0].partlyUnpriced).toBe(true);
        expect(alternatives[0].costPerUnit).toBeCloseTo(100, 6);
    });

    test('when every setup is partly unpriced, the cheapest is picked, not the first', () => {
        // The unpriced decompose output leaves every setup partial; the first has a costly tea
        setups.list = [setup(10000), setup(0)];
        const { alternatives } = liveAlternatives(TARGET, new Set());
        expect(alternatives).toHaveLength(1);
        expect(alternatives[0].result.overhead).toBe(0);
    });
});
