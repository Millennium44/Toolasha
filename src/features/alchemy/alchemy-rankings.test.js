/**
 * What alchemy pays, ranked.
 *
 * The profit calculator is *not* mocked here, which is the point of the file.
 * A ranking that made up its own arithmetic would be a second opinion about
 * what alchemy earns, and the planner ranking that second opinion against
 * gathering would be ranking two different things. So the fixtures are prices
 * and game data, the real `alchemy-profit-calculator.js` runs, and the expected
 * figures below are hand-computed from the formulas that calculator documents —
 * with the coin fee taken from `utils/alchemy-fees.js` rather than restated, so
 * a change to the fee shows up as a changed rate rather than as a test that
 * agrees with an old copy of it.
 *
 * Catalysts are priced absurdly high in every fixture, so the calculator's
 * six-way catalyst/tea search settles on "no catalyst, no tea" and the success
 * rate is the base rate. That keeps the expected profit a line of arithmetic
 * rather than a search result.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initClientData: null,
    skills: [],
    drinkSlots: [],
    /** Default price for every getItemPrice lookup */
    itemPrice: 0,
    /** Per-hrid overrides */
    itemPrices: {},
    actionStats: { actionTime: 20, totalEfficiency: 0, efficiencyBreakdown: {} },
    experienceMultiplier: 1,
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));
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
vi.mock('../../utils/tea-parser.js', () => ({ getDrinkConcentration: () => 0 }));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => mocks.itemPrices[hrid] ?? mocks.itemPrice,
}));
vi.mock('../../utils/buff-parser.js', () => ({ getAlchemySuccessBonus: () => 0 }));
vi.mock('../../utils/equipment-parser.js', () => ({
    parseEquipmentSpeedBonuses: () => 0,
    debugEquipmentSpeedBonuses: () => [],
    parseEssenceFindBonus: () => 0,
    parseRareFindBonus: () => 0,
}));
vi.mock('../../utils/action-calculator.js', () => ({ calculateActionStats: () => mocks.actionStats }));
vi.mock('../../utils/house-efficiency.js', () => ({ calculateHouseRareFind: () => 0 }));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null, on: () => () => {} } }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: { getCachedValue: () => null, calculateSingleContainer: () => 0, isInitialized: false },
}));
vi.mock('../../utils/experience-parser.js', () => ({
    calculateExperienceMultiplier: () => ({ totalMultiplier: mocks.experienceMultiplier }),
}));

const { rankAlchemyType, alchemyGoldRates, clearAlchemyRateCache, isEligible } = await import('./alchemy-rankings.js');
const { getAlchemyCoinCost } = await import('../../utils/alchemy-fees.js');
const { calculatePriceAfterTax } = await import('../../utils/profit-helpers.js');

/** Absurd, so the six-way catalyst search always prefers no catalyst at all */
const CATALYST_PRICE = 1e12;

const ACTION_TIME = 20;
const ACTIONS_PER_HOUR = 3600 / ACTION_TIME;

/**
 * Game data with one item per alchemy action and one item with no alchemy at all.
 * @param {Object} [overrides] - Extra or replacement item details, by hrid
 * @returns {Object} An init_client_data stand-in
 */
function gameData(overrides = {}) {
    return {
        actionDetailMap: {
            '/actions/alchemy/coinify': {
                type: '/action_types/alchemy',
                baseTimeCost: ACTION_TIME * 1e9,
                levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
            },
            '/actions/alchemy/decompose': {
                type: '/action_types/alchemy',
                baseTimeCost: ACTION_TIME * 1e9,
                levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
            },
            '/actions/alchemy/transmute': {
                type: '/action_types/alchemy',
                baseTimeCost: ACTION_TIME * 1e9,
                levelRequirement: { skillHrid: '/skills/alchemy', level: 1 },
            },
        },
        itemDetailMap: {
            '/items/cheese': {
                name: 'Cheese',
                itemLevel: 10,
                sellPrice: 100,
                alchemyDetail: { isCoinifiable: true, bulkMultiplier: 1 },
            },
            '/items/milk': {
                name: 'Milk',
                itemLevel: 5,
                sellPrice: 20,
                alchemyDetail: { decomposeItems: [{ itemHrid: '/items/whey', count: 2 }], bulkMultiplier: 1 },
            },
            '/items/ore': {
                name: 'Ore',
                itemLevel: 30,
                sellPrice: 500,
                alchemyDetail: {
                    transmuteSuccessRate: 0.5,
                    transmuteDropTable: [{ itemHrid: '/items/gem', dropRate: 1, minCount: 1, maxCount: 1 }],
                    bulkMultiplier: 1,
                },
            },
            '/items/rock': { name: 'Rock', itemLevel: 1, sellPrice: 1 },
            ...overrides,
        },
    };
}

/**
 * Profit per hour from a per-attempt profit, at the fixture's action time.
 * @param {number} netPerAttempt - Coins per attempt after every cost
 * @returns {number} Coins per hour
 */
const perHour = (netPerAttempt) => (netPerAttempt / ACTION_TIME) * 3600;

beforeEach(() => {
    clearAlchemyRateCache();
    mocks.initClientData = gameData();
    mocks.skills = [{ skillHrid: '/skills/alchemy', level: 40 }];
    mocks.drinkSlots = [];
    mocks.itemPrice = 0;
    mocks.itemPrices = {
        '/items/catalyst_of_coinification': CATALYST_PRICE,
        '/items/catalyst_of_decomposition': CATALYST_PRICE,
        '/items/catalyst_of_transmutation': CATALYST_PRICE,
        '/items/prime_catalyst': CATALYST_PRICE,
        '/items/cheese': 200,
        '/items/milk': 50,
        '/items/whey': 200,
        '/items/ore': 10,
        '/items/gem': 900,
    };
    mocks.actionStats = { actionTime: ACTION_TIME, totalEfficiency: 0, efficiencyBreakdown: {} };
    mocks.experienceMultiplier = 1;
});

describe('isEligible', () => {
    test('reads the three flags the calculator reads, and nothing else', () => {
        const items = gameData().itemDetailMap;
        expect(isEligible('coinify', items['/items/cheese'])).toBe(true);
        expect(isEligible('decompose', items['/items/cheese'])).toBe(false);
        expect(isEligible('decompose', items['/items/milk'])).toBe(true);
        expect(isEligible('transmute', items['/items/ore'])).toBe(true);
        expect(isEligible('coinify', items['/items/rock'])).toBe(false);
        expect(isEligible('coinify', null)).toBe(false);
    });
});

describe('rankAlchemyType', () => {
    test('coinify pays the vendor formula less the item, at the calculator’s own number', () => {
        const [row] = rankAlchemyType('coinify');

        // sellPrice 100 × bulk 1 × 5 = 500 coins, at the base 70% success rate,
        // less the 200 the cheese cost. Coinify has no coin fee.
        const expected = perHour(500 * 0.7 - 200);

        expect(row.itemHrid).toBe('/items/cheese');
        expect(row.action).toBe('coinify');
        expect(row.actionHrid).toBe('/actions/alchemy/coinify');
        expect(row.profitPerHour).toBeCloseTo(expected, 6);
        expect(row.profitData.successRate).toBeCloseTo(0.7, 10);
    });

    test('decompose charges the alchemy coin fee, and it is inside the rate', () => {
        const [row] = rankAlchemyType('decompose');

        const fee = getAlchemyCoinCost(mocks.initClientData.itemDetailMap['/items/milk'], 'decompose');
        const output = calculatePriceAfterTax(200) * 2;
        const expected = perHour(output * 0.6 - (50 + fee));

        expect(fee).toBeGreaterThan(0);
        expect(row.profitPerHour).toBeCloseTo(expected, 6);

        // And visibly: the fee is a coin line on the requirement list
        const coinLine = row.profitData.requirementCosts.find((cost) => cost.itemHrid === '/items/coin');
        expect(coinLine.count).toBe(fee);
    });

    test('a decompose rate falls by exactly the fee when the fee is the only thing that moves', () => {
        const withFee = rankAlchemyType('decompose')[0].profitPerHour;

        // The fee is (10 + itemLevel) × 5, so a level-25 milk pays 100 more per
        // action than a level-5 one. Still under the character's alchemy level,
        // so the under-level penalty is not what moved.
        mocks.initClientData.itemDetailMap['/items/milk'].itemLevel = 25;
        const dearer = rankAlchemyType('decompose')[0].profitPerHour;

        expect(withFee - dearer).toBeCloseTo(perHour(100), 6);
    });

    test('transmute nets the drop table against the input and the fee', () => {
        const [row] = rankAlchemyType('transmute');

        const fee = getAlchemyCoinCost(mocks.initClientData.itemDetailMap['/items/ore'], 'transmute');
        const output = calculatePriceAfterTax(900);
        const expected = perHour(output * 0.5 - (10 + fee));

        expect(row.profitPerHour).toBeCloseTo(expected, 6);
    });

    test('an under-levelled item is quoted with the penalty inside, not hidden', () => {
        mocks.skills = [{ skillHrid: '/skills/alchemy', level: 8 }];
        const [row] = rankAlchemyType('coinify');

        // perLevel = 0.9 / itemLevel = 0.09, two levels short → 0.7 × (1 - 0.18)
        const rate = 0.7 * (1 - 0.18);
        expect(row.underLevelled).toBe(true);
        expect(row.requiresLevel).toBe(10);
        expect(row.profitData.successRate).toBeCloseTo(rate, 10);
        expect(row.profitPerHour).toBeCloseTo(perHour(500 * rate - 200), 6);
    });

    test('at or above the item level there is no penalty and no flag', () => {
        const [row] = rankAlchemyType('coinify');
        expect(row.underLevelled).toBe(false);
        expect(row.profitData.successRate).toBeCloseTo(0.7, 10);
    });

    test('an action the alchemy level cannot start yields nothing at all', () => {
        mocks.initClientData.actionDetailMap['/actions/alchemy/transmute'].levelRequirement.level = 90;
        expect(rankAlchemyType('transmute')).toEqual([]);
        // The other two are unaffected — the gate is per action
        expect(rankAlchemyType('coinify')).toHaveLength(1);
    });

    test('experience per hour blends the full award with the 10% consolation', () => {
        const [row] = rankAlchemyType('coinify');
        // base XP for coinify is itemLevel + 10 = 20, at multiplier 1
        const perAction = 0.7 * 20 + 0.3 * 20 * 0.1;
        expect(row.xpPerHour).toBeCloseTo(ACTIONS_PER_HOUR * perAction, 6);
    });

    test('says nothing at all when there is no game data', () => {
        mocks.initClientData = null;
        expect(rankAlchemyType('coinify')).toEqual([]);
    });
});

describe('alchemyGoldRates', () => {
    test('ranks all three actions against each other, best first', () => {
        const rates = alchemyGoldRates();

        expect(rates.map((rate) => rate.action)).toEqual(['transmute', 'coinify', 'decompose']);
        for (let i = 1; i < rates.length; i++) {
            expect(rates[i - 1].goldPerHour).toBeGreaterThanOrEqual(rates[i].goldPerHour);
        }
    });

    test('hands the planner the shape it ranks on', () => {
        const [best] = alchemyGoldRates();
        expect(best).toMatchObject({
            kind: 'alchemy',
            action: 'transmute',
            actionHrid: '/actions/alchemy/transmute',
            itemHrid: '/items/ore',
            label: 'Transmute Ore',
            requiresLevel: 30,
            underLevelled: false,
        });
        expect(best.goldPerHour).toBeGreaterThan(0);
    });

    test('drops anything that loses money — a rate the planner cannot earn at is not a rate', () => {
        mocks.itemPrices['/items/gem'] = 0;
        mocks.itemPrices['/items/whey'] = 0;
        const rates = alchemyGoldRates();
        expect(rates.map((rate) => rate.action)).toEqual(['coinify']);
    });

    test('offers nothing when nothing pays', () => {
        mocks.itemPrices = { ...mocks.itemPrices, '/items/gem': 0, '/items/whey': 0, '/items/cheese': 1e6 };
        expect(alchemyGoldRates()).toEqual([]);
    });

    test('keeps only the top few, since the planner shows a winner and a handful', () => {
        const many = {};
        for (let i = 0; i < 30; i++) {
            many[`/items/thing_${i}`] = {
                name: `Thing ${i}`,
                itemLevel: 1,
                sellPrice: 100 + i,
                alchemyDetail: { isCoinifiable: true, bulkMultiplier: 1 },
            };
        }
        mocks.initClientData = gameData(many);

        const rates = alchemyGoldRates({ limit: 5 });
        expect(rates).toHaveLength(5);
        expect(rates[0].goldPerHour).toBeGreaterThanOrEqual(rates[4].goldPerHour);
    });

    test('memoises against the state it was computed for, and lets go on demand', () => {
        const first = alchemyGoldRates({ priceStamp: 1 })[0].goldPerHour;

        // A price moved but the stamp did not: the caller is saying the market
        // data is the same fetch, so the answer is the same answer
        mocks.itemPrices['/items/gem'] = 4000;
        expect(alchemyGoldRates({ priceStamp: 1 })[0].goldPerHour).toBe(first);

        // A new fetch, or an explicit clear, and it looks again
        expect(alchemyGoldRates({ priceStamp: 2 })[0].goldPerHour).toBeGreaterThan(first);
        clearAlchemyRateCache();
        expect(alchemyGoldRates({ priceStamp: 1 })[0].goldPerHour).toBeGreaterThan(first);
    });

    test('a change of alchemy level invalidates the memo on its own', () => {
        const atForty = alchemyGoldRates({ priceStamp: 1 }).find((rate) => rate.action === 'coinify').goldPerHour;

        mocks.skills = [{ skillHrid: '/skills/alchemy', level: 8 }];
        const underLevelled = alchemyGoldRates({ priceStamp: 1 }).find((rate) => rate.action === 'coinify');

        expect(underLevelled.goldPerHour).toBeLessThan(atForty);
        expect(underLevelled.underLevelled).toBe(true);
    });
});
