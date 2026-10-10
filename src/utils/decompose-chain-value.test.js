/**
 * The decompose chain's setup choice: every step's catalyst/tea setup is chosen to
 * maximize the whole chain's gold per hour, (Σ net) / (Σ seconds), not each step's
 * own figure.
 *
 * Item shapes are the game's (`alchemyDetail.decomposeItems`, gear decomposing to
 * lower gear plus materials); calculator results carry only the fields the chain
 * reads. The brute-force checks enumerate every combination of setups and value
 * each with the same chain walk the module reports with.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const engine = vi.hoisted(() => ({
    itemDetails: {},
    bids: {},
    estimated: new Set(),
    candidates: {},
    calculatorCalls: 0,
    /** crate hrid -> openableLootDropMap table */
    crates: {},
    /** hrid -> what the sell-side resolver answers ({value, needsTax}); absent = null */
    sellResolved: {},
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ openableLootDropMap: engine.crates }),
        getItemDetails: (hrid) => engine.itemDetails[hrid] ?? null,
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => fallback, getSetting: () => null },
}));
vi.mock('../features/market/alchemy-profit-calculator.js', () => ({
    default: {
        calculateCandidateResults: (action, hrid) => {
            engine.calculatorCalls += 1;
            return engine.candidates[hrid] ?? [];
        },
        calculateDecomposeProfit: (hrid) => engine.candidates[hrid]?.[0] ?? null,
    },
}));
vi.mock('../features/market/expected-value-calculator.js', () => ({
    default: { resolveSellSideValue: (hrid) => engine.sellResolved[hrid] ?? null },
}));
vi.mock('./profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * 0.96 }));
vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid) => engine.bids[hrid] ?? null,
    getItemPriceInfo: (hrid) => ({ price: engine.bids[hrid] ?? null, estimated: engine.estimated.has(hrid) }),
    isPriceEstimated: (hrid) => engine.estimated.has(hrid),
    getPricingMode: () => 'conservative',
    withProfitPricingMode: (mode, fn) => fn(),
}));
vi.mock('../features/settings/custom-price-overrides.js', () => ({ getCustomPrice: () => null }));
vi.mock('./game-lookups.js', () => ({ getShopCoinOnlyCost: () => 0, getShopCoinCost: () => 0 }));
vi.mock('../features/enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const { decomposeChain, clearDecomposeChainCaches, maximizeChainRatio, MAX_RATIO_ITERATIONS } =
    await import('./decompose-chain-value.js');
const { selfUseDecomposeChain } = await import('./self-use-alchemy.js');

/**
 * A decompose calculator answer carrying only what the chain reads.
 * @param {number} ask - The input's ask
 * @param {number} actionsPerHour
 * @param {Object} [extra] - successRate, catalystCostPerHour, dropRevenues, ...
 * @returns {Object}
 */
function setup(ask, actionsPerHour, extra = {}) {
    return {
        actionsPerHour,
        successRate: 1,
        requirementCosts: [{ itemHrid: '/items/x', count: 1, price: ask }],
        dropRevenues: [],
        ...extra,
    };
}

/**
 * @param {Array<Array>} outputs - [itemHrid, count] pairs
 * @returns {Object} Gear details
 */
function gear(outputs) {
    return {
        equipmentDetail: {},
        alchemyDetail: { decomposeItems: outputs.map(([itemHrid, count]) => ({ itemHrid, count })) },
    };
}

/** The chain walk with an explicit setup per gear, priced the way the module prices */
function chainWith(itemHrid, choice, ask) {
    return selfUseDecomposeChain(itemHrid, {
        getDecompose: (h) => choice[h] ?? null,
        getItemDetails: (h) => engine.itemDetails[h] ?? null,
        isChainable: (h) => Boolean(engine.itemDetails[h]?.equipmentDetail),
        priceOf: (h) => (engine.bids[h] === undefined ? null : engine.bids[h] * 0.96),
        ownUseCost: ask,
    });
}

/** The best chain per hour over every combination of setups */
function bruteForce(itemHrid, ask) {
    const gearHrids = Object.keys(engine.candidates);
    let best = -Infinity;
    const recurse = (i, choice) => {
        if (i === gearHrids.length) {
            const value = chainWith(itemHrid, choice, ask)?.netPerHour;
            if (Number.isFinite(value)) best = Math.max(best, value);
            return;
        }
        for (const candidate of engine.candidates[gearHrids[i]]) {
            recurse(i + 1, { ...choice, [gearHrids[i]]: candidate });
        }
    };
    recurse(0, {});
    return best;
}

beforeEach(() => {
    engine.itemDetails = {};
    engine.bids = {};
    engine.estimated = new Set();
    engine.candidates = {};
    engine.calculatorCalls = 0;
    engine.crates = {};
    engine.sellResolved = {};
    clearDecomposeChainCaches();
});

describe('the chain picks setups jointly', () => {
    /**
     * item_a (100 s a unit, ask 1000) -> 1 mid_b -> 2 term_c at a 1000 bid.
     * mid_b runs slow and free (1920 net over 10 s) or fast with a catalyst
     * (1820 net over 1 s). On its own the fast setup is far better per hour, but
     * the chain above it already takes 100 s and earns little, so the extra 100
     * gold beats the 9 s it costs: 920 / 110 s beats 820 / 101 s.
     */
    function slowChildWins() {
        engine.itemDetails = {
            '/items/item_a': gear([['/items/mid_b', 1]]),
            '/items/mid_b': gear([['/items/term_c', 2]]),
            '/items/term_c': { alchemyDetail: null },
        };
        engine.bids = { '/items/term_c': 1000 };
        const slow = setup(300, 360);
        const fast = setup(300, 3600, { catalystCostPerHour: 360_000, winningCatalystHrid: '/items/catalyst' });
        engine.candidates = { '/items/item_a': [setup(1000, 36)], '/items/mid_b': [fast, slow] };
        return { fast };
    }

    test('a child setup that is best on its own but worse in the chain is not taken', () => {
        const { fast } = slowChildWins();
        const greedy = chainWith(
            '/items/item_a',
            { '/items/item_a': engine.candidates['/items/item_a'][0], '/items/mid_b': fast },
            1000
        ).netPerHour;
        expect(greedy).toBeCloseTo((820 * 3600) / 101);

        const chain = decomposeChain('/items/item_a');
        expect(chain.netPerHour).toBeCloseTo((920 * 3600) / 110);
        expect(chain.netPerHour).toBeGreaterThan(greedy);
        expect(chain.netPerHour).toBeCloseTo(bruteForce('/items/item_a', 1000));
        expect(chain.seconds).toBeCloseTo(110);
        expect(chain.steps.map((s) => s.itemHrid)).toEqual(['/items/item_a', '/items/mid_b']);
        expect(chain.topStep).toBe(engine.candidates['/items/item_a'][0]);
    });

    test('the top step setup is chosen on the whole chain too, and reported as topStep', () => {
        slowChildWins();
        // A second top setup: twice as fast, 30 gold of tea a unit
        const quickTop = setup(1000, 72, { totalTeaCostPerHour: 72 * 30 });
        engine.candidates['/items/item_a'] = [setup(1000, 36), quickTop];

        const chain = decomposeChain('/items/item_a');
        expect(chain.topStep).toBe(quickTop);
        expect(chain.netPerHour).toBeCloseTo(bruteForce('/items/item_a', 1000));
    });

    test('a child shared by two items takes the setup each item is best with', () => {
        slowChildWins();
        // item_g is fast and cheap above the same mid_b: there the fast child wins
        engine.itemDetails['/items/item_g'] = gear([['/items/mid_b', 1]]);
        engine.candidates['/items/item_g'] = [setup(100, 3600)];

        const a = decomposeChain('/items/item_a');
        const g = decomposeChain('/items/item_g');
        expect(a.netPerHour).toBeCloseTo((920 * 3600) / 110);
        expect(g.netPerHour).toBeCloseTo(((1820 - 100) * 3600) / 2);
        expect(g.netPerHour).toBeCloseTo(bruteForce('/items/item_g', 100));
        // Candidate lists are still asked once per gear across both items
        expect(engine.calculatorCalls).toBe(3);
    });

    test('a success rate above a step weighs the step below it', () => {
        // The top setups differ in success rate, which scales how much of mid_b arrives
        engine.itemDetails = {
            '/items/item_a': gear([
                ['/items/mid_b', 2],
                ['/items/mat_m', 5],
            ]),
            '/items/mid_b': gear([
                ['/items/low_c', 1],
                ['/items/mat_n', 3],
            ]),
            '/items/low_c': gear([['/items/mat_m', 4]]),
            '/items/mat_m': { alchemyDetail: null },
            '/items/mat_n': { alchemyDetail: null },
        };
        engine.bids = { '/items/mat_m': 40, '/items/mat_n': 90, '/items/essence': 300 };
        engine.candidates = {
            '/items/item_a': [
                setup(900, 60, { successRate: 0.6 }),
                setup(900, 40, { successRate: 0.95, catalystCostPerHour: 40 * 60 }),
            ],
            '/items/mid_b': [
                setup(0, 400, { successRate: 0.7 }),
                setup(0, 900, {
                    successRate: 0.9,
                    totalTeaCostPerHour: 900 * 25,
                    // The alchemy-wide essence rolls on every action, per hour
                    dropRevenues: [{ itemHrid: '/items/essence', isEssence: true, dropsPerHour: 90 }],
                }),
                setup(0, 150, { successRate: 1 }),
            ],
            '/items/low_c': [setup(0, 2000, { successRate: 0.8 }), setup(0, 300, { successRate: 1 })],
        };

        const chain = decomposeChain('/items/item_a');
        expect(chain.netPerHour).toBeCloseTo(bruteForce('/items/item_a', 900), 6);
    });

    test('random trees: the pick matches brute force and never falls below any setup combination', () => {
        let seed = 12345;
        const rand = () => {
            seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
            return seed / 2_147_483_648;
        };
        for (let trial = 0; trial < 40; trial++) {
            clearDecomposeChainCaches();
            engine.itemDetails = {
                '/items/t0': gear([
                    ['/items/t1', 1],
                    ['/items/m0', 1 + Math.floor(rand() * 20)],
                ]),
                '/items/t1': gear([
                    ['/items/t2', 1],
                    ['/items/m1', 1 + Math.floor(rand() * 20)],
                ]),
                '/items/t2': gear([['/items/m2', 1 + Math.floor(rand() * 20)]]),
                '/items/m0': { alchemyDetail: null },
                '/items/m1': { alchemyDetail: null },
                '/items/m2': { alchemyDetail: null },
            };
            engine.bids = { '/items/m0': rand() * 200, '/items/m1': rand() * 200, '/items/m2': rand() * 200 };
            const ask = 200 + rand() * 3000;
            engine.candidates = {};
            for (const hrid of ['/items/t0', '/items/t1', '/items/t2']) {
                engine.candidates[hrid] = Array.from({ length: 2 + Math.floor(rand() * 4) }, () => {
                    const actionsPerHour = 50 + rand() * 3000;
                    return setup(ask, actionsPerHour, {
                        successRate: 0.4 + rand() * 0.6,
                        catalystCostPerHour: rand() < 0.5 ? 0 : actionsPerHour * rand() * 100,
                    });
                });
            }
            const chain = decomposeChain('/items/t0');
            expect(chain.netPerHour).toBeCloseTo(bruteForce('/items/t0', ask), 4);
        }
    });
});

describe('fixtures where each step was already best stay as they were', () => {
    test('a two-level chain with one setup a step', () => {
        engine.itemDetails = {
            '/items/item_a': gear([['/items/mid_b', 1]]),
            '/items/mid_b': gear([['/items/term_c', 2]]),
            '/items/term_c': { alchemyDetail: null },
        };
        engine.bids = { '/items/term_c': 1000 };
        engine.candidates = { '/items/item_a': [setup(500, 3600)], '/items/mid_b': [setup(300, 1800)] };
        expect(decomposeChain('/items/item_a').netPerHour).toBeCloseTo(1_704_000);
    });

    test('the catalyst child that the greedy pick also took', () => {
        engine.itemDetails = {
            '/items/item_a': gear([['/items/mid_b', 1]]),
            '/items/mid_b': gear([['/items/term_c', 2]]),
            '/items/term_c': { alchemyDetail: null },
        };
        engine.bids = { '/items/term_c': 1000 };
        engine.candidates = {
            '/items/item_a': [setup(500, 3600)],
            '/items/mid_b': [
                setup(300, 1800, { successRate: 0.5 }),
                setup(300, 1800, { successRate: 1, catalystCostPerHour: 180_000 }),
            ],
        };
        expect(decomposeChain('/items/item_a').netPerHour).toBeCloseTo(1_584_000);
    });

    test('an unpriced terminal still leaves the chain without a figure, with its top step', () => {
        engine.itemDetails = {
            '/items/item_a': gear([['/items/mid_b', 1]]),
            '/items/mid_b': gear([['/items/term_c', 2]]),
            '/items/term_c': { alchemyDetail: null },
        };
        engine.candidates = { '/items/item_a': [setup(500, 3600)], '/items/mid_b': [setup(300, 1800)] };
        const chain = decomposeChain('/items/item_a');
        expect(chain.netPerHour).toBeNull();
        expect(chain.partlyUnpriced).toBe(true);
        expect(chain.topStep).toBe(engine.candidates['/items/item_a'][0]);
    });

    test('a cycle in the gear still walks the way it did', () => {
        engine.itemDetails = {
            '/items/item_a': gear([
                ['/items/mid_b', 1],
                ['/items/term_c', 1],
            ]),
            '/items/mid_b': gear([
                ['/items/item_a', 1],
                ['/items/term_c', 1],
            ]),
            '/items/term_c': { alchemyDetail: null },
        };
        engine.bids = { '/items/term_c': 1000, '/items/item_a': 500 };
        engine.candidates = { '/items/item_a': [setup(500, 3600)], '/items/mid_b': [setup(300, 1800)] };
        const chain = decomposeChain('/items/item_a');
        expect(chain.truncated).toBe(true);
        // 960 + 960 + the looped-back item_a at 480, less the 500 ask, over 1 s + 2 s
        expect(chain.netPerHour).toBeCloseTo(((960 * 2 + 480 - 500) * 3600) / 3);
    });
});

describe('maximizeChainRatio', () => {
    test('converges within the cap on a long Pareto front', () => {
        // One step with 200 setups on a concave net-vs-time front: the hardest shape
        // for the iteration, every λ lands on a different setup
        const options = Array.from({ length: 200 }, (_, i) => {
            const seconds = 1 + i;
            return { result: { i }, net: 1000 * Math.sqrt(seconds), seconds, children: [] };
        });
        const solved = maximizeChainRatio('/items/r', { termsOf: () => options, rootCost: 900 });
        expect(solved.iterations).toBeLessThanOrEqual(MAX_RATIO_ITERATIONS);
        expect(solved.converged).toBe(true);
        const best = Math.max(...options.map((o) => (o.net - 900) / o.seconds));
        expect(solved.ratio).toBeCloseTo(best, 9);
    });

    test('reaches the optimum in a handful of iterations on a three-level tree', () => {
        const terms = {
            '/items/a': [
                { result: 'a1', net: 0, seconds: 50, children: [{ hrid: '/items/b', multiplier: 1 }] },
                { result: 'a2', net: 0, seconds: 10, children: [{ hrid: '/items/b', multiplier: 0.7 }] },
            ],
            '/items/b': [
                { result: 'b1', net: 500, seconds: 20, children: [{ hrid: '/items/c', multiplier: 2 }] },
                { result: 'b2', net: 450, seconds: 2, children: [{ hrid: '/items/c', multiplier: 2 }] },
            ],
            '/items/c': [
                { result: 'c1', net: 300, seconds: 30, children: [] },
                { result: 'c2', net: 200, seconds: 1, children: [] },
            ],
        };
        const solved = maximizeChainRatio('/items/a', { termsOf: (h) => terms[h], rootCost: 400 });
        expect(solved.converged).toBe(true);
        expect(solved.iterations).toBeLessThanOrEqual(6);
        let best = -Infinity;
        for (const a of terms['/items/a'])
            for (const b of terms['/items/b'])
                for (const c of terms['/items/c']) {
                    const m = a.children[0].multiplier;
                    const net = a.net + m * (b.net + 2 * c.net) - 400;
                    const seconds = a.seconds + m * (b.seconds + 2 * c.seconds);
                    best = Math.max(best, net / seconds);
                }
        expect(solved.ratio).toBeCloseTo(best, 9);
    });

    test('a step with no priced setup leaves the chain unsolved', () => {
        const terms = {
            '/items/a': [{ result: 'a', net: 0, seconds: 1, children: [{ hrid: '/items/b', multiplier: 1 }] }],
            '/items/b': [],
        };
        expect(maximizeChainRatio('/items/a', { termsOf: (h) => terms[h], rootCost: 0 })).toBeNull();
    });
});

describe('a bonus crate', () => {
    const CRATE = '/items/artisans_crate';
    /** item_a -> 2x term_c, plus a rare crate rolling on 1% of actions (36/hr at 3600 actions) */
    function crateFixture({ junkPriced }) {
        engine.itemDetails = {
            '/items/item_a': gear([['/items/term_c', 2]]),
            '/items/term_c': { alchemyDetail: null },
        };
        engine.bids = { '/items/term_c': 1000 };
        const drops = (dropsPerHour) => [{ itemHrid: CRATE, isRare: true, dropsPerHour }];
        engine.candidates = { '/items/item_a': [setup(500, 3600, { dropRevenues: drops(36) })] };
        engine.crates = {
            [CRATE]: [
                { itemHrid: '/items/coin', dropRate: 1, minCount: 100, maxCount: 100 },
                { itemHrid: '/items/gem', dropRate: 0.5, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/junk', dropRate: 0.5, minCount: 1, maxCount: 1 },
            ],
        };
        engine.sellResolved = {
            '/items/coin': { value: 1, needsTax: false },
            '/items/gem': { value: 400, needsTax: true },
            ...(junkPriced ? { '/items/junk': { value: 100, needsTax: true } } : {}),
        };
    }

    test('prices its contents like the tooltip and counts a partly priced crate as a lower bound', () => {
        crateFixture({ junkPriced: false });
        const chain = decomposeChain('/items/item_a');
        // Coin at face value (100) + gem sold after tax (0.5 x 384); junk has no bid
        const perAction = 0.01 * (100 + 0.5 * 384);
        expect(chain.netPerHour).toBeCloseTo((1920 - 500 + perAction) * 3600);
        expect(chain.partial).toBe(true);
        expect(chain.partialItems).toEqual([CRATE]);
        expect(chain.unpriced).toEqual([]);

        clearDecomposeChainCaches();
        crateFixture({ junkPriced: true });
        const full = decomposeChain('/items/item_a');
        expect(full.partial).toBe(false);
        expect(full.netPerHour).toBeGreaterThan(chain.netPerHour);
    });

    test('a crate with nothing priced still leaves the chain without a figure', () => {
        crateFixture({ junkPriced: false });
        engine.sellResolved = {};
        const chain = decomposeChain('/items/item_a');
        expect(chain.netPerHour).toBeNull();
        expect(chain.unpriced).toContain(CRATE);
    });
});
