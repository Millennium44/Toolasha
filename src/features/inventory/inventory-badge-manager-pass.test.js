/** @vitest-environment happy-dom */
/**
 * Inventory Badge Manager — what one full pricing pass costs, and what a second pass over unchanged
 * inputs does. A large enhanced inventory used to recompute every enhancement path on every pass
 * (the shared cost cache was smaller than the inventory, so a pass in tile order evicted each entry
 * before the next pass read it), and every pass rewrote every tile's data attributes and badge text
 * even when nothing had changed.
 *
 * The real net-worth cost cache is used here, not a mock: its eviction is what this is about.
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

const INV = '/item_locations/inventory';

/**
 * An inventory tile the way the game draws one: icon sprite, count, and an enhancement level when nonzero.
 * @param {string} hrid
 * @param {number} count
 * @param {number} level
 * @returns {HTMLElement}
 */
function tile(hrid, count, level = 0) {
    const el = document.createElement('div');
    el.className = 'Item_itemContainer__x';
    const inner = document.createElement('div');
    inner.className = 'Item_item__x';
    el.appendChild(inner);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('xlink:href', `/static/media/items_sprite.svg#${hrid.slice('/items/'.length)}`);
    svg.appendChild(use);
    inner.appendChild(svg);
    const countEl = document.createElement('div');
    countEl.className = 'Item_count__x';
    countEl.textContent = String(count);
    inner.appendChild(countEl);
    const enh = document.createElement('div');
    enh.className = 'Item_enhancementLevel__x';
    enh.textContent = level > 0 ? `+${level}` : '';
    inner.appendChild(enh);
    return el;
}

/**
 * A 558-tile inventory: 180 distinct enhanced pieces whose bid side is empty (each priced by its
 * enhancement cost), three identical +15 swords, an enhanced piece no path can price, unpriced
 * unenhanced gear (crafting cost), openable chests, an unpriced resource, and priced resources.
 */
function buildInventory() {
    const itemDetailMap = {};
    const inventory = [];
    const tiles = [];
    const priceBatch = new Map();
    const actionDetailMap = {};
    const add = (hrid, count, level, details, price) => {
        itemDetailMap[hrid] = { name: hrid.slice(7), ...details };
        inventory.push({ itemHrid: hrid, itemLocationHrid: INV, count, enhancementLevel: level });
        tiles.push(tile(hrid, count, level));
        if (price) priceBatch.set(`${hrid}:${level}`, price);
    };
    for (let i = 0; i < 180; i++) {
        add(`/items/gear_${i}`, 1, 5, { equipmentDetail: { type: '/equipment_types/body' } }, { ask: 9000, bid: null });
    }
    // Three tiles of the same +15 piece: one cost, not three
    for (let i = 0; i < 3; i++) {
        add('/items/sword', 1, 15, { equipmentDetail: { type: '/equipment_types/main_hand' } }, null);
    }
    inventory.splice(-2, 2); // the game lists a stack once; the extra tiles share its lookup key
    add('/items/broken_shield', 1, 7, { equipmentDetail: { type: '/equipment_types/off_hand' } }, null);
    for (let i = 0; i < 20; i++) {
        const hrid = `/items/plain_gear_${i}`;
        add(hrid, 1, 0, { equipmentDetail: { type: '/equipment_types/feet' } }, null);
        actionDetailMap[`/actions/craft/${i}`] = {
            inputItems: [{ itemHrid: '/items/res_0', count: 3 }],
            outputItems: [{ itemHrid: hrid, count: 1 }],
        };
    }
    for (let i = 0; i < 5; i++) {
        add(`/items/chest_${i}`, 3, 0, { isOpenable: true }, null);
    }
    add('/items/unpriced_thing', 4, 0, {}, null);
    while (tiles.length < 558) {
        const i = tiles.length;
        add(`/items/res_${i}`, 10 + i, 0, {}, { ask: 100 + i, bid: 90 + i });
    }
    // Filler so the action scan is the length of the real one
    for (let i = 0; i < 1000; i++) {
        actionDetailMap[`/actions/other/${i}`] = { outputItems: [{ itemHrid: `/items/other_${i}`, count: 1 }] };
    }
    return { itemDetailMap, inventory, tiles, priceBatch, actionDetailMap };
}

let fixture;

beforeEach(() => {
    fixture = buildInventory();
    mocks.initData = { itemDetailMap: fixture.itemDetailMap, actionDetailMap: fixture.actionDetailMap };
    mocks.inventory = fixture.inventory;
    mocks.priceBatch = fixture.priceBatch;
    mocks.settings = { networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 13 };
    mocks.pathCalls = new Map();
    mocks.craftPriceCalls = 0;
    mocks.evCalls = 0;
    mocks.batchCalls = 0;
    networthCache.clear();

    const inv = document.createElement('div');
    inv.className = 'Inventory_items__x';
    // Two category grids, the way the "All" tab draws them
    const half = Math.floor(fixture.tiles.length / 2);
    for (const part of [fixture.tiles.slice(0, half), fixture.tiles.slice(half)]) {
        const grid = document.createElement('div');
        grid.className = 'Inventory_itemGrid__x';
        part.forEach((t) => grid.appendChild(t));
        inv.appendChild(grid);
    }
    document.body.innerHTML = '';
    document.body.appendChild(inv);
    inventoryBadgeManager.currentInventoryElem = inv;
    inventoryBadgeManager.providers.clear();
    inventoryBadgeManager.invalidateCache();
    inventoryBadgeManager.lastCalculationTime = 0;
    inventoryBadgeManager.lastRenderTime = 0;
    inventoryBadgeManager.isRendering = false;
    inventoryBadgeManager.isCalculating = false;
    inventoryBadgeManager.rerenderRequested = false;
});

const totalPathCalls = () => [...mocks.pathCalls.values()].reduce((a, b) => a + b, 0);

/** A full pass the way an items_updated event drives one: caches invalidated, cooldowns open. */
async function pass() {
    inventoryBadgeManager.invalidateCache();
    inventoryBadgeManager.lastCalculationTime = 0;
    inventoryBadgeManager.lastRenderTime = 0;
    await inventoryBadgeManager.renderAllBadges();
}

describe('one pricing pass over a large enhanced inventory', () => {
    test('prices each item hrid and level at most once per pass', async () => {
        await pass();
        for (const [key, calls] of mocks.pathCalls) {
            expect(calls, key).toBe(1);
        }
        // The batch price lookup is one per pass, not one per category grid
        expect(mocks.batchCalls).toBe(1);
        // 20 crafted pieces, one input each: one price read per piece
        expect(mocks.craftPriceCalls).toBe(20);
    });

    test('a second pass over unchanged inputs recomputes no enhancement path', async () => {
        await pass();
        const first = totalPathCalls();
        expect(first).toBe(182); // 180 gear + sword + shield
        await pass();
        // Only the shield, which has no usable path to cache, is tried again
        expect(totalPathCalls() - first).toBeLessThanOrEqual(1);
    });

    test('a second pass leaves every figure as the first pass wrote it', async () => {
        await pass();
        const snapshot = fixture.tiles.map((t) => ({ ...t.dataset }));
        await pass();
        expect(fixture.tiles.map((t) => ({ ...t.dataset }))).toEqual(snapshot);
        // Spot-check the shapes every reader relies on
        const gear = fixture.tiles[0].dataset;
        expect([gear.askPrice, gear.bidPrice, gear.askValue, gear.bidValue]).toEqual(['9000', '5000', '9000', '5000']);
        expect(gear.expectPrice).toBe('gear_0');
        const sword = fixture.tiles[180].dataset;
        expect([sword.askPrice, sword.bidPrice]).toEqual(['15000', '15000']);
        expect(fixture.tiles[181].dataset.askPrice).toBe('15000');
        const shield = fixture.tiles[183].dataset;
        expect([shield.askPrice, shield.bidPrice, shield.expectPrice]).toEqual(['0', '0', 'broken_shield']);
        const plain = fixture.tiles[184].dataset;
        // 3 × 10 × 0.9 artisan
        expect(plain.askPrice).toBe('27');
        const chest = fixture.tiles[204].dataset;
        expect([chest.askPrice, chest.askValue]).toEqual(['500', '1500']);
        const unpriced = fixture.tiles[209].dataset;
        expect([unpriced.askValue, unpriced.expectPrice]).toEqual(['0', 'unpriced_thing']);
    });
});

describe('a pass over unchanged inputs writes nothing', () => {
    test('no tile attribute or badge is rewritten, and no further pass is queued', async () => {
        // A provider shaped like the price badges: it sets badge text from the dataset
        inventoryBadgeManager.registerProvider('test-badge', (el) => {
            let badge = el.querySelector('.mwi-stack-price');
            if (!badge) {
                badge = document.createElement('div');
                badge.className = 'mwi-stack-price';
                el.appendChild(badge);
            }
            const text = String(Math.round(parseFloat(el.dataset.askValue) || 0));
            if (badge.textContent !== text) badge.textContent = text;
        });
        await pass();

        const records = [];
        const observer = new MutationObserver((m) => records.push(...m));
        observer.observe(inventoryBadgeManager.currentInventoryElem, {
            subtree: true,
            childList: true,
            attributes: true,
            characterData: true,
        });
        await pass();
        await Promise.resolve();
        records.push(...observer.takeRecords());
        observer.disconnect();

        expect(records.map((r) => `${r.type}:${r.attributeName ?? ''}`)).toEqual([]);
        expect(inventoryBadgeManager.rerenderRequested).toBe(false);
        expect(inventoryBadgeManager.isRendering).toBe(false);
    });
});
