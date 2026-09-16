/**
 * Coinify and decompose record whatever catalyst was actually in the slot.
 *
 * Both used to test the secondary hash against two constants and add the
 * successes to a matching field. A catalyst outside those two matched neither
 * branch and was recorded as nothing — and nothing reads as free, so the
 * session's profit came out quietly too good. They now record by hrid, measured
 * from the catalyst's own stack, exactly as transmute does, and keep the two old
 * fields populated so stored sessions and the existing readers still work.
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
        save: async () => true,
        clear: async () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { coinifyHistoryTracker } = await import('./coinify-history-tracker.js');
const { decomposeHistoryTracker } = await import('./decompose-history-tracker.js');

const CAPE = '/items/cape';
const ESSENCE = '/items/essence';
const PRIME = '/items/prime_catalyst';
const COINIFICATION = '/items/catalyst_of_coinification';
const DECOMPOSITION = '/items/catalyst_of_decomposition';
/** A catalyst the game added after this code was written. */
const UNKNOWN = '/items/catalyst_of_something_new';

const COIN = '/items/coin';

beforeEach(() => {
    game.items = {
        [CAPE]: {
            name: 'cape',
            itemLevel: 10,
            sellPrice: 10,
            alchemyDetail: {
                bulkMultiplier: 1,
                decomposeItems: [{ itemHrid: ESSENCE, count: 2 }],
            },
        },
        [ESSENCE]: { name: 'essence' },
        [PRIME]: { name: 'prime catalyst' },
        [COINIFICATION]: { name: 'catalyst of coinification' },
        [DECOMPOSITION]: { name: 'catalyst of decomposition' },
        [UNKNOWN]: { name: 'catalyst of something new' },
    };
    game.prices = { [ESSENCE]: 100 };

    for (const tracker of [coinifyHistoryTracker, decomposeHistoryTracker]) {
        tracker.activeSession = null;
        tracker.characterId = 'char-1';
        tracker.lastCurrentCount = null;
        tracker.itemCounts.reset();
    }
});

/** @param {string} hrid - Item @param {number} count - New total @returns {Object} A stack row */
const row = (hrid, count) => ({ id: `stack-${hrid}`, itemHrid: hrid, count });

/**
 * An `action_completed`.
 * @param {string} actionHrid - The alchemy action
 * @param {Object} options - The message's moving parts
 * @param {number} options.currentCount - The action's running count
 * @param {string|null} options.catalyst - Catalyst hrid in the secondary slot
 * @param {Array<Object>} options.items - `endCharacterItems` rows, in the order sent
 * @returns {Object} The message
 */
function message(actionHrid, { currentCount, catalyst, items }) {
    return {
        endCharacterAction: {
            actionHrid,
            primaryItemHash: `char-1::/item_locations/inventory::${CAPE}::0`,
            secondaryItemHash: catalyst ? `char-1::/item_locations/inventory::${catalyst}::0` : null,
            currentCount,
        },
        endCharacterItems: items,
    };
}

describe('coinify', () => {
    /** @param {Object} options - As `message` takes them @returns {Promise<void>} Nothing */
    const play = (options) => coinifyHistoryTracker.handleActionCompleted(message('/actions/alchemy/coinify', options));

    test('a catalyst nobody listed is recorded, not dropped', async () => {
        // Baseline message: no deltas to read yet, so the successes stand in
        await play({ currentCount: 1, catalyst: UNKNOWN, items: [row(COIN, 1000), row(UNKNOWN, 100)] });
        // Three actions, 50 coins each, and three catalysts off the stack
        await play({ currentCount: 4, catalyst: UNKNOWN, items: [row(COIN, 1150), row(UNKNOWN, 97)] });

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalSuccesses).toBe(4);
        expect(session.catalystsUsed).toEqual({ [UNKNOWN]: 4 });
        // It is emphatically not zero, which is what the allowlist recorded
        expect(session.catalystsUsed[UNKNOWN]).toBeGreaterThan(0);
    });

    test('the legacy fields still populate for the two known catalysts', async () => {
        await play({ currentCount: 1, catalyst: PRIME, items: [row(COIN, 1000), row(PRIME, 100)] });
        await play({ currentCount: 3, catalyst: PRIME, items: [row(COIN, 1100), row(PRIME, 98)] });
        await play({ currentCount: 4, catalyst: COINIFICATION, items: [row(COIN, 1150), row(COINIFICATION, 49)] });

        const session = coinifyHistoryTracker.activeSession;
        expect(session.primeCatalystUsed).toBe(3);
        expect(session.catalystOfCoinificationUsed).toBe(1);
        expect(session.catalystsUsed).toEqual({ [PRIME]: 3, [COINIFICATION]: 1 });
    });

    test('a batched message does not multiply the catalyst count', async () => {
        await play({ currentCount: 1, catalyst: PRIME, items: [row(COIN, 1000), row(PRIME, 100)] });
        // The game repeats the catalyst stack once per packed action —
        // successive snapshots of ONE stack, not three spends
        await play({
            currentCount: 4,
            catalyst: PRIME,
            items: [row(COIN, 1050), row(PRIME, 99), row(COIN, 1100), row(PRIME, 98), row(COIN, 1150), row(PRIME, 97)],
        });

        const session = coinifyHistoryTracker.activeSession;
        expect(session.totalSuccesses).toBe(4);
        expect(session.catalystsUsed).toEqual({ [PRIME]: 4 });
        expect(session.primeCatalystUsed).toBe(4);
    });
});

describe('decompose', () => {
    /**
     * @param {Object} options - As `message` takes them
     * @returns {Promise<void>} Nothing
     */
    const play = (options) =>
        decomposeHistoryTracker.handleActionCompleted(message('/actions/alchemy/decompose', options));

    test('a catalyst nobody listed is recorded, not dropped', async () => {
        await play({ currentCount: 1, catalyst: UNKNOWN, items: [row(ESSENCE, 10), row(UNKNOWN, 100)] });
        // Three successes: two essences each, three catalysts off the stack
        await play({ currentCount: 4, catalyst: UNKNOWN, items: [row(ESSENCE, 16), row(UNKNOWN, 97)] });

        const session = decomposeHistoryTracker.activeSession;
        expect(session.totalSuccesses).toBe(4);
        expect(session.catalystsUsed).toEqual({ [UNKNOWN]: 4 });
    });

    test('the legacy fields still populate for the two known catalysts', async () => {
        await play({ currentCount: 1, catalyst: DECOMPOSITION, items: [row(ESSENCE, 10), row(DECOMPOSITION, 100)] });
        await play({ currentCount: 3, catalyst: PRIME, items: [row(ESSENCE, 14), row(PRIME, 48)] });

        const session = decomposeHistoryTracker.activeSession;
        expect(session.catalystOfDecompositionUsed).toBe(1);
        expect(session.primeCatalystUsed).toBe(2);
        expect(session.catalystsUsed).toEqual({ [DECOMPOSITION]: 1, [PRIME]: 2 });
    });

    test('a batched message does not multiply the catalyst count', async () => {
        await play({ currentCount: 1, catalyst: PRIME, items: [row(ESSENCE, 10), row(PRIME, 100)] });
        await play({
            currentCount: 4,
            catalyst: PRIME,
            items: [
                row(ESSENCE, 12),
                row(PRIME, 99),
                row(ESSENCE, 14),
                row(PRIME, 98),
                row(ESSENCE, 16),
                row(PRIME, 97),
            ],
        });

        expect(decomposeHistoryTracker.activeSession.catalystsUsed).toEqual({ [PRIME]: 4 });
        expect(decomposeHistoryTracker.activeSession.primeCatalystUsed).toBe(4);
    });

    test('a catalyst stack that moved for some other reason falls back to the successes', async () => {
        await play({ currentCount: 1, catalyst: PRIME, items: [row(ESSENCE, 10), row(PRIME, 100)] });
        // The player bought catalysts mid-run: the stack went UP, which says
        // nothing about what this action spent
        await play({ currentCount: 3, catalyst: PRIME, items: [row(ESSENCE, 14), row(PRIME, 900)] });

        expect(decomposeHistoryTracker.activeSession.catalystsUsed).toEqual({ [PRIME]: 3 });
    });
});
