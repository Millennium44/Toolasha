/**
 * "Instead of buying" / "Instead of selling" — a crate's coins and cowbells.
 *
 * Neither has an order book: coins are worth their face, and cowbells what the treasure tracker counts them at
 * (a bag of ten's sell price less tax, split ten ways, or zero when the tracker is set to "Cowbells at zero").
 * Before this, both read as unpriced: a Medium Artisan's Crate lost about a third of its value and flagged every
 * transmute it dropped from as "(an output unpriced)".
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const TARGET = '/items/target';
const SOURCE = '/items/source';
const CRATE = '/items/medium_artisans_crate';
const GEM = '/items/pearl';

/** One setup: decompose a source into one target, with a crate bonus drop each action */
const setup = () => ({
    actionType: 'decompose',
    itemHrid: SOURCE,
    actionsPerHour: 100,
    successRate: 1,
    requirementCosts: [{ itemHrid: SOURCE, count: 1, price: 0 }],
    catalystCostPerHour: 0,
    totalTeaCostPerHour: 0,
    dropRevenues: [{ itemHrid: CRATE, isRare: true, dropsPerHour: 100 }],
});

const book = vi.hoisted(() => ({}));
const tracker = vi.hoisted(() => ({ worth: 10, present: true }));
const loot = vi.hoisted(() => ({ table: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => 0,
        getSettingValue: (id, fallback) => (id === 'selfUse_markMeaning' ? 'keep' : fallback),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        currentCharacterId: 'c1',
        getInitClientData: () => ({
            itemDetailMap: { '/items/source': { alchemyDetail: { decomposeItems: [{ itemHrid: TARGET, count: 1 }] } } },
            openableLootDropMap: { '/items/medium_artisans_crate': loot.table },
        }),
        getItemDetails: (hrid) => ({ alchemyDetail: { decomposeItems: [{ itemHrid: TARGET, count: 1 }] }, hrid }),
        getActionDrinkSlots: () => [],
        getInventory: () => [],
        getEquipment: () => new Map(),
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { lastFetchTimestamp: 1 } }));
vi.mock('./alchemy-profit-calculator.js', () => ({
    default: { calculateCandidateResults: () => [setup()] },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, { side = 'sell' }) => ({
        price: book[hrid]?.[side === 'buy' ? 'ask' : 'bid'] ?? null,
        source: book[hrid] ? 'book' : null,
    }),
    withProfitPricingMode: (_mode, fn) => fn(),
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * 0.9,
    calculateActionsPerHour: () => 0,
    calculateTeaCostsPerHour: () => ({ totalCostPerHour: 0 }),
}));
vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    treasureTracker: () => (tracker.present ? { cowbellWorth: () => tracker.worth } : null),
}));

import { liveAlternatives, liveSellRoutes, clearInsteadCache } from './alchemy-instead-of-buying.js';

describe("a crate's coins and cowbells", () => {
    beforeEach(() => {
        clearInsteadCache();
        tracker.worth = 10;
        tracker.present = true;
        book[TARGET] = { ask: 1000, bid: 900 };
        book[SOURCE] = { ask: 100, bid: 90 };
        // A crate holds 20 coins, 2 cowbells and one gem
        loot.table = [
            { itemHrid: '/items/coin', dropRate: 1, minCount: 20, maxCount: 20 },
            { itemHrid: '/items/cowbell', dropRate: 1, minCount: 2, maxCount: 2 },
            { itemHrid: GEM, dropRate: 1, minCount: 1, maxCount: 1 },
        ];
        book[GEM] = { ask: 50, bid: 40 };
    });

    test('a kept crate counts coins at face and cowbells at the tracker worth, and is fully priced', () => {
        const { alternatives } = liveAlternatives(TARGET, new Set([CRATE]));
        // spend 100; the crate is 20 coins + 2 cowbells at 10 + one gem at its ask of 50 = 90
        expect(alternatives[0].costPerUnit).toBeCloseTo(100 - 90, 6);
        expect(alternatives[0].partlyUnpriced).toBe(false);
        expect(alternatives[0].unpriced).toEqual([]);
    });

    test('an unwanted crate counts the same coins and cowbells, the gem at its bid after tax', () => {
        const { alternatives } = liveAlternatives(TARGET, new Set());
        // 20 + 2 * 10 + 40 * 0.9 = 76
        expect(alternatives[0].costPerUnit).toBeCloseTo(100 - 76, 6);
        expect(alternatives[0].partlyUnpriced).toBe(false);
    });

    test('"Cowbells at zero" in the treasure tracker counts them at zero, still fully priced', () => {
        tracker.worth = 0;
        const { alternatives } = liveAlternatives(TARGET, new Set([CRATE]));
        expect(alternatives[0].costPerUnit).toBeCloseTo(100 - 70, 6);
        expect(alternatives[0].partlyUnpriced).toBe(false);
    });

    test('changing the tracker worth is a new result, not the cached one', () => {
        const before = liveAlternatives(TARGET, new Set([CRATE])).alternatives[0].costPerUnit;
        tracker.worth = 0;
        const after = liveAlternatives(TARGET, new Set([CRATE])).alternatives[0].costPerUnit;
        expect(after).toBeCloseTo(before + 20, 6);
    });

    test('with no tracker or no bag price, cowbells are unpriced and the crate is named', () => {
        tracker.worth = null;
        const { alternatives } = liveAlternatives(TARGET, new Set([CRATE]));
        expect(alternatives[0].partlyUnpriced).toBe(true);
        expect(alternatives[0].unpriced).toEqual([CRATE]);
        // 20 coins + the gem's 50 still count
        expect(alternatives[0].costPerUnit).toBeCloseTo(100 - 70, 6);
    });

    test('an "Instead of selling" route carries the same unpriced list', () => {
        tracker.present = false;
        const { routes, bestLoser } = liveSellRoutes(SOURCE);
        const route = routes[0] ?? bestLoser;
        expect(route).toBeTruthy();
        expect(route.partlyUnpriced).toBe(true);
        expect(route.unpriced).toEqual([CRATE]);
    });
});
