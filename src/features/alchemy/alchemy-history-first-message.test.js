/**
 * The first message of a coinify or decompose run.
 *
 * The game packs efficiency repeats into one `action_completed` — measured live,
 * a run's first messages advanced `currentCount` 3, 6, 9 — and a session that
 * starts with an empty ledger and no attempt baseline could read that first
 * message only as one attempt and at most one success: the coins, the outputs
 * and the catalysts of the rest of the batch were never recorded.
 *
 * A session started from the queue (`actions_updated`, which arrives between
 * messages) now seeds the ledger from the cached inventory and takes the queued
 * action's `currentCount` as the attempt baseline, as transmute already does.
 *
 * Every message here is delivered the way the page sees it: dataManager has
 * already written its rows into the inventory when the tracker reads them.
 * Item counts and yields are fixture values; the row shapes are the game's.
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

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');

const INVENTORY = '/item_locations/inventory';
const COIN = '/items/coin';
const DONUT = '/items/mooberry_donut';
const COOKING_ESSENCE = '/items/cooking_essence';
const SCROLL = '/items/scroll_of_wisdom';
const TOKEN = '/items/labyrinth_token';
const COINIFY_CATALYST = '/items/catalyst_of_coinification';
const DECOMPOSE_CATALYST = '/items/catalyst_of_decomposition';
const PRIME = '/items/prime_catalyst';

/** Coins per coinify success: sellPrice 100 x 5 x bulk 1 */
const COINS_PER_SUCCESS = 500;

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
 * @param {string|null} hrid - Item hrid
 * @returns {string} The item hash the game puts in an action's item slots
 */
function hash(hrid) {
    return hrid ? `char-1::${INVENTORY}::${hrid}::0` : '';
}

/**
 * The player queues the action: the queue changes before any action completes.
 * @param {Object} tracker - The tracker under test
 * @param {string} actionHrid - The alchemy action
 * @param {string} inputHrid - Item in the primary slot
 * @param {string|null} catalystHrid - Item in the secondary slot
 * @param {number} [currentCount] - The action's count when the queue changed
 * @returns {Promise<void>}
 */
async function startFromQueue(tracker, actionHrid, inputHrid, catalystHrid, currentCount = 0) {
    game.actions = [
        {
            id: 501,
            actionHrid,
            primaryItemHash: hash(inputHrid),
            secondaryItemHash: hash(catalystHrid),
            currentCount,
            isDone: false,
            ordinal: 1,
        },
    ];
    await tracker.handleActionsUpdated();
}

/**
 * Deliver an action_completed after dataManager has absorbed its rows.
 * @param {Object} tracker - The tracker under test
 * @param {string} actionHrid - The alchemy action
 * @param {string} inputHrid - Item in the primary slot
 * @param {string|null} catalystHrid - Item in the secondary slot
 * @param {number} currentCount - The action's running count
 * @param {Array<Object>} rows - `endCharacterItems`
 * @returns {Promise<void>}
 */
async function complete(tracker, actionHrid, inputHrid, catalystHrid, currentCount, rows) {
    for (const row of rows) {
        const index = game.inventory.findIndex((held) => held.id === row.id);
        if (index === -1) game.inventory.push({ ...row });
        else game.inventory[index].count = row.count;
    }
    await tracker.handleActionCompleted({
        type: 'action_completed',
        endCharacterAction: {
            id: 501,
            actionHrid,
            primaryItemHash: hash(inputHrid),
            secondaryItemHash: hash(catalystHrid),
            currentCount,
            maxCount: 0,
            isDone: false,
            ordinal: 1,
        },
        endCharacterItems: rows,
    });
}

beforeEach(() => {
    game.items = {
        [DONUT]: {
            name: 'Mooberry Donut',
            itemLevel: 20,
            sellPrice: 100,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: COOKING_ESSENCE, count: 3 }] },
        },
        [SCROLL]: {
            name: 'Scroll of Wisdom',
            itemLevel: 1,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: TOKEN, count: 5 }] },
        },
    };
    game.prices = { [COOKING_ESSENCE]: 40, [TOKEN]: 0 };
    game.actions = [];
    coinifyHistoryTracker.activeSession = null;
    coinifyHistoryTracker.characterId = 'char-1';
    decomposeHistoryTracker.activeSession = null;
    decomposeHistoryTracker.characterId = 'char-1';
});

describe('coinify: the first message of a run', () => {
    const coinify = (count, rows) =>
        complete(coinifyHistoryTracker, '/actions/alchemy/coinify', DONUT, COINIFY_CATALYST, count, rows);

    beforeEach(() => {
        game.inventory = [stack(1001, DONUT, 100), stack(9001, COIN, 1_000_000), stack(6001, COINIFY_CATALYST, 50)];
    });

    test('a batch of three successes records three attempts, three successes and their coins', async () => {
        await startFromQueue(coinifyHistoryTracker, '/actions/alchemy/coinify', DONUT, COINIFY_CATALYST);

        await coinify(3, [
            stack(1001, DONUT, 97),
            stack(9001, COIN, 1_000_000 + 3 * COINS_PER_SUCCESS),
            stack(6001, COINIFY_CATALYST, 47),
        ]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(3);
        expect(session.totalSuccesses).toBe(3);
        expect(session.totalCoinsEarned).toBe(3 * COINS_PER_SUCCESS);
        expect(session.catalystOfCoinificationUsed).toBe(3);
        expect(session.catalystsUsed[COINIFY_CATALYST]).toBe(3);
    });

    test('two successes and a failure in the first batch, then a single failure', async () => {
        await startFromQueue(coinifyHistoryTracker, '/actions/alchemy/coinify', DONUT, COINIFY_CATALYST);

        await coinify(3, [
            stack(1001, DONUT, 97),
            stack(9001, COIN, 1_000_000 + 2 * COINS_PER_SUCCESS),
            stack(6001, COINIFY_CATALYST, 48),
        ]);
        await coinify(4, [stack(1001, DONUT, 96)]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(4);
        expect(session.totalSuccesses).toBe(2);
        expect(session.totalCoinsEarned).toBe(2 * COINS_PER_SUCCESS);
        expect(session.catalystOfCoinificationUsed).toBe(2);
    });

    test('a coin stack snapshotted once per packed action is read at its last total', async () => {
        await startFromQueue(coinifyHistoryTracker, '/actions/alchemy/coinify', DONUT, null);

        await coinify(3, [
            stack(9001, COIN, 1_000_000 + COINS_PER_SUCCESS),
            stack(9001, COIN, 1_000_000 + 2 * COINS_PER_SUCCESS),
            stack(9001, COIN, 1_000_000 + 3 * COINS_PER_SUCCESS),
            stack(1001, DONUT, 97),
        ]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(3);
        expect(session.totalSuccesses).toBe(3);
        expect(session.totalCoinsEarned).toBe(3 * COINS_PER_SUCCESS);
    });

    test('a prime catalyst is measured from its own stack on the first message', async () => {
        game.inventory.push(stack(6002, PRIME, 10));
        await startFromQueue(coinifyHistoryTracker, '/actions/alchemy/coinify', DONUT, PRIME);

        await complete(coinifyHistoryTracker, '/actions/alchemy/coinify', DONUT, PRIME, 3, [
            stack(1001, DONUT, 97),
            stack(9001, COIN, 1_000_000 + 3 * COINS_PER_SUCCESS),
            stack(6002, PRIME, 7),
        ]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.primeCatalystUsed).toBe(3);
        expect(session.catalystOfCoinificationUsed).toBe(0);
    });

    test('a session picked up mid-run from the queue counts from the count it was queued at', async () => {
        await startFromQueue(coinifyHistoryTracker, '/actions/alchemy/coinify', DONUT, null, 57);

        await coinify(60, [stack(1001, DONUT, 97), stack(9001, COIN, 1_000_000 + 3 * COINS_PER_SUCCESS)]);

        expect(coinifyHistoryTracker.activeSession.totalAttempts).toBe(3);
        expect(coinifyHistoryTracker.activeSession.totalSuccesses).toBe(3);
    });

    test('a session first seen through action_completed still reads its first message as a floor', async () => {
        // No queue update, so the inventory already carries this message's
        // rows and cannot serve as a baseline
        await coinify(3, [stack(1001, DONUT, 97), stack(9001, COIN, 1_000_000 + 3 * COINS_PER_SUCCESS)]);
        await coinify(6, [stack(1001, DONUT, 94), stack(9001, COIN, 1_000_000 + 6 * COINS_PER_SUCCESS)]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(4);
        expect(session.totalSuccesses).toBe(4);
    });
});

describe('decompose: the first message of a run', () => {
    const decompose = (input, catalyst, count, rows) =>
        complete(decomposeHistoryTracker, '/actions/alchemy/decompose', input, catalyst, count, rows);

    test('Mooberry Donut: two successes and a failure in the first batch', async () => {
        game.inventory = [
            stack(1001, DONUT, 100),
            stack(8001, COOKING_ESSENCE, 10),
            stack(6001, DECOMPOSE_CATALYST, 20),
        ];
        await startFromQueue(decomposeHistoryTracker, '/actions/alchemy/decompose', DONUT, DECOMPOSE_CATALYST);

        await decompose(DONUT, DECOMPOSE_CATALYST, 3, [
            stack(1001, DONUT, 97),
            stack(8001, COOKING_ESSENCE, 16),
            stack(6001, DECOMPOSE_CATALYST, 18),
        ]);

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(3);
        expect(session.totalSuccesses).toBe(2);
        expect(session.results[COOKING_ESSENCE].count).toBe(6);
        expect(session.results[COOKING_ESSENCE].totalValue).toBe(6 * 40);
        expect(session.catalystOfDecompositionUsed).toBe(2);
        expect(session.catalystsUsed[DECOMPOSE_CATALYST]).toBe(2);
    });

    test('an essence stack snapshotted once per packed action is read at its last total', async () => {
        game.inventory = [stack(1001, DONUT, 100), stack(8001, COOKING_ESSENCE, 10)];
        await startFromQueue(decomposeHistoryTracker, '/actions/alchemy/decompose', DONUT, null);

        await decompose(DONUT, null, 3, [
            stack(1001, DONUT, 99),
            stack(8001, COOKING_ESSENCE, 13),
            stack(1001, DONUT, 98),
            stack(8001, COOKING_ESSENCE, 16),
            stack(1001, DONUT, 97),
            stack(8001, COOKING_ESSENCE, 19),
        ]);

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(3);
        expect(session.totalSuccesses).toBe(3);
        expect(session.results[COOKING_ESSENCE].count).toBe(9);
    });

    test('scrolls into Labyrinth Tokens the character had none of: the new stack counts from zero', async () => {
        game.inventory = [stack(1002, SCROLL, 40)];
        await startFromQueue(decomposeHistoryTracker, '/actions/alchemy/decompose', SCROLL, null);

        await decompose(SCROLL, null, 3, [stack(1002, SCROLL, 37), stack(8101, TOKEN, 15)]);
        await decompose(SCROLL, null, 6, [stack(1002, SCROLL, 34), stack(8101, TOKEN, 25)]);

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(6);
        expect(session.totalSuccesses).toBe(5);
        expect(session.results[TOKEN].count).toBe(25);
    });

    test('a session first seen through action_completed still reads its first message as a floor', async () => {
        game.inventory = [stack(1001, DONUT, 100), stack(8001, COOKING_ESSENCE, 10)];

        await decompose(DONUT, null, 3, [stack(1001, DONUT, 97), stack(8001, COOKING_ESSENCE, 19)]);
        await decompose(DONUT, null, 6, [stack(1001, DONUT, 94), stack(8001, COOKING_ESSENCE, 28)]);

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(4);
        expect(session.totalSuccesses).toBe(4);
        expect(session.results[COOKING_ESSENCE].count).toBe(12);
    });
});
