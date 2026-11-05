/**
 * The next-set additions to the Iron Bell helper: what the game queue already holds, the gold a batch
 * needs behind it, what the gold on hand pays for, and when the queue runs out.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentActions: () => [], getInventory: () => [] } }));

const { queuedLegCounts, reduceBatchByQueue, queueEndText, summarizeCycle } = await import('./ironbell-cycle.js');
const { batchStages, withBatchStages, coinReserve, bellBudget } = await import('./coin-reserve.js');
const { affordableBatch } = await import('./starfruit-loop.js');
const { OWNED_KEY_PREFIXES } = await import('../sync/sync-ownership.js');
const { KEEP_BATCH_CASH_KEY } = await import('./ironcow-store.js');

const FRUIT = '/items/star_fruit';
const ESSENCE = '/items/foraging_essence';
const OTHER = '/items/apple';
const items = { forageActionHrid: '/actions/foraging/star_fruit', starfruitHrid: FRUIT, essenceHrid: ESSENCE };
const hash = (item) => `1::/item_locations/inventory::${item}::0`;
const row = (actionHrid, item, extra = {}) => ({
    ordinal: 1,
    actionHrid,
    primaryItemHash: item ? hash(item) : undefined,
    hasMaxCount: true,
    maxCount: 100,
    currentCount: 0,
    isDone: false,
    ...extra,
});

/** The loop's stock arithmetic, as the engine's ledger sees it: 2 fruit a decompose, 6 essence a fruit */
const LOOP = { fruitPerForageAction: 1, decomposeBulk: 2, essencePerFruit: 6, coinifyBulk: 10 };
const stock = (fruitHeld, essenceHeld = 0) => ({ loop: LOOP, fruitHeld, essenceHeld });

describe('what the game queue will really perform of each leg', () => {
    test('matches by action AND item: alchemy on another item is not a loop leg', () => {
        const queued = queuedLegCounts(
            [row('/actions/alchemy/decompose', OTHER), row('/actions/alchemy/coinify', FRUIT)],
            items,
            stock(1000, 1000)
        );
        expect(queued.decompose.count).toBe(0);
        expect(queued.coinify.count).toBe(0);
    });

    test('counts what each unfinished row has left, the running one included, finished rows not at all', () => {
        const queued = queuedLegCounts(
            [
                row('/actions/alchemy/coinify', ESSENCE, { maxCount: 500, currentCount: 120, ordinal: 1 }),
                row('/actions/alchemy/coinify', ESSENCE, { maxCount: 50, ordinal: 2 }),
                row('/actions/alchemy/coinify', ESSENCE, { maxCount: 999, isDone: true, ordinal: 3 }),
            ],
            items,
            stock(0, 9999)
        );
        expect(queued.coinify).toEqual({ count: 430, performed: 430 });
        expect(queued.starved).toEqual([]);
    });

    test('a coinify queued ahead of any essence is starved, not credited', () => {
        const queued = queuedLegCounts(
            [row('/actions/alchemy/coinify', ESSENCE, { maxCount: 480 })],
            items,
            stock(0, 0)
        );
        expect(queued.coinify.performed).toBe(0);
        expect(queued.starved).toEqual([{ leg: 'coinify', count: 480, performed: 0 }]);
    });

    test('a decompose asks for more than the fruit ahead of it: only the fruit is performed', () => {
        const queued = queuedLegCounts(
            [row('/actions/alchemy/decompose', FRUIT, { maxCount: 1800 })],
            items,
            stock(1600)
        );
        expect(queued.decompose).toEqual({ count: 1800, performed: 800 });
        expect(queued.starved[0]).toMatchObject({ leg: 'decompose', count: 1800, performed: 800 });
    });

    test('a forage ahead feeds the decompose behind it, and the queue is read in order, not array order', () => {
        const queued = queuedLegCounts(
            [
                row('/actions/alchemy/decompose', FRUIT, { maxCount: 500, ordinal: 2 }),
                row(items.forageActionHrid, null, { maxCount: 1000, ordinal: 1 }),
            ],
            items,
            stock(0)
        );
        expect(queued.decompose.performed).toBe(500);
        expect(queued.starved).toEqual([]);
        // and the other way round, the decompose runs first and has nothing
        const reversed = queuedLegCounts(
            [
                row('/actions/alchemy/decompose', FRUIT, { maxCount: 500, ordinal: 1 }),
                row(items.forageActionHrid, null, { maxCount: 1000, ordinal: 2 }),
            ],
            items,
            stock(0)
        );
        expect(reversed.decompose.performed).toBe(0);
        expect(reversed.starved).toHaveLength(1);
    });

    test('Repeat ∞ on an alchemy leg is limited by its materials and covered up to them', () => {
        const queued = queuedLegCounts(
            [
                row('/actions/alchemy/decompose', FRUIT, { hasMaxCount: false, maxCount: 0, ordinal: 1 }),
                row('/actions/alchemy/coinify', ESSENCE, { hasMaxCount: false, maxCount: 0, ordinal: 2 }),
            ],
            items,
            stock(184_290, 0)
        );
        // 184,290 fruit is 92,145 decomposes of 2, making 1,105,740 essence for 110,574 coinifies
        expect(queued.decompose.performed).toBe(92_145);
        expect(queued.coinify.performed).toBe(110_574);
        expect(queued.endless).toBeNull();
        expect(queued.starved).toEqual([]);
    });

    test('a row with no count and no material limit never hands on, and the rows behind it are unreachable', () => {
        const queued = queuedLegCounts(
            [
                row(items.forageActionHrid, null, { hasMaxCount: false, maxCount: 0, ordinal: 1 }),
                row('/actions/alchemy/decompose', FRUIT, { maxCount: 50, ordinal: 2 }),
            ],
            items,
            stock(1000)
        );
        expect(queued.endless).toBe('Forage');
        expect(queued.decompose.performed).toBe(0);
    });
});

describe('which rows end: the engine’s verdict decides', () => {
    const apple = (extra = {}) =>
        row('/actions/alchemy/decompose', OTHER, { hasMaxCount: false, maxCount: 0, ordinal: 1, ...extra });
    const loopD = (extra = {}) => row('/actions/alchemy/decompose', FRUIT, { maxCount: 400, ordinal: 2, ...extra });

    test('a material-limited ∞ row of another item ahead does not stop inspection; the rows behind it are credited', () => {
        const walked = { stages: [{ label: 'a' }, { label: 'b' }], stoppedAt: null };
        const queued = queuedLegCounts([apple(), loopD()], items, { ...stock(1000), walked });
        expect(queued.endless).toBeNull();
        expect(queued.decompose.performed).toBe(400);
    });

    test('without the engine the same row is taken as unbounded, the conservative way', () => {
        const queued = queuedLegCounts([apple(), loopD()], items, stock(1000));
        expect(queued.endless).toBe('An action with no count');
        expect(queued.decompose.performed).toBe(0);
    });

    test('only the row the engine stopped at is unbounded', () => {
        // the engine listed one stage and stopped at the second row
        const walked = { stages: [{ label: 'a' }], stoppedAt: 'Forage' };
        const queued = queuedLegCounts(
            [
                apple(),
                row(items.forageActionHrid, null, { hasMaxCount: false, maxCount: 0, ordinal: 2 }),
                loopD({ ordinal: 3 }),
            ],
            items,
            { ...stock(1000), walked, labelOf: () => 'Foraging: Star Fruit' }
        );
        expect(queued.endless).toBe('Foraging: Star Fruit');
        expect(queued.decompose.performed).toBe(0);
    });

    test('a row ahead that spends the loop’s own fruit or essence takes it from the legs behind', () => {
        const eatsFruit = row('/actions/alchemy/coinify', FRUIT, { maxCount: 10, ordinal: 1 });
        const queued = queuedLegCounts([eatsFruit, loopD()], items, {
            ...stock(1000),
            walked: { stages: [{}, {}], stoppedAt: null },
        });
        expect(queued.decompose.performed).toBe(0);
        expect(queued.starved).toHaveLength(1);
        const eatsEssence = row('/actions/alchemy/transmute', ESSENCE, { maxCount: 10, ordinal: 1 });
        const coinify = row('/actions/alchemy/coinify', ESSENCE, { maxCount: 40, ordinal: 2 });
        const second = queuedLegCounts([eatsEssence, coinify], items, {
            ...stock(0, 5000),
            walked: { stages: [{}, {}], stoppedAt: null },
        });
        expect(second.coinify.performed).toBe(0);
    });
});

describe('walking only what is missing', () => {
    const batch = { forageActions: 0, decomposeActions: 1000, coinifyActions: 300 };
    const reduce = (actions, fruit, essence, b = batch) =>
        reduceBatchByQueue(b, queuedLegCounts(actions, items, stock(fruit, essence)), LOOP);

    test('a leg queued at a sufficient count that will perform is skipped and named', () => {
        const out = reduce([row('/actions/alchemy/coinify', ESSENCE, { maxCount: 300 })], 2000, 3000);
        expect(out.batch.coinifyActions).toBe(0);
        expect(out.batch.decomposeActions).toBe(1000);
        expect(out.skipped).toEqual(['Coinify']);
        expect(out.blocked).toBeNull();
    });

    test('a leg queued at less keeps only the difference', () => {
        const out = reduce([row('/actions/alchemy/decompose', FRUIT, { maxCount: 400 })], 2000, 0);
        expect(out.batch.decomposeActions).toBe(600);
        expect(out.partial).toEqual(['Decompose']);
    });

    test('nothing queued walks the whole batch, capped to what its own inputs allow', () => {
        const out = reduce([], 2000, 0);
        expect(out.batch).toMatchObject({ decomposeActions: 1000, coinifyActions: 300 });
    });

    test('Queue [D 1,800, C 600] with 1,600 fruit and a new forage: refused, never a queue that idles', () => {
        // Forage would go on LAST, behind the decompose that needed its fruit
        const out = reduce(
            [
                row('/actions/alchemy/decompose', FRUIT, { maxCount: 1800, ordinal: 1 }),
                row('/actions/alchemy/coinify', ESSENCE, { maxCount: 600, ordinal: 2 }),
            ],
            1600,
            0,
            { forageActions: 1000, decomposeActions: 1800, coinifyActions: 600 }
        );
        expect(out.blocked).toContain('Decompose is queued for 1,800');
        expect(out.blocked).toContain('stall');
    });

    test('a starved row with nothing behind it to feed it stalls with or without the walk: a warning, not a refusal', () => {
        const noFruit = reduce([row('/actions/alchemy/decompose', FRUIT, { maxCount: 1000 })], 0, 0);
        expect(noFruit.blocked).toBeNull();
        expect(noFruit.notes[0]).toContain('Decompose is queued for 1,000');
        expect(noFruit.notes[0]).toContain('stalls there until more arrives');

        const noEssence = reduce([row('/actions/alchemy/coinify', ESSENCE, { maxCount: 480 })], 0, 0, {
            coinifyActions: 480,
        });
        expect(noEssence.blocked).toBeNull();
        expect(noEssence.notes[0]).toContain('Coinify is queued for 480');
    });

    test('refused only when the walk itself would leave the starved row idle: its feeder would sit behind it', () => {
        // a starved coinify with a decompose to be added behind it
        const out = reduce([row('/actions/alchemy/coinify', ESSENCE, { maxCount: 480 })], 2000, 0, {
            decomposeActions: 1000,
            coinifyActions: 480,
        });
        expect(out.blocked).toContain('queued behind it');
        expect(out.blocked).toContain('stall there for good');
    });

    test('a row that never ends is a warning naming it by its display name, and the legs behind it are not credited', () => {
        const queued = queuedLegCounts(
            [row(items.forageActionHrid, null, { hasMaxCount: false, maxCount: 0, ordinal: 1 })],
            items,
            { ...stock(2000, 0), labelOf: () => 'Golem Cave' }
        );
        const out = reduceBatchByQueue(batch, queued, LOOP);
        expect(out.blocked).toBeNull();
        expect(out.waitingBehind).toBe('Golem Cave');
        expect(out.notes).toEqual(['The new rows wait behind Golem Cave, which repeats forever, until you stop it.']);
        expect(out.skipped).toEqual([]);
        expect(out.batch.decomposeActions).toBe(1000);
    });

    test('with no display name to give it is a generic phrase, never the hrid tail', () => {
        const queued = queuedLegCounts(
            [row('/actions/combat/golem_cave', null, { hasMaxCount: false, maxCount: 0 })],
            items,
            stock(0)
        );
        expect(queued.endless).toBe('An action with no count');
    });

    test('with everything covered there is nothing to walk and nothing to block', () => {
        const out = reduce(
            [
                row('/actions/alchemy/decompose', FRUIT, { hasMaxCount: false, maxCount: 0, ordinal: 1 }),
                row('/actions/alchemy/coinify', ESSENCE, { hasMaxCount: false, maxCount: 0, ordinal: 2 }),
            ],
            2000,
            0
        );
        expect(out.batch.decomposeActions + out.batch.coinifyActions + out.batch.forageActions).toBe(0);
        expect(out.blocked).toBeNull();
    });

    test('does not change the batch it was given', () => {
        reduce([row('/actions/alchemy/coinify', ESSENCE, { maxCount: 300 })], 2000, 3000);
        expect(batch.coinifyActions).toBe(300);
    });
});

describe('the gold a batch needs behind the queue', () => {
    const loop = { decomposeBulk: 2, goldOutPerFruit: 375, coinsPerSuccess: 15_000, coinifyRate: 0.7, items };

    test('is the decompose fees, per action with the bulk folded in', () => {
        const stages = batchStages(loop, { decomposeActions: 100, coinifyActions: 30 });
        expect(coinReserve(stages).reserve).toBe(100 * 2 * 375);
    });

    test('an unpriced fee is unknown (null), never free', () => {
        expect(batchStages({ ...loop, goldOutPerFruit: undefined }, { decomposeActions: 5 })).toBeNull();
        expect(batchStages({ ...loop, goldOutPerFruit: Number.NaN }, { decomposeActions: 5 })).toBeNull();
        // nothing to pay for needs no price
        expect(batchStages({ ...loop, goldOutPerFruit: undefined }, { decomposeActions: 0 })).toEqual([]);
    });

    test('lands behind the queue: its dip is added to the queue’s, and earnings do not lower it', () => {
        const walked = {
            stages: [{ label: 'Decompose', coinDelta: -1000, earned: 0 }],
            stoppedAt: null,
        };
        const joined = withBatchStages(walked, batchStages(loop, { decomposeActions: 10, coinifyActions: 99 }));
        expect(coinReserve(joined.stages).reserve).toBe(1000 + 10 * 2 * 375);
    });

    test('a queue that never ends never reaches the batch', () => {
        const walked = { stages: [], stoppedAt: 'Forage' };
        expect(withBatchStages(walked, batchStages(loop, { decomposeActions: 10 }))).toBe(walked);
    });

    test('a leg the game queue already holds is walked once: only the missing part is added', () => {
        const queuedDecompose = 600;
        const walked = { stages: [{ label: 'Decompose', coinDelta: -600 * 2 * 375, earned: 0 }], stoppedAt: null };
        const queued = queuedLegCounts(
            [row('/actions/alchemy/decompose', FRUIT, { maxCount: queuedDecompose })],
            items,
            stock(5000)
        );
        const missing = reduceBatchByQueue(
            { decomposeActions: 1000, coinifyActions: 0, forageActions: 0 },
            queued,
            LOOP
        ).batch;
        const joined = withBatchStages(walked, batchStages(loop, missing));
        // 1000 decomposes in all, each paid once
        expect(coinReserve(joined.stages).reserve).toBe(1000 * 2 * 375);
    });

    test('the bells that can be bought follow the larger reserve, and reach zero rather than below', () => {
        const pricing = { price: 1_000_000, quoted: true };
        const walked = { stages: [{ label: 'Decompose', coinDelta: -1_000_000, earned: 0 }], stoppedAt: null };
        const plain = bellBudget(walked, 50_000_000, pricing);
        const withBatch = bellBudget(
            withBatchStages(walked, batchStages(loop, { decomposeActions: 60_000 })),
            50_000_000,
            pricing
        );
        expect(plain.can.bells).toBeGreaterThan(0);
        expect(withBatch.reserve).toBeGreaterThan(plain.reserve);
        expect(withBatch.can.bells).toBe(0);
    });
});

describe('the largest batch the gold pays for', () => {
    const loop = {
        missing: [],
        items,
        fruitPerForageAction: 1,
        forageActionsPerHour: 360,
        decomposeActionsPerHour: 180,
        coinifyActionsPerHour: 180,
        decomposeBulk: 1,
        coinifyBulk: 10,
        essencePerFruit: 3,
        goldOutPerFruit: 375,
        coinsPerSuccess: 15_000,
        coinifyRate: 0.7,
        bellPrice: 950_000,
    };
    const state = { starfruitHeld: 0, essenceHeld: 0, holdingsCredited: true };

    test('cuts the hours until the decompose fees fit, and never past the gold', () => {
        const out = affordableBatch(loop, state, 100_000, { hours: 16 });
        // 100,000 / 375 = 266 decomposes
        expect(out.batch.decomposeActions).toBeLessThanOrEqual(266);
        expect(out.batch.decomposeActions).toBeGreaterThan(250);
        expect(out.batch.decomposeActions * 375).toBeLessThanOrEqual(100_000);
        expect(out.hours).toBeLessThan(16);
    });

    test('an affordable batch is returned unchanged at the hours asked', () => {
        const out = affordableBatch(loop, state, 1e12, { hours: 16 });
        expect(out.hours).toBe(16);
        expect(out.batch.decomposeActions).toBe(1600);
    });

    test('Max is cut to the fruit the gold pays for', () => {
        const out = affordableBatch(loop, { ...state, starfruitHeld: 5000 }, 375 * 1200, { max: true });
        expect(out.batch.decomposeActions).toBe(1200);
    });

    test('decomposes already queued do not use up the gold', () => {
        const out = affordableBatch(loop, state, 375 * 100, { hours: 16, queuedDecompose: 500 });
        expect(out.batch.decomposeActions).toBeLessThanOrEqual(600);
        expect(out.batch.decomposeActions).toBeGreaterThan(590);
    });

    test('not even one fee, or an unpriced fee, gives no batch and a reason, never a zero queue', () => {
        const none = affordableBatch(loop, state, 10, { hours: 16 });
        expect(none.batch).toBeNull();
        expect(none.reason).toContain('does not cover');
        const unpriced = affordableBatch({ ...loop, goldOutPerFruit: undefined }, state, 1e9, { hours: 16 });
        expect(unpriced.batch).toBeNull();
        expect(unpriced.reason).toContain('no price');
    });
});

describe('when the queue runs out', () => {
    const NOW = Date.parse('2026-11-04T12:00:00');
    const walkedOf = (stages, stoppedAt = null) => ({ stages, stoppedAt });
    const stage = (over) => ({
        actionHrid: '/actions/alchemy/coinify',
        itemHrid: ESSENCE,
        count: 10,
        coinDelta: 0,
        earned: 0,
        seconds: 3600,
        ...over,
    });
    const text = (walked, coins = 0, bellPrice = 1000) =>
        queueEndText(walked, summarizeCycle(walked, { coins, loopItems: items, bellPrice }), {
            coins,
            bellPrice,
            now: NOW,
        });

    test('a clock time and an estimated bell count: gold on hand plus expected income less fees', () => {
        const walked = walkedOf([
            stage({ coinDelta: -2_000_000, actionHrid: '/actions/alchemy/decompose', itemHrid: FRUIT }),
            stage({ earned: 30_000_000 }),
        ]);
        const out = text(walked, 5_000_000, 1_000_000);
        // 5M + 30M - 2M = 33M gold = 33 bells -> 3 whole bags = 30 bells
        expect(out.text).toContain('about 30 bells by then (estimate)');
        expect(out.text).toContain('in 2h');
    });

    test('an empty queue says so, not a date', () => {
        expect(text(walkedOf([])).text).toBe('The queue is empty.');
    });

    test('an endless queue says it never runs out, not a date', () => {
        const out = text(walkedOf([], 'Forage: Star Fruit'));
        expect(out.text).toContain('never runs out');
        expect(out.text).not.toMatch(/\d:\d\d/);
    });

    test('a fight that cannot be timed leaves the end unknown', () => {
        const out = text(walkedOf([stage({ seconds: Infinity })]));
        expect(out.text).toContain('unknown');
    });

    test('without a bell price the time is still given and no bell figure is invented', () => {
        const out = text(walkedOf([stage({})]), 0, null);
        expect(out.text).toContain('The queue runs out');
        expect(out.text).not.toContain('bells');
    });

    test('an unreadable queue gives nothing', () => {
        expect(queueEndText(null, null, { coins: 1 })).toBeNull();
    });
});

describe('the keep-cash switch is a registered key', () => {
    test('so a sync owns it', () => {
        expect(OWNED_KEY_PREFIXES).toContain(KEEP_BATCH_CASH_KEY);
    });
});
