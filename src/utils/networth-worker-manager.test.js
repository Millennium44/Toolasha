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
