/**
 * One message, several snapshots of the same stack.
 *
 * Captured live while transmuting a refined cape (bulk 1, one item per
 * success, 90% self-return / 10% stone): a single `action_completed` whose
 * `currentCount` advanced by three carried three rows for the input stack,
 * counts ascending — 936, 937, 938. They are successive snapshots of the one
 * stack as the batched actions played out, not three stacks and not three
 * gains, and only the last of them is the total the stack ended on.
 *
 * Read as separate rows, the tracker applied its self-return arithmetic
 * (`delta + attempts`) once per snapshot and recorded roughly 1.6x as many
 * self-returns as there were successes. That is not merely a wrong number on
 * screen: the viewer's input cost is `attempts * bulk - selfReturned`, which
 * such a session clamps to zero, so the whole input side of the profit
 * silently disappears.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {} }));

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
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => game.prices[hrid] ?? 0,
    getItemPrices: () => null,
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => [],
        save: async () => {},
        clear: async () => {},
        setCharacter: () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { createItemCountLedger, foldStackRows } = await import('./alchemy-item-deltas.js');

const CAPE = '/items/gatherer_cape_refined';
const STONE = '/items/philosophers_stone';

beforeEach(() => {
    game.items = {
        [CAPE]: {
            itemLevel: 10,
            sellPrice: 1000,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteDropTable: [{ itemHrid: CAPE }, { itemHrid: STONE }],
            },
        },
    };
    game.prices = { [STONE]: 540_000_000 };
    transmuteHistoryTracker.activeSession = null;
    transmuteHistoryTracker.characterId = 'char-1';
});

/**
 * A transmute `action_completed`.
 * @param {number} currentCount - The action's running count
 * @param {Array<number>} capeCounts - Successive totals of the input stack
 * @param {number|null} stoneCount - The stone stack's new total, if it moved
 * @returns {Object} The message
 */
function message(currentCount, capeCounts, stoneCount = null) {
    const rows = capeCounts.map((count) => ({ id: 'cape-stack', itemHrid: CAPE, count }));
    if (stoneCount !== null) rows.push({ id: 'stone-stack', itemHrid: STONE, count: stoneCount });
    return {
        endCharacterAction: {
            actionHrid: '/actions/alchemy/transmute',
            primaryItemHash: `char-1::/item_locations/inventory::${CAPE}::0`,
            currentCount,
        },
        endCharacterItems: rows,
    };
}

/** The exact sequence captured on the test server */
const CAPTURED = [
    [153, [939, 940], null],
    [155, [938], 1],
    [157, [936, 937, 938], null],
    [159, [936, 937], null],
    [161, [935, 936], null],
    [164, [933, 934, 935], null],
    [166, [933, 934], null],
    [168, [932, 933, 934], null],
];

describe('folding a message down to one row per stack', () => {
    test('successive snapshots of one stack collapse to the last of them', () => {
        expect(
            foldStackRows([
                { id: 'a', count: 936 },
                { id: 'a', count: 937 },
                { id: 'a', count: 938 },
            ])
        ).toEqual([{ id: 'a', count: 938 }]);
    });

    test('two genuinely different stacks are left alone', () => {
        const folded = foldStackRows([
            { id: 'a', itemHrid: '/items/gem', count: 5 },
            { id: 'b', itemHrid: '/items/gem', count: 9 },
        ]);
        expect(folded).toHaveLength(2);
    });

    test('the ledger measures one delta per stack, not one per snapshot', () => {
        const ledger = createItemCountLedger();
        ledger.noteEach([{ id: 'a', count: 940 }]);

        const seen = ledger.noteEach([
            { id: 'a', count: 936 },
            { id: 'a', count: 937 },
            { id: 'a', count: 938 },
        ]);

        expect(seen).toHaveLength(1);
        expect(seen[0].delta).toBe(-2);
    });
});

describe('transmute: the captured self-return sequence', () => {
    test('self-returns stay within the successes that produced them', async () => {
        await transmuteHistoryTracker.startSession(CAPE, 1000);

        for (const [currentCount, capeCounts, stoneCount] of CAPTURED) {
            await transmuteHistoryTracker.handleActionCompleted(message(currentCount, capeCounts, stoneCount));
        }

        const session = transmuteHistoryTracker.activeSession;
        const produced = Object.values(session.results).reduce((sum, result) => sum + result.count, 0);

        // The invariant the bug broke: one action produces one output, so the
        // outputs recorded cannot outnumber the successes, which cannot
        // outnumber the attempts
        expect(produced).toBeLessThanOrEqual(session.totalSuccesses);
        expect(session.totalSuccesses).toBeLessThanOrEqual(session.totalAttempts);

        // The exact reading of that capture
        expect(session.totalAttempts).toBe(16);
        expect(session.totalSuccesses).toBe(10);
        expect(session.results[CAPE].count).toBe(9);
        expect(session.results[CAPE].isSelfReturn).toBe(true);
        expect(session.results[STONE].count).toBe(1);
    });

    test('the input is costed at all, rather than clamping to nothing consumed', async () => {
        await transmuteHistoryTracker.startSession(CAPE, 1000);

        for (const [currentCount, capeCounts, stoneCount] of CAPTURED) {
            await transmuteHistoryTracker.handleActionCompleted(message(currentCount, capeCounts, stoneCount));
        }

        const session = transmuteHistoryTracker.activeSession;
        // The viewer's formula, kept here rather than imported so this test
        // stays about what the tracker recorded
        const netConsumed = Math.max(0, session.totalAttempts * session.bulkMultiplier - session.results[CAPE].count);

        expect(netConsumed).toBeGreaterThan(0);
    });

    test('a batch that both returns the input and drops a stone still scores at most its attempts', async () => {
        await transmuteHistoryTracker.startSession(CAPE, 1000);

        // A baseline for the input stack first
        await transmuteHistoryTracker.handleActionCompleted(message(1, [100]));

        // Two attempts: the input stack did not move (both returned) and a
        // stone landed. Taken at face value that is three outputs from two
        // attempts, and one of the three has to go.
        await transmuteHistoryTracker.handleActionCompleted(message(3, [100], 1));

        const session = transmuteHistoryTracker.activeSession;
        const produced = Object.values(session.results).reduce((sum, result) => sum + result.count, 0);

        expect(session.totalSuccesses).toBe(2);
        expect(produced).toBe(2);
        // The stone is a measured gain; the self-return is the inferred one,
        // so the trim comes off the self-return
        expect(session.results[STONE].count).toBe(1);
        expect(session.results[CAPE].count).toBe(1);
    });
});
