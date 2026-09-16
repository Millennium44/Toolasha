/** @vitest-environment happy-dom */
/**
 * "Totals by Input Item" — the transmute history viewer groups filtered
 * sessions by input item and totals attempts, consumption, revenue, cost and
 * a break-even catalyst figure.
 *
 * Two honesty rules are load-bearing here (both learned the hard way
 * elsewhere in this file — see transmute-history-refined-input.test.js):
 *   - a session with no recorded `predictedCatalystHrid` must show as
 *     "unrecorded" catalyst cost, never as a silent zero
 *   - a group whose recorded counts are internally impossible (more result
 *     entries than successes — the self-return batching bug) must be flagged,
 *     not averaged in as if it were good data
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const INPUT_A_HRID = '/items/soul_stone';
const INPUT_B_HRID = '/items/cursed_essence';
const CATALYST_HRID = '/items/prime_catalyst';
const OUTPUT_HRID = '/items/enchanted_gem';

const mocks = vi.hoisted(() => ({ prices: {} }));

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
        getItemDetails: (itemHrid) => ({
            name: itemHrid.split('/').pop(),
            sellPrice: 1000,
            alchemyDetail: { bulkMultiplier: 1 },
        }),
        getInitClientData: () => ({
            itemDetailMap: {},
            actionDetailMap: {},
        }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));

const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

/**
 * Load sessions directly into the viewer's filtered set + profit cache,
 * bypassing the DOM/tracker plumbing that `openModal` drives — the totals
 * logic under test only reads `filteredSessions` and `profitCache`.
 */
function loadSessions(sessions) {
    transmuteHistoryViewer.sessions = sessions;
    transmuteHistoryViewer.filteredSessions = sessions;
    transmuteHistoryViewer.profitCache = new Map();
    for (const session of sessions) {
        transmuteHistoryViewer.profitCache.set(session.id, transmuteHistoryViewer.computeSessionProfit(session));
    }
}

function makeSession(overrides) {
    return {
        id: 's1',
        inputItemHrid: INPUT_A_HRID,
        bulkMultiplier: 1,
        totalAttempts: 10,
        totalSuccesses: 8,
        predictedCatalystHrid: null,
        results: {
            [OUTPUT_HRID]: { count: 8, isSelfReturn: false, totalValue: 8000, priceEach: 1000 },
        },
        ...overrides,
    };
}

describe('transmute history totals: grouping by input item', () => {
    beforeEach(() => {
        mocks.prices = { [INPUT_A_HRID]: 100, [INPUT_B_HRID]: 200, [CATALYST_HRID]: 50 };
    });

    test('sums two sessions of the same input item into one group', () => {
        loadSessions([
            makeSession({ id: 's1', totalAttempts: 10, totalSuccesses: 8 }),
            makeSession({ id: 's2', totalAttempts: 5, totalSuccesses: 4 }),
        ]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();

        expect(totals).toHaveLength(1);
        const group = totals[0];
        expect(group.inputItemHrid).toBe(INPUT_A_HRID);
        expect(group.sessionCount).toBe(2);
        expect(group.attempts).toBe(15);
        expect(group.successes).toBe(12);
        // netConsumed per session: attempts*bulk - selfReturned(0) = attempts
        expect(group.netConsumed).toBe(15);
    });

    test('keeps different input items in separate groups', () => {
        loadSessions([
            makeSession({ id: 's1', inputItemHrid: INPUT_A_HRID }),
            makeSession({ id: 's2', inputItemHrid: INPUT_B_HRID }),
        ]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();

        expect(totals).toHaveLength(2);
        expect(totals.map((g) => g.inputItemHrid).sort()).toEqual([INPUT_A_HRID, INPUT_B_HRID].sort());
    });
});

describe('transmute history totals: catalyst cost', () => {
    beforeEach(() => {
        mocks.prices = { [INPUT_A_HRID]: 100, [CATALYST_HRID]: 50 };
    });

    test('costs a recorded catalyst as successes × current price', () => {
        loadSessions([makeSession({ id: 's1', totalSuccesses: 8, predictedCatalystHrid: CATALYST_HRID })]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        expect(group.catalystRecordedSessions).toBe(1);
        expect(group.catalystCost).toBe(8 * 50);
        const [text] = transmuteHistoryViewer.formatCatalystTotal(group);
        expect(text).not.toBe('0');
        expect(text).not.toMatch(/^0(\.0)?$/);
    });

    test('a session with no recorded catalyst hrid is "unrecorded", never a silent zero', () => {
        loadSessions([makeSession({ id: 's1', totalSuccesses: 8, predictedCatalystHrid: null })]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        expect(group.catalystRecordedSessions).toBe(0);
        expect(group.catalystUnrecordedSessions).toBe(1);
        expect(group.catalystCost).toBe(0);

        const [text, title] = transmuteHistoryViewer.formatCatalystTotal(group);
        expect(text).toBe('unrecorded');
        expect(text).not.toBe('0');
        expect(title).toMatch(/predate catalyst tracking/);
    });

    test('mixing a recorded and an unrecorded session marks the total incomplete, not short', () => {
        loadSessions([
            makeSession({ id: 's1', totalSuccesses: 8, predictedCatalystHrid: CATALYST_HRID }),
            makeSession({ id: 's2', totalSuccesses: 4, predictedCatalystHrid: null }),
        ]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        // Only the recorded session's successes are costed — the unrecorded
        // one is excluded from the number, not counted as free.
        expect(group.catalystCost).toBe(8 * 50);
        expect(group.catalystUnrecordedSessions).toBe(1);

        const [text, title] = transmuteHistoryViewer.formatCatalystTotal(group);
        expect(text).toContain('‡'); // marks the total as incomplete
        expect(title).toMatch(/have no recorded catalyst/);
    });

    test('a catalyst the market cannot price is excluded from the sum, not treated as free', () => {
        delete mocks.prices[CATALYST_HRID];
        loadSessions([makeSession({ id: 's1', totalSuccesses: 8, predictedCatalystHrid: CATALYST_HRID })]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        expect(group.catalystUnpricedSessions).toBe(1);
        expect(group.catalystCost).toBe(0);
        const [text] = transmuteHistoryViewer.formatCatalystTotal(group);
        expect(text).toContain('†');
    });
});

describe('transmute history totals: impossible-session flag', () => {
    beforeEach(() => {
        mocks.prices = { [INPUT_A_HRID]: 100 };
    });

    test('flags a group whose recorded result count exceeds its successes', () => {
        // The self-return batching bug: 103 self-returns against 75 attempts / 64 successes
        loadSessions([
            makeSession({
                id: 'corrupt',
                totalAttempts: 75,
                totalSuccesses: 64,
                results: {
                    [INPUT_A_HRID]: { count: 103, isSelfReturn: true, totalValue: 0 },
                },
            }),
        ]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        expect(group.impossible).toBe(true);
    });

    test('a normal session (results within successes) is not flagged', () => {
        loadSessions([makeSession({ id: 's1', totalAttempts: 10, totalSuccesses: 8 })]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        expect(group.impossible).toBe(false);
    });

    test('one corrupt session taints the whole group even alongside a clean one', () => {
        loadSessions([
            makeSession({ id: 'clean', totalAttempts: 10, totalSuccesses: 8 }),
            makeSession({
                id: 'corrupt',
                totalAttempts: 75,
                totalSuccesses: 64,
                results: { [INPUT_A_HRID]: { count: 103, isSelfReturn: true, totalValue: 0 } },
            }),
        ]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        expect(group.impossible).toBe(true);
    });
});

describe('transmute history totals: break-even input value', () => {
    beforeEach(() => {
        mocks.prices = { [INPUT_A_HRID]: 100, [CATALYST_HRID]: 50 };
    });

    test('is (revenue − catalystCost − coinCost) / netConsumed', () => {
        loadSessions([
            makeSession({
                id: 's1',
                totalAttempts: 10,
                totalSuccesses: 8,
                predictedCatalystHrid: CATALYST_HRID,
                results: {
                    [OUTPUT_HRID]: { count: 8, isSelfReturn: false, totalValue: 8000, priceEach: 1000 },
                },
            }),
        ]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        const expected = (group.revenue - group.catalystCost - group.coinCost) / group.netConsumed;
        expect(group.breakEvenInputValue).toBeCloseTo(expected, 6);
        // Sanity: with revenue well above catalyst+coin cost, break-even should
        // be a small positive number relative to what the recorded input sells for
        expect(group.breakEvenInputValue).toBeGreaterThan(0);
    });

    test('is null when nothing was actually consumed (cannot divide by zero silently)', () => {
        loadSessions([
            makeSession({
                id: 's1',
                totalAttempts: 5,
                totalSuccesses: 0,
                results: {
                    [INPUT_A_HRID]: { count: 5, isSelfReturn: true, totalValue: 0 },
                },
            }),
        ]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();

        expect(group.netConsumed).toBe(0);
        expect(group.breakEvenInputValue).toBeNull();
    });

    test('is suppressed (—) for an impossible group even though the arithmetic would not throw', () => {
        loadSessions([
            makeSession({
                id: 'corrupt',
                totalAttempts: 75,
                totalSuccesses: 64,
                results: { [INPUT_A_HRID]: { count: 103, isSelfReturn: true, totalValue: 0 } },
            }),
        ]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();
        const row = transmuteHistoryViewer.buildTotalsRow(group, 0);
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);

        expect(group.impossible).toBe(true);
        // Last cell is the break-even column; corrupted groups must not present
        // a computed figure as fact
        expect(cells[cells.length - 1]).toBe('—');
    });
});

// Cell order from buildTotalsRow/buildOverallTotalsRow: Input Item, Sessions,
// Attempts, Consumed, Successes, Revenue, Input Cost, Catalyst Cost, Coin
// Cost, Net, Inputs/Output, Break-even Input.
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

function corruptSession(overrides) {
    return makeSession({
        id: 'corrupt',
        totalAttempts: 75,
        totalSuccesses: 64,
        results: { [INPUT_A_HRID]: { count: 103, isSelfReturn: true, totalValue: 0 } },
        ...overrides,
    });
}

describe('transmute history totals: a flagged group suppresses every netConsumed-derived column', () => {
    beforeEach(() => {
        mocks.prices = { [INPUT_A_HRID]: 100 };
    });

    test('per-item row hides Consumed, Successes, Input Cost, Net, Inputs/Output and Break-even together', () => {
        loadSessions([corruptSession()]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();
        const row = transmuteHistoryViewer.buildTotalsRow(group, 0);
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);

        expect(group.impossible).toBe(true);
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
    });

    test('per-item row still shows Sessions, Attempts, Revenue and Coin Cost — those do not depend on consumed count', () => {
        loadSessions([corruptSession()]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();
        const row = transmuteHistoryViewer.buildTotalsRow(group, 0);
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);

        expect(cells[COL.SESSIONS]).toBe('1');
        expect(cells[COL.ATTEMPTS]).toBe('75');
        expect(cells[COL.REVENUE]).not.toBe('—');
        expect(cells[COL.COIN_COST]).not.toBe('—');
    });

    test('a clean group is unaffected: every figure is shown', () => {
        loadSessions([makeSession({ id: 'clean', totalAttempts: 10, totalSuccesses: 8 })]);

        const [group] = transmuteHistoryViewer.computeInputItemTotals();
        const row = transmuteHistoryViewer.buildTotalsRow(group, 0);
        const cells = Array.from(row.querySelectorAll('td')).map((td) => td.textContent);

        expect(group.impossible).toBe(false);
        for (const col of [COL.CONSUMED, COL.SUCCESSES, COL.INPUT_COST, COL.NET, COL.INPUTS_PER_OUTPUT]) {
            expect(cells[col]).not.toBe('—');
        }
    });
});

describe('transmute history totals: a flagged group poisons the overall "All items" row', () => {
    beforeEach(() => {
        mocks.prices = { [INPUT_A_HRID]: 100, [INPUT_B_HRID]: 200 };
    });

    test('one flagged group among clean ones marks and suppresses the overall row', () => {
        loadSessions([
            makeSession({ id: 'clean', inputItemHrid: INPUT_A_HRID, totalAttempts: 10, totalSuccesses: 8 }),
            corruptSession({ inputItemHrid: INPUT_B_HRID }),
        ]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const overallRow = transmuteHistoryViewer.buildOverallTotalsRow(totals);
        const cells = Array.from(overallRow.querySelectorAll('td')).map((td) => td.textContent);

        expect(totals.some((g) => g.impossible)).toBe(true);
        expect(cells[COL.ITEM]).toContain('⚠');
        for (const col of [COL.CONSUMED, COL.SUCCESSES, COL.INPUT_COST, COL.NET]) {
            expect(cells[col]).toBe('—');
        }
        // Still true regardless of the flagged group, and must keep showing
        expect(cells[COL.SESSIONS]).toBe('2');
        expect(cells[COL.ATTEMPTS]).toBe('85');
        expect(cells[COL.REVENUE]).not.toBe('—');
    });

    test('all-clean groups leave the overall row unmarked and every figure shown', () => {
        loadSessions([
            makeSession({ id: 's1', inputItemHrid: INPUT_A_HRID, totalAttempts: 10, totalSuccesses: 8 }),
            makeSession({
                id: 's2',
                inputItemHrid: INPUT_B_HRID,
                totalAttempts: 5,
                totalSuccesses: 4,
                results: {
                    [OUTPUT_HRID]: { count: 4, isSelfReturn: false, totalValue: 4000, priceEach: 1000 },
                },
            }),
        ]);

        const totals = transmuteHistoryViewer.computeInputItemTotals();
        const overallRow = transmuteHistoryViewer.buildOverallTotalsRow(totals);
        const cells = Array.from(overallRow.querySelectorAll('td')).map((td) => td.textContent);

        expect(cells[COL.ITEM]).not.toContain('⚠');
        expect(cells[COL.ITEM]).toBe('All items');
        for (const col of [COL.CONSUMED, COL.SUCCESSES, COL.INPUT_COST, COL.NET]) {
            expect(cells[col]).not.toBe('—');
        }
    });
});
