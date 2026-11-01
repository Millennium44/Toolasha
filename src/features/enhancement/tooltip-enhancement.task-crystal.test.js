/**
 * Task Crystal pricing through the shared enhancement input rule.
 *
 * Task badges enhance with `/items/task_crystal` plus coin. The crystal is untradable (no listing, no
 * recipe, no coin shop line): the Task Shop sells it for Task Tokens. Nothing used to price it, so the
 * enhancement path showed it at 0 under "some inputs have no price", the protect-or-not choice treated
 * failed attempts as nearly free, and every other surface that tallies a bill was understated the same
 * way. It is now valued through the tokens it costs, at the same coins-per-token the Task Token tooltip
 * shows, marked as an estimate - and left unpriced (never 0) when that value is unknown.
 *
 * The game is faked (data, settings, order book); the pricing rule, the Task Shop valuation and the
 * path builder are the real modules.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import * as mathjs from 'mathjs';

const BADGE = '/items/expert_task_badge';
const CRYSTAL = '/items/task_crystal';
const CHEST = '/items/large_treasure_chest';
const MIRROR = '/items/philosophers_mirror';
const PROTECTION = '/items/mirror_of_protection';

const prices = vi.hoisted(() => ({}));
const state = vi.hoisted(() => ({
    evReady: true,
    shop: {},
    custom: {},
    ev: {},
}));

const gameData = {
    itemDetailMap: {
        // Fixture bill: one crystal and coin per attempt (the in-game counts are not what is under test)
        '/items/expert_task_badge': {
            name: 'Expert Task Badge',
            itemLevel: 50,
            enhancementCosts: [
                { itemHrid: '/items/task_crystal', count: 1 },
                { itemHrid: '/items/coin', count: 1000 },
            ],
        },
        '/items/task_crystal': { name: 'Task Crystal' },
        '/items/large_treasure_chest': { name: 'Large Treasure Chest', isOpenable: true },
        '/items/philosophers_mirror': { name: "Philosopher's Mirror", sellPrice: 1 },
        '/items/mirror_of_protection': { name: 'Mirror of Protection', sellPrice: 1 },
    },
    actionDetailMap: {},
    get taskShopItemDetailMap() {
        return state.shop;
    },
};

// The code under test reads the live singleton through the bridge (split build); hand it the mocked module.
vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => {
    const original = await importOriginal();
    const mockedexpectedValueCalculator = await import('../market/expected-value-calculator.js');
    return {
        ...original,
        expectedValueCalculator: () => original.expectedValueCalculator() || mockedexpectedValueCalculator.default,
    };
});

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => gameData,
        getEquipment: () => new Map(),
        getActionDrinkSlots: () => [],
        getAchievementBuffFlatBoost: () => 0,
        characterData: null,
    },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        isFeatureEnabled: () => false,
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        COLOR_MIRROR: '#fff',
        COLOR_BORDER: '#fff',
        COLOR_TOOLTIP_INFO: '#fff',
        COLOR_TOOLTIP_PROFIT: '#fff',
        COLOR_TOOLTIP_LOSS: '#fff',
        COLOR_XP_RATE: '#fff',
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { on: () => {}, getPrice: (hrid) => prices[hrid] || null },
}));
vi.mock('../../utils/market-data.js', () => ({
    getPricingMode: () => 'ask',
    getItemPriceInfo: (hrid, { mode } = {}) => {
        const quote = prices[hrid];
        if (!quote) return { price: null, source: null, estimated: false };
        return { price: mode === 'bid' ? quote.bid : quote.ask, source: 'book', estimated: false };
    },
    getItemPrice: (hrid) => prices[hrid]?.ask ?? 0,
    getItemPrices: (hrid, level = 0) => (level === 0 ? (prices[hrid] ?? null) : null),
}));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        get isInitialized() {
            return state.evReady;
        },
        calculateExpectedValue: (hrid) => state.ev[hrid] ?? null,
    },
}));
vi.mock('../../utils/tea-parser.js', () => ({ parseArtisanBonus: () => 0, getDrinkConcentration: () => 0 }));
vi.mock('../settings/custom-price-overrides.js', () => ({
    getCustomPriceVersion: () => 0,
    getCustomPrice: (hrid, level = 0, side = 'sell') => state.custom[`${hrid}:${level}:${side}`] ?? null,
}));
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));

let calculateEnhancementPath;
let buildEnhancementTooltipHTML;
let priceMaterial;
let perAttemptMaterialCost;

beforeAll(async () => {
    globalThis.math = mathjs;
    ({ calculateEnhancementPath, buildEnhancementTooltipHTML } = await import('./tooltip-enhancement.js'));
    ({ priceMaterial, perAttemptMaterialCost } = await import('../../utils/enhancement-input-pricing.js'));
});

/** The Task Shop: a chest worth 1.2M for 30 tokens, and the crystal for 50 (the shape the game sends) */
function taskShop() {
    return {
        chest: { itemHrid: CHEST, cost: { itemHrid: '/items/task_token', count: 30 } },
        crystal: { itemHrid: CRYSTAL, cost: { itemHrid: '/items/task_token', count: 50 } },
    };
}

beforeEach(() => {
    state.evReady = true;
    state.custom = {};
    state.shop = taskShop();
    // The chest's expected contents are already net of tax, as the calculator reports them
    state.ev = { [CHEST]: { expectedValue: 1_200_000, missingCount: 0, isPartial: false } };
    for (const key of Object.keys(prices)) delete prices[key];
    Object.assign(prices, {
        [BADGE]: { ask: 5_000_000, bid: 4_800_000 },
        [MIRROR]: { ask: 20_000_000, bid: 19_000_000 },
        [PROTECTION]: { ask: 3_000_000, bid: 2_900_000 },
    });
});

const enhancingConfig = {
    enhancingLevel: 100,
    houseLevel: 0,
    toolBonus: 0,
    speedBonus: 0,
    experienceBonus: 0,
    guzzlingBonus: 1,
    blessedTeaBonus: 0.01,
    teas: { blessed: false },
};

const PER_TOKEN = 1_200_000 / 30;
const CRYSTAL_PRICE = 50 * PER_TOKEN;

describe('Task Crystal price', () => {
    test('is its token cost at the best coins-per-token the Task Shop offers, flagged as an estimate', () => {
        expect(priceMaterial(CRYSTAL)).toMatchObject({
            price: CRYSTAL_PRICE,
            unpriced: false,
            estimated: true,
            tokenValued: true,
            partial: false,
        });
    });

    test('reads the cost from the shop data, not a constant', () => {
        state.shop.crystal.cost.count = 80;
        expect(priceMaterial(CRYSTAL).price).toBe(80 * PER_TOKEN);
    });

    test('reads a costs-array line and a line that hands over several', () => {
        state.shop.crystal = {
            itemHrid: CRYSTAL,
            costs: [{ itemHrid: '/items/task_token', count: 50 }],
            outputCount: 2,
        };
        expect(priceMaterial(CRYSTAL).price).toBe((50 * PER_TOKEN) / 2);
    });

    test('is the same on the net-worth side and with a side forced (the token valuation is not a book quote)', () => {
        expect(priceMaterial(CRYSTAL, { context: 'networth' }).price).toBe(CRYSTAL_PRICE);
        expect(priceMaterial(CRYSTAL, { mode: 'bid' }).price).toBe(CRYSTAL_PRICE);
        expect(priceMaterial(CRYSTAL, { mode: 'ask' }).price).toBe(CRYSTAL_PRICE);
    });

    test('a token value that is itself a floor (unpriced chest contents) marks the price partial', () => {
        state.ev[CHEST] = { expectedValue: 1_200_000, missingCount: 2, isPartial: true };
        expect(priceMaterial(CRYSTAL)).toMatchObject({ price: CRYSTAL_PRICE, partial: true, tokenValued: true });
    });

    test('a live quote wins over the token valuation', () => {
        prices[CRYSTAL] = { ask: 123456, bid: 120000 };
        const quoted = priceMaterial(CRYSTAL);
        expect(quoted.price).toBe(123456);
        expect(quoted.tokenValued).toBeUndefined();
    });

    test('a custom price wins, and a custom price of 0 stays the player\'s own "unpriced"', () => {
        state.custom[`${CRYSTAL}:0:buy`] = 777777;
        expect(priceMaterial(CRYSTAL)).toMatchObject({ price: 777777, custom: true });
        expect(priceMaterial(CRYSTAL).tokenValued).toBeUndefined();
        state.custom[`${CRYSTAL}:0:buy`] = 0;
        expect(priceMaterial(CRYSTAL).tokenValued).toBeUndefined();
    });

    test.each([
        [
            'the shop does not sell it',
            () => {
                delete state.shop.crystal;
            },
        ],
        [
            'it is not bought with task tokens alone',
            () => {
                state.shop.crystal.cost.itemHrid = '/items/coin';
            },
        ],
        [
            'the shop prices no token (nothing is priceable)',
            () => {
                state.ev = {};
            },
        ],
        [
            'the expected-value calculator is not ready',
            () => {
                state.evReady = false;
            },
        ],
    ])('stays unpriced, never 0, when %s', (_name, breakIt) => {
        breakIt();
        expect(priceMaterial(CRYSTAL)).toMatchObject({ price: null, unpriced: true });
        expect(perAttemptMaterialCost(gameData.itemDetailMap[BADGE])).toMatchObject({ hasMissingPrices: true });
    });

    describe('in the split production build', () => {
        // The utils bundle inlines its own, never-initialized calculator; the market bundle's copy is the
        // live one, published on the namespace
        afterEach(() => {
            vi.unstubAllGlobals();
        });

        const publish = (calculator) =>
            vi.stubGlobal('window', { Toolasha: { Market: { expectedValueCalculator: calculator } } });

        test('prices from the market bundle copy while the inlined copy is uninitialized', () => {
            state.evReady = false;
            publish({ isInitialized: true, calculateExpectedValue: (hrid) => state.ev[hrid] ?? null });
            expect(priceMaterial(CRYSTAL)).toMatchObject({ price: CRYSTAL_PRICE, tokenValued: true });
        });

        test('stays unpriced when neither copy is ready', () => {
            state.evReady = false;
            publish({ isInitialized: false, calculateExpectedValue: () => null });
            expect(priceMaterial(CRYSTAL)).toMatchObject({ price: null, unpriced: true });
        });
    });

    test('a missing shop map stays unpriced', () => {
        state.shop = undefined;
        expect(priceMaterial(CRYSTAL)).toMatchObject({ price: null, unpriced: true });
    });

    test('other untradable items are not token-valued', () => {
        state.shop.other = { itemHrid: '/items/other_thing', cost: { itemHrid: '/items/task_token', count: 5 } };
        expect(priceMaterial('/items/other_thing')).toMatchObject({ price: null, unpriced: true });
    });
});

describe('the enhancement path with Task Crystals', () => {
    test('the profile score (forced ask) and the net-worth worker feed (networth context) tally the same bill', () => {
        const details = gameData.itemDetailMap[BADGE];
        expect(perAttemptMaterialCost(details, { mode: 'ask' })).toMatchObject({
            cost: CRYSTAL_PRICE + 1000,
            hasMissingPrices: false,
        });
        expect(perAttemptMaterialCost(details, { context: 'networth' }).cost).toBe(CRYSTAL_PRICE + 1000);
    });

    test('a bill counts the crystal instead of leaving it out', () => {
        const bill = perAttemptMaterialCost(gameData.itemDetailMap[BADGE]);
        expect(bill).toMatchObject({ cost: CRYSTAL_PRICE + 1000, hasMissingPrices: false });
    });

    test('Expert Task Badge +0 to +11: crystals are in the total and the tooltip labels the estimate', () => {
        const data = calculateEnhancementPath(BADGE, 11, enhancingConfig);
        const strategy = data.optimalStrategy;
        const crystal = strategy.materialBill.find((m) => m.itemHrid === CRYSTAL);
        expect(crystal.unitPrice).toBe(CRYSTAL_PRICE);
        expect(crystal.count).toBeGreaterThan(11);

        const html = buildEnhancementTooltipHTML(data, BADGE);
        expect(crystal.name).toBe('Task Crystal (token value)');
        expect(html).not.toContain('Some inputs have no price');
    });

    test('with the token value unknown the crystal is flagged unpriced, not free', () => {
        const priced = calculateEnhancementPath(BADGE, 11, enhancingConfig).optimalStrategy.totalCost;
        state.ev = {};
        const data = calculateEnhancementPath(BADGE, 11, enhancingConfig);
        expect(data.optimalStrategy.totalCost).toBeLessThan(priced / 10);
        expect(buildEnhancementTooltipHTML(data, BADGE)).toContain('Some inputs have no price');
    });

    test('protection starts earlier when crystals are expensive than when they are cheap or unpriced', () => {
        const protectFrom = () => calculateEnhancementPath(BADGE, 11, enhancingConfig).optimalStrategy.protectFrom;
        const expensive = protectFrom();
        // Crystals cost almost nothing (a nearly worthless chest): a failed attempt is cheap, protection is not
        state.ev = { [CHEST]: { expectedValue: 30, missingCount: 0, isPartial: false } };
        const cheap = protectFrom();
        expect(expensive).toBeGreaterThan(0);
        expect(expensive).toBeLessThan(cheap);
        state.ev = {};
        expect(protectFrom()).toBeGreaterThanOrEqual(cheap);
    });
});
