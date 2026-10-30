import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    shopItemDetailMap: {},
    labyrinthShopItemDetailMap: {},
    items: {},
    /** hrid -> {ask, bid} */
    books: {},
    side: 'ask',
    ironCow: false,
    settings: {},
    /** hrid -> {value, partial} the cape valuation answers */
    capeCosts: {},
    custom: {},
    capeCalls: [],
}));

vi.mock('../../core/config.js', () => ({
    default: { getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            shopItemDetailMap: mocks.shopItemDetailMap,
            labyrinthShopItemDetailMap: mocks.labyrinthShopItemDetailMap,
            itemDetailMap: mocks.items,
        }),
        getItemDetails: (hrid) => mocks.items[hrid] ?? null,
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    // The token valuation's source: a custom price wins, the side is forced by `mode`
    getItemPrice: (hrid, { mode } = {}) => mocks.custom[hrid] ?? mocks.books[hrid]?.[mode] ?? null,
    // dungeonShopOffers still reads the raw book for its own `askPrice`, which the badge ignores
    getItemPrices: (hrid) => mocks.books[hrid] ?? null,
}));
vi.mock('../../utils/profit-helpers.js', () => ({
    calculatePriceAfterTax: (price) => (mocks.ironCow ? price : price * 0.96),
}));
vi.mock('../../utils/token-valuation.js', () => ({
    DUNGEON_TOKEN_HRIDS: new Set([
        '/items/chimerical_token',
        '/items/sinister_token',
        '/items/enchanted_token',
        '/items/pirate_token',
    ]),
    tokenPricingSide: () => mocks.side,
}));
vi.mock('../../utils/untradable-cape-cost.js', () => ({
    getUntradableCapeBaseCost: (hrid, options) => {
        mocks.capeCalls.push([hrid, options]);
        return mocks.capeCosts[hrid] ?? null;
    },
}));

const { shopLineValues, bestLine, badgedCurrencies, badgeSide, LABYRINTH_TOKEN_HRID } =
    await import('./shop-token-values-logic.js');

const CHIM = '/items/chimerical_token';
const back = { equipmentDetail: { type: '/equipment_types/back' } };

const dungeonLine = (itemHrid, count, outputCount, sortIndex, extraCosts = []) => ({
    itemHrid,
    costs: [{ itemHrid: CHIM, count }, ...extraCosts],
    outputCount,
    sortIndex,
});

beforeEach(() => {
    mocks.side = 'ask';
    mocks.ironCow = false;
    mocks.settings = {};
    mocks.capeCosts = {};
    mocks.custom = {};
    mocks.capeCalls = [];
    mocks.books = {
        '/items/essence': { ask: 1000, bid: 800 },
        '/items/bulk': { ask: 50, bid: 40 },
        '/items/rare': { ask: 90_000, bid: 70_000 },
    };
    mocks.items = {
        '/items/essence': { name: 'Essence', isTradable: true },
        '/items/bulk': { name: 'Bulk', isTradable: true },
        '/items/rare': { name: 'Rare', isTradable: true },
        '/items/unlisted': { name: 'Unlisted', isTradable: true },
        '/items/chimerical_quiver': { name: 'Chimerical Quiver', ...back },
        '/items/tradable_cloak': { name: 'Cloak', isTradable: true, ...back },
    };
    mocks.shopItemDetailMap = {
        a: dungeonLine('/items/essence', 10, 1, 1),
        b: dungeonLine('/items/bulk', 1, 20, 2),
        c: dungeonLine('/items/rare', 100, 1, 3),
        d: dungeonLine('/items/unlisted', 5, 1, 4),
        e: dungeonLine('/items/essence', 1, 1, 5, [{ itemHrid: '/items/coin', count: 100 }]),
        f: dungeonLine('/items/chimerical_quiver', 35_000, 1, 6),
    };
    mocks.labyrinthShopItemDetailMap = {
        x: { itemHrid: '/items/essence', cost: { itemHrid: LABYRINTH_TOKEN_HRID, count: 4 }, outputCount: 10 },
        y: { itemHrid: '/items/rare', cost: { itemHrid: LABYRINTH_TOKEN_HRID, count: 30 }, outputCount: 1 },
        z: { itemHrid: '/items/essence', cost: { itemHrid: LABYRINTH_TOKEN_HRID, count: 8 }, outputCount: 10 },
        w: { itemHrid: '/items/unlisted', cost: { itemHrid: LABYRINTH_TOKEN_HRID, count: 2 }, outputCount: 1 },
    };
});

describe('shopLineValues', () => {
    test('a dungeon line is the ask after tax, times the units a purchase hands over, over its token cost', () => {
        const lines = shopLineValues(CHIM);
        const byItem = (hrid) => lines.filter((line) => line.itemHrid === hrid);

        // 1000 x 0.96 / 10 tokens
        expect(byItem('/items/essence')[0]).toMatchObject({ cost: 10, perToken: 96, assumed: false });
        // 20 units per purchase: 50 x 0.96 x 20 / 1 token
        expect(byItem('/items/bulk')[0]).toMatchObject({ outputCount: 20, perToken: 960, assumed: false });
        expect(byItem('/items/rare')[0].perToken).toBeCloseTo((90_000 * 0.96) / 100, 8);
    });

    test('a line also paid in another currency is not a token-only line, and an unlisted item has no value', () => {
        const lines = shopLineValues(CHIM);

        expect(lines.some((line) => line.cost === 1 && line.itemHrid === '/items/essence')).toBe(false);
        expect(lines.some((line) => line.itemHrid === '/items/unlisted')).toBe(false);
    });

    test('the side of the book follows the token side setting', () => {
        mocks.side = 'bid';
        expect(shopLineValues(CHIM).find((line) => line.itemHrid === '/items/essence').perToken).toBeCloseTo(
            (800 * 0.96) / 10,
            8
        );
        expect(badgeSide()).toBe('bid');
        expect(shopLineValues(CHIM, 'ask').find((line) => line.itemHrid === '/items/essence').perToken).toBeCloseTo(
            96,
            8
        );
    });

    test('an Iron Cow character pays no tax, so the figure is gross', () => {
        mocks.ironCow = true;
        expect(shopLineValues(CHIM).find((line) => line.itemHrid === '/items/essence').perToken).toBe(100);
    });

    test('labyrinth lines come from the labyrinth shop map, one per entry, with the same item twice kept apart', () => {
        const lines = shopLineValues(LABYRINTH_TOKEN_HRID);
        const essence = lines.filter((line) => line.itemHrid === '/items/essence');

        expect(essence.map((line) => [line.cost, line.perToken])).toEqual([
            [4, (1000 * 0.96 * 10) / 4],
            [8, (1000 * 0.96 * 10) / 8],
        ]);
        expect(lines.some((line) => line.itemHrid === '/items/unlisted')).toBe(false);
        expect(lines.every((line) => line.currencyHrid === LABYRINTH_TOKEN_HRID)).toBe(true);
    });

    test('a cape line is valued by the cape setting, untaxed, and flagged assumed', () => {
        mocks.capeCosts['/items/chimerical_quiver'] = { value: 5_000_000, partial: false };
        const cape = shopLineValues(CHIM).find((line) => line.itemHrid === '/items/chimerical_quiver');

        expect(cape).toMatchObject({
            assumed: true,
            assumedValue: 5_000_000,
            partial: false,
            perToken: 5_000_000 / 35_000,
        });
    });

    test('a cape the setting values at nothing is assumed zero and a floor, not omitted and not free', () => {
        mocks.capeCosts['/items/chimerical_quiver'] = { value: null, partial: true };
        const cape = shopLineValues(CHIM).find((line) => line.itemHrid === '/items/chimerical_quiver');
        expect(cape).toMatchObject({ assumed: true, assumedValue: 0, perToken: 0, partial: true });

        // The cost helper not answering at all reads the same
        delete mocks.capeCosts['/items/chimerical_quiver'];
        expect(shopLineValues(CHIM).find((line) => line.itemHrid === '/items/chimerical_quiver')).toMatchObject({
            assumed: true,
            perToken: 0,
            partial: true,
        });
    });

    test('a cape the book does quote is an ordinary priced line', () => {
        mocks.books['/items/chimerical_quiver'] = { ask: 2_000_000, bid: 1_900_000 };
        const cape = shopLineValues(CHIM).find((line) => line.itemHrid === '/items/chimerical_quiver');

        expect(cape.assumed).toBe(false);
        expect(cape.perToken).toBeCloseTo((2_000_000 * 0.96) / 35_000, 8);
    });

    test('a custom price counts, as it does in the token valuation', () => {
        mocks.custom['/items/essence'] = 5000;
        const essence = shopLineValues(CHIM).find((line) => line.itemHrid === '/items/essence');
        expect(essence.perToken).toBeCloseTo((5000 * 0.96) / 10, 8);
    });

    test('the cape stand-in is read on the badge side', () => {
        mocks.side = 'bid';
        mocks.capeCosts['/items/chimerical_quiver'] = { value: 1, partial: false };
        shopLineValues(CHIM);
        expect(mocks.capeCalls).toContainEqual(['/items/chimerical_quiver', { mode: 'bid' }]);
    });

    test('a shop with no data, or a currency nothing sells for, has no lines', () => {
        expect(shopLineValues('/items/pirate_token')).toEqual([]);
        mocks.shopItemDetailMap = {};
        mocks.labyrinthShopItemDetailMap = {};
        expect(shopLineValues(CHIM)).toEqual([]);
        expect(shopLineValues(LABYRINTH_TOKEN_HRID)).toEqual([]);
    });
});

describe('bestLine', () => {
    test('is the highest real value per token across every line, and says which cost it is', () => {
        expect(bestLine(shopLineValues(CHIM))).toEqual({ itemHrid: '/items/bulk', cost: 1 });
        expect(bestLine(shopLineValues(LABYRINTH_TOKEN_HRID))).toEqual({ itemHrid: '/items/rare', cost: 30 });
    });

    test('an assumed cape never wins, however much it is assumed to be worth', () => {
        mocks.capeCosts['/items/chimerical_quiver'] = { value: 900_000_000_000, partial: false };
        const lines = shopLineValues(CHIM);

        expect(lines.find((line) => line.assumed).perToken).toBeGreaterThan(1e6);
        expect(bestLine(lines)).toEqual({ itemHrid: '/items/bulk', cost: 1 });
    });

    test('nothing priced, only capes, or no lines at all is no best', () => {
        expect(bestLine([])).toBeNull();
        expect(bestLine([{ itemHrid: '/items/q', cost: 1, perToken: 99, assumed: true }])).toBeNull();
        expect(bestLine([{ itemHrid: '/items/z', cost: 1, perToken: 0, assumed: false }])).toBeNull();
    });
});

describe('badgedCurrencies', () => {
    test('is the four dungeon tokens and the labyrinth token', () => {
        expect(badgedCurrencies()).toEqual([
            '/items/chimerical_token',
            '/items/sinister_token',
            '/items/enchanted_token',
            '/items/pirate_token',
            LABYRINTH_TOKEN_HRID,
        ]);
    });
});
