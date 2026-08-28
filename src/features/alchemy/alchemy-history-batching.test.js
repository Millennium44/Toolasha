/**
 * What a batched message actually says, and when a session gets written.
 *
 * Two things were read wrong:
 *
 * - Successes were counted by how many item STACKS a message changed.
 *   `endCharacterItems` carries one row per changed stack holding that stack's
 *   new absolute total, so a batch of efficiency procs arrives as one row —
 *   and for coinify, whose output is coins, one row is all there can ever be.
 *   The attempt count was already derived from a delta for exactly that reason;
 *   the successes were not, so a five-proc batch scored 1/5.
 * - `disable()` did not await `endSession()`. The write resumed after the
 *   character id had been nulled and landed under the 'default' scope, over
 *   whatever was there.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, prices: {} }));

const store = vi.hoisted(() => {
    const saved = [];
    return {
        saved,
        reset: () => {
            saved.length = 0;
        },
        forgotten: 0,
    };
});

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
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
        save: async (scope, sessions) => {
            store.saved.push({ scope, sessions: structuredClone(sessions) });
        },
        clear: async () => {},
        setCharacter: () => {},
        forget: () => {
            store.forgotten += 1;
        },
    }),
    NO_CHARACTER: 'none',
}));

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');
const { createItemCountLedger } = await import('./alchemy-item-deltas.js');

/** Coins per success for this item: sellPrice 100 x 5 x bulk 1 = 500 */
const COINIFY_ITEM = { itemLevel: 10, sellPrice: 100, alchemyDetail: { bulkMultiplier: 1 } };

beforeEach(() => {
    game.items = {
        '/items/thing': structuredClone(COINIFY_ITEM),
        '/items/gem': {
            itemLevel: 10,
            sellPrice: 50,
            alchemyDetail: {
                bulkMultiplier: 1,
                transmuteDropTable: [{ itemHrid: '/items/shard' }, { itemHrid: '/items/gem' }],
            },
        },
        '/items/ore': {
            itemLevel: 10,
            sellPrice: 10,
            alchemyDetail: {
                bulkMultiplier: 1,
                decomposeItems: [{ itemHrid: '/items/dust', count: 1 }],
            },
        },
    };
    game.prices = { '/items/shard': 700, '/items/dust': 20 };
    store.reset();
    store.forgotten = 0;
    coinifyHistoryTracker.activeSession = null;
    coinifyHistoryTracker.characterId = 'char-1';
    transmuteHistoryTracker.activeSession = null;
    transmuteHistoryTracker.characterId = 'char-1';
    decomposeHistoryTracker.activeSession = null;
    decomposeHistoryTracker.characterId = 'char-1';
});

/**
 * A coinify action_completed message.
 * @param {number} currentCount - The action's running count
 * @param {number|null} coins - The coin stack's new total, or null for no coin row
 * @returns {Object} The message
 */
function coinifyMessage(currentCount, coins) {
    return {
        endCharacterAction: {
            actionHrid: '/actions/alchemy/coinify',
            primaryItemHash: 'char-1::/item_locations/inventory::/items/thing::0',
            currentCount,
        },
        endCharacterItems: coins === null ? [] : [{ id: 'coinstack', itemHrid: '/items/coin', count: coins }],
    };
}

describe('the count ledger', () => {
    test('a stack seen for the first time has no delta to give', () => {
        const ledger = createItemCountLedger();
        expect(ledger.note([{ id: 1, count: 500 }])).toBe(null);
    });

    test('afterwards it hands back the gain, not the total', () => {
        const ledger = createItemCountLedger();
        ledger.note([{ id: 1, count: 500 }]);
        expect(ledger.note([{ id: 1, count: 2500 }])).toBe(2000);
    });

    test('a reset drops the baselines, as a new session must', () => {
        const ledger = createItemCountLedger();
        ledger.note([{ id: 1, count: 500 }]);
        ledger.reset();
        expect(ledger.note([{ id: 1, count: 2500 }])).toBe(null);
    });

    test('rows are reported one by one, so a caller can tell which stack moved', () => {
        const ledger = createItemCountLedger();
        ledger.noteEach([{ id: 'a', count: 10 }]);
        const seen = ledger.noteEach([
            { id: 'a', count: 14 },
            { id: 'b', count: 3 },
        ]);
        expect(seen.map((entry) => entry.delta)).toEqual([4, null]);
    });
});

describe('coinify: successes come from the coins gained', () => {
    test('a batch of five procs on one coin stack is five successes, not one', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, 1000);

        // First message establishes both baselines
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(1, 500));
        expect(coinifyHistoryTracker.activeSession.totalSuccesses).toBe(1);

        // Then one message covering five attempts, all of which paid out:
        // the coin stack rose by 5 x 500 while currentCount rose by 5
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(6, 500 + 2500));

        expect(coinifyHistoryTracker.activeSession.totalAttempts).toBe(6);
        expect(coinifyHistoryTracker.activeSession.totalSuccesses).toBe(6);
        expect(coinifyHistoryTracker.activeSession.totalCoinsEarned).toBe(6 * 500);
    });

    test('a partly successful batch is scored by the coins, not the row', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, 1000);
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(1, 500));

        // Five more attempts, two of which paid
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(6, 500 + 1000));

        expect(coinifyHistoryTracker.activeSession.totalAttempts).toBe(6);
        expect(coinifyHistoryTracker.activeSession.totalSuccesses).toBe(3);
    });

    test('a failed batch scores nothing even though the coin row is still there', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, 1000);
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(1, 500));

        // The coin stack did not move — the game re-sent the row unchanged
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(4, 500));

        expect(coinifyHistoryTracker.activeSession.totalAttempts).toBe(4);
        expect(coinifyHistoryTracker.activeSession.totalSuccesses).toBe(1);
    });

    test('successes never outnumber the attempts they came from', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, 1000);
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(1, 500));

        // A coin gain from somewhere else entirely, on a single attempt
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(2, 500 + 9_000_000));

        expect(coinifyHistoryTracker.activeSession.totalSuccesses).toBe(2);
    });

    test('a new session measures from scratch rather than against the old baseline', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, 1000);
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(1, 500));

        await coinifyHistoryTracker.startSession('/items/thing', 0, 2000);
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(1, 9_999_999));

        expect(coinifyHistoryTracker.activeSession.totalSuccesses).toBe(1);
    });

    test('a missing sellPrice is logged rather than silently costed as free', async () => {
        game.items['/items/unpriced'] = { itemLevel: 10, sellPrice: 0, alchemyDetail: { bulkMultiplier: 1 } };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await coinifyHistoryTracker.startSession('/items/unpriced', 0, 1000);

        expect(coinifyHistoryTracker.activeSession.coinsPerSuccess).toBe(0);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('no sellPrice'));
        errorSpy.mockRestore();
    });
});

describe('transmute: successes come from the output counts', () => {
    /**
     * A transmute action_completed message.
     * @param {number} currentCount - The action's running count
     * @param {Array<Object>} rows - endCharacterItems rows
     * @returns {Object} The message
     */
    function message(currentCount, rows) {
        return {
            endCharacterAction: {
                actionHrid: '/actions/alchemy/transmute',
                primaryItemHash: 'char-1::/item_locations/inventory::/items/gem::0',
                currentCount,
            },
            endCharacterItems: rows,
        };
    }

    test('a batch of four procs on one output stack is four successes', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', 1000);

        await transmuteHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'shards', itemHrid: '/items/shard', count: 10 }])
        );
        expect(transmuteHistoryTracker.activeSession.totalSuccesses).toBe(1);

        // Four more attempts, all producing a shard: one row, count up by four
        await transmuteHistoryTracker.handleActionCompleted(
            message(5, [{ id: 'shards', itemHrid: '/items/shard', count: 14 }])
        );

        expect(transmuteHistoryTracker.activeSession.totalAttempts).toBe(5);
        expect(transmuteHistoryTracker.activeSession.totalSuccesses).toBe(5);
        expect(transmuteHistoryTracker.activeSession.results['/items/shard'].count).toBe(5);
        expect(transmuteHistoryTracker.activeSession.results['/items/shard'].totalValue).toBe(5 * 700);
    });

    test('a bulk recipe counts actions, not items', async () => {
        game.items['/items/gem'].alchemyDetail.bulkMultiplier = 5;
        await transmuteHistoryTracker.startSession('/items/gem', 1000);

        // The first message has no baseline, so it can only be read as one action
        await transmuteHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'shards', itemHrid: '/items/shard', count: 5 }])
        );
        const before = transmuteHistoryTracker.activeSession.totalSuccesses;
        const held = transmuteHistoryTracker.activeSession.results['/items/shard'].count;

        // Then three actions at five items apiece, in one message
        await transmuteHistoryTracker.handleActionCompleted(
            message(4, [{ id: 'shards', itemHrid: '/items/shard', count: 20 }])
        );

        expect(transmuteHistoryTracker.activeSession.totalSuccesses - before).toBe(3);
        expect(transmuteHistoryTracker.activeSession.results['/items/shard'].count - held).toBe(15);
    });

    test('an unmoved output row is a failed batch', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', 1000);
        await transmuteHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'shards', itemHrid: '/items/shard', count: 10 }])
        );

        await transmuteHistoryTracker.handleActionCompleted(
            message(4, [{ id: 'shards', itemHrid: '/items/shard', count: 10 }])
        );

        expect(transmuteHistoryTracker.activeSession.totalAttempts).toBe(4);
        expect(transmuteHistoryTracker.activeSession.totalSuccesses).toBe(1);
    });

    test('a self-return is read from what is left of the input, not from a second row', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', 1000);
        await transmuteHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'gems', itemHrid: '/items/gem', count: 100 }])
        );

        // The first message only set the baseline: with nothing to compare the
        // input stack against, a self-return cannot be told from plain
        // consumption, and is not counted.
        expect(transmuteHistoryTracker.activeSession.totalSuccesses).toBe(0);

        // Four attempts consume four gems; two of them handed the gem back,
        // so the stack fell by two rather than by four
        await transmuteHistoryTracker.handleActionCompleted(
            message(5, [{ id: 'gems', itemHrid: '/items/gem', count: 98 }])
        );

        expect(transmuteHistoryTracker.activeSession.totalAttempts).toBe(5);
        expect(transmuteHistoryTracker.activeSession.totalSuccesses).toBe(2);
        expect(transmuteHistoryTracker.activeSession.results['/items/gem'].count).toBe(2);
        expect(transmuteHistoryTracker.activeSession.results['/items/gem'].isSelfReturn).toBe(true);
    });

    test('drops that are not in the table are still ignored', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', 1000);
        await transmuteHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'essence', itemHrid: '/items/essence', count: 5 }])
        );
        await transmuteHistoryTracker.handleActionCompleted(
            message(4, [{ id: 'essence', itemHrid: '/items/essence', count: 9 }])
        );

        expect(transmuteHistoryTracker.activeSession.totalSuccesses).toBe(0);
        expect(transmuteHistoryTracker.activeSession.results['/items/essence']).toBeUndefined();
    });
});

describe('decompose: successes come from the output counts, not the row count', () => {
    /**
     * A decompose action_completed message.
     * @param {number} currentCount - The action's running count
     * @param {Array<Object>} rows - endCharacterItems rows
     * @returns {Object} The message
     */
    function message(currentCount, rows) {
        return {
            endCharacterAction: {
                actionHrid: '/actions/alchemy/decompose',
                primaryItemHash: 'char-1::/item_locations/inventory::/items/ore::0',
                currentCount,
            },
            endCharacterItems: rows,
        };
    }

    test('a single message batching five successes counts them all, not one', async () => {
        await decomposeHistoryTracker.startSession('/items/ore', 0, 1000);

        // First message only sets the dust stack's baseline
        await decomposeHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'dust', itemHrid: '/items/dust', count: 10 }])
        );
        expect(decomposeHistoryTracker.activeSession.totalSuccesses).toBe(1);

        // Five more attempts, all producing dust: one row, count up by five
        await decomposeHistoryTracker.handleActionCompleted(
            message(6, [{ id: 'dust', itemHrid: '/items/dust', count: 15 }])
        );

        expect(decomposeHistoryTracker.activeSession.totalAttempts).toBe(6);
        expect(decomposeHistoryTracker.activeSession.totalSuccesses).toBe(6);
        expect(decomposeHistoryTracker.activeSession.results['/items/dust'].count).toBe(6);
        expect(decomposeHistoryTracker.activeSession.results['/items/dust'].totalValue).toBe(6 * 20);
    });

    test('a partly successful batch is scored by the dust gained, not by the row', async () => {
        await decomposeHistoryTracker.startSession('/items/ore', 0, 1000);
        await decomposeHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'dust', itemHrid: '/items/dust', count: 10 }])
        );

        // Five more attempts, three of which paid out
        await decomposeHistoryTracker.handleActionCompleted(
            message(6, [{ id: 'dust', itemHrid: '/items/dust', count: 13 }])
        );

        expect(decomposeHistoryTracker.activeSession.totalAttempts).toBe(6);
        expect(decomposeHistoryTracker.activeSession.totalSuccesses).toBe(4);
    });

    test('an unmoved output row is a failed batch', async () => {
        await decomposeHistoryTracker.startSession('/items/ore', 0, 1000);
        await decomposeHistoryTracker.handleActionCompleted(
            message(1, [{ id: 'dust', itemHrid: '/items/dust', count: 10 }])
        );

        await decomposeHistoryTracker.handleActionCompleted(
            message(4, [{ id: 'dust', itemHrid: '/items/dust', count: 10 }])
        );

        expect(decomposeHistoryTracker.activeSession.totalAttempts).toBe(4);
        expect(decomposeHistoryTracker.activeSession.totalSuccesses).toBe(1);
    });

    test('multiple decompose outputs agree on one success count rather than stacking', async () => {
        game.items['/items/ore'].alchemyDetail.decomposeItems = [
            { itemHrid: '/items/dust', count: 1 },
            { itemHrid: '/items/shard', count: 1 },
        ];
        await decomposeHistoryTracker.startSession('/items/ore', 0, 1000);
        await decomposeHistoryTracker.handleActionCompleted(
            message(1, [
                { id: 'dust', itemHrid: '/items/dust', count: 10 },
                { id: 'shards', itemHrid: '/items/shard', count: 10 },
            ])
        );

        // Five more successes, both outputs rise together by five
        await decomposeHistoryTracker.handleActionCompleted(
            message(6, [
                { id: 'dust', itemHrid: '/items/dust', count: 15 },
                { id: 'shards', itemHrid: '/items/shard', count: 15 },
            ])
        );

        // If both rows' deltas were summed instead of taking the max, this
        // would read as 10 successes instead of 5
        expect(decomposeHistoryTracker.activeSession.totalSuccesses).toBe(6);
    });
});

describe('disable() finishes the session before it lets go of the character', () => {
    test('coinify saves under the character’s scope, not the default one', async () => {
        await coinifyHistoryTracker.startSession('/items/thing', 0, 1000);
        await coinifyHistoryTracker.handleActionCompleted(coinifyMessage(1, 500));
        store.reset();

        await coinifyHistoryTracker.disable();

        expect(store.saved.length).toBeGreaterThan(0);
        expect(store.saved.every((entry) => entry.scope === 'char-1')).toBe(true);
        expect(coinifyHistoryTracker.characterId).toBe(null);
        expect(coinifyHistoryTracker.activeSession).toBe(null);
    });

    test('transmute does the same', async () => {
        await transmuteHistoryTracker.startSession('/items/gem', 1000);
        await transmuteHistoryTracker.handleActionCompleted({
            endCharacterAction: {
                actionHrid: '/actions/alchemy/transmute',
                primaryItemHash: 'char-1::/item_locations/inventory::/items/gem::0',
                currentCount: 1,
            },
            endCharacterItems: [{ id: 'shards', itemHrid: '/items/shard', count: 10 }],
        });
        store.reset();

        await transmuteHistoryTracker.disable();

        expect(store.saved.length).toBeGreaterThan(0);
        expect(store.saved.every((entry) => entry.scope === 'char-1')).toBe(true);
        expect(transmuteHistoryTracker.characterId).toBe(null);
    });
});
