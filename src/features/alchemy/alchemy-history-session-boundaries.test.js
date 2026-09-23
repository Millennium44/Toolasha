/**
 * Where an alchemy run's messages stop measuring against the right baseline.
 *
 * Every message is delivered the way the page sees it: dataManager has already
 * written its rows into the inventory, and has already replaced the cached
 * action, when the tracker reads it. Item counts and yields are fixture values;
 * the row shapes are the game's.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    items: {},
    prices: {},
    inventory: null,
    actions: [],
    activeSocket: true,
}));
const store = vi.hoisted(() => ({ gate: null, saved: [] }));

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
        isFromActiveSocket: () => game.activeSocket,
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
        load: async () => {
            if (store.gate) await store.gate;
            return [];
        },
        save: async (_scope, sessions) => {
            store.saved.push(sessions.map((s) => ({ ...s })));
        },
        clear: async () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');

const INVENTORY = '/item_locations/inventory';
const COIN = '/items/coin';
const DONUT = '/items/mooberry_donut';
const COOKING_ESSENCE = '/items/cooking_essence';
const GEM = '/items/amber';
const GARNET = '/items/garnet';
const JADE = '/items/jade';
const SWORD = '/items/cheese_sword';
const CHEESE = '/items/cheese';
const ENHANCING_ESSENCE = '/items/enhancing_essence';
const TWIN = '/items/twin_output_item';
const COINIFY_CATALYST = '/items/catalyst_of_coinification';
const PRIME = '/items/prime_catalyst';

const TRANSMUTE = '/actions/alchemy/transmute';
const COINIFY = '/actions/alchemy/coinify';
const DECOMPOSE = '/actions/alchemy/decompose';

/** Coins per coinify success: sellPrice 100 x 5 x bulk 1 */
const COINS_PER_SUCCESS = 500;

/**
 * @param {number} id - Stack id
 * @param {string} itemHrid - Item hrid
 * @param {number} count - The stack's absolute total
 * @returns {Object} An inventory row as the game sends it
 */
function stack(id, itemHrid, count) {
    return { id, characterID: 1, itemLocationHrid: INVENTORY, itemHrid, enhancementLevel: 0, count };
}

/**
 * @param {string|null} hrid - Item hrid
 * @param {number} [level] - Enhancement level
 * @returns {string} The item hash the game puts in an action's item slots
 */
function hash(hrid, level = 0) {
    return hrid ? `char-1::${INVENTORY}::${hrid}::${level}` : '';
}

/**
 * @param {Object} spec - The action's moving parts
 * @returns {Object} An action as the queue carries it
 */
function action({ id, actionHrid, input, level = 0, catalyst = null, currentCount = 0, ordinal = 1 }) {
    return {
        id,
        actionHrid,
        primaryItemHash: hash(input, level),
        secondaryItemHash: hash(catalyst),
        currentCount,
        isDone: false,
        ordinal,
    };
}

/**
 * The queue changed: dataManager has merged it and re-emits.
 * @param {Object} tracker - The tracker under test
 * @param {Array<Object>} actions - The whole queue after the change
 * @returns {Promise<void>}
 */
async function queue(tracker, actions) {
    game.actions = actions;
    await tracker.handleActionsUpdated();
}

/**
 * Apply rows to the inventory as dataManager does.
 * @param {Array<Object>} rows - `endCharacterItems`
 */
function absorb(rows) {
    for (const row of rows) {
        const index = game.inventory.findIndex((held) => held.id === row.id);
        if (index === -1) game.inventory.push({ ...row });
        else game.inventory[index].count = row.count;
    }
}

/**
 * Deliver an action_completed after dataManager has absorbed its rows.
 * @param {Object} tracker - The tracker under test
 * @param {Object} running - The action as the message carries it
 * @param {Array<Object>} rows - `endCharacterItems`
 * @returns {Promise<void>}
 */
async function complete(tracker, running, rows) {
    absorb(rows);
    const index = game.actions.findIndex((queued) => queued.id === running.id);
    if (index !== -1) game.actions[index] = running;
    await tracker.handleActionCompleted({
        type: 'action_completed',
        endCharacterAction: { ...running, maxCount: 0 },
        endCharacterItems: rows,
    });
}

/**
 * An items_updated from outside the action — a market sale, a purchase.
 * @param {Object} tracker - The tracker under test
 * @param {Array<Object>} rows - `endCharacterItems`
 */
function itemsUpdated(tracker, rows) {
    absorb(rows);
    tracker.handleItemsUpdated({ type: 'items_updated', endCharacterItems: rows });
}

const trackers = [transmuteHistoryTracker, coinifyHistoryTracker, decomposeHistoryTracker];

beforeEach(() => {
    game.items = {
        [DONUT]: {
            name: 'Mooberry Donut',
            itemLevel: 20,
            sellPrice: 100,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: COOKING_ESSENCE, count: 3 }] },
        },
        [GEM]: {
            name: 'Amber',
            itemLevel: 30,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteDropTable: [{ itemHrid: GEM }, { itemHrid: GARNET }, { itemHrid: JADE }],
            },
        },
        [SWORD]: {
            name: 'Cheese Sword',
            itemLevel: 10,
            alchemyDetail: { bulkMultiplier: 1, decomposeItems: [{ itemHrid: CHEESE, count: 4 }] },
        },
        [TWIN]: {
            name: 'Twin',
            itemLevel: 10,
            alchemyDetail: {
                bulkMultiplier: 1,
                decomposeItems: [
                    { itemHrid: CHEESE, count: 2 },
                    { itemHrid: COOKING_ESSENCE, count: 1 },
                ],
            },
        },
    };
    game.prices = { [COOKING_ESSENCE]: 40, [GARNET]: 1000, [JADE]: 1000, [CHEESE]: 10, [ENHANCING_ESSENCE]: 5 };
    game.actions = [];
    game.activeSocket = true;
    store.gate = null;
    store.saved = [];
    for (const tracker of trackers) {
        tracker.activeSession = null;
        tracker.characterId = 'char-1';
        tracker.lastCurrentCount = null;
        tracker.trackedActionId = null;
    }
});

describe('the next action for the same item', () => {
    test('transmute: a second queued copy counts its first batch from its own currentCount', async () => {
        game.inventory = [stack(1, GEM, 100), stack(2, GARNET, 0), stack(3, JADE, 0)];
        const first = { id: 501, actionHrid: TRANSMUTE, input: GEM };
        await queue(transmuteHistoryTracker, [action(first), action({ ...first, id: 502, ordinal: 2 })]);

        // Three failures, then three failures: the first copy's count ends at 6
        await complete(transmuteHistoryTracker, action({ ...first, currentCount: 3 }), [stack(1, GEM, 97)]);
        await complete(transmuteHistoryTracker, action({ ...first, currentCount: 6 }), [stack(1, GEM, 94)]);

        // It finishes; the second copy takes the front at count 0
        await queue(transmuteHistoryTracker, [action({ ...first, id: 502, ordinal: 2 })]);

        // Its first message packs four attempts: one garnet, three failures
        await complete(transmuteHistoryTracker, action({ ...first, id: 502, ordinal: 2, currentCount: 4 }), [
            stack(1, GEM, 90),
            stack(2, GARNET, 1),
        ]);

        const session = transmuteHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(10);
        expect(session.totalSuccesses).toBe(1);
        expect(session.results[GARNET].count).toBe(1);
    });

    test('coinify: restarting the same item counts the new action from zero', async () => {
        game.inventory = [stack(1, DONUT, 100), stack(9, COIN, 1_000_000), stack(6, COINIFY_CATALYST, 50)];
        const first = { id: 501, actionHrid: COINIFY, input: DONUT, catalyst: COINIFY_CATALYST };
        await queue(coinifyHistoryTracker, [action(first)]);

        await complete(coinifyHistoryTracker, action({ ...first, currentCount: 3 }), [
            stack(1, DONUT, 97),
            stack(9, COIN, 1_000_000 + 3 * COINS_PER_SUCCESS),
            stack(6, COINIFY_CATALYST, 47),
        ]);

        // The player presses Start again on the same donut: a new action at count 0
        await queue(coinifyHistoryTracker, [action({ ...first, id: 777, ordinal: 2 })]);

        await complete(coinifyHistoryTracker, action({ ...first, id: 777, ordinal: 2, currentCount: 3 }), [
            stack(1, DONUT, 94),
            stack(9, COIN, 1_000_000 + 6 * COINS_PER_SUCCESS),
            stack(6, COINIFY_CATALYST, 44),
        ]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(6);
        expect(session.totalSuccesses).toBe(6);
        expect(session.totalCoinsEarned).toBe(6 * COINS_PER_SUCCESS);
        expect(session.catalystsUsed[COINIFY_CATALYST]).toBe(6);
    });

    test('decompose: a restart with the prime catalyst instead seeds the new catalyst', async () => {
        game.inventory = [stack(1, DONUT, 100), stack(4, COOKING_ESSENCE, 0), stack(8, PRIME, 20)];
        const first = { id: 501, actionHrid: DECOMPOSE, input: DONUT };
        await queue(decomposeHistoryTracker, [action(first)]);

        await complete(decomposeHistoryTracker, action({ ...first, currentCount: 3 }), [
            stack(1, DONUT, 97),
            stack(4, COOKING_ESSENCE, 9),
        ]);

        // Restarted with the prime catalyst in the slot
        const second = { ...first, id: 502, catalyst: PRIME, ordinal: 2 };
        await queue(decomposeHistoryTracker, [action(second)]);

        // Three attempts, two successes
        await complete(decomposeHistoryTracker, action({ ...second, currentCount: 3 }), [
            stack(1, DONUT, 94),
            stack(4, COOKING_ESSENCE, 15),
            stack(8, PRIME, 18),
        ]);

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(6);
        expect(session.totalSuccesses).toBe(5);
        expect(session.primeCatalystUsed).toBe(2);
    });
});

describe('inventory moved by something other than the action', () => {
    test('coinify: coins from a market sale between messages are not read as successes', async () => {
        game.inventory = [stack(1, DONUT, 100), stack(9, COIN, 1_000_000)];
        const run = { id: 501, actionHrid: COINIFY, input: DONUT };
        await queue(coinifyHistoryTracker, [action(run)]);

        await complete(coinifyHistoryTracker, action({ ...run, currentCount: 3 }), [
            stack(1, DONUT, 97),
            stack(9, COIN, 1_000_000 + COINS_PER_SUCCESS),
        ]);

        // A sell listing is collected mid-run
        itemsUpdated(coinifyHistoryTracker, [stack(9, COIN, 1_000_000 + COINS_PER_SUCCESS + 250_000)]);

        // One success in the next batch of three
        await complete(coinifyHistoryTracker, action({ ...run, currentCount: 6 }), [
            stack(1, DONUT, 94),
            stack(9, COIN, 1_000_000 + 2 * COINS_PER_SUCCESS + 250_000),
        ]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(6);
        expect(session.totalSuccesses).toBe(2);
        expect(session.totalCoinsEarned).toBe(2 * COINS_PER_SUCCESS);
    });

    test('transmute: buying more of the input mid-run is not read as self-returns', async () => {
        game.inventory = [stack(1, GEM, 10), stack(2, GARNET, 0), stack(3, JADE, 0)];
        const run = { id: 501, actionHrid: TRANSMUTE, input: GEM };
        await queue(transmuteHistoryTracker, [action(run)]);

        await complete(transmuteHistoryTracker, action({ ...run, currentCount: 3 }), [stack(1, GEM, 7)]);
        itemsUpdated(transmuteHistoryTracker, [stack(1, GEM, 57)]);
        await complete(transmuteHistoryTracker, action({ ...run, currentCount: 6 }), [stack(1, GEM, 54)]);

        const session = transmuteHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(6);
        expect(session.totalSuccesses).toBe(0);
        expect(session.results[GEM]).toBeUndefined();
    });
});

describe('a run already going when the tracker starts', () => {
    test('coinify: a page loaded mid-run seeds from the queue and reads the first batch whole', async () => {
        game.inventory = [stack(1, DONUT, 70), stack(9, COIN, 2_000_000)];
        const run = { id: 501, actionHrid: COINIFY, input: DONUT, currentCount: 30 };
        game.actions = [action(run)];

        coinifyHistoryTracker.isInitialized = false;
        coinifyHistoryTracker.initialize();
        await vi.waitFor(() => expect(coinifyHistoryTracker.activeSession).not.toBeNull());

        await complete(coinifyHistoryTracker, action({ ...run, currentCount: 33 }), [
            stack(1, DONUT, 67),
            stack(9, COIN, 2_000_000 + 3 * COINS_PER_SUCCESS),
        ]);

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(3);
        expect(session.totalSuccesses).toBe(3);
    });

    test('a session started by the queue survives the previous one still being saved', async () => {
        game.inventory = [stack(1, DONUT, 100), stack(9, COIN, 1_000_000)];
        const run = { id: 501, actionHrid: COINIFY, input: DONUT };
        await queue(coinifyHistoryTracker, [action(run)]);
        await complete(coinifyHistoryTracker, action({ ...run, currentCount: 3 }), [
            stack(1, DONUT, 97),
            stack(9, COIN, 1_000_000 + COINS_PER_SUCCESS),
        ]);
        const before = coinifyHistoryTracker.activeSession;

        // A reconnect ends the session; its save is slow
        let open;
        store.gate = new Promise((resolve) => {
            open = resolve;
        });
        const ending = coinifyHistoryTracker.handleReconnect();

        // The reconnect's queue arrives while the save is still in flight
        await queue(coinifyHistoryTracker, [action({ ...run, currentCount: 3 })]);
        const started = coinifyHistoryTracker.activeSession;
        expect(started).not.toBe(before);

        open();
        await ending;
        expect(coinifyHistoryTracker.activeSession).toBe(started);
    });
});

describe('the floor for a message with no baseline', () => {
    test('transmute: one attempt that produced a garnet is one attempt, not two', async () => {
        game.inventory = [stack(1, GEM, 9), stack(2, GARNET, 1)];
        await complete(
            transmuteHistoryTracker,
            action({ id: 501, actionHrid: TRANSMUTE, input: GEM, currentCount: 1 }),
            [stack(1, GEM, 9), stack(2, GARNET, 1)]
        );

        const session = transmuteHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(1);
        expect(session.totalSuccesses).toBe(1);
    });

    test('decompose: one success with two outputs is one attempt, not two', async () => {
        game.inventory = [stack(1, TWIN, 9), stack(2, CHEESE, 2), stack(3, COOKING_ESSENCE, 1)];
        await complete(
            decomposeHistoryTracker,
            action({ id: 501, actionHrid: DECOMPOSE, input: TWIN, currentCount: 1 }),
            [stack(1, TWIN, 9), stack(2, CHEESE, 2), stack(3, COOKING_ESSENCE, 1)]
        );

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalAttempts).toBe(1);
        expect(session.totalSuccesses).toBe(1);
    });
});

describe('messages the tracker must not read', () => {
    test('an action_completed from a connection that is no longer the active one is ignored', async () => {
        game.inventory = [stack(1, DONUT, 100), stack(9, COIN, 1_000_000)];
        game.activeSocket = false;
        await coinifyHistoryTracker.handleActionCompleted(
            {
                type: 'action_completed',
                endCharacterAction: action({ id: 501, actionHrid: COINIFY, input: DONUT, currentCount: 3 }),
                endCharacterItems: [stack(9, COIN, 1_000_000 + COINS_PER_SUCCESS)],
            },
            { socket: {} }
        );
        expect(coinifyHistoryTracker.activeSession).toBeNull();
    });
});

describe('an enhanced item decomposed', () => {
    test('the enhancing essence it yields is recorded as an output', async () => {
        game.inventory = [stack(1, SWORD, 5), stack(2, CHEESE, 0), stack(3, ENHANCING_ESSENCE, 100)];
        const run = { id: 501, actionHrid: DECOMPOSE, input: SWORD, level: 5 };
        await queue(decomposeHistoryTracker, [action(run)]);

        // Two attempts, both successes: 4 cheese and 70 essence each
        await complete(decomposeHistoryTracker, action({ ...run, currentCount: 2 }), [
            stack(1, SWORD, 3),
            stack(2, CHEESE, 8),
            stack(3, ENHANCING_ESSENCE, 240),
        ]);

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalSuccesses).toBe(2);
        expect(session.results[CHEESE].count).toBe(8);
        expect(session.results[ENHANCING_ESSENCE].count).toBe(140);
        expect(session.results[ENHANCING_ESSENCE].totalValue).toBe(140 * 5);
    });

    test('an unenhanced decompose records no enhancing essence', async () => {
        game.inventory = [stack(1, SWORD, 5), stack(2, CHEESE, 0), stack(3, ENHANCING_ESSENCE, 100)];
        const run = { id: 501, actionHrid: DECOMPOSE, input: SWORD };
        await queue(decomposeHistoryTracker, [action(run)]);
        await complete(decomposeHistoryTracker, action({ ...run, currentCount: 1 }), [
            stack(1, SWORD, 4),
            stack(2, CHEESE, 4),
        ]);
        expect(decomposeHistoryTracker.activeSession.results[ENHANCING_ESSENCE]).toBeUndefined();
    });
});

describe('a catalyst stack that ran out', () => {
    test('transmute: a success with the seeded catalyst stack unmoved spent no catalyst', async () => {
        game.inventory = [stack(1, GEM, 10), stack(2, GARNET, 0), stack(3, JADE, 0), stack(8, PRIME, 1)];
        const run = { id: 501, actionHrid: TRANSMUTE, input: GEM, catalyst: PRIME };
        await queue(transmuteHistoryTracker, [action(run)]);

        await complete(transmuteHistoryTracker, action({ ...run, currentCount: 1 }), [
            stack(1, GEM, 9),
            stack(2, GARNET, 1),
            stack(8, PRIME, 0),
        ]);
        // The stack is empty; the next success moves nothing but the gems
        await complete(transmuteHistoryTracker, action({ ...run, currentCount: 2 }), [
            stack(1, GEM, 8),
            stack(3, JADE, 1),
        ]);

        const session = transmuteHistoryTracker.activeSession;
        expect(session.totalSuccesses).toBe(2);
        expect(session.catalystsUsed[PRIME]).toBe(1);
    });
});

describe('the version stamp', () => {
    test('sessions recorded with these fixes carry the session-boundary version', async () => {
        const { SESSION_BOUNDARY_FIX_VERSION, isPreFixSession } = await import('./alchemy-tracker-version.js');
        game.inventory = [stack(1, DONUT, 100), stack(9, COIN, 1_000_000)];
        await queue(coinifyHistoryTracker, [action({ id: 501, actionHrid: COINIFY, input: DONUT })]);
        const session = coinifyHistoryTracker.activeSession;
        expect(session.trackerVersion).toBeGreaterThanOrEqual(SESSION_BOUNDARY_FIX_VERSION);
        expect(isPreFixSession(session, SESSION_BOUNDARY_FIX_VERSION)).toBe(false);
    });
});
