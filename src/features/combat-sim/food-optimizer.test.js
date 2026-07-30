/**
 * Tests for the cheapest-viable-food solver's pure parts: signature
 * classification, pool construction, slot templating, the price decision, and
 * reading survival out of a sim result.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./combat-sim-runner.js', () => ({ runSimulation: vi.fn() }));
vi.mock('../../utils/profit-helpers.js', () => ({ resolveItemPrice: vi.fn() }));

const {
    restoreSignature,
    buildConsumablePools,
    buildSearchSlots,
    cheapestAtLeast,
    estimateFoodSimCount,
    readViability,
    runFoodOptimization,
} = await import('./food-optimizer.js');
const { resolveItemPrice } = await import('../../utils/profit-helpers.js');
const { runSimulation } = await import('./combat-sim-runner.js');

const HOUR_NS = 3600 * 1e9;

const PRICES = {
    '/items/cheese': 100,
    '/items/gourmet_cheese': 1_500,
    '/items/marsberry_cake': 400,
    '/items/donut': 300,
    '/items/star_fruit_yogurt': 900,
    '/items/sword': 5_000,
    '/items/unpriced_cake': 0,
};

function foodGameData() {
    return {
        itemDetailMap: {
            '/items/cheese': {
                name: 'Cheese',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 50, manapointRestore: 0 },
            },
            '/items/marsberry_cake': {
                name: 'Marsberry Cake',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 240, manapointRestore: 0 },
            },
            '/items/gourmet_cheese': {
                name: 'Gourmet Cheese',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 500, manapointRestore: 0, recoveryDuration: 10 },
            },
            '/items/donut': {
                name: 'Donut',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 0, manapointRestore: 60 },
            },
            '/items/star_fruit_yogurt': {
                name: 'Star Fruit Yogurt',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 0, manapointRestore: 350 },
            },
            '/items/unpriced_cake': {
                name: 'Unpriced Cake',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 400, manapointRestore: 0 },
            },
            '/items/sword': {
                name: 'Sword',
                categoryHrid: '/item_categories/equipment',
                equipmentDetail: {},
            },
            '/items/lucky_coffee_cake': {
                name: 'Lucky Cake',
                categoryHrid: '/item_categories/food',
                consumableDetail: { hitpointRestore: 0, manapointRestore: 0, buffs: [{ uniqueHrid: '/luck' }] },
            },
        },
    };
}

beforeEach(() => {
    resolveItemPrice.mockImplementation((hrid) => ({ price: PRICES[hrid] ?? 0 }));
});

describe('restoreSignature', () => {
    test('separates what is restored and how it is delivered', () => {
        expect(restoreSignature({ hitpointRestore: 100 })).toBe('hp_instant');
        expect(restoreSignature({ hitpointRestore: 100, recoveryDuration: 10 })).toBe('hp_overtime');
        expect(restoreSignature({ manapointRestore: 100 })).toBe('mp_instant');
        expect(restoreSignature({ hitpointRestore: 100, manapointRestore: 100 })).toBe('hpmp_instant');
    });

    test('returns null for buff-only consumables', () => {
        expect(restoreSignature({ buffs: [{}] })).toBe(null);
        expect(restoreSignature(null)).toBe(null);
    });
});

describe('buildConsumablePools', () => {
    test('groups by signature, sorted by restore amount', () => {
        const pools = buildConsumablePools(foodGameData());

        expect(pools.get('hp_instant').map((e) => e.hrid)).toEqual(['/items/cheese', '/items/marsberry_cake']);
        expect(pools.get('hp_overtime').map((e) => e.hrid)).toEqual(['/items/gourmet_cheese']);
        expect(pools.get('mp_instant').map((e) => e.hrid)).toEqual(['/items/donut', '/items/star_fruit_yogurt']);
    });

    test('skips non-food, buff-only, and unpriced items', () => {
        const pools = buildConsumablePools(foodGameData());
        const all = [...pools.values()].flat().map((e) => e.hrid);

        expect(all).not.toContain('/items/sword');
        expect(all).not.toContain('/items/lucky_coffee_cake');
        // No market price means no way to call it cheap
        expect(all).not.toContain('/items/unpriced_cake');
    });

    test('records price per restored point', () => {
        const pools = buildConsumablePools(foodGameData());
        const cheese = pools.get('hp_instant').find((e) => e.hrid === '/items/cheese');
        expect(cheese.pricePerPoint).toBeCloseTo(2);
    });

    test('returns an empty map without game data', () => {
        expect(buildConsumablePools(null).size).toBe(0);
    });
});

describe('buildSearchSlots', () => {
    test('binds each restore slot to its own signature pool at its original index', () => {
        const gameData = foodGameData();
        const pools = buildConsumablePools(gameData);
        const slots = buildSearchSlots(
            [{ hrid: '/items/marsberry_cake' }, null, { hrid: '/items/donut' }],
            gameData.itemDetailMap,
            pools
        );

        expect(slots).toHaveLength(2);
        expect(slots[0]).toMatchObject({ index: 0, signature: 'hp_instant', currentHrid: '/items/marsberry_cake' });
        expect(slots[0].pool.map((e) => e.hrid)).toEqual(['/items/cheese', '/items/marsberry_cake']);
        expect(slots[1]).toMatchObject({ index: 2, signature: 'mp_instant', currentHrid: '/items/donut' });
    });

    test('never touches buff-only foods', () => {
        const gameData = foodGameData();
        const pools = buildConsumablePools(gameData);
        const slots = buildSearchSlots([{ hrid: '/items/lucky_coffee_cake' }], gameData.itemDetailMap, pools);
        expect(slots).toHaveLength(0);
    });

    test('an HP-over-time slot only sees HP-over-time candidates', () => {
        const gameData = foodGameData();
        const pools = buildConsumablePools(gameData);
        const slots = buildSearchSlots([{ hrid: '/items/gourmet_cheese' }], gameData.itemDetailMap, pools);

        expect(slots[0].pool.map((e) => e.hrid)).toEqual(['/items/gourmet_cheese']);
    });

    test('returns nothing when no restore food is equipped', () => {
        const gameData = foodGameData();
        const pools = buildConsumablePools(gameData);
        expect(buildSearchSlots([null, null, null], gameData.itemDetailMap, pools)).toHaveLength(0);
        expect(buildSearchSlots([], gameData.itemDetailMap, pools)).toHaveLength(0);
    });
});

describe('cheapestAtLeast', () => {
    const pool = [
        { hrid: 'a', hpRestore: 50, mpRestore: 0, pricePerPoint: 3 },
        { hrid: 'b', hpRestore: 200, mpRestore: 0, pricePerPoint: 1.5 },
        { hrid: 'c', hpRestore: 500, mpRestore: 0, pricePerPoint: 2 },
    ];

    test('prefers a higher tier that costs less per point', () => {
        expect(cheapestAtLeast(pool, pool[0]).hrid).toBe('b');
    });

    test('never drops below the proven restore amount', () => {
        expect(cheapestAtLeast(pool, pool[2]).hrid).toBe('c');
    });

    test('requires every restored stat to hold, not just the total', () => {
        const both = [
            { hrid: 'x', hpRestore: 100, mpRestore: 100, pricePerPoint: 2 },
            { hrid: 'y', hpRestore: 300, mpRestore: 50, pricePerPoint: 1 },
        ];
        // y is cheaper and restores more in total, but falls short on MP
        expect(cheapestAtLeast(both, both[0]).hrid).toBe('x');
    });

    test('keeps the reference when nothing beats it', () => {
        expect(cheapestAtLeast([pool[1]], pool[1]).hrid).toBe('b');
    });
});

describe('readViability', () => {
    test('converts deaths to a per-hour rate over the simulated time', () => {
        const result = readViability(
            { simulatedTime: 2 * HOUR_NS, deaths: { player1: 5 }, playerRanOutOfManaTime: {} },
            'player1'
        );
        expect(result.deathsPerHour).toBeCloseTo(2.5);
        expect(result.oomFraction).toBe(0);
    });

    test('reports the out-of-mana share of the run', () => {
        const result = readViability(
            {
                simulatedTime: 10 * HOUR_NS,
                deaths: {},
                playerRanOutOfManaTime: {
                    player1: { isOutOfMana: false, startTimeForOutOfMana: 0, totalTimeForOutOfMana: HOUR_NS },
                },
            },
            'player1'
        );
        expect(result.oomFraction).toBeCloseTo(0.1);
    });

    test('counts an out-of-mana window still open at the end of the run', () => {
        const result = readViability(
            {
                simulatedTime: 10 * HOUR_NS,
                deaths: {},
                playerRanOutOfManaTime: {
                    player1: {
                        isOutOfMana: true,
                        startTimeForOutOfMana: 8 * HOUR_NS,
                        totalTimeForOutOfMana: HOUR_NS,
                    },
                },
            },
            'player1'
        );
        // 1h closed + 2h still open = 3h of 10
        expect(result.oomFraction).toBeCloseTo(0.3);
    });

    test('survives an empty sim result', () => {
        expect(readViability({}, 'player1')).toEqual({ deathsPerHour: 0, oomFraction: 0 });
    });
});

describe('runFoodOptimization', () => {
    /**
     * Sim stand-in: dying is prevented only by an HP food restoring ≥ 240, and
     * mana only holds with an MP food restoring ≥ 350 — the screenshot scenario
     * where a cheap drink meant 49% of the run spent out of mana.
     */
    function mockSimFromFood() {
        runSimulation.mockImplementation(async ({ playerDTOs, hours }) => {
            const food = playerDTOs[0].food.filter(Boolean);
            const maxHp = Math.max(0, ...food.map((s) => hpOf(s.hrid)));
            const maxMp = Math.max(0, ...food.map((s) => mpOf(s.hrid)));
            const simulatedTime = hours * HOUR_NS;
            return {
                simulatedTime,
                deaths: { player1: maxHp >= 240 ? 0 : 5 * hours },
                playerRanOutOfManaTime: {
                    player1: {
                        isOutOfMana: false,
                        startTimeForOutOfMana: 0,
                        totalTimeForOutOfMana: maxMp >= 350 ? 0 : simulatedTime * 0.49,
                    },
                },
                consumablesUsed: { player1: Object.fromEntries(food.map((s) => [s.hrid, 100 * hours])) },
            };
        });
    }

    const hpOf = (hrid) => foodGameData().itemDetailMap[hrid]?.consumableDetail?.hitpointRestore || 0;
    const mpOf = (hrid) => foodGameData().itemDetailMap[hrid]?.consumableDetail?.manapointRestore || 0;

    const params = () => ({
        gameData: foodGameData(),
        playerDTOs: [
            {
                hrid: 'player1',
                food: [{ hrid: '/items/marsberry_cake' }, { hrid: '/items/donut' }, null],
            },
        ],
        playerIndex: 0,
        zoneHrid: '/actions/combat/x',
        difficultyTier: 0,
        hours: 1,
        communityBuffs: {},
        seed: 1,
        baselineResult: null,
    });

    test('never recommends a setup that runs out of mana when a viable tier exists', async () => {
        mockSimFromFood();

        const result = await runFoodOptimization(params(), null, {});

        expect(result.recommendation.oomFraction).toBeLessThanOrEqual(result.oomTarget);
        expect(result.oomTarget).toBeCloseTo(0.005);

        // The donut (60 MP) leaves you dry — the same-type upgrade is the answer
        const mpSlot = result.recommendation.slots.find((s) => s.index === 1);
        expect(mpSlot.hrid).toBe('/items/star_fruit_yogurt');
        expect(mpSlot.changed).toBe(true);
    });

    test('keeps the slot types the player runs', async () => {
        mockSimFromFood();

        const result = await runFoodOptimization(params(), null, {});

        const hpSlot = result.recommendation.slots.find((s) => s.index === 0);
        // Only hp_instant candidates were in play; the cake was already the
        // minimum viable tier so it stays
        expect(hpSlot.hrid).toBe('/items/marsberry_cake');
        expect(hpSlot.changed).toBe(false);
    });

    test('recommends keeping current food when it is viable and cheapest', async () => {
        mockSimFromFood();
        const p = params();
        // Current setup already viable: cake + yogurt
        p.playerDTOs[0].food = [{ hrid: '/items/marsberry_cake' }, { hrid: '/items/star_fruit_yogurt' }, null];
        p.baselineResult = {
            simulatedTime: HOUR_NS,
            deaths: { player1: 0 },
            playerRanOutOfManaTime: {
                player1: { isOutOfMana: false, startTimeForOutOfMana: 0, totalTimeForOutOfMana: 0 },
            },
            consumablesUsed: {
                player1: { '/items/marsberry_cake': 100, '/items/star_fruit_yogurt': 100 },
            },
        };

        const result = await runFoodOptimization(p, null, {});

        expect(result.keepCurrent).toBe(true);
    });

    test('returns null when no restore food is equipped', async () => {
        mockSimFromFood();
        const p = params();
        p.playerDTOs[0].food = [null, null, null];

        expect(await runFoodOptimization(p, null, {})).toBe(null);
    });

    test('minimizes shared-mana slots against each other, not a top-tier partner', async () => {
        // Two slots both feed mana: a gummy (over-time) and a yogurt (instant).
        // Mana holds only when their combined restore reaches 450. Minimizing each
        // against a top-tier partner proves plum (100+350) and peach (280+200)
        // separately, but plum+peach (300) fails together — the old search then
        // fell back to top tiers of everything.
        const manaData = {
            itemDetailMap: {
                '/items/plum_gummy': {
                    name: 'Plum Gummy',
                    categoryHrid: '/item_categories/food',
                    consumableDetail: { hitpointRestore: 0, manapointRestore: 100, recoveryDuration: 10 },
                },
                '/items/star_fruit_gummy': {
                    name: 'Star Fruit Gummy',
                    categoryHrid: '/item_categories/food',
                    consumableDetail: { hitpointRestore: 0, manapointRestore: 280, recoveryDuration: 10 },
                },
                '/items/donut': {
                    name: 'Donut',
                    categoryHrid: '/item_categories/food',
                    consumableDetail: { hitpointRestore: 0, manapointRestore: 60 },
                },
                '/items/peach_yogurt': {
                    name: 'Peach Yogurt',
                    categoryHrid: '/item_categories/food',
                    consumableDetail: { hitpointRestore: 0, manapointRestore: 200 },
                },
                '/items/star_fruit_yogurt': {
                    name: 'Star Fruit Yogurt',
                    categoryHrid: '/item_categories/food',
                    consumableDetail: { hitpointRestore: 0, manapointRestore: 350 },
                },
            },
        };
        resolveItemPrice.mockImplementation(
            (hrid) =>
                ({
                    '/items/plum_gummy': { price: 200 },
                    '/items/star_fruit_gummy': { price: 2_000 },
                    '/items/donut': { price: 100 },
                    '/items/peach_yogurt': { price: 500 },
                    '/items/star_fruit_yogurt': { price: 1_200 },
                })[hrid] || { price: 0 }
        );
        runSimulation.mockImplementation(async ({ playerDTOs, hours }) => {
            const food = playerDTOs[0].food.filter(Boolean);
            const totalMp = food.reduce(
                (sum, slot) => sum + (manaData.itemDetailMap[slot.hrid]?.consumableDetail?.manapointRestore || 0),
                0
            );
            const simulatedTime = hours * HOUR_NS;
            return {
                simulatedTime,
                deaths: { player1: 0 },
                playerRanOutOfManaTime: {
                    player1: {
                        isOutOfMana: false,
                        startTimeForOutOfMana: 0,
                        totalTimeForOutOfMana: totalMp >= 450 ? 0 : simulatedTime * 0.49,
                    },
                },
                consumablesUsed: { player1: Object.fromEntries(food.map((slot) => [slot.hrid, 100 * hours])) },
            };
        });

        const result = await runFoodOptimization(
            {
                gameData: manaData,
                playerDTOs: [
                    { hrid: 'player1', food: [{ hrid: '/items/plum_gummy' }, { hrid: '/items/peach_yogurt' }, null] },
                ],
                playerIndex: 0,
                zoneHrid: '/actions/combat/x',
                difficultyTier: 0,
                hours: 1,
                communityBuffs: {},
                seed: 1,
                baselineResult: null,
            },
            null,
            {}
        );

        expect(result.recommendation.oomFraction).toBeLessThanOrEqual(result.oomTarget);

        // Sequential search fixes the gummy at plum first, then the yogurt search
        // sees that fixed choice and lands on the tier that actually covers it —
        // not the everything-at-top fallback
        const gummy = result.recommendation.slots.find((s) => s.index === 0);
        const yogurt = result.recommendation.slots.find((s) => s.index === 1);
        expect(gummy.hrid).toBe('/items/plum_gummy');
        expect(gummy.changed).toBe(false);
        expect(yogurt.hrid).toBe('/items/star_fruit_yogurt');
    });
});

describe('estimateFoodSimCount', () => {
    test('scales with a binary search per equipped restore slot', () => {
        // Slot pools: hp_instant (2 items → 2 rungs + empty = ceil(log2(4)) = 2 sims)
        // and mp_instant (2 items → 2 sims); plus ceiling and confirmation probes
        const count = estimateFoodSimCount(foodGameData(), [
            { hrid: '/items/marsberry_cake' },
            { hrid: '/items/donut' },
        ]);
        expect(count).toBe(2 + 2 + 2);
    });

    test('counts only the fixed probes with no searchable slots', () => {
        expect(estimateFoodSimCount(foodGameData(), [])).toBe(2);
    });
});
