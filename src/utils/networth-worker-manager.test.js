import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

const pool = vi.hoisted(() => ({ script: null }));
const shop = vi.hoisted(() => ({ costs: {} }));
// What the main thread's shared input rule reads: this suite has no market feed, so the price map
// each test hands the batch stands in for the book, and the recipes for the craft-cost walk
const yielded = vi.hoisted(() => ({ count: 0 }));
const ctx = vi.hoisted(() => ({ priceMap: {}, recipes: {} }));
// The player's Artisan bonus per action type, and every task the pool was handed
const artisan = vi.hoisted(() => ({ byType: {}, asked: [], tasks: [] }));

// The manager reads the bonus on the main thread; this suite has no tea-parser feed behind it
vi.mock('./artisan-bonus.js', () => ({
    getArtisanBonus: (type) => {
        artisan.asked.push(type);
        return artisan.byType[type] ?? 0;
    },
}));

// The shop's coin price is read off the game data, which this suite has none of
vi.mock('./game-lookups.js', () => ({ getShopCoinCost: (hrid) => shop.costs[hrid] || 0 }));

vi.mock('./yield-to-browser.js', () => ({
    yieldToBrowser: async () => {
        yielded.count++;
    },
}));

// The shared enhancement input rule, emulated over the test's own price map: the main thread resolves
// every input with it and ships the figures to the worker, which is what these cases exercise
vi.mock('./enhancement-input-pricing.js', async () => {
    const { applyInflationGuard } = await import('./enhancement-pricing.js');
    const sides = (hrid) => {
        const positive = (value) => (value > 0 ? value : 0);
        const ask = positive(ctx.priceMap[hrid + ':0_ask'] ?? ctx.priceMap[hrid + ':0']);
        const bid = positive(ctx.priceMap[hrid + ':0_bid']);
        return { ask, bid };
    };
    const craftCost = (hrid) => {
        for (const recipe of Object.values(ctx.recipes)) {
            const out = (recipe.outputItems || []).find((o) => o.itemHrid === hrid);
            if (!out) continue;
            let total = 0;
            for (const input of recipe.inputItems || []) {
                const { ask, bid } = sides(input.itemHrid);
                total += (ask || bid) * input.count;
            }
            return total / (out.count || 1);
        }
        return 0;
    };
    const answer = (price) => ({ price: price > 0 ? price : null, unpriced: !(price > 0), estimated: false });
    const guarded = (hrid) => answer(applyInflationGuard({ ...sides(hrid), productionCost: craftCost(hrid) }));
    return {
        priceMaterial: (hrid) => {
            if (hrid.startsWith('/items/trainee_')) return answer(250_000);
            if (hrid === '/items/coin') return answer(1);
            const { ask, bid } = sides(hrid);
            return answer(ask || bid || craftCost(hrid));
        },
        priceGuarded: guarded,
        priceBase: guarded,
    };
});

// The pool runs the real worker script in a vm sandbox instead of a Web Worker, so the test
// drives the exact text the browser would ship.
vi.mock('./worker-pool.js', () => {
    class FakePool {
        constructor(blob) {
            this.blob = blob;
        }
        async initialize() {
            pool.script = await this.blob.text();
        }
        getStats() {
            return { poolSize: 1, busyWorkers: 0, queuedTasks: 0 };
        }
        async executeAll(tasks) {
            artisan.tasks.push(...tasks);
            return tasks.map((task) => {
                const posted = [];
                const sandbox = { self: { postMessage: (message) => posted.push(message) }, console };
                vm.runInNewContext(pool.script, sandbox);
                sandbox.self.onmessage({ data: { taskId: 1, data: task } });
                const message = posted[0];
                if (message.error) throw new Error(message.error);
                return message.result;
            });
        }
        terminate() {}
    }
    return { default: FakePool, createIdlePoolReaper: () => ({ touch() {}, cancel() {} }) };
});

const { calculateItemValueBatch, terminateItemValueWorkerPool } = await import('./networth-worker-manager.js');

/** calculateItemValueBatch, with the shared rule's fake book pointed at this call's price map */
async function runBatch(items, priceMap, configOptions, gameData) {
    ctx.priceMap = priceMap;
    ctx.recipes = gameData.actionDetailMap || {};
    return calculateItemValueBatch(items, priceMap, configOptions, gameData);
}

const ITEM = '/items/sword';
const itemDetailMap = {
    [ITEM]: {
        itemLevel: 10,
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
        protectionItemHrids: [],
    },
};

async function valueWith(enhancementParams) {
    const [value] = await runBatch(
        [{ itemHrid: ITEM, enhancementLevel: 8, count: 1 }],
        { [`${ITEM}:0`]: 1000, [`${ITEM}:0_ask`]: 1000, [`${ITEM}:0_bid`]: 1000 },
        { useHighEnhancementCost: false, minLevel: 99, enhancementParams },
        { itemDetailMap, actionDetailMap: {} }
    );
    return value;
}

describe('networth enhancement cost under Blessed Tea', () => {
    const bench = { enhancingLevel: 60, toolBonus: 10, blessedTeaBonus: 0.5, guzzlingBonus: 1 };

    test('the nested teas.blessed shape that getEnhancingParams() returns is costed with Blessed', async () => {
        const without = await valueWith({ ...bench, teas: { blessed: false } });
        const nested = await valueWith({ ...bench, teas: { blessed: true } });
        const flat = await valueWith({ ...bench, blessedTea: true });

        terminateItemValueWorkerPool();
        expect(nested).toBeLessThan(without);
        expect(nested).toBeCloseTo(flat, 6);
    });
});

describe('networth enhancement materials with no market quote', () => {
    const MAT = '/items/rare_mat';
    const params = { enhancingLevel: 60, toolBonus: 10, blessedTeaBonus: 0, guzzlingBonus: 1 };
    const prices = { [`${ITEM}:0`]: 1000, [`${ITEM}:0_ask`]: 1000, [`${ITEM}:0_bid`]: 1000 };

    const value = async (materials, actionDetailMap, priceMap = prices) => {
        const [v] = await runBatch(
            [{ itemHrid: ITEM, enhancementLevel: 5, count: 1 }],
            priceMap,
            { useHighEnhancementCost: false, minLevel: 99, enhancementParams: params },
            {
                itemDetailMap: {
                    [ITEM]: { itemLevel: 10, enhancementCosts: materials, protectionItemHrids: [] },
                    [MAT]: { name: 'Rare Mat', sellPrice: 50_000 },
                    '/items/ore': { name: 'Ore' },
                },
                actionDetailMap,
            }
        );
        return v;
    };

    test('makes the path unavailable (base price), not booked at its vendor price', async () => {
        const unpriced = await value([{ itemHrid: MAT, count: 10 }], {});
        const vendorPriced = await value([{ itemHrid: '/items/coin', count: 10 * 50_000 }], {});

        expect(unpriced).toBe(1000);
        expect(unpriced).toBeLessThan(vendorPriced);
    });

    test('a partial bill is not the value: coins priced, one material unpriced falls back to base', async () => {
        const partial = await value(
            [
                { itemHrid: '/items/coin', count: 5000 },
                { itemHrid: MAT, count: 10 },
            ],
            {}
        );
        const coinsOnly = await value([{ itemHrid: '/items/coin', count: 5000 }], {});

        expect(partial).toBe(1000);
        expect(coinsOnly).toBeGreaterThan(1000);
    });

    test('a trainee charm stays priced', async () => {
        const v = await value([{ itemHrid: '/items/trainee_charm', count: 1 }], {});
        expect(v).toBeGreaterThan(1000);
    });

    test('a craftable but unlisted material is costed from its recipe', async () => {
        const recipe = {
            '/actions/make_mat': {
                inputItems: [{ itemHrid: '/items/ore', count: 2 }],
                outputItems: [{ itemHrid: MAT, count: 1 }],
            },
        };
        const crafted = await value([{ itemHrid: MAT, count: 10 }], recipe, { ...prices, '/items/ore:0': 400 });
        const without = await value([], recipe, { ...prices, '/items/ore:0': 400 });

        expect(crafted).toBeGreaterThan(without);
    });

    test('a -1 quote on both sides is not a negative cost', async () => {
        const priceMap = { ...prices, [`${MAT}:0_ask`]: -1, [`${MAT}:0_bid`]: -1 };
        const quoted = await value([{ itemHrid: MAT, count: 10 }], {}, priceMap);

        expect(quoted).toBe(1000);
    });
});

describe('resolving the shipped input prices', () => {
    test('hands the browser a frame while it works through a long batch', async () => {
        yielded.count = 0;
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 20));
        try {
            const hrids = ['/items/a', '/items/b', '/items/c', '/items/d'];
            const itemDetailMap = Object.fromEntries(
                hrids.map((hrid) => [hrid, { itemLevel: 10, enhancementCosts: [], protectionItemHrids: [] }])
            );
            await runBatch(
                hrids.map((itemHrid) => ({ itemHrid, enhancementLevel: 5, count: 1 })),
                {},
                { useHighEnhancementCost: false, minLevel: 99, enhancementParams: {} },
                { itemDetailMap, actionDetailMap: {} }
            );
        } finally {
            clock.mockRestore();
        }
        expect(yielded.count).toBeGreaterThan(0);
    });
});

describe('the worker with nothing shipped', () => {
    test('a trainee charm still costs the shop price, not nothing', async () => {
        // Run any batch so the worker source is captured, then hand the worker a task that carries no
        // inputPrices at all (an older caller, a test): it must fall back to the shop constant
        const params = { enhancingLevel: 60, toolBonus: 10, blessedTeaBonus: 0, guzzlingBonus: 1 };
        const priceMap = { [`${ITEM}:0`]: 1000, [`${ITEM}:0_ask`]: 1000, [`${ITEM}:0_bid`]: 1000 };
        await runBatch(
            [{ itemHrid: ITEM, enhancementLevel: 5, count: 1 }],
            priceMap,
            { useHighEnhancementCost: false, minLevel: 99, enhancementParams: params },
            {
                itemDetailMap: { [ITEM]: { itemLevel: 10, enhancementCosts: [], protectionItemHrids: [] } },
                actionDetailMap: {},
            }
        );

        const posted = [];
        const sandbox = { self: { postMessage: (message) => posted.push(message) }, console };
        vm.runInNewContext(pool.script, sandbox);
        sandbox.self.onmessage({
            data: {
                taskId: 1,
                data: {
                    action: 'calculateBatch',
                    params: {
                        items: [
                            {
                                itemIndex: 0,
                                item: { itemHrid: ITEM, enhancementLevel: 5, count: 1 },
                                itemDetails: {
                                    itemLevel: 10,
                                    enhancementCosts: [{ itemHrid: '/items/trainee_charm', count: 1 }],
                                    protectionItemHrids: [],
                                },
                            },
                        ],
                        priceMap,
                        recipes: {},
                        shopCosts: {},
                        useHighEnhancementCost: false,
                        minLevel: 99,
                        enhancementParams: params,
                    },
                },
            },
        });

        expect(posted[0].error).toBeUndefined();
        // At least one attempt at 250,000 on top of the 1,000 base
        expect(posted[0].result[0].value).toBeGreaterThan(250_000);
    });
});

describe('networth enhancement path parity with the main thread', () => {
    const MAT = '/items/rare_mat';
    const MIRROR = '/items/philosophers_mirror';
    const params = { enhancingLevel: 60, toolBonus: 10, blessedTeaBonus: 0, guzzlingBonus: 1 };
    const base = { [`${ITEM}:0`]: 1000, [`${ITEM}:0_ask`]: 1000, [`${ITEM}:0_bid`]: 1000 };

    const value = async (materials, priceMap, level = 5, shopCosts = {}) => {
        shop.costs = shopCosts;
        const [v] = await runBatch(
            [{ itemHrid: ITEM, enhancementLevel: level, count: 1 }],
            priceMap,
            { useHighEnhancementCost: false, minLevel: 99, enhancementParams: params },
            {
                itemDetailMap: {
                    [ITEM]: { itemLevel: 10, enhancementCosts: materials, protectionItemHrids: [] },
                    [MAT]: { name: 'Rare Mat' },
                },
                actionDetailMap: {},
            }
        );
        return v;
    };

    test('a material quoted on the bid side only is priced at it, as the main thread prices it', async () => {
        // The order book answers a missing side with null, and null < 0 is false: the old
        // cross-fill never fired, the material read unpriced and the whole path fell back to base
        const materials = [{ itemHrid: MAT, count: 10 }];
        const bidOnly = await value(materials, { ...base, [`${MAT}:0_ask`]: null, [`${MAT}:0_bid`]: 300 });
        const twoSided = await value(materials, { ...base, [`${MAT}:0_ask`]: 300, [`${MAT}:0_bid`]: 300 });
        const askOnly = await value(materials, { ...base, [`${MAT}:0_ask`]: 300, [`${MAT}:0_bid`]: null });

        expect(twoSided).toBeGreaterThan(1000);
        expect(bidOnly).toBeCloseTo(twoSided, 6);
        expect(askOnly).toBeCloseTo(twoSided, 6);
    });

    test('the mirror is priced as the tooltip prices it, not at the pricing-mode price', async () => {
        // A wide spread: the realistic rule takes the bid (nothing crafts a mirror here), while the
        // pricing-mode key holds the ask. A mirror at the bid is far cheaper, and the +12 path uses it.
        const coins = [{ itemHrid: '/items/coin', count: 1000 }];
        const spread = {
            ...base,
            [`${MIRROR}:0`]: 5_000_000,
            [`${MIRROR}:0_ask`]: 5_000_000,
            [`${MIRROR}:0_bid`]: 10,
        };
        const atBid = { ...base, [`${MIRROR}:0`]: 10, [`${MIRROR}:0_ask`]: 10, [`${MIRROR}:0_bid`]: 10 };
        const atAsk = {
            ...base,
            [`${MIRROR}:0`]: 5_000_000,
            [`${MIRROR}:0_ask`]: 5_000_000,
            [`${MIRROR}:0_bid`]: 5_000_000,
        };

        const quoted = await value(coins, spread, 12);
        expect(quoted).toBeCloseTo(await value(coins, atBid, 12), 6);
        expect(quoted).toBeLessThan(await value(coins, atAsk, 12));
    });

    test('a shop-sold piece with no market quote is worth its shop price, not 0', async () => {
        const coins = [{ itemHrid: '/items/coin', count: 1000 }];
        const noQuote = {};

        expect(await value(coins, noQuote, 5)).toBe(0);
        expect(await value(coins, noQuote, 5, { [ITEM]: 7000 })).toBe(7000);
    });
});

describe('networth production-cost fallback uses the real Artisan bonus', () => {
    const PLANK = '/items/plank';
    const SMITH = '/items/anvil';
    const gameData = {
        itemDetailMap: {},
        actionDetailMap: {
            '/actions/saw': {
                type: '/action_types/woodcutting_craft',
                outputItems: [{ itemHrid: PLANK, count: 1 }],
                inputItems: [{ itemHrid: '/items/log', count: 4 }],
            },
            '/actions/forge': {
                type: '/action_types/forging',
                outputItems: [{ itemHrid: SMITH, count: 1 }],
                inputItems: [{ itemHrid: '/items/log', count: 4 }],
            },
        },
    };
    const priceMap = { '/items/log:0': 10, '/items/log:0_ask': 10, '/items/log:0_bid': 10 };
    const value = async (hrid) => {
        const [v] = await runBatch(
            [{ itemHrid: hrid, enhancementLevel: 0, count: 1 }],
            priceMap,
            { useHighEnhancementCost: false, minLevel: 99, enhancementParams: {} },
            gameData
        );
        terminateItemValueWorkerPool();
        return v;
    };

    test('no Artisan is a factor of 1, not 0.9', async () => {
        artisan.byType = {};
        expect(await value(PLANK)).toBeCloseTo(40, 9);
    });

    test('a known bonus is applied, per the recipe own skill, and rides the payload', async () => {
        artisan.byType = { '/action_types/woodcutting_craft': 0.25, '/action_types/forging': 0.1 };
        artisan.tasks = [];
        expect(await value(PLANK)).toBeCloseTo(30, 9); // 4 x 10 x (1 - 0.25)
        const shipped = artisan.tasks[0].params.recipes[PLANK];
        expect(shipped.artisanBonus).toBe(0.25);
        expect(await value(SMITH)).toBeCloseTo(36, 9); // the forging tea, not the woodcutting one
    });

    test('a tea change shows in the next batch: the bonus is read per batch, never memoized', async () => {
        artisan.byType = { '/action_types/woodcutting_craft': 0.2 };
        const withTea = await value(PLANK);
        artisan.byType = {};
        const without = await value(PLANK);
        expect(withTea).toBeCloseTo(32, 9);
        expect(without).toBeCloseTo(40, 9);
    });
});
