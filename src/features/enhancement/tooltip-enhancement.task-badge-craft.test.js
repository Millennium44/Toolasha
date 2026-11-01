/**
 * An untradable task badge with no market price is priced by what it costs to make.
 *
 * Expert = 16 Task Crystal + an Advanced badge; Advanced = 4 crystal + a Basic badge; Basic = 1 crystal
 * (the recipes the game sends in actionDetailMap), so an Expert is 21 crystals and an Advanced 5. The
 * crystal is valued through the Task Tokens it costs. The base item, the protection choice, the mirror
 * route and the path's "Buy Item" line all go through one production cost, so it is fixed there.
 */

import { describe, test, expect, beforeAll, beforeEach, vi } from 'vitest';
import * as mathjs from 'mathjs';

const BASIC = '/items/basic_task_badge';
const ADVANCED = '/items/advanced_task_badge';
const EXPERT = '/items/expert_task_badge';
const CRYSTAL = '/items/task_crystal';
const CHEST = '/items/large_treasure_chest';
const MIRROR = '/items/philosophers_mirror';
const PROTECTION = '/items/mirror_of_protection';

const prices = vi.hoisted(() => ({}));
const state = vi.hoisted(() => ({ evReady: true, shop: {}, ev: {}, version: 0 }));

const recipe = (output, crystals, upgrade) => ({
    type: '/action_types/crafting',
    inputItems: [{ itemHrid: '/items/task_crystal', count: crystals }],
    outputItems: [{ itemHrid: output, count: 1 }],
    ...(upgrade ? { upgradeItemHrid: upgrade } : {}),
});

const gameData = {
    itemDetailMap: {
        [EXPERT]: {
            name: 'Expert Task Badge',
            itemLevel: 50,
            enhancementCosts: [{ itemHrid: '/items/coin', count: 1000 }],
        },
        [ADVANCED]: { name: 'Advanced Task Badge' },
        [BASIC]: { name: 'Basic Task Badge' },
        [CRYSTAL]: { name: 'Task Crystal' },
        '/items/loop_a': { name: 'Loop A' },
        '/items/odd_charm': { name: 'Odd Charm' },
        [CHEST]: { name: 'Large Treasure Chest', isOpenable: true },
        [MIRROR]: { name: "Philosopher's Mirror", sellPrice: 1 },
        [PROTECTION]: { name: 'Mirror of Protection', sellPrice: 1 },
    },
    actionDetailMap: {
        '/actions/crafting/basic_task_badge': recipe(BASIC, 1),
        '/actions/crafting/advanced_task_badge': recipe(ADVANCED, 4, BASIC),
        '/actions/crafting/expert_task_badge': recipe(EXPERT, 16, ADVANCED),
        // A recipe whose upgrade item is its own output
        '/actions/crafting/loop_a': recipe('/items/loop_a', 1, '/items/loop_a'),
        // Crafted from something nothing prices
        '/actions/crafting/odd_charm': {
            type: '/action_types/crafting',
            inputItems: [{ itemHrid: '/items/unknown_dust', count: 3 }],
            outputItems: [{ itemHrid: '/items/odd_charm', count: 1 }],
        },
    },
    get taskShopItemDetailMap() {
        return state.shop;
    },
};

vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => {
    const original = await importOriginal();
    const calc = await import('../market/expected-value-calculator.js');
    return { ...original, expectedValueCalculator: () => original.expectedValueCalculator() || calc.default };
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
    default: {
        on: () => {},
        get priceVersion() {
            return state.version;
        },
        getPrice: (hrid) => prices[hrid] || null,
    },
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
    getCustomPrice: () => null,
}));
// The test-server Tester shop is not a price source: a coin line for the badge must never be read
vi.mock('../../utils/game-lookups.js', () => ({ getShopCoinCost: () => 0 }));

let calculateEnhancementPath;
let buildEnhancementTooltipHTML;
let priceBase;
let priceGuarded;
let priceMirror;
let priceProtection;
let priceAtLevel;

beforeAll(async () => {
    globalThis.math = mathjs;
    ({ calculateEnhancementPath, buildEnhancementTooltipHTML } = await import('./tooltip-enhancement.js'));
    ({ priceBase, priceGuarded, priceMirror, priceProtection, priceAtLevel } =
        await import('../../utils/enhancement-input-pricing.js'));
});

const PER_TOKEN = 1_200_000 / 30;
const CRYSTAL_PRICE = 50 * PER_TOKEN;
const crystalLine = () => ({ itemHrid: CRYSTAL, cost: { itemHrid: '/items/task_token', count: 50 } });

beforeEach(() => {
    state.version++;
    state.evReady = true;
    state.shop = {
        chest: { itemHrid: CHEST, cost: { itemHrid: '/items/task_token', count: 30 } },
        crystal: crystalLine(),
    };
    state.ev = { [CHEST]: { expectedValue: 1_200_000, missingCount: 0, isPartial: false } };
    for (const key of Object.keys(prices)) delete prices[key];
    Object.assign(prices, {
        [MIRROR]: { ask: 20_000_000, bid: 19_000_000 },
        [PROTECTION]: { ask: 9_440_000, bid: 9_000_000 },
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

describe('an unlisted task badge costs what its crafting chain costs', () => {
    test('Expert is 21 crystals, Advanced 5, Basic 1, at the token value, flagged estimated', () => {
        expect(priceGuarded(EXPERT)).toMatchObject({ price: 21 * CRYSTAL_PRICE, unpriced: false, estimated: true });
        expect(priceGuarded(ADVANCED).price).toBe(5 * CRYSTAL_PRICE);
        expect(priceGuarded(BASIC).price).toBe(CRYSTAL_PRICE);
        expect(priceBase(EXPERT).price).toBe(21 * CRYSTAL_PRICE);
        expect(priceAtLevel(EXPERT, 0).price).toBe(21 * CRYSTAL_PRICE);
    });

    test('the badge itself competes as protection: chosen when cheaper than Mirror of Protection', () => {
        expect(priceProtection(EXPERT)).toMatchObject({ itemHrid: PROTECTION, price: 9_440_000 });
        prices[PROTECTION] = { ask: 90_000_000, bid: 89_000_000 };
        state.version++;
        expect(priceProtection(EXPERT)).toMatchObject({ itemHrid: EXPERT, price: 21 * CRYSTAL_PRICE });
    });

    test('the +9 to +10 path has a priced base and no unpriced-input warning', () => {
        const data = calculateEnhancementPath(EXPERT, 10, enhancingConfig);
        const html = buildEnhancementTooltipHTML(data, EXPERT);
        expect(data.optimalStrategy.totalCost).toBeGreaterThan(21 * CRYSTAL_PRICE);
        expect(html).not.toContain('Some inputs have no price');
        expect(priceMirror().price).toBe(20_000_000);
    });

    test('a token value that is itself a floor makes the chain partial', () => {
        state.ev[CHEST] = { expectedValue: 1_200_000, missingCount: 2, isPartial: true };
        expect(priceGuarded(EXPERT)).toMatchObject({ price: 21 * CRYSTAL_PRICE, partial: true });
    });

    test('a listed badge keeps its market price', () => {
        prices[EXPERT] = { ask: 5_000_000, bid: 4_800_000 };
        state.version++;
        expect(priceBase(EXPERT).price).toBe(5_000_000);
    });

    test.each([
        [
            'the shop does not sell the crystal',
            () => {
                delete state.shop.crystal;
            },
        ],
        [
            'the token has no value',
            () => {
                state.ev = {};
            },
        ],
        [
            'the value calculator is not ready',
            () => {
                state.evReady = false;
            },
        ],
    ])('stays unpriced, never 0, when %s; and prices once the value arrives', (_name, breakIt) => {
        breakIt();
        expect(priceGuarded(EXPERT)).toMatchObject({ price: null, unpriced: true });
        expect(priceBase(EXPERT)).toMatchObject({ price: null, unpriced: true });
        // Nothing was remembered: restoring the valuation prices it with no market movement
        state.evReady = true;
        state.shop.crystal = crystalLine();
        state.ev = { [CHEST]: { expectedValue: 1_200_000, missingCount: 0, isPartial: false } };
        expect(priceGuarded(EXPERT).price).toBe(21 * CRYSTAL_PRICE);
    });

    test('an untradable item crafted from inputs nothing prices stays unpriced', () => {
        expect(priceGuarded('/items/odd_charm')).toMatchObject({ price: null, unpriced: true });
    });

    test('a recipe cycle ends instead of looping, and is partial', () => {
        const priced = priceGuarded('/items/loop_a');
        expect(priced.price).toBe(CRYSTAL_PRICE);
        expect(priced.partial).toBe(true);
    });
});
