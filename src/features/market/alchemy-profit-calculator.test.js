/**
 * Alchemy Profit Calculator — success-rate math and the catalyst/tea combo
 * search. calculateCoinifyProfit/Decompose/Transmute pull in a large web of
 * game-data lookups (action stats, equipment speed, drop tables); the
 * dense, self-contained logic worth pinning here is the success-rate formula
 * and the six-combination search that picks the best catalyst+tea setup.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    alchemyTeaBonus: 0,
    /** Game data returned by dataManager.getInitClientData() */
    initClientData: null,
    /** Active drink slots for /action_types/alchemy */
    drinkSlots: [],
    drinkConcentration: 0,
    /** Equipment speed bonus (decimal) reported by the equipment parser */
    equipmentSpeed: 0,
    /** What calculateActionStats() hands back — tea speed is NOT part of it */
    actionStats: {},
    /** Character skills, so a test can under-level the alchemist */
    skills: [],
    /** Default price for getItemPrice() lookups */
    itemPrice: 0,
    /** Per-hrid price overrides, so a test can make catalysts cheap and drops valuable */
    itemPrices: {},
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: (k, f) => f } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initClientData,
        getItemDetails: (hrid) => mocks.initClientData?.itemDetailMap?.[hrid] ?? null,
        getSkills: () => mocks.skills,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => mocks.drinkSlots,
        characterData: {},
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => mocks.drinkConcentration }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: (hrid) => mocks.itemPrices[hrid] ?? mocks.itemPrice }));
vi.mock('../../utils/buff-parser.js', () => ({ getAlchemySuccessBonus: () => mocks.alchemyTeaBonus }));
vi.mock('../../utils/equipment-parser.js', () => ({
    parseEquipmentSpeedBonuses: () => mocks.equipmentSpeed,
    debugEquipmentSpeedBonuses: () => [],
    parseEssenceFindBonus: () => 0,
    parseRareFindBonus: () => 0,
}));
vi.mock('../../utils/action-calculator.js', () => ({ calculateActionStats: () => mocks.actionStats }));
vi.mock('../../utils/house-efficiency.js', () => ({ calculateHouseRareFind: () => 0 }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null, on: () => () => {} } }));
vi.mock('./expected-value-calculator.js', () => ({ default: { getCachedValue: () => null, isInitialized: false } }));

const { default: alchemyProfitCalculator, parseTeaSpeedDetails } = await import('./alchemy-profit-calculator.js');

beforeEach(() => {
    mocks.alchemyTeaBonus = 0;
    mocks.initClientData = null;
    mocks.drinkSlots = [];
    mocks.drinkConcentration = 0;
    mocks.equipmentSpeed = 0;
    mocks.actionStats = {};
    mocks.skills = [];
    mocks.itemPrice = 0;
    mocks.itemPrices = {};
});

describe('calculateSuccessRateBreakdown', () => {
    test('with no modifiers, the total is just the base rate', () => {
        const breakdown = alchemyProfitCalculator.calculateSuccessRateBreakdown(0.7);
        expect(breakdown).toEqual({ total: 0.7, base: 0.7, tea: 0, catalyst: 0, levelPenalty: 0 });
    });

    test('catalyst, tea and level penalty combine additively inside the multiplier', () => {
        // base × (1 + catalyst + levelPenalty + tea)
        const breakdown = alchemyProfitCalculator.calculateSuccessRateBreakdown(0.6, 0.15, 0.05, -0.1);
        expect(breakdown.total).toBeCloseTo(0.6 * (1 + 0.15 - 0.1 + 0.05), 10);
    });

    test('is capped at 100%, never overshoots', () => {
        const breakdown = alchemyProfitCalculator.calculateSuccessRateBreakdown(0.7, 0.25, 0.5);
        expect(breakdown.total).toBe(1);
    });

    test('is floored at 0%, never goes negative', () => {
        const breakdown = alchemyProfitCalculator.calculateSuccessRateBreakdown(0.5, 0, 0, -5);
        expect(breakdown.total).toBe(0);
    });

    test('reads live tea bonus when no override is given', () => {
        mocks.alchemyTeaBonus = 0.1;
        const breakdown = alchemyProfitCalculator.calculateSuccessRateBreakdown(0.5);
        expect(breakdown.tea).toBe(0.1);
        expect(breakdown.total).toBeCloseTo(0.55, 10);
    });
});

describe('_bestCatalystCombo', () => {
    // netProfit is highest with a catalyst that costs nothing extra in this
    // fixture (catalystPrice comes from getItemPrice, mocked to 0), so the
    // combo with the highest success rate should always win.
    function baseParams(overrides = {}) {
        return {
            actionType: 'coinify',
            baseSuccessRate: 0.5,
            actionsPerHour: 100,
            efficiencyDecimal: 0,
            actionTime: 10,
            alchemyBonusRevenue: 0,
            computeNetProfit: (successRate) => successRate * 1000, // pure success-rate-driven profit
            computeTeaCost: () => 0,
            ...overrides,
        };
    }

    test('with catalysts free and tea free, the prime catalyst (highest bonus) wins', () => {
        const best = alchemyProfitCalculator._bestCatalystCombo(baseParams());
        expect(best.catalystBonus).toBeCloseTo(0.25, 10); // prime catalyst bonus
        expect(best.successRate).toBeCloseTo(0.5 * 1.25, 10);
    });

    test('a nonzero tea cost can make the no-tea combo win despite a lower success rate', () => {
        const best = alchemyProfitCalculator._bestCatalystCombo(
            baseParams({
                computeTeaCost: (teaBonus) => (teaBonus > 0 ? 1_000_000 : 0),
            })
        );
        expect(best.teaBonus).toBe(0);
    });

    test('picks among exactly six combinations and returns the best profitPerHour', () => {
        const best = alchemyProfitCalculator._bestCatalystCombo(baseParams());
        // Recompute the best of all 6 manually and confirm they agree
        const combos = [
            { catalyst: 0, tea: 0 },
            { catalyst: 0.15, tea: 0 },
            { catalyst: 0.25, tea: 0 },
        ];
        const maxRate = Math.max(...combos.map((c) => 0.5 * (1 + c.catalyst)));
        expect(best.successRate).toBeCloseTo(maxRate, 10);
    });

    test('respects a level penalty passed through to every combination', () => {
        const withPenalty = alchemyProfitCalculator._bestCatalystCombo(baseParams({ levelPenalty: -0.2 }));
        const withoutPenalty = alchemyProfitCalculator._bestCatalystCombo(baseParams());
        expect(withPenalty.successRate).toBeLessThan(withoutPenalty.successRate);
    });
});

describe('parseTeaSpeedDetails', () => {
    const itemDetailMap = {
        '/items/alchemy_tea': {
            name: 'Alchemy Tea',
            consumableDetail: {
                buffs: [
                    { typeHrid: '/buff_types/action_speed', flatBoost: 0.06 },
                    { typeHrid: '/buff_types/alchemy_success', ratioBoost: 0.05 },
                ],
            },
        },
        '/items/catalytic_tea': {
            name: 'Catalytic Tea',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/alchemy_success', ratioBoost: 0.05 }] },
        },
        '/items/coin': { name: 'Coin' },
    };

    test('reads the action_speed flatBoost off each equipped tea', () => {
        const details = parseTeaSpeedDetails([{ itemHrid: '/items/alchemy_tea' }], itemDetailMap);
        expect(details).toEqual([{ name: 'Alchemy Tea', speedBonus: 0.06 }]);
    });

    test('scales with drink concentration like every other tea bonus', () => {
        // 6% base × (1 + 50% concentration) = 9%
        const details = parseTeaSpeedDetails([{ itemHrid: '/items/alchemy_tea' }], itemDetailMap, 0.5);
        expect(details[0].speedBonus).toBeCloseTo(0.09, 10);
    });

    test('teas without a speed buff, empty slots and non-consumables are skipped', () => {
        const details = parseTeaSpeedDetails(
            [{ itemHrid: '/items/catalytic_tea' }, null, {}, { itemHrid: '/items/coin' }, { itemHrid: '/items/nope' }],
            itemDetailMap
        );
        expect(details).toEqual([]);
    });

    test('returns nothing when there are no drinks or no game data', () => {
        expect(parseTeaSpeedDetails([], itemDetailMap)).toEqual([]);
        expect(parseTeaSpeedDetails(null, itemDetailMap)).toEqual([]);
        expect(parseTeaSpeedDetails([{ itemHrid: '/items/alchemy_tea' }], null)).toEqual([]);
    });
});

describe('tea speed is applied on every alchemy path', () => {
    // 20 s base action, 25% equipment speed → calculateActionStats hands back 16 s.
    // Alchemy Tea adds 6% × 1.5 concentration = 9%, and speed sources stack
    // additively → 20 / (1.25 + 0.09) = 14.925... s.
    const BASE_TIME_SECONDS = 20;
    const EQUIPMENT_ONLY_TIME = 16;
    const TEA_SPEED = 0.09;
    const WITH_TEA_TIME = BASE_TIME_SECONDS / (1.25 + TEA_SPEED);

    const ITEM_DETAIL_MAP = {
        '/items/alchemy_tea': {
            name: 'Alchemy Tea',
            consumableDetail: { buffs: [{ typeHrid: '/buff_types/action_speed', flatBoost: 0.06 }] },
        },
        '/items/cheese': {
            name: 'Cheese',
            itemLevel: 10,
            sellPrice: 100,
            alchemyDetail: { isCoinifiable: true, bulkMultiplier: 1 },
        },
        '/items/cheese_hat': {
            name: 'Cheese Hat',
            itemLevel: 10,
            sellPrice: 500,
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 2 }] },
        },
        '/items/milk': {
            name: 'Milk',
            itemLevel: 10,
            sellPrice: 20,
            alchemyDetail: {
                transmuteSuccessRate: 0.5,
                transmuteDropTable: [{ itemHrid: '/items/cheese', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        },
    };

    const alchemyAction = { type: '/action_types/alchemy', baseTimeCost: BASE_TIME_SECONDS * 1e9 };

    /** Each path: the public method, and the item it can actually run on. */
    const paths = [
        ['coinify', (calc) => calc.calculateCoinifyProfit('/items/cheese')],
        ['decompose', (calc) => calc.calculateDecomposeProfit('/items/cheese_hat')],
        ['transmute', (calc) => calc.calculateTransmuteProfit('/items/milk')],
    ];

    beforeEach(() => {
        mocks.initClientData = {
            itemDetailMap: ITEM_DETAIL_MAP,
            actionDetailMap: {
                '/actions/alchemy/coinify': alchemyAction,
                '/actions/alchemy/decompose': alchemyAction,
                '/actions/alchemy/transmute': alchemyAction,
            },
        };
        mocks.equipmentSpeed = 0.25;
        mocks.drinkConcentration = 0.5;
        mocks.actionStats = {
            actionTime: EQUIPMENT_ONLY_TIME,
            totalEfficiency: 0,
            efficiencyBreakdown: {},
        };
    });

    test.each(paths)('%s: a speed tea shortens the action and shows up in the breakdown', (_name, run) => {
        mocks.drinkSlots = [{ itemHrid: '/items/alchemy_tea' }];

        const result = run(alchemyProfitCalculator);

        expect(result).not.toBeNull();
        expect(result.actionSpeedBreakdown.tea).toBeCloseTo(TEA_SPEED, 10);
        expect(result.actionSpeedBreakdown.equipment).toBeCloseTo(0.25, 10);
        expect(result.actionSpeedBreakdown.total).toBeCloseTo(0.34, 10);
        expect(result.actionSpeedBreakdown.teaDetails).toEqual([{ name: 'Alchemy Tea', speedBonus: TEA_SPEED }]);
        expect(result.actionTime).toBeCloseTo(WITH_TEA_TIME, 10);
        // actions/hr is derived from the shortened time
        expect(result.actionsPerHour).toBeCloseTo(3600 / WITH_TEA_TIME, 8);
    });

    test.each(paths)('%s: with no speed tea the action time is left exactly as calculated', (_name, run) => {
        mocks.drinkSlots = [];

        const result = run(alchemyProfitCalculator);

        expect(result).not.toBeNull();
        expect(result.actionSpeedBreakdown.tea).toBe(0);
        expect(result.actionSpeedBreakdown.teaDetails).toEqual([]);
        expect(result.actionTime).toBe(EQUIPMENT_ONLY_TIME);
    });

    test('the action time never drops below the game minimum', () => {
        mocks.drinkSlots = [{ itemHrid: '/items/alchemy_tea' }];
        mocks.actionStats = { actionTime: 3, totalEfficiency: 0, efficiencyBreakdown: {} };

        const result = alchemyProfitCalculator.calculateCoinifyProfit('/items/cheese');

        expect(result.actionTime).toBe(3);
    });
});

describe('official alchemy rules', () => {
    // A level-50 item, so a level-1 alchemist is 49 levels under it.
    const ITEM_DETAIL_MAP = {
        '/items/cheese': {
            name: 'Cheese',
            itemLevel: 50,
            sellPrice: 100,
            alchemyDetail: { isCoinifiable: true, bulkMultiplier: 3 },
        },
        '/items/cheese_hat': {
            name: 'Cheese Hat',
            itemLevel: 50,
            sellPrice: 500,
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 2 }] },
        },
        '/items/milk': {
            name: 'Milk',
            itemLevel: 50,
            sellPrice: 20,
            alchemyDetail: {
                transmuteSuccessRate: 0.5,
                transmuteDropTable: [{ itemHrid: '/items/cheese', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        },
        '/items/enhancing_essence': { name: 'Enhancing Essence' },
    };

    const alchemyAction = { type: '/action_types/alchemy', baseTimeCost: 20e9 };

    const paths = [
        ['coinify', (calc, enh = 0) => calc.calculateCoinifyProfit('/items/cheese', enh)],
        ['decompose', (calc, enh = 0) => calc.calculateDecomposeProfit('/items/cheese_hat', enh)],
        ['transmute', (calc) => calc.calculateTransmuteProfit('/items/milk')],
    ];

    beforeEach(() => {
        mocks.initClientData = {
            itemDetailMap: ITEM_DETAIL_MAP,
            actionDetailMap: {
                '/actions/alchemy/coinify': alchemyAction,
                '/actions/alchemy/decompose': alchemyAction,
                '/actions/alchemy/transmute': alchemyAction,
            },
        };
        mocks.actionStats = { actionTime: 20, totalEfficiency: 0, efficiencyBreakdown: {} };
        mocks.skills = [{ skillHrid: '/skills/alchemy', level: 50 }];
    });

    test('base success rates are 70% coinify, 60% decompose, per-item transmute', () => {
        expect(alchemyProfitCalculator.calculateCoinifyProfit('/items/cheese').successRateBreakdown.base).toBe(0.7);
        expect(alchemyProfitCalculator.calculateDecomposeProfit('/items/cheese_hat').successRateBreakdown.base).toBe(
            0.6
        );
        // Transmute reads the rate off the item, not a constant
        expect(alchemyProfitCalculator.calculateTransmuteProfit('/items/milk').successRateBreakdown.base).toBe(0.5);
    });

    test('coinify pays 5× the item sell price, at bulk scale, and is charged no coin fee', () => {
        const result = alchemyProfitCalculator.calculateCoinifyProfit('/items/cheese');
        const coins = result.dropRevenues.find((d) => d.itemHrid === '/items/coin');
        // sellPrice 100 × bulkMultiplier 3 × 5
        expect(coins.count).toBe(1500);
        // Coinify is free: the only per-attempt cost is the item itself (priced 0 here)
        expect(result.requirementCosts.some((c) => c.itemHrid === '/items/coin')).toBe(false);
        expect(result.costPerAttempt).toBe(0);
    });

    test.each(paths)('%s: being under the item level cuts the success rate', (_name, run) => {
        const atLevel = run(alchemyProfitCalculator);
        mocks.skills = [{ skillHrid: '/skills/alchemy', level: 1 }];
        const underLevelled = run(alchemyProfitCalculator);

        expect(atLevel.successRateBreakdown.levelPenalty).toBe(0);
        // perLevel = 0.9 / 50, 49 levels short
        expect(underLevelled.successRateBreakdown.levelPenalty).toBeCloseTo((0.9 / 50) * -49, 10);
        expect(underLevelled.successRate).toBeLessThan(atLevel.successRate);
    });

    test.each(paths)('%s: a catalyst is paid for only on success, not per attempt', (_name, run) => {
        // Drops worth having, catalysts cheap enough that the combo search takes one
        mocks.itemPrice = 10_000;
        mocks.itemPrices = {
            '/items/catalyst_of_coinification': 100,
            '/items/catalyst_of_decomposition': 100,
            '/items/catalyst_of_transmutation': 100,
            '/items/prime_catalyst': 100,
            // Inputs free, outputs valuable, so a catalyst is always worth buying
            '/items/cheese_hat': 0,
            '/items/milk': 0,
        };

        const result = run(alchemyProfitCalculator);

        expect(result.catalystCost.itemHrid).toBeTruthy();
        expect(result.successRate).toBeLessThan(1);
        // Charging per attempt would be the full 100; consumed on success it is price × rate
        expect(result.catalystCost.costPerAttempt).toBeCloseTo(100 * result.successRate, 8);
        expect(result.catalystCost.costPerSuccess).toBe(100);
    });

    test('decompose enhancing-essence yield doubles with each enhancement level', () => {
        const essence = (level) =>
            alchemyProfitCalculator
                .calculateDecomposeProfit('/items/cheese_hat', level)
                .dropRevenues.find((d) => d.itemHrid === '/items/enhancing_essence').count;

        // round(2 × (0.5 + 0.1 × 1.05^itemLevel) × 2^enhancementLevel)
        const perLevel = 2 * (0.5 + 0.1 * Math.pow(1.05, 50));
        for (const level of [1, 2, 3, 10]) {
            expect(essence(level)).toBe(Math.round(perLevel * Math.pow(2, level)));
        }
        // The doubling itself, read off two levels large enough that rounding no longer bites
        expect(essence(11) / essence(10)).toBeCloseTo(2, 3);
    });

    test('decompose consumes and yields at bulk scale (e.g. Holy Milk, 2 per action)', () => {
        const bulkItem = (bulkMultiplier) => ({
            name: 'Holy Milk',
            itemLevel: 50,
            sellPrice: 40,
            alchemyDetail: { decomposeItems: [{ itemHrid: '/items/cheese', count: 2 }], bulkMultiplier },
        });
        const run = (bulkMultiplier) => {
            mocks.initClientData = {
                ...mocks.initClientData,
                itemDetailMap: { ...ITEM_DETAIL_MAP, '/items/holy_milk': bulkItem(bulkMultiplier) },
            };
            return alchemyProfitCalculator.calculateDecomposeProfit('/items/holy_milk');
        };
        mocks.itemPrices = { '/items/holy_milk': 100, '/items/cheese': 50 };

        const single = run(1);
        const bulk = run(2);

        // Input: two copies consumed per action, each at the per-item price
        const singleInput = single.requirementCosts.find((c) => c.itemHrid === '/items/holy_milk');
        const bulkInput = bulk.requirementCosts.find((c) => c.itemHrid === '/items/holy_milk');
        expect(singleInput).toMatchObject({ count: 1, price: 100, costPerAction: 100 });
        expect(bulkInput).toMatchObject({ count: 2, price: 100, costPerAction: 200 });
        // Per-attempt cost grows by the extra copy (100) plus the coin fee's own
        // bulk scaling ((10 + itemLevel 50) × 5 = 300, already bulk-aware in alchemy-fees)
        expect(bulk.costPerAttempt - single.costPerAttempt).toBeCloseTo(400, 8);
        const singleFee = single.requirementCosts.find((c) => c.itemHrid === '/items/coin');
        const bulkFee = bulk.requirementCosts.find((c) => c.itemHrid === '/items/coin');
        expect(bulkFee.costPerAction).toBe(2 * singleFee.costPerAction);

        // Output: base decompose items double with it
        const singleDrop = single.dropRevenues.find((d) => d.itemHrid === '/items/cheese');
        const bulkDrop = bulk.dropRevenues.find((d) => d.itemHrid === '/items/cheese');
        expect(singleDrop.count).toBe(2);
        expect(bulkDrop.count).toBe(4);
        expect(bulkDrop.revenuePerAttempt).toBeCloseTo(2 * singleDrop.revenuePerAttempt, 8);
    });

    test('an unenhanced decompose yields no enhancing essence at all', () => {
        const result = alchemyProfitCalculator.calculateDecomposeProfit('/items/cheese_hat', 0);
        expect(result.dropRevenues.find((d) => d.itemHrid === '/items/enhancing_essence')).toBeUndefined();
    });

    describe('an output the market cannot price', () => {
        // Left out of the revenue entirely, which understates the profit rather
        // than overstating it — but the reader has to be told, or a partial total
        // reads as a complete one.
        beforeEach(() => {
            mocks.itemPrice = null;
        });

        test('decompose names it instead of quoting the shortfall in silence', () => {
            mocks.itemPrices = { '/items/cheese_hat': 100 };
            const result = alchemyProfitCalculator.calculateDecomposeProfit('/items/cheese_hat', 0);

            expect(result.unpricedOutputs).toEqual(['/items/cheese']);
            expect(result.dropRevenues.find((d) => d.itemHrid === '/items/cheese')).toBeUndefined();
        });

        test('decompose counts the enhancing essence it could not price', () => {
            mocks.itemPrices = { '/items/cheese_hat': 100, '/items/cheese': 50 };
            const result = alchemyProfitCalculator.calculateDecomposeProfit('/items/cheese_hat', 2);

            expect(result.unpricedOutputs).toEqual(['/items/enhancing_essence']);
        });

        test('transmute names its unpriced drop', () => {
            mocks.itemPrices = { '/items/milk': 10 };
            const result = alchemyProfitCalculator.calculateTransmuteProfit('/items/milk');

            expect(result.unpricedOutputs).toEqual(['/items/cheese']);
        });

        test('a fully priced run reports nothing missing', () => {
            mocks.itemPrices = { '/items/cheese_hat': 100, '/items/cheese': 50 };
            expect(alchemyProfitCalculator.calculateDecomposeProfit('/items/cheese_hat', 0).unpricedOutputs).toEqual(
                []
            );
        });
    });
});

describe('_forcedCatalystCombo', () => {
    function baseParams(overrides = {}) {
        return {
            actionType: 'transmute',
            baseSuccessRate: 0.5,
            actionsPerHour: 100,
            efficiencyDecimal: 0,
            actionTime: 20,
            alchemyBonusRevenue: 0,
            computeNetProfit: (successRate) => 1000 * successRate,
            computeTeaCost: () => 0,
            teaBonusOverride: 0,
            ...overrides,
        };
    }

    test('"none" applies no catalyst bonus or cost regardless of price data', () => {
        mocks.itemPrices['/items/catalyst_of_transmutation'] = 5000;
        mocks.itemPrices['/items/prime_catalyst'] = 50000;

        const combo = alchemyProfitCalculator._forcedCatalystCombo(baseParams({ catalystChoice: 'none' }));

        expect(combo.catalystHrid).toBeNull();
        expect(combo.catalystBonus).toBe(0);
        expect(combo.catalystPrice).toBe(0);
        expect(combo.successRateBreakdown.total).toBe(0.5); // unmodified base rate
    });

    test('"typeSpecific" forces the type-specific catalyst for the given actionType', () => {
        mocks.itemPrices['/items/catalyst_of_transmutation'] = 5000;

        const combo = alchemyProfitCalculator._forcedCatalystCombo(baseParams({ catalystChoice: 'typeSpecific' }));

        expect(combo.catalystHrid).toBe('/items/catalyst_of_transmutation');
        expect(combo.catalystBonus).toBe(0.15);
        expect(combo.catalystPrice).toBe(5000);
        expect(combo.successRateBreakdown.total).toBeCloseTo(0.5 * 1.15, 10);
    });

    test('"prime" forces the prime catalyst regardless of actionType', () => {
        mocks.itemPrices['/items/prime_catalyst'] = 50000;

        const combo = alchemyProfitCalculator._forcedCatalystCombo(baseParams({ catalystChoice: 'prime' }));

        expect(combo.catalystHrid).toBe('/items/prime_catalyst');
        expect(combo.catalystBonus).toBe(0.25);
        expect(combo.catalystPrice).toBe(50000);
        expect(combo.successRateBreakdown.total).toBeCloseTo(0.5 * 1.25, 10);
    });

    test('catalyst cost is charged per attempt scaled by the resulting success rate', () => {
        mocks.itemPrices['/items/prime_catalyst'] = 1000;

        const combo = alchemyProfitCalculator._forcedCatalystCombo(baseParams({ catalystChoice: 'prime' }));

        // successRate = 0.5 × 1.25 = 0.625; catalystCostPerAttempt = price × successRate
        expect(combo.catalystCostPerAttempt).toBeCloseTo(1000 * 0.625, 10);
    });

    test('does not choose a catalyst just because it is not the most profitable one', () => {
        // A forced "none" choice must be honored even when a catalyst would clearly be more
        // profitable — this method never searches for the best option, unlike _bestCatalystCombo.
        mocks.itemPrices['/items/prime_catalyst'] = 1; // trivially cheap, would win any search

        const combo = alchemyProfitCalculator._forcedCatalystCombo(
            baseParams({ catalystChoice: 'none', computeNetProfit: () => 1_000_000 })
        );

        expect(combo.catalystHrid).toBeNull();
    });
});
