/**
 * On an Iron Cow character `computeSessionProfit`'s Labyrinth Shop revenue must not pay
 * the marketplace fee: an Iron Cow character has no market access to pay it on, whether
 * the token's value came from the shop-value fallback (`decompose-history-viewer.shop-value.test.js`
 * covers the market-character, taxed case) or from an ordinary priced result.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const INPUT_HRID = '/items/scroll_of_gathering';
const TOKEN_HRID = '/items/labyrinth_token';
const SHARD_HRID = '/items/labyrinth_refinement_shard';

const state = vi.hoisted(() => ({ shardPrice: 0, gameMode: 'ironcow' }));

vi.mock('./decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { on: () => {}, off: () => {}, loadSessions: async () => [] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => fallback,
        COLOR_PROFIT: '#4ade80',
        COLOR_LOSS: '#f87171',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => state.gameMode,
        getItemDetails: (itemHrid) =>
            itemHrid === INPUT_HRID ? { name: 'Scroll', itemLevel: 1, alchemyDetail: { bulkMultiplier: 1 } } : null,
        getInitClientData: () => ({
            itemDetailMap: {
                [SHARD_HRID]: { name: 'Labyrinth Refinement Shard' },
            },
            actionDetailMap: {},
            labyrinthShopItemDetailMap: {
                shard: { itemHrid: SHARD_HRID, cost: { count: 1 }, outputCount: 1 },
            },
        }),
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, options) => {
        if (itemHrid === TOKEN_HRID) return null; // untradeable — the whole premise
        if (itemHrid === SHARD_HRID && options?.context === 'profit' && options?.side === 'sell') {
            return state.shardPrice;
        }
        return null;
    },
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
}));

const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');

const sessionWithTokenResult = () => ({
    id: 's1',
    inputItemHrid: INPUT_HRID,
    bulkMultiplier: 1,
    totalAttempts: 10,
    totalSuccesses: 9,
    results: {
        [TOKEN_HRID]: { totalValue: 0, priceEach: 0, unpriced: true, count: 90 },
    },
    catalystOfDecompositionUsed: 0,
    primeCatalystUsed: 0,
});

beforeEach(() => {
    state.shardPrice = 5500;
    state.gameMode = 'ironcow';
});

describe('decompose history on an Iron Cow character: shop-valued revenue is not taxed', () => {
    test('the shop-derived Labyrinth Token revenue is the full value, no market cut taken', () => {
        const detail = decomposeHistoryViewer.computeSessionProfit(sessionWithTokenResult());

        expect(detail.revenueShopValued).toBe(true);
        expect(detail.revenue).toBeCloseTo(90 * 5500, 6);
    });

    test('the same session on a market character pays the market cut (sanity check the mode actually gates it)', () => {
        state.gameMode = 'standard';
        const detail = decomposeHistoryViewer.computeSessionProfit(sessionWithTokenResult());

        expect(detail.revenue).toBeLessThan(90 * 5500);
    });
});
