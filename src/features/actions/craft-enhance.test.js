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
    profitCalls: [],
    /** actionHrid -> the answer for a costing with the upgrade item already held */
    heldProfits: {},
    tokenValue: {},
    tokenEstimated: false,
    stamp: 1,
    drinks: [],
    drinkPrices: {},
    fpExtra: '',
    chain: [],
    xp: {},
    detected: { enhancingLevel: 100, experienceBonus: 10, toolBonus: 5, speedBonus: 0, guzzlingBonus: 1, teas: {} },
    settings: {},
    /** The character's items, or null for an inventory not loaded */
    inventory: [],
    /** refined item hrid -> its refinement action */
    refinements: {},
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
        getInventory: () => game.inventory,
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        get lastFetchTimestamp() {
            return game.stamp;
        },
        get priceVersion() {
            return game.priceVersion;
        },
    },
}));
vi.mock('../market/profit-calculator.js', () => ({
    default: {
        calculateProfit: async (itemHrid, options) => {
            game.profitCalls.push({ itemHrid, ...options });
            if (options.upgradeItemOwned && game.heldProfits[options.actionHrid]) {
                return game.heldProfits[options.actionHrid];
            }
            return game.profits[options.actionHrid] ?? null;
        },
    },
}));
vi.mock('../combat-sim/direct-enhancement-cost.js', () => ({
    quoteDirectEnhancement: (itemHrid, from, to, data, options) => {
        game.enhanceCalls.push({ itemHrid, from, to, options });
        // A quote keyed `hrid:from` answers only a run from that level
        return game.enhanceQuotes[`${itemHrid}:${from}`] ?? game.enhanceQuotes[itemHrid] ?? null;
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
    calculateDungeonTokenValueDetail: (hrid) =>
        game.tokenValue[hrid] > 0
            ? {
                  value: game.tokenValue[hrid],
                  itemHrid: '/items/x',
                  via: 'shop',
                  estimated: Boolean(game.tokenEstimated),
              }
            : null,
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => price * 0.96,
    calculateDrinksPerHour: (concentration = 0) => 12 * (1 + concentration),
    outputTaxRate: () => 0.04,
}));
vi.mock('../../utils/ironcow-valuation.js', () => ({ isIronCowCharacter: () => game.ironCow === true }));
vi.mock('../../utils/refined-item-cost.js', () => ({
    findRefinementAction: (hrid) => game.refinements[hrid] ?? null,
}));
vi.mock('../../utils/background-work.js', () => ({ yieldToEventLoop: async () => {} }));
vi.mock('./production-arbitrage.js', () => ({
    productionRecipes: () => game.recipes,
    stateFingerprint: (stamp) => `fp${stamp}${game.fpExtra}`,
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

/** One inventory stack in the shape the game sends */
function stack(itemHrid, count, enhancementLevel = 0, itemLocationHrid = '/item_locations/inventory') {
    return { itemHrid, count, enhancementLevel, itemLocationHrid };
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
    game.profitCalls = [];
    game.heldProfits = {};
    game.tokenValue = {};
    game.tokenEstimated = false;
    game.drinks = [];
    game.drinkPrices = {};
    game.fpExtra = '';
    // Holds far more than an hour of crafts needs, so the ordinary tests price the drop as owned in market mode
    game.inventory = [stack('/items/griffin_leather', 1_000_000)];
    game.chain = [];
    game.xp = {};
    game.refinements = {};
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

describe('a token-valued input resting on a value-map price says so', () => {
    const setup = () => {
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
    };

    test('flagged, still priced (not rejected), when the token value is an estimate', async () => {
        setup();
        game.tokenEstimated = true;
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.estimatedInputs).toEqual(['/items/shop_cloth']);
        expect(row.target.status).not.toBe('unpriced');
    });

    test('not flagged when the token value is real', async () => {
        setup();
        const [row] = await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' });
        expect(row.estimatedInputs).toEqual([]);
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
        game.priceVersion = 0;
        const stamp = craftEnhancePriceStamp();
        expect(craftEnhanceStateKey()).toContain(stamp);
        game.stamp = 124;
        expect(craftEnhancePriceStamp()).not.toBe(stamp);
    });

    test('an order book opened or a custom price edited (priceVersion only) moves the stamp and the state key', () => {
        game.stamp = 123;
        game.priceVersion = 4;
        const stamp = craftEnhancePriceStamp();
        const key = craftEnhanceStateKey();
        game.priceVersion = 5;
        expect(craftEnhancePriceStamp()).not.toBe(stamp);
        expect(craftEnhanceStateKey()).not.toBe(key);
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

/**
 * A refined (star) ring made from a base ring: the shape of the game's refinement action
 * (`upgradeItemHrid` is the base, `retainAllEnhancement` keeps the base's level).
 */
function starFixture({ retain = true, refinementKnown = true } = {}) {
    const action = {
        hrid: '/actions/cheesesmithing/ring_refined',
        name: 'Ring Star',
        levelRequirement: { level: 10 },
        upgradeItemHrid: '/items/ring',
        retainAllEnhancement: retain,
        inputItems: [{ itemHrid: '/items/griffin_leather', count: 2 }],
    };
    game.gameData.itemDetailMap['/items/ring_refined'] = {
        name: 'Ring Star',
        isTradable: true,
        enhancementCosts: [{ itemHrid: '/items/x', count: 1 }],
    };
    game.gameData.itemDetailMap['/items/ring'] = {
        name: 'Ring',
        isTradable: true,
        enhancementCosts: [{ itemHrid: '/items/x', count: 1 }],
    };
    game.recipes = [{ actionHrid: action.hrid, itemHrid: '/items/ring_refined', skill, action }];
    game.profits[action.hrid] = profit('ring_refined', {
        actionHrid: action.hrid,
        materialCosts: [
            // The upgrade item is the base, bought at +0 and not reduced by Artisan
            {
                itemHrid: '/items/ring',
                baseAmount: 1,
                amount: 1,
                askPrice: 800,
                totalCost: 800,
                missingPrice: false,
                isUpgradeItem: true,
            },
            {
                itemHrid: '/items/griffin_leather',
                baseAmount: 2,
                amount: 2,
                askPrice: 1000,
                totalCost: 2000,
                missingPrice: false,
            },
        ],
    });
    game.quotes['/items/ring_refined:0'] = { price: 4000, source: 'book', estimated: false };
    game.quotes['/items/ring_refined:5'] = { price: 20000, source: 'book', estimated: false };
    if (refinementKnown) game.refinements['/items/ring_refined'] = action;
    game.enhanceQuotes = {
        '/items/ring_refined': { cost: 5000, seconds: 120, xp: 900, xpKnown: true },
        '/items/ring': { cost: 3000, seconds: 80, xp: 600, xpKnown: true },
    };
    return action;
}

describe('enhancing the base before refining', () => {
    const run = async () => (await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' }))[0];

    test('the cheaper base wins, and its run (cost, time, XP) is the one rated', async () => {
        starFixture();
        const row = await run();
        expect(game.enhanceCalls.map((call) => [call.itemHrid, call.from, call.to])).toEqual([
            ['/items/ring_refined', 0, 5],
            ['/items/ring', 0, 5],
        ]);
        expect(game.enhanceCalls[1].options.params).toBe(game.detected);
        expect(row.route).toEqual(
            expect.objectContaining({
                route: 'refine-base',
                directCost: 5000,
                baseCost: 3000,
                saved: 2000,
                offered: true,
                baseHrid: '/items/ring',
            })
        );
        expect(row.target.enhanceCost).toBe(3000);
        // 36 s crafting + the base run's 80 s, and the base run's XP
        expect(row.target.unitsPerHour).toBeCloseTo(3600 / 116, 6);
        expect(row.target.enhanceXpPerHour).toBeCloseTo(600 * (3600 / 116), 6);
        // The base is bought once, in the craft cost, whichever route: 800 + 2 leather at 960
        expect(row.target.craftCostPerUnit).toBeCloseTo(800 + 1920, 6);
    });

    test('the star item itself wins when it is cheaper, and a tie keeps it', async () => {
        starFixture();
        game.enhanceQuotes['/items/ring'] = { cost: 6000, seconds: 80, xp: 600, xpKnown: true };
        expect((await run()).route.route).toBe('craft');
        clearCraftEnhanceCache();
        game.stamp += 1;
        game.enhanceQuotes['/items/ring'] = { cost: 5000, seconds: 80, xp: 600, xpKnown: true };
        const tie = await run();
        expect(tie.route.route).toBe('craft');
        expect(tie.target.enhanceCost).toBe(5000);
    });

    test('a recipe with no refinement action has no base route and quotes only itself', async () => {
        starFixture({ refinementKnown: false });
        const row = await run();
        expect(game.enhanceCalls.map((call) => call.itemHrid)).toEqual(['/items/ring_refined']);
        expect(row.route.offered).toBe(false);
        expect(row.route.route).toBe('craft');
        expect(row.target.enhanceCost).toBe(5000);
    });

    test('a refinement that does not keep the level has no base route', async () => {
        starFixture({ retain: false });
        const row = await run();
        expect(row.route.offered).toBe(false);
        expect(game.enhanceCalls.map((call) => call.itemHrid)).toEqual(['/items/ring_refined']);
    });

    test('another recipe that makes the same star item is not this recipe', async () => {
        const action = starFixture();
        game.refinements['/items/ring_refined'] = { ...action, hrid: '/actions/cheesesmithing/other_ring_refined' };
        expect((await run()).route.offered).toBe(false);
    });

    test('a base that cannot be quoted is not a candidate and never counts as free', async () => {
        starFixture();
        delete game.enhanceQuotes['/items/ring'];
        const row = await run();
        expect(row.route.route).toBe('craft');
        expect(row.route.baseCost).toBeNull();
        expect(row.target.enhanceCost).toBe(5000);
        expect(row.notes.join(' ')).toContain('Enhancing the base first could not be priced');
    });

    test('a star item that cannot be quoted is priced through the base', async () => {
        starFixture();
        delete game.enhanceQuotes['/items/ring_refined'];
        const row = await run();
        expect(row.target.status).toBe('ok');
        expect(row.route.route).toBe('refine-base');
        expect(row.route.directCost).toBeNull();
        expect(row.target.enhanceCost).toBe(3000);
        expect(row.notes.join(' ')).toContain('base route is used');
    });

    test('neither run quotable leaves +N unpriced, +0 still priced', async () => {
        starFixture();
        game.enhanceQuotes = {};
        const row = await run();
        expect(row.route.route).toBeNull();
        expect(row.target.status).toBe('unpriced');
        expect(row.target.reasons).toEqual(['enhance']);
        expect(row.target.enhanceCost).toBeNull();
        expect(row.base.status).toBe('ok');
    });

    test('an unpriced enhancing drink makes both runs unknown, so no route is chosen', async () => {
        starFixture();
        game.drinks = [{ itemHrid: '/items/tea' }];
        const row = await run();
        expect(row.route.route).toBeNull();
        expect(row.target.status).toBe('unpriced');
    });

    test('an unpriced base makes the whole row unpriced, whichever route would win', async () => {
        starFixture();
        game.profits['/actions/cheesesmithing/ring_refined'].materialCosts[0].missingPrice = true;
        const row = await run();
        expect(row.route.route).toBe('refine-base');
        expect(row.target.status).toBe('unpriced');
        expect(row.base.status).toBe('unpriced');
        expect(row.target.reasons).toContain('input');
        expect(row.target.craftCostPerUnit).toBeNull();
        expect(row.target.profitPerHour).toBeNull();
    });

    test('an unpriced star item leaves +N with no sale, whichever route', async () => {
        starFixture();
        delete game.quotes['/items/ring_refined:5'];
        const row = await run();
        expect(row.target.status).toBe('unpriced');
        expect(row.target.reasons).toEqual(['sale']);
        expect(row.target.profitPerHour).toBeNull();
        expect(row.route.route).toBe('refine-base');
    });

    test('a copy of the base held at some level is not considered: the run starts from a fresh +0 base', async () => {
        starFixture();
        await run();
        const baseCalls = game.enhanceCalls.filter((call) => call.itemHrid === '/items/ring');
        expect(baseCalls.map((call) => call.from)).toEqual([0]);
    });

    test('the profit is the sale minus the craft (base once) minus the base run', async () => {
        starFixture();
        const row = await run();
        expect(row.target.profitPerUnit).toBeCloseTo(20000 * 0.96 - (800 + 1920) - 3000, 6);
    });
});

describe('Artisan worst case', () => {
    /** 8 cheese and 2 leather a craft, reduced by Artisan: 8 x (1 - bonus) is 6.8 at 15% */
    function artisan(bonus) {
        const reduced = 8 * (1 - bonus);
        game.profits['/actions/cheesesmithing/sword'] = profit('sword', {
            artisanBonus: bonus,
            materialCosts: [
                {
                    itemHrid: '/items/griffin_leather',
                    baseAmount: 2,
                    amount: 2 * (1 - bonus),
                    askPrice: 1000,
                    totalCost: 2 * (1 - bonus) * 1000,
                    missingPrice: false,
                },
                {
                    itemHrid: '/items/cheese',
                    baseAmount: 8,
                    amount: reduced,
                    askPrice: 5,
                    totalCost: reduced * 5,
                    missingPrice: false,
                },
            ],
        });
    }
    const rank = async (mode = 'sunk') => (await rankCraftEnhance({ targetLevel: 5, ownedMode: mode }))[0];

    test("the average is the default and prices the calculator's fractional amounts", async () => {
        artisan(0.15);
        const row = await rank();
        expect(row.target.craftCostPerUnit).toBeCloseTo(6.8 * 5, 6);
        expect(row.notes.join(' ')).not.toContain('worst case');
    });

    test('worst case bills each craft rounded up, drink concentration included in the bonus', async () => {
        game.settings.actions_artisanMaterialMode = 'worst-case';
        // 10% Artisan with 50% drink concentration is 15%: 8 x 0.85 = 6.8 rounds to 7 a craft (7.2 -> 8 at 10%)
        artisan(0.15);
        const row = await rank();
        expect(row.target.craftCostPerUnit).toBeCloseTo(7 * 5, 6);
        expect(row.notes.join(' ')).toContain('Artisan worst case');
        artisan(0.1);
        clearCraftEnhanceCache();
        game.stamp += 1;
        expect((await rank()).target.craftCostPerUnit).toBeCloseTo(8 * 5, 6);
    });

    test('worst case also rounds a dungeon input up, at its own price', async () => {
        game.settings.actions_artisanMaterialMode = 'worst-case';
        artisan(0.15);
        const row = await rank('market');
        // 2 x 0.85 = 1.7 -> 2 leather at 1000 x 0.96, and 7 cheese at 5
        expect(row.target.craftCostPerUnit).toBeCloseTo(2 * 960 + 35, 6);
    });

    test('Artisan 0 changes nothing in either mode', async () => {
        artisan(0);
        const expected = (await rank()).target.craftCostPerUnit;
        clearCraftEnhanceCache();
        game.stamp += 1;
        game.settings.actions_artisanMaterialMode = 'worst-case';
        const worst = await rank();
        expect(worst.target.craftCostPerUnit).toBeCloseTo(expected, 6);
        expect(worst.notes.join(' ')).not.toContain('worst case');
    });

    test('hybrid has no run length here, so it reads as the average', async () => {
        game.settings.actions_artisanMaterialMode = 'hybrid';
        artisan(0.15);
        expect((await rank()).target.craftCostPerUnit).toBeCloseTo(6.8 * 5, 6);
    });

    test('the upgrade item is not reduced or rounded by Artisan', async () => {
        game.settings.actions_artisanMaterialMode = 'worst-case';
        starFixture();
        game.profits['/actions/cheesesmithing/ring_refined'].artisanBonus = 0.15;
        const row = (await rankCraftEnhance({ targetLevel: 5, ownedMode: 'sunk' }))[0];
        // The base counts once at 800; the leather is sunk
        expect(row.target.craftCostPerUnit).toBeCloseTo(800, 6);
    });

    test('changing the setting is a different ranking, not a cache hit', async () => {
        artisan(0.15);
        const first = await rank();
        game.settings.actions_artisanMaterialMode = 'worst-case';
        const second = await rank();
        expect(first.target.craftCostPerUnit).toBeCloseTo(34, 6);
        expect(second.target.craftCostPerUnit).toBeCloseTo(35, 6);
        expect(craftEnhanceStateKey()).toContain('worst-case');
    });
});

describe('the inventory split', () => {
    // One craft an hour: the hour's need is one craft's, so the counts below read per craft
    beforeEach(() => {
        game.profits['/actions/cheesesmithing/sword'].totalItemsPerHour = 1;
    });
    const rank = async (mode = 'market') => (await rankCraftEnhance({ targetLevel: 5, ownedMode: mode }))[0];
    /** Cheese is 10 x 5 in every fixture recipe */
    const CHEESE = 50;

    test('2 leather needed, 1 held: one at the after-tax sale value, one at the buy price', async () => {
        game.inventory = [stack('/items/griffin_leather', 1)];
        const row = await rank();
        expect(row.target.craftCostPerUnit).toBeCloseTo(960 + 1000 + CHEESE, 6);
        expect(row.heldInputs).toEqual([
            { itemHrid: '/items/griffin_leather', needed: 2, held: 1, bought: 1, stock: 1 },
        ]);
        const text = row.notes.join(' ');
        expect(text).toContain('Holds 1 ');
        expect(text).toContain('an hour of crafts needs 2');
        expect(text).toContain('spreads the stock over that hour');
    });

    test('nothing held and an empty inventory price every unit at the buy price, with no note about the inventory', async () => {
        game.inventory = [];
        const row = await rank();
        expect(row.target.craftCostPerUnit).toBeCloseTo(2000 + CHEESE, 6);
        expect(row.notes.join(' ')).not.toContain('inventory is not loaded');
        expect(row.notes.join(' ')).not.toContain('Holds');
    });

    test('an inventory that is not loaded prices like an empty one but says so', async () => {
        game.inventory = null;
        const row = await rank();
        expect(row.target.craftCostPerUnit).toBeCloseTo(2000 + CHEESE, 6);
        expect(row.notes.join(' ')).toContain('inventory is not loaded');
    });

    test('exactly enough and more than enough are wholly owned', async () => {
        for (const count of [2, 40]) {
            clearCraftEnhanceCache();
            game.stamp += 1;
            game.inventory = [stack('/items/griffin_leather', count)];
            const row = await rank();
            expect(row.target.craftCostPerUnit).toBeCloseTo(1920 + CHEESE, 6);
            expect(row.heldInputs[0].bought).toBe(0);
        }
    });

    test('stacks of the item in the inventory add up; equipped and enhanced ones are not +0 inputs', async () => {
        game.inventory = [
            stack('/items/griffin_leather', 1),
            stack('/items/griffin_leather', 5, 2),
            stack('/items/griffin_leather', 5, 0, '/item_locations/main_hand'),
        ];
        expect((await rank()).target.craftCostPerUnit).toBeCloseTo(960 + 1000 + CHEESE, 6);
    });

    test('sunk counts the held unit at 0 and buys the rest; buy mode ignores a full inventory', async () => {
        game.inventory = [stack('/items/griffin_leather', 1)];
        const sunk = await rank('sunk');
        expect(sunk.target.craftCostPerUnit).toBeCloseTo(1000 + CHEESE, 6);
        expect(sunk.sunkInputs).toEqual(['/items/griffin_leather']);
        clearCraftEnhanceCache();
        game.stamp += 1;
        game.inventory = [stack('/items/griffin_leather', 99)];
        const buy = await rank('buy');
        expect(buy.target.craftCostPerUnit).toBeCloseTo(2000 + CHEESE, 6);
        expect(buy.heldInputs).toEqual([]);
    });

    test('a partly held input with no buy price is unpriced, never the owned part alone', async () => {
        game.inventory = [stack('/items/griffin_leather', 1)];
        game.profits['/actions/cheesesmithing/sword'].materialCosts[0].missingPrice = true;
        const row = await rank();
        expect(row.target.status).toBe('unpriced');
        expect(row.target.craftCostPerUnit).toBeNull();
    });

    test('the same item on two inputs of one recipe draws one stack down once', async () => {
        game.profits['/actions/cheesesmithing/sword'].materialCosts.push({
            itemHrid: '/items/griffin_leather',
            baseAmount: 1,
            amount: 1,
            askPrice: 1000,
            totalCost: 1000,
            missingPrice: false,
        });
        game.inventory = [stack('/items/griffin_leather', 2)];
        const row = await rank();
        // 3 needed, 2 held
        expect(row.target.craftCostPerUnit).toBeCloseTo(2 * 960 + 1000 + CHEESE, 6);
    });

    test('a change in what is held moves the state key and reranks; an unrelated stack does not', async () => {
        game.inventory = [stack('/items/griffin_leather', 1)];
        const key = craftEnhanceStateKey();
        const first = await rank();
        game.inventory = [stack('/items/griffin_leather', 1), stack('/items/cheese', 500)];
        expect(craftEnhanceStateKey()).toBe(key);
        game.inventory = [stack('/items/griffin_leather', 2)];
        expect(craftEnhanceStateKey()).not.toBe(key);
        const second = await rank();
        expect(second).not.toBe(first);
        expect(second.target.craftCostPerUnit).toBeCloseTo(1920 + CHEESE, 6);
    });

    test('no inventory and an empty inventory are different keys; buy mode has no inventory in its key', () => {
        game.inventory = [];
        const empty = craftEnhanceStateKey();
        game.inventory = null;
        expect(craftEnhanceStateKey()).not.toBe(empty);
        game.settings.actions_craftEnhance_ownedDrops = 'buy';
        const buyNone = craftEnhanceStateKey();
        game.inventory = [stack('/items/griffin_leather', 9)];
        expect(craftEnhanceStateKey()).toBe(buyNone);
    });
});

describe('starting from a base the character holds', () => {
    /** The star recipe at a given number of crafts an hour (1: the counts below read per craft) */
    const star = (crafts = 1) => {
        const action = starFixture();
        game.profits[action.hrid].totalItemsPerHour = crafts;
        return action;
    };
    const run = async (mode = 'market') => (await rankCraftEnhance({ targetLevel: 5, ownedMode: mode }))[0];
    const RING_AT_3 = { price: 1000, source: 'book', estimated: false };

    test('a held +3 base is enhanced 3 to 5, priced at its own sale value, and replaces the bought base', async () => {
        star();
        game.quotes['/items/ring:3'] = RING_AT_3;
        game.enhanceQuotes['/items/ring:3'] = { cost: 900, seconds: 40, xp: 300, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 3)];
        const row = await run();
        // A run from +3 is its own quote, not the +0 one reused
        expect(game.enhanceCalls.map((call) => [call.itemHrid, call.from, call.to])).toContainEqual([
            '/items/ring',
            3,
            5,
        ]);
        expect(game.enhanceCalls.map((call) => [call.itemHrid, call.from])).toContainEqual(['/items/ring', 0]);
        expect(row.route.route).toBe('held-base');
        expect(row.route.heldBase).toEqual(
            expect.objectContaining({ level: 3, count: 1, unitValue: 960, via: 'sale' })
        );
        // The base at 960 (its sale after tax) instead of the 800 ask, and the leather held
        expect(row.target.craftCostPerUnit).toBeCloseTo(960 + 1920, 6);
        expect(row.target.enhanceCost).toBe(900);
        // No crafting chain for a base that is held: the chain actions are not in the XP
        expect(game.profitCalls.some((call) => call.upgradeItemOwned === true)).toBe(true);
        // +0 sells an unenhanced star, which a +3 base cannot make: untouched
        expect(row.base.craftCostPerUnit).toBeCloseTo(800 + 1920, 6);
    });

    test('a held base that is dearer to use than the fresh route loses', async () => {
        star();
        game.quotes['/items/ring:3'] = { price: 90000, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:3'] = { cost: 900, seconds: 40, xp: 300, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 3)];
        const row = await run();
        expect(row.route.route).toBe('refine-base');
        expect(row.route.heldBase).toBeNull();
    });

    test('sunk counts a held non-dungeon base at its sale value, not 0', async () => {
        star();
        game.quotes['/items/ring:3'] = RING_AT_3;
        game.enhanceQuotes['/items/ring:3'] = { cost: 900, seconds: 40, xp: 300, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 3)];
        const row = await run('sunk');
        expect(row.route.heldBase.unitValue).toBe(960);
        // The held leather is sunk
        expect(row.target.craftCostPerUnit).toBeCloseTo(960, 6);
    });

    test('a held base above the target level is not a candidate', async () => {
        star();
        game.quotes['/items/ring:7'] = RING_AT_3;
        game.enhanceQuotes['/items/ring:7'] = { cost: 1, seconds: 1, xp: 1, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 7)];
        const row = await run();
        expect(row.route.route).toBe('refine-base');
        expect(game.enhanceCalls.some((call) => call.from === 7)).toBe(false);
    });

    test('a held base with no real sale quote is not a candidate and is never counted as free', async () => {
        star();
        game.enhanceQuotes['/items/ring:3'] = { cost: 1, seconds: 1, xp: 1, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 3)];
        for (const mode of ['market', 'sunk']) {
            clearCraftEnhanceCache();
            game.stamp += 1;
            expect((await run(mode)).route.route).toBe('refine-base');
        }
    });

    test('buy mode and an unloaded inventory ignore a held base', async () => {
        star();
        game.quotes['/items/ring:3'] = RING_AT_3;
        game.enhanceQuotes['/items/ring:3'] = { cost: 1, seconds: 1, xp: 1, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 3)];
        expect((await run('buy')).route.route).toBe('refine-base');
        clearCraftEnhanceCache();
        game.stamp += 1;
        game.inventory = null;
        expect((await run('market')).route.route).toBe('refine-base');
        expect(game.profitCalls.every((call) => !call.upgradeItemOwned)).toBe(true);
    });

    test('a held +0 base is spent once: an input of the same item cannot use the same copy', async () => {
        const action = star();
        action.inputItems.push({ itemHrid: '/items/ring', count: 1 });
        game.gameData.actionDetailMap['/actions/combat/den'].combatZoneInfo.dungeonInfo.rewardDropTable.push({
            itemHrid: '/items/ring',
        });
        game.profits[action.hrid].materialCosts.push({
            itemHrid: '/items/ring',
            baseAmount: 1,
            amount: 1,
            askPrice: 800,
            totalCost: 800,
            missingPrice: false,
        });
        game.quotes['/items/ring:0'] = { price: 1000, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:0'] = { cost: 100, seconds: 10, xp: 1, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1)];
        const row = await run();
        // Base 960 as the held copy, the ring INPUT bought at 800 (the copy is spent), leather 1920
        expect(row.target.craftCostPerUnit).toBeCloseTo(960 + 800 + 1920, 6);
    });

    test('the held count of the base moves the state key', () => {
        star();
        game.inventory = [stack('/items/griffin_leather', 1_000_000)];
        const key = craftEnhanceStateKey();
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 3)];
        expect(craftEnhanceStateKey()).not.toBe(key);
        // A base above the target is never a candidate, so it is not in the key
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 7)];
        expect(craftEnhanceStateKey()).toBe(key);
    });
});

describe('the stock is spread over the hour of crafts', () => {
    const rank = async (mode = 'market') => (await rankCraftEnhance({ targetLevel: 5, ownedMode: mode }))[0];
    const CHEESE = 50;

    test('10 crafts an hour, 2 leather each, 1 held: 1 owned and 19 bought, over 10 crafts', async () => {
        game.profits['/actions/cheesesmithing/sword'].totalItemsPerHour = 10;
        game.inventory = [stack('/items/griffin_leather', 1)];
        const row = await rank();
        expect(row.target.craftCostPerUnit).toBeCloseTo((960 + 19 * 1000) / 10 + CHEESE, 6);
        expect(row.heldInputs[0]).toEqual(expect.objectContaining({ needed: 20, held: 1, bought: 19 }));
        const text = row.notes.join(' ');
        expect(text).toContain('an hour of crafts needs 20');
        expect(text).not.toContain('best case');
    });

    test('stock equal to and above the hour need price every unit as owned', async () => {
        game.profits['/actions/cheesesmithing/sword'].totalItemsPerHour = 10;
        for (const count of [20, 400]) {
            clearCraftEnhanceCache();
            game.stamp += 1;
            game.inventory = [stack('/items/griffin_leather', count)];
            expect((await rank()).target.craftCostPerUnit).toBeCloseTo(1920 + CHEESE, 6);
        }
    });

    test('gourmet copies come from the same crafts: the hour counts crafts, not items', async () => {
        const profitData = game.profits['/actions/cheesesmithing/sword'];
        profitData.totalItemsPerHour = 12;
        profitData.gourmetBonus = 0.2;
        // 12 items an hour from 10 crafts: 20 leather needed
        game.inventory = [stack('/items/griffin_leather', 20)];
        const row = await rank();
        expect(row.heldInputs[0]).toEqual(expect.objectContaining({ needed: 20, held: 20, bought: 0 }));
    });

    test('crafts an hour unknown prices against one craft and says so', async () => {
        game.profits['/actions/cheesesmithing/sword'].totalItemsPerHour = 0;
        game.inventory = [stack('/items/griffin_leather', 1)];
        const row = await rank();
        expect(row.heldInputs[0]).toEqual(expect.objectContaining({ needed: 2, held: 1, bought: 1 }));
        expect(row.notes.join(' ')).toContain('Crafts per hour are not known');
    });

    test('a held base smaller than the hour serves its share; the rest takes the fresh route', async () => {
        const action = starFixture();
        game.profits[action.hrid].totalItemsPerHour = 10;
        game.quotes['/items/ring:3'] = { price: 1000, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:3'] = { cost: 900, seconds: 40, xp: 300, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 2, 3)];
        const row = await rank();
        expect(row.route.route).toBe('held-base');
        expect(row.route.heldBase.coverage).toBeCloseTo(0.2, 9);
        // Fresh: base 800 + leather 1920; held: base 960 + leather 1920. A fifth held:
        expect(row.target.craftCostPerUnit).toBeCloseTo(0.2 * 2880 + 0.8 * 2720, 6);
        expect(row.target.enhanceCost).toBeCloseTo(0.2 * 900 + 0.8 * 3000, 6);
    });

    test('a held base on a faster route covers its share of the mixed hour, not stock over the faster rate', async () => {
        const action = starFixture();
        game.profits[action.hrid].totalItemsPerHour = 10;
        // Owning the base skips its crafting chain: 20 crafts an hour on the held route
        game.heldProfits[action.hrid] = { ...game.profits[action.hrid], totalItemsPerHour: 20 };
        game.quotes['/items/ring:3'] = { price: 1000, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:3'] = { cost: 900, seconds: 40, xp: 300, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 10, 3)];
        const row = await rank();
        // 10 held crafts take half the hour; the other half runs 5 fresh crafts: 10 of 15
        expect(row.route.heldBase.coverage).toBeCloseTo(10 / 15, 9);
    });

    test('a held base stack at least as big as the hour covers all of it', async () => {
        const action = starFixture();
        game.profits[action.hrid].totalItemsPerHour = 10;
        game.quotes['/items/ring:3'] = { price: 1000, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:3'] = { cost: 900, seconds: 40, xp: 300, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 10, 3)];
        const row = await rank();
        expect(row.route.heldBase.coverage).toBe(1);
        expect(row.target.enhanceCost).toBe(900);
        expect(row.target.craftCostPerUnit).toBeCloseTo(960 + 1920, 6);
    });

    test('the key follows the held stacks; crafts an hour come from the same state the fingerprint already covers', () => {
        game.inventory = [stack('/items/griffin_leather', 1)];
        const key = craftEnhanceStateKey();
        game.inventory = [stack('/items/griffin_leather', 2)];
        expect(craftEnhanceStateKey()).not.toBe(key);
        game.fpExtra = '|level61';
        game.inventory = [stack('/items/griffin_leather', 1)];
        expect(craftEnhanceStateKey()).not.toBe(key);
    });
});

describe('held-base candidates and the stock the ordinary split already used', () => {
    const rank = async () => (await rankCraftEnhance({ targetLevel: 5, ownedMode: 'market' }))[0];

    test('a +0 base that is itself a dungeon input is counted once, by the ordinary split', async () => {
        const action = starFixture();
        game.gameData.actionDetailMap['/actions/combat/den'].combatZoneInfo.dungeonInfo.rewardDropTable.push({
            itemHrid: '/items/ring',
        });
        game.profits[action.hrid].totalItemsPerHour = 10;
        // Owned (480 after tax) is cheaper than bought (800)
        game.quotes['/items/ring:0'] = { price: 500, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:0'] = { cost: 3000, seconds: 80, xp: 600, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 2)];
        const row = await rank();
        // 2 of the hour's 10 bases at 480, the other 8 at 800; not blended a second time
        expect(row.target.craftCostPerUnit).toBeCloseTo(0.2 * 480 + 0.8 * 800 + 1920, 6);
        expect(row.route.route).not.toBe('held-base');
    });

    test('crafts an hour unknown on the fresh route considers no held base', async () => {
        const action = starFixture();
        game.profits[action.hrid].totalItemsPerHour = 0;
        game.heldProfits[action.hrid] = { ...game.profits[action.hrid], totalItemsPerHour: 10 };
        game.quotes['/items/ring:3'] = { price: 1000, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:3'] = { cost: 1, seconds: 1, xp: 1, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 1, 3)];
        const row = await rank();
        expect(row.route.route).not.toBe('held-base');
    });

    test('crafts an hour unknown on the held route considers no held base', async () => {
        const action = starFixture();
        game.profits[action.hrid].totalItemsPerHour = 10;
        game.heldProfits[action.hrid] = { ...game.profits[action.hrid], totalItemsPerHour: 0 };
        game.quotes['/items/ring:3'] = { price: 1000, source: 'book', estimated: false };
        game.enhanceQuotes['/items/ring:3'] = { cost: 1, seconds: 1, xp: 1, xpKnown: true };
        game.inventory = [stack('/items/griffin_leather', 1_000_000), stack('/items/ring', 20, 3)];
        const row = await rank();
        expect(row.route.route).not.toBe('held-base');
    });
});
