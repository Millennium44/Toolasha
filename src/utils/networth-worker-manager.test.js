import vm from 'node:vm';
import { describe, expect, test, vi } from 'vitest';

const pool = vi.hoisted(() => ({ script: null }));

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

const ITEM = '/items/sword';
const itemDetailMap = {
    [ITEM]: {
        itemLevel: 10,
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
        protectionItemHrids: [],
    },
};

async function valueWith(enhancementParams) {
    const [value] = await calculateItemValueBatch(
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
        const [v] = await calculateItemValueBatch(
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

    test('is left out of the sum, not booked at its vendor price', async () => {
        const unpriced = await value([{ itemHrid: MAT, count: 10 }], {});
        const without = await value([], {});
        const vendorPriced = await value([{ itemHrid: '/items/coin', count: 10 * 50_000 }], {});

        expect(unpriced).toBe(without);
        expect(unpriced).toBeLessThan(vendorPriced);
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
        const without = await value([], {}, priceMap);

        expect(quoted).toBe(without);
    });
});
