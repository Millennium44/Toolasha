import { describe, test, expect } from 'vitest';
import { labyrinthTokenValue, labyrinthRewardValue, shopPurchasePrice } from './token-valuation.js';

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
