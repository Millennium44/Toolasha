/**
 * One alchemy run across a page reload.
 *
 * Reproduces the live coinify run: Mooberry Donut, Prime Catalyst, repeat, one
 * queue action id throughout. Truth from the inventory was 51 attempts, 46
 * successes, 9200 coins, 46 prime. The page before the reload recorded counts
 * up to 18; the batch 18→21 completed while the page was reloading, so no
 * message for it was ever delivered, and the new page's snapshot said 21. The
 * history showed two rows, 18/16 and 30/27, with that batch in neither.
 *
 * Every message is delivered the way the page sees it: dataManager has already
 * written its rows into the inventory, and the cached action, when the tracker
 * reads it.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, inventory: null, actions: [] }));
const store = vi.hoisted(() => ({ sessions: [] }));

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
    getItemPrice: () => 10,
    getItemPrices: () => null,
}));
// What is on disk survives the reload; the page's objects do not
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => structuredClone(store.sessions),
        save: async (_scope, sessions) => {
            store.sessions = structuredClone(sessions);
        },
        clear: async () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { MAX_RESUME_GAP_MS } = await import('./alchemy-session-resume.js');

const INVENTORY = '/item_locations/inventory';
const COIN = '/items/coin';
const DONUT = '/items/mooberry_donut';
const PRIME = '/items/prime_catalyst';
const GEM = '/items/amber';
const GARNET = '/items/garnet';
const COINIFY = '/actions/alchemy/coinify';
const TRANSMUTE = '/actions/alchemy/transmute';
const ACTION_ID = 24022273;

/** sellPrice 40 x 5 x bulk 1 */
const COINS_PER_SUCCESS = 200;

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
 * @returns {string} The item hash the game puts in an action's item slots
 */
function hash(hrid) {
    return hrid ? `char-1::${INVENTORY}::${hrid}::0` : '';
}

/**
 * @param {number} currentCount - The action's count
 * @param {Object} [spec] - Overrides
 * @returns {Object} The coinify action as the queue carries it
 */
function coinifyAction(currentCount, { id = ACTION_ID } = {}) {
    return {
        id,
        actionHrid: COINIFY,
        primaryItemHash: hash(DONUT),
        secondaryItemHash: hash(PRIME),
        currentCount,
        isDone: false,
        ordinal: 1,
        hasMaxCount: false,
    };
}

/** The game's side of the run: totals it moves, whether or not a page is listening. */
const world = { count: 0, donut: 0, coin: 0, prime: 0 };

/**
 * The game plays one batch of three attempts.
 * @param {number} successes - How many of the three succeeded
 * @returns {Array<Object>} The batch's `endCharacterItems`, already in the inventory
 */
function playBatch(successes) {
    world.count += 3;
    world.donut -= 3;
    world.coin += successes * COINS_PER_SUCCESS;
    world.prime -= successes;
    const rows = [stack(1, DONUT, world.donut), stack(6, PRIME, world.prime)];
    if (successes > 0) rows.push(stack(9, COIN, world.coin));
    for (const row of rows) game.inventory.find((held) => held.id === row.id).count = row.count;
    game.actions = [coinifyAction(world.count)];
    return rows;
}

/**
 * A batch the page receives.
 * @param {number} successes - How many of the three succeeded
 * @returns {Promise<void>}
 */
async function deliver(successes) {
    const rows = playBatch(successes);
    await coinifyHistoryTracker.handleActionCompleted({
        type: 'action_completed',
        endCharacterAction: { ...coinifyAction(world.count), maxCount: 0 },
        endCharacterItems: rows,
    });
}

/** The page goes away: nothing in memory survives. */
function unloadPage() {
    for (const tracker of [coinifyHistoryTracker, transmuteHistoryTracker]) {
        tracker.activeSession = null;
        tracker.isInitialized = false;
        tracker.itemCounts.reset();
        tracker.seededHrids = new Set();
        tracker.lastCurrentCount = null;
        tracker.trackedActionId = null;
    }
}

/**
 * A fresh page loads from the login snapshot and the tracker initializes.
 * @param {Object} tracker - The tracker under test
 * @returns {Promise<void>}
 */
async function loadPage(tracker) {
    tracker.isInitialized = false;
    tracker.initialize();
    await vi.waitFor(() => expect(tracker.activeSession).not.toBeNull());
}

beforeEach(() => {
    game.items = {
        [DONUT]: { name: 'Mooberry Donut', itemLevel: 20, sellPrice: 40, alchemyDetail: { bulkMultiplier: 1 } },
        [GEM]: {
            name: 'Amber',
            itemLevel: 30,
            alchemyDetail: { bulkMultiplier: 1, transmuteDropTable: [{ itemHrid: GEM }, { itemHrid: GARNET }] },
        },
    };
    Object.assign(world, { count: 0, donut: 1_248_631_860, coin: 13_116_900_123_473, prime: 97_815_973 });
    game.inventory = [stack(1, DONUT, world.donut), stack(9, COIN, world.coin), stack(6, PRIME, world.prime)];
    game.actions = [coinifyAction(0)];
    store.sessions = [];
    unloadPage();
    coinifyHistoryTracker.characterId = 'char-1';
    transmuteHistoryTracker.characterId = 'char-1';
});

describe('coinify across a reload', () => {
    test('one row, with the batch that completed during the reload counted', async () => {
        await loadPage(coinifyHistoryTracker);

        // Before the reload: counts 3..18, sixteen successes
        for (const successes of [3, 3, 2, 3, 3, 2]) await deliver(successes);
        unloadPage();

        // During the reload the game plays 18→21 with nobody listening
        playBatch(3);

        // The new page starts from the snapshot at 21, then the run goes on to 51
        await loadPage(coinifyHistoryTracker);
        for (const successes of [3, 3, 3, 3, 3, 3, 3, 2, 2, 2]) await deliver(successes);

        expect(store.sessions).toHaveLength(1);
        const [session] = store.sessions;
        expect(session.totalAttempts).toBe(51);
        expect(session.totalSuccesses).toBe(46);
        expect(session.totalCoinsEarned).toBe(9200);
        expect(session.primeCatalystUsed).toBe(46);
        expect(session.catalystsUsed[PRIME]).toBe(46);
    });

    test('a reload with no batch in the gap resumes without adding anything', async () => {
        await loadPage(coinifyHistoryTracker);
        for (const successes of [3, 2]) await deliver(successes);
        unloadPage();

        await loadPage(coinifyHistoryTracker);
        await deliver(1);

        expect(store.sessions).toHaveLength(1);
        expect(store.sessions[0].totalAttempts).toBe(9);
        expect(store.sessions[0].totalSuccesses).toBe(6);
    });

    test('a different queue action for the same item starts a new session', async () => {
        await loadPage(coinifyHistoryTracker);
        await deliver(3);
        unloadPage();

        game.actions = [coinifyAction(0, { id: ACTION_ID + 1 })];
        world.count = 0;
        await loadPage(coinifyHistoryTracker);

        expect(coinifyHistoryTracker.activeSession.totalAttempts).toBe(0);
        expect(coinifyHistoryTracker.activeSession.id).not.toBe(store.sessions[0].id);
    });

    test('a session last active too long ago is not resumed', async () => {
        await loadPage(coinifyHistoryTracker);
        await deliver(3);
        unloadPage();

        // The tab was closed long enough for anything to have happened
        store.sessions[0].lastActivityTime -= MAX_RESUME_GAP_MS + 1000;
        playBatch(3);
        await loadPage(coinifyHistoryTracker);

        expect(coinifyHistoryTracker.activeSession.totalAttempts).toBe(0);
        expect(store.sessions[0].totalAttempts).toBe(3);
    });
});

describe('transmute across a reload', () => {
    test('the gap batch reads its outputs and self-returns against the stored point', async () => {
        game.inventory = [stack(11, GEM, 100), stack(12, GARNET, 0)];
        const action = (currentCount) => ({
            id: 77,
            actionHrid: TRANSMUTE,
            primaryItemHash: hash(GEM),
            secondaryItemHash: '',
            currentCount,
            isDone: false,
            ordinal: 1,
        });
        game.actions = [action(0)];
        await loadPage(transmuteHistoryTracker);

        // Three attempts: one garnet, one self-return, one failure
        game.inventory[0].count = 98;
        game.inventory[1].count = 1;
        game.actions = [action(3)];
        await transmuteHistoryTracker.handleActionCompleted({
            type: 'action_completed',
            endCharacterAction: action(3),
            endCharacterItems: [stack(11, GEM, 98), stack(12, GARNET, 1)],
        });
        unloadPage();

        // During the reload: three attempts, two garnets and one self-return
        game.inventory[0].count = 96;
        game.inventory[1].count = 3;
        game.actions = [action(6)];
        await loadPage(transmuteHistoryTracker);

        const session = transmuteHistoryTracker.activeSession;
        expect(store.sessions).toHaveLength(1);
        expect(session.totalAttempts).toBe(6);
        expect(session.totalSuccesses).toBe(5);
        expect(session.results[GARNET].count).toBe(3);
        expect(session.results[GEM].count).toBe(2);
    });
});
