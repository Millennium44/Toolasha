/** @vitest-environment happy-dom */
/**
 * Pooled totals for equivalent transmute inputs.
 *
 * Four refined capes transmuted a handful of times each say nothing on their
 * own: against a ~6.5% jackpot, one drop either way swings a per-cape row by
 * hundreds of millions. Pooled they are one sample worth reading — but only if
 * they really are the same bet, so membership is derived from the game data
 * (success rate, drop table, bulk size) rather than from a list of names.
 *
 * The rules under test:
 *   - equivalent inputs pool into one extra row that sums the parts
 *   - an input whose rate or drop shape differs stays out by itself
 *   - one qualifying item produces no pooled row (that is the per-item row)
 *   - a flagged member poisons the pooled row exactly as it poisons its own
 *   - the per-item rows are untouched by any of this
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const STONE_HRID = '/items/philosophers_stone';
const CAPE_HRIDS = [
    '/items/gatherer_cape_refined',
    '/items/chance_cape_refined',
    '/items/culinary_cape_refined',
    '/items/artificer_cape_refined',
];
const ODD_RATE_HRID = '/items/odd_rate_cape_refined';
const ODD_SHAPE_HRID = '/items/odd_shape_cape_refined';
const PLAIN_HRID = '/items/soul_stone';

const mocks = vi.hoisted(() => ({ prices: {}, items: {} }));

vi.mock('./transmute-history-tracker.js', () => ({
    transmuteHistoryTracker: { on: () => {}, off: () => {}, getSessions: async () => [] },
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
            mocks.items[itemHrid] || {
                name: itemHrid.split('/').pop(),
                sellPrice: 1000,
                itemLevel: 10,
                alchemyDetail: { bulkMultiplier: 1 },
            },
        getInitClientData: () => ({ itemDetailMap: mocks.items, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

/**
 * A refined-cape-shaped item: ~90% self-return, ~10% Philosopher's Stone.
 * @param {string} hrid
 * @param {{rate?: number, stoneDropRate?: number, bulk?: number}} [opts]
 * @returns {Object}
 */
function capeItem(hrid, opts = {}) {
    return {
        name: hrid.split('/').pop(),
        sellPrice: 1000,
        itemLevel: 10,
        alchemyDetail: {
            bulkMultiplier: opts.bulk ?? 1,
            transmuteSuccessRate: opts.rate ?? 0.7,
            transmuteDropTable: [
                { itemHrid: hrid, dropRate: 0.9, minCount: 1, maxCount: 1 },
                { itemHrid: STONE_HRID, dropRate: opts.stoneDropRate ?? 0.1, minCount: 1, maxCount: 1 },
            ],
        },
    };
}

function loadSessions(sessions) {
    transmuteHistoryViewer.sessions = sessions;
    transmuteHistoryViewer.filteredSessions = sessions;
    transmuteHistoryViewer.profitCache = new Map();
    for (const session of sessions) {
        transmuteHistoryViewer.profitCache.set(session.id, transmuteHistoryViewer.computeSessionProfit(session));
    }
}

/**
 * One clean session: 10 attempts, 7 successes, 6 self-returns and 1 stone.
 * @param {string} hrid
 * @param {Object} [overrides]
 * @returns {Object}
 */
function capeSession(hrid, overrides = {}) {
    return {
        id: `s-${hrid}`,
        inputItemHrid: hrid,
        bulkMultiplier: 1,
        totalAttempts: 10,
        totalSuccesses: 7,
        predictedCatalystHrid: null,
        results: {
            [hrid]: { count: 6, isSelfReturn: true, totalValue: 0 },
            [STONE_HRID]: { count: 1, isSelfReturn: false, totalValue: 500_000_000, priceEach: 500_000_000 },
        },
        ...overrides,
    };
}

beforeEach(() => {
    mocks.items = {};
    for (const hrid of CAPE_HRIDS) mocks.items[hrid] = capeItem(hrid);
    mocks.items[ODD_RATE_HRID] = capeItem(ODD_RATE_HRID, { rate: 0.5 });
    mocks.items[ODD_SHAPE_HRID] = capeItem(ODD_SHAPE_HRID, { stoneDropRate: 0.25 });
    mocks.items[PLAIN_HRID] = {
        name: 'soul_stone',
        sellPrice: 1000,
        itemLevel: 10,
        alchemyDetail: { bulkMultiplier: 1 },
    };

    mocks.prices = { [STONE_HRID]: 500_000_000 };
    for (const hrid of [...CAPE_HRIDS, ODD_RATE_HRID, ODD_SHAPE_HRID, PLAIN_HRID]) mocks.prices[hrid] = 100;
});

describe('pooled totals: membership is derived from the game data', () => {
    test('four equivalent inputs pool into one row whose figures are the sum of the parts', () => {
        loadSessions(CAPE_HRIDS.map((hrid) => capeSession(hrid)));

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const pooled = transmuteHistoryViewer.computePooledTotals(totals);

        expect(totals).toHaveLength(4);
        expect(pooled).toHaveLength(1);

        const row = pooled[0];
        expect(row.memberHrids.sort()).toEqual([...CAPE_HRIDS].sort());
        expect(row.sessionCount).toBe(4);
        expect(row.attempts).toBe(40);
        expect(row.successes).toBe(28);
        // netConsumed per cape: 10 attempts − 6 self-returns = 4
        expect(row.netConsumed).toBe(16);
        expect(row.nonSelfReturnOutputs).toBe(4);
        expect(row.inputsPerOutput).toBeCloseTo(4, 6);

        // Every summed money column matches the parts exactly
        for (const field of ['revenue', 'inputCost', 'coinCost', 'catalystCost']) {
            const expected = totals.reduce((sum, group) => sum + group[field], 0);
            expect(row[field]).toBeCloseTo(expected, 6);
        }
        expect(row.net).toBeCloseTo(row.revenue - row.inputCost - row.catalystCost - row.coinCost, 6);
        expect(row.successRate).toBeCloseTo(28 / 40, 6);
    });

    test('an input with a different success rate stays out of the pool', () => {
        loadSessions([...CAPE_HRIDS.map((hrid) => capeSession(hrid)), capeSession(ODD_RATE_HRID)]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const [row] = transmuteHistoryViewer.computePooledTotals(totals);

        expect(row.memberHrids).not.toContain(ODD_RATE_HRID);
        expect(row.memberHrids).toHaveLength(4);
        expect(row.attempts).toBe(40);
    });

    test('an input with a different drop-table shape stays out of the pool', () => {
        loadSessions([...CAPE_HRIDS.map((hrid) => capeSession(hrid)), capeSession(ODD_SHAPE_HRID)]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const [row] = transmuteHistoryViewer.computePooledTotals(totals);

        expect(row.memberHrids).not.toContain(ODD_SHAPE_HRID);
        expect(row.memberHrids).toHaveLength(4);
    });

    test('an input with a different bulk size stays out of the pool', () => {
        const oddBulk = '/items/odd_bulk_cape_refined';
        mocks.items[oddBulk] = capeItem(oddBulk, { bulk: 5 });
        mocks.prices[oddBulk] = 100;
        loadSessions([
            ...CAPE_HRIDS.map((hrid) => capeSession(hrid)),
            capeSession(oddBulk, { bulkMultiplier: 5, id: 's-oddbulk' }),
        ]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const [row] = transmuteHistoryViewer.computePooledTotals(totals);

        expect(row.memberHrids).not.toContain(oddBulk);
    });

    test('an item with no transmute drop table pools with nothing', () => {
        expect(transmuteHistoryViewer.getTransmuteEquivalenceKey(PLAIN_HRID)).toBeNull();

        loadSessions([capeSession(CAPE_HRIDS[0]), { ...capeSession(PLAIN_HRID), id: 'plain' }]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        expect(transmuteHistoryViewer.computePooledTotals(totals)).toHaveLength(0);
    });

    test('a single qualifying item produces no pooled row — that is just the per-item row', () => {
        loadSessions([capeSession(CAPE_HRIDS[0])]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();

        expect(totals).toHaveLength(1);
        expect(transmuteHistoryViewer.computePooledTotals(totals)).toHaveLength(0);
    });

    test('two disjoint equivalence classes produce two pooled rows, not one', () => {
        const oddPair = ['/items/odd_rate_two_refined', ODD_RATE_HRID];
        mocks.items[oddPair[0]] = capeItem(oddPair[0], { rate: 0.5 });
        mocks.prices[oddPair[0]] = 100;

        loadSessions([...CAPE_HRIDS, ...oddPair].map((hrid) => capeSession(hrid)));

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const pooled = transmuteHistoryViewer.computePooledTotals(totals);

        expect(pooled).toHaveLength(2);
        expect(pooled.map((row) => row.memberHrids.length).sort()).toEqual([2, 4]);
    });
});

describe('pooled totals: honesty rules carry through', () => {
    // Cell order matches buildTotalsRow — see transmute-history-totals.test.js
    const COL = {
        ITEM: 0,
        SESSIONS: 1,
        ATTEMPTS: 2,
        CONSUMED: 3,
        SUCCESSES: 4,
        REVENUE: 5,
        INPUT_COST: 6,
        CATALYST_COST: 7,
        COIN_COST: 8,
        NET: 9,
        INPUTS_PER_OUTPUT: 10,
        BREAK_EVEN: 11,
    };

    test('a flagged member poisons the pooled row and suppresses every derived column', () => {
        const corrupt = capeSession(CAPE_HRIDS[0], {
            totalAttempts: 75,
            totalSuccesses: 64,
            results: { [CAPE_HRIDS[0]]: { count: 103, isSelfReturn: true, totalValue: 0 } },
        });
        loadSessions([corrupt, ...CAPE_HRIDS.slice(1).map((hrid) => capeSession(hrid))]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const [pooled] = transmuteHistoryViewer.computePooledTotals(totals);

        expect(pooled.impossible).toBe(true);

        const row = transmuteHistoryViewer.buildTotalsRow(pooled, 0);
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);

        expect(cells[COL.ITEM]).toContain('⚠');
        for (const col of [
            COL.CONSUMED,
            COL.SUCCESSES,
            COL.INPUT_COST,
            COL.NET,
            COL.INPUTS_PER_OUTPUT,
            COL.BREAK_EVEN,
        ]) {
            expect(cells[col]).toBe('—');
        }
        // Figures that never depended on the corrupt counts keep showing
        expect(cells[COL.SESSIONS]).toBe('4');
        expect(cells[COL.REVENUE]).not.toBe('—');
    });

    test('the § repaired and ◇ estimated-catalyst markers carry into the pooled row', () => {
        loadSessions([
            capeSession(CAPE_HRIDS[0], {
                repair: { id: 'transmute-self-return-batching', outcome: 'repaired', from: 9, to: 6 },
                predictedCatalystHrid: STONE_HRID,
            }),
            ...CAPE_HRIDS.slice(1).map((hrid) => capeSession(hrid)),
        ]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const [pooled] = transmuteHistoryViewer.computePooledTotals(totals);

        expect(pooled.repairedSessions).toBe(1);
        expect(pooled.catalystEstimatedSessions).toBe(1);

        const row = transmuteHistoryViewer.buildTotalsRow(pooled, 0);
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);

        expect(cells[COL.ITEM]).toContain('§');
        expect(cells[COL.CATALYST_COST]).toContain('◇');
    });

    test('an unpriced input marks the pooled input cost incomplete, not zero', () => {
        delete mocks.prices[CAPE_HRIDS[0]];
        loadSessions(CAPE_HRIDS.map((hrid) => capeSession(hrid)));

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const [pooled] = transmuteHistoryViewer.computePooledTotals(totals);

        expect(pooled.inputUnpriced).toBe(true);
        const row = transmuteHistoryViewer.buildTotalsRow(pooled, 0);
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);
        expect(cells[COL.INPUT_COST]).toContain('*');
    });

    test('the pooled row names its members so the reader can audit it', () => {
        loadSessions(CAPE_HRIDS.map((hrid) => capeSession(hrid)));

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const [pooled] = transmuteHistoryViewer.computePooledTotals(totals);
        const row = transmuteHistoryViewer.buildTotalsRow(pooled, 0);
        const itemCell = row.querySelector('td');

        expect(itemCell.textContent).toContain('Pooled');
        expect(itemCell.textContent).toContain('4');
        for (const hrid of CAPE_HRIDS) {
            expect(itemCell.title).toContain(transmuteHistoryViewer.getItemName(hrid));
        }
        // Not labelled after any one family of items — the rule is about
        // equivalent transmute inputs, not about capes
        expect(itemCell.textContent.toLowerCase()).not.toContain('cape');
    });
});

describe('pooled totals: the per-item rows are unchanged', () => {
    test('pooling adds a row without altering any per-item group', () => {
        loadSessions(CAPE_HRIDS.map((hrid) => capeSession(hrid)));

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const before = totals.map((group) => ({ ...group, catalystHrids: undefined }));

        transmuteHistoryViewer.computePooledTotals(totals);

        const after = totals.map((group) => ({ ...group, catalystHrids: undefined }));
        expect(after).toEqual(before);
        expect(totals).toHaveLength(4);
    });

    test('the rendered table keeps all four per-item rows, adds one pooled row, and keeps "All items" whole', () => {
        loadSessions(CAPE_HRIDS.map((hrid) => capeSession(hrid)));

        transmuteHistoryViewer.modal = document.createElement('div');
        transmuteHistoryViewer.modal.innerHTML = '<div class="mwi-transmute-history-totals-container"></div>';
        transmuteHistoryViewer.renderTotals();

        const bodyRows = Array.from(transmuteHistoryViewer.modal.querySelectorAll('tbody tr'));
        // 4 per-item + 1 pooled + 1 overall
        expect(bodyRows).toHaveLength(6);

        const firstCells = bodyRows.map((row) => row.querySelector('td').textContent);
        for (const hrid of CAPE_HRIDS) {
            expect(firstCells).toContain(transmuteHistoryViewer.getItemName(hrid));
        }
        expect(firstCells.filter((text) => text.startsWith('Pooled'))).toHaveLength(1);

        // The overall row still reduces over the per-item groups only — pooling
        // must not double-count anything into it
        const overall = bodyRows[bodyRows.length - 1];
        const overallCells = Array.from(overall.querySelectorAll('td')).map((td) => td.textContent);
        expect(overallCells[0]).toBe('All items');
        expect(overallCells[1]).toBe('4');
        expect(overallCells[2]).toBe('40');
    });
});
