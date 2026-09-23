/**
 * Decomposing scrolls yields Labyrinth Tokens, which are untradeable — the
 * market prices them at nothing, so every such session used to show 0
 * revenue and read as a pure loss ("Labyrinth Token x90 = 0 (0 each)"). A
 * token still has a value: the best conversion its own Labyrinth Shop
 * offers (`alchemy-shop-value.js`). These tests prove `computeSessionProfit`
 * picks that value up for an unpriced result, and that the profit cell and
 * results line mark it as shop-derived rather than showing it as an
 * ordinary market price.
 */

/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const INPUT_HRID = '/items/scroll_of_gathering';
const TOKEN_HRID = '/items/labyrinth_token';
const SHARD_HRID = '/items/labyrinth_refinement_shard';

const state = vi.hoisted(() => ({ shardPrice: 0 }));

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
    state.shardPrice = 0;
});

describe('decompose history: Labyrinth Token is valued through the shop, not priced at zero', () => {
    test('revenue picks up the shop-derived value when the market cannot price the token', () => {
        state.shardPrice = 5500;
        const detail = decomposeHistoryViewer.computeSessionProfit(sessionWithTokenResult());

        expect(detail.revenue).toBe(90 * 5500);
        expect(detail.revenueShopValued).toBe(true);
        // The shop fallback covered the only unpriced result, so the session is not
        // reported as having any UNRESOLVED unpriced revenue
        expect(detail.revenueUnpriced).toBe(false);
    });

    test('stays unpriced (not zero) when the shop itself has nothing priced', () => {
        state.shardPrice = 0;
        const detail = decomposeHistoryViewer.computeSessionProfit(sessionWithTokenResult());

        expect(detail.revenue).toBe(0);
        expect(detail.revenueShopValued).toBe(false);
        expect(detail.revenueUnpriced).toBe(true);
    });

    test('the results cell marks the line as shop-derived, with a value and a tooltip naming the shop item', () => {
        state.shardPrice = 5500;
        const cell = document.createElement('td');
        decomposeHistoryViewer.renderResultsCell(cell, sessionWithTokenResult());

        expect(cell.textContent).toContain('labyrinth token');
        expect(cell.textContent).toContain('§');
        expect(cell.textContent).not.toContain('NaN');
        expect(cell.textContent).not.toContain('undefined');
        const line = cell.querySelector('span');
        expect(line.title).toContain('Labyrinth Refinement Shard');
        expect(line.title).toContain('5.5K');
    });

    test('the results cell falls back to the plain unpriced marker when the shop cannot price it', () => {
        state.shardPrice = 0;
        const cell = document.createElement('td');
        decomposeHistoryViewer.renderResultsCell(cell, sessionWithTokenResult());

        expect(cell.textContent).toContain('¶');
        expect(cell.textContent).not.toContain('§');
    });
});
