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
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: (k, f) => f } }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initClientData,
        getItemDetails: (hrid) => mocks.initClientData?.itemDetailMap?.[hrid] ?? null,
        getSkills: () => [],
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => mocks.drinkSlots,
        characterData: {},
        getAchievementBuffFlatBoost: () => 0,
        getPersonalBuffFlatBoost: () => 0,
    },
}));
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => mocks.drinkConcentration }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0 }));
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
