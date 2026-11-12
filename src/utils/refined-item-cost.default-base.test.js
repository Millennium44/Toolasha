/**
 * The base item a refinement upgrades is bought on the player's Buy side by default, the same side the
 * materials beside it are: not a pinned ask.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const CAPE_HRID = '/items/test_cape_refined';
const BASE_HRID = '/items/test_cape';
const SHARD_HRID = '/items/test_shard';

const world = vi.hoisted(() => ({ lookups: [], book: { ask: 1000, bid: 700 }, mode: 'conservative' }));

vi.mock('../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (key, fallback) => fallback },
}));

vi.mock('./market-data.js', () => ({
    getItemPrice: () => null,
    // An explicit mode names a book side; otherwise the profit pricing mode picks it for the Buy side
    getItemPriceInfo: (hrid, options = {}) => {
        world.lookups.push({ hrid, ...options });
        const side = options.mode ?? (['optimistic', 'patientBuy'].includes(world.mode) ? 'bid' : 'ask');
        return { price: world.book[side], source: 'book', estimated: false };
    },
    getPricingMode: () => 'ask',
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

beforeEach(() => {
    world.lookups = [];
    world.mode = 'conservative';
});

describe('the default price of a refinement base', () => {
    test('names no book side of its own: the profit mode picks it', () => {
        computeRefinementCraftCost(CAPE_HRID, { priceMaterial: () => 100 });

        const lookup = world.lookups.find((entry) => entry.hrid === BASE_HRID);
        expect(lookup).toMatchObject({ side: 'buy', context: 'profit' });
        expect(lookup.mode).toBeUndefined();
    });

    test('is the ask for an instant buyer and the bid for a patient one', () => {
        world.mode = 'conservative';
        expect(computeRefinementCraftCost(CAPE_HRID, { priceMaterial: () => 100 }).cost).toBe(10 * 100 + 1000);
        world.mode = 'optimistic';
        expect(computeRefinementCraftCost(CAPE_HRID, { priceMaterial: () => 100 }).cost).toBe(10 * 100 + 700);
    });
});
