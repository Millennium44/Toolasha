/**
 * Tests for the Crafting Plan Calculator
 *
 * The recipe book, the market and the character's teas are mocked; the
 * recursion is not. Each test sets up a small world and pins the buy-vs-craft
 * decision, the unit cost that decision produces, and the quantities that flow
 * down to the children.
 *
 * Standing fixture (unless a test says otherwise):
 *   cowhide        — no recipe, market 10
 *   rough leather  — 3 cowhide → 1, market 50  (craft = 30, so craft wins)
 *   leather boots  — 6 rough leather → 1, market 500 (craft = 6 × 30 = 180)
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    initClientData: null,
    itemDetails: {},
}));

const market = vi.hoisted(() => ({
    /** itemHrid → buy price, or absent for "no market data" */
    prices: {},
    shopCosts: {},
}));

const buffs = vi.hoisted(() => ({
    artisanBonus: 0,
    actionStats: { actionTime: 10, totalEfficiency: 100 },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.initClientData,
        getItemDetails: (hrid) => game.itemDetails[hrid] ?? null,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getSkills: () => [],
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => (hrid in market.prices ? market.prices[hrid] : null),
}));

vi.mock('../../utils/game-lookups.js', () => ({
    getShopCoinCost: (hrid) => market.shopCosts[hrid] ?? 0,
}));

vi.mock('../../utils/tea-parser.js', () => ({
    parseArtisanBonus: () => buffs.artisanBonus,
    getDrinkConcentration: () => 0,
}));

vi.mock('../../utils/action-calculator.js', () => ({
    calculateActionStats: () => buffs.actionStats,
}));

const { computeBestCraftingPlan, collectMissingMaterials } = await import('./crafting-plan-calculator.js');

const COWHIDE = '/items/cowhide';
const LEATHER = '/items/rough_leather';
const BOOTS = '/items/leather_boots';

beforeEach(() => {
    buffs.artisanBonus = 0;
    buffs.actionStats = { actionTime: 10, totalEfficiency: 100 };
    market.prices = { [COWHIDE]: 10, [LEATHER]: 50, [BOOTS]: 500 };
    market.shopCosts = {};
    game.itemDetails = {
        [COWHIDE]: { name: 'Cowhide', isTradable: true },
        [LEATHER]: { name: 'Rough Leather', isTradable: true },
        [BOOTS]: { name: 'Leather Boots', isTradable: true },
    };
    game.initClientData = {
        actionDetailMap: {
            '/actions/tailoring/rough_leather': {
                type: '/action_types/tailoring',
                category: '/action_categories/tailoring/material',
                inputItems: [{ itemHrid: COWHIDE, count: 3 }],
                outputItems: [{ itemHrid: LEATHER, count: 1 }],
            },
            '/actions/crafting/leather_boots': {
                type: '/action_types/crafting',
                category: '/action_categories/crafting/feet',
                inputItems: [{ itemHrid: LEATHER, count: 6 }],
                outputItems: [{ itemHrid: BOOTS, count: 1 }],
            },
        },
    };
});

describe('leaf nodes', () => {
    test('coins always cost one each', () => {
        const plan = computeBestCraftingPlan('/items/coin', 250);

        expect(plan).toMatchObject({ strategy: 'buy', unitCost: 1, totalCost: 250, itemName: 'Coin' });
    });

    test('an item with no recipe is bought at its market price', () => {
        const plan = computeBestCraftingPlan(COWHIDE, 7);

        expect(plan.strategy).toBe('buy');
        expect(plan.unitCost).toBe(10);
        expect(plan.totalCost).toBe(70);
        expect(plan.children).toEqual([]);
        expect(plan.actionHrid).toBeNull();
    });

    test('an unpriceable item costs Infinity so it cannot masquerade as free', () => {
        delete market.prices[COWHIDE];

        const plan = computeBestCraftingPlan(COWHIDE, 3);

        expect(plan.buyPrice).toBeNull();
        expect(plan.unitCost).toBe(Infinity);
        expect(plan.totalCost).toBe(Infinity);
    });

    test('an untradable item ignores the market and falls back to the shop', () => {
        game.itemDetails[COWHIDE].isTradable = false;
        market.shopCosts[COWHIDE] = 25;

        expect(computeBestCraftingPlan(COWHIDE, 2).unitCost).toBe(25);
    });

    test('the shop price is used only when it undercuts the market', () => {
        market.shopCosts[COWHIDE] = 8;
        expect(computeBestCraftingPlan(COWHIDE, 1).unitCost).toBe(8);

        market.shopCosts[COWHIDE] = 12;
        expect(computeBestCraftingPlan(COWHIDE, 1).unitCost).toBe(10);
    });

    test('an unnamed item falls back to the last path segment', () => {
        game.itemDetails = {};

        expect(computeBestCraftingPlan(COWHIDE, 1).itemName).toBe('cowhide');
    });
});

describe('buy vs craft', () => {
    test('crafts when the recipe beats the listing, and prices the whole tree', () => {
        // boots: 6 leather × (3 cowhide × 10 = 30) = 180 < market 500
        const plan = computeBestCraftingPlan(BOOTS, 1);

        expect(plan.strategy).toBe('craft');
        expect(plan.craftCost).toBe(180);
        expect(plan.unitCost).toBe(180);
        expect(plan.totalCost).toBe(180);
        expect(plan.actionHrid).toBe('/actions/crafting/leather_boots');
        expect(plan.actionsNeeded).toBe(1);

        const leather = plan.children[0];
        expect(leather).toMatchObject({ itemHrid: LEATHER, strategy: 'craft', unitCost: 30 });
        expect(leather.quantity).toBe(6); // 6 per boot
        expect(leather.totalCost).toBe(180);

        const cowhide = leather.children[0];
        expect(cowhide).toMatchObject({ itemHrid: COWHIDE, strategy: 'buy', unitCost: 10 });
        expect(cowhide.quantity).toBe(18); // 3 cowhide × 6 leather
        expect(cowhide.totalCost).toBe(180);
    });

    test('buys when the listing is at or below the craft cost', () => {
        market.prices[LEATHER] = 20; // below the 30 it costs to make

        const plan = computeBestCraftingPlan(LEATHER, 4);

        expect(plan.strategy).toBe('buy');
        expect(plan.unitCost).toBe(20);
        expect(plan.craftCost).toBe(30); // still reported, for the display
        expect(plan.totalCost).toBe(80);
        expect(plan.children).toEqual([]);
        expect(plan.actionsNeeded).toBe(0);
    });

    test('a tie goes to buying', () => {
        market.prices[LEATHER] = 30; // exactly the craft cost

        expect(computeBestCraftingPlan(LEATHER, 1).strategy).toBe('buy');
    });

    test('a cheaper sub-material propagates up into the parent decision', () => {
        market.prices[LEATHER] = 20;

        // boots now cost 6 × 20 = 120 to craft instead of 180
        const plan = computeBestCraftingPlan(BOOTS, 1);

        expect(plan.craftCost).toBe(120);
        expect(plan.children[0].strategy).toBe('buy');
    });

    test('scales quantities and rounds actions up to whole actions', () => {
        const plan = computeBestCraftingPlan(BOOTS, 5);

        expect(plan.actionsNeeded).toBe(5);
        expect(plan.totalCost).toBe(900); // 5 × 180
        expect(plan.children[0].quantity).toBe(30); // 6 leather × 5 boots
        expect(plan.children[0].children[0].quantity).toBe(90); // 3 cowhide × 30 leather
    });
});

describe('multi-output recipes and upgrade items', () => {
    test('splits the input cost across every unit the action produces', () => {
        // 1 shaft (10) → 2 arrows, so an arrow costs 5 to craft, below its 8 listing
        game.itemDetails['/items/arrow'] = { name: 'Arrow', isTradable: true };
        game.itemDetails['/items/shaft'] = { name: 'Shaft', isTradable: true };
        market.prices['/items/arrow'] = 8;
        market.prices['/items/shaft'] = 10;
        game.initClientData.actionDetailMap['/actions/crafting/arrow'] = {
            type: '/action_types/crafting',
            category: '/action_categories/crafting/ammo',
            inputItems: [{ itemHrid: '/items/shaft', count: 1 }],
            outputItems: [{ itemHrid: '/items/arrow', count: 2 }],
        };

        const plan = computeBestCraftingPlan('/items/arrow', 5);

        expect(plan.strategy).toBe('craft');
        expect(plan.unitCost).toBe(5);
        expect(plan.totalCost).toBe(25);
        expect(plan.actionsNeeded).toBe(3); // ceil(5 / 2)
        expect(plan.children[0].quantity).toBe(3); // 1 shaft per action
    });

    test('an upgrade item is charged once per action and skips the artisan discount', () => {
        // Reinforced boots: 2 leather + the boots themselves
        game.itemDetails['/items/reinforced_boots'] = { name: 'Reinforced Boots', isTradable: true };
        market.prices['/items/reinforced_boots'] = 9999;
        game.initClientData.actionDetailMap['/actions/crafting/reinforced_boots'] = {
            type: '/action_types/crafting',
            category: '/action_categories/crafting/feet',
            inputItems: [{ itemHrid: LEATHER, count: 2 }],
            upgradeItemHrid: BOOTS,
            outputItems: [{ itemHrid: '/items/reinforced_boots', count: 1 }],
        };
        buffs.artisanBonus = 0.5; // halves every input, must not touch the upgrade item

        // With the tea running the whole tree gets cheaper:
        //   leather = 3 × 0.5 = 1.5 cowhide × 10 = 15
        //   boots   = 6 × 0.5 = 3 leather × 15   = 45
        // reinforced = (2 × 0.5 = 1 leather × 15) + one WHOLE boot at 45 = 60
        // The upgrade line is 45, not 22.5 — the discount stops at the inputs.
        const plan = computeBestCraftingPlan('/items/reinforced_boots', 1);

        expect(plan.craftCost).toBe(60);
        expect(plan.children[1].unitCost).toBe(45);
        expect(plan.children.map((c) => c.itemHrid)).toEqual([LEATHER, BOOTS]);
        expect(plan.children[1].quantity).toBe(1);
    });
});

describe('artisan tea', () => {
    test('reduces input counts and the resulting craft cost', () => {
        buffs.artisanBonus = 0.1;

        // leather: 3 × 0.9 = 2.7 cowhide × 10 = 27 (vs 30 without tea)
        const leather = computeBestCraftingPlan(LEATHER, 1);
        expect(leather.craftCost).toBeCloseTo(27, 10);
        expect(leather.children[0].quantity).toBe(3); // 2.7 rounded up to whole hides

        // boots: 6 × 0.9 = 5.4 leather × 27 = 145.8
        const boots = computeBestCraftingPlan(BOOTS, 1);
        expect(boots.craftCost).toBeCloseTo(145.8, 10);
    });
});

describe('planning flags', () => {
    test('buyRawOnly crafts anything with a recipe even when buying is cheaper', () => {
        market.prices[LEATHER] = 20; // buying would normally win

        const plan = computeBestCraftingPlan(BOOTS, 1, 'ask', new Set(), new Map(), 0, 15, true);

        expect(plan.children[0].strategy).toBe('craft');
        expect(plan.children[0].unitCost).toBe(30);
        expect(plan.craftCost).toBe(180);
    });

    test('forceRootCraft crafts the target only, leaving children free to be bought', () => {
        market.prices[BOOTS] = 100; // cheaper than the 180 it costs to make
        market.prices[LEATHER] = 20;

        const plan = computeBestCraftingPlan(BOOTS, 1, 'ask', new Set(), new Map(), 0, 15, false, true);

        expect(plan.strategy).toBe('craft');
        expect(plan.unitCost).toBe(120); // 6 × 20 bought leather
        expect(plan.children[0].strategy).toBe('buy');
    });

    test('skipProcessing buys material-conversion outputs instead of making them', () => {
        // rough leather's action category ends in /material
        const plan = computeBestCraftingPlan(BOOTS, 1, 'ask', new Set(), new Map(), 0, 15, false, false, 0, true);

        expect(plan.children[0].strategy).toBe('buy');
        expect(plan.children[0].unitCost).toBe(50);
        expect(plan.craftCost).toBe(300); // 6 × 50
    });

    test('the depth limit forces everything below it to be bought', () => {
        const plan = computeBestCraftingPlan(BOOTS, 1, 'ask', new Set(), new Map(), 0, 1);

        expect(plan.strategy).toBe('craft');
        expect(plan.children[0].strategy).toBe('buy');
        expect(plan.children[0].unitCost).toBe(50);
        expect(plan.craftCost).toBe(300);
    });

    test('a maxDepth of zero buys the target outright', () => {
        const plan = computeBestCraftingPlan(BOOTS, 2, 'ask', new Set(), new Map(), 0, 0);

        expect(plan.strategy).toBe('buy');
        expect(plan.totalCost).toBe(1000);
    });

    test('time cost is charged per action at the requested hourly rate', () => {
        // 10s action at 100% efficiency → 10 / 2 = 5s per leather
        // 5s × (7200 / 3600 per second) = 10 gold → craft cost 30 + 10 = 40
        const plan = computeBestCraftingPlan(LEATHER, 1, 'ask', new Set(), new Map(), 0, 15, false, false, 7200);

        expect(plan.craftCost).toBeCloseTo(40, 10);
        expect(plan.strategy).toBe('craft'); // still under the 50 listing
    });

    test('enough time cost flips a craft into a buy', () => {
        // 5s per leather at 36,000/hour = 50 gold → craft 80 > listing 50
        const plan = computeBestCraftingPlan(LEATHER, 1, 'ask', new Set(), new Map(), 0, 15, false, false, 36000);

        expect(plan.craftCost).toBeCloseTo(80, 10);
        expect(plan.strategy).toBe('buy');
    });
});

describe('recursion safety', () => {
    test('a circular recipe stops at the repeat and buys instead of looping', () => {
        game.itemDetails['/items/a'] = { name: 'A', isTradable: true };
        game.itemDetails['/items/b'] = { name: 'B', isTradable: true };
        market.prices['/items/a'] = 100;
        market.prices['/items/b'] = 40;
        game.initClientData.actionDetailMap = {
            '/actions/x/a': {
                type: '/action_types/crafting',
                inputItems: [{ itemHrid: '/items/b', count: 1 }],
                outputItems: [{ itemHrid: '/items/a', count: 1 }],
            },
            '/actions/x/b': {
                type: '/action_types/crafting',
                inputItems: [{ itemHrid: '/items/a', count: 1 }],
                outputItems: [{ itemHrid: '/items/b', count: 1 }],
            },
        };

        // A → craft from B; B → its input A is already on the stack, so A is bought at 100,
        // making B cost 100 to craft vs 40 to buy → B is bought → A costs 40 to craft.
        const plan = computeBestCraftingPlan('/items/a', 1);

        expect(plan.strategy).toBe('craft');
        expect(plan.craftCost).toBe(40);
        expect(plan.children[0]).toMatchObject({ itemHrid: '/items/b', strategy: 'buy' });
    });

    test('two recipes that consume each other terminate even when both are worth crafting', () => {
        // A: 1 B → 1 A, market 100.  B: 1 A → 2 B, market 150.
        // B crafts at 50 (A bought at 100, split over 2 outputs) and A then
        // crafts at 50 — BOTH end up memoised as 'craft', and the memo path
        // used to re-expand each one's children into the other forever
        // (neither `visited` nor the depth limit was checked before the memo),
        // overflowing the stack on a single call.
        game.itemDetails['/items/a'] = { name: 'A', isTradable: true };
        game.itemDetails['/items/b'] = { name: 'B', isTradable: true };
        market.prices['/items/a'] = 100;
        market.prices['/items/b'] = 150;
        game.initClientData.actionDetailMap = {
            '/actions/x/a': {
                type: '/action_types/crafting',
                inputItems: [{ itemHrid: '/items/b', count: 1 }],
                outputItems: [{ itemHrid: '/items/a', count: 1 }],
            },
            '/actions/x/b': {
                type: '/action_types/crafting',
                inputItems: [{ itemHrid: '/items/a', count: 1 }],
                outputItems: [{ itemHrid: '/items/b', count: 2 }],
            },
        };

        const plan = computeBestCraftingPlan('/items/a', 1);

        expect(plan.strategy).toBe('craft');
        expect(plan.craftCost).toBe(50);
        expect(plan.children[0].itemHrid).toBe('/items/b');
    });

    test('a memoised item keeps its decision and re-expands children for the new quantity', () => {
        // Two boot recipes sharing rough leather, so the second hits the memo
        game.itemDetails['/items/leather_gloves'] = { name: 'Leather Gloves', isTradable: true };
        market.prices['/items/leather_gloves'] = 500;
        game.initClientData.actionDetailMap['/actions/crafting/leather_gloves'] = {
            type: '/action_types/crafting',
            category: '/action_categories/crafting/hands',
            inputItems: [
                { itemHrid: LEATHER, count: 6 },
                { itemHrid: LEATHER, count: 2 },
            ],
            outputItems: [{ itemHrid: '/items/leather_gloves', count: 1 }],
        };

        const plan = computeBestCraftingPlan('/items/leather_gloves', 1);

        // 8 leather at the memoised unit cost of 30 = 240
        expect(plan.craftCost).toBe(240);
        expect(plan.children[1]).toMatchObject({ itemHrid: LEATHER, strategy: 'craft', unitCost: 30 });
        expect(plan.children[1].quantity).toBe(2);
        expect(plan.children[1].children[0].quantity).toBe(6); // 3 cowhide × 2 leather
    });
});

describe('collectMissingMaterials', () => {
    test('a multi-output recipe is billed per action, not per unit of output', () => {
        // 1 shaft → 2 arrows. 20 arrows = 10 actions = 10 shafts. The display
        // used to scale a one-unit plan's buy counts by numActions × outputCount,
        // billing 20 shafts here — double what ten actions consume.
        game.itemDetails['/items/arrow'] = { name: 'Arrow', isTradable: true };
        game.itemDetails['/items/shaft'] = { name: 'Shaft', isTradable: true };
        market.prices['/items/arrow'] = 8;
        market.prices['/items/shaft'] = 10;
        game.initClientData.actionDetailMap['/actions/crafting/arrow'] = {
            type: '/action_types/crafting',
            category: '/action_categories/crafting/ammo',
            inputItems: [{ itemHrid: '/items/shaft', count: 1 }],
            outputItems: [{ itemHrid: '/items/arrow', count: 2 }],
        };

        const plan = computeBestCraftingPlan('/items/arrow', 20);
        const missing = collectMissingMaterials(plan, [{ itemHrid: '/items/shaft', count: 4 }]);

        expect(missing).toEqual([
            { itemHrid: '/items/shaft', itemName: 'Shaft', missing: 6, required: 10, isTradeable: true },
        ]);
    });

    test('aggregates branches, skips coins, ignores enhanced copies, drops covered lines', () => {
        const plan = {
            strategy: 'craft',
            children: [
                { strategy: 'buy', itemHrid: COWHIDE, itemName: 'Cowhide', quantity: 5, children: [] },
                {
                    strategy: 'craft',
                    children: [
                        { strategy: 'buy', itemHrid: COWHIDE, itemName: 'Cowhide', quantity: 2.5, children: [] },
                        { strategy: 'buy', itemHrid: '/items/coin', itemName: 'Coin', quantity: 100, children: [] },
                        { strategy: 'buy', itemHrid: LEATHER, itemName: 'Rough Leather', quantity: 2, children: [] },
                    ],
                },
            ],
        };

        const missing = collectMissingMaterials(plan, [
            { itemHrid: COWHIDE, count: 3 },
            { itemHrid: COWHIDE, count: 50, enhancementLevel: 2 }, // not a material
            { itemHrid: LEATHER, count: 2 }, // fully covered — dropped
        ]);

        // 5 + 2.5 across branches → ceil(7.5) = 8 needed, 3 held → 5 short
        expect(missing).toEqual([
            { itemHrid: COWHIDE, itemName: 'Cowhide', missing: 5, required: 8, isTradeable: true },
        ]);
    });
});

describe('missing game data', () => {
    test('an item is bought when the recipe book is unavailable', () => {
        game.initClientData = null;

        const plan = computeBestCraftingPlan(BOOTS, 1);

        expect(plan.strategy).toBe('buy');
        expect(plan.unitCost).toBe(500);
    });
});
