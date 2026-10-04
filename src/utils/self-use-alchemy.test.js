/**
 * Self-use alchemy valuations — decompose once, the whole decompose chain, and
 * transmuting a held item, all with the outputs kept rather than sold.
 *
 * Item shapes are the game's: `alchemyDetail.decomposeItems` as measured live
 * (umbral_hood → 90 umbral_leather + 1 beast_hood, beast_hood → 60
 * beast_leather + 1 gobo_hood, umbral_leather → 18 tailoring_essence,
 * cheese_sword → 18 cheese, ability books with `decomposeItems: null`).
 * Calculator results carry only the fields `calculateDecomposeProfit` /
 * `calculateTransmuteProfit` return.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameMode: 'standard' }));

vi.mock('../core/data-manager.js', () => ({
    default: { getCurrentCharacterGameMode: () => state.gameMode },
}));
vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => fallback },
}));
vi.mock('./market-data.js', () => ({
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
    getPricingMode: () => 'ask',
}));
vi.mock('../features/settings/custom-price-overrides.js', () => ({ getCustomPrice: () => null }));
vi.mock('./game-lookups.js', () => ({ getShopCoinCost: () => 0 }));
vi.mock('../features/enhancement/tooltip-enhancement.js', () => ({ getProductionCost: () => 0 }));

const {
    bestSelfUseCandidate,
    ownUseUnitCost,
    selfUseDecompose,
    selfUseDecomposeChain,
    selfUseTransmuteHeld,
    untaxedContainerValue,
} = await import('./self-use-alchemy.js');

beforeEach(() => {
    state.gameMode = 'standard';
});

const ITEMS = {
    '/items/umbral_hood': {
        name: 'Umbral Hood',
        equipmentDetail: {},
        alchemyDetail: {
            decomposeItems: [
                { itemHrid: '/items/umbral_leather', count: 90 },
                { itemHrid: '/items/beast_hood', count: 1 },
            ],
        },
    },
    '/items/beast_hood': {
        name: 'Beast Hood',
        equipmentDetail: {},
        alchemyDetail: {
            decomposeItems: [
                { itemHrid: '/items/beast_leather', count: 60 },
                { itemHrid: '/items/gobo_hood', count: 1 },
            ],
        },
    },
    '/items/gobo_hood': {
        name: 'Gobo Hood',
        equipmentDetail: {},
        alchemyDetail: { decomposeItems: [{ itemHrid: '/items/gobo_leather', count: 30 }] },
    },
    // A material that decomposes too — but it is not gear, so a chain stops at it
    '/items/umbral_leather': {
        name: 'Umbral Leather',
        alchemyDetail: { decomposeItems: [{ itemHrid: '/items/tailoring_essence', count: 18 }] },
    },
    '/items/cheese_sword': {
        name: 'Cheese Sword',
        equipmentDetail: {},
        alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 18 }] },
    },
    '/items/revive': {
        name: 'Revive',
        abilityBookDetail: {},
        alchemyDetail: {
            decomposeItems: null,
            transmuteSuccessRate: 1,
            transmuteDropTable: [{ itemHrid: '/items/guardian_aura', dropRate: 1, minCount: 1, maxCount: 1 }],
        },
    },
};

const getItemDetails = (hrid) => ITEMS[hrid] || null;
const isChainable = (hrid) => Boolean(ITEMS[hrid]?.equipmentDetail && ITEMS[hrid]?.alchemyDetail?.decomposeItems);

/**
 * A calculator result with only the fields the helper reads.
 * @returns {Object}
 */
function result({
    itemHrid,
    actionsPerHour = 100,
    successRate = 0.6,
    bulk = 1,
    coin = 0,
    catalystCostPerHour = 0,
    totalTeaCostPerHour = 0,
    bonus = [],
}) {
    const requirementCosts = [{ itemHrid, count: bulk, price: 0 }];
    if (coin > 0) requirementCosts.push({ itemHrid: '/items/coin', count: coin, price: 1, costPerAction: coin });
    return {
        itemHrid,
        actionsPerHour,
        successRate,
        requirementCosts,
        catalystCostPerHour,
        totalTeaCostPerHour,
        dropRevenues: bonus,
    };
}

const BUY = {
    '/items/umbral_leather': 1000,
    '/items/beast_leather': 300,
    '/items/gobo_leather': 50,
    '/items/tailoring_essence': 20,
    '/items/cheese': 10,
    // Gear priced high on purpose: a chain that counted the intermediate pieces would show it
    '/items/beast_hood': 1_000_000,
    '/items/gobo_hood': 500_000,
    '/items/guardian_aura': 1100,
};
const priceOf = (hrid) => (hrid in BUY ? BUY[hrid] : null);

describe('own-use unit cost', () => {
    test('is the cheaper of making and buying', () => {
        expect(ownUseUnitCost({ make: 80_000, buy: 100_000 })).toBe(80_000);
        expect(ownUseUnitCost({ make: 120_000, buy: 100_000 })).toBe(100_000);
    });

    test('takes whichever side is priced, and null when neither is', () => {
        expect(ownUseUnitCost({ make: null, buy: 100 })).toBe(100);
        expect(ownUseUnitCost({ make: 90, buy: null })).toBe(90);
        expect(ownUseUnitCost({})).toBeNull();
    });
});

describe('decompose once, self-use', () => {
    test('values every output untaxed at the buy side, the gear piece included', () => {
        const step = selfUseDecompose(
            result({ itemHrid: '/items/umbral_hood', actionsPerHour: 100, successRate: 0.6 }),
            ITEMS['/items/umbral_hood'],
            { ownUseCost: 2_000_000, priceOf }
        );
        // per attempt: 0.6 × (90 × 1000 + 1 × 1,000,000) = 654,000; cost 2,000,000
        expect(step.netPerAction).toBeCloseTo(654_000 - 2_000_000, 6);
        expect(step.netPerHour).toBeCloseTo((654_000 - 2_000_000) * 100, 4);
        expect(step.partlyUnpriced).toBe(false);
    });

    test('carries the coin, catalyst and tea spend the calculator already worked out', () => {
        const step = selfUseDecompose(
            result({
                itemHrid: '/items/cheese_sword',
                actionsPerHour: 200,
                successRate: 0.5,
                coin: 10,
                catalystCostPerHour: 400,
                totalTeaCostPerHour: 600,
            }),
            ITEMS['/items/cheese_sword'],
            { ownUseCost: 50, priceOf }
        );
        // outputs: 18 × 10 × 0.5 × 200 = 18,000; cost: 50 × 200 + 10 × 200 + 400 + 600 = 13,000
        expect(step.outputValuePerHour).toBeCloseTo(18_000, 6);
        expect(step.costPerHour).toBeCloseTo(13_000, 6);
        expect(step.netPerHour).toBeCloseTo(5_000, 6);
        expect(step.netPerAction).toBeCloseTo(25, 6);
    });

    test('bulk scales input and outputs alike', () => {
        const step = selfUseDecompose(
            result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 1, bulk: 3 }),
            ITEMS['/items/cheese_sword'],
            { ownUseCost: 100, priceOf }
        );
        // 3 swords → 54 cheese per action
        expect(step.netPerAction).toBeCloseTo(3 * 18 * 10 - 3 * 100, 6);
    });

    test('bonus drops use buy-side values, with the resolved keep value for a crate', () => {
        const bonus = [
            { itemHrid: '/items/alchemy_essence', isEssence: true, dropsPerHour: 5, price: 999 },
            { itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 0.1, price: 2000 },
        ];
        const prices = (hrid) => (hrid === '/items/alchemy_essence' ? 400 : priceOf(hrid));
        const step = selfUseDecompose(
            result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 1, bonus }),
            ITEMS['/items/cheese_sword'],
            {
                ownUseCost: 0,
                priceOf: prices,
                containerValue: (hrid) => (hrid === '/items/small_artisans_crate' ? 2000 : null),
            }
        );
        expect(step.outputValuePerHour).toBeCloseTo(18 * 10 * 100 + 5 * 400 + 0.1 * 2000, 6);
    });

    test('a crate with no book is worth its contents untaxed, not the taxed container figure', () => {
        // Contents worth 10,000 at the buy side; the calculator's figure is that less the 4% tax
        const contents = 10_000;
        const bonus = [
            { itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 0.5, price: contents * 0.96 },
        ];
        const containerValue = (hrid) => (hrid === '/items/small_artisans_crate' ? contents : null);
        const step = selfUseDecompose(
            result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 1, bonus }),
            ITEMS['/items/cheese_sword'],
            { ownUseCost: 0, priceOf, containerValue }
        );
        expect(step.outputValuePerHour).toBeCloseTo(18 * 10 * 100 + 0.5 * contents, 6);

        const chain = selfUseDecomposeChain('/items/cheese_sword', {
            getDecompose: (hrid) => result({ itemHrid: hrid, actionsPerHour: 100, successRate: 1, bonus }),
            getItemDetails,
            isChainable,
            priceOf,
            ownUseCost: 0,
            containerValue,
        });
        expect(chain.terminalValue).toBeCloseTo(18 * 10 + (0.5 / 100) * contents, 6);
    });

    test('a direct buy quote takes precedence over opened contents', () => {
        const bonus = [{ itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 1, price: 1 }];
        const directQuote = (hrid) => (hrid === '/items/small_artisans_crate' ? 300 : priceOf(hrid));
        const step = selfUseDecompose(
            result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 1, bonus }),
            ITEMS['/items/cheese_sword'],
            {
                ownUseCost: 0,
                priceOf: directQuote,
                containerValue: () => ({ value: 200, partlyUnpriced: true }),
            }
        );
        expect(step.outputValuePerHour).toBeCloseTo(18 * 10 * 100 + 300, 6);
        expect(step.partlyUnpriced).toBe(false);
    });

    test('a partial crate subtotal remains visible and makes its net a lower bound', () => {
        const bonus = [{ itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 1, price: 1 }];
        const step = selfUseDecompose(
            result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 1, bonus }),
            ITEMS['/items/cheese_sword'],
            {
                ownUseCost: 0,
                priceOf,
                containerValue: () => ({ value: 200, partlyUnpriced: true }),
            }
        );
        expect(step.outputValuePerHour).toBeCloseTo(18 * 10 * 100 + 200, 6);
        expect(step.netPerHour).toBeCloseTo(18 * 10 * 100 + 200, 6);
        expect(step.partlyUnpriced).toBe(true);
    });

    test('a partial bonus container makes the full decompose chain net unstated', () => {
        const bonus = [{ itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 1, price: 1 }];
        const chain = selfUseDecomposeChain('/items/cheese_sword', {
            getDecompose: (hrid) => result({ itemHrid: hrid, actionsPerHour: 100, successRate: 1, bonus }),
            getItemDetails,
            isChainable,
            priceOf,
            ownUseCost: 0,
            containerValue: () => ({ value: 200, partlyUnpriced: true }),
        });
        expect(chain.terminalValue).toBeCloseTo(18 * 10 + 2, 6);
        expect(chain.net).toBeNull();
        expect(chain.partlyUnpriced).toBe(true);
    });

    test('a partial bonus container remains a lower bound for held-item transmute', () => {
        const transmute = result({
            itemHrid: '/items/revive',
            actionsPerHour: 100,
            successRate: 1,
            bonus: [{ itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 1, price: 1 }],
        });
        const held = selfUseTransmuteHeld(transmute, ITEMS['/items/revive'], {
            sellPrice: 0,
            priceOf,
            containerValue: () => ({ value: 200, partlyUnpriced: true }),
        });
        expect(held.outputValuePerHour).toBeCloseTo(1100 * 100 + 200, 6);
        expect(held.partlyUnpriced).toBe(true);
    });

    test('a missing buy quote does not borrow the producer sell-side bonus price', () => {
        // Shape emitted by calculateAlchemyBonusDrops for its non-openable Alchemy Essence
        // output: price is populated from getItemPrice(... side: 'sell').
        const bonus = {
            itemHrid: '/items/alchemy_essence',
            count: 1,
            dropRate: 0.05,
            effectiveDropRate: 0.05,
            price: 500,
            isEssence: true,
            isRare: false,
            revenuePerAttempt: 25,
            revenuePerHour: 2500,
            dropsPerHour: 5,
        };
        const buyPriceOf = (hrid) => (hrid === '/items/cheese' ? 10 : null);
        const step = selfUseDecompose(
            result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 1, bonus: [bonus] }),
            ITEMS['/items/cheese_sword'],
            { ownUseCost: 0, priceOf: buyPriceOf }
        );

        expect(step.outputValuePerHour).toBe(18_000);
        expect(step.unpriced).toEqual(['/items/alchemy_essence']);
        expect(step.partlyUnpriced).toBe(true);
    });

    test('an item with no decompose outputs has no line', () => {
        expect(
            selfUseDecompose(result({ itemHrid: '/items/revive' }), ITEMS['/items/revive'], {
                ownUseCost: 1000,
                priceOf,
            })
        ).toBeNull();
    });

    test('an unpriced output is named rather than riding in as free', () => {
        const step = selfUseDecompose(result({ itemHrid: '/items/cheese_sword' }), ITEMS['/items/cheese_sword'], {
            ownUseCost: 10,
            priceOf: () => null,
        });
        expect(step.partlyUnpriced).toBe(true);
        expect(step.unpriced).toEqual(['/items/cheese']);
    });

    test('the valuation is untaxed for a market character and an Iron Cow alike', () => {
        const run = () =>
            selfUseDecompose(
                result({ itemHrid: '/items/cheese_sword', actionsPerHour: 1, successRate: 1 }),
                ITEMS['/items/cheese_sword'],
                { ownUseCost: 0, priceOf }
            ).netPerAction;
        const standard = run();
        state.gameMode = 'ironcow';
        expect(run()).toBe(standard);
        expect(standard).toBe(18 * 10);
    });
});

describe('full decompose chain, self-use', () => {
    const rates = {
        '/items/umbral_hood': { actionsPerHour: 100, successRate: 0.6, coin: 50 },
        '/items/beast_hood': { actionsPerHour: 120, successRate: 0.5, coin: 20 },
        '/items/gobo_hood': { actionsPerHour: 150, successRate: 0.8, coin: 0 },
    };
    const getDecompose = (hrid) => (rates[hrid] ? result({ itemHrid: hrid, ...rates[hrid] }) : null);

    test('values only the terminal materials and lists the gear collected', () => {
        const chain = selfUseDecomposeChain('/items/umbral_hood', {
            getDecompose,
            getItemDetails,
            isChainable,
            priceOf,
            ownUseCost: 2_000_000,
        });
        const reachBeast = 0.6;
        const reachGobo = 0.6 * 0.5;
        const terminal =
            0.6 * 90 * 1000 + // umbral leather — a decomposable material, kept as is
            reachBeast * 0.5 * 60 * 300 +
            reachGobo * 0.8 * 30 * 50;
        expect(chain.terminalValue).toBeCloseTo(terminal, 6);
        expect(chain.collected).toEqual([
            { itemHrid: '/items/beast_hood', expected: reachBeast },
            { itemHrid: '/items/gobo_hood', expected: reachGobo },
        ]);
        // Overhead: each step's coin per item, weighted by the reach
        const overhead = 50 + reachBeast * 20;
        expect(chain.overheadCost).toBeCloseTo(overhead, 6);
        expect(chain.net).toBeCloseTo(terminal - 2_000_000 - overhead, 6);
        expect(chain.partlyUnpriced).toBe(false);
        expect(chain.truncated).toBe(false);
    });

    test('total time is each step at its own rate, weighted by how often the chain gets there', () => {
        const chain = selfUseDecomposeChain('/items/umbral_hood', {
            getDecompose,
            getItemDetails,
            isChainable,
            priceOf,
            ownUseCost: 1,
        });
        const seconds = 3600 / 100 + (0.6 * 3600) / 120 + (0.3 * 3600) / 150;
        expect(chain.seconds).toBeCloseTo(seconds, 6);
        expect(chain.netPerHour).toBeCloseTo((chain.net * 3600) / seconds, 6);
        expect(chain.steps.map((s) => s.itemHrid)).toEqual([
            '/items/umbral_hood',
            '/items/beast_hood',
            '/items/gobo_hood',
        ]);
    });

    test('a chain whose outputs are only materials collects no gear', () => {
        const chain = selfUseDecomposeChain('/items/cheese_sword', {
            getDecompose: (hrid) => result({ itemHrid: hrid, successRate: 0.6 }),
            getItemDetails,
            isChainable,
            priceOf,
            ownUseCost: 50,
        });
        expect(chain.collected).toEqual([]);
        expect(chain.terminalValue).toBeCloseTo(0.6 * 18 * 10, 6);
    });

    test('an item that cannot be decomposed has no chain', () => {
        expect(
            selfUseDecomposeChain('/items/revive', {
                getDecompose: (hrid) => result({ itemHrid: hrid }),
                getItemDetails,
                isChainable,
                priceOf,
                ownUseCost: 1000,
            })
        ).toBeNull();
    });

    test('an unpriced material leaves the net unstated and says what is known', () => {
        const chain = selfUseDecomposeChain('/items/umbral_hood', {
            getDecompose,
            getItemDetails,
            isChainable,
            priceOf: (hrid) => (hrid === '/items/gobo_leather' ? null : priceOf(hrid)),
            ownUseCost: 2_000_000,
        });
        expect(chain.partlyUnpriced).toBe(true);
        expect(chain.unpriced).toEqual(['/items/gobo_leather']);
        expect(chain.net).toBeNull();
        expect(chain.netPerHour).toBeNull();
        expect(chain.terminalValue).toBeCloseTo(0.6 * 90 * 1000 + 0.6 * 0.5 * 60 * 300, 6);
        expect(chain.collected.map((c) => c.itemHrid)).toEqual(['/items/beast_hood', '/items/gobo_hood']);
    });

    test('a step the calculator cannot price stops there, still collected, marked partly unpriced', () => {
        const chain = selfUseDecomposeChain('/items/umbral_hood', {
            getDecompose: (hrid) => (hrid === '/items/gobo_hood' ? null : getDecompose(hrid)),
            getItemDetails,
            isChainable,
            priceOf,
            ownUseCost: 2_000_000,
        });
        expect(chain.partlyUnpriced).toBe(true);
        expect(chain.unpriced).toEqual(['/items/gobo_hood']);
        expect(chain.net).toBeNull();
        expect(chain.collected.map((c) => c.itemHrid)).toContain('/items/gobo_hood');
        // The gobo step's time is not counted, since it was never worked out
        expect(chain.seconds).toBeCloseTo(3600 / 100 + (0.6 * 3600) / 120, 6);
    });

    test('a cycle in the data is cut off instead of recursing forever', () => {
        const loop = {
            '/items/a': {
                equipmentDetail: {},
                alchemyDetail: { decomposeItems: [{ itemHrid: '/items/b', count: 1 }] },
            },
            '/items/b': {
                equipmentDetail: {},
                alchemyDetail: { decomposeItems: [{ itemHrid: '/items/a', count: 1 }] },
            },
        };
        const chain = selfUseDecomposeChain('/items/a', {
            getDecompose: (hrid) => result({ itemHrid: hrid, successRate: 1 }),
            getItemDetails: (hrid) => loop[hrid],
            isChainable: (hrid) => hrid in loop,
            priceOf: () => 7,
            ownUseCost: 1,
        });
        expect(chain.truncated).toBe(true);
        expect(chain.steps).toHaveLength(2);
        expect(Number.isFinite(chain.terminalValue)).toBe(true);
    });

    test('the depth cap stops a long line', () => {
        const line = {};
        for (let i = 0; i < 30; i++) {
            line[`/items/g${i}`] = {
                equipmentDetail: {},
                alchemyDetail: { decomposeItems: [{ itemHrid: `/items/g${i + 1}`, count: 1 }] },
            };
        }
        const chain = selfUseDecomposeChain('/items/g0', {
            getDecompose: (hrid) => result({ itemHrid: hrid, successRate: 1 }),
            getItemDetails: (hrid) => line[hrid],
            isChainable: (hrid) => hrid in line,
            priceOf: () => 1,
            ownUseCost: 1,
            maxDepth: 5,
        });
        expect(chain.truncated).toBe(true);
        expect(chain.steps).toHaveLength(6);
    });
});

describe('transmute a held item, self-use', () => {
    const revive = () =>
        result({ itemHrid: '/items/revive', actionsPerHour: 1, successRate: 1, coin: 0, bulk: 1, bonus: [] });

    test('a Revive at 1,090 sells for 1,046.4; keeping a 1,100 Guardian Aura is worth more', () => {
        const held = selfUseTransmuteHeld(revive(), ITEMS['/items/revive'], { sellPrice: 1090, priceOf });
        expect(held.inputValue).toBeCloseTo(1046.4, 6);
        expect(held.outputValuePerHour).toBeCloseTo(1100, 6);
        expect(held.netPerAction).toBeCloseTo(1100 - 1046.4, 6);
        expect(held.netPerAction).toBeGreaterThan(0);
    });

    test('an Iron Cow sells untaxed, so the same trade is the plain difference', () => {
        state.gameMode = 'ironcow';
        const held = selfUseTransmuteHeld(revive(), ITEMS['/items/revive'], { sellPrice: 1090, priceOf });
        expect(held.inputValue).toBe(1090);
        expect(held.netPerAction).toBeCloseTo(10, 6);
    });

    test('a self-return gives the held item back at the same value as the input', () => {
        const details = {
            alchemyDetail: {
                transmuteDropTable: [
                    { itemHrid: '/items/revive', dropRate: 0.5, minCount: 1, maxCount: 1 },
                    { itemHrid: '/items/guardian_aura', dropRate: 0.5, minCount: 1, maxCount: 1 },
                ],
            },
        };
        const held = selfUseTransmuteHeld(revive(), details, { sellPrice: 1000, priceOf });
        // 0.5 × 960 back + 0.5 × 1100 − 960
        expect(held.netPerAction).toBeCloseTo(0.5 * 960 + 0.5 * 1100 - 960, 6);
    });

    test('success rate, coin, catalyst and tea come off as the calculator charged them', () => {
        const held = selfUseTransmuteHeld(
            result({
                itemHrid: '/items/revive',
                actionsPerHour: 10,
                successRate: 0.5,
                coin: 5,
                catalystCostPerHour: 30,
                totalTeaCostPerHour: 70,
            }),
            ITEMS['/items/revive'],
            { sellPrice: 1000, priceOf }
        );
        // outputs: 1100 × 0.5 × 10 = 5,500; cost: 960 × 10 + 5 × 10 + 30 + 70 = 9,750
        expect(held.netPerHour).toBeCloseTo(5500 - 9750, 6);
    });

    test('no sell price means no line — the opportunity cost is the whole question', () => {
        expect(selfUseTransmuteHeld(revive(), ITEMS['/items/revive'], { sellPrice: null, priceOf })).toBeNull();
    });
});

describe('picking the catalyst for self-use', () => {
    // Cheese Sword: 18 cheese at 10 (buy side). The seller values cheese at a taxed bid of
    // ~6, where a prime catalyst at 2,000/hr does not pay; at the buy side it does.
    const plain = result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 0.6 });
    const prime = result({
        itemHrid: '/items/cheese_sword',
        actionsPerHour: 100,
        successRate: 0.75,
        catalystCostPerHour: 2000,
    });
    const evaluate = (r) => selfUseDecompose(r, ITEMS['/items/cheese_sword'], { ownUseCost: 50, priceOf });

    test('takes the candidate that is best on the self-use objective, not the seller pick', () => {
        // Seller, cheese at a taxed 6: plain 18 × 6 × 0.6 × 100 = 6,480; prime 8,100 − 2,000 = 6,100
        // Self-use, cheese at 10:      plain 10,800;                    prime 13,500 − 2,000 = 11,500
        const best = bestSelfUseCandidate([plain, prime], evaluate, 'netPerHour');
        expect(best.result).toBe(prime);
        expect(best.evaluation.netPerHour).toBeCloseTo(13_500 - 2000 - 5000, 6);
    });

    test('does not rank a partial lower bound against complete candidate values', () => {
        const partial = { id: 'partial' };
        const complete = { id: 'complete' };
        const best = bestSelfUseCandidate(
            [partial, complete],
            (candidate) =>
                candidate.id === 'partial'
                    ? { netPerHour: 10000, partlyUnpriced: true }
                    : { netPerHour: 5000, partlyUnpriced: false },
            'netPerHour'
        );
        expect(best.result).toBe(complete);
        expect(best.optimized).toBe(true);
    });

    test('a partial crate lower bound cannot win catalyst selection over a complete game-shaped result', () => {
        const partial = result({
            itemHrid: '/items/cheese_sword',
            actionsPerHour: 100,
            successRate: 1,
            bonus: [{ itemHrid: '/items/small_artisans_crate', isRare: true, dropsPerHour: 1, price: 1 }],
        });
        const complete = result({ itemHrid: '/items/cheese_sword', actionsPerHour: 100, successRate: 0.9 });
        const evaluate = (candidate) =>
            selfUseDecompose(candidate, ITEMS['/items/cheese_sword'], {
                ownUseCost: 0,
                priceOf,
                containerValue: (hrid) =>
                    hrid === '/items/small_artisans_crate' ? { value: 10000, partlyUnpriced: true } : null,
            });

        const best = bestSelfUseCandidate([partial, complete], evaluate, 'netPerHour');
        expect(best.result).toBe(complete);
        expect(best.evaluation.partlyUnpriced).toBe(false);
    });

    test('keeps the first candidate as an unoptimized display fallback when every candidate is partial', () => {
        const partial = { id: 'partial' };
        const best = bestSelfUseCandidate([partial], () => ({ netPerHour: 10000, partlyUnpriced: true }), 'netPerHour');
        expect(best.result).toBe(partial);
        expect(best.optimized).toBe(false);
    });

    test('keeps the cheaper setup when the catalyst does not pay for self-use either', () => {
        const dear = { ...prime, catalystCostPerHour: 5000 };
        expect(bestSelfUseCandidate([dear, plain], evaluate, 'netPerHour').result).toBe(plain);
    });

    test('skips candidates that cannot be valued, and is null when none can', () => {
        expect(bestSelfUseCandidate([null, plain], evaluate, 'netPerHour').result).toBe(plain);
        expect(bestSelfUseCandidate([plain], () => null, 'netPerHour')).toBeNull();
        expect(bestSelfUseCandidate([], evaluate, 'netPerHour')).toBeNull();
    });
});

describe('a container opened for keeps', () => {
    const tables = {
        '/items/small_artisans_crate': [
            { itemHrid: '/items/cheese', dropRate: 1, minCount: 10, maxCount: 30 },
            { itemHrid: '/items/beast_leather', dropRate: 0.5, minCount: 2, maxCount: 2 },
            { itemHrid: '/items/inner_box', dropRate: 0.25, minCount: 1, maxCount: 1 },
        ],
        '/items/inner_box': [{ itemHrid: '/items/gobo_leather', dropRate: 1, minCount: 4, maxCount: 4 }],
        '/items/loop_a': [{ itemHrid: '/items/loop_b', dropRate: 1, minCount: 1, maxCount: 1 }],
        '/items/loop_b': [
            { itemHrid: '/items/loop_a', dropRate: 1, minCount: 1, maxCount: 1 },
            { itemHrid: '/items/cheese', dropRate: 1, minCount: 1, maxCount: 1 },
        ],
    };
    const containerDrops = (hrid) => tables[hrid] || null;

    test('is the untaxed buy-side sum of its contents, a nested container opened too', () => {
        // 20 cheese × 10 + 0.5 × 2 × 300 + 0.25 × (4 × 50)
        expect(untaxedContainerValue('/items/small_artisans_crate', { containerDrops, priceOf })).toEqual({
            value: 200 + 300 + 50,
            partlyUnpriced: false,
        });
    });

    test('is the same for an Iron Cow — nothing is sold', () => {
        state.gameMode = 'ironcow';
        expect(untaxedContainerValue('/items/small_artisans_crate', { containerDrops, priceOf })).toEqual({
            value: 550,
            partlyUnpriced: false,
        });
    });

    test('retains a known lower bound and marks unpriced contents, including nested drops', () => {
        const onlyCheese = (hrid) => (hrid === '/items/cheese' ? 10 : null);
        expect(untaxedContainerValue('/items/small_artisans_crate', { containerDrops, priceOf: onlyCheese })).toEqual({
            value: 200,
            partlyUnpriced: true,
        });
        expect(untaxedContainerValue('/items/small_artisans_crate', { containerDrops, priceOf: () => null })).toEqual({
            value: null,
            partlyUnpriced: true,
        });
        expect(untaxedContainerValue('/items/cheese', { containerDrops, priceOf })).toBeNull();
    });

    test('a container that holds itself does not recurse forever', () => {
        expect(untaxedContainerValue('/items/loop_a', { containerDrops, priceOf })).toEqual({
            value: 10,
            partlyUnpriced: true,
        });
    });
});
