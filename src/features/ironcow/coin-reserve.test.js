/**
 * The gold the queue needs on hand, walked through the real action-time engine.
 *
 * The engine is the one the queue tooltip uses; what is mocked is the game under
 * it. With no alchemy calculator behind it the engine falls back to the base
 * success rates, 60% decompose and 70% coinify, which keeps every figure below a
 * hand-computable one:
 *
 *  - Star Fruit: level 80, two to a decompose action, ten essence each on a
 *    success → fee (10 + 80) × 5 × 2 = **900 an action**, 2 × 10 × 0.6 = **12
 *    essence an action**.
 *  - Foraging Essence: sell price 50, ten to a coinify action → 50 × 10 × 5 ×
 *    0.7 = **1,750 coins an action**.
 *
 * @vitest-environment happy-dom
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    currentActions: [],
    actionDetails: {},
    itemDetails: {},
    inventory: [],
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentActions: () => game.currentActions,
        getActionDetails: (hrid) => game.actionDetails[hrid] ?? null,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetails }),
        getActionDrinkSlots: () => [],
        getElapsedSecondsInCurrentUnit: () => 0,
        getSkills: () => [],
        getEquipment: () => [],
        on: () => () => {},
    },
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => ({ actionTime: 10, totalEfficiency: 0 }),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_TOOLTIP_INFO: '#abc',
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: { isLoaded: () => true, getPrice: () => null, on: () => () => {} },
}));
vi.mock('../actions/gathering-profit.js', () => ({ calculateGatheringProfit: async () => null }));
vi.mock('../market/profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: { calculate: async () => null } }));
vi.mock('../enhancement/enhancement-xp.js', () => ({ calculateEnhancementPredictions: () => null }));

const { default: engine } = await import('../actions/action-time-display.js');
const { walkQueueCoins, coinReserve, bellsAffordable, COWBELLS_PER_BAG } = await import('./coin-reserve.js');

const STAR_FRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const COIN = '/items/coin';
const FORAGE = '/actions/foraging/star_fruit';
const DECOMPOSE = '/actions/alchemy/decompose';
const COINIFY = '/actions/alchemy/coinify';

const FEE_PER_DECOMPOSE = 900;
const ESSENCE_PER_DECOMPOSE = 12;
const COINS_PER_COINIFY = 1750;

/** A bag row in the one location the ledger counts */
const stack = (itemHrid, count) => ({
    itemHrid,
    count,
    enhancementLevel: 0,
    itemLocationHrid: '/item_locations/inventory',
});

/**
 * A queued action as `actions_updated` carries one.
 * @param {number} ordinal - Queue position; lower runs first
 * @param {string} actionHrid - Full action hrid
 * @param {Object} [options] - `item` for the alchemy slot, `maxCount`/`currentCount` for a counted row
 * @returns {Object} The action
 */
function queued(ordinal, actionHrid, { item = null, maxCount, currentCount = 0 } = {}) {
    return {
        id: 1000 + ordinal,
        characterID: 42,
        partyID: 0,
        actionHrid,
        difficultyTier: 0,
        primaryItemHash: item ? `42::/item_locations/inventory::${item}::0` : '',
        secondaryItemHash: '',
        hasMaxCount: maxCount !== undefined,
        maxCount: maxCount ?? 0,
        currentCount,
        isDone: false,
        ordinal,
    };
}

beforeEach(() => {
    game.itemDetails = {
        [STAR_FRUIT]: {
            hrid: STAR_FRUIT,
            name: 'Star Fruit',
            itemLevel: 80,
            sellPrice: 40,
            alchemyDetail: { bulkMultiplier: 2, decomposeItems: [{ itemHrid: ESSENCE, count: 10 }] },
        },
        [ESSENCE]: {
            hrid: ESSENCE,
            name: 'Foraging Essence',
            itemLevel: 40,
            sellPrice: 50,
            alchemyDetail: { bulkMultiplier: 10, isCoinifiable: true },
        },
        [COIN]: { hrid: COIN, name: 'Coin' },
    };
    game.actionDetails = {
        [FORAGE]: {
            hrid: FORAGE,
            name: 'Star Fruit',
            type: '/action_types/foraging',
            dropTable: [{ itemHrid: STAR_FRUIT, dropRate: 1, minCount: 1, maxCount: 1 }],
        },
        [DECOMPOSE]: { hrid: DECOMPOSE, name: 'Decompose', type: '/action_types/alchemy' },
        [COINIFY]: { hrid: COINIFY, name: 'Coinify', type: '/action_types/alchemy' },
    };
    game.inventory = [stack(COIN, 1_000_000), stack(STAR_FRUIT, 1000)];
    game.currentActions = [];
});

describe('walking the queue for its coin flow', () => {
    test('decompose then coinify: the reserve is the whole decompose bill, paid before coinify earns', () => {
        // The live loop: a counted decompose part-way through, coinify ∞, then forage ∞
        game.currentActions = [
            queued(3, FORAGE),
            queued(2, COINIFY, { item: ESSENCE }),
            queued(1, DECOMPOSE, { item: STAR_FRUIT, maxCount: 600, currentCount: 100 }),
        ];

        const walked = walkQueueCoins(engine);

        expect(walked.stages.map((stage) => [stage.actionHrid, stage.count])).toEqual([
            [DECOMPOSE, 500],
            // ∞ coinify runs to its mat limit: the essence the decompose ahead of it makes
            [COINIFY, (500 * ESSENCE_PER_DECOMPOSE) / 10],
        ]);
        expect(walked.stages[0].coinDelta).toBeCloseTo(-500 * FEE_PER_DECOMPOSE, 3);
        // Recorded, but not counted on: coinify rolls can fail
        expect(walked.stages[1].coinDelta).toBe(0);
        expect(walked.stages[1].earned).toBeCloseTo(600 * COINS_PER_COINIFY, 3);
        // Forage ∞ never ends, so nothing after it is reachable
        expect(walked.stoppedAt).toBe('Star Fruit');

        const { reserve, spenders } = coinReserve(walked.stages);
        expect(reserve).toBeCloseTo(450_000, 3);
        expect(spenders).toEqual(['Decompose: Star Fruit']);
    });

    test('a decompose ∞ runs to the fruit it has, and is never cut short by the coins on hand', () => {
        // 1,000 fruit is 500 actions; 900 coins would stop the game after one
        game.inventory = [stack(COIN, 900), stack(STAR_FRUIT, 1000)];
        game.currentActions = [queued(1, DECOMPOSE, { item: STAR_FRUIT })];

        const walked = walkQueueCoins(engine);

        expect(walked.stages[0].count).toBe(500);
        expect(coinReserve(walked.stages).reserve).toBeCloseTo(450_000, 3);
    });

    test('coinify first: its expected earnings do not fund the decompose behind it', () => {
        game.inventory = [stack(COIN, 1_000_000), stack(STAR_FRUIT, 1000), stack(ESSENCE, 2000)];
        game.currentActions = [
            queued(1, COINIFY, { item: ESSENCE, maxCount: 200 }),
            queued(2, DECOMPOSE, { item: STAR_FRUIT, maxCount: 500 }),
        ];

        const { reserve } = coinReserve(walkQueueCoins(engine).stages);

        // 200 coinify are expected to pay 350,000, but a failed roll pays nothing: the whole bill is kept
        expect(reserve).toBeCloseTo(450_000, 3);
    });

    test('no decompose queued: nothing spends, so nothing is held back', () => {
        game.inventory = [stack(COIN, 1_000_000), stack(ESSENCE, 2000)];
        game.currentActions = [queued(1, COINIFY, { item: ESSENCE }), queued(2, FORAGE)];

        const walked = walkQueueCoins(engine);

        expect(walked.stages.every((stage) => stage.coinDelta >= 0)).toBe(true);
        expect(coinReserve(walked.stages)).toEqual({ reserve: 0, spenders: [], estimated: false });
    });

    test('a counted decompose behind a counted fight, which its loot could feed, makes the walk unreadable', () => {
        game.actionDetails['/actions/combat/fly'] = {
            hrid: '/actions/combat/fly',
            name: 'Fly',
            type: '/action_types/combat',
        };
        game.currentActions = [
            queued(1, '/actions/combat/fly', { maxCount: 50 }),
            queued(2, DECOMPOSE, { item: STAR_FRUIT, maxCount: 500 }),
        ];

        expect(walkQueueCoins(engine)).toBeNull();
    });

    test('a free coinify behind a counted fight is walked through: loot cannot raise what it costs', () => {
        game.actionDetails['/actions/combat/fly'] = {
            hrid: '/actions/combat/fly',
            name: 'Fly',
            type: '/action_types/combat',
        };
        game.inventory = [stack(COIN, 1_000_000), stack(ESSENCE, 2000)];
        game.currentActions = [
            queued(1, '/actions/combat/fly', { maxCount: 50 }),
            queued(2, COINIFY, { item: ESSENCE, maxCount: 100 }),
        ];

        const walked = walkQueueCoins(engine);

        expect(walked).not.toBeNull();
        expect(coinReserve(walked.stages).reserve).toBe(0);
    });

    test('a counted fight ahead of a row that pays no gold is walked through, not taken as the end', () => {
        game.actionDetails['/actions/combat/fly'] = {
            hrid: '/actions/combat/fly',
            name: 'Fly',
            type: '/action_types/combat',
        };
        game.currentActions = [
            queued(1, '/actions/combat/fly', { maxCount: 50 }),
            queued(2, FORAGE, { maxCount: 100 }),
        ];

        const walked = walkQueueCoins(engine);

        expect(walked.stoppedAt).toBeNull();
        expect(walked.stages.map((stage) => stage.actionHrid)).toEqual(['/actions/combat/fly', FORAGE]);
        expect(coinReserve(walked.stages).reserve).toBe(0);
    });

    test('a spending row limited by materials the engine only expects makes the reserve an estimate', () => {
        game.currentActions = [queued(1, DECOMPOSE, { item: STAR_FRUIT })];
        const original = engine.calculateSingleQueueActionTime.bind(engine);
        const spy = vi
            .spyOn(engine, 'calculateSingleQueueActionTime')
            .mockImplementation((...args) => ({ ...original(...args), materialLimitIsEstimated: true }));
        try {
            const walked = walkQueueCoins(engine);
            expect(walked.stages[0].estimated).toBe(true);
            expect(coinReserve(walked.stages).estimated).toBe(true);
        } finally {
            spy.mockRestore();
        }
    });

    test('discarded coinify proceeds leave no estimate mark on the decompose after them', () => {
        game.inventory = [stack(COIN, 1_000_000), stack(STAR_FRUIT, 1000), stack(ESSENCE, 2000)];
        game.currentActions = [
            queued(1, COINIFY, { item: ESSENCE, maxCount: 200 }),
            queued(2, DECOMPOSE, { item: STAR_FRUIT }),
        ];

        const walked = walkQueueCoins(engine);

        expect(walked.stages[0].earned).toBeGreaterThan(0);
        expect(coinReserve(walked.stages)).toMatchObject({ reserve: 450_000, estimated: false });
    });

    test('an uncounted spender behind a counted fight, which could run on its loot, makes the walk unreadable', () => {
        game.actionDetails['/actions/combat/fly'] = {
            hrid: '/actions/combat/fly',
            name: 'Fly',
            type: '/action_types/combat',
        };
        game.currentActions = [
            queued(1, '/actions/combat/fly', { maxCount: 50 }),
            queued(2, DECOMPOSE, { item: STAR_FRUIT }),
        ];

        expect(walkQueueCoins(engine)).toBeNull();
    });

    test('a paid row whose catalyst sets its count makes the reserve an estimate', () => {
        const engineStub = {
            buildInventoryLookup: () => ({ byHrid: {}, byEnhancedKey: {}, estimatedHrids: new Set() }),
            calculateSingleQueueActionTime: () => ({ limitType: '/items/x', isTrulyInfinite: false }),
            deductQueueActionMaterials: (ledger) => {
                ledger.byHrid[COIN] -= 900;
                return 1;
            },
        };
        const catalyst = '42::/item_locations/inventory::/items/catalyst_of_decomposition::0';
        game.currentActions = [{ ...queued(1, DECOMPOSE, { item: STAR_FRUIT }), secondaryItemHash: catalyst }];

        engineStub.calculateSingleQueueActionTime = () => ({
            limitType: 'material:/items/catalyst_of_decomposition',
            isTrulyInfinite: false,
        });
        expect(walkQueueCoins(engineStub).stages[0].estimated).toBe(true);

        // Limited by the fruit instead: the count is exact
        engineStub.calculateSingleQueueActionTime = () => ({
            limitType: 'material:/items/star_fruit',
            isTrulyInfinite: false,
        });
        expect(walkQueueCoins(engineStub).stages[0].estimated).toBe(false);
    });

    test('a paid row behind an unrefine, whose returned item the walk does not credit, makes it unreadable', () => {
        const UNREFINE = '/actions/alchemy/unrefine';
        game.actionDetails[UNREFINE] = { hrid: UNREFINE, name: 'Unrefine', type: '/action_types/alchemy' };
        game.currentActions = [
            queued(1, UNREFINE, { item: STAR_FRUIT, maxCount: 1 }),
            queued(2, DECOMPOSE, { item: STAR_FRUIT, maxCount: 500 }),
        ];

        expect(walkQueueCoins(engine)).toBeNull();
    });

    test('a queued action the game data does not know makes the walk unreadable, not free', () => {
        game.currentActions = [
            queued(1, '/actions/alchemy/unknown'),
            queued(2, DECOMPOSE, { item: STAR_FRUIT, maxCount: 500 }),
        ];

        expect(walkQueueCoins(engine)).toBeNull();
    });

    test('an empty queue holds nothing back', () => {
        expect(coinReserve(walkQueueCoins(engine).stages)).toEqual({ reserve: 0, spenders: [], estimated: false });
    });

    test('without the engine the walk answers nothing rather than zero', () => {
        expect(walkQueueCoins(null)).toBeNull();
    });
});

describe('the reserve, from stage flows', () => {
    test('is the deepest dip, not the net', () => {
        const stages = [
            { label: 'Decompose: Star Fruit', coinDelta: -300 },
            { label: 'Coinify: Foraging Essence', coinDelta: 1000 },
            { label: 'Decompose: Star Fruit', coinDelta: -900 },
        ];
        // −300, then +700, then −200: the lowest point is −300
        expect(coinReserve(stages)).toEqual({ reserve: 300, spenders: ['Decompose: Star Fruit'], estimated: false });
    });

    test('a second dip deeper than the first sets it', () => {
        const stages = [
            { label: 'A', coinDelta: -300 },
            { label: 'B', coinDelta: 100 },
            { label: 'C', coinDelta: -500 },
        ];
        expect(coinReserve(stages)).toEqual({ reserve: 700, spenders: ['A', 'C'], estimated: false });
    });

    test('an enhancing spender on the way down makes the reserve an estimate', () => {
        const stages = [
            { label: 'Enhance: Sword', coinDelta: -300, estimated: true },
            { label: 'Decompose: Star Fruit', coinDelta: -200 },
        ];
        expect(coinReserve(stages)).toMatchObject({ reserve: 500, estimated: true });
    });

    test('an enhancing spender after the deepest point does not', () => {
        const stages = [
            { label: 'Decompose: Star Fruit', coinDelta: -900 },
            { label: 'Coinify', coinDelta: 1000 },
            { label: 'Enhance: Sword', coinDelta: -50, estimated: true },
        ];
        expect(coinReserve(stages)).toMatchObject({ reserve: 900, estimated: false });
    });
});

describe('bells the spare coins buy', () => {
    test('floors to whole bags of ten, the only way bells are sold', () => {
        // 95,000 a bell is 950,000 a bag; the 100,000 left after two bags buys nothing
        const pricing = { price: 95_000, source: 'bag' };
        expect(bellsAffordable(3_000_000, 1_000_000, pricing)).toEqual({
            spare: 2_000_000,
            bells: 2 * COWBELLS_PER_BAG,
            bags: 2,
        });
    });

    test('an exact multiple of the bag price buys that many bags, not one fewer', () => {
        const pricing = { price: 111_500, source: 'bag' };
        expect(bellsAffordable(3 * 1_115_000, 0, pricing)).toMatchObject({ bags: 3, bells: 30 });
    });

    test('a reserve above the coins on hand buys nothing, not a negative', () => {
        const pricing = { price: 100_000, source: 'bag' };
        expect(bellsAffordable(400_000, 450_000, pricing)).toMatchObject({ spare: 0, bells: 0, bags: 0 });
    });

    test('says nothing without a bell price', () => {
        expect(bellsAffordable(1_000_000, 0, { price: null, source: null })).toBeNull();
    });
});
