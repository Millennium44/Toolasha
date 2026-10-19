/**
 * Net worth's "partial" flag for an enhanced item, on both threads, from the inputs the enhancement
 * path actually SELECTED.
 *
 * The real tooltip path (main thread) and the real worker source (fed by the real batch function, which
 * resolves every input with the shared rule and ships the figures) are driven over one fixture. A
 * crafted base chosen over a market quote, a crafted protection item and a crafted mirror, each with a
 * recipe input nothing prices, must be flagged on both; the same items with that input priced must not.
 */

import vm from 'node:vm';
import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as mathjs from 'mathjs';

const SWORD = '/items/cheese_sword';
const REFINED = '/items/cheese_sword_refined';
const PROT = '/items/cheese_guard';
const MIRROR = '/items/philosophers_mirror';
const ORE = '/items/ore';
const DUST = '/items/mystery_dust';

const state = vi.hoisted(() => ({
    books: {},
    actions: {},
    craftingSetting: false,
    script: null,
    // Moves every test: the craft-cost memo is module state and only a version bump empties it
    version: 0,
}));

const ITEM_DETAIL_MAP = {
    [SWORD]: {
        hrid: SWORD,
        name: 'Cheese Sword',
        itemLevel: 10,
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1_000_000 }],
        protectionItemHrids: [PROT],
    },
    [REFINED]: {
        hrid: REFINED,
        name: 'Cheese Sword (Refined)',
        itemLevel: 10,
        enhancementCosts: [{ itemHrid: '/items/coin', count: 1_000_000 }],
        protectionItemHrids: [PROT],
    },
    [PROT]: { hrid: PROT, name: 'Cheese Guard' },
    [MIRROR]: { hrid: MIRROR, name: "Philosopher's Mirror" },
    [ORE]: { hrid: ORE, name: 'Ore' },
    [DUST]: { hrid: DUST, name: 'Mystery Dust' },
    '/items/mirror_of_protection': { name: 'Mirror of Protection' },
};

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: state.actions }),
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getBuffStateVersion: () => state.version,
        getAchievementBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: (key) => key === 'enhanceSim_baseItemCraftingCost' && state.craftingSetting,
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
    },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { on: () => {}, getPrice: () => null } }));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: [] }),
}));
vi.mock('../../utils/tea-parser.js', () => ({ parseArtisanBonus: () => 0, getDrinkConcentration: () => 0 }));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => false }));
vi.mock('../settings/custom-price-overrides.js', () => ({
    getCustomPrice: () => null,
    getCustomPriceVersion: () => 0,
}));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    describeEnhancementSource: () => ({ detail: '' }),
    buildSourceChipHTML: () => '',
    enhancementParamsFor: () => ({}),
    sectionAttributes: () => '',
    toggleProRates: () => {},
    SECTION_ATTR: 'data-x',
    SOURCE_CHIP_CLASS: 'x',
}));
vi.mock('../../utils/market-data.js', () => {
    const reconciled = (hrid, level = 0) => {
        const book = state.books[`${hrid}:${level}`];
        if (!book) return null;
        const ask = book.ask > 0 ? book.ask : book.bid > 0 ? book.bid : null;
        return ask === null ? null : { ask, bid: book.bid > 0 ? book.bid : ask };
    };
    return {
        getPricingMode: () => 'ask',
        getItemPriceInfo: (hrid, { enhancementLevel = 0 } = {}) => {
            const book = reconciled(hrid, enhancementLevel);
            return book
                ? { price: book.ask, source: 'book', estimated: false }
                : { price: null, source: null, estimated: false };
        },
        getItemPrices: (hrid, level = 0) => {
            const book = state.books[`${hrid}:${level}`];
            return book ? { ask: book.ask ?? null, bid: book.bid ?? null } : null;
        },
        getItemPrice: (hrid, { mode = 'ask' } = {}) => reconciled(hrid)?.[mode] || 0,
    };
});
// The pool runs the real worker script in a vm sandbox instead of a Web Worker
vi.mock('../../utils/worker-pool.js', () => {
    class FakePool {
        constructor(blob) {
            this.blob = blob;
        }
        async initialize() {
            state.script = await this.blob.text();
        }
        getStats() {
            return { poolSize: 1, busyWorkers: 0, queuedTasks: 0 };
        }
        async executeAll(tasks) {
            return tasks.map((task) => {
                const posted = [];
                const sandbox = { self: { postMessage: (message) => posted.push(message) }, console };
                vm.runInNewContext(state.script, sandbox);
                sandbox.self.onmessage({ data: { taskId: 1, data: task } });
                if (posted[0].error) throw new Error(posted[0].error);
                return posted[0].result;
            });
        }
        terminate() {}
    }
    return { default: FakePool, createIdlePoolReaper: () => ({ touch() {}, cancel() {} }) };
});

const { calculateEnhancementPath } = await import('../enhancement/tooltip-enhancement.js');
const { calculateItemValueBatch, terminateItemValueWorkerPool } =
    await import('../../utils/networth-worker-manager.js');

const params = {
    enhancingLevel: 20,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    experienceBonus: 0,
    guzzlingBonus: 1,
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
};

/** A recipe making `out` from ore and one dust; `out` is a partial bill while the dust has no price */
const recipeFor = (out) => ({
    type: '/action_types/crafting',
    outputItems: [{ itemHrid: out, count: 1 }],
    inputItems: [
        { itemHrid: ORE, count: 2 },
        { itemHrid: DUST, count: 1 },
    ],
});

beforeEach(() => {
    globalThis.math = mathjs;
    state.version++;
    state.craftingSetting = false;
    state.actions = {};
    state.books = {
        [`${SWORD}:0`]: { ask: 5000, bid: 4900 },
        [`${ORE}:0`]: { ask: 100, bid: 90 },
    };
});

/** Both threads' reading of the same item at the same level */
async function bothThreads(level, hrid = SWORD) {
    const path = calculateEnhancementPath(hrid, level, params, { priceContext: 'networth' });
    const priceMap = {};
    for (const [key, book] of Object.entries(state.books)) {
        priceMap[`${key}_ask`] = book.ask ?? null;
        priceMap[`${key}_bid`] = book.bid ?? null;
        priceMap[key] = book.ask > 0 ? book.ask : (book.bid ?? 0);
    }
    const partial = new Set();
    const [value] = await calculateItemValueBatch(
        [{ itemHrid: hrid, enhancementLevel: level, count: 1 }],
        priceMap,
        { useHighEnhancementCost: true, minLevel: 1, enhancementParams: params },
        { itemDetailMap: ITEM_DETAIL_MAP, actionDetailMap: state.actions },
        partial
    );
    terminateItemValueWorkerPool();
    return { path, main: path.inputsPartial, worker: partial.has(0), workerValue: value };
}

describe('net worth partial flag follows the inputs the path selected, on both threads', () => {
    test('a crafted base chosen over a market quote with an unpriced recipe input is flagged', async () => {
        state.craftingSetting = true;
        state.actions['/actions/forge'] = recipeFor(SWORD);
        const read = await bothThreads(2);
        expect(read.path.optimalStrategy.baseAskIsCrafted).toBe(true);
        expect(read.main).toBe(true);
        expect(read.worker).toBe(true);
    });

    test('the same crafted base with every recipe input priced is not', async () => {
        state.craftingSetting = true;
        state.actions['/actions/forge'] = recipeFor(SWORD);
        state.books[`${DUST}:0`] = { ask: 50, bid: 45 };
        const read = await bothThreads(2);
        expect(read.path.optimalStrategy.baseAskIsCrafted).toBe(true);
        expect(read.main).toBe(false);
        expect(read.worker).toBe(false);
    });

    test('a crafted protection item that the path spends, with an unpriced recipe input, is flagged', async () => {
        state.actions['/actions/stitch'] = recipeFor(PROT);
        const read = await bothThreads(3);
        expect(read.path.optimalStrategy.protectionCount).toBeGreaterThan(0);
        expect(read.path.optimalStrategy.protectionItemHrid).toBe(PROT);
        expect(read.main).toBe(true);
        expect(read.worker).toBe(true);
    });

    test('the same crafted protection with every recipe input priced is not', async () => {
        state.actions['/actions/stitch'] = recipeFor(PROT);
        state.books[`${DUST}:0`] = { ask: 50, bid: 45 };
        const read = await bothThreads(3);
        expect(read.path.optimalStrategy.protectionItemHrid).toBe(PROT);
        expect(read.main).toBe(false);
        expect(read.worker).toBe(false);
    });

    test('a crafted mirror the plan uses, with an unpriced recipe input, is flagged', async () => {
        state.books[`${PROT}:0`] = { ask: 400_000, bid: 390_000 };
        state.actions['/actions/polish'] = recipeFor(MIRROR);
        const read = await bothThreads(6);
        expect(read.path.optimalStrategy.usedMirror).toBe(true);
        expect(read.main).toBe(true);
        expect(read.worker).toBe(true);
    });

    test('the same crafted mirror with every recipe input priced is not', async () => {
        state.books[`${PROT}:0`] = { ask: 400_000, bid: 390_000 };
        state.actions['/actions/polish'] = recipeFor(MIRROR);
        state.books[`${DUST}:0`] = { ask: 50, bid: 45 };
        const read = await bothThreads(6);
        expect(read.path.optimalStrategy.usedMirror).toBe(true);
        expect(read.main).toBe(false);
        expect(read.worker).toBe(false);
    });

    test('a partial crafted protection the path did NOT select does not flag it', async () => {
        // A priced, cheaper protection exists; the crafted one with the unpriced input is not chosen
        state.books['/items/mirror_of_protection:0'] = { ask: 20, bid: 18 };
        state.actions['/actions/stitch'] = recipeFor(PROT);
        state.books[`${PROT}:0`] = { ask: 900_000, bid: 800_000 };
        const read = await bothThreads(3);
        expect(read.path.optimalStrategy.protectionItemHrid).toBe('/items/mirror_of_protection');
        expect(read.main).toBe(false);
        expect(read.worker).toBe(false);
    });

    describe('a refined piece whose chosen route mirrors copies of the unrefined base', () => {
        beforeEach(() => {
            // The refined piece is bought; protection is dear and the mirror cheap, so the plan mirrors;
            // the copies are the plain sword, crafted when that is cheaper than its 5000 quote
            state.craftingSetting = true;
            state.books[`${REFINED}:0`] = { ask: 90_000, bid: 89_000 };
            state.books[`${PROT}:0`] = { ask: 400_000, bid: 390_000 };
            state.books[`${MIRROR}:0`] = { ask: 100, bid: 90 };
            state.actions['/actions/forge'] = recipeFor(SWORD);
        });

        test('the copy base crafted from an unpriced recipe input flags the item on both threads', async () => {
            const read = await bothThreads(6, REFINED);
            expect(read.path.optimalStrategy.usedMirror).toBe(true);
            expect(read.main).toBe(true);
            expect(read.worker).toBe(true);
        });

        test('both threads total the same refined plan: secondary leaves cost the plain base, not the refined one', async () => {
            state.books[`${DUST}:0`] = { ask: 50, bid: 45 };
            const read = await bothThreads(6, REFINED);
            expect(read.path.optimalStrategy.usedMirror).toBe(true);
            expect(read.path.optimalStrategy.copyItemHrid).toBe(SWORD);
            // The plain copy is far cheaper than the 90,000 refined base, so the saving is large
            expect(read.workerValue).toBeCloseTo(read.path.optimalStrategy.totalCost, 6);
        });

        test('the same copy base with every recipe input priced does not', async () => {
            state.books[`${DUST}:0`] = { ask: 50, bid: 45 };
            const read = await bothThreads(6, REFINED);
            expect(read.path.optimalStrategy.usedMirror).toBe(true);
            expect(read.main).toBe(false);
            expect(read.worker).toBe(false);
        });
    });
});
