/** @vitest-environment happy-dom */
/**
 * Pooling equivalent decompose inputs.
 *
 * The case this exists for is scrolls: a handful of attempts on each of
 * several scroll types is several rows too thin to read, when the question
 * being asked is "is decomposing scrolls worth it at all". Two inputs are the
 * same trade when the game data says they break into the same materials, in
 * the same counts, at the same bulk size — decompose is deterministic, so that
 * is the whole of the trade.
 *
 * The rules that make the row trustworthy, all of them load-bearing:
 *   - the pooled row is IN ADDITION to the per-item rows, never instead of them
 *   - it is hoverable, and the tooltip names its members
 *   - membership comes from the game data, not a hardcoded list of hrids, so an
 *     item whose outputs differ drops out by itself
 *   - it is never folded into "All items", which reduces over the per-item
 *     groups — adding it there would count every session twice
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const SCROLL_A = '/items/scroll_of_efficiency';
const SCROLL_B = '/items/scroll_of_gathering';
const SCROLL_C = '/items/scroll_of_wisdom';
const ODD_ONE_OUT = '/items/zinc_bar';
const ESSENCE = '/items/essence';
const SCRAP = '/items/scrap';

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
        getItemDetails: (itemHrid) => mocks.items[itemHrid] ?? null,
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { decomposeHistoryViewer } = await import('./decompose-history-viewer.js');

/**
 * An item the game data says breaks into `outputs`.
 * @param {string} name
 * @param {Array<{itemHrid: string, count: number}>} outputs
 * @param {number} [bulk]
 */
function item(name, outputs, bulk = 1) {
    return {
        name,
        itemLevel: 10,
        sellPrice: 1000,
        alchemyDetail: { bulkMultiplier: bulk, decomposeItems: outputs },
    };
}

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

function makeSession(id, inputItemHrid, overrides = {}) {
    return {
        id,
        inputItemHrid,
        bulkMultiplier: 1,
        enhancementLevel: 0,
        totalAttempts: 10,
        totalSuccesses: 8,
        results: { [ESSENCE]: { count: 8, totalValue: 8000, priceEach: 1000 } },
        catalystOfDecompositionUsed: 0,
        primeCatalystUsed: 0,
        ...overrides,
    };
}

beforeEach(() => {
    document.body.innerHTML = '';
    decomposeHistoryViewer.modal = buildTotalsModal();
    mocks.prices = { [SCROLL_A]: 100, [SCROLL_B]: 100, [SCROLL_C]: 100, [ODD_ONE_OUT]: 100, [ESSENCE]: 1000 };
    mocks.items = {
        [SCROLL_A]: item('Scroll of Efficiency', [{ itemHrid: ESSENCE, count: 2 }]),
        [SCROLL_B]: item('Scroll of Gathering', [{ itemHrid: ESSENCE, count: 2 }]),
        [SCROLL_C]: item('Scroll of Wisdom', [{ itemHrid: ESSENCE, count: 2 }]),
        [ODD_ONE_OUT]: item('Zinc Bar', [{ itemHrid: SCRAP, count: 3 }]),
    };
});

describe('decompose equivalence key', () => {
    test('scrolls that break into the same materials share a key', () => {
        const keyA = decomposeHistoryViewer.getDecomposeEquivalenceKey(SCROLL_A);
        expect(keyA).not.toBeNull();
        expect(decomposeHistoryViewer.getDecomposeEquivalenceKey(SCROLL_B)).toBe(keyA);
    });

    test('an item that breaks into different materials has a different key', () => {
        expect(decomposeHistoryViewer.getDecomposeEquivalenceKey(ODD_ONE_OUT)).not.toBe(
            decomposeHistoryViewer.getDecomposeEquivalenceKey(SCROLL_A)
        );
    });

    test('the same outputs at a different count are a different trade', () => {
        mocks.items[SCROLL_B] = item('Scroll of Gathering', [{ itemHrid: ESSENCE, count: 3 }]);

        expect(decomposeHistoryViewer.getDecomposeEquivalenceKey(SCROLL_B)).not.toBe(
            decomposeHistoryViewer.getDecomposeEquivalenceKey(SCROLL_A)
        );
    });

    test('the same outputs at a different bulk size are a different trade', () => {
        mocks.items[SCROLL_B] = item('Scroll of Gathering', [{ itemHrid: ESSENCE, count: 2 }], 5);

        expect(decomposeHistoryViewer.getDecomposeEquivalenceKey(SCROLL_B)).not.toBe(
            decomposeHistoryViewer.getDecomposeEquivalenceKey(SCROLL_A)
        );
    });

    test('an item with no decompose data pools with nothing', () => {
        mocks.items['/items/mystery'] = { name: 'Mystery', alchemyDetail: { bulkMultiplier: 1 } };

        expect(decomposeHistoryViewer.getDecomposeEquivalenceKey('/items/mystery')).toBeNull();
        expect(decomposeHistoryViewer.getDecomposeEquivalenceKey('/items/not_an_item')).toBeNull();
    });
});

describe('pooled decompose rows', () => {
    test('three equivalent scrolls produce one pooled group summing all three', () => {
        loadSessions([makeSession('s1', SCROLL_A), makeSession('s2', SCROLL_B), makeSession('s3', SCROLL_C)]);

        const totals = decomposeHistoryViewer.computeInputItemTotals();
        const pooled = decomposeHistoryViewer.computePooledTotals(totals);

        expect(pooled).toHaveLength(1);
        expect(pooled[0].memberHrids).toHaveLength(3);
        expect(pooled[0].sessionCount).toBe(3);
        expect(pooled[0].attempts).toBe(30);
        expect(pooled[0].netConsumed).toBe(30);
        expect(pooled[0].revenue).toBeCloseTo(totals.reduce((sum, g) => sum + g.revenue, 0));
    });

    test('an item that is not equivalent is left out of the pool', () => {
        loadSessions([makeSession('s1', SCROLL_A), makeSession('s2', SCROLL_B), makeSession('s3', ODD_ONE_OUT)]);

        const pooled = decomposeHistoryViewer.computePooledTotals(decomposeHistoryViewer.computeInputItemTotals());

        expect(pooled).toHaveLength(1);
        expect(pooled[0].memberHrids).toEqual([SCROLL_A, SCROLL_B]);
    });

    test('a single scroll pools with nothing — one row must not be relabelled as a summary', () => {
        loadSessions([makeSession('s1', SCROLL_A), makeSession('s2', ODD_ONE_OUT)]);

        expect(decomposeHistoryViewer.computePooledTotals(decomposeHistoryViewer.computeInputItemTotals())).toEqual([]);
    });

    test('the pooled row is drawn in addition to the per-item rows, above "All items"', () => {
        loadSessions([makeSession('s1', SCROLL_A), makeSession('s2', SCROLL_B)]);

        expect(() => decomposeHistoryViewer.renderTotals()).not.toThrow();

        const rows = Array.from(decomposeHistoryViewer.modal.querySelectorAll('tbody tr'));
        // two per-item rows + the pooled row + "All items"
        expect(rows).toHaveLength(4);
        expect(rows[0].textContent).toContain('Scroll of Efficiency');
        expect(rows[1].textContent).toContain('Scroll of Gathering');
        expect(rows[2].textContent).toContain('Pooled: 2 equivalent inputs');
        expect(rows[3].textContent).toContain('All items');
    });

    test('the pooled row is hoverable and names its members', () => {
        loadSessions([makeSession('s1', SCROLL_A), makeSession('s2', SCROLL_B)]);
        decomposeHistoryViewer.renderTotals();

        const pooledRow = Array.from(decomposeHistoryViewer.modal.querySelectorAll('tbody tr')).find((row) =>
            row.textContent.includes('Pooled')
        );
        const title = pooledRow.querySelector('td').title;

        expect(title).toContain('Scroll of Efficiency');
        expect(title).toContain('Scroll of Gathering');
        expect(title).toContain('read from the game data');
    });

    test('"All items" counts each session once — the pooled row is not folded in', () => {
        loadSessions([makeSession('s1', SCROLL_A), makeSession('s2', SCROLL_B)]);
        decomposeHistoryViewer.renderTotals();

        const overall = Array.from(decomposeHistoryViewer.modal.querySelectorAll('tbody tr')).at(-1);
        const sessionsCell = overall.querySelectorAll('td')[1];

        expect(sessionsCell.textContent).toBe('2');
    });

    test('an unpriced input on any member marks the pooled row too', () => {
        delete mocks.prices[SCROLL_B];
        loadSessions([makeSession('s1', SCROLL_A), makeSession('s2', SCROLL_B)]);

        const pooled = decomposeHistoryViewer.computePooledTotals(decomposeHistoryViewer.computeInputItemTotals());

        expect(pooled[0].inputUnpriced).toBe(true);
    });
});
