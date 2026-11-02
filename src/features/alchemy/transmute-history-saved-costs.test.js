/** @vitest-environment happy-dom */
/**
 * Reading a transmute session whose costs were saved when it ran.
 *
 * `computeSessionProfit` priced the input and catalysts at the market of the
 * moment it was called, so a session's Net moved with the market while its
 * outputs (priced at result time) did not. A session with saved costs reads
 * them back; one without, and the unsaved part of one that has some, is priced
 * at today's market and says so — in its tooltip, and in every group, pooled
 * row and total that holds one.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const STONE_HRID = '/items/philosophers_stone';
const CAPES = ['/items/gatherer_cape_refined', '/items/chance_cape_refined', '/items/culinary_cape_refined'];
const PRIME = '/items/prime_catalyst';

const mocks = vi.hoisted(() => ({ prices: {}, items: {}, capeValue: null, capes: new Set() }));

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

vi.mock('../enhancement/untradable-cape-value.js', () => ({ getUntradableCapeValue: () => mocks.capeValue }));

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
 * @param {string} hrid
 * @returns {Object} A refined-cape-shaped item: mostly self-return, sometimes a stone
 */
function capeItem(hrid) {
    return {
        name: hrid.split('/').pop(),
        sellPrice: 1000,
        itemLevel: 10,
        equipmentDetail: { type: '/equipment_types/back' },
        alchemyDetail: {
            bulkMultiplier: 1,
            transmuteSuccessRate: 0.7,
            transmuteDropTable: [
                { itemHrid: hrid, dropRate: 0.9, minCount: 1, maxCount: 1 },
                { itemHrid: STONE_HRID, dropRate: 0.1, minCount: 1, maxCount: 1 },
            ],
        },
    };
}

/**
 * 10 attempts, 6 self-returns, 1 stone: 4 inputs consumed.
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
        catalystsUsed: { [PRIME]: 7 },
        results: {
            [hrid]: { count: 6, isSelfReturn: true, totalValue: 0 },
            [STONE_HRID]: { count: 1, isSelfReturn: false, totalValue: 500_000_000, priceEach: 500_000_000 },
        },
        ...overrides,
    };
}

/** Costs as the tracker saves them for `capeSession`: 4 inputs at `price`, 7 prime at 1000 */
const saved = (price, basis = 'current buy') => ({
    input: { cost: 4 * price, units: 4, unpricedUnits: 0, bases: { [basis]: 4 } },
    catalysts: { [PRIME]: { cost: 7000, count: 7, unpricedCount: 0 } },
});

function loadSessions(sessions) {
    transmuteHistoryViewer.sessions = sessions;
    transmuteHistoryViewer.filteredSessions = sessions;
    transmuteHistoryViewer.profitCache = new Map();
    for (const session of sessions) {
        transmuteHistoryViewer.profitCache.set(session.id, transmuteHistoryViewer.computeSessionProfit(session));
    }
}

beforeEach(() => {
    mocks.items = {};
    for (const hrid of CAPES) mocks.items[hrid] = capeItem(hrid);
    mocks.prices = { [STONE_HRID]: 500_000_000, [PRIME]: 1000 };
    for (const hrid of CAPES) mocks.prices[hrid] = 100;
    mocks.capeValue = null;
});

describe('a session with saved costs', () => {
    test('Net does not move when the market does', () => {
        const session = capeSession(CAPES[0], { costs: saved(100) });
        const before = transmuteHistoryViewer.computeSessionProfit(session);

        mocks.prices[CAPES[0]] = 5000;
        mocks.prices[PRIME] = 90_000;
        const after = transmuteHistoryViewer.computeSessionProfit(session);

        expect(after.profit).toBe(before.profit);
        expect(after.inputCost).toBe(400);
        expect(after.catalystCost).toBe(7000);
        expect(after.inputAtTodaysPrice).toBe(false);
        expect(after.catalystAtTodaysPrice).toBe(false);
        expect(after.catalystEntries[0]).toMatchObject({ cost: 7000, atTodaysPrice: false });
    });

    test('an old session moves with the market, and says it was priced at today', () => {
        const old = capeSession(CAPES[0]);
        const before = transmuteHistoryViewer.computeSessionProfit(old);
        mocks.prices[CAPES[0]] = 5000;
        const after = transmuteHistoryViewer.computeSessionProfit(old);

        expect(before.inputCost).toBe(400);
        expect(after.inputCost).toBe(20_000);
        expect(after).toMatchObject({ inputAtTodaysPrice: true, catalystAtTodaysPrice: true });
        expect(transmuteHistoryViewer.formatCatalystLine(after)).toContain("today's market");
        expect(transmuteHistoryViewer.buildDataNote(old, after)).toContain("input priced at today's market");
    });

    test('a saved unpriced input stays unpriced when the market has a price later', () => {
        const session = capeSession(CAPES[0], {
            costs: {
                input: { cost: 0, units: 0, unpricedUnits: 4, bases: {} },
                catalysts: saved(0).catalysts,
            },
        });
        mocks.prices[CAPES[0]] = 100;
        const detail = transmuteHistoryViewer.computeSessionProfit(session);
        expect(detail.inputUnpriced).toBe(true);
        expect(detail.inputCost).toBe(0);
        expect(detail.inputAtTodaysPrice).toBe(false);
    });

    test('a refined cape saved under the base-cape rule keeps that cost when the cape value changes', () => {
        const hrid = CAPES[0];
        mocks.prices[hrid] = 0;
        mocks.capeValue = { value: 9_000_000, partial: false };
        const session = capeSession(hrid, { costs: saved(79_000_000, 'untradable-cape value') });

        const detail = transmuteHistoryViewer.computeSessionProfit(session);
        expect(detail.inputCost).toBe(4 * 79_000_000);
        expect(detail.inputBasis).toBe('untradable-cape value');
        expect(detail.inputUnpriced).toBe(false);
    });
});

describe('pooled and total rows holding old and new sessions', () => {
    test('the group counts the sessions priced at today, and the pooled row sums them', () => {
        loadSessions([
            capeSession(CAPES[0], { costs: saved(100) }),
            capeSession(CAPES[1]), // recorded before costs were kept
            capeSession(CAPES[2], { costs: saved(100) }),
        ]);
        mocks.prices[CAPES[0]] = mocks.prices[CAPES[1]] = mocks.prices[CAPES[2]] = 1000;
        transmuteHistoryViewer.profitCache.clear();
        loadSessions(transmuteHistoryViewer.sessions);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const byHrid = Object.fromEntries(totals.map((group) => [group.inputItemHrid, group]));
        expect(byHrid[CAPES[0]]).toMatchObject({ inputCost: 400, todaysPriceSessions: 0 });
        expect(byHrid[CAPES[1]]).toMatchObject({ inputCost: 4000, todaysPriceSessions: 1 });
        expect(byHrid[CAPES[2]]).toMatchObject({ inputCost: 400, todaysPriceSessions: 0 });

        const [pooled] = transmuteHistoryViewer.computePooledTotals(totals);
        expect(pooled.inputCost).toBe(400 + 4000 + 400);
        expect(pooled.todaysPriceSessions).toBe(1);
    });

    test('the rendered Input Cost cells carry the mark and the hover, only where a session was priced at today', () => {
        loadSessions([capeSession(CAPES[0], { costs: saved(100) }), capeSession(CAPES[1])]);
        transmuteHistoryViewer.modal = document.createElement('div');
        transmuteHistoryViewer.modal.innerHTML = '<div class="mwi-transmute-history-totals-container"></div>';
        transmuteHistoryViewer.renderTotals();

        const rows = [...transmuteHistoryViewer.modal.querySelectorAll('tbody tr')];
        const rowFor = (hrid) => rows.find((row) => row.textContent.includes(hrid.split('/').pop()));
        const inputCell = (row) => row.querySelectorAll('td')[6];

        expect(inputCell(rowFor(CAPES[0])).textContent).not.toContain('≈');
        expect(inputCell(rowFor(CAPES[1])).textContent).toContain('≈');
        expect(inputCell(rowFor(CAPES[1])).title).toContain("priced at today's market");

        // The all-items total holds one such session, so it says so too
        const overall = rows.find((row) => row.textContent.includes('All items'));
        expect(inputCell(overall).textContent).toContain('≈');
        expect(inputCell(overall).title).toContain('1 session(s)');
    });

    test('the saved and today units add up to what was consumed: saved, partly saved, or none', () => {
        const savedLine = transmuteHistoryViewer.computeSessionProfit(capeSession(CAPES[0], { costs: saved(100) }));
        const partial = transmuteHistoryViewer.computeSessionProfit(
            capeSession(CAPES[0], {
                costs: { input: { cost: 100, units: 1, unpricedUnits: 0, bases: { 'current buy': 1 } } },
            })
        );
        const none = transmuteHistoryViewer.computeSessionProfit(capeSession(CAPES[0]));
        expect(savedLine.inputSavedUnits).toBe(4);
        expect(partial).toMatchObject({ inputSavedUnits: 1, inputTodayUnits: 3, inputAtTodaysPrice: true });
        expect(none).toMatchObject({ inputSavedUnits: 0, inputTodayUnits: 4, inputAtTodaysPrice: true });
    });
});
