/**
 * A session's Profit cell and the totals row it feeds must agree: the
 * transmute Profit column used to leave catalysts out (while its own new
 * catalyst columns showed them being spent, and the totals Net charged them),
 * so a row read richer than the sum it was part of. And a catalyst that could
 * not be priced or was never recorded contributes nothing to a session's
 * profit in any of the three windows — the cell has to say so with the same
 * marks the totals row uses, not show a clean number.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const INPUT_HRID = '/items/gem';
const OUTPUT_HRID = '/items/dust';
const PRIME_HRID = '/items/prime_catalyst';

const mocks = vi.hoisted(() => ({ prices: {} }));

vi.mock('../../core/storage.js', () => ({
    default: { get: async (_key, _store, fallback) => fallback, set: async () => true },
}));
vi.mock('./transmute-history-tracker.js', () => ({ transmuteHistoryTracker: { loadSessions: async () => [] } }));
vi.mock('./decompose-history-tracker.js', () => ({ decomposeHistoryTracker: { loadSessions: async () => [] } }));
vi.mock('./coinify-history-tracker.js', () => ({ coinifyHistoryTracker: { loadSessions: async () => [] } }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_PROFIT: '#0f0',
        COLOR_LOSS: '#f00',
    },
}));

vi.mock('../../utils/market-data.js', () => {
    const priceOf = (hrid) => (hrid in mocks.prices ? mocks.prices[hrid] : null);
    return {
        getItemPrice: (hrid) => priceOf(hrid),
        getItemPriceInfo: (hrid) => {
            const price = priceOf(hrid);
            return { price, source: price === null ? null : 'book', estimated: false };
        },
        getItemPrices: () => null,
        getPricingMode: () => 'ask',
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
        getItemDetails: (hrid) => ({
            name: hrid.split('/').pop(),
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/dust', count: 1 }] },
        }),
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');
const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');
const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');

/**
 * @param {Object} overrides
 * @returns {Object} A session every window can read
 */
function session(overrides = {}) {
    return {
        id: 's1',
        startTime: Date.UTC(2026, 8, 20),
        trackerVersion: 2,
        inputItemHrid: INPUT_HRID,
        enhancementLevel: 0,
        bulkMultiplier: 1,
        totalAttempts: 10,
        totalSuccesses: 8,
        totalCoinsEarned: 8000,
        results: { [OUTPUT_HRID]: { count: 8, totalValue: 8000, priceEach: 1000 } },
        catalystsUsed: { [PRIME_HRID]: 8 },
        catalystOfDecompositionUsed: 0,
        catalystOfCoinificationUsed: 0,
        primeCatalystUsed: 8,
        ...overrides,
    };
}

/**
 * Draw a viewer over sessions and return the Profit cell text of each row.
 * @param {Object} viewer
 * @param {string} kind
 * @param {Array<Object>} sessions
 * @returns {Array<string>}
 */
function profitCells(viewer, kind, sessions) {
    viewer.sessions = sessions;
    viewer.profitCache.clear();
    if (!viewer.modal) viewer.createModal();
    viewer.applyFilters();
    viewer.renderTable();
    const rows = viewer.modal.querySelectorAll(`.mwi-${kind}-history-table-container tbody tr`);
    // Profit is the cell before the trailing delete button
    return Array.from(rows).map((row) => row.cells[row.cells.length - 2].textContent);
}

beforeEach(() => {
    mocks.prices = { [INPUT_HRID]: 500, [OUTPUT_HRID]: 1000, [PRIME_HRID]: 300 };
});

afterEach(() => {
    for (const viewer of [transmuteHistoryViewer, decomposeHistoryViewer, coinifyHistoryViewer]) {
        viewer.modal?.remove();
        viewer.modal = null;
    }
});

describe('transmute history: a session Profit includes the catalysts it consumed', () => {
    test('profit is revenue − input − coin fee − catalysts', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session());

        expect(detail.catalystCost).toBe(8 * 300);
        expect(detail.profit).toBeCloseTo(detail.revenue - detail.inputCost - detail.coinCost - detail.catalystCost, 6);
    });

    test('the sessions of a group sum to its Net', () => {
        const sessions = [
            session({ id: 'a' }),
            session({ id: 'b', totalAttempts: 6, totalSuccesses: 2, catalystsUsed: { [PRIME_HRID]: 2 } }),
        ];
        transmuteHistoryViewer.sessions = sessions;
        transmuteHistoryViewer.profitCache.clear();
        transmuteHistoryViewer.applyFilters();

        const [group] = transmuteHistoryViewer.computeInputItemTotals();
        const summed = sessions.reduce((sum, s) => sum + transmuteHistoryViewer.profitCache.get(s.id).profit, 0);
        expect(summed).toBeCloseTo(group.net, 6);
    });

    test('an estimated catalyst marks the Profit cell ◇; an unrecorded one ‡; an unpriced one †', () => {
        const cells = profitCells(transmuteHistoryViewer, 'transmute', [
            session({ id: 'est', catalystsUsed: undefined, predictedCatalystHrid: PRIME_HRID }),
            session({ id: 'unrec', startTime: 2, catalystsUsed: undefined, predictedCatalystHrid: null }),
        ]);
        expect(cells.join(' ')).toContain('◇');
        expect(cells.join(' ')).toContain('‡');

        mocks.prices[PRIME_HRID] = null;
        const unpriced = profitCells(transmuteHistoryViewer, 'transmute', [session()]);
        expect(unpriced[0]).toContain('†');
        expect(unpriced.join(' ')).not.toMatch(/NaN|undefined|Infinity/);
    });
});

describe.each([
    ['decompose', decomposeHistoryViewer],
    ['coinify', coinifyHistoryViewer],
])('%s history: the Profit cell marks a catalyst it could not charge', (kind, viewer) => {
    test('an unpriced catalyst marks †', () => {
        mocks.prices[PRIME_HRID] = null;
        const [cell] = profitCells(viewer, kind, [session()]);
        expect(cell).toContain('†');
        expect(cell).not.toMatch(/NaN|undefined|Infinity/);
    });

    test('a session predating catalyst tracking marks ‡, and its catalyst cells say unknown', () => {
        const legacy = session({
            catalystOfDecompositionUsed: undefined,
            catalystOfCoinificationUsed: undefined,
            primeCatalystUsed: undefined,
        });
        const [cell] = profitCells(viewer, kind, [legacy]);
        expect(cell).toContain('‡');
        const dashes = Array.from(viewer.modal.querySelectorAll('tbody td span')).filter(
            (span) => span.textContent === '—' && span.title.includes('predates catalyst tracking')
        );
        expect(dashes).toHaveLength(2);
    });

    test('a priced, recorded catalyst leaves the cell unmarked', () => {
        const [cell] = profitCells(viewer, kind, [session()]);
        expect(cell).not.toMatch(/[†‡]/);
    });
});

describe('Break-even Input says when it is only a bound', () => {
    /**
     * @param {Object} viewer
     * @param {string} kind
     * @param {Array<Object>} sessions
     * @returns {string} The first totals row's Break-even Input cell text
     */
    function breakEvenCell(viewer, kind, sessions) {
        profitCells(viewer, kind, sessions);
        const row = viewer.modal.querySelector(`.mwi-${kind}-history-totals-container tbody tr`);
        return row.cells[row.cells.length - 1].textContent;
    }

    test('transmute: an unpriced output gives a lower bound', () => {
        const text = breakEvenCell(transmuteHistoryViewer, 'transmute', [
            session({ results: { [OUTPUT_HRID]: { count: 8, totalValue: 0, priceEach: 0, unpriced: true } } }),
        ]);
        expect(text.startsWith('≥')).toBe(true);
        expect(text).toContain('¶');
    });

    test('decompose: an unpriced catalyst gives an upper bound', () => {
        mocks.prices[PRIME_HRID] = null;
        expect(breakEvenCell(decomposeHistoryViewer, 'decompose', [session()]).startsWith('≤')).toBe(true);
    });

    test('decompose: both gaps together give no figure at all', () => {
        mocks.prices[PRIME_HRID] = null;
        const text = breakEvenCell(decomposeHistoryViewer, 'decompose', [
            session({ results: { [OUTPUT_HRID]: { count: 8, totalValue: 0, priceEach: 0, unpriced: true } } }),
        ]);
        expect(text).toBe('—¶');
    });

    test('coinify: complete data is a plain figure', () => {
        const text = breakEvenCell(coinifyHistoryViewer, 'coinify', [session()]);
        expect(text).not.toMatch(/[≥≤—]|NaN|undefined|Infinity/);
    });

    test('transmute legend explains ⚠ and the bounds', () => {
        profitCells(transmuteHistoryViewer, 'transmute', [session()]);
        const text = transmuteHistoryViewer.modal.querySelector('.mwi-transmute-history-totals-container').textContent;
        expect(text).toContain('⚠ recorded counts are internally impossible');
        expect(text).toContain('≥ / ≤ on Break-even Input');
    });
});
