/**
 * Catalyst consumption, recorded from the wire instead of guessed.
 *
 * The viewer used to price a transmute session's catalysts as
 * `predictedCatalystHrid × totalSuccesses` — the catalyst that happened to be
 * in the slot when the run STARTED, times a count nobody observed. Swap the
 * catalyst mid-run and the whole session is costed against the wrong item.
 *
 * `coinify-history-tracker.js` and `decompose-history-tracker.js` already track
 * what was actually spent; this is transmute catching up, with one extra
 * requirement neither of them has: the catalyst stack also appears in
 * `endCharacterItems`, once per action packed into a batched message, so it has
 * to be read through the FOLDED ledger or the count multiplies exactly the way
 * self-returns did.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {} }));
const store = vi.hoisted(() => ({ saved: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getCurrentCharacterId: () => 'char-1',
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({ itemDetailMap: {}, actionDetailMap: {} }),
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => game.prices[hrid] ?? 0,
    getItemPrices: () => null,
    getItemPriceInfo: (hrid) => ({ price: game.prices[hrid] ?? null, source: 'book', estimated: false }),
    getPricingMode: () => 'ask',
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        save: async (scope, sessions) => {
            store.saved.push({ scope, sessions: structuredClone(sessions) });
            return true;
        },
        clear: async () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { transmuteHistoryViewer } = await import('./transmute-history-viewer.js');

const GEM = '/items/gem';
const SHARD = '/items/shard';
const PRIME = '/items/prime_catalyst';
const OTHER_CATALYST = '/items/catalyst_of_transmutation';

beforeEach(() => {
    game.items = {
        [GEM]: {
            name: 'gem',
            itemLevel: 10,
            sellPrice: 50,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteDropTable: [{ itemHrid: SHARD }, { itemHrid: GEM }],
            },
        },
        [SHARD]: { name: 'shard' },
        [PRIME]: { name: 'prime catalyst' },
        [OTHER_CATALYST]: { name: 'catalyst of transmutation' },
    };
    game.prices = { [SHARD]: 700, [PRIME]: 1000, [OTHER_CATALYST]: 400 };
    store.saved.length = 0;
    transmuteHistoryTracker.activeSession = null;
    transmuteHistoryTracker.characterId = 'char-1';
    transmuteHistoryTracker.lastCurrentCount = null;
    transmuteHistoryTracker.itemCounts.reset();
});

/**
 * An `action_completed` for a transmute.
 * @param {Object} options - The message's moving parts
 * @param {number} options.currentCount - The action's running count
 * @param {string} options.catalyst - Catalyst hrid in the secondary slot
 * @param {Array<Object>} options.items - `endCharacterItems` rows, in the order sent
 * @returns {Object} The message
 */
function message({ currentCount, catalyst, items }) {
    return {
        endCharacterAction: {
            actionHrid: '/actions/alchemy/transmute',
            primaryItemHash: `char-1::/item_locations/inventory::${GEM}::0`,
            secondaryItemHash: catalyst ? `char-1::/item_locations/inventory::${catalyst}::0` : null,
            currentCount,
        },
        endCharacterItems: items,
    };
}

/** A catalyst stack row. @param {string} hrid - Item @param {number} count - New total @returns {Object} Row */
const catalystRow = (hrid, count) => ({ id: `stack-${hrid}`, itemHrid: hrid, count });

describe('the tracker records what was actually spent', () => {
    test('a batched message does not multiply the catalyst count', async () => {
        // Baseline: no deltas to read yet, so the successes stand in
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 1,
                catalyst: PRIME,
                items: [
                    { id: 'stack-gem', itemHrid: GEM, count: 99 },
                    { id: 'stack-shard', itemHrid: SHARD, count: 10 },
                    catalystRow(PRIME, 101),
                ],
            })
        );

        // Three actions packed into one message. The game sends the catalyst
        // stack once per action — successive snapshots of ONE stack, not three
        // spends — and the folded ledger reads them as the single -3 they are.
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 4,
                catalyst: PRIME,
                items: [
                    catalystRow(PRIME, 100),
                    { id: 'stack-shard', itemHrid: SHARD, count: 11 },
                    catalystRow(PRIME, 99),
                    { id: 'stack-shard', itemHrid: SHARD, count: 12 },
                    catalystRow(PRIME, 98),
                    { id: 'stack-shard', itemHrid: SHARD, count: 13 },
                ],
            })
        );

        const session = transmuteHistoryTracker.activeSession;
        expect(session.totalSuccesses).toBe(4);
        expect(session.catalystsUsed).toEqual({ [PRIME]: 4 });
    });

    test('a mid-session swap is recorded against both catalysts', async () => {
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 1,
                catalyst: PRIME,
                items: [{ id: 'stack-shard', itemHrid: SHARD, count: 10 }, catalystRow(PRIME, 50)],
            })
        );
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 2,
                catalyst: PRIME,
                items: [{ id: 'stack-shard', itemHrid: SHARD, count: 11 }, catalystRow(PRIME, 49)],
            })
        );
        // Player swaps the slot
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 3,
                catalyst: OTHER_CATALYST,
                items: [{ id: 'stack-shard', itemHrid: SHARD, count: 12 }, catalystRow(OTHER_CATALYST, 20)],
            })
        );
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 4,
                catalyst: OTHER_CATALYST,
                items: [{ id: 'stack-shard', itemHrid: SHARD, count: 13 }, catalystRow(OTHER_CATALYST, 19)],
            })
        );

        expect(transmuteHistoryTracker.activeSession.catalystsUsed).toEqual({
            [PRIME]: 2,
            [OTHER_CATALYST]: 2,
        });
    });

    test('a catalyst stack that moved for some other reason falls back to the successes', async () => {
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 1,
                catalyst: PRIME,
                items: [{ id: 'stack-shard', itemHrid: SHARD, count: 10 }, catalystRow(PRIME, 50)],
            })
        );
        // The player bought catalysts mid-run: the stack went UP, which says
        // nothing about what this action spent
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 2,
                catalyst: PRIME,
                items: [{ id: 'stack-shard', itemHrid: SHARD, count: 11 }, catalystRow(PRIME, 500)],
            })
        );

        expect(transmuteHistoryTracker.activeSession.catalystsUsed).toEqual({ [PRIME]: 2 });
    });

    test('a failed attempt with no catalyst in the slot records nothing', async () => {
        await transmuteHistoryTracker.handleActionCompleted(
            message({
                currentCount: 1,
                catalyst: null,
                items: [{ id: 'stack-gem', itemHrid: GEM, count: 99 }],
            })
        );

        expect(transmuteHistoryTracker.activeSession.catalystsUsed).toEqual({});
    });
});

describe('the viewer prefers the recorded count and labels the estimate', () => {
    /**
     * @param {Object} [overrides] - Session fields
     * @returns {Object} A stored session
     */
    const session = (overrides = {}) => ({
        id: 'transmute_1',
        startTime: 1,
        inputItemHrid: GEM,
        totalAttempts: 100,
        totalSuccesses: 80,
        bulkMultiplier: 1,
        results: { [SHARD]: { count: 80, totalValue: 56000, priceEach: 700 } },
        ...overrides,
    });

    test('a recorded count wins over the catalyst predicted at session start', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(
            session({ predictedCatalystHrid: OTHER_CATALYST, catalystsUsed: { [PRIME]: 10 } })
        );

        expect(detail.catalystEstimated).toBe(false);
        expect(detail.catalystHrid).toBe(PRIME);
        expect(detail.catalystCost).toBe(10 * 1000);
        // Not 80 successes x the predicted catalyst's price
        expect(detail.catalystCost).not.toBe(80 * 400);
    });

    test('a swapped session is costed against both catalysts', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(
            session({ catalystsUsed: { [PRIME]: 30, [OTHER_CATALYST]: 50 } })
        );

        expect(detail.catalystEntries).toHaveLength(2);
        expect(detail.catalystCost).toBe(30 * 1000 + 50 * 400);
        expect(detail.catalystHrid).toBeNull();
        expect(transmuteHistoryViewer.formatCatalystLine(detail)).toContain('(recorded)');
    });

    test('an older session still falls back to the prediction, and says it is an estimate', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session({ predictedCatalystHrid: PRIME }));

        expect(detail.catalystEstimated).toBe(true);
        expect(detail.catalystCost).toBe(80 * 1000);
        expect(transmuteHistoryViewer.formatCatalystLine(detail)).toContain('estimated');
    });

    test('a session that predates catalyst tracking entirely is unrecorded, not free', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session());

        expect(detail.catalystUnrecorded).toBe(true);
        expect(detail.catalystCost).toBe(0);
        expect(transmuteHistoryViewer.formatCatalystLine(detail)).toContain('not recorded');
    });

    test('a recorded session that spent no catalysts used none — it is not a gap in the data', () => {
        const detail = transmuteHistoryViewer.computeSessionProfit(session({ catalystsUsed: {} }));

        expect(detail.catalystUnrecorded).toBe(false);
        expect(transmuteHistoryViewer.formatCatalystLine(detail)).toBe('Catalyst: none');
    });

    test('an unpriced catalyst is excluded rather than counted as free', () => {
        game.prices[PRIME] = 0;
        const detail = transmuteHistoryViewer.computeSessionProfit(session({ catalystsUsed: { [PRIME]: 10 } }));

        expect(detail.catalystUnpriced).toBe(true);
        expect(detail.catalystCost).toBe(0);
    });
});
