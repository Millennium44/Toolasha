/**
 * One-sided and empty books through the REAL resolver and book reconciliation.
 *
 * The unit suite for the shared rule fakes the market feed, and a fake that fills a missing side
 * hides exactly what matters here: `getItemPriceInfo` / `reconcileBook` do not hand the mode's side
 * the opposite live quote. With no official value the missing side stays null (unpriced); with one it
 * is filled with the official-value estimate. The shared rule must use the live opposite quote first,
 * as the old material rule did, and fall to estimate, shop, craft cost or nothing only after that.
 *
 * Only the market feed, the game data, the settings and the custom-price store are faked; market-data,
 * market-values, profit-helpers, enhancement-pricing and the shared rule are the real modules.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const state = vi.hoisted(() => ({
    books: {},
    shop: {},
    profitMode: 'hybrid',
    version: 0,
    items: {},
    actions: {},
}));

vi.mock('../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ itemDetailMap: state.items, actionDetailMap: state.actions }),
        getItemDetails: () => null,
        getBuffStateVersion: () => state.version,
        on: () => {},
    },
}));
vi.mock('../core/config.js', () => ({
    default: {
        getSettingValue: (key) => (key === 'profitCalc_pricingMode' ? state.profitMode : undefined),
        getSetting: () => false,
        isFeatureEnabled: () => false,
    },
}));
vi.mock('../api/marketplace.js', () => ({
    default: {
        on: () => {},
        liveSourced: false,
        getPrice: (hrid, level = 0) => state.books[`${hrid}:${level}`] ?? null,
    },
}));
vi.mock('./ironcow-valuation.js', () => ({
    getIronCowValue: () => null,
    isIronCowCharacter: () => false,
}));
vi.mock('./action-context.js', () => ({ resolveActionContext: () => ({ equipment: new Map(), drinks: [] }) }));
vi.mock('./game-lookups.js', () => ({ getShopCoinCost: (hrid) => state.shop[hrid] || 0 }));
vi.mock('../features/settings/custom-price-overrides.js', () => ({
    getCustomPrice: () => null,
    getCustomPriceVersion: () => 0,
}));

const { priceMaterial, priceGuarded, priceProtection, priceBase, priceAtLevel } =
    await import('./enhancement-input-pricing.js');
const { applyMarketValuesMessage } = await import('./market-values.js');

const ASK_ONLY = '/items/ask_only';
const BID_ONLY = '/items/bid_only';
const NONE = '/items/no_quote';
const VALUED_BID_ONLY = '/items/valued_bid_only';
const VALUED_ASK_ONLY = '/items/valued_ask_only';

beforeEach(() => {
    state.version++;
    state.profitMode = 'hybrid';
    state.shop = {};
    state.items = {};
    state.actions = {};
    state.books = {
        [`${ASK_ONLY}:0`]: { ask: 1000, bid: -1 },
        [`${BID_ONLY}:0`]: { ask: -1, bid: 800 },
        [`${VALUED_BID_ONLY}:0`]: { ask: -1, bid: 850 },
        [`${VALUED_ASK_ONLY}:0`]: { ask: 950, bid: -1 },
    };
    // The official values fill an empty side with an estimate: 900, with both quotes inside its band
    applyMarketValuesMessage({
        marketValuesVersion: state.version,
        marketItemValues: {
            [VALUED_BID_ONLY]: { 0: 900 },
            [VALUED_ASK_ONLY]: { 0: 900 },
            '/items/valued_none': { 0: 900 },
        },
    });
});

describe('a material with only one live side', () => {
    test.each([
        ['ask-only book, ask mode', ASK_ONLY, 'ask', 1000],
        ['ask-only book, bid mode', ASK_ONLY, 'bid', 1000],
        ['bid-only book, ask mode', BID_ONLY, 'ask', 800],
        ['bid-only book, bid mode', BID_ONLY, 'bid', 800],
    ])('%s is priced from the live quote it has', (_name, hrid, mode, expected) => {
        expect(priceMaterial(hrid, { mode })).toMatchObject({ price: expected, unpriced: false, estimated: false });
    });

    test('with an official value filling the empty side, the live opposite quote still wins over the estimate', () => {
        expect(priceMaterial(VALUED_BID_ONLY, { mode: 'ask' }).price).toBe(850);
        expect(priceMaterial(VALUED_ASK_ONLY, { mode: 'bid' }).price).toBe(950);
    });

    test('the side that is quoted is read as itself, not replaced by the other', () => {
        expect(priceMaterial(VALUED_BID_ONLY, { mode: 'bid' }).price).toBe(850);
        expect(priceMaterial(VALUED_ASK_ONLY, { mode: 'ask' }).price).toBe(950);
    });

    test('the profit mode picks the side when none is forced, and the cross-fill follows it', () => {
        state.profitMode = 'optimistic'; // buys at the bid
        expect(priceMaterial(ASK_ONLY).price).toBe(1000);
        expect(priceMaterial(BID_ONLY).price).toBe(800);
        state.profitMode = 'hybrid'; // buys at the ask
        expect(priceMaterial(BID_ONLY).price).toBe(800);
    });

    test('a shop floor below the cross-filled quote still wins, as it does over any book price', () => {
        state.shop[BID_ONLY] = 500;
        expect(priceMaterial(BID_ONLY, { mode: 'ask' }).price).toBe(500);
    });
});

describe('a book with no quote at all', () => {
    test.each(['ask', 'bid'])('is unpriced in %s mode (nothing to cross-fill, nothing to craft)', (mode) => {
        expect(priceMaterial(NONE, { mode })).toMatchObject({ price: null, unpriced: true });
    });

    test.each(['ask', 'bid'])('falls to the official-value estimate, flagged, in %s mode', (mode) => {
        const priced = priceMaterial('/items/valued_none', { mode });
        expect(priced).toMatchObject({ price: 900, unpriced: false, estimated: true });
    });

    test('the shop floor prices it when nothing else does', () => {
        state.shop[NONE] = 300;
        expect(priceMaterial(NONE, { mode: 'ask' }).price).toBe(300);
    });
});

describe('protection, mirror and base use the same cross-fill', () => {
    test.each([
        ['ask-only', ASK_ONLY, 1000],
        ['bid-only', BID_ONLY, 800],
    ])('%s: guarded price, base and an enhanced level read the live quote', (_name, hrid, expected) => {
        for (const mode of ['ask', 'bid']) {
            expect(priceGuarded(hrid, { mode }).price).toBe(expected);
            expect(priceBase(hrid, { mode }).price).toBe(expected);
        }
    });

    test('protection picks the one live quote among options that are otherwise empty', () => {
        // The protection options are the item itself and the mirror of protection; only the item is quoted
        state.books['/items/prot_piece:0'] = { ask: -1, bid: 800 };
        expect(priceProtection('/items/prot_piece', { mode: 'ask' })).toMatchObject({
            price: 800,
            itemHrid: '/items/prot_piece',
            unpriced: false,
        });
    });

    test('an enhanced level with only a bid is priced from it in ask mode', () => {
        state.books[`${ASK_ONLY}:5`] = { ask: -1, bid: 640 };
        expect(priceAtLevel(ASK_ONLY, 5, { mode: 'ask' }).price).toBe(640);
        expect(priceAtLevel(ASK_ONLY, 6, { mode: 'ask' })).toMatchObject({ price: null, unpriced: true });
    });
});

describe('the inflation guard after a cross-fill onto a value-filled book', () => {
    /** An item crafted from ore: 2 ore at 1000 = 2000 */
    const craftable = (hrid, oreAsk) => {
        state.items[hrid] = { name: hrid };
        state.items['/items/ore'] = { name: 'Ore' };
        state.books['/items/ore:0'] = { ask: oreAsk, bid: oreAsk };
        state.actions['/actions/make'] = {
            type: '/action_types/crafting',
            inputItems: [{ itemHrid: '/items/ore', count: 2 }],
            outputItems: [{ itemHrid: hrid, count: 1 }],
        };
    };

    test('ask mode: a live bid with an estimated ask is a one-sided bid book, so the craft cost lifts it', () => {
        // The ask is the official-value estimate (900); only the bid (850) is a quote. One-sided bid:
        // max(bid, production) = 2000, not the bare 850
        craftable(VALUED_BID_ONLY, 1000);
        expect(priceGuarded(VALUED_BID_ONLY, { mode: 'ask' }).price).toBe(2000);
        expect(priceBase(VALUED_BID_ONLY, { mode: 'ask' }).price).toBe(2000);
        expect(priceProtection(VALUED_BID_ONLY, { mode: 'ask' }).price).toBe(2000);
    });

    test('bid mode: a live ask with an estimated bid is a one-sided ask book, so an inflated ask falls to the craft cost', () => {
        // Ask 950 over a craft cost of 500 is inflated (> 1.3x): the craft cost stands, not the ask
        craftable(VALUED_ASK_ONLY, 250);
        expect(priceGuarded(VALUED_ASK_ONLY, { mode: 'bid' }).price).toBe(500);
    });

    test('a genuinely two-sided book keeps the ordinary guard', () => {
        state.books[`${ASK_ONLY}:0`] = { ask: 1000, bid: 900 };
        craftable(ASK_ONLY, 1000);
        expect(priceGuarded(ASK_ONLY, { mode: 'ask' }).price).toBe(1000);
    });
});

describe('a shop price that beats a cross-filled quote keeps its provenance', () => {
    test('is not weighed as a one-sided market quote by the inflation guard', () => {
        // Bid-only book at 1000, shop sells it for 100, and crafting it would cost 500: the guard would
        // lift a one-sided bid to the craft cost, but the shop price is guaranteed
        state.items[BID_ONLY] = { name: 'Bid Only' };
        state.items['/items/ore'] = { name: 'Ore' };
        state.books[`${BID_ONLY}:0`] = { ask: -1, bid: 1000 };
        state.books['/items/ore:0'] = { ask: 250, bid: 250 };
        state.actions['/actions/make'] = {
            type: '/action_types/crafting',
            inputItems: [{ itemHrid: '/items/ore', count: 2 }],
            outputItems: [{ itemHrid: BID_ONLY, count: 1 }],
        };
        state.shop[BID_ONLY] = 100;
        expect(priceGuarded(BID_ONLY, { mode: 'ask' }).price).toBe(100);
        expect(priceBase(BID_ONLY, { mode: 'ask' }).price).toBe(100);
        expect(priceProtection(BID_ONLY, { mode: 'ask' }).price).toBe(100);
    });

    test('a shop price dearer than the quote leaves the cross-filled quote guarded as before', () => {
        state.items[BID_ONLY] = { name: 'Bid Only' };
        state.items['/items/ore'] = { name: 'Ore' };
        state.books[`${BID_ONLY}:0`] = { ask: -1, bid: 300 };
        state.books['/items/ore:0'] = { ask: 250, bid: 250 };
        state.actions['/actions/make'] = {
            type: '/action_types/crafting',
            inputItems: [{ itemHrid: '/items/ore', count: 2 }],
            outputItems: [{ itemHrid: BID_ONLY, count: 1 }],
        };
        state.shop[BID_ONLY] = 5000;
        // One-sided bid 300 under a craft cost of 500: max(bid, production)
        expect(priceGuarded(BID_ONLY, { mode: 'ask' }).price).toBe(500);
    });
});
