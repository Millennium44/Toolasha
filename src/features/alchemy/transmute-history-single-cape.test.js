/**
 * A transmute run begun with a single refined cape.
 *
 * Reported from a live session: one Gatherer Cape ★, three attempts. The first
 * two succeeded and handed the cape back, the third failed and consumed it. The
 * game's loot log said 3 attempts and 2 capes gained; the history said 1 success,
 * 2 failures, one cape returned, and costed two capes consumed.
 *
 * The first message of a session had no baseline for the input stack, so its
 * self-return could not be told from plain consumption and was not counted. A
 * session started from the queue now seeds the ledger from the inventory it
 * held before any action completed.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {}, inventory: null, actions: [] }));

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
        getCurrentActions: () => game.actions,
        get characterItems() {
            return game.inventory;
        },
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in game.prices ? game.prices[hrid] : null),
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

const CAPE = '/items/gatherer_cape_refined';
const STONE = '/items/philosophers_stone';
const COIN = '/items/coin';
const INVENTORY = '/item_locations/inventory';
const HASH = `char-1::${INVENTORY}::${CAPE}::0`;
const FEE = 20_000;

/**
 * An inventory row as the game sends it.
 * @param {number} id - Stack id
 * @param {string} itemHrid - Item hrid
 * @param {number} count - The stack's absolute total
 * @returns {Object} The row
 */
function stack(id, itemHrid, count) {
    return { id, characterID: 1, itemLocationHrid: INVENTORY, itemHrid, enhancementLevel: 0, count };
}

/**
 * Deliver a transmute action_completed the way the page sees it: dataManager
 * has already written the rows into its inventory when the tracker reads them.
 * @param {number} currentCount - The action's running count
 * @param {Array<Object>} rows - `endCharacterItems`
 * @returns {Promise<void>}
 */
async function complete(currentCount, rows) {
    for (const row of rows) {
        const index = game.inventory.findIndex((held) => held.id === row.id);
        if (index === -1) game.inventory.push({ ...row });
        else game.inventory[index].count = row.count;
    }
    await transmuteHistoryTracker.handleActionCompleted({
        type: 'action_completed',
        endCharacterAction: {
            id: 501,
            actionHrid: '/actions/alchemy/transmute',
            primaryItemHash: HASH,
            secondaryItemHash: '',
            currentCount,
            maxCount: 0,
            isDone: false,
            ordinal: 1,
        },
        endCharacterItems: rows,
    });
}

/** The player starts the transmute: the queue changes before any action completes. */
async function startFromQueue() {
    game.actions = [
        {
            id: 501,
            actionHrid: '/actions/alchemy/transmute',
            primaryItemHash: HASH,
            currentCount: 0,
            isDone: false,
            ordinal: 1,
        },
    ];
    await transmuteHistoryTracker.handleActionsUpdated();
}

beforeEach(() => {
    game.items = {
        [CAPE]: {
            name: 'Gatherer Cape ★',
            itemLevel: 1,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteDropTable: [{ itemHrid: CAPE }, { itemHrid: STONE }],
            },
        },
    };
    game.prices = { [STONE]: 540_000_000 };
    game.inventory = [stack(7001, CAPE, 1), stack(9001, COIN, 50_000_000)];
    game.actions = [];
    transmuteHistoryTracker.activeSession = null;
    transmuteHistoryTracker.characterId = 'char-1';
});

/** @returns {Object} What the viewer's profit reads off the session */
function recorded() {
    const session = transmuteHistoryTracker.activeSession;
    const selfReturned = session.results[CAPE]?.count ?? 0;
    return {
        attempts: session.totalAttempts,
        successes: session.totalSuccesses,
        selfReturned,
        isSelfReturn: session.results[CAPE]?.isSelfReturn,
        netConsumed: Math.max(0, session.totalAttempts * session.bulkMultiplier - selfReturned),
    };
}

const TRUTH = { attempts: 3, successes: 2, selfReturned: 2, isSelfReturn: true, netConsumed: 1 };

describe('transmute: a run begun with one refined cape', () => {
    test('self-return, self-return, failure — the stack is snapshotted on the way down and back', async () => {
        await startFromQueue();

        await complete(1, [stack(9001, COIN, 50_000_000 - FEE), stack(7001, CAPE, 0), stack(7001, CAPE, 1)]);
        await complete(2, [stack(9001, COIN, 50_000_000 - 2 * FEE), stack(7001, CAPE, 0), stack(7001, CAPE, 1)]);
        await complete(3, [stack(9001, COIN, 50_000_000 - 3 * FEE), stack(7001, CAPE, 0)]);

        expect(recorded()).toEqual(TRUTH);
    });

    test('the same run when an unmoved cape stack is left out of the message', async () => {
        await startFromQueue();

        await complete(1, [stack(9001, COIN, 50_000_000 - FEE)]);
        await complete(2, [stack(9001, COIN, 50_000_000 - 2 * FEE)]);
        await complete(3, [stack(9001, COIN, 50_000_000 - 3 * FEE), stack(7001, CAPE, 0)]);

        expect(recorded()).toEqual(TRUTH);
    });

    test('the same run when an emptied stack comes back under a new id', async () => {
        await startFromQueue();

        await complete(1, [stack(9001, COIN, 50_000_000 - FEE), stack(7001, CAPE, 0), stack(7002, CAPE, 1)]);
        await complete(2, [stack(9001, COIN, 50_000_000 - 2 * FEE), stack(7002, CAPE, 0), stack(7003, CAPE, 1)]);
        await complete(3, [stack(9001, COIN, 50_000_000 - 3 * FEE), stack(7003, CAPE, 0)]);

        expect(recorded()).toEqual(TRUTH);
    });

    test('a first message covering a batch counts every attempt in it', async () => {
        game.inventory = [stack(7001, CAPE, 5), stack(9001, COIN, 50_000_000)];
        await startFromQueue();

        // Three attempts in one message: two self-returns and a failure, so
        // the stack fell by one
        await complete(3, [stack(9001, COIN, 50_000_000 - 3 * FEE), stack(7001, CAPE, 4)]);

        expect(recorded()).toEqual({ ...TRUTH, attempts: 3 });
    });

    test('a stone first seen after the queue seed is counted from zero', async () => {
        game.inventory = [stack(7001, CAPE, 5), stack(9001, COIN, 50_000_000)];
        await startFromQueue();

        await complete(2, [stack(9001, COIN, 50_000_000 - 2 * FEE), stack(7001, CAPE, 3), stack(8001, STONE, 2)]);

        const session = transmuteHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(2);
        expect(session.totalSuccesses).toBe(2);
        expect(session.results[STONE].count).toBe(2);
        expect(session.results[CAPE]).toBeUndefined();
    });

    test('a session first seen through action_completed still reads its first message conservatively', async () => {
        // No queue update, so the inventory already carries this message's
        // rows and cannot serve as a baseline
        await complete(1, [stack(9001, COIN, 50_000_000 - FEE), stack(7001, CAPE, 0), stack(7001, CAPE, 1)]);
        await complete(2, [stack(9001, COIN, 50_000_000 - 2 * FEE), stack(7001, CAPE, 0), stack(7001, CAPE, 1)]);

        const session = transmuteHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(2);
        expect(session.totalSuccesses).toBe(1);
    });
});
