/** @vitest-environment happy-dom */
/**
 * "Totals by Input Item" — the decompose history viewer groups filtered
 * sessions by input item and totals attempts, consumption, output value, cost
 * and the input value at which decomposing breaks even.
 *
 * Two things it must keep doing:
 *   - carry transmute's marker discipline: an unpriced input marks the row `*`,
 *     an unpriced catalyst is excluded and marked `†`, a session predating
 *     catalyst tracking is marked `‡`. None of these is ever a silent zero.
 *   - pool inputs the game data says break into the same materials, in a row
 *     that sits *below* the per-item rows rather than replacing them (see
 *     decompose-history-pooled-inputs.test.js for the pooling rule itself).
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const INPUT_A_HRID = '/items/apple';
const INPUT_B_HRID = '/items/zinc_bar';
const OUTPUT_HRID = '/items/dust';
const CATALYST_HRID = '/items/catalyst_of_decomposition';

const mocks = vi.hoisted(() => ({ prices: {}, items: {} }));

vi.mock('./decompose-history-tracker.js', () => ({
    decomposeHistoryTracker: { on: () => {}, off: () => {}, getSessions: async () => [] },
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
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
            mocks.items[itemHrid] ?? {
                name: itemHrid.split('/').pop(),
                itemLevel: 10,
                sellPrice: 1000,
                alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: OUTPUT_HRID, count: 1 }] },
            },
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');

function buildTotalsModal() {
    const modal = document.createElement('div');
    modal.innerHTML = '<div class="mwi-decompose-history-totals-container"></div>';
    document.body.appendChild(modal);
    return modal;
}

function loadSessions(sessions) {
    decomposeHistoryViewer.sessions = sessions;
    decomposeHistoryViewer.filteredSessions = sessions;
    decomposeHistoryViewer.profitCache = new Map();
    for (const session of sessions) {
        decomposeHistoryViewer.profitCache.set(session.id, decomposeHistoryViewer.computeSessionProfit(session));
    }
}

function makeSession(overrides) {
    return {
        id: 's1',
        inputItemHrid: INPUT_A_HRID,
        bulkMultiplier: 1,
        enhancementLevel: 0,
        totalAttempts: 10,
        totalSuccesses: 8,
        results: { [OUTPUT_HRID]: { count: 8, totalValue: 8000, priceEach: 1000 } },
        catalystOfDecompositionUsed: 0,
        primeCatalystUsed: 0,
        ...overrides,
    };
}

function totalsText() {
    return decomposeHistoryViewer.modal.querySelector('.mwi-decompose-history-totals-container').textContent;
}

beforeEach(() => {
    document.body.innerHTML = '';
    decomposeHistoryViewer.modal = buildTotalsModal();
    mocks.items = {};
    mocks.prices = { [INPUT_A_HRID]: 100, [INPUT_B_HRID]: 200, [CATALYST_HRID]: 50, [OUTPUT_HRID]: 1000 };
});

describe('decompose history totals: grouping by input item', () => {
    test('sums two sessions of the same input item into one group', () => {
        loadSessions([
            makeSession({ id: 's1', totalAttempts: 10, totalSuccesses: 8 }),
            makeSession({ id: 's2', totalAttempts: 5, totalSuccesses: 4 }),
        ]);

        const totals = decomposeHistoryViewer.computeInputItemTotals();

        expect(totals).toHaveLength(1);
        const group = totals[0];
        expect(group.sessionCount).toBe(2);
        expect(group.attempts).toBe(15);
        expect(group.successes).toBe(12);
        // A failed attempt destroys its input too
        expect(group.netConsumed).toBe(15);
        expect(group.inputCost).toBe(1500);
        expect(group.successRate).toBeCloseTo(12 / 15);
        // The coin fee is charged per attempt and belongs in Net
        expect(group.coinCost).toBeGreaterThan(0);
        expect(group.net).toBe(group.revenue - group.inputCost - group.catalystCost - group.coinCost);
    });

    test('revenue is the recorded output value after the marketplace cut, not the raw figure', () => {
        loadSessions([makeSession({ results: { [OUTPUT_HRID]: { count: 8, totalValue: 8000 } } })]);

        const [group] = decomposeHistoryViewer.computeInputItemTotals();

        expect(group.revenue).toBeGreaterThan(0);
        expect(group.revenue).toBeLessThan(8000);
    });

    test('break-even input covers catalyst and coin cost out of revenue', () => {
        loadSessions([makeSession({ totalAttempts: 10, catalystOfDecompositionUsed: 10 })]);

        const [group] = decomposeHistoryViewer.computeInputItemTotals();

        expect(group.breakEvenInputValue).toBeCloseTo(
            (group.revenue - group.catalystCost - group.coinCost) / group.netConsumed
        );
    });
});

describe('decompose history totals: honesty markers', () => {
    test('an unpriced input marks the row and says the total is incomplete', () => {
        mocks.prices = { [CATALYST_HRID]: 50, [OUTPUT_HRID]: 1000 };
        loadSessions([makeSession({})]);

        decomposeHistoryViewer.renderTotals();

        expect(totalsText()).toContain('*');
        const marked = Array.from(decomposeHistoryViewer.modal.querySelectorAll('td')).find((td) =>
            td.title.includes('incomplete')
        );
        expect(marked).toBeDefined();
    });

    test('an unpriced catalyst is excluded and marked, not counted as free', () => {
        mocks.prices = { [INPUT_A_HRID]: 100, [OUTPUT_HRID]: 1000 };
        loadSessions([makeSession({ catalystOfDecompositionUsed: 4 })]);

        const [group] = decomposeHistoryViewer.computeInputItemTotals();
        expect(group.catalystCost).toBe(0);
        expect(group.catalystUnpricedSessions).toBe(1);

        decomposeHistoryViewer.renderTotals();
        const marked = Array.from(decomposeHistoryViewer.modal.querySelectorAll('td')).find((td) =>
            td.title.includes('could not price')
        );
        expect(marked).toBeDefined();
        expect(marked.textContent).toContain('†');
    });

    test('a session predating catalyst tracking is unknown, not zero', () => {
        const session = makeSession({});
        delete session.catalystOfDecompositionUsed;
        delete session.primeCatalystUsed;
        loadSessions([session]);

        const [group] = decomposeHistoryViewer.computeInputItemTotals();
        expect(group.catalystUnrecordedSessions).toBe(1);

        decomposeHistoryViewer.renderTotals();
        expect(totalsText()).toContain('‡');
    });
});

describe('decompose history totals: the table that gets drawn', () => {
    test('draws a row per input item plus an "All items" row, and nothing fails to draw', () => {
        mocks.items[INPUT_B_HRID] = {
            name: 'zinc_bar',
            itemLevel: 20,
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: '/items/scrap', count: 3 }] },
        };
        loadSessions([makeSession({ id: 's1' }), makeSession({ id: 's2', inputItemHrid: INPUT_B_HRID })]);

        expect(() => decomposeHistoryViewer.renderTotals()).not.toThrow();

        const rows = decomposeHistoryViewer.modal.querySelectorAll('tbody tr');
        expect(rows).toHaveLength(3);
        expect(rows[2].textContent).toContain('All items');
        expect(totalsText()).toContain('Totals by Input Item');
    });

    test('carries Coin Cost but no jackpot column — decompose pays a fee and has no drop table', () => {
        loadSessions([makeSession({})]);
        decomposeHistoryViewer.renderTotals();

        const headers = Array.from(decomposeHistoryViewer.modal.querySelectorAll('thead th')).map(
            (th) => th.textContent
        );
        expect(headers).toEqual([
            'Input Item',
            'Sessions',
            'Attempts',
            'Consumed',
            'Successes',
            'Revenue',
            'Input Cost',
            'Catalyst Cost',
            'Coin Cost',
            'Net',
            'Break-even Input',
        ]);
    });

    test('no sessions draws no table at all', () => {
        loadSessions([]);
        decomposeHistoryViewer.renderTotals();

        expect(decomposeHistoryViewer.modal.querySelector('table')).toBeNull();
    });
});
