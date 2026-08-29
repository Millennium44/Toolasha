/**
 * The worker scripts are built by string concatenation, which no amount of
 * linting checks. Two things can go wrong and did: the source can fail to
 * parse, and the chain inside it can drift from the one on the main thread.
 *
 * Since the matrix helper is serialised in alongside the chain — replacing an
 * `importScripts` of ~600 KB of math.js per worker — both risks now apply to
 * it too, so the generated source is parsed and run here and its answers
 * compared against the main-thread calculator's.
 */
import { describe, test, expect, vi, afterEach } from 'vitest';

/**
 * Capture the worker source a manager hands to `new Blob([...])`.
 * @param {Function} load - Imports the manager and provokes the pool creation
 * @returns {Promise<string>} The worker script text
 */
async function captureWorkerScript(load) {
    let captured = null;
    vi.stubGlobal(
        'Blob',
        class {
            constructor(parts) {
                captured = parts[0];
            }
        }
    );
    vi.stubGlobal('navigator', { hardwareConcurrency: 2 });

    // There is no real Worker here, so pool creation throws after the Blob is
    // built — which is all this needs.
    await load().catch(() => {});

    expect(captured).toBeTruthy();
    return captured;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('generated worker sources', () => {
    test('the enhancement worker parses, pulls in no CDN library, and matches the calculator', async () => {
        const { calculateEnhancementAsync } = await import('./enhancement-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateEnhancementAsync({ enhancingLevel: 100, toolBonus: 0, itemLevel: 50, targetLevel: 5 })
        );

        expect(source).not.toContain("importScripts('http");

        // Parsing and running it is the point: a template-literal mistake in
        // the serialised helper shows up here and nowhere else.
        const calculateEnhancement = new Function('self', `${source}\n; return calculateEnhancement;`)({
            postMessage: () => {},
            onmessage: null,
        });

        const params = { enhancingLevel: 100, toolBonus: 5, itemLevel: 60, targetLevel: 10, protectFrom: 5 };
        const fromWorker = calculateEnhancement(params);

        const { calculateEnhancement: mainThread } = await import('./enhancement-calculator.js');
        const fromMain = mainThread(params);

        expect(fromWorker.attempts).toBeCloseTo(fromMain.attempts, 9);
        expect(fromWorker.protectionCount).toBeCloseTo(fromMain.protectionCount, 9);
    });

    test('the networth worker parses and pulls in no CDN library', async () => {
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} })
        );

        expect(source).not.toContain("importScripts('http");

        // Parses, and the serialised matrix helper is intact inside it
        const math = new Function('self', `${source}\n; return math;`)({ postMessage: () => {}, onmessage: null });
        const identity = math.identity(3);
        expect(math.inv(identity).get([2, 2])).toBe(1);
    });

    test('the networth worker values a batch from chunk-level shared context', async () => {
        // The 2026-08-29 protocol change: priceMap and the recipe index ride
        // the message once per chunk instead of once per item, and production
        // cost reads recipes[hrid] instead of scanning every action. These are
        // the fallback chains the pruning must not have changed.
        vi.resetModules(); // the manager memoises its pool, and a memoised pool builds no Blob
        const { calculateItemValueBatch } = await import('./networth-worker-manager.js');
        const source = await captureWorkerScript(() =>
            calculateItemValueBatch([], {}, {}, { itemDetailMap: {}, actionDetailMap: {} })
        );

        const messages = [];
        const self = { postMessage: (message) => messages.push(message), onmessage: null };
        new Function('self', source)(self);

        const shared = {
            priceMap: {
                '/items/iron_sword:0': 100,
                '/items/iron_sword:3': 900,
                '/items/log:0_ask': 10,
                '/items/log:0': 10,
            },
            recipes: {
                '/items/plank': { inputItems: [{ itemHrid: '/items/log', count: 2 }], upgradeItemHrid: null },
            },
            useHighEnhancementCost: false,
            minLevel: 13,
            enhancementParams: {},
        };
        const items = [
            // Priced plain stack: unit price times count
            { itemIndex: 0, item: { itemHrid: '/items/iron_sword', enhancementLevel: 0, count: 5 }, itemDetails: {} },
            // Unpriced but craftable: production cost through the recipe index,
            // with the Artisan Tea 0.9 on inputs - 2 logs x 10 x 0.9 = 18 each
            { itemIndex: 1, item: { itemHrid: '/items/plank', enhancementLevel: 0, count: 2 }, itemDetails: {} },
            // Enhanced with a market price at its level: that price wins
            { itemIndex: 2, item: { itemHrid: '/items/iron_sword', enhancementLevel: 3, count: 1 }, itemDetails: {} },
            // Neither priced nor craftable: honestly zero
            { itemIndex: 3, item: { itemHrid: '/items/mystery', enhancementLevel: 0, count: 7 }, itemDetails: {} },
        ];

        self.onmessage({ data: { taskId: 1, data: { action: 'calculateBatch', params: { items, ...shared } } } });

        expect(messages).toHaveLength(1);
        expect(messages[0].error).toBeUndefined();
        const byIndex = new Map(messages[0].result.map((entry) => [entry.itemIndex, entry.value]));
        expect(byIndex.get(0)).toBe(500);
        expect(byIndex.get(1)).toBe(36);
        expect(byIndex.get(2)).toBe(900);
        expect(byIndex.get(3)).toBe(0);
    });
});
