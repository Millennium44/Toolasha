/**
 * Tests for the craft-arbitrage adapter.
 *
 * What is worth pinning here is the part a caller outside this bundle depends
 * on and cannot see: that `unitCost` is always the cost of *making* the thing
 * even when the plan would rather buy it, that per-unit figures stay per unit
 * when an action yields several, and that a material with no price fails the
 * item rather than costing it at zero.
 *
 * The plan calculator itself runs for real — it is the thing being adapted, and
 * mocking it would leave nothing under test. Its leaf collaborators (prices,
 * teas, action stats) are mocked, because each of them reads the live game.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    prices: {},
    data: null,
    stats: { actionTime: 10, totalEfficiency: 100 },
    artisanBonus: 0,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => game.data,
        getItemDetails: (itemHrid) => game.data?.itemDetailMap?.[itemHrid] ?? null,
        getEquipment: () => [],
        getSkills: () => [],
        getActionDrinkSlots: () => [],
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (itemHrid) => game.prices[itemHrid] ?? null,
}));

vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));

vi.mock('../../utils/tea-parser.js', () => ({
    parseArtisanBonus: () => game.artisanBonus,
    getDrinkConcentration: () => 0,
}));

vi.mock('../../utils/action-calculator.js', () => ({ calculateActionStats: () => game.stats }));

const { describeCraft, describeCrafts, isCraftable } = await import('./craft-arbitrage-adapter.js');

const MILK = '/items/milk';
const CHEESE = '/items/cheese';
const HAT = '/items/cheese_hat';

beforeEach(() => {
    game.stats = { actionTime: 10, totalEfficiency: 100 };
    game.artisanBonus = 0;
    game.prices = { [MILK]: 10, [CHEESE]: 100, [HAT]: 1000 };
    // A fresh object each time, so the adapter's index cache is invalidated the
    // same way a reload invalidates it
    game.data = {
        itemDetailMap: {
            [MILK]: { name: 'Milk', isTradable: true },
            [CHEESE]: { name: 'Cheese', isTradable: true },
            [HAT]: { name: 'Cheese Hat', isTradable: true },
        },
        actionDetailMap: {
            '/actions/cheesesmithing/cheese': {
                type: '/action_types/cheesesmithing',
                levelRequirement: { skillHrid: '/skills/cheesesmithing', level: 10 },
                inputItems: [{ itemHrid: MILK, count: 2 }],
                outputItems: [{ itemHrid: CHEESE, count: 1 }],
            },
            '/actions/crafting/cheese_hat': {
                type: '/action_types/crafting',
                levelRequirement: { skillHrid: '/skills/crafting', level: 25 },
                inputItems: [{ itemHrid: CHEESE, count: 3 }],
                outputItems: [{ itemHrid: HAT, count: 2 }],
            },
        },
    };
});

describe('describeCraft', () => {
    test('costs a unit out of its materials, and names the action behind it', () => {
        const craft = describeCraft(CHEESE);
        expect(craft).toMatchObject({
            itemHrid: CHEESE,
            unitCost: 20,
            strategy: 'craft',
            actionHrid: '/actions/cheesesmithing/cheese',
            actionsNeeded: 1,
            skillHrid: '/skills/cheesesmithing',
            requiredLevel: 10,
        });
        expect(craft.inputs).toEqual([{ itemHrid: MILK, quantityPerUnit: 2 }]);
    });

    test('reports the crafting cost even when buying is cheaper', () => {
        // This is the whole reason strategy is separate from unitCost: a caller
        // comparing a craft against the market needs the cost of making it, and
        // needs telling that making it is currently the worse of the two
        game.prices[CHEESE] = 5;
        expect(describeCraft(CHEESE)).toMatchObject({ unitCost: 20, strategy: 'buy' });
    });

    test('reported input quantities agree with the artisan-discounted cost, not the printed recipe', () => {
        // 2 milk per cheese, 10% artisan reduction → the plan costs cheese at
        // 2 × 0.9 × 10 = 18, so a caller checking "do I have enough milk" against
        // `inputs` must see 1.8, not the printed 2 — otherwise it demands milk the
        // craft will never actually consume.
        game.artisanBonus = 0.1;

        const craft = describeCraft(CHEESE);
        expect(craft.unitCost).toBeCloseTo(18, 10);
        expect(craft.inputs).toEqual([{ itemHrid: MILK, quantityPerUnit: 1.8 }]);
    });

    test('the upgrade item is not artisan-discounted in the reported inputs either', () => {
        game.data.actionDetailMap['/actions/crafting/cheese_hat'].upgradeItemHrid = MILK;
        game.artisanBonus = 0.5;

        const craft = describeCraft(HAT);
        // cheese input (3) is halved by the tea; the upgrade slot (milk) is not
        expect(craft.inputs).toEqual([
            { itemHrid: CHEESE, quantityPerUnit: 0.75 },
            { itemHrid: MILK, quantityPerUnit: 0.5 },
        ]);
    });

    test('an action that yields several divides everything by the yield', () => {
        // Three cheese at 20 makes two hats: 30 a hat, half an action each
        const craft = describeCraft(HAT);
        expect(craft).toMatchObject({ unitCost: 30, actionsNeeded: 0.5, requiredLevel: 25 });
        expect(craft.inputs).toEqual([{ itemHrid: CHEESE, quantityPerUnit: 1.5 }]);
    });

    test('skipProcessing buys processed intermediates instead of making them', () => {
        // Mark cheese as a material-conversion (processing) action. Left to
        // itself the planner crafts cheese at 20, so a hat is 3 × 20 / 2 = 30.
        game.data.actionDetailMap['/actions/cheesesmithing/cheese'].category =
            '/action_categories/cheesesmithing/material';
        expect(describeCraft(HAT).unitCost).toBe(30);

        // Directed to buy processed materials, cheese is bought at 100, so the
        // hat costs 3 × 100 / 2 = 150 — the "direct craft off bought materials".
        expect(describeCraft(HAT, { skipProcessing: true }).unitCost).toBe(150);
    });

    test('timeCostPerHour folds crafting time into the unit cost', () => {
        const free = describeCraft(CHEESE).unitCost;
        const timed = describeCraft(CHEESE, { timeCostPerHour: 3600 }).unitCost;
        expect(timed).toBeGreaterThan(free);
    });

    test('efficiency divides the time, and the yield divides it again', () => {
        // 10s at +100% efficiency is 5s an action, two hats an action
        expect(describeCraft(HAT).secondsPerUnit).toBeCloseTo(2.5, 9);
        game.stats = { actionTime: 10, totalEfficiency: 0 };
        expect(describeCraft(CHEESE).secondsPerUnit).toBeCloseTo(10, 9);
    });

    test('unreadable action stats cost the timing, not the row', () => {
        game.stats = null;
        const craft = describeCraft(CHEESE);
        expect(craft.unitCost).toBe(20);
        expect(craft.secondsPerUnit).toBeNull();
    });

    test('a material with no obtainable price fails the item rather than costing it at nothing', () => {
        game.prices = {};
        expect(describeCraft(CHEESE)).toBeNull();
    });

    test('an item with no recipe, and no item at all, are both nothing to say', () => {
        expect(describeCraft(MILK)).toBeNull();
        expect(describeCraft('/items/nonsense')).toBeNull();
        expect(describeCraft(null)).toBeNull();
    });

    test('nothing to read means nothing to report', () => {
        game.data = null;
        expect(describeCraft(CHEESE)).toBeNull();
        expect(isCraftable(CHEESE)).toBe(false);
    });
});

describe('describeCrafts', () => {
    test('costs a list in one pass, skipping what has no recipe', () => {
        const costed = describeCrafts([CHEESE, MILK, HAT, CHEESE]);
        expect([...costed.keys()]).toEqual([CHEESE, HAT]);
        expect(costed.get(HAT).unitCost).toBe(30);
    });

    test('the shared memo does not let one item decide another', () => {
        // The hat is reached both directly and as nobody's ingredient; costing
        // it in the same pass as the cheese must not change either answer
        const together = describeCrafts([HAT, CHEESE]);
        expect(together.get(CHEESE)).toMatchObject(describeCraft(CHEESE));
        expect(together.get(HAT)).toMatchObject(describeCraft(HAT));
    });

    test('an empty ask is an empty answer', () => {
        expect(describeCrafts([]).size).toBe(0);
        expect(describeCrafts(null).size).toBe(0);
    });
});

describe('isCraftable', () => {
    test('says which items have a recipe without costing any of them', () => {
        expect(isCraftable(CHEESE)).toBe(true);
        expect(isCraftable(MILK)).toBe(false);
        expect(isCraftable('')).toBe(false);
    });
});
