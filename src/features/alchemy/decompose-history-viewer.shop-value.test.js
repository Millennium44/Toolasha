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
const { calculatePriceAfterTax } = await import('../../utils/profit-helpers.js');

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

        expect(detail.revenue).toBeCloseTo(calculatePriceAfterTax(90 * 5500), 6);
        expect(detail.revenueShopValued).toBe(true);
        // The shop fallback covered the only unpriced result, so the session is not
        // reported as having any UNRESOLVED unpriced revenue
        expect(detail.revenueUnpriced).toBe(false);
    });

    test('a session recorded before the unpriced flag (token stored as priced at 0) takes the shop value too', () => {
        state.shardPrice = 5500;
        const legacy = sessionWithTokenResult();
        legacy.results[TOKEN_HRID] = { totalValue: 0, priceEach: 0, unpriced: false, count: 90 };
        const detail = decomposeHistoryViewer.computeSessionProfit(legacy);
        expect(detail.revenue).toBeCloseTo(calculatePriceAfterTax(90 * 5500), 6);
        expect(detail.revenueShopValued).toBe(true);

        const cell = document.createElement('td');
        decomposeHistoryViewer.renderResultsCell(cell, legacy);
        expect(cell.textContent).toContain('§');
    });

    test('the shop value pays the market cut, the same as a market-priced output of equal value', () => {
        // Realizing a token as gold means selling what the shop converts it to on the
        // market; leaving the cut off overstated every scroll session by the tax rate
        state.shardPrice = 5500;
        const shopValued = decomposeHistoryViewer.computeSessionProfit(sessionWithTokenResult());
        const marketPriced = decomposeHistoryViewer.computeSessionProfit({
            ...sessionWithTokenResult(),
            results: { [SHARD_HRID]: { totalValue: 90 * 5500, priceEach: 5500, count: 90 } },
        });

        expect(shopValued.revenue).toBeLessThan(90 * 5500);
        expect(shopValued.revenue).toBeCloseTo(marketPriced.revenue, 6);
    });

    test('the CSV export shows the shop value it charged, not the recorded zero, and says so', () => {
        state.shardPrice = 5500;
        decomposeHistoryViewer.sessions = [{ ...sessionWithTokenResult(), startTime: Date.UTC(2026, 8, 20) }];
        decomposeHistoryViewer.profitCache.clear();
        let csv = null;
        const OriginalBlob = globalThis.Blob;
        const spy = vi.spyOn(globalThis, 'Blob').mockImplementation(
            class {
                constructor(parts, opts) {
                    csv = parts[0];
                    return new OriginalBlob(parts, opts);
                }
            }
        );
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:mock');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        decomposeHistoryViewer.exportHistory();
        spy.mockRestore();

        const row = csv.split('\n')[1];
        expect(row).toContain('x90 = 495.0K (5.5K each, Labyrinth Shop value)');
        expect(row).toContain('valued at its best Labyrinth Shop conversion');
        expect(row).not.toMatch(/NaN|undefined|Infinity/);
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
