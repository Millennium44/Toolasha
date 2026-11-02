/**
 * A session's saved costs, as the trackers write them.
 *
 * The viewers priced a session's input and catalysts at the market of the day
 * somebody looked, while its outputs were priced when they arrived. Each
 * message now prices what it consumed and adds it to `session.costs`, so a run
 * across a price move, a reload, or a build that did not save costs reads back
 * as what it cost.
 *
 * Messages are delivered the way the page sees them: dataManager has already
 * written the rows into the inventory, and the cached action, when the tracker
 * reads it. Shapes are the game's (see alchemy-history-reload-resume.test.js).
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, inventory: null, actions: [], prices: {} }));
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
vi.mock('../../utils/market-data.js', () => {
    const priceOf = (itemHrid) => (itemHrid in game.prices ? game.prices[itemHrid] : null);
    return {
        getItemPrice: (itemHrid) => priceOf(itemHrid),
        getItemPriceInfo: (itemHrid) => {
            const price = priceOf(itemHrid);
            return { price, source: price === null ? null : 'book', estimated: false };
        },
        getItemPrices: () => null,
    };
});
vi.mock('../enhancement/untradable-cape-value.js', () => ({ getUntradableCapeValue: () => null }));
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
    mergeSessionCopies: (a) => a,
    NO_CHARACTER: 'none',
}));

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { resolveInputCost, resolveCatalystCost } = await import('./alchemy-cost-record.js');

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
 * @returns {Object} The coinify action as the queue carries it
 */
function coinifyAction(currentCount) {
    return {
        id: ACTION_ID,
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

/** @returns {Object} The one stored session */
function stored() {
    expect(store.sessions).toHaveLength(1);
    return store.sessions[0];
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
    game.prices = { [DONUT]: 10, [PRIME]: 1000, [GEM]: 50 };
    Object.assign(world, { count: 0, donut: 1_248_631_860, coin: 13_116_900_123_473, prime: 97_815_973 });
    game.inventory = [stack(1, DONUT, world.donut), stack(9, COIN, world.coin), stack(6, PRIME, world.prime)];
    game.actions = [coinifyAction(0)];
    store.sessions = [];
    unloadPage();
    coinifyHistoryTracker.characterId = 'char-1';
    transmuteHistoryTracker.characterId = 'char-1';
});

describe('coinify: what each batch cost when it ran', () => {
    test('the price moves between batches: each is costed at its own price, catalysts too', async () => {
        await loadPage(coinifyHistoryTracker);

        await deliver(3); // 3 attempts at donut 10, 3 prime at 1000
        game.prices[DONUT] = 14;
        game.prices[PRIME] = 1200;
        await deliver(2); // 3 attempts at 14, 2 prime at 1200
        game.prices[DONUT] = 9;
        await deliver(3); // 3 attempts at 9, 3 prime at 1200

        const session = stored();
        expect(session.totalAttempts).toBe(9);
        expect(session.costs.input).toMatchObject({ cost: 3 * 10 + 3 * 14 + 3 * 9, units: 9 });
        expect(session.costs.catalysts[PRIME]).toMatchObject({ cost: 3 * 1000 + 2 * 1200 + 3 * 1200, count: 8 });

        // Looking at it later, at any price, reads back the same
        game.prices[DONUT] = 1000;
        const resolved = resolveInputCost(session, 9, () => ({ price: 1000, basis: 'current buy', unpriced: false }));
        expect(resolved.cost).toBe(99);
        expect(resolved.pricedToday).toBe(false);
        expect(resolveCatalystCost(session, PRIME, 8, () => 99999).pricedToday).toBe(false);
    });

    test('a batch with no price saves nothing: it reads at the market found later, marked, and unpriced only if there is none', async () => {
        await loadPage(coinifyHistoryTracker);
        await deliver(3);
        delete game.prices[DONUT];
        await deliver(3);
        game.prices[DONUT] = 10;
        await deliver(3);

        // The unpriced batch is not covered (and not saved as a free one)
        expect(stored().costs.input).toMatchObject({ cost: 3 * 10 + 3 * 10, units: 6 });
        const later = resolveInputCost(stored(), 9, () => ({ price: 12, basis: 'current buy', unpriced: false }));
        expect(later).toMatchObject({ cost: 60 + 3 * 12, todayUnits: 3, pricedToday: true, unpriced: false });
        const none = resolveInputCost(stored(), 9, () => ({ price: 0, basis: null, unpriced: true }));
        expect(none).toMatchObject({ unpriced: true, pricedToday: false });
    });

    test('a reload in the middle: the batch that finished in the gap is costed when the page comes back', async () => {
        await loadPage(coinifyHistoryTracker);
        await deliver(3); // 3 attempts at 10
        unloadPage();

        playBatch(3); // 3 attempts nobody saw
        game.prices[DONUT] = 20;
        await loadPage(coinifyHistoryTracker); // the gap is read as one message, at 20
        await deliver(2); // 3 attempts at 20

        const session = stored();
        expect(session.totalAttempts).toBe(9);
        expect(session.costs.input).toMatchObject({ cost: 3 * 10 + 6 * 20, units: 9 });
    });

    test('a session begun on a build that saved nothing, resumed on this one: the old part reads at today', async () => {
        await loadPage(coinifyHistoryTracker);
        await deliver(3);
        await deliver(3);
        // What the older build left behind: counts, no costs
        delete store.sessions[0].costs;
        unloadPage();

        game.prices[DONUT] = 20;
        await loadPage(coinifyHistoryTracker);
        await deliver(3);

        const session = stored();
        expect(session.totalAttempts).toBe(9);
        expect(session.costs.input).toMatchObject({ cost: 3 * 20, units: 3 });

        const resolved = resolveInputCost(session, 9, () => ({ price: 30, basis: 'current buy', unpriced: false }));
        // Three saved at 20, six not saved: read at today's 30, and marked
        expect(resolved).toMatchObject({ cost: 3 * 20 + 6 * 30, savedUnits: 3, todayUnits: 6, pricedToday: true });
    });
});

describe("coinify: units follow the viewer's bulk rule", () => {
    test("a session with no recorded bulk size counts the item's, as the viewer does", async () => {
        await loadPage(coinifyHistoryTracker);
        await deliver(3);
        // A record from before the bulk size was persisted
        delete store.sessions[0].bulkMultiplier;
        unloadPage();
        game.items[DONUT].alchemyDetail.bulkMultiplier = 5;

        await loadPage(coinifyHistoryTracker);
        coinifyHistoryTracker.activeSession.bulkMultiplier = undefined;
        await deliver(3);

        // Three attempts at the item's bulk of 5 are 15 items, which is what the viewer will say was consumed
        expect(stored().costs.input.units).toBe(3 + 15);
    });
});

describe('transmute: net of the self-returns', () => {
    test('units are attempts minus the input handed back, priced per message', async () => {
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

        // 3 attempts at 50: one garnet, one self-return, one failure -> 2 consumed
        game.inventory[0].count = 98;
        game.inventory[1].count = 1;
        game.actions = [action(3)];
        await transmuteHistoryTracker.handleActionCompleted({
            type: 'action_completed',
            endCharacterAction: action(3),
            endCharacterItems: [stack(11, GEM, 98), stack(12, GARNET, 1)],
        });

        // The price moves; 3 more attempts: two garnets and a failure -> 3 consumed
        game.prices[GEM] = 80;
        game.inventory[0].count = 95;
        game.inventory[1].count = 3;
        game.actions = [action(6)];
        await transmuteHistoryTracker.handleActionCompleted({
            type: 'action_completed',
            endCharacterAction: action(6),
            endCharacterItems: [stack(11, GEM, 95), stack(12, GARNET, 3)],
        });

        const session = stored();
        const selfReturned = session.results[GEM]?.count ?? 0;
        const netConsumed = session.totalAttempts - selfReturned;
        expect(netConsumed).toBe(5);
        expect(session.costs.input).toMatchObject({ cost: 2 * 50 + 3 * 80, units: 5 });
        // What the saved record covers is exactly what the viewer will say was consumed
        const resolved = resolveInputCost(session, netConsumed, () => ({ price: 999, basis: 'current buy' }));
        expect(resolved).toMatchObject({ cost: 340, todayUnits: 0, pricedToday: false });
    });
});
