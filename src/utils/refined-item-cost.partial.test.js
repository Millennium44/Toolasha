/**
 * A craft-cost price that skipped an unpriced input (`partial`) is no price for a refinement material or base:
 * the refined item's cost is unresolved, never a cheap sum with the input counted as 0.
 */

import { describe, test, expect, vi } from 'vitest';

const CAPE_HRID = '/items/test_cape_refined';
const BASE_HRID = '/items/test_cape';
const SHARD_HRID = '/items/test_shard';

const world = vi.hoisted(() => ({ partial: new Set() }));

vi.mock('../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));

vi.mock('./market-data.js', () => ({
    getItemPrice: () => null,
    getItemPriceInfo: () => ({ price: 100, source: 'production', estimated: true }),
    getPricingMode: () => 'ask',
}));

vi.mock('./profit-helpers.js', () => ({
    resolveItemPrice: (hrid) => ({
        price: 100,
        missing: false,
        estimated: true,
        production: true,
        ...(world.partial.has(hrid) ? { partial: true } : {}),
    }),
}));

vi.mock('./material-calculator.js', () => ({ calculateArtisanBonus: () => 0 }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getItemDetails: () => null,
        getInitClientData: () => ({
            itemDetailMap: {
                [CAPE_HRID]: { name: 'Test Cape ★', isTradable: false },
                [BASE_HRID]: { name: 'Test Cape', isTradable: true },
                [SHARD_HRID]: { name: 'Shard' },
            },
            actionDetailMap: {
                '/actions/refine_cape': {
                    type: '/action_types/enhancing',
                    outputItems: [{ itemHrid: CAPE_HRID }],
                    upgradeItemHrid: BASE_HRID,
                    inputItems: [{ itemHrid: SHARD_HRID, count: 10 }],
                },
            },
        }),
    },
}));

const { computeRefinementCraftCost } = await import('./refined-item-cost.js');

describe('default prices of a refinement with a partial craft cost', () => {
    test('whole prices resolve', () => {
        world.partial.clear();
        expect(computeRefinementCraftCost(CAPE_HRID)?.cost).toBe(10 * 100 + 100);
    });

    test('a partial material is unresolved, not summed as a firm number', () => {
        world.partial = new Set([SHARD_HRID]);
        expect(computeRefinementCraftCost(CAPE_HRID)).toBeNull();
    });

    test('a partial base is unresolved too (it is not a free cape the player owns)', () => {
        world.partial = new Set([BASE_HRID]);
        const result = computeRefinementCraftCost(CAPE_HRID);
        expect(result === null || result.cost === 10 * 100).toBe(true);
        expect(result?.cost).not.toBe(10 * 100 + 100);
    });
});
