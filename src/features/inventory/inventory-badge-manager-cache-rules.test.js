/**
 * Inventory Badge Manager - the enhancement costs it shares with net worth.
 *
 * Both surfaces read and write the same networth-cache entries under the same keys, so the badges
 * must follow net worth's rules: an untradable cape is costed on the valuation bench and never
 * cached, a path with an unpriced material is no figure and is never cached, and a usable partial
 * bill is cached with its flag. A path that cannot be built is remembered across passes until the
 * pricing fingerprint moves.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initData: null,
    settings: {},
    pathCalls: [],
    paths: {},
    fingerprint: 'fp-1',
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
        getItemDetails: (hrid) => mocks.initData?.itemDetailMap?.[hrid],
        getInventory: () => [],
        getCurrentCharacterId: () => 'char-1',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: (hrid, level, params) => {
        mocks.pathCalls.push({ hrid, level, bench: params.bench });
        return mocks.paths[hrid] ?? null;
    },
}));
vi.mock('../enhancement/enhancement-params-source.js', () => ({
    enhancementParamsFor: () => ({ bench: 'valuation' }),
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({ bench: 'sim' }) }));
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
    getItemPrice: () => {
        mocks.craftPriceCalls++;
        return 10;
    },
}));
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

const { default: inventoryBadgeManager } = await import('./inventory-badge-manager.js');
const { default: networthCache } = await import('../networth/networth-cache.js');

const CAPE = '/items/artificer_cape';
const SWORD = '/items/sword';
const BACK = { equipmentDetail: { type: '/equipment_types/back' }, isTradable: false };

const pass = () => ({ enhancementCosts: new Map(), validated: false, failedPaths: null });

beforeEach(() => {
    mocks.initData = {
        itemDetailMap: {
            [CAPE]: { name: 'Artificer Cape', ...BACK },
            [SWORD]: { name: 'Sword', isTradable: true, equipmentDetail: { type: '/equipment_types/main_hand' } },
        },
    };
    mocks.settings = {};
    mocks.pathCalls = [];
    mocks.paths = {};
    mocks.fingerprint = 'fp-1';
    networthCache.clear();
    inventoryBadgeManager._failedPaths = null;
    inventoryBadgeManager._pricingFingerprint = () => mocks.fingerprint;
});

describe('enhancementCostFor shares net worth cache rules', () => {
    test('an untradable cape at +5 is costed on the valuation bench and never cached', () => {
        mocks.paths[CAPE] = { optimalStrategy: { totalCost: 7000 } };
        expect(inventoryBadgeManager.enhancementCostFor(CAPE, 5, pass())).toBe(7000);
        expect(mocks.pathCalls[0].bench).toBe('valuation');
        expect(networthCache.get(CAPE, 5)).toBeNull();
    });

    test('a cape figure in the shared cache is not read back by the badge', () => {
        networthCache.set(CAPE, 5, 1, false);
        mocks.paths[CAPE] = { optimalStrategy: { totalCost: 7000 } };
        expect(inventoryBadgeManager.enhancementCostFor(CAPE, 5, pass())).toBe(7000);
    });

    test('a tradable piece uses the simulator bench and is cached with its partial flag', () => {
        mocks.paths[SWORD] = { optimalStrategy: { totalCost: 500 }, inputsPartial: true };
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 15, pass())).toBe(500);
        expect(mocks.pathCalls[0].bench).toBe('sim');
        expect(networthCache.get(SWORD, 15)).toBe(500);
        expect(networthCache.isPartial(SWORD, 15)).toBe(true);
    });

    test('a path with an unpriced material is no figure and is not cached', () => {
        mocks.paths[SWORD] = { optimalStrategy: { totalCost: 500 }, pricesPartial: true };
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 15, pass())).toBeNull();
        expect(networthCache.get(SWORD, 15)).toBeNull();
    });
});

describe('failed enhancement paths', () => {
    test('are not searched again by the next pass while the fingerprint holds', () => {
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 7, pass())).toBeNull();
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 7, pass())).toBeNull();
        expect(mocks.pathCalls).toHaveLength(1);
    });

    test('are retried once the fingerprint moves', () => {
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 7, pass())).toBeNull();
        mocks.fingerprint = 'fp-2';
        mocks.paths[SWORD] = { optimalStrategy: { totalCost: 900 } };
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 7, pass())).toBe(900);
        expect(mocks.pathCalls).toHaveLength(2);
    });

    test('are kept only for the pass when the fingerprint cannot be watched', () => {
        mocks.fingerprint = null;
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 7, pass())).toBeNull();
        expect(inventoryBadgeManager.enhancementCostFor(SWORD, 7, pass())).toBeNull();
        expect(mocks.pathCalls).toHaveLength(2);
    });
});
