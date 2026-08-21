/**
 * The Tester shop as a price source: gated to the test server and the
 * setting, and the mirror route's doubling above the shop's level.
 */

import { describe, test, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({ setting: false }));

vi.mock('../core/config.js', () => ({ default: { getSetting: () => state.setting } }));
vi.mock('../core/data-manager.js', () => ({ default: { getInitClientData: () => null } }));

const { testerShopEnabled, testerShopEntry, testerGearPrice, isTesterShopEntry, MIRROR_HRID } =
    await import('./tester-shop.js');

const SHOP = {
    '/shop_items/tester_cedar_lumber': {
        category: '/shop_categories/tester',
        itemHrid: '/items/cedar_lumber',
        costs: [{ itemHrid: '/items/coin', count: 100 }],
    },
    '/shop_items/tester_philosophers_necklace': {
        category: '/shop_categories/tester',
        itemHrid: '/items/philosophers_necklace',
        costs: [{ itemHrid: '/items/coin', count: 12_000_000 }],
    },
    '/shop_items/tester_philosophers_mirror': {
        category: '/shop_categories/tester',
        itemHrid: MIRROR_HRID,
        costs: [{ itemHrid: '/items/coin', count: 10_000_000 }],
    },
    // A general-shop entry for the same lumber: not the Tester tab
    '/shop_items/cedar_lumber': {
        category: '/shop_categories/general',
        itemHrid: '/items/cedar_lumber',
        costs: [{ itemHrid: '/items/coin', count: 5_000 }],
    },
    // A token-priced tester entry counts for nothing in coins
    '/shop_items/tester_token_thing': {
        category: '/shop_categories/tester',
        itemHrid: '/items/token_thing',
        costs: [{ itemHrid: '/items/dungeon_token', count: 3 }],
    },
};
const ITEMS = {
    '/items/philosophers_necklace': { equipmentDetail: { type: '/equipment_types/neck' } },
    '/items/cedar_lumber': {},
};

describe('gating', () => {
    test('off the test server it is never on, whatever the setting', () => {
        state.setting = true;
        expect(testerShopEnabled({ testServer: false })).toBe(false);
    });

    test('on the test server it follows the setting', () => {
        state.setting = false;
        expect(testerShopEnabled({ testServer: true })).toBe(false);
        state.setting = true;
        expect(testerShopEnabled({ testServer: true })).toBe(true);
    });

    test('a Tester entry is told by its category or its hrid', () => {
        expect(isTesterShopEntry({ category: '/shop_categories/tester' })).toBe(true);
        expect(isTesterShopEntry({}, '/shop_items/tester_x')).toBe(true);
        expect(isTesterShopEntry({ category: '/shop_categories/general' }, '/shop_items/x')).toBe(false);
    });
});

describe('what the shop charges', () => {
    test('the Tester entry, never the general one, and only for coins', () => {
        expect(testerShopEntry('/items/cedar_lumber', SHOP)).toEqual({ coinCost: 100, enhancementLevel: null });
        expect(testerShopEntry('/items/token_thing', SHOP)).toBeNull();
        expect(testerShopEntry('/items/nothing', SHOP)).toBeNull();
    });

    test('a material is the shop price at any level', () => {
        expect(testerGearPrice('/items/cedar_lumber', 0, { shopMap: SHOP, itemDetailMap: ITEMS })).toMatchObject({
            price: 100,
            route: 'shop',
            shopLevel: 0,
        });
    });

    test('equipment is the shop price up to +10, then doubles plus a mirror per level', () => {
        const at10 = testerGearPrice('/items/philosophers_necklace', 10, { shopMap: SHOP, itemDetailMap: ITEMS });
        expect(at10).toMatchObject({ price: 12_000_000, route: 'shop', shopLevel: 10, mirrors: 0 });
        const at3 = testerGearPrice('/items/philosophers_necklace', 3, { shopMap: SHOP, itemDetailMap: ITEMS });
        expect(at3.price).toBe(12_000_000);

        // +11: a +10 copy consumed plus a mirror, on top of the +10 being made
        const at11 = testerGearPrice('/items/philosophers_necklace', 11, { shopMap: SHOP, itemDetailMap: ITEMS });
        expect(at11).toMatchObject({ price: 2 * 12_000_000 + 10_000_000, route: 'mirror', mirrors: 1 });
        // +12: the +11 doubled plus a mirror
        const at12 = testerGearPrice('/items/philosophers_necklace', 12, { shopMap: SHOP, itemDetailMap: ITEMS });
        expect(at12.price).toBe(2 * at11.price + 10_000_000);
        expect(at12.mirrors).toBe(2);
    });

    test('an entry that states its own level is sold at that level', () => {
        const shop = {
            '/shop_items/tester_ring': {
                category: '/shop_categories/tester',
                itemHrid: '/items/ring',
                enhancementLevel: 0,
                costs: [{ itemHrid: '/items/coin', count: 1_000 }],
            },
        };
        const items = { '/items/ring': { equipmentDetail: { type: '/equipment_types/ring' } } };
        expect(testerGearPrice('/items/ring', 1, { shopMap: shop, itemDetailMap: items })).toMatchObject({
            route: 'mirror',
            shopLevel: 0,
            mirrors: 1,
        });
    });

    test('something the shop does not sell has no tester price', () => {
        expect(testerGearPrice('/items/nothing', 5, { shopMap: SHOP, itemDetailMap: ITEMS })).toBeNull();
    });
});
