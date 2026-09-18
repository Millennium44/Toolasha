/** @vitest-environment happy-dom */
/**
 * "Totals by Input Item" — the coinify history viewer groups filtered sessions
 * by input item and totals attempts, consumption, coins earned, cost and the
 * input value at which coinifying breaks even.
 *
 * The honesty rules transmute learned the hard way apply here unchanged:
 *   - an input the market cannot price marks the row `*`; the total says it is
 *     incomplete rather than pretending the item was free
 *   - a catalyst that could not be priced is excluded and marked `†`, never
 *     silently costed at zero
 * And the table must not grow a Coin Cost column: coinify pays no alchemy coin
 * fee at all, so that column would be permanent zeros.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const INPUT_A_HRID = '/items/apple';
const INPUT_B_HRID = '/items/zinc_bar';
const CATALYST_HRID = '/items/catalyst_of_coinification';

const mocks = vi.hoisted(() => ({ prices: {} }));

vi.mock('./coinify-history-tracker.js', () => ({
    coinifyHistoryTracker: { on: () => {}, off: () => {}, getSessions: async () => [] },
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
        getItemDetails: (itemHrid) => ({
            name: itemHrid.split('/').pop(),
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1, isCoinifiable: true },
        }),
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { coinifyHistoryViewer } = await import('./coinify-history-viewer.js');

/**
 * The totals host the viewer's modal normally provides. The totals logic reads
 * only `filteredSessions` and `profitCache`, so the rest of the modal is not
 * needed to exercise it.
 */
function buildTotalsModal() {
    const modal = document.createElement('div');
    modal.innerHTML = '<div class="mwi-coinify-history-totals-container"></div>';
    document.body.appendChild(modal);
    return modal;
}

function loadSessions(sessions) {
    coinifyHistoryViewer.sessions = sessions;
    coinifyHistoryViewer.filteredSessions = sessions;
    coinifyHistoryViewer.profitCache = new Map();
    for (const session of sessions) {
        coinifyHistoryViewer.profitCache.set(session.id, coinifyHistoryViewer.computeSessionProfit(session));
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
        totalCoinsEarned: 40000,
        catalystOfCoinificationUsed: 0,
        primeCatalystUsed: 0,
        ...overrides,
    };
}

function totalsText() {
    return coinifyHistoryViewer.modal.querySelector('.mwi-coinify-history-totals-container').textContent;
}

beforeEach(() => {
    document.body.innerHTML = '';
    coinifyHistoryViewer.modal = buildTotalsModal();
    mocks.prices = { [INPUT_A_HRID]: 100, [INPUT_B_HRID]: 200, [CATALYST_HRID]: 50 };
});

describe('coinify history totals: grouping by input item', () => {
    test('sums two sessions of the same input item into one group', () => {
        loadSessions([
            makeSession({ id: 's1', totalAttempts: 10, totalSuccesses: 8, totalCoinsEarned: 40000 }),
            makeSession({ id: 's2', totalAttempts: 5, totalSuccesses: 4, totalCoinsEarned: 20000 }),
        ]);

        const totals = coinifyHistoryViewer.computeInputItemTotals();

        expect(totals).toHaveLength(1);
        const group = totals[0];
        expect(group.sessionCount).toBe(2);
        expect(group.attempts).toBe(15);
        expect(group.successes).toBe(12);
        // Every attempt destroys its input, successful or not
        expect(group.netConsumed).toBe(15);
        expect(group.revenue).toBe(60000);
        expect(group.inputCost).toBe(1500);
        expect(group.net).toBe(58500);
        expect(group.successRate).toBeCloseTo(12 / 15);
    });

    test('different input items stay separate groups', () => {
        loadSessions([makeSession({ id: 's1' }), makeSession({ id: 's2', inputItemHrid: INPUT_B_HRID })]);

        const totals = coinifyHistoryViewer.computeInputItemTotals();

        expect(totals.map((g) => g.inputItemHrid).sort()).toEqual([INPUT_A_HRID, INPUT_B_HRID]);
    });

    test('break-even input is the coin yield per item consumed, net of catalyst', () => {
        loadSessions([makeSession({ totalAttempts: 10, totalCoinsEarned: 40000, catalystOfCoinificationUsed: 10 })]);

        const [group] = coinifyHistoryViewer.computeInputItemTotals();

        // (40000 coins − 10 catalysts × 50) / 10 items consumed
        expect(group.breakEvenInputValue).toBe((40000 - 500) / 10);
    });
});

describe('coinify history totals: honesty markers', () => {
    test('an unpriced input marks the row and its tooltip says the total is incomplete', () => {
        mocks.prices = { [CATALYST_HRID]: 50 };
        loadSessions([makeSession({})]);

        coinifyHistoryViewer.renderTotals();

        expect(totalsText()).toContain('*');
        const marked = Array.from(coinifyHistoryViewer.modal.querySelectorAll('td')).find((td) =>
            td.title.includes('incomplete')
        );
        expect(marked).toBeDefined();
    });

    test('an unpriced catalyst is excluded and marked, not counted as free', () => {
        mocks.prices = { [INPUT_A_HRID]: 100 };
        loadSessions([makeSession({ catalystOfCoinificationUsed: 4 })]);

        const [group] = coinifyHistoryViewer.computeInputItemTotals();
        expect(group.catalystCost).toBe(0);
        expect(group.catalystUnpricedSessions).toBe(1);

        coinifyHistoryViewer.renderTotals();
        const marked = Array.from(coinifyHistoryViewer.modal.querySelectorAll('td')).find((td) =>
            td.title.includes('could not price')
        );
        expect(marked).toBeDefined();
        expect(marked.textContent).toContain('†');
    });

    test('a session predating catalyst tracking is unknown, not zero', () => {
        const session = makeSession({});
        delete session.catalystOfCoinificationUsed;
        delete session.primeCatalystUsed;
        loadSessions([session]);

        const [group] = coinifyHistoryViewer.computeInputItemTotals();
        expect(group.catalystUnrecordedSessions).toBe(1);

        coinifyHistoryViewer.renderTotals();
        expect(totalsText()).toContain('‡');
    });
});

describe('coinify history totals: the table that gets drawn', () => {
    test('draws a row per input item plus an "All items" row, and nothing fails to draw', () => {
        loadSessions([makeSession({ id: 's1' }), makeSession({ id: 's2', inputItemHrid: INPUT_B_HRID })]);

        expect(() => coinifyHistoryViewer.renderTotals()).not.toThrow();

        const rows = coinifyHistoryViewer.modal.querySelectorAll('tbody tr');
        expect(rows).toHaveLength(3);
        expect(rows[2].textContent).toContain('All items');
        expect(totalsText()).toContain('Totals by Input Item');
    });

    test('carries no Coin Cost column — coinify pays no alchemy coin fee', () => {
        loadSessions([makeSession({})]);
        coinifyHistoryViewer.renderTotals();

        const headers = Array.from(coinifyHistoryViewer.modal.querySelectorAll('thead th')).map((th) => th.textContent);
        expect(headers).toEqual([
            'Input Item',
            'Sessions',
            'Attempts',
            'Consumed',
            'Successes',
            'Coins Earned',
            'Input Cost',
            'Catalyst Cost',
            'Net',
            'Break-even Input',
        ]);
    });

    test('the "All items" row leaves break-even blank — it means nothing across mixed items', () => {
        loadSessions([makeSession({ id: 's1' }), makeSession({ id: 's2', inputItemHrid: INPUT_B_HRID })]);
        coinifyHistoryViewer.renderTotals();

        const cells = coinifyHistoryViewer.modal.querySelectorAll('tbody tr:last-child td');
        expect(cells[cells.length - 1].textContent).toBe('—');
    });

    test('no sessions draws no table at all', () => {
        loadSessions([]);
        coinifyHistoryViewer.renderTotals();

        expect(coinifyHistoryViewer.modal.querySelector('table')).toBeNull();
    });
});
