/**
 * The one enhancement input pricing rule, driven through the real resolver.
 *
 * The market feed, the custom overrides and the shop are faked; `resolveItemPrice`, the production
 * cost walk and the inflation guard are the real ones, so what these cases pin is the chain a
 * player's settings actually move: custom price, then the book on the profit mode's side, then the
 * shop floor, then craft cost, with trainee charms and coins settled first and the guard on top
 * for protection, the mirror and the base item.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const game = vi.hoisted(() => ({
    items: {},
    // hrid -> { ask, bid }; null or missing sides are unquoted
    books: {},
    custom: {},
    shop: {},
    actions: {},
    mode: 'hybrid',
    networthMode: 'ask',
    craftingSetting: false,
    customVersion: 0,
    buffVersion: 0,
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: game.items, actionDetailMap: game.actions }),
        getBuffStateVersion: () => game.buffVersion,
    },
}));
vi.mock('../core/config.js', () => ({
    default: { isFeatureEnabled: (key) => key === 'enhanceSim_baseItemCraftingCost' && game.craftingSetting },
}));
vi.mock('../api/marketplace.js', () => ({ default: { on: () => {} } }));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));
vi.mock('./ironcow-valuation.js', () => ({ isIronCowCharacter: () => false }));
vi.mock('../features/settings/custom-price-overrides.js', () => ({
    getCustomPrice: (hrid, _level, side) => game.custom[`${hrid}:${side}`] ?? null,
    getCustomPriceVersion: () => game.customVersion,
}));
vi.mock('./game-lookups.js', () => ({ getShopCoinCost: (hrid) => game.shop[hrid] || 0 }));
// profit-helpers reads the production cost through the tooltip module, which re-exports this one
vi.mock('../features/enhancement/tooltip-enhancement.js', async () => ({
    getProductionCost: (await import('./enhancement-pricing.js')).getProductionCost,
}));

/** The side a context reads: hybrid asks on both sides, optimistic bids when buying */
function modeOf(context, side) {
    if (context === 'networth') return game.networthMode;
    if (game.mode === 'optimistic') return side === 'buy' ? 'bid' : 'ask';
    return 'ask';
}

/** A one-sided book fills the other side, as the reconciled book does */
function reconciled(hrid) {
    const book = game.books[hrid];
    if (!book) return null;
    const ask = book.ask > 0 ? book.ask : book.bid > 0 ? book.bid : null;
    const bid = book.bid > 0 ? book.bid : ask;
    return ask === null ? null : { ask, bid };
}

vi.mock('./market-data.js', () => ({
    getPricingMode: (context, side) => modeOf(context, side),
    getItemPriceInfo: (hrid, { mode, context, side = 'sell' } = {}) => {
        const book = reconciled(hrid);
        if (!book) return { price: null, source: null, estimated: false };
        const picked = mode || modeOf(context, side);
        return { price: picked === 'bid' ? book.bid : book.ask, source: 'book', estimated: false };
    },
    // The raw sides: a missing one stays null, which is what the inflation guard reads as one-sided
    getItemPrices: (hrid) =>
        game.books[hrid] ? { ask: game.books[hrid].ask ?? null, bid: game.books[hrid].bid ?? null } : null,
    getItemPrice: (hrid, { mode = 'ask' } = {}) => reconciled(hrid)?.[mode] || 0,
}));

const { priceMaterial, priceProtection, priceMirror, priceBase, priceGuarded, perAttemptMaterialCost } =
    await import('./enhancement-input-pricing.js');
const { TRAINEE_SHOP_PRICE } = await import('./enhancement-pricing.js');

const SWORD = '/items/fine_sword';
const SHARD = '/items/shard';
const MIRROR = '/items/philosophers_mirror';
const PROTECTION = '/items/mirror_of_protection';
const PROTECT_ITEM = '/items/protect_stone';

beforeEach(() => {
    game.items = {
        [SWORD]: { name: 'Fine Sword', protectionItemHrids: [PROTECT_ITEM], enhancementCosts: [] },
        [SHARD]: { name: 'Shard' },
        [PROTECTION]: { name: 'Mirror of Protection' },
        [PROTECT_ITEM]: { name: 'Protect Stone' },
        [MIRROR]: { name: "Philosopher's Mirror" },
    };
    game.books = {};
    game.custom = {};
    game.shop = {};
    game.actions = {};
    game.mode = 'hybrid';
    game.networthMode = 'ask';
    game.craftingSetting = false;
    game.buffVersion++;
});

describe('priceMaterial', () => {
    test('a quoted material is the ask, a bid-only book is the bid', () => {
        game.books[SHARD] = { ask: 1000, bid: 900 };
        expect(priceMaterial(SHARD)).toMatchObject({ price: 1000, unpriced: false, estimated: false });
        game.books[SHARD] = { ask: null, bid: 900 };
        expect(priceMaterial(SHARD).price).toBe(900);
    });

    test('a wide book is not guarded: a material is a purchase, the ask is what it costs', () => {
        game.books[SHARD] = { ask: 2000, bid: 1000 };
        expect(priceMaterial(SHARD).price).toBe(2000);
    });

    test('a custom buy price wins over the book', () => {
        game.books[SHARD] = { ask: 1000, bid: 900 };
        game.custom[`${SHARD}:buy`] = 123;
        expect(priceMaterial(SHARD).price).toBe(123);
    });

    test('the bid profit mode (optimistic) prices at the bid; forcing a mode wins over it', () => {
        game.books[SHARD] = { ask: 1000, bid: 900 };
        game.mode = 'optimistic';
        expect(priceMaterial(SHARD).price).toBe(900);
        game.mode = 'hybrid';
        expect(priceMaterial(SHARD, { mode: 'bid' }).price).toBe(900);
    });

    test('a shop-sold material is capped at the shop price', () => {
        game.books[SHARD] = { ask: 5000, bid: 4000 };
        game.shop[SHARD] = 3000;
        expect(priceMaterial(SHARD).price).toBe(3000);
    });

    test('a craft-only material is priced from its recipe and flagged estimated', () => {
        game.books['/items/ore'] = { ask: 100, bid: 90 };
        game.items['/items/bar'] = { name: 'Bar' };
        game.actions['/actions/smelt'] = {
            type: '/action_types/smithing',
            inputItems: [{ itemHrid: '/items/ore', count: 3 }],
            outputItems: [{ itemHrid: '/items/bar', count: 1 }],
        };
        expect(priceMaterial('/items/bar')).toMatchObject({ price: 300, unpriced: false, estimated: true });
    });

    test('nothing prices it: null and flagged, never zero', () => {
        expect(priceMaterial(SHARD)).toMatchObject({ price: null, unpriced: true, estimated: false });
        expect(priceMaterial('')).toMatchObject({ price: null, unpriced: true, estimated: false });
    });

    test('trainee charms cost the shop price whatever the book, a mode or a custom price says', () => {
        game.books['/items/trainee_charm'] = { ask: 9, bid: 8 };
        game.mode = 'optimistic';
        expect(priceMaterial('/items/trainee_charm').price).toBe(TRAINEE_SHOP_PRICE);
        expect(priceMaterial('/items/trainee_charm', { context: 'networth' }).price).toBe(TRAINEE_SHOP_PRICE);
    });

    test('coins are worth their face value', () => {
        expect(priceMaterial('/items/coin').price).toBe(1);
    });

    test('the networth context reads the networth mode, not the profit mode', () => {
        game.books[SHARD] = { ask: 1000, bid: 900 };
        game.mode = 'optimistic';
        game.networthMode = 'ask';
        expect(priceMaterial(SHARD).price).toBe(900);
        expect(priceMaterial(SHARD, { context: 'networth' }).price).toBe(1000);
        game.networthMode = 'bid';
        expect(priceMaterial(SHARD, { context: 'networth' }).price).toBe(900);
    });
});

describe('the inflation guard on protection, the mirror and the base', () => {
    test('an ask more than 30% over the bid is read as the bid when nothing crafts it', () => {
        game.books[PROTECTION] = { ask: 200, bid: 100 };
        expect(priceGuarded(PROTECTION)).toMatchObject({ price: 100, unpriced: false, estimated: true });
    });

    test('an ask inflated over the craft cost is read as the craft cost', () => {
        game.books[PROTECT_ITEM] = { ask: 1000, bid: null };
        game.books['/items/stone'] = { ask: 400, bid: 400 };
        game.actions['/actions/make_stone'] = {
            type: '/action_types/crafting',
            inputItems: [{ itemHrid: '/items/stone', count: 1 }],
            outputItems: [{ itemHrid: PROTECT_ITEM, count: 1 }],
        };
        game.items['/items/stone'] = { name: 'Stone' };
        expect(priceGuarded(PROTECT_ITEM).price).toBe(400);
    });

    test('a normal book is the ask', () => {
        game.books[PROTECTION] = { ask: 120, bid: 100 };
        expect(priceGuarded(PROTECTION).price).toBe(120);
    });

    test('a custom price bypasses the guard', () => {
        game.books[PROTECTION] = { ask: 200, bid: 100 };
        game.custom[`${PROTECTION}:buy`] = 500;
        expect(priceGuarded(PROTECTION).price).toBe(500);
    });

    test('the bid mode is the player asking for the bid: the guard does not lift it', () => {
        game.books[PROTECTION] = { ask: 200, bid: 100 };
        game.books['/items/stone'] = { ask: 900, bid: 900 };
        game.mode = 'optimistic';
        expect(priceGuarded(PROTECTION).price).toBe(100);
    });

    test('a shop floor below the book is not weighed as an ask', () => {
        game.books[PROTECT_ITEM] = { ask: 200, bid: 100 };
        game.shop[PROTECT_ITEM] = 50;
        expect(priceGuarded(PROTECT_ITEM).price).toBe(50);
    });

    test('unpriced is null and flagged', () => {
        expect(priceMirror()).toMatchObject({ price: null, unpriced: true, estimated: false });
    });

    test('the mirror is the guarded price of the philosopher’s mirror', () => {
        game.books[MIRROR] = { ask: 300, bid: 100 };
        expect(priceMirror().price).toBe(100);
        game.books[MIRROR] = { ask: 300, bid: 290 };
        expect(priceMirror().price).toBe(300);
    });
});

describe('priceProtection', () => {
    test('the cheapest of the item itself, the mirror and the listed items, each guarded', () => {
        game.books[SWORD] = { ask: 5000, bid: 4900 };
        game.books[PROTECTION] = { ask: 900, bid: 800 };
        game.books[PROTECT_ITEM] = { ask: 600, bid: 100 }; // guard: 600/100 > 1.3, so 100
        expect(priceProtection(SWORD)).toMatchObject({
            price: 100,
            itemHrid: PROTECT_ITEM,
            unpriced: false,
            estimated: true,
        });
    });

    test('includeSelf: false leaves the second copy of the piece out', () => {
        game.books[SWORD] = { ask: 50, bid: 49 };
        game.books[PROTECTION] = { ask: 900, bid: 800 };
        expect(priceProtection(SWORD).itemHrid).toBe(SWORD);
        expect(priceProtection(SWORD, { includeSelf: false }).itemHrid).toBe(PROTECTION);
    });

    test('a custom price on one option wins the min', () => {
        game.books[PROTECTION] = { ask: 900, bid: 800 };
        game.custom[`${PROTECT_ITEM}:buy`] = 10;
        expect(priceProtection(SWORD).price).toBe(10);
    });

    test('bid profit mode: every option at its bid', () => {
        game.books[PROTECTION] = { ask: 900, bid: 800 };
        game.mode = 'optimistic';
        expect(priceProtection(SWORD).price).toBe(800);
    });

    test('nothing priced: null, flagged, no item', () => {
        expect(priceProtection(SWORD)).toMatchObject({ price: null, itemHrid: null, unpriced: true, estimated: false });
    });
});

describe('priceBase', () => {
    test('with the crafting setting off it is the guarded price', () => {
        game.books[SWORD] = { ask: 200, bid: 100 };
        expect(priceBase(SWORD)).toMatchObject({ price: 100, crafted: false });
    });

    test('with it on, the cheaper of the craft cost and the guarded price', () => {
        game.books[SWORD] = { ask: 1000, bid: 950 };
        game.books['/items/ore'] = { ask: 100, bid: 100 };
        game.items['/items/ore'] = { name: 'Ore' };
        game.actions['/actions/forge'] = {
            type: '/action_types/smithing',
            inputItems: [{ itemHrid: '/items/ore', count: 4 }],
            outputItems: [{ itemHrid: SWORD, count: 1 }],
        };
        game.craftingSetting = true;
        expect(priceBase(SWORD)).toMatchObject({ price: 400, crafted: true });
        game.books[SWORD] = { ask: 300, bid: 290 };
        expect(priceBase(SWORD)).toMatchObject({ price: 300, crafted: false });
    });

    test('with it on and no listing, the craft cost stands in', () => {
        game.books['/items/ore'] = { ask: 100, bid: 100 };
        game.items['/items/ore'] = { name: 'Ore' };
        game.actions['/actions/forge'] = {
            type: '/action_types/smithing',
            inputItems: [{ itemHrid: '/items/ore', count: 4 }],
            outputItems: [{ itemHrid: SWORD, count: 1 }],
        };
        game.craftingSetting = true;
        expect(priceBase(SWORD).price).toBe(400);
        game.craftingSetting = false;
        // The resolver's own craft-cost fallback prices it the same when there is no listing at all
        expect(priceBase(SWORD).price).toBe(400);
    });

    test('unpriced is null and flagged', () => {
        expect(priceBase(SWORD)).toMatchObject({ price: null, unpriced: true });
    });
});

describe('perAttemptMaterialCost with the shared rule', () => {
    test('sums the shared material price and flags what nothing prices', () => {
        game.books[SHARD] = { ask: 1000, bid: 900 };
        const details = {
            enhancementCosts: [
                { itemHrid: SHARD, count: 3 },
                { itemHrid: '/items/trainee_charm', count: 1 },
                { itemHrid: '/items/coin', count: 10 },
                { itemHrid: '/items/mystery', count: 2 },
            ],
        };
        expect(perAttemptMaterialCost(details)).toEqual({
            cost: 3000 + TRAINEE_SHOP_PRICE + 10,
            hasCost: true,
            hasMissingPrices: true,
        });
    });
});

describe('every entry point reads one number per input', () => {
    // The tooltip, the XP/h table, the advisor, the savings row, the goal planner, the loot log and the
    // risk-of-ruin adapter all reach these three drop-ins; the panel and the tracker reach the
    // price* functions. Same fixture, same answer, whichever door.
    const doors = async () => ({
        ...(await import('./enhancement-input-pricing.js')),
    });

    const fixtures = {
        'bid-only book': () => {
            game.books[SHARD] = { ask: null, bid: 900 };
            game.books[PROTECTION] = { ask: null, bid: 700 };
        },
        'ask/bid over 1.3 (guard fires)': () => {
            game.books[SHARD] = { ask: 2000, bid: 1000 };
            game.books[PROTECTION] = { ask: 2000, bid: 1000 };
        },
        'a custom price': () => {
            game.books[SHARD] = { ask: 2000, bid: 1000 };
            game.books[PROTECTION] = { ask: 2000, bid: 1000 };
            game.custom[`${SHARD}:buy`] = 77;
            game.custom[`${PROTECTION}:buy`] = 88;
        },
        'bid profit mode': () => {
            game.books[SHARD] = { ask: 2000, bid: 1000 };
            game.books[PROTECTION] = { ask: 2000, bid: 1000 };
            game.mode = 'optimistic';
        },
        'shop-sold material': () => {
            game.books[SHARD] = { ask: 2000, bid: 1900 };
            game.shop[SHARD] = 1500;
        },
        'unpriced protection': () => {
            game.books[SHARD] = { ask: 2000, bid: 1900 };
        },
        'trainee charm': () => {
            game.books['/items/trainee_charm'] = { ask: 5, bid: 4 };
        },
    };

    for (const [name, arrange] of Object.entries(fixtures)) {
        test(name, async () => {
            arrange();
            const m = await doors();
            const material = name === 'trainee charm' ? '/items/trainee_charm' : SHARD;
            // The drop-in names its side, so it is the rule forced to the ask whatever the profit mode says
            expect(m.getEnhancementMaterialPrice(material)).toBe(m.priceMaterial(material, { mode: 'ask' }).price || 0);
            expect(m.getEnhancementMaterialPrice(material, 'bid')).toBe(
                m.priceMaterial(material, { mode: 'bid' }).price || 0
            );
            expect(m.perAttemptMaterialCost({ enhancementCosts: [{ itemHrid: material, count: 2 }] }).cost).toBe(
                2 * (m.priceMaterial(material).price || 0)
            );
            expect(m.getRealisticBaseItemPrice(PROTECTION)).toBe(m.priceGuarded(PROTECTION).price || 0);
            const protection = m.priceProtection(SWORD, { includeSelf: false });
            expect(m.getCheapestProtectionPrice(SWORD, { includeSelf: false })).toEqual({
                price: protection.price,
                itemHrid: protection.itemHrid,
            });
            // Unpriced is null and flagged on every door that can say so
            expect(protection.unpriced).toBe(protection.price === null);
        });
    }

    test('the unpriced protection fixture is unpriced on every door', async () => {
        fixtures['unpriced protection']();
        const m = await doors();
        expect(m.priceProtection(SWORD).unpriced).toBe(true);
        expect(m.getCheapestProtectionPrice(SWORD).price).toBeNull();
        expect(m.getRealisticBaseItemPrice(PROTECTION)).toBe(0);
    });
});

describe('a custom price wins absolutely', () => {
    const arrangeCraftable = () => {
        game.books['/items/ore'] = { ask: 100, bid: 100 };
        game.items['/items/ore'] = { name: 'Ore' };
        game.actions['/actions/forge'] = {
            type: '/action_types/smithing',
            inputItems: [{ itemHrid: '/items/ore', count: 1 }],
            outputItems: [{ itemHrid: SWORD, count: 1 }],
        };
        game.craftingSetting = true;
    };

    test('the craft cost competes with market quotes, never with a custom base price', () => {
        arrangeCraftable();
        game.books[SWORD] = { ask: 1000, bid: 950 };
        expect(priceBase(SWORD)).toMatchObject({ price: 100, crafted: true });
        game.custom[`${SWORD}:buy`] = 500;
        expect(priceBase(SWORD)).toMatchObject({ price: 500, crafted: false, custom: true });
    });

    test('a custom price of zero or less reads as unpriced', () => {
        game.books[SHARD] = { ask: 1000, bid: 900 };
        game.custom[`${SHARD}:buy`] = 0;
        expect(priceMaterial(SHARD)).toMatchObject({ price: null, unpriced: true });
    });
});

describe('+0 follows the base rule', () => {
    test('an enhanced copy at +0 is the base item, crafting setting included; above +0 it is a quote', async () => {
        const { priceAtLevel } = await import('./enhancement-input-pricing.js');
        game.books['/items/ore'] = { ask: 100, bid: 100 };
        game.items['/items/ore'] = { name: 'Ore' };
        game.actions['/actions/forge'] = {
            type: '/action_types/smithing',
            inputItems: [{ itemHrid: '/items/ore', count: 1 }],
            outputItems: [{ itemHrid: SWORD, count: 1 }],
        };
        game.books[SWORD] = { ask: 1000, bid: 950 };
        game.craftingSetting = true;
        expect(priceAtLevel(SWORD, 0).price).toBe(priceBase(SWORD).price);
        expect(priceAtLevel(SWORD, 0).price).toBe(100);
    });
});

describe('drop-ins keep the side they are given', () => {
    test('getEnhancementMaterialPrice(hrid, side) is the rule forced to that side under a bid profit mode', async () => {
        const { getEnhancementMaterialPrice } = await import('./enhancement-input-pricing.js');
        game.books[SHARD] = { ask: 1000, bid: 900 };
        game.mode = 'optimistic';
        expect(getEnhancementMaterialPrice(SHARD, 'ask')).toBe(1000);
        expect(getEnhancementMaterialPrice(SHARD, 'bid')).toBe(900);
        expect(priceMaterial(SHARD).price).toBe(900);
    });

    test('perAttemptMaterialCost and the protection drop-in take a forced mode', async () => {
        const { getCheapestProtectionPrice } = await import('./enhancement-input-pricing.js');
        game.books[SHARD] = { ask: 1000, bid: 900 };
        game.books[PROTECTION] = { ask: 900, bid: 800 };
        game.mode = 'optimistic';
        const details = { enhancementCosts: [{ itemHrid: SHARD, count: 2 }] };
        expect(perAttemptMaterialCost(details).cost).toBe(1800);
        expect(perAttemptMaterialCost(details, { mode: 'ask' }).cost).toBe(2000);
        expect(getCheapestProtectionPrice(SWORD).price).toBe(800);
        expect(getCheapestProtectionPrice(SWORD, { mode: 'ask' }).price).toBe(900);
    });
});

describe('pricingStamp', () => {
    test('moves with the profit mode, the net-worth mode, the crafting setting and the custom prices', async () => {
        const { pricingStamp } = await import('./enhancement-input-pricing.js');
        const base = pricingStamp();
        game.customVersion++;
        const afterCustom = pricingStamp();
        expect(afterCustom).not.toBe(base);
        game.craftingSetting = true;
        expect(pricingStamp()).not.toBe(afterCustom);
    });
});

describe('partial: a craft cost that skipped an unpriced input', () => {
    const craftable = (out, withDust) => {
        game.books['/items/ore'] = { ask: 100, bid: 100 };
        game.items['/items/ore'] = { name: 'Ore' };
        game.items['/items/dust'] = { name: 'Dust' };
        if (withDust) game.books['/items/dust'] = { ask: 10, bid: 10 };
        game.actions['/actions/make'] = {
            type: '/action_types/crafting',
            inputItems: [
                { itemHrid: '/items/ore', count: 1 },
                { itemHrid: '/items/dust', count: 1 },
            ],
            outputItems: [{ itemHrid: out, count: 1 }],
        };
    };

    test('a crafted material, protection item and base carry the flag; a quoted one does not', () => {
        craftable(SHARD, false);
        expect(priceMaterial(SHARD)).toMatchObject({ estimated: true, partial: true });
        game.books[SHARD] = { ask: 5, bid: 4 };
        expect(priceMaterial(SHARD).partial).toBe(false);
    });

    test('the chosen crafted base is partial, a bought one is not, and a custom one never is', () => {
        craftable(SWORD, false);
        game.craftingSetting = true;
        game.books[SWORD] = { ask: 1000, bid: 950 };
        expect(priceBase(SWORD)).toMatchObject({ crafted: true, partial: true });
        game.books[SWORD] = { ask: 50, bid: 49 };
        expect(priceBase(SWORD)).toMatchObject({ crafted: false, partial: false });
        game.books[SWORD] = { ask: 1000, bid: 950 };
        game.custom[`${SWORD}:buy`] = 500;
        expect(priceBase(SWORD).partial).toBe(false);
    });

    test('a priced protection item is partial only when its own price is a partial bill', () => {
        craftable(PROTECTION, false);
        expect(priceProtection(SWORD).partial).toBe(true);
        craftable(PROTECTION, true);
        game.buffVersion++;
        expect(priceProtection(SWORD).partial).toBe(false);
    });
});
