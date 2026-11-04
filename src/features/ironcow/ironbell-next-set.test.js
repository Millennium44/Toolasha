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
    actionHrid,
    primaryItemHash: item ? hash(item) : undefined,
    hasMaxCount: true,
    maxCount: 100,
    currentCount: 0,
    isDone: false,
    ...extra,
});

describe('what the game queue already holds of each leg', () => {
    test('matches by action AND item: alchemy on another item is not a loop leg', () => {
        const queued = queuedLegCounts(
            [row('/actions/alchemy/decompose', OTHER), row('/actions/alchemy/coinify', FRUIT)],
            items
        );
        expect(queued.decompose.count).toBe(0);
        expect(queued.coinify.count).toBe(0);
    });

    test('counts what each unfinished row has left, the running one included, finished rows not at all', () => {
        const queued = queuedLegCounts(
            [
                row('/actions/alchemy/coinify', ESSENCE, { maxCount: 500, currentCount: 120 }),
                row('/actions/alchemy/coinify', ESSENCE, { maxCount: 50 }),
                row('/actions/alchemy/coinify', ESSENCE, { maxCount: 999, isDone: true }),
            ],
            items
        );
        expect(queued.coinify).toEqual({ count: 430, endless: false });
    });

    test('a row with no count is endless', () => {
        const queued = queuedLegCounts([row(items.forageActionHrid, null, { hasMaxCount: false })], items);
        expect(queued.forage.endless).toBe(true);
    });

    test('does not read the queue by position: a queued leg ahead of the running one still counts', () => {
        const queued = queuedLegCounts(
            [row('/actions/alchemy/decompose', OTHER), row('/actions/alchemy/decompose', FRUIT, { maxCount: 7 })],
            items
        );
        expect(queued.decompose.count).toBe(7);
    });
});

describe('walking only what is missing', () => {
    const batch = { forageActions: 0, decomposeActions: 1000, coinifyActions: 300 };
    const queued = (over) => ({
        forage: { count: 0, endless: false },
        decompose: { count: 0, endless: false },
        coinify: { count: 0, endless: false },
        ...over,
    });

    test('a leg queued at a sufficient count is skipped and named', () => {
        const out = reduceBatchByQueue(batch, queued({ coinify: { count: 300, endless: false } }));
        expect(out.batch.coinifyActions).toBe(0);
        expect(out.batch.decomposeActions).toBe(1000);
        expect(out.skipped).toEqual(['Coinify']);
    });

    test('a leg queued at less keeps only the difference', () => {
        const out = reduceBatchByQueue(batch, queued({ decompose: { count: 400, endless: false } }));
        expect(out.batch.decomposeActions).toBe(600);
        expect(out.partial).toEqual(['Decompose']);
    });

    test('nothing queued walks the whole batch; everything queued walks nothing', () => {
        expect(reduceBatchByQueue(batch, queued({})).batch).toMatchObject(batch);
        const all = reduceBatchByQueue(
            batch,
            queued({ decompose: { count: 5000, endless: false }, coinify: { count: 0, endless: true } })
        );
        expect(all.batch.decomposeActions + all.batch.coinifyActions).toBe(0);
    });

    test('does not change the batch it was given', () => {
        reduceBatchByQueue(batch, queued({ coinify: { count: 300, endless: false } }));
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
        const missing = reduceBatchByQueue(
            { decomposeActions: 1000, coinifyActions: 0, forageActions: 0 },
            {
                forage: { count: 0, endless: false },
                decompose: { count: queuedDecompose, endless: false },
                coinify: { count: 0, endless: false },
            }
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
