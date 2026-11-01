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
const { walkQueueCoins, coinReserve, bellsAffordable, bellBudget, COWBELLS_PER_BAG } =
    await import('./coin-reserve.js');
const { summarizeCycle, keptNote } = await import('./ironbell-cycle.js');

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

describe('the whole queued cycle, walked through the real engine', () => {
    // Every action is 10 s with no efficiency (the mocked calculator)
    const LOOP = { forageActionHrid: FORAGE, starfruitHrid: STAR_FRUIT, essenceHrid: ESSENCE };
    const fullLoop = () => [
        queued(1, FORAGE, { maxCount: 100 }),
        queued(2, DECOMPOSE, { item: STAR_FRUIT, maxCount: 500 }),
        queued(3, COINIFY, { item: ESSENCE }),
    ];

    test('every leg is timed and counted, and the cycle sums them', () => {
        game.currentActions = fullLoop();
        const walked = walkQueueCoins(engine);
        expect(walked.stages.map((stage) => stage.seconds)).toEqual([1000, 5000, 6000]);
        expect(walked.stages.map((stage) => stage.itemHrid)).toEqual([null, STAR_FRUIT, ESSENCE]);

        const cycle = summarizeCycle(walked, {
            coins: 1_000_000,
            loopItems: LOOP,
            bellPrice: 1000,
            offlineCapHours: 4,
        });
        expect(cycle.legs).toEqual({ forage: 100, decompose: 500, coinify: 600 });
        expect(cycle.seconds).toBe(12_000);
        expect(cycle.fees).toBeCloseTo(450_000, 3);
        expect(cycle.earned).toBeCloseTo(600 * COINS_PER_COINIFY, 3);
        expect(cycle.net).toBeCloseTo(600_000, 3);
        expect(cycle.netBells).toBeCloseTo(600, 6);
        expect(cycle.netBags).toBe(60);
        expect(cycle.estimated).toBe(true);
        // 1M covers the 450K of fees; 12,000 s is under the 4 h cap
        expect(cycle.shortfall).toBeNull();
        expect(cycle.outlastsCap).toBe(false);
    });

    test('the panel and the strip share one bells-now answer off the same walk', () => {
        game.currentActions = fullLoop();
        const walked = walkQueueCoins(engine);
        const budget = bellBudget(walked, 4_000_000, { price: 1000, quoted: true });
        // 4M less 450K of fees and the 3M buffer leaves 550K spare = 55 bags
        expect(budget).toMatchObject({
            status: 'ok',
            reserve: 3_450_000,
            fees: 450_000,
            buffer: 3_000_000,
            can: { bags: 55, bells: 550 },
        });
        expect(budget.spenders).toEqual(['Decompose: Star Fruit']);
    });

    test('with no gold-spending leg the reserve is exactly the buffer, and the note calls it a safety buffer', () => {
        game.currentActions = [queued(1, FORAGE, { maxCount: 100 })];
        const budget = bellBudget(walkQueueCoins(engine), 4_000_000, { price: 1000, quoted: true });
        expect(budget).toMatchObject({ status: 'ok', reserve: 3_000_000, fees: 0, buffer: 3_000_000 });
        expect(keptNote(budget.reserve, budget.spenders, (n) => `${n}`, budget.buffer)).toBe(
            'Nothing queued spends gold; 3000000 is kept back as a safety buffer.'
        );
    });

    test('short of the fees: names the leg that stalls and how far into the queue', () => {
        game.currentActions = fullLoop();
        const cycle = summarizeCycle(walkQueueCoins(engine), { coins: 200_000, loopItems: LOOP, offlineCapHours: 3 });
        // 200K pays 222 of the 900-coin decomposes: 1,000 s of forage, then 222 × 10 s
        expect(cycle.shortfall).toMatchObject({ label: 'Decompose: Star Fruit', leg: 'decompose', atSeconds: 3220 });
        expect(cycle.shortfall.short).toBeCloseTo(250_000, 3);
        // 12,000 s outlasts a 3 h cap; no bell price, no bells
        expect(cycle.outlastsCap).toBe(true);
        expect(cycle.netBells).toBeNull();
    });

    test('zero gold stalls the first fee at once', () => {
        game.currentActions = fullLoop().slice(1);
        const cycle = summarizeCycle(walkQueueCoins(engine), { coins: 0, loopItems: LOOP });
        expect(cycle.shortfall).toMatchObject({ leg: 'decompose', atSeconds: 0 });
        expect(cycle.shortfall.short).toBeCloseTo(450_000, 3);
        expect(bellBudget(walkQueueCoins(engine), 0, { price: 1000, quoted: true }).can).toMatchObject({ bells: 0 });
    });

    test('an infinite forage leg ends the walk: the cycle has no end and outlasts any cap', () => {
        game.currentActions = [queued(1, FORAGE), queued(2, DECOMPOSE, { item: STAR_FRUIT, maxCount: 500 })];
        const walked = walkQueueCoins(engine);
        const cycle = summarizeCycle(walked, { coins: 1_000_000, loopItems: LOOP, offlineCapHours: 20 });
        expect(cycle.endless).toBe('Star Fruit');
        expect(cycle.seconds).toBeNull();
        expect(cycle.legs).toEqual({ forage: 0, decompose: 0, coinify: 0 });
        expect(cycle.outlastsCap).toBe(true);
        expect(cycle.shortfall).toBeNull();
    });

    test('an unreadable queue has no cycle and no bells-now answer', () => {
        expect(summarizeCycle(null, { coins: 1, loopItems: LOOP })).toBeNull();
        expect(bellBudget(null, 1, { price: 1000, quoted: true }).status).toBe('unreadable');
        expect(bellBudget(null, 1, { price: 1000, quoted: false }).status).toBe('unquoted');
        expect(bellBudget(null, 1, { price: null }).status).toBe('noPrice');
    });

    test('a stack of three same-leg rows and a non-loop row are counted apart', () => {
        game.inventory = [stack(COIN, 1_000_000), stack(STAR_FRUIT, 3000)];
        game.currentActions = [
            queued(1, DECOMPOSE, { item: STAR_FRUIT, maxCount: 100 }),
            queued(2, DECOMPOSE, { item: STAR_FRUIT, maxCount: 100 }),
            queued(3, DECOMPOSE, { item: STAR_FRUIT, maxCount: 100 }),
            // A decompose of something else is not a loop leg
            queued(4, DECOMPOSE, { item: ESSENCE, maxCount: 5 }),
        ];
        const cycle = summarizeCycle(walkQueueCoins(engine), { coins: 1_000_000, loopItems: LOOP });
        expect(cycle.legs.decompose).toBe(300);
        expect(cycle.otherActions).toBeGreaterThan(0);
    });
});

describe('the cycle summary says when its figures are estimates', () => {
    const loop = { forageActionHrid: FORAGE, starfruitHrid: STAR_FRUIT, essenceHrid: ESSENCE };

    test('a catalyst-limited decompose with no coinify still marks the cycle estimated', () => {
        const walked = {
            stages: [
                {
                    actionHrid: DECOMPOSE,
                    itemHrid: STAR_FRUIT,
                    count: 10,
                    coinDelta: -9000,
                    earned: 0,
                    seconds: 600,
                    estimated: true,
                },
            ],
            stoppedAt: null,
        };
        const cycle = summarizeCycle(walked, { coins: 1_000_000, loopItems: loop });
        expect(cycle.earned).toBe(0);
        expect(cycle.estimated).toBe(true);
    });

    test('exact fees and no earnings stay exact', () => {
        const walked = {
            stages: [{ actionHrid: DECOMPOSE, itemHrid: STAR_FRUIT, count: 10, coinDelta: -9000, seconds: 600 }],
            stoppedAt: null,
        };
        expect(summarizeCycle(walked, { coins: 1_000_000, loopItems: loop }).estimated).toBe(false);
    });
});
