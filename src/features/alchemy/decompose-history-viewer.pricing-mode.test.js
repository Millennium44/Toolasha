/**
 * `computeSessionProfit` used to price a session's input at a hardcoded
 * ask-then-bid — `inputPrices?.ask > 0 ? inputPrices.ask : inputPrices?.bid`,
 * read off `getItemPrices` — ignoring `profitCalc_pricingMode` entirely. The
 * transmute history viewer got this right (`getItemPrice(hrid, { context:
 * 'profit', side: 'buy' })`), so decompose now goes through the same call —
 * and a market-data mock that only answers a `context: 'profit', side: 'buy'`
 * lookup, never a bare ask/bid pair, is enough to prove the old shape is gone
 * (calling the removed `getItemPrices` would throw).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const INPUT_HRID = '/items/cotton';
const CATALYST_HRID = '/items/catalyst_of_decomposition';

const state = vi.hoisted(() => ({ mode: 'conservative' }));

vi.mock('./decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { on: () => {}, off: () => {}, loadSessions: async () => [] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => fallback,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getItemDetails: (itemHrid) =>
            itemHrid === INPUT_HRID ? { name: 'Cotton', itemLevel: 1, alchemyDetail: { bulkMultiplier: 1 } } : null,
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
    },
}));

// Simulates what the real `getItemPriceInfo` does for a pricing mode: a
// caller that asks for the buy side under the 'profit' context gets a price
// that depends on the mode, proving the mode is actually consulted rather
// than a fixed ask/bid pick.
function priceFor(itemHrid, options) {
    if (options?.context !== 'profit' || options?.side !== 'buy') return null;
    if (itemHrid === INPUT_HRID) return state.mode === 'optimistic' ? 100 : 200;
    if (itemHrid === CATALYST_HRID) return 50;
    return null;
}

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid, options) => priceFor(itemHrid, options),
    getItemPriceInfo: (itemHrid, options) => {
        const price = priceFor(itemHrid, options);
        return { price, source: price === null ? null : 'book', estimated: false };
    },
}));

const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');

const session = () => ({
    id: 's1',
    inputItemHrid: INPUT_HRID,
    bulkMultiplier: 1,
    totalAttempts: 10,
    totalSuccesses: 8,
    results: {},
    catalystOfDecompositionUsed: 2,
    primeCatalystUsed: 0,
});

beforeEach(() => {
    state.mode = 'conservative';
});

describe('decompose history: input pricing follows profitCalc_pricingMode', () => {
    test('a conservative-mode price is used for the input', () => {
        state.mode = 'conservative';
        const detail = decomposeHistoryViewer.computeSessionProfit(session());
        expect(detail.inputCost).toBe(10 * 200);
    });

    test('switching to optimistic mode changes the input cost — the old ask/bid pick could not do this', () => {
        state.mode = 'optimistic';
        const detail = decomposeHistoryViewer.computeSessionProfit(session());
        expect(detail.inputCost).toBe(10 * 100);
    });

    test('the catalyst price also goes through the buy-side profit lookup', () => {
        const detail = decomposeHistoryViewer.computeSessionProfit(session());
        expect(detail.catalystCost).toBe(2 * 50);
    });
});
