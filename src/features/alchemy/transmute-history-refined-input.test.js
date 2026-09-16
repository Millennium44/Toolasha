/**
 * A refined (★) cape is untradable, so the marketplace prices it at nothing. The
 * history viewer used to turn that "unknown" into "free" with a `|| 0`, and a
 * session that destroyed a 79M cape reported the 20K/attempt coin fee as its
 * entire loss. The input now falls back to what refining one costs.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const CAPE_HRID = '/items/gatherer_cape_refined';
const SHARD_HRID = '/items/labyrinth_refinement_shard';
const BASE_CAPE_HRID = '/items/gatherer_cape';

const mocks = vi.hoisted(() => ({
    prices: {},
    refineAction: null,
    capeTradable: false,
}));

vi.mock('./transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: { on: () => {}, off: () => {}, getSessions: async () => [] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../utils/market-data.js', () => {
    const priceOf = (itemHrid) => (itemHrid in mocks.prices ? mocks.prices[itemHrid] : null);
    return {
        getItemPrice: (itemHrid) => priceOf(itemHrid),
        getItemPriceInfo: (itemHrid) => {
            const price = priceOf(itemHrid);
            return { price, source: price === null ? null : 'book', estimated: false };
        },
        getItemPrices: (itemHrid) => {
            const price = priceOf(itemHrid);
            return price === null ? null : { ask: price, bid: price, average: price };
        },
        getPricingMode: () => 'ask',
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (itemHrid) =>
            itemHrid === CAPE_HRID
                ? { name: 'Gatherer Cape ★', sellPrice: 100_000, alchemyDetail: { bulkMultiplier: 1 } }
                : null,
        getInitClientData: () => ({
            itemDetailMap: {
                [CAPE_HRID]: { name: 'Gatherer Cape ★', isTradable: false },
                [BASE_CAPE_HRID]: { name: 'Gatherer Cape', isTradable: mocks.capeTradable },
                [SHARD_HRID]: { name: 'Labyrinth Refinement Shard' },
            },
            actionDetailMap: mocks.refineAction ? { '/actions/refine_cape': mocks.refineAction } : {},
        }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

/** A session of 3 attempts on a refined cape: 2 self-returns, 1 failure */
const session = () => ({
    id: 's1',
    inputItemHrid: CAPE_HRID,
    bulkMultiplier: 1,
    totalAttempts: 3,
    totalSuccesses: 2,
    results: {
        [CAPE_HRID]: { count: 2, isSelfReturn: true, totalValue: 0 },
    },
});

describe('transmute history: an untradable refined input', () => {
    beforeEach(() => {
        mocks.prices = { [SHARD_HRID]: 892_000 };
        mocks.capeTradable = false;
        mocks.refineAction = {
            type: '/action_types/enhancing',
            upgradeItemHrid: BASE_CAPE_HRID,
            outputItems: [{ itemHrid: CAPE_HRID }],
            inputItems: [{ itemHrid: SHARD_HRID, count: 100 }],
        };
    });

    test('the net-consumed cape is costed at what refining one costs, not zero', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session());

        // 3 attempts − 2 self-returns = 1 cape actually destroyed
        expect(detail.netConsumed).toBe(1);
        expect(detail.coinCost).toBe(3 * 20_000);
        expect(detail.inputCost).toBeCloseTo(100 * 892_000, 6);
        expect(detail.inputBasis).toBe('refinement craft cost');
        expect(detail.inputUnpriced).toBe(false);
        // Before the fix this was −60K: the coin fee alone, the cape free
        expect(detail.profit).toBeCloseTo(-(100 * 892_000 + 60_000), 6);
    });

    test('a listed refined item still prices off the market', () => {
        mocks.prices[CAPE_HRID] = 1_000_000;

        const detail = transmuteHistoryViewer.computeSessionProfit(session());

        expect(detail.inputCost).toBe(1_000_000);
        expect(detail.inputBasis).toBe('current buy');
    });

    test('a tradable base adds its own acquisition cost to the craft', () => {
        mocks.capeTradable = true;
        mocks.prices[BASE_CAPE_HRID] = 5_000_000;

        const detail = transmuteHistoryViewer.computeSessionProfit(session());

        expect(detail.inputCost).toBeCloseTo(100 * 892_000 + 5_000_000, 6);
    });

    test('an input nothing can price is reported unpriced, not free', () => {
        mocks.refineAction = null;
        delete mocks.prices[SHARD_HRID];

        const detail = transmuteHistoryViewer.computeSessionProfit(session());

        expect(detail.inputCost).toBe(0);
        expect(detail.inputBasis).toBeNull();
        expect(detail.inputUnpriced).toBe(true);
        expect(detail.profit).toBe(-60_000);
    });

    test('an unpriced material sinks the whole craft rather than costing it short', () => {
        delete mocks.prices[SHARD_HRID];

        const detail = transmuteHistoryViewer.computeSessionProfit(session());

        expect(detail.inputUnpriced).toBe(true);
    });
});
