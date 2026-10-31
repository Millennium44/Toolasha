/** @vitest-environment happy-dom */
/**
 * The unenhanced-gear crafting-cost fallback of the inventory badge: the character's real Artisan
 * bonus (none: x1), acquisition priced on the buy side, and a bill with an unpriced input is not a quote.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initData: null,
    inventory: [],
    priceBatch: new Map(),
    settings: {},
    pathCalls: new Map(),
    craftPriceCalls: 0,
    evCalls: 0,
    batchCalls: 0,
    artisan: 0,
    prices: {},
    lastCalls: [],
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, onReady: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mocks.settings[key] ?? false,
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        isFeatureEnabled: () => true,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../utils/market-values.js', () => ({
    refreshMarketValues: () => {},
    marketValueFor: () => null,
    reconcileBook: (ask, bid) => ({ ask, bid }),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPricesBatch: () => {
            mocks.batchCalls++;
            return mocks.priceBatch;
        },
        getPrice: () => null,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getInventory: () => mocks.inventory,
        getCurrentCharacterId: () => 'char-1',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: (hrid, level) => {
        const key = `${hrid}:${level}`;
        mocks.pathCalls.set(key, (mocks.pathCalls.get(key) || 0) + 1);
        // The shield has no usable path at all (an item nothing prices the inputs of)
        if (hrid === '/items/broken_shield') return null;
        return { optimalStrategy: { totalCost: 1000 * level } };
    },
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({ enhancingLevel: 100 }) }));
vi.mock('../networth/networth-cache-validation.js', () => ({ validateNetworthCache: () => {} }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        isInitialized: true,
        calculateExpectedValue: () => {
            mocks.evCalls++;
            return { expectedValue: 500 };
        },
    },
}));
vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid, opts) => {
        mocks.lastCalls.push({ hrid, opts });
        return mocks.prices[hrid] ?? 0;
    },
}));
vi.mock('../../utils/artisan-bonus.js', () => ({ getArtisanBonus: () => mocks.artisan }));
vi.mock('../../utils/number-parser.js', () => ({
    parseItemCount: (text) => parseInt(text, 10) || 0,
}));
vi.mock('../../utils/dungeon-keys.js', () => ({ DUNGEON_CHEST_CHEST_KEYS: {} }));
vi.mock('../../utils/token-valuation.js', () => ({
    DUNGEON_TOKEN_HRIDS: new Set(),
    calculateDungeonTokenValue: () => null,
}));
vi.mock('../../utils/guild-credit-pricing.js', () => ({ buildGoldPerCredit: () => ({}) }));
vi.mock('../../utils/key-cost.js', () => ({ getKeyUnitCost: () => 0 }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));
vi.mock('../../utils/background-work.js', () => ({ yieldToEventLoop: () => Promise.resolve() }));

const { default: manager } = await import('./inventory-badge-manager.js');

const action = {
    type: '/action_types/cheesesmithing',
    inputItems: [
        { itemHrid: '/items/a', count: 2 },
        { itemHrid: '/items/b', count: 1 },
    ],
    upgradeItemHrid: '/items/base',
    outputItems: [{ itemHrid: '/items/sword', count: 1 }],
};

describe('badge craft-cost fallback', () => {
    beforeEach(() => {
        mocks.initData = { actionDetailMap: { '/actions/x': action } };
        mocks.artisan = 0;
        mocks.prices = { '/items/a': 30, '/items/b': 40, '/items/base': 500 };
        mocks.lastCalls = [];
    });

    const cost = () => manager.calculateCraftingCost('/items/sword', manager.buildCraftIndex());

    test('no Artisan tea means no reduction (inputs 100 + upgrade 500)', () => {
        expect(cost()).toBe(600);
    });

    test('the real Artisan bonus is applied to the inputs only', () => {
        mocks.artisan = 0.1129;
        expect(cost()).toBeCloseTo(100 * (1 - 0.1129) + 500, 6);
    });

    test('acquisition inputs are priced on the buy side', () => {
        cost();
        expect(mocks.lastCalls.length).toBe(3);
        for (const call of mocks.lastCalls) expect(call.opts).toEqual({ mode: 'ask', side: 'buy' });
    });

    test('an unpriced input makes the bill unquotable instead of a zero-filled lower bound', () => {
        mocks.prices['/items/b'] = 0;
        expect(cost()).toBe(0);
    });

    test('an unpriced upgrade item makes the bill unquotable', () => {
        mocks.prices['/items/base'] = 0;
        expect(cost()).toBe(0);
    });
});
