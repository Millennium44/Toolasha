/**
 * "Instead of buying" — the alchemy route to an item that beats its ask.
 * The arithmetic is driven through `findAlchemyAlternatives` with plain price
 * tables; the calculator results are cut to the fields the valuation reads.
 */
import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => 0 } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => null, getItemDetails: () => null },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { lastFetchTimestamp: 1 } }));
vi.mock('./alchemy-profit-calculator.js', () => ({ default: {} }));
vi.mock('./expected-value-calculator.js', () => ({ default: {} }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: () => ({ price: null, source: null, estimated: false }),
    withProfitPricingMode: (_mode, fn) => fn(),
}));
// A flat 10% tax keeps the arithmetic readable
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * 0.9,
    calculateActionsPerHour: () => 0,
    calculateTeaCostsPerHour: () => ({ totalCostPerHour: 0 }),
}));

import { buildSourceIndex, findAlchemyAlternatives } from './alchemy-instead-of-buying.js';

const ESSENCE = '/items/goblin_essence';
const SHOOTER = '/items/gobo_shooter';
const BOOMSTICK = '/items/gobo_boomstick';
const LEATHER = '/items/gobo_leather';

const itemDetails = {
    // 10 essence and 2 leather per decompose
    [SHOOTER]: {
        name: 'Gobo Shooter',
        alchemyDetail: {
            decomposeItems: [
                { itemHrid: ESSENCE, count: 10 },
                { itemHrid: LEATHER, count: 2 },
            ],
        },
    },
    // 10 essence and nothing else
    [BOOMSTICK]: { name: 'Gobo Boomstick', alchemyDetail: { decomposeItems: [{ itemHrid: ESSENCE, count: 10 }] } },
    [ESSENCE]: { name: 'Goblin Essence' },
    [LEATHER]: { name: 'Gobo Leather' },
};

/** A decompose result: 100 actions/hr, 50% success, 100 coin per action, no catalyst or tea */
const decompose = (itemHrid, extra = {}) => ({
    actionType: 'decompose',
    itemHrid,
    actionsPerHour: 100,
    successRate: 0.5,
    requirementCosts: [
        { itemHrid, count: 1, price: 0 },
        { itemHrid: '/items/coin', count: 100, costPerAction: 100 },
    ],
    catalystCostPerHour: 0,
    totalTeaCostPerHour: 0,
    dropRevenues: [],
    ...extra,
});

/**
 * The deps around a price table: `{hrid: {ask, bid, estimated?}}`.
 * @param {Object} prices
 * @param {Object} [extra]
 */
const depsFor = (prices, extra = {}) => ({
    sources: [
        { sourceHrid: SHOOTER, actionType: 'decompose' },
        { sourceHrid: BOOMSTICK, actionType: 'decompose' },
    ],
    getItemDetails: (hrid) => itemDetails[hrid] ?? null,
    askOf: (hrid) => (prices[hrid] && !prices[hrid].estimated ? (prices[hrid].ask ?? null) : null),
    sellOf: (hrid) => (prices[hrid]?.bid != null && !prices[hrid].estimated ? prices[hrid].bid * 0.9 : null),
    candidatesOf: (_type, hrid) => [decompose(hrid)],
    ...extra,
});

describe('the source index', () => {
    test('maps each output to the items that decompose or transmute into it, self-returns aside', () => {
        const index = buildSourceIndex({
            ...itemDetails,
            '/items/frenzy': {
                alchemyDetail: {
                    transmuteDropTable: [
                        { itemHrid: '/items/frenzy', dropRate: 0.5, minCount: 1, maxCount: 1 },
                        { itemHrid: ESSENCE, dropRate: 0.5, minCount: 1, maxCount: 1 },
                    ],
                },
            },
        });
        expect(index.get(ESSENCE)).toEqual([
            { sourceHrid: SHOOTER, actionType: 'decompose' },
            { sourceHrid: BOOMSTICK, actionType: 'decompose' },
            { sourceHrid: '/items/frenzy', actionType: 'transmute' },
        ]);
        expect(index.get('/items/frenzy')).toBeUndefined();
    });
});

describe('findAlchemyAlternatives', () => {
    test('of two decompose sources, the cheaper per essence comes first', () => {
        // Shooter: (1000 + 100) / 5 essence = 220 each; Boomstick: (600 + 100) / 5 = 140 each
        const { targetAsk, alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor({ [ESSENCE]: { ask: 300 }, [SHOOTER]: { ask: 1000 }, [BOOMSTICK]: { ask: 600 } })
        );
        expect(targetAsk).toBe(300);
        expect(alternatives.map((a) => a.sourceHrid)).toEqual([BOOMSTICK, SHOOTER]);
        expect(alternatives[0].costPerUnit).toBeCloseTo(140);
        expect(alternatives[0].saving).toBeCloseTo(160);
        // 100 actions/hr × 5 essence = 500 essence/hr, so 160 × 500 = 80,000/hr
        expect(alternatives[0].savingPerHour).toBeCloseTo(80000);
        expect(alternatives[0].secondsPerUnit).toBeCloseTo(7.2);
    });

    test('other outputs are credited at their bid after tax', () => {
        // Shooter: 1 leather per action at 200 × 0.9 = 180; (1000 + 100 − 180) / 5 = 184
        const { alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor({ [ESSENCE]: { ask: 300 }, [SHOOTER]: { ask: 1000 }, [LEATHER]: { ask: 250, bid: 200 } })
        );
        expect(alternatives).toHaveLength(1);
        expect(alternatives[0].sourceHrid).toBe(SHOOTER);
        expect(alternatives[0].costPerUnit).toBeCloseTo(184);
        expect(alternatives[0].kept).toEqual([]);
    });

    test('an other output on the keep list is credited at its ask', () => {
        // Leather kept: 1 × 250; (1000 + 100 − 250) / 5 = 170
        const { alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor(
                { [ESSENCE]: { ask: 300 }, [SHOOTER]: { ask: 1000 }, [LEATHER]: { ask: 250, bid: 200 } },
                { isWanted: (hrid) => hrid === LEATHER }
            )
        );
        expect(alternatives[0].costPerUnit).toBeCloseTo(170);
        expect(alternatives[0].kept).toEqual([LEATHER]);
    });

    test('a source whose price is an estimate is left out', () => {
        const { alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor({ [ESSENCE]: { ask: 300 }, [SHOOTER]: { ask: 1000 }, [BOOMSTICK]: { ask: 10, estimated: true } })
        );
        expect(alternatives.map((a) => a.sourceHrid)).toEqual([SHOOTER]);
    });

    test('an estimated target ask leaves nothing to compare against', () => {
        const { targetAsk, alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor({ [ESSENCE]: { ask: 300, estimated: true }, [BOOMSTICK]: { ask: 600 } })
        );
        expect(targetAsk).toBeNull();
        expect(alternatives).toEqual([]);
    });

    test('a gold rate makes a marginal saving disappear', () => {
        const prices = { [ESSENCE]: { ask: 150 }, [BOOMSTICK]: { ask: 600 } };
        // 140 per essence against an ask of 150: 10 saved, 5,000/hr of alchemy
        const free = findAlchemyAlternatives(ESSENCE, depsFor(prices));
        expect(free.alternatives).toHaveLength(1);
        expect(free.alternatives[0].savingPerHour).toBeCloseTo(5000);
        // At 10,000/hr, 7.2 s per essence costs 20 — more than the 10 saved
        const timed = findAlchemyAlternatives(ESSENCE, depsFor(prices, { goldPerHour: 10000 }));
        expect(timed.alternatives).toEqual([]);
        // At 2,000/hr it costs 4: 6 saved, 3,000/hr over the rate
        const cheap = findAlchemyAlternatives(ESSENCE, depsFor(prices, { goldPerHour: 2000 }));
        expect(cheap.alternatives[0].timeCostPerUnit).toBeCloseTo(4);
        expect(cheap.alternatives[0].saving).toBeCloseTo(6);
        expect(cheap.alternatives[0].savingPerHour).toBeCloseTo(3000);
    });

    test('nothing when buying is cheapest', () => {
        const { alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor({ [ESSENCE]: { ask: 100 }, [SHOOTER]: { ask: 1000 }, [BOOMSTICK]: { ask: 600 } })
        );
        expect(alternatives).toEqual([]);
    });

    test('the setup is chosen on cost per unit, a dearer catalyst winning when its success pays', () => {
        // A catalyst lifting success to 0.75 for 3,000/hr: (600 + 100 + 30) / 7.5 = 97.3 < 140
        const { alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor(
                { [ESSENCE]: { ask: 300 }, [BOOMSTICK]: { ask: 600 } },
                {
                    candidatesOf: (_type, hrid) => [
                        decompose(hrid),
                        decompose(hrid, { successRate: 0.75, catalystCostPerHour: 3000 }),
                    ],
                }
            )
        );
        expect(alternatives[0].costPerUnit).toBeCloseTo(730 / 7.5);
        expect(alternatives[0].result.successRate).toBe(0.75);
    });

    test('a transmute self-return is credited at what the source cost', () => {
        const FRENZY = '/items/frenzy';
        const details = {
            [FRENZY]: {
                alchemyDetail: {
                    transmuteDropTable: [
                        { itemHrid: FRENZY, dropRate: 0.5, minCount: 1, maxCount: 1 },
                        { itemHrid: ESSENCE, dropRate: 0.5, minCount: 2, maxCount: 2 },
                    ],
                },
            },
        };
        // Per action at 100% success: 1 essence, half a Frenzy back (worth 500 of its 1,000)
        const { alternatives } = findAlchemyAlternatives(
            ESSENCE,
            depsFor(
                { [ESSENCE]: { ask: 900 }, [FRENZY]: { ask: 1000 } },
                {
                    sources: [{ sourceHrid: FRENZY, actionType: 'transmute' }],
                    getItemDetails: (hrid) => details[hrid] ?? null,
                    candidatesOf: (_type, hrid) => [{ ...decompose(hrid), actionType: 'transmute', successRate: 1 }],
                }
            )
        );
        // (1000 + 100 − 500) / 1 = 600
        expect(alternatives[0].costPerUnit).toBeCloseTo(600);
    });
});
