/**
 * Tests for Game Data Lookup Utilities
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
    },
}));

const { getActionHridFromName, getItemHridFromName, getShopCoinCost } = await import('./game-lookups.js');

describe('getActionHridFromName', () => {
    beforeEach(() => {
        state.gameData = {
            actionDetailMap: {
                '/actions/foraging/carrot': { name: 'Carrot' },
                '/actions/crafting/star_fragment': { name: 'Star Fragment ★' },
            },
        };
    });

    test('returns null without game data', () => {
        state.gameData = null;
        expect(getActionHridFromName('Carrot')).toBeNull();
    });

    test('finds an exact match', () => {
        expect(getActionHridFromName('Carrot')).toBe('/actions/foraging/carrot');
    });

    test('returns null when nothing matches', () => {
        expect(getActionHridFromName('Nonexistent')).toBeNull();
    });

    test('resolves the (R) variant to a ★ display name', () => {
        expect(getActionHridFromName('Star Fragment (R)')).toBe('/actions/crafting/star_fragment');
    });
});

describe('getItemHridFromName', () => {
    beforeEach(() => {
        state.gameData = {
            itemDetailMap: {
                '/items/plank': { name: 'Plank' },
                '/items/refined_bar': { name: 'Refined Bar (R)' },
            },
        };
    });

    test('returns null without game data', () => {
        state.gameData = null;
        expect(getItemHridFromName('Plank')).toBeNull();
    });

    test('finds an exact match', () => {
        expect(getItemHridFromName('Plank')).toBe('/items/plank');
    });

    test('resolves the ★ variant to a (R) display name', () => {
        expect(getItemHridFromName('Refined Bar ★')).toBe('/items/refined_bar');
    });

    test('returns null when no exact or variant match exists', () => {
        expect(getItemHridFromName('Nothing Here')).toBeNull();
    });
});

describe('getShopCoinCost', () => {
    beforeEach(() => {
        state.gameData = {
            shopItemDetailMap: {
                '/shop_items/bag': {
                    itemHrid: '/items/bag',
                    costs: [{ itemHrid: '/items/coin', count: 500 }],
                },
                '/shop_items/token_only': {
                    itemHrid: '/items/token_item',
                    costs: [{ itemHrid: '/items/task_token', count: 3 }],
                },
            },
        };
    });

    test('returns 0 without game data', () => {
        state.gameData = null;
        expect(getShopCoinCost('/items/bag')).toBe(0);
    });

    test('returns the coin cost for a shop item purchasable with coins', () => {
        expect(getShopCoinCost('/items/bag')).toBe(500);
    });

    test('returns 0 for an item not in the shop', () => {
        expect(getShopCoinCost('/items/unknown')).toBe(0);
    });

    test('returns 0 for a shop item not purchasable with coins', () => {
        expect(getShopCoinCost('/items/token_item')).toBe(0);
    });
});

describe('name lookups are memoised per detail map', () => {
    test('the first hrid in map order wins a shared display name', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/first_plank': { name: 'Plank' },
                '/items/second_plank': { name: 'Plank' },
            },
        };
        expect(getItemHridFromName('Plank')).toBe('/items/first_plank');
    });

    test('an exact match beats a refined-name variant wherever it sits in the map', () => {
        state.gameData = {
            itemDetailMap: {
                '/items/star_variant': { name: 'Bar ★' },
                '/items/exact': { name: 'Bar (R)' },
            },
        };
        expect(getItemHridFromName('Bar (R)')).toBe('/items/exact');
        expect(getItemHridFromName('Bar ★')).toBe('/items/star_variant');
    });

    test('a replaced detail map is re-indexed; the same map is not rescanned', () => {
        const first = { '/items/plank': { name: 'Plank' } };
        state.gameData = { itemDetailMap: first };
        expect(getItemHridFromName('Plank')).toBe('/items/plank');

        // Same map object: the memo answers, so a name added in place is not seen yet
        first['/items/board'] = { name: 'Board' };
        expect(getItemHridFromName('Board')).toBeNull();

        // A new map object (what a character switch hands out) is indexed afresh
        state.gameData = { itemDetailMap: { '/items/board': { name: 'Board' } } };
        expect(getItemHridFromName('Board')).toBe('/items/board');
        expect(getItemHridFromName('Plank')).toBeNull();
    });

    test('actions and items keep separate memos', () => {
        state.gameData = {
            actionDetailMap: { '/actions/foraging/carrot': { name: 'Carrot' } },
            itemDetailMap: { '/items/carrot': { name: 'Carrot' } },
        };
        expect(getActionHridFromName('Carrot')).toBe('/actions/foraging/carrot');
        expect(getItemHridFromName('Carrot')).toBe('/items/carrot');
    });
});
