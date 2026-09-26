import { describe, expect, test, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            itemDetailMap: {
                '/items/pirate_essence': { name: 'Pirate Essence' },
                '/items/kraken_fang': { name: 'Kraken Fang' },
                '/items/mixed_a': { name: 'Mixed A' },
                '/items/mixed_b': { name: 'Mixed B' },
            },
            shopItemDetailMap: {
                a: {
                    itemHrid: '/items/pirate_essence',
                    outputCount: 10,
                    costs: [{ itemHrid: '/items/pirate_token', count: 1 }],
                },
                b: { itemHrid: '/items/kraken_fang', costs: [{ itemHrid: '/items/pirate_token', count: 3000 }] },
                // Token first, then another currency
                c: {
                    itemHrid: '/items/mixed_a',
                    costs: [
                        { itemHrid: '/items/pirate_token', count: 100 },
                        { itemHrid: '/items/coin', count: 1000 },
                    ],
                },
                // Token after another currency
                d: {
                    itemHrid: '/items/mixed_b',
                    costs: [
                        { itemHrid: '/items/coin', count: 1000 },
                        { itemHrid: '/items/pirate_token', count: 100 },
                    ],
                },
            },
        }),
    },
}));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrices: (hrid) =>
        ({ '/items/pirate_essence': { ask: 5 }, '/items/kraken_fang': { ask: 9000 } })[hrid] ?? null,
}));

const { dungeonShopOffers } = await import('./dungeon-shop-offers.js');

describe('dungeonShopOffers', () => {
    test('leaves out a line that also costs another currency, wherever the token sits', () => {
        const names = dungeonShopOffers('/items/pirate_token').map((offer) => offer.name);

        expect(names).toEqual(['Pirate Essence', 'Kraken Fang']);
    });

    test('carries a line that yields several units, valuing a purchase as all of them', () => {
        const essence = dungeonShopOffers('/items/pirate_token').find((offer) => offer.name === 'Pirate Essence');

        expect(essence.outputCount).toBe(10);
        expect(essence.askPrice).toBe(5);
        expect(essence.goldPerToken).toBe(50);
    });
});
