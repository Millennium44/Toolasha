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

    test('the pruned closure prices every hrid the worker can reach', async () => {
        // Differential proof that pruning is invisible: the real manager runs
        // end-to-end through a fake Worker (so the batch carries only the
        // pruned closure), and every value must match the same worker source
        // evaluated against the FULL price map and FULL recipe index. Any
        // reachable-but-unclosed hrid prices 0 only on the pruned side and
        // splits the two answers. The fixture is built to reach the deep
        // paths: a protection item priced only through a two-level production
        // chain (inputs and an upgrade item), enhancement materials read
        // through the price map, both mirrors, and a plain item priced only
        // through a transitive production input.
        vi.resetModules();

        let workerSource = null;
        vi.stubGlobal(
            'Blob',
            class {
                constructor(parts) {
                    this.text = parts[0];
                    workerSource = parts[0];
                }
            }
        );
        // Keep URL constructable (vitest internals build URLs); only the
        // object-URL statics are faked, handing the source text through
        const RealURL = globalThis.URL;
        vi.stubGlobal(
            'URL',
            class extends RealURL {
                static createObjectURL(blob) {
                    return blob.text;
                }
                static revokeObjectURL() {}
            }
        );
        vi.stubGlobal('navigator', { hardwareConcurrency: 2 });

        const sentParams = [];
        vi.stubGlobal(
            'Worker',
            class {
                constructor(source) {
                    this._listeners = { message: new Set(), error: new Set() };
                    const workerSelf = {
                        onmessage: null,
                        postMessage: (message) => {
                            queueMicrotask(() => {
                                for (const listener of this._listeners.message) listener({ data: message });
                            });
                        },
                    };
                    new Function('self', source)(workerSelf);
                    this._self = workerSelf;
                }
                postMessage(message) {
                    sentParams.push(message.data.params);
                    queueMicrotask(() => this._self.onmessage({ data: message }));
                }
                addEventListener(type, listener) {
                    this._listeners[type].add(listener);
                }
                removeEventListener(type, listener) {
                    this._listeners[type].delete(listener);
                }
                terminate() {}
            }
        );

        const gameData = {
            actionDetailMap: {
                '/actions/craft_sword': {
                    outputItems: [{ itemHrid: '/items/iron_sword', count: 1 }],
                    inputItems: [{ itemHrid: '/items/iron_bar', count: 2 }],
                },
                '/actions/craft_prot_orb': {
                    outputItems: [{ itemHrid: '/items/prot_orb', count: 1 }],
                    inputItems: [{ itemHrid: '/items/orb_shard', count: 3 }],
                    upgradeItemHrid: '/items/orb_core',
                },
                '/actions/craft_orb_core': {
                    outputItems: [{ itemHrid: '/items/orb_core', count: 1 }],
                    inputItems: [{ itemHrid: '/items/core_dust', count: 2 }],
                },
                '/actions/craft_mirror': {
                    outputItems: [{ itemHrid: '/items/philosophers_mirror', count: 1 }],
                    inputItems: [{ itemHrid: '/items/mirror_shard', count: 5 }],
                },
            },
            itemDetailMap: {
                '/items/iron_sword': {
                    itemLevel: 10,
                    sellPrice: 5,
                    enhancementCosts: [
                        { itemHrid: '/items/enhance_stone', count: 1 },
                        { itemHrid: '/items/coin', count: 100 },
                    ],
                    protectionItemHrids: ['/items/prot_orb'],
                },
                '/items/enhance_stone': { sellPrice: 30, name: 'Enhance Stone' },
                '/items/orb_core': { sellPrice: 3, name: 'Orb Core' },
            },
        };

        // Deliberately unpriced: prot_orb, orb_core, philosophers_mirror — the
        // worker can only price them through the recipe closure.
        const fullPriceMap = {
            '/items/iron_sword:0': 1000,
            '/items/iron_sword:0_ask': 1000,
            '/items/iron_sword:0_bid': 900,
            '/items/iron_bar:0': 100,
            '/items/iron_bar:0_ask': 100,
            '/items/enhance_stone:0': 50,
            '/items/enhance_stone:0_ask': 50,
            '/items/enhance_stone:0_bid': 40,
            '/items/orb_shard:0': 20,
            '/items/orb_shard:0_ask': 20,
            '/items/core_dust:0': 7,
            '/items/core_dust:0_ask': 7,
            '/items/mirror_shard:0': 11,
            '/items/mirror_shard:0_ask': 11,
            '/items/mirror_of_protection:0': 500000,
            '/items/mirror_of_protection:0_ask': 500000,
            '/items/mirror_of_protection:0_bid': 490000,
        };

        const configOptions = {
            useHighEnhancementCost: true,
            minLevel: 13,
            enhancementParams: { enhancingLevel: 100, toolBonus: 0 },
        };
        const items = [
            // High-enhancement: full strategy search with protection chains
            { itemHrid: '/items/iron_sword', enhancementLevel: 14, count: 1 },
            // Enhanced, no market price at its level: enhancement-cost path
            { itemHrid: '/items/iron_sword', enhancementLevel: 3, count: 1 },
            // Unpriced base item reachable only through core_dust production
            { itemHrid: '/items/orb_core', enhancementLevel: 0, count: 4 },
        ];

        const { calculateItemValueBatch, terminateItemValueWorkerPool } = await import('./networth-worker-manager.js');
        let values;
        try {
            values = await calculateItemValueBatch(items, fullPriceMap, configOptions, gameData);
        } finally {
            terminateItemValueWorkerPool();
        }

        // Control: the same worker source valuing the same items against the
        // UNPRUNED context — the full price map and the full recipe index.
        const workerCalculate = new Function('self', `${workerSource}\n; return calculateItemValue;`)({
            postMessage: () => {},
            onmessage: null,
        });
        const fullRecipes = {};
        for (const action of Object.values(gameData.actionDetailMap)) {
            const primary = action.outputItems[0].itemHrid;
            if (!(primary in fullRecipes)) {
                fullRecipes[primary] = {
                    inputItems: action.inputItems || null,
                    upgradeItemHrid: action.upgradeItemHrid || null,
                    outputItems: action.outputItems,
                };
            }
        }
        const expected = items.map((item, index) => {
            const itemDetails = gameData.itemDetailMap[item.itemHrid];
            const allItemDetails = {};
            if (itemDetails?.enhancementCosts) {
                for (const material of itemDetails.enhancementCosts) {
                    const materialDetail = gameData.itemDetailMap[material.itemHrid];
                    if (materialDetail) {
                        allItemDetails[material.itemHrid] = {
                            sellPrice: materialDetail.sellPrice,
                            name: materialDetail.name,
                        };
                    }
                }
            }
            return workerCalculate({
                itemIndex: index,
                item,
                itemDetails: itemDetails ? { ...itemDetails, allItemDetails } : {},
                priceMap: fullPriceMap,
                recipes: fullRecipes,
                useHighEnhancementCost: configOptions.useHighEnhancementCost,
                minLevel: configOptions.minLevel,
                enhancementParams: configOptions.enhancementParams,
            }).value;
        });

        expect(values).toEqual(expected);
        // Nothing degenerated to zero: the deep chains actually priced
        for (const value of values) expect(value).toBeGreaterThan(0);

        // And the closure the chunk carried names the deep reaches explicitly
        expect(sentParams.length).toBeGreaterThan(0);
        const shared = sentParams[0];
        expect(shared.recipes).toHaveProperty('/items/prot_orb');
        expect(shared.recipes).toHaveProperty('/items/orb_core');
        expect(shared.recipes).toHaveProperty('/items/philosophers_mirror');
        expect(shared.priceMap).toHaveProperty('/items/core_dust:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/orb_shard:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/mirror_shard:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/mirror_of_protection:0_ask');
        expect(shared.priceMap).toHaveProperty('/items/enhance_stone:0_bid');
    });
});
