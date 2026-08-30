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

const game = vi.hoisted(() => ({ items: {}, prices: {}, actions: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: game.items, actionDetailMap: game.actions }),
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
    },
}));
vi.mock('../api/marketplace.js', () => ({ default: { on: () => {} } }));
vi.mock('./market-data.js', () => ({
    getItemPrices: (hrid, level = 0) => game.prices[`${hrid}:${level}`] || null,
    getItemPrice: (hrid, { mode = 'ask' } = {}) => game.prices[`${hrid}:0`]?.[mode] || 0,
}));

const { getEnhancementMaterialPrice, perAttemptMaterialCost, getCheapestProtectionPrice, TRAINEE_SHOP_PRICE } =
    await import('./enhancement-pricing.js');

beforeEach(() => {
    game.items = {
        '/items/enhance_mat': { name: 'Mat', sellPrice: 100 },
        '/items/mirror_of_protection': { name: 'Mirror' },
        '/items/fine_sword': { name: 'Fine Sword' },
    };
    game.prices = {};
    game.actions = {};
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
