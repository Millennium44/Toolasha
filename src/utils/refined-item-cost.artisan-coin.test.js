/**
 * Artisan Tea reduces a recipe's coin fee as well as its materials (measured live on the test
 * server), and the profit calculator already reduces every input row. The refinement craft
 * cost must agree with it.
 */

import { describe, test, expect, vi } from 'vitest';

const CAPE_HRID = '/items/gatherer_cape_refined';
const SHARD_HRID = '/items/labyrinth_refinement_shard';

vi.mock('../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));

vi.mock('./market-data.js', () => ({
    getItemPrice: () => 1000,
    getItemPriceInfo: () => ({ price: 1000, source: 'book', estimated: false }),
    getPricingMode: () => 'ask',
}));

vi.mock('./material-calculator.js', () => ({ calculateArtisanBonus: () => 0.1 }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
        getInitClientData: () => ({
            itemDetailMap: {
                [CAPE_HRID]: { name: 'Gatherer Cape ★', isTradable: false },
                [SHARD_HRID]: { name: 'Shard' },
            },
            actionDetailMap: {
                '/actions/refine_cape': {
                    type: '/action_types/enhancing',
                    outputItems: [{ itemHrid: CAPE_HRID }],
                    inputItems: [
                        { itemHrid: '/items/coin', count: 10_000 },
                        { itemHrid: SHARD_HRID, count: 100 },
                    ],
                },
            },
        }),
    },
}));

const { computeRefinementCraftCost } = await import('./refined-item-cost.js');

describe('refinement craft cost with Artisan Tea', () => {
    test('the coin fee is reduced like the materials', () => {
        const result = computeRefinementCraftCost(CAPE_HRID, { priceMaterial: () => 1000 });

        // 10,000 coins and 100 shards at 1,000, both at 90%
        expect(result.cost).toBeCloseTo(9_000 + 90_000, 6);
        expect(result.lines[0]).toContain('9');
        expect(result.items).toEqual([{ itemHrid: SHARD_HRID, count: 90 }]);
    });
});
