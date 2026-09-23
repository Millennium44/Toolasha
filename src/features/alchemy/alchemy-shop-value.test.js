import { describe, it, expect, vi, beforeEach } from 'vitest';

const game = vi.hoisted(() => ({ initClientData: null, prices: {} }));

vi.mock('../../core/data-manager.js', () => ({
    default: { getInitClientData: () => game.initClientData },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => game.prices[hrid] ?? null,
}));

const { getAlchemyOutputShopValue, describeShopValue } = await import('./alchemy-shop-value.js');

describe('getAlchemyOutputShopValue', () => {
    beforeEach(() => {
        game.prices = {};
        game.initClientData = {
            labyrinthShopItemDetailMap: {
                shard: { itemHrid: '/items/labyrinth_refinement_shard', cost: { count: 1 }, outputCount: 1 },
                essence: { itemHrid: '/items/essence', cost: { count: 1 }, outputCount: 10 },
            },
            itemDetailMap: {
                '/items/labyrinth_refinement_shard': { name: 'Labyrinth Refinement Shard' },
                '/items/essence': { name: 'Essence' },
            },
        };
    });

    it('is null for any item other than the labyrinth token', () => {
        expect(getAlchemyOutputShopValue('/items/essence')).toBeNull();
    });

    it('prices the labyrinth token at the best shop conversion', () => {
        game.prices = { '/items/labyrinth_refinement_shard': 5500, '/items/essence': 100 };
        const result = getAlchemyOutputShopValue('/items/labyrinth_token');
        expect(result).toEqual({
            valuePerUnit: 5500,
            sourceItemHrid: '/items/labyrinth_refinement_shard',
            sourceItemName: 'Labyrinth Refinement Shard',
        });
    });

    it('picks the highest-value line, not the first one', () => {
        game.prices = { '/items/labyrinth_refinement_shard': 10, '/items/essence': 1000 };
        // Essence: 1000 * 10 / 1 = 10,000/token vs shard 10/token
        const result = getAlchemyOutputShopValue('/items/labyrinth_token');
        expect(result.sourceItemHrid).toBe('/items/essence');
        expect(result.valuePerUnit).toBe(10_000);
    });

    it('is null when nothing in the shop is priced', () => {
        expect(getAlchemyOutputShopValue('/items/labyrinth_token')).toBeNull();
    });

    it('is null without game data, never throws', () => {
        game.initClientData = null;
        expect(getAlchemyOutputShopValue('/items/labyrinth_token')).toBeNull();
    });
});

describe('describeShopValue', () => {
    it('names the conversion so the marker is never unexplained', () => {
        const text = describeShopValue(
            { valuePerUnit: 5500, sourceItemName: 'Labyrinth Refinement Shard' },
            (n) => `${n}g`
        );
        expect(text).toContain('5500g');
        expect(text).toContain('Labyrinth Refinement Shard');
        expect(text).not.toContain('undefined');
    });
});
