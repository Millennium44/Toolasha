/**
 * Tests for Game Data Lookup Utilities
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({ gameData: null, fibers: new Map() }));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => state.gameData,
    },
}));

// The fiber lookup walks the live React root; what is under test is what is read off the fiber
vi.mock('./react-click.js', () => ({ fiberFor: (el) => state.fibers.get(el) ?? null }));

const {
    getActionHridFromName,
    getItemHridFromName,
    getShopCoinCost,
    getActionHridFromIconHref,
    getSkillHridFromIconHref,
    getItemHridFromIconHref,
    getIconHref,
    getActionHridFromFiber,
} = await import('./game-lookups.js');

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

describe('icon sprite lookups (locale-independent)', () => {
    const ACTIONS = '/static/media/actions_sprite.0a1b2c.svg';
    const SKILLS = '/static/media/skills_sprite.0a1b2c.svg';
    const ITEMS = '/static/media/items_sprite.0a1b2c.svg';

    beforeEach(() => {
        state.gameData = {
            actionDetailMap: {
                '/actions/milking/cow': { name: 'Cow' },
                '/actions/woodcutting/tree': { name: 'Tree' },
            },
            skillDetailMap: {
                '/skills/milking': { name: 'Milking' },
                '/skills/woodcutting': { name: 'Woodcutting' },
            },
            itemDetailMap: { '/items/redwood_log': { name: 'Redwood Log' } },
        };
    });

    test('an action href resolves by its last hrid segment, whatever the tile text says', () => {
        expect(getActionHridFromIconHref(`${ACTIONS}#cow`)).toBe('/actions/milking/cow');
        // The translated name the tile shows would not resolve by name
        expect(getActionHridFromName('奶牛')).toBeNull();
    });

    test('a skill href resolves to its skill hrid', () => {
        expect(getSkillHridFromIconHref(`${SKILLS}#woodcutting`)).toBe('/skills/woodcutting');
    });

    test('an item href resolves when the item exists, and not otherwise', () => {
        expect(getItemHridFromIconHref(`${ITEMS}#redwood_log`)).toBe('/items/redwood_log');
        expect(getItemHridFromIconHref(`${ITEMS}#not_an_item`)).toBeNull();
    });

    test('a href into another sheet, without a fragment, or empty resolves to nothing', () => {
        expect(getActionHridFromIconHref(`${SKILLS}#milking`)).toBeNull();
        expect(getSkillHridFromIconHref(`${ACTIONS}#cow`)).toBeNull();
        expect(getActionHridFromIconHref(ACTIONS)).toBeNull();
        expect(getActionHridFromIconHref(null)).toBeNull();
        expect(getItemHridFromIconHref('')).toBeNull();
    });

    test('without game data nothing resolves', () => {
        state.gameData = null;
        expect(getActionHridFromIconHref(`${ACTIONS}#cow`)).toBeNull();
        expect(getSkillHridFromIconHref(`${SKILLS}#milking`)).toBeNull();
    });

    test('the fragment index follows a replaced detail map', () => {
        expect(getActionHridFromIconHref(`${ACTIONS}#cow`)).toBe('/actions/milking/cow');
        state.gameData = { actionDetailMap: { '/actions/milking/cow_two': { name: 'Cow Two' } } };
        expect(getActionHridFromIconHref(`${ACTIONS}#cow`)).toBeNull();
        expect(getActionHridFromIconHref(`${ACTIONS}#cow_two`)).toBe('/actions/milking/cow_two');
    });

    /** A `<use>` carrying the given attributes, as the DOM reports them */
    const use = (attrs) => ({ getAttribute: (name) => attrs[name] ?? null });

    test('getIconHref reads the first icon in the named sheet', () => {
        const container = {
            querySelectorAll: () => [
                use({ href: '/static/media/items_sprite.x.svg#milk' }),
                use({ href: `${SKILLS}#milking` }),
            ],
        };
        expect(getIconHref(container, 'skills_sprite')).toBe(`${SKILLS}#milking`);
        expect(getIconHref(null, 'skills_sprite')).toBeNull();
        expect(getIconHref({ querySelectorAll: () => [] }, 'skills_sprite')).toBeNull();
    });

    test('getIconHref reads an icon that carries its sprite on xlink:href alone', () => {
        const container = { querySelectorAll: () => [use({ 'xlink:href': `${SKILLS}#milking` })] };
        expect(getIconHref(container, 'skills_sprite')).toBe(`${SKILLS}#milking`);
    });
});

describe('getActionHridFromFiber', () => {
    test('reads the action off the nearest ancestor component that carries actionDetail', () => {
        const el = {};
        const modal = { memoizedProps: { actionDetail: { hrid: '/actions/milking/cow' } }, return: null };
        const host = { memoizedProps: { className: 'x' }, return: { memoizedProps: {}, return: modal } };
        state.fibers.set(el, host);
        expect(getActionHridFromFiber(el)).toBe('/actions/milking/cow');
    });

    test('ignores an actionDetail that is not an action, and gives up at the root', () => {
        const el = {};
        state.fibers.set(el, { memoizedProps: { actionDetail: { hrid: '/items/cow' } }, return: null });
        expect(getActionHridFromFiber(el)).toBeNull();
        expect(getActionHridFromFiber({})).toBeNull();
        expect(getActionHridFromFiber(null)).toBeNull();
    });
});
