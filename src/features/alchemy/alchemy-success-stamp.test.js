/** @vitest-environment happy-dom */

/**
 * The predicted success rate, written down while it is still true.
 *
 * The one thing this must never do is supply a prediction after the fact. A
 * session recorded before stamping existed ran under a tea, a catalyst and a
 * level penalty that are all gone; handing it today's number and calling the
 * comparison calibration would measure the model's history rather than its
 * accuracy. So the assertions are as much about what is NOT stamped as about
 * what is.
 *
 * The rate itself comes from the calculator the profit rankings use rather than
 * from a second copy of the formula — a copy could drift, and then the panel
 * would be judging a model nobody ever quoted.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ items: {}, alchemyLevel: 99, teaBonus: 0 }));
const store = vi.hoisted(() => ({ saved: [], stored: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_id, fallback) => fallback },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: () => {}, off: () => {}, onSocketEvent: () => {}, offSocketEvent: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (hrid) => game.items[hrid] ?? null,
        getInitClientData: () => ({ itemDetailMap: game.items }),
        getSkills: () => [{ skillHrid: '/skills/alchemy', level: game.alchemyLevel }],
        getCurrentCharacterId: () => 'char-1',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: () => 0,
    getItemPrices: () => null,
    getPricingMode: () => 'ask',
}));
vi.mock('../../utils/buff-parser.js', () => ({
    getAlchemySuccessBonus: () => game.teaBonus,
    getBuffValue: () => 0,
}));
vi.mock('./alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({
        load: async () => structuredClone(store.stored),
        save: async (scope, sessions) => {
            store.saved.push({ scope, sessions: structuredClone(sessions) });
        },
        clear: async () => {},
        forget: () => {},
    }),
    NO_CHARACTER: 'none',
}));

const { predictedSuccessStamp, readLiveCatalyst } = await import('./alchemy-success-stamp.js');
// The stamp asks the calculator for the base rates and catalyst bonuses rather
// than keeping copies, so those are asserted where they live
const { default: alchemyProfitCalculator } = await import('../market/alchemy-profit-calculator.js');
const { transmuteHistoryTracker } = await import('./transmute-history-tracker.js');

/**
 * Put a catalyst in the action panel's slot.
 * @param {string|null} icon - Sprite id, or null for an empty slot
 */
const setCatalystSlot = (icon) => {
    document.body.innerHTML = icon
        ? `<div class="SkillActionDetail_catalystItemInputContainer">
               <div class="Item_itemContainer"><svg><use xlink:href="/sprites.svg#${icon}"></use></svg></div>
           </div>`
        : '';
};

beforeEach(() => {
    game.items = {
        '/items/gem': { itemLevel: 10, alchemyDetail: { transmuteSuccessRate: 0.5, bulkMultiplier: 1 } },
        '/items/plain': { itemLevel: 10, alchemyDetail: { bulkMultiplier: 1 } },
    };
    game.alchemyLevel = 99;
    game.teaBonus = 0;
    store.saved = [];
    store.stored = [];
    setCatalystSlot(null);
});

describe('the pieces of the stamp', () => {
    test('reads the base rate each kind actually uses', () => {
        const rate = (kind, item) => alchemyProfitCalculator.baseSuccessRateFor(kind, item);
        expect(rate('transmute', game.items['/items/gem'])).toBe(0.5);
        expect(rate('decompose', game.items['/items/gem'])).toBe(0.6);
        expect(rate('coinify', game.items['/items/gem'])).toBe(0.7);
        // An item with no transmute drop table has no transmute rate at all
        expect(rate('transmute', game.items['/items/plain'])).toBe(0);
        expect(rate('nonsense', game.items['/items/gem'])).toBe(0);
    });

    test('prices the catalyst in the slot, and only a real one', () => {
        const bonus = (hrid) => alchemyProfitCalculator.catalystSuccessBonus(hrid);
        expect(bonus(null)).toBe(0);
        expect(bonus('/items/catalyst_of_transmutation')).toBe(0.15);
        expect(bonus('/items/prime_catalyst')).toBe(0.25);
        expect(bonus('/items/cheese')).toBe(0);
    });

    test('finds the catalyst on xlink:href, which is where item icons carry it', () => {
        setCatalystSlot('prime_catalyst');
        expect(readLiveCatalyst()).toBe('/items/prime_catalyst');
        setCatalystSlot('cheese');
        expect(readLiveCatalyst()).toBeNull();
        setCatalystSlot(null);
        expect(readLiveCatalyst()).toBeNull();
    });
});

describe('predictedSuccessStamp', () => {
    test('is the calculator’s own number, with the live tea, catalyst and penalty in it', () => {
        game.teaBonus = 0.05;
        setCatalystSlot('prime_catalyst');

        const stamp = predictedSuccessStamp('transmute', '/items/gem', 1234);

        // base 0.5 x (1 + 0.25 catalyst + 0.05 tea) = 0.65
        expect(stamp.predictedRate).toBeCloseTo(0.65);
        expect(stamp.predictedAt).toBe(1234);
        expect(stamp.predictedCatalystHrid).toBe('/items/prime_catalyst');
    });

    test('carries the under-level penalty, which keys off the item and not the action', () => {
        game.alchemyLevel = 5;
        // perLevel 0.9/10 x (5 - 10) = -0.45, so 0.7 x 0.55
        const stamp = predictedSuccessStamp('coinify', '/items/gem', 1);
        expect(stamp.predictedRate).toBeCloseTo(0.385);
    });

    test('refuses rather than stamping a zero when there is no rate to predict', () => {
        expect(predictedSuccessStamp('transmute', '/items/plain', 1)).toBeNull();
        expect(predictedSuccessStamp('transmute', '/items/missing', 1)).toBeNull();
        expect(predictedSuccessStamp('nonsense', '/items/gem', 1)).toBeNull();
    });
});

describe('stamping a session', () => {
    test('is done at the start, out of the setup the run is played with', async () => {
        game.teaBonus = 0.1;
        setCatalystSlot('catalyst_of_transmutation');

        await transmuteHistoryTracker.startSession('/items/gem', 5_000);

        // 0.5 x (1 + 0.15 + 0.1)
        expect(transmuteHistoryTracker.activeSession.predictedRate).toBeCloseTo(0.625);
        expect(transmuteHistoryTracker.activeSession.predictedAt).toBe(5_000);
        expect(transmuteHistoryTracker.activeSession.predictedCatalystHrid).toBe('/items/catalyst_of_transmutation');

        // The rate the session is judged against is the one it started with,
        // however the setup changes underneath it afterwards
        game.teaBonus = 0.4;
        setCatalystSlot(null);
        transmuteHistoryTracker.activeSession.totalAttempts = 3;
        await transmuteHistoryTracker.saveActiveSession();

        const [write] = store.saved;
        expect(write.sessions.at(-1).predictedRate).toBeCloseTo(0.625);
    });

    test('leaves a session that has no stamp without one, forever', async () => {
        // A session from before stamping existed, already on disk
        store.stored = [
            { id: 'transmute_1', startTime: 1, inputItemHrid: '/items/gem', totalAttempts: 900, totalSuccesses: 300 },
        ];

        await transmuteHistoryTracker.startSession('/items/gem', 9_000);
        transmuteHistoryTracker.activeSession.totalAttempts = 4;
        await transmuteHistoryTracker.saveActiveSession();

        const written = store.saved.at(-1).sessions;
        const old = written.find((entry) => entry.id === 'transmute_1');
        const fresh = written.find((entry) => entry.id === 'transmute_9000');

        // The old one is written back untouched: no prediction is invented for it
        expect(old.predictedRate).toBeUndefined();
        expect(old.predictedAt).toBeUndefined();
        expect(fresh.predictedRate).toBeCloseTo(0.5);
    });

    test('records a null rather than a wrong number when the rate cannot be had', async () => {
        await transmuteHistoryTracker.startSession('/items/plain', 7_000);
        expect(transmuteHistoryTracker.activeSession.predictedRate).toBeNull();
        expect(transmuteHistoryTracker.activeSession.predictedCatalystHrid).toBeNull();
    });
});
