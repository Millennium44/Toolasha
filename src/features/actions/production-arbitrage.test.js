/**
 * The production arbitrage ranking.
 *
 * The profit calculator is mocked: what it says about a recipe is its own
 * file's business, and the point here is the shaping around it — which
 * recipes are walked, what a row carries, how the volume cap cuts the day view,
 * how the data-quality flag is chosen, and that the result is memoised on the
 * character's state and recomputed when that state moves.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    skills: [],
    drinks: {},
    equipment: new Map(),
}));

const calculator = vi.hoisted(() => ({
    /** actionHrid → profit-calculator result */
    answers: {},
    calls: [],
}));

const market = vi.hoisted(() => ({
    lastFetchTimestamp: Date.now(),
    /** itemHrid → price timestamp (ms) */
    stamps: {},
}));

const settings = vi.hoisted(() => ({
    pricingMode: 'hybrid',
    craftUpgradeItems: false,
}));

const liquidity = vi.hoisted(() => ({
    /** itemHrid → throttle in (0, 1) */
    throttleByItem: {},
    capEnabled: true,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'profitCalc_craftUpgradeItems' ? settings.craftUpgradeItems : true),
        getSettingValue: (key, fallback) => (key === 'profitCalc_pricingMode' ? settings.pricingMode : fallback),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getItemDetails: (hrid) => game.initClientData?.itemDetailMap?.[hrid] ?? null,
        getSkills: () => game.skills,
        getActionDrinkSlots: (type) => game.drinks[type] || [],
        getEquipment: () => game.equipment,
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        get lastFetchTimestamp() {
            return market.lastFetchTimestamp;
        },
        getPriceTimestamp: (hrid) => market.stamps[hrid] ?? market.lastFetchTimestamp,
    },
}));

vi.mock('../market/profit-calculator.js', () => ({
    default: {
        calculateProfit: async (itemHrid, { actionHrid } = {}) => {
            calculator.calls.push(actionHrid);
            return calculator.answers[actionHrid] ?? null;
        },
    },
}));

vi.mock('../../utils/liquidity-cap.js', () => ({
    liquidityCapEnabled: () => liquidity.capEnabled,
    sellsFromProfitData: (profitData) =>
        profitData?.itemHrid
            ? [{ itemHrid: profitData.itemHrid, unitsPerHour: profitData.totalItemsPerHour || 0 }]
            : [],
    capProfitRate: async ({ goldPerHour, sells }) => {
        for (const sold of sells || []) {
            const throttle = liquidity.throttleByItem[sold.itemHrid];
            if (throttle !== undefined && throttle < 1) {
                return {
                    goldPerHour: goldPerHour * throttle,
                    capped: true,
                    limit: {
                        kind: 'volume',
                        note: 'limited by market volume (~1/week)',
                        detail: `${sold.itemHrid} trades ~1/week, and you are not the only seller.`,
                        itemHrid: sold.itemHrid,
                        throttle,
                    },
                };
            }
        }
        return { goldPerHour, capped: false, limit: null };
    },
}));

vi.mock('../../utils/background-work.js', () => ({
    yieldToEventLoop: async () => {},
}));

vi.mock('../../utils/tester-shop.js', () => ({
    testerShopEnabled: () => false,
}));

const {
    rankProductionArbitrage,
    arrangeRows,
    productionRecipes,
    dataQuality,
    rowFromProfit,
    stateFingerprint,
    clearProductionArbitrageCache,
    STALE_PRICE_MS,
} = await import('./production-arbitrage.js');

/**
 * A profit-calculator answer with the fields the ranking reads, at sane defaults.
 * @param {Object} overrides - Fields to set
 * @returns {Object}
 */
function answer(overrides = {}) {
    return {
        itemName: 'Thing',
        itemHrid: '/items/thing',
        actionHrid: '/actions/cheesesmithing/thing',
        actionsPerHour: 100,
        totalItemsPerHour: 100,
        costPerItem: 50,
        priceAfterTax: 95,
        profitPerItem: 40,
        profitPerAction: 40,
        profitPerHour: 4000,
        outputPriceMissing: false,
        outputPriceEstimated: false,
        hasMissingPrices: false,
        teaSkillLevelBonus: 0,
        ...overrides,
    };
}

beforeEach(() => {
    clearProductionArbitrageCache();
    calculator.calls = [];
    calculator.answers = {};
    liquidity.throttleByItem = {};
    liquidity.capEnabled = true;
    market.stamps = {};
    market.lastFetchTimestamp = Date.now();
    settings.pricingMode = 'hybrid';
    settings.craftUpgradeItems = false;
    game.skills = [
        { skillHrid: '/skills/cheesesmithing', level: 50 },
        { skillHrid: '/skills/cooking', level: 10 },
    ];
    game.drinks = {};
    game.equipment = new Map();
    game.initClientData = {
        itemDetailMap: {
            '/items/cheese': { name: 'Cheese' },
            '/items/egg': { name: 'Egg' },
            '/items/log': { name: 'Log' },
            '/items/verdant_cheese': { name: 'Verdant Cheese' },
        },
        actionDetailMap: {
            '/actions/cheesesmithing/cheese': {
                name: 'Cheese',
                type: '/action_types/cheesesmithing',
                levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 1 },
                outputItems: [{ itemHrid: '/items/cheese', count: 1 }],
            },
            '/actions/cheesesmithing/verdant_cheese': {
                name: 'Verdant Cheese',
                type: '/action_types/cheesesmithing',
                levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 65 },
                outputItems: [{ itemHrid: '/items/verdant_cheese', count: 1 }],
            },
            '/actions/cooking/egg': {
                name: 'Egg',
                type: '/action_types/cooking',
                levelRequirement: { skillHrid: '/skills/cooking', level: 5 },
                outputItems: [{ itemHrid: '/items/egg', count: 1 }],
            },
            // Gathering, not production — never walked
            '/actions/woodcutting/log': {
                name: 'Log',
                type: '/action_types/woodcutting',
                levelRequirement: { skillHrid: '/skills/woodcutting', level: 1 },
                outputItems: [{ itemHrid: '/items/log', count: 1 }],
            },
        },
    };
    calculator.answers = {
        '/actions/cheesesmithing/cheese': answer({
            itemName: 'Cheese',
            itemHrid: '/items/cheese',
            actionHrid: '/actions/cheesesmithing/cheese',
        }),
        '/actions/cheesesmithing/verdant_cheese': answer({
            itemName: 'Verdant Cheese',
            itemHrid: '/items/verdant_cheese',
            actionHrid: '/actions/cheesesmithing/verdant_cheese',
            profitPerItem: 200,
            profitPerAction: 200,
            profitPerHour: 20_000,
        }),
        '/actions/cooking/egg': answer({
            itemName: 'Egg',
            itemHrid: '/items/egg',
            actionHrid: '/actions/cooking/egg',
            profitPerItem: -5,
            profitPerAction: -5,
            profitPerHour: -500,
        }),
    };
});

describe('productionRecipes', () => {
    test('walks only the five production skills', () => {
        const recipes = productionRecipes();
        expect(recipes.map((recipe) => recipe.actionHrid).sort()).toEqual([
            '/actions/cheesesmithing/cheese',
            '/actions/cheesesmithing/verdant_cheese',
            '/actions/cooking/egg',
        ]);
        expect(recipes.find((recipe) => recipe.actionHrid === '/actions/cooking/egg').skill.label).toBe('Cooking');
    });

    test('is empty without game data', () => {
        game.initClientData = null;
        expect(productionRecipes()).toEqual([]);
    });
});

describe('rankProductionArbitrage', () => {
    test('asks the calculator about each recipe by name and carries its figures', async () => {
        const rows = await rankProductionArbitrage();

        expect(calculator.calls.sort()).toEqual([
            '/actions/cheesesmithing/cheese',
            '/actions/cheesesmithing/verdant_cheese',
            '/actions/cooking/egg',
        ]);
        expect(rows).toHaveLength(3);

        const cheese = rows.find((row) => row.itemHrid === '/items/cheese');
        expect(cheese).toMatchObject({
            itemName: 'Cheese',
            actionHrid: '/actions/cheesesmithing/cheese',
            skillHrid: '/skills/cheesesmithing',
            skillLabel: 'Cheesesmithing',
            requiredLevel: 1,
            level: 50,
            levelMet: true,
            materialCostPerUnit: 50,
            saleAfterTax: 95,
            marginPerUnit: 40,
            marginPerAction: 40,
            marginPerHour: 4000,
            // 100 units/hr × 24, 4000/hr × 24
            unitsPerDay: 2400,
            marginPerDay: 96_000,
            quality: null,
        });
    });

    test('flags a recipe above the character level, counting tea levels', async () => {
        calculator.answers['/actions/cheesesmithing/verdant_cheese'].teaSkillLevelBonus = 8;
        const rows = await rankProductionArbitrage();
        const verdant = rows.find((row) => row.itemHrid === '/items/verdant_cheese');
        // 50 + 8 < 65
        expect(verdant.levelMet).toBe(false);

        clearProductionArbitrageCache();
        game.skills = [{ skillHrid: '/skills/cheesesmithing', level: 57 }];
        const again = await rankProductionArbitrage();
        // 57 + 8 = 65
        expect(again.find((row) => row.itemHrid === '/items/verdant_cheese').levelMet).toBe(true);
    });

    test('skips a recipe the calculator cannot cost', async () => {
        calculator.answers['/actions/cooking/egg'] = null;
        const rows = await rankProductionArbitrage();
        expect(rows.map((row) => row.itemHrid).sort()).toEqual(['/items/cheese', '/items/verdant_cheese']);
    });

    test('skips an answer about a different recipe for the same item', async () => {
        calculator.answers['/actions/cooking/egg'].actionHrid = '/actions/cooking/egg_other';
        const rows = await rankProductionArbitrage();
        expect(rows.map((row) => row.itemHrid)).not.toContain('/items/egg');
    });

    test('bounds the day view by market volume and leaves the hour view alone', async () => {
        liquidity.throttleByItem['/items/verdant_cheese'] = 0.1;
        const rows = await rankProductionArbitrage();
        const verdant = rows.find((row) => row.itemHrid === '/items/verdant_cheese');

        expect(verdant.marginPerHour).toBe(20_000);
        expect(verdant.uncappedMarginPerDay).toBe(480_000);
        // 20,000 × 24 × 0.1
        expect(verdant.marginPerDay).toBeCloseTo(48_000, 6);
        // 100 × 24 × 0.1 — "make 240/day"
        expect(verdant.unitsPerDay).toBeCloseTo(240, 6);
        expect(verdant.makeablePerDay).toBe(2400);
        expect(verdant.liquidityLimit).toMatchObject({ kind: 'volume', throttle: 0.1 });
        expect(verdant.volumeChecked).toBe(true);

        // A loss is not bounded — there is nothing to bound — but it is checked
        const egg = rows.find((row) => row.itemHrid === '/items/egg');
        expect(egg.liquidityLimit).toBeNull();
        expect(egg.marginPerDay).toBe(-12_000);
    });

    test('reports progress as slices land', async () => {
        const seen = [];
        await rankProductionArbitrage({ onProgress: (done, total) => seen.push([done, total]) });
        expect(seen.length).toBeGreaterThan(0);
        expect(seen[seen.length - 1]).toEqual([3, 3]);
    });

    test('memoises on the character state and recomputes when it moves', async () => {
        const first = await rankProductionArbitrage();
        const second = await rankProductionArbitrage();
        expect(second).toBe(first);
        expect(calculator.calls).toHaveLength(3);

        // A new price snapshot is a new answer
        market.lastFetchTimestamp += 1;
        const third = await rankProductionArbitrage();
        expect(third).not.toBe(first);
        expect(calculator.calls).toHaveLength(6);

        // So is a level, a drink, a piece of gear, or the pricing mode
        game.skills = [{ skillHrid: '/skills/cheesesmithing', level: 51 }];
        await rankProductionArbitrage();
        expect(calculator.calls).toHaveLength(9);

        game.drinks['/action_types/cooking'] = [{ itemHrid: '/items/gourmet_tea' }];
        await rankProductionArbitrage();
        expect(calculator.calls).toHaveLength(12);

        game.equipment = new Map([['hands', { itemHrid: '/items/gloves', enhancementLevel: 5 }]]);
        await rankProductionArbitrage();
        expect(calculator.calls).toHaveLength(15);

        settings.pricingMode = 'conservative';
        await rankProductionArbitrage();
        expect(calculator.calls).toHaveLength(18);

        // And nothing else
        await rankProductionArbitrage();
        expect(calculator.calls).toHaveLength(18);
    });

    test('a second call while the first runs joins it', async () => {
        const a = rankProductionArbitrage();
        const b = rankProductionArbitrage();
        expect(await a).toBe(await b);
        expect(calculator.calls).toHaveLength(3);
    });
});

describe('stateFingerprint', () => {
    test('moves with the volume-cap switch', () => {
        const on = stateFingerprint(5);
        liquidity.capEnabled = false;
        expect(stateFingerprint(5)).not.toBe(on);
    });
});

describe('dataQuality', () => {
    const now = 10_000_000;

    test('no output price', () => {
        expect(dataQuality(answer({ outputPriceMissing: true }), now).flag).toBe('no-price');
        expect(dataQuality(answer({ outputPriceMissing: true, outputPriceEstimated: true }), now).flag).toBe(
            'no-price'
        );
    });

    test('a material without a price', () => {
        expect(dataQuality(answer({ hasMissingPrices: true }), now).flag).toBe('missing-input');
    });

    test('a stale output price', () => {
        market.stamps['/items/thing'] = now - STALE_PRICE_MS - 1;
        expect(dataQuality(answer(), now)).toMatchObject({ flag: 'stale' });
        market.stamps['/items/thing'] = now - 1000;
        expect(dataQuality(answer(), now).flag).toBeNull();
    });

    test('the output flag outranks the input flag', () => {
        expect(dataQuality(answer({ outputPriceMissing: true, hasMissingPrices: true }), now).flag).toBe('no-price');
    });
});

describe('rowFromProfit', () => {
    test('falls back to the item map and the hrid for names', () => {
        const recipe = {
            actionHrid: '/actions/cooking/egg',
            action: { type: '/action_types/cooking', levelRequirement: { level: 5 } },
            skill: { skillHrid: '/skills/cooking', label: 'Cooking', type: '/action_types/cooking' },
            itemHrid: '/items/egg',
        };
        const row = rowFromProfit(recipe, answer({ itemName: undefined, itemHrid: '/items/egg' }));
        expect(row.itemName).toBe('Egg');
        expect(row.actionName).toBe('egg');
        expect(row.level).toBe(10);
        expect(row.levelMet).toBe(true);
    });
});

describe('arrangeRows', () => {
    let rows;
    beforeEach(async () => {
        liquidity.throttleByItem['/items/verdant_cheese'] = 0.01;
        rows = await rankProductionArbitrage();
    });

    test('sorts by margin per day by default — the capped figure', () => {
        // verdant: 480,000 × 0.01 = 4,800/day; cheese: 96,000/day; egg: −12,000/day
        expect(arrangeRows(rows).map((row) => row.itemHrid)).toEqual([
            '/items/cheese',
            '/items/verdant_cheese',
            '/items/egg',
        ]);
    });

    test('sorts by margin per hour and per unit', () => {
        expect(arrangeRows(rows, { sort: 'hour' })[0].itemHrid).toBe('/items/verdant_cheese');
        expect(arrangeRows(rows, { sort: 'unit' })[0].itemHrid).toBe('/items/verdant_cheese');
    });

    test('filters by skill, by name and by craftability', () => {
        expect(arrangeRows(rows, { skillHrid: '/skills/cooking' }).map((row) => row.itemHrid)).toEqual(['/items/egg']);
        expect(arrangeRows(rows, { query: 'VERD' }).map((row) => row.itemHrid)).toEqual(['/items/verdant_cheese']);
        expect(arrangeRows(rows, { craftableOnly: true }).map((row) => row.itemHrid)).toEqual([
            '/items/cheese',
            '/items/egg',
        ]);
    });

    test('does not touch the input', () => {
        const before = rows.map((row) => row.itemHrid);
        arrangeRows(rows, { sort: 'unit' });
        expect(rows.map((row) => row.itemHrid)).toEqual(before);
    });
});
