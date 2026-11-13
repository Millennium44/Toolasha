/**
 * The Craft & Enhance ranking, wired to a mocked game.
 *
 * The arithmetic is `craft-enhance-rank.test.js`'s. What is proved here is the wiring: which recipes are
 * walked, that the enhancement run is quoted on the player's DETECTED bench, that a missing price at any
 * of the four places it can occur (a drop, an ordinary input, the +N sale, the enhancement run) reaches
 * the row as missing and never as 0, that owned-drops mode moves the cost, and that a superseded run says so.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    gameData: null,
    recipes: [],
    profits: {},
    /** `${hrid}:${level}` -> {price, estimated, source} */
    quotes: {},
    enhanceQuotes: {},
    enhanceCalls: [],
    tokenValue: {},
    stamp: 1,
    drinks: [],
    drinkPrices: {},
    fpExtra: '',
    chain: [],
    xp: {},
    detected: { enhancingLevel: 100, experienceBonus: 10, toolBonus: 5, speedBonus: 0, guzzlingBonus: 1, teas: {} },
    settings: {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key in game.settings ? game.settings[key] : fallback),
        getSetting: (key) => game.settings[key],
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.gameData,
        getCurrentCharacterId: () => 7,
        getSkills: () => [{ skillHrid: '/skills/cheesesmithing', level: 60 }],
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        get lastFetchTimestamp() {
            return game.stamp;
        },
    },
}));
vi.mock('../market/profit-calculator.js', () => ({
    default: { calculateProfit: async (itemHrid, { actionHrid }) => game.profits[actionHrid] ?? null },
}));
vi.mock('../combat-sim/direct-enhancement-cost.js', () => ({
    quoteDirectEnhancement: (itemHrid, from, to, data, options) => {
        game.enhanceCalls.push({ itemHrid, from, to, options });
        return game.enhanceQuotes[itemHrid] ?? null;
    },
}));
vi.mock('../../utils/enhancement-pricing.js', () => ({
    getProductionChainActions: () => game.chain,
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getAutoDetectedParams: () => game.detected }));
vi.mock('../../utils/experience-calculator.js', () => ({
    calculateExpPerHour: (actionHrid) => (actionHrid in game.xp ? game.xp[actionHrid] : { modifiedXP: 100 }),
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPriceInfo: (hrid, { enhancementLevel = 0, side } = {}) =>
        game.quotes[`${hrid}:${enhancementLevel}`] ??
        (side === 'buy' && hrid in game.drinkPrices
            ? { price: game.drinkPrices[hrid], source: 'book', estimated: false }
            : { price: null, source: null, estimated: false }),
}));
vi.mock('../../utils/action-context.js', () => ({
    resolveActionContext: () => ({ equipment: new Map(), drinks: game.drinks }),
}));
vi.mock('../../utils/token-valuation.js', () => ({
    DUNGEON_TOKEN_HRIDS: new Set(['/items/sinister_token']),
    shopCosts: (line) => (Array.isArray(line?.costs) ? line.costs : line?.cost ? [line.cost] : []),
    calculateDungeonTokenValue: (hrid) => game.tokenValue[hrid] ?? null,
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * 0.96,
    calculateDrinksPerHour: (concentration = 0) => 12 * (1 + concentration),
    outputTaxRate: () => 0.04,
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => game.ironCow === true }));
vi.mock('../../utils/background-work.js', () => ({ yieldToEventLoop: async () => {} }));
vi.mock('./production-arbitrage.js', () => ({
    productionRecipes: () => game.recipes,
    stateFingerprint: () => `fp${game.stamp}${game.fpExtra}`,
}));

const {
    rankCraftEnhance,
    clearCraftEnhanceCache,
    craftEnhanceAvailable,
    saleAfterTaxAt,
    craftEnhancePriceStamp,
    craftEnhanceStateKey,
} = await import('./craft-enhance.js');

const skill = { skillHrid: '/skills/cheesesmithing', label: 'Cheesesmithing' };

/** A recipe taking one dungeon drop and some cheese */
function recipe(name, extra = {}) {
    return {
        actionHrid: `/actions/cheesesmithing/${name}`,
        itemHrid: `/items/${name}`,
        skill,
        action: {
            name,
            levelRequirement: { level: 10 },
            inputItems: [
                { itemHrid: '/items/griffin_leather', count: 2 },
                { itemHrid: '/items/cheese', count: 10 },
            ],
        },
        ...extra,
    };
}

/** What the profit calculator would answer for a recipe */
function profit(name, extra = {}) {
    return {
        actionHrid: `/actions/cheesesmithing/${name}`,
        itemName: name,
        totalItemsPerHour: 100,
        outputAmount: 1,
        gourmetBonus: 0,
        totalTeaCostPerHour: 0,
        materialCostPerHour: 100 * 20,
        revenuePerHour: 0,
        profitPerHour: -100 * 20,
        teaCosts: [],
        bonusRevenue: { hasMissingPrices: false },
        materialCosts: [
            { itemHrid: '/items/griffin_leather', amount: 2, askPrice: 1000, totalCost: 2 * 1000, missingPrice: false },
            { itemHrid: '/items/cheese', amount: 10, askPrice: 5, totalCost: 10 * 5, missingPrice: false },
        ],
        ...extra,
    };
}

beforeEach(() => {
    clearCraftEnhanceCache();
    game.stamp += 1;
    game.ironCow = false;
    game.settings = { actions_craftEnhance: true };
    game.gameData = {
        itemDetailMap: {
            '/items/sword': { name: 'Sword', isTradable: true, enhancementCosts: [{ itemHrid: '/items/x', count: 1 }] },
            '/items/robe': { name: 'Robe', isTradable: true, enhancementCosts: [{ itemHrid: '/items/x', count: 1 }] },
            '/items/soulbound': { name: 'Soulbound', enhancementCosts: [{ itemHrid: '/items/x', count: 1 }] },
            '/items/plain': { name: 'Plain', isTradable: true },
        },
        actionDetailMap: {
            '/actions/combat/den': {
                name: 'Den',
                combatZoneInfo: {
                    isDungeon: true,
                    dungeonInfo: { rewardDropTable: [{ itemHrid: '/items/griffin_leather' }] },
                },
            },
        },
        openableLootDropMap: {},
        shopItemDetailMap: {},
    };
    game.recipes = [recipe('sword')];
    game.profits = { '/actions/cheesesmithing/sword': profit('sword') };
    game.quotes = {
        '/items/griffin_leather:0': { price: 1000, source: 'book', estimated: false },
        '/items/sword:0': { price: 2000, source: 'book', estimated: false },
        '/items/sword:5': { price: 9000, source: 'book', estimated: false },
    };
    game.enhanceQuotes = { '/items/sword': { cost: 1500, seconds: 60, xp: 400, xpKnown: true } };
    game.enhanceCalls = [];
    game.tokenValue = {};
    game.drinks = [];
    game.drinkPrices = {};
    game.fpExtra = '';
    game.chain = [];
    game.xp = {};
});

describe('which recipes are walked', () => {
    test('only gear that is tradable, enhanceable and takes a direct dungeon input', async () => {
        game.recipes = [
            recipe('sword'),
            // No dungeon input
            recipe('robe', { action: { name: 'robe', inputItems: [{ itemHrid: '/items/cheese', count: 1 }] } }),
            // Output that cannot be sold
            recipe('soulbound'),
            // Output with nothing to enhance
            recipe('plain'),
            // A cooking recipe is not gear
            recipe('sword', {
                skill: { skillHrid: '/skills/cooking', label: 'Cooking' },
                actionHrid: '/actions/cooking/x',
            }),
        ];
        game.profits['/actions/cheesesmithing/robe'] = profit('robe');
        const rows = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(rows.map((row) => row.itemHrid)).toEqual(['/items/sword']);
    });

    test('a calculator answer about a different recipe is not this row', async () => {
        game.profits['/actions/cheesesmithing/sword'] = profit('sword', {
            actionHrid: '/actions/cheesesmithing/other',
        });
        expect(await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' })).toEqual([]);
    });
});

describe('the figures', () => {
    test('market mode values the drop at its after-tax sale and rates +0 and +5', async () => {
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        // 2 leather at 1000 x 0.96 + 10 cheese at 5 = 1970 a craft
        expect(row.target.craftCostPerUnit).toBeCloseTo(1970, 6);
        expect(row.target.enhanceCost).toBe(1500);
        expect(row.target.saleAfterTax).toBeCloseTo(9000 * 0.96, 6);
        expect(row.target.profitPerUnit).toBeCloseTo(9000 * 0.96 - 1970 - 1500, 6);
        expect(row.base.profitPerUnit).toBeCloseTo(2000 * 0.96 - 1970, 6);
        expect(row.target.status).toBe('ok');
        // 36 s crafting + 60 s enhancing
        expect(row.target.unitsPerHour).toBeCloseTo(3600 / 96, 6);
        expect(row.target.craftXpPerHour).toBeCloseTo(100 * (3600 / 96), 6);
        expect(row.target.enhanceXpPerHour).toBeCloseTo(400 * (3600 / 96), 6);
    });

    test('sunk mode counts the drop at 0 and badges the row', async () => {
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'sunk' });
        expect(row.target.craftCostPerUnit).toBeCloseTo(50, 6);
        expect(row.sunkInputs).toEqual(['/items/griffin_leather']);
        expect(row.target.status).toBe('ok');
    });

    test('the enhancement run is quoted on the DETECTED bench, whatever the Pro setting says', async () => {
        game.settings.itemTooltip_enhancementProRates = true;
        await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(game.enhanceCalls).toHaveLength(1);
        expect(game.enhanceCalls[0].options.params).toBe(game.detected);
        expect(game.enhanceCalls[0]).toEqual(expect.objectContaining({ from: 0, to: 5 }));
    });
});

describe('a missing price is carried as missing', () => {
    test('a drop with no sale quote and no token route is unpriced in market mode', async () => {
        game.quotes['/items/griffin_leather:0'] = { price: null, source: null, estimated: false };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.status).toBe('unpriced');
        expect(row.target.profitPerHour).toBeNull();
        expect(row.base.profitPerHour).toBeNull();
        expect(row.target.unpricedInputs).toEqual([{ itemHrid: '/items/griffin_leather', reason: 'dungeon-input' }]);
    });

    test('...but the same unpriceable drop is simply sunk in sunk mode', async () => {
        game.quotes['/items/griffin_leather:0'] = { price: null, source: null, estimated: false };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'sunk' });
        expect(row.target.status).toBe('ok');
    });

    test('a value-map estimate is not a sale quote', async () => {
        game.quotes['/items/griffin_leather:0'] = { price: 1000, source: 'value', estimated: true };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.status).toBe('unpriced');
    });

    test('an unpriced +N sale leaves +0 priced and +N null', async () => {
        delete game.quotes['/items/sword:5'];
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.base.status).toBe('ok');
        expect(row.target.status).toBe('unpriced');
        expect(row.target.reasons).toEqual(['sale']);
        expect(row.target.profitPerHour).toBeNull();
    });

    test('an estimated +N quote is not a sale either', async () => {
        game.quotes['/items/sword:5'] = { price: 9000, source: 'value', estimated: true };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.reasons).toEqual(['sale']);
    });

    test('an enhancement run that cannot be quoted makes +N unpriced, not free', async () => {
        game.enhanceQuotes = {};
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.status).toBe('unpriced');
        expect(row.target.reasons).toEqual(['enhance']);
        expect(row.target.enhanceCost).toBeNull();
        expect(row.base.status).toBe('ok');
    });

    test('an ordinary input with no price makes both levels unpriced', async () => {
        game.profits['/actions/cheesesmithing/sword'].materialCosts[1].missingPrice = true;
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.base.status).toBe('unpriced');
        expect(row.target.status).toBe('unpriced');
    });

    test('a drink with no price makes the craft cost unknown', async () => {
        game.profits['/actions/cheesesmithing/sword'].teaCosts = [{ itemHrid: '/items/tea', missingPrice: true }];
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.status).toBe('unpriced');
    });

    test('a token-shop input in the real single-cost shape is read too', async () => {
        game.gameData.shopItemDetailMap = {
            a: { itemHrid: '/items/shop_cloth', cost: { itemHrid: '/items/sinister_token', count: 20 } },
        };
        game.recipes = [
            recipe('sword', { action: { name: 'sword', inputItems: [{ itemHrid: '/items/shop_cloth' }] } }),
        ];
        game.profits['/actions/cheesesmithing/sword'] = profit('sword', {
            materialCosts: [{ itemHrid: '/items/shop_cloth', amount: 1, totalCost: 9999, missingPrice: false }],
        });
        game.tokenValue = { '/items/sinister_token': 50 };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.craftCostPerUnit).toBeCloseTo(20 * 50 * 0.96, 6);
    });

    test('a token-shop input is valued through the token, after tax', async () => {
        game.gameData.shopItemDetailMap = {
            a: {
                itemHrid: '/items/shop_cloth',
                costs: [{ itemHrid: '/items/sinister_token', count: 20 }],
                outputCount: 2,
            },
        };
        game.recipes = [
            recipe('sword', {
                action: { name: 'sword', inputItems: [{ itemHrid: '/items/shop_cloth', count: 1 }] },
            }),
        ];
        game.profits['/actions/cheesesmithing/sword'] = profit('sword', {
            materialCosts: [{ itemHrid: '/items/shop_cloth', amount: 1, totalCost: 9999, missingPrice: false }],
        });
        game.tokenValue = { '/items/sinister_token': 50 };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        // 20 tokens x 50 per token, two cloth per purchase, after 4% tax
        expect(row.target.craftCostPerUnit).toBeCloseTo((20 * 50 * 0.96) / 2, 6);
        expect(row.dungeonInputs[0].via).toBe('token');
    });
});

describe('the run itself', () => {
    test('a superseded run answers null and is not joined by the next caller', async () => {
        let current = true;
        const first = rankCraftEnhance({ targetLevel: 5, ownedMode: 'market', isCurrent: () => current });
        current = false;
        expect(await first).toBeNull();
        const second = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(second).toHaveLength(1);
    });

    test('the result is memoised on the state, and a changed owned mode recomputes', async () => {
        const a = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        const b = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(b).toBe(a);
        const c = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'sunk' });
        expect(c).not.toBe(a);
        const d = await rankCraftEnhance({ targetLevel: 6, ownedMode: 'sunk' });
        expect(d).not.toBe(c);
    });

    test('a moved enhancing bench recomputes', async () => {
        const a = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        game.detected = { ...game.detected, enhancingLevel: 120 };
        const b = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(b).not.toBe(a);
    });

    test('a profit calculation that throws drops that row and keeps the rest', async () => {
        game.recipes = [recipe('sword'), recipe('robe')];
        game.profits['/actions/cheesesmithing/robe'] = null;
        const rows = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(rows.map((row) => row.itemHrid)).toEqual(['/items/sword']);
    });

    test('no game data answers empty without a run', async () => {
        game.gameData = null;
        expect(await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' })).toEqual([]);
    });

    test('duplicate recipes for one output quote its enhancement once', async () => {
        game.recipes = [recipe('sword'), { ...recipe('sword'), actionHrid: '/actions/cheesesmithing/sword2' }];
        game.profits['/actions/cheesesmithing/sword2'] = profit('sword', {
            actionHrid: '/actions/cheesesmithing/sword2',
        });
        const rows = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(rows).toHaveLength(2);
        expect(game.enhanceCalls).toHaveLength(1);
    });
});

describe('availability and quotes', () => {
    test('an Iron Cow character has no window', () => {
        expect(craftEnhanceAvailable()).toBe(true);
        game.ironCow = true;
        expect(craftEnhanceAvailable()).toBe(false);
    });

    test('saleAfterTaxAt: a real quote is taxed, anything else is null', () => {
        game.quotes['/items/a:3'] = { price: 100, source: 'book', estimated: false };
        game.quotes['/items/b:3'] = { price: 100, source: null, estimated: false };
        game.quotes['/items/c:3'] = { price: 0, source: 'book', estimated: false };
        expect(saleAfterTaxAt('/items/a', 3)).toBeCloseTo(96, 6);
        expect(saleAfterTaxAt('/items/b', 3)).toBeNull();
        expect(saleAfterTaxAt('/items/c', 3)).toBeNull();
        expect(saleAfterTaxAt('/items/d', 3)).toBeNull();
    });
});

describe('enhancing drinks', () => {
    const concentration = { ...game.detected, guzzlingBonus: 1.5 };

    test('the slotted drinks are charged over the run, one per 300 / (1 + concentration) seconds in every slot', async () => {
        game.detected = concentration;
        game.drinks = [{ itemHrid: '/items/tea_a' }, { itemHrid: '/items/tea_b' }, null];
        game.drinkPrices = { '/items/tea_a': 100, '/items/tea_b': 50 };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        // 12 x 1.5 = 18 drinks an hour per slot; the run is 60 s
        const drinks = ((100 + 50) * 18 * 60) / 3600;
        expect(row.target.enhanceCost).toBeCloseTo(1500 + drinks, 6);
        game.detected = {
            enhancingLevel: 100,
            experienceBonus: 10,
            toolBonus: 5,
            speedBonus: 0,
            guzzlingBonus: 1,
            teas: {},
        };
    });

    test('a drink with no price makes the enhance figure null, never the plan alone', async () => {
        game.drinks = [{ itemHrid: '/items/tea_a' }, { itemHrid: '/items/tea_gone' }];
        game.drinkPrices = { '/items/tea_a': 100 };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.enhanceCost).toBeNull();
        expect(row.target.status).toBe('unpriced');
        expect(row.target.reasons).toEqual(['enhance']);
        expect(row.base.status).toBe('ok');
    });

    test('a changed drink slot recomputes', async () => {
        game.drinkPrices = { '/items/tea_a': 100 };
        const a = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        game.drinks = [{ itemHrid: '/items/tea_a' }];
        const b = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(b).not.toBe(a);
    });
});

describe('test-server shop quote', () => {
    test('a quote that does not know its XP (the shop copy price) is no enhancement quote', async () => {
        game.enhanceQuotes = { '/items/sword': { cost: 8800, seconds: 0, xp: 0, xpKnown: false } };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.status).toBe('unpriced');
        expect(row.target.reasons).toEqual(['enhance']);
        expect(row.target.enhanceCost).toBeNull();
    });
});

describe('buy mode, estimates, teas and the price stamp', () => {
    test('buy mode prices the dungeon input at the calculator buy price, untaxed', async () => {
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'buy' });
        // 2 leather at the 1000 buy price (totalCost 2000 / 2) and 10 cheese at 5
        expect(row.target.craftCostPerUnit).toBeCloseTo(2000 + 50, 6);
        expect(row.sunkInputs).toEqual([]);
    });

    test('buy mode with a missing buy price is unpriced, not 0', async () => {
        game.profits['/actions/cheesesmithing/sword'].materialCosts[0].missingPrice = true;
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'buy' });
        expect(row.target.status).toBe('unpriced');
    });

    test('an input priced only from the value estimate is noted, and still priced', async () => {
        game.profits['/actions/cheesesmithing/sword'].materialCosts[1].estimatedPrice = true;
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.status).toBe('ok');
        expect(row.estimatedInputs).toEqual(['/items/cheese']);
        expect(row.notes.join(' ')).toContain('estimate');
    });

    test('an unpriced drink has its own reason', async () => {
        game.profits['/actions/cheesesmithing/sword'].teaCosts = [{ itemHrid: '/items/tea', missingPrice: true }];
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.target.reasons).toEqual(['tea']);
    });

    test('the price stamp is exposed for staleness checks', () => {
        game.stamp = 123;
        expect(craftEnhancePriceStamp()).toBe(123);
    });
});

describe('the state key the window compares on every draw', () => {
    test('it moves with anything the fingerprint covers (levels, gear, pricing mode), the drinks and the bench', () => {
        const key = craftEnhanceStateKey();
        expect(craftEnhanceStateKey()).toBe(key);
        game.fpExtra = '|level61';
        expect(craftEnhanceStateKey()).not.toBe(key);
        game.fpExtra = '';
        expect(craftEnhanceStateKey()).toBe(key);
        game.drinks = [{ itemHrid: '/items/tea_a' }];
        expect(craftEnhanceStateKey()).not.toBe(key);
        game.drinks = [];
        const bench = game.detected;
        game.detected = { ...bench, toolBonus: 99 };
        expect(craftEnhanceStateKey()).not.toBe(key);
        game.detected = bench;
    });

    test('a held ranking is current exactly when its key matches the one a run would cache under', async () => {
        const rows = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(await rankCraftEnhance()).toBe(rows);
        expect(craftEnhanceStateKey()).toBeTruthy();
    });
});

describe('Only craftable now', () => {
    test('a skill-level tea lets a row start below its requirement', async () => {
        game.profits['/actions/cheesesmithing/sword'].teaSkillLevelBonus = 5;
        game.recipes[0].action.levelRequirement = { level: 63 };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        // Level 60 plus 5 from the tea
        expect(row.levelMet).toBe(true);
    });

    test("Artisan's Action Level raises the requirement past the level", async () => {
        game.profits['/actions/cheesesmithing/sword'].actionLevelBonus = 5;
        game.recipes[0].action.levelRequirement = { level: 58 };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.levelMet).toBe(false);
    });

    test('with no bonus it is the plain comparison', async () => {
        game.recipes[0].action.levelRequirement = { level: 61 };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.levelMet).toBe(false);
    });
});

describe('crafting XP when the upgrade chain is crafted', () => {
    const SWORD_ACTION = '/actions/cheesesmithing/sword';

    test('the chain actions teach inside the same hour, so their XP is counted per unit', async () => {
        game.profits[SWORD_ACTION].upgradeChainCrafted = true;
        game.chain = ['/actions/cheesesmithing/blade', '/actions/cheesesmithing/ingot'];
        game.xp = {
            '/actions/cheesesmithing/blade': { modifiedXP: 40 },
            '/actions/cheesesmithing/ingot': { modifiedXP: 10 },
        };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        // 100 for the recipe, 40 and 10 down the chain, 3600 / 96 units an hour
        expect(row.target.craftXpPerHour).toBeCloseTo(150 * (3600 / 96), 6);
        expect(row.base.craftXpPerHour).toBeCloseTo(150 * 100, 6);
    });

    test('no chain charged, no chain XP', async () => {
        game.chain = ['/actions/cheesesmithing/blade'];
        game.xp = { '/actions/cheesesmithing/blade': { modifiedXP: 40 } };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.base.craftXpPerHour).toBeCloseTo(100 * 100, 6);
    });

    test('one chain action with unreadable XP leaves the figure unknown, with a note, never partial', async () => {
        game.profits[SWORD_ACTION].upgradeChainCrafted = true;
        game.chain = ['/actions/cheesesmithing/blade'];
        game.xp = { '/actions/cheesesmithing/blade': null };
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.base.craftXpPerHour).toBeNull();
        expect(row.target.craftXpPerHour).toBeNull();
        expect(row.notes.join(' ')).toContain('crafting XP');
        expect(row.base.status).toBe('ok');
    });
});
