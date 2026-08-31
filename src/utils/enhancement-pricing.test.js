/**
 * The one enhancement pricing rule.
 *
 * These cases used to be pinned in `upgrade-advisor.test.js`, against that
 * module's own transcription of the rule. The rule now lives here and so do
 * they, because a rule tested only through one of its four callers is a rule
 * three callers can drift away from without anything going red.
 *
 * The sentinels below were both wrong in the same direction — downwards. A
 * missing market side reads as `null`, so a cross-fill guarded by `bid < 0`
 * never ran and a bid-only book fell through to production cost or the vendor
 * sell price, both far under what the material goes for.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const game = vi.hoisted(() => ({
    items: {},
    prices: {},
    actions: {},
    equipment: new Map(),
    drinks: [],
    buffVersion: 0,
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: game.items, actionDetailMap: game.actions }),
        getEquipment: () => new Map(game.equipment),
        getActionDrinkSlots: () => game.drinks,
        getBuffStateVersion: () => game.buffVersion,
    },
}));
vi.mock('../api/marketplace.js', () => ({ default: { on: () => {} } }));
vi.mock('./market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => game.prices[`${hrid}:${level}`] || null,
    getItemPrice: (hrid, { mode = 'ask' } = {}) => game.prices[`${hrid}:0`]?.[mode] || 0,
}));

const {
    getEnhancementMaterialPrice,
    perAttemptMaterialCost,
    getCheapestProtectionPrice,
    getProductionCost,
    TRAINEE_SHOP_PRICE,
} = await import('./enhancement-pricing.js');

beforeEach(() => {
    game.items = {
        '/items/enhance_mat': { name: 'Mat', sellPrice: 100 },
        '/items/mirror_of_protection': { name: 'Mirror' },
        '/items/fine_sword': { name: 'Fine Sword' },
    };
    game.prices = {};
    game.actions = {};
    game.equipment = new Map();
    game.drinks = [];
    // Monotonic across tests, never reset: the memo maps are module state and
    // survive between tests, so rewinding the version would revive their entries
    game.buffVersion++;
});

describe('getEnhancementMaterialPrice', () => {
    test('a bid-only book is priced at the bid, not at the vendor price', () => {
        // The game sends null for a side with no listing
        game.prices['/items/enhance_mat:0'] = { ask: null, bid: 90_000 };

        expect(getEnhancementMaterialPrice('/items/enhance_mat', 'ask')).toBe(90_000);
    });

    test('an ask-only book still uses the ask, on both sides', () => {
        game.prices['/items/enhance_mat:0'] = { ask: 90_000, bid: null };

        expect(getEnhancementMaterialPrice('/items/enhance_mat', 'ask')).toBe(90_000);
        expect(getEnhancementMaterialPrice('/items/enhance_mat', 'bid')).toBe(90_000);
    });

    test('a two-sided book uses the side it was asked for', () => {
        game.prices['/items/enhance_mat:0'] = { ask: 90_000, bid: 80_000 };

        expect(getEnhancementMaterialPrice('/items/enhance_mat', 'ask')).toBe(90_000);
        expect(getEnhancementMaterialPrice('/items/enhance_mat', 'bid')).toBe(80_000);
    });

    test('a book with neither side falls back to the vendor price', () => {
        game.prices['/items/enhance_mat:0'] = { ask: null, bid: null };

        // No recipe produces it here, so the production cost is 0 and the
        // vendor's 100 is all that is left
        expect(getEnhancementMaterialPrice('/items/enhance_mat', 'ask')).toBe(100);
    });

    test('production cost beats the vendor price when there is a recipe', () => {
        // A material of its own, because the production-cost memo is keyed on
        // the price-feed version rather than reset per test: another case's
        // "no recipe, so 0" would still be cached for a shared hrid
        game.items['/items/craft_mat'] = { name: 'Craft Mat', sellPrice: 100 };
        game.prices['/items/ore:0'] = { ask: 250, bid: 240 };
        game.items['/items/ore'] = { name: 'Ore' };
        game.actions['/actions/make_mat'] = {
            type: '/action_types/crafting',
            inputItems: [{ itemHrid: '/items/ore', count: 2 }],
            outputItems: [{ itemHrid: '/items/craft_mat', count: 1 }],
        };

        expect(getEnhancementMaterialPrice('/items/craft_mat', 'ask')).toBe(500);
    });

    test('coins are worth their face value and trainee charms the shop price', () => {
        expect(getEnhancementMaterialPrice('/items/coin')).toBe(1);
        expect(getEnhancementMaterialPrice('/items/trainee_task_charm')).toBe(TRAINEE_SHOP_PRICE);
        expect(TRAINEE_SHOP_PRICE).toBe(250_000);
    });

    test('nothing known at all is 0', () => {
        expect(getEnhancementMaterialPrice('/items/unknown')).toBe(0);
        expect(getEnhancementMaterialPrice(null)).toBe(0);
    });
});

describe('perAttemptMaterialCost', () => {
    test('sums the recipe at the ask side', () => {
        game.prices['/items/enhance_mat:0'] = { ask: 90_000, bid: 80_000 };

        expect(perAttemptMaterialCost({ enhancementCosts: [{ itemHrid: '/items/enhance_mat', count: 3 }] })).toEqual({
            cost: 270_000,
            hasCost: true,
            hasMissingPrices: false,
        });
    });

    test('an unpriced material is flagged, not silently dropped', () => {
        game.prices['/items/enhance_mat:0'] = { ask: 90_000, bid: 80_000 };

        const result = perAttemptMaterialCost({
            enhancementCosts: [
                { itemHrid: '/items/enhance_mat', count: 1 },
                { itemHrid: '/items/unknown', count: 1 },
            ],
        });

        // The priced part is kept — a partial bill is more use than none — but
        // the caller is told it is partial rather than being handed an under-quote
        expect(result).toEqual({ cost: 90_000, hasCost: true, hasMissingPrices: true });
    });

    test('an item with no recipe costs nothing per attempt and knows it', () => {
        expect(perAttemptMaterialCost({})).toEqual({ cost: 0, hasCost: false, hasMissingPrices: false });
    });

    test('a caller with its own price feed can supply it', () => {
        const result = perAttemptMaterialCost(
            { enhancementCosts: [{ itemHrid: '/items/enhance_mat', count: 2 }] },
            { priceMaterial: () => 5 }
        );

        expect(result.cost).toBe(10);
    });
});

describe('production-cost memo invalidation', () => {
    /** One recipe per test hrid: 2 ore at 250 ask = 500 with no buffs */
    function makeRecipe(matHrid, oreHrid) {
        game.items[matHrid] = { name: 'Memo Mat' };
        game.items[oreHrid] = { name: 'Memo Ore' };
        game.prices[`${oreHrid}:0`] = { ask: 250, bid: 240 };
        game.actions[`/actions/make_${matHrid.split('/').pop()}`] = {
            type: '/action_types/crafting',
            inputItems: [{ itemHrid: oreHrid, count: 2 }],
            outputItems: [{ itemHrid: matHrid, count: 1 }],
        };
    }

    const ARTISAN_TEA = {
        name: 'Artisan Tea',
        consumableDetail: { buffs: [{ typeHrid: '/buff_types/artisan', flatBoost: 0.1 }] },
    };

    test('the same query twice is served from the memo', () => {
        makeRecipe('/items/memo_mat', '/items/memo_ore');
        expect(getProductionCost('/items/memo_mat')).toBe(500);

        // Change the inputs behind the memo's back; neither the price feed nor
        // the buff state moved, so the stale figure is exactly what a memo serves
        game.prices['/items/memo_ore:0'] = { ask: 1_000, bid: 990 };
        expect(getProductionCost('/items/memo_mat')).toBe(500);
    });

    test('a drink change recomputes the fallback', () => {
        makeRecipe('/items/drink_mat', '/items/drink_ore');
        game.items['/items/artisan_tea'] = ARTISAN_TEA;
        expect(getProductionCost('/items/drink_mat')).toBe(500);

        // Drinking artisan tea bumps the buff version, so the memo misses and
        // the 10% material reduction reaches the figure
        game.drinks = [{ itemHrid: '/items/artisan_tea' }];
        game.buffVersion++;
        expect(getProductionCost('/items/drink_mat')).toBe(450);
    });

    test('a gear change recomputes the fallback', () => {
        makeRecipe('/items/gear_mat', '/items/gear_ore');
        game.items['/items/artisan_tea'] = ARTISAN_TEA;
        game.items['/items/conc_pouch'] = {
            name: 'Concentration Pouch',
            equipmentDetail: { noncombatStats: { drinkConcentration: 0.5 } },
        };
        game.drinks = [{ itemHrid: '/items/artisan_tea' }];
        expect(getProductionCost('/items/gear_mat')).toBe(450);

        // Equipping drink concentration scales the tea to 15%: 2 × 250 × 0.85
        game.equipment.set('/item_locations/pouch', { itemHrid: '/items/conc_pouch', enhancementLevel: 0 });
        game.buffVersion++;
        expect(getProductionCost('/items/gear_mat')).toBe(425);
    });
});

describe('getCheapestProtectionPrice', () => {
    beforeEach(() => {
        game.prices['/items/mirror_of_protection:0'] = { ask: 2_000_000, bid: 1_900_000 };
        game.prices['/items/fine_sword:0'] = { ask: 500_000, bid: 480_000 };
    });

    test('a second copy of the piece counts, and can be the cheapest', () => {
        expect(getCheapestProtectionPrice('/items/fine_sword')).toEqual({
            price: 500_000,
            itemHrid: '/items/fine_sword',
        });
    });

    test('includeSelf false leaves only the things you can actually buy', () => {
        // What the savings card needs: its targets are untradable gear, where
        // there is no second copy on the market at any price
        expect(getCheapestProtectionPrice('/items/fine_sword', { includeSelf: false })).toEqual({
            price: 2_000_000,
            itemHrid: '/items/mirror_of_protection',
        });
    });

    test('nothing priceable is null, not zero', () => {
        game.prices = {};

        // Zero read as a price makes protection free, and a free protection wins
        // every strategy comparison on a quote nobody has a basis for
        expect(getCheapestProtectionPrice('/items/fine_sword')).toEqual({ price: null, itemHrid: null });
    });
});
