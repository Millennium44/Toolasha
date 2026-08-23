import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ initClientData: null, settings: {}, prices: {} }));

vi.mock('../core/data-manager.js', () => ({
    default: { getInitClientData: () => game.initClientData },
}));
vi.mock('../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => game.settings[key] ?? fallback },
}));
// Prices go through getItemPrice, so a user's custom overrides count — reading the raw
// order book (which the dungeon token valuation used to do) skips them entirely
vi.mock('./market-data.js', () => ({
    getItemPrice: (hrid, { mode } = {}) => game.prices[hrid]?.[mode] ?? null,
}));

const { labyrinthTokenValue, labyrinthRewardValue, shopPurchasePrice, calculateDungeonTokenValue } =
    await import('./token-valuation.js');

/**
 * A shop where an essence is the best conversion and a scroll is the reward
 * nobody can sell — which is the case that matters, since an unsellable reward
 * is exactly what a market-only reading drops on the floor.
 */
const shopMap = {
    essence: { itemHrid: '/items/essence', cost: { count: 1 }, outputCount: 10 },
    cheese: { itemHrid: '/items/cheese', cost: { count: 1 }, outputCount: 1 },
    scroll: { itemHrid: '/items/seal_of_damage', cost: { count: 30 }, outputCount: 1 },
};

const priceOf = (hrid) => ({ '/items/essence': 1000, '/items/cheese': 500 })[hrid] ?? null;

describe('labyrinthTokenValue', () => {
    test('the best conversion the shop offers', () => {
        // Ten essences at 1,000 for one token beats one cheese at 500
        expect(labyrinthTokenValue(shopMap, priceOf)).toBe(10_000);
    });

    test('an unsellable shop line cannot set the price', () => {
        // Otherwise a token prices at nothing and every reward follows it down
        expect(labyrinthTokenValue({ scroll: shopMap.scroll }, priceOf)).toBe(0);
    });

    test('nothing priced is nothing rather than a crash', () => {
        expect(labyrinthTokenValue({}, priceOf)).toBe(0);
        expect(labyrinthTokenValue(null, priceOf)).toBe(0);
    });
});

describe('labyrinthRewardValue', () => {
    test('a scroll is worth the tokens it costs', () => {
        // 30 tokens at 10,000 each
        expect(labyrinthRewardValue('/items/seal_of_damage', shopMap, priceOf)).toBe(300_000);
    });

    test('a line that hands over several splits the cost between them', () => {
        expect(labyrinthRewardValue('/items/essence', shopMap, priceOf)).toBe(1000);
    });

    test('something the labyrinth does not sell is not a labyrinth reward', () => {
        expect(labyrinthRewardValue('/items/cheese_sword', shopMap, priceOf)).toBeNull();
    });

    test('an unpriced shop leaves the reward unvalued rather than free', () => {
        expect(labyrinthRewardValue('/items/seal_of_damage', shopMap, () => null)).toBeNull();
    });
});

describe('shopPurchasePrice', () => {
    // A cape is never listed. It drops, or it is bought for tokens — so the
    // shop is the only thing that can price one.
    const shop = {
        cape: { itemHrid: '/items/cape', costs: [{ itemHrid: '/items/token', count: 10 }] },
        sword: { itemHrid: '/items/sword', costs: [{ itemHrid: '/items/token', count: 20 }] },
    };
    const priceOf = (hrid) => ({ '/items/sword': 100_000_000 })[hrid] || 0;

    test('a token is worth the best line in its own shop', () => {
        // 100M over 20 tokens is 5M each, so ten of them is 50M
        expect(shopPurchasePrice('/items/cape', [shop], priceOf)).toBe(50_000_000);
    });

    test('coins are counted at face value', () => {
        const coinShop = { thing: { itemHrid: '/items/thing', costs: [{ itemHrid: '/items/coin', count: 250_000 }] } };
        expect(shopPurchasePrice('/items/thing', [coinShop], priceOf)).toBe(250_000);
    });

    test('a line that buys several splits the price between them', () => {
        const bulk = {
            pack: { itemHrid: '/items/thing', outputCount: 5, costs: [{ itemHrid: '/items/coin', count: 500 }] },
        };
        expect(shopPurchasePrice('/items/thing', [bulk], priceOf)).toBe(100);
    });

    test('the labyrinth shop spells its cost differently and is still read', () => {
        const labyrinth = {
            scroll: { itemHrid: '/items/scroll', cost: { itemHrid: '/items/coin', count: 900 } },
        };
        expect(shopPurchasePrice('/items/scroll', [labyrinth], priceOf)).toBe(900);
    });

    test('a currency nothing prices makes the line unpriced rather than free', () => {
        const orphan = { cape: { itemHrid: '/items/cape', costs: [{ itemHrid: '/items/token', count: 10 }] } };
        expect(shopPurchasePrice('/items/cape', [orphan], priceOf)).toBeNull();
    });

    test('nothing sells it', () => {
        expect(shopPurchasePrice('/items/nowhere', [shop], priceOf)).toBeNull();
    });
});

describe('calculateDungeonTokenValue', () => {
    const TOKEN = '/items/chimerical_token';

    beforeEach(() => {
        game.settings = {};
        game.prices = {
            '/items/cape': { ask: 1000, bid: 900 },
            '/items/chimerical_essence': { ask: 200, bid: 180 },
        };
        game.initClientData = {
            shopItemDetailMap: {
                cape: { itemHrid: '/items/cape', costs: [{ itemHrid: TOKEN, count: 10 }] },
            },
        };
    });

    test('a token is worth the best line its own shop offers', () => {
        // Conservative is the default, so the bid: 900 / 10
        expect(calculateDungeonTokenValue(TOKEN)).toBe(90);
    });

    test('the token cost is found wherever it sits in the costs array', () => {
        // It used to be read from costs[0] only, so a line that listed coins first was
        // priced as though its first cost were the token
        game.initClientData.shopItemDetailMap.cape.costs = [{ itemHrid: TOKEN, count: 10 }];
        expect(calculateDungeonTokenValue(TOKEN)).toBe(90);

        game.initClientData.shopItemDetailMap.cape.costs = [
            { itemHrid: '/items/other_token', count: 3 },
            { itemHrid: TOKEN, count: 10 },
        ];
        // Two currencies say nothing clean about what one token alone is worth, so the
        // line is skipped and the essence fallback speaks instead
        expect(calculateDungeonTokenValue(TOKEN)).toBe(180);
    });

    test('a line that hands over several is counted as several', () => {
        game.initClientData.shopItemDetailMap.cape.outputCount = 3;
        expect(calculateDungeonTokenValue(TOKEN)).toBe(270); // 3 × 900 / 10
    });

    test('the pricing mode picks the side, and respecting it can be turned off', () => {
        game.settings.profitCalc_pricingMode = 'hybrid';
        expect(calculateDungeonTokenValue(TOKEN)).toBe(100); // ask: 1000 / 10

        game.settings.expectedValue_respectPricingMode = false;
        expect(calculateDungeonTokenValue(TOKEN)).toBe(90); // back to the bid
    });

    test('nothing priceable in the shop falls back to the essence', () => {
        game.prices['/items/cape'] = { ask: 0, bid: 0 };
        expect(calculateDungeonTokenValue(TOKEN)).toBe(180);
    });

    test('nothing priceable at all is null rather than zero', () => {
        game.prices = {};
        expect(calculateDungeonTokenValue(TOKEN)).toBeNull();
    });

    test('no game data is null', () => {
        game.initClientData = null;
        expect(calculateDungeonTokenValue(TOKEN)).toBeNull();
    });
});
