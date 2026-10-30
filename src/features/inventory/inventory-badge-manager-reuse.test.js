/** @vitest-environment happy-dom */
/**
 * Inventory Badge Manager: a pass reuses the prices the last one wrote when nothing they were read
 * from has moved.
 *
 * One items_updated used to buy two full pricing passes (custom tabs forces one from its layout
 * pass, then Inventory Sort, the badge prices and the category totals ask for another), and an item
 * popper bought two more (one on open, one on close) though neither moves a price. A tile the last
 * pass priced, still showing the same sprite, count and level, priced from the same market version,
 * settings, inventory, value map and container values, keeps its figures; anything else is priced.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    initData: null,
    inventory: [],
    priceBatch: new Map(),
    settings: {},
    priceVersion: 1,
    evGeneration: 0,
    dataListeners: {},
    anySetting: null,
    popper: null,
}));

vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {}, onReady: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => mocks.settings[key] ?? false,
        getSettingValue: (key, fallback) => mocks.settings[key] ?? fallback,
        isFeatureEnabled: () => true,
        onSettingChange: () => () => {},
        onAnySettingChange: (cb) => {
            mocks.anySetting = cb;
            return () => {
                mocks.anySetting = null;
            };
        },
    },
}));
vi.mock('../../utils/market-values.js', () => ({
    refreshMarketValues: () => {},
    marketValueFor: () => null,
    reconcileBook: (ask, bid) => ({ ask, bid }),
}));
vi.mock('../../api/marketplace.js', () => ({
    default: {
        getPricesBatch: () => mocks.priceBatch,
        getPrice: () => null,
        get priceVersion() {
            return mocks.priceVersion;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => mocks.initData,
        getInventory: () => mocks.inventory,
        getCurrentCharacterId: () => 'char-1',
        on: (event, cb) => {
            mocks.dataListeners[event] = cb;
        },
        off: (event, cb) => {
            if (mocks.dataListeners[event] === cb) delete mocks.dataListeners[event];
        },
    },
}));
vi.mock('../enhancement/tooltip-enhancement.js', () => ({
    calculateEnhancementPath: (hrid, level) => ({ optimalStrategy: { totalCost: 1000 * level } }),
}));
vi.mock('../../utils/enhancement-config.js', () => ({ getEnhancingParams: () => ({ enhancingLevel: 100 }) }));
vi.mock('../networth/networth-cache-validation.js', () => ({ validateNetworthCache: () => {} }));
vi.mock('../market/expected-value-calculator.js', () => ({
    default: {
        isInitialized: true,
        get generation() {
            return mocks.evGeneration;
        },
        calculateExpectedValue: () => ({ expectedValue: 500 }),
    },
}));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 10 }));
vi.mock('../../utils/number-parser.js', () => ({ parseItemCount: (text) => parseInt(text, 10) || 0 }));
vi.mock('../../utils/dungeon-keys.js', () => ({ DUNGEON_CHEST_CHEST_KEYS: {} }));
vi.mock('../../utils/token-valuation.js', () => ({
    DUNGEON_TOKEN_HRIDS: new Set(),
    calculateDungeonTokenValue: () => null,
}));
vi.mock('../../utils/guild-credit-pricing.js', () => ({ buildGoldPerCredit: () => ({}) }));
vi.mock('../../utils/key-cost.js', () => ({ getKeyUnitCost: () => 0 }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({
    createMutationWatcher: (_target, cb) => {
        mocks.popper = cb;
        return () => {};
    },
}));
vi.mock('../../utils/background-work.js', () => ({ yieldToEventLoop: () => Promise.resolve() }));

const { default: inventoryBadgeManager } = await import('./inventory-badge-manager.js');
const { default: networthCache } = await import('../networth/networth-cache.js');

const INV = '/item_locations/inventory';

/**
 * An inventory tile the way the game draws one: icon sprite, count, and an enhancement level.
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

let tiles;
let grid;

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 9, 30, 12, 0, 0));
    const itemDetailMap = {};
    const inventory = [];
    const priceBatch = new Map();
    tiles = [];
    const add = (hrid, count, level, details, price) => {
        itemDetailMap[hrid] = { name: hrid.slice(7), ...details };
        inventory.push({ itemHrid: hrid, itemLocationHrid: INV, count, enhancementLevel: level });
        tiles.push(tile(hrid, count, level));
        if (price) priceBatch.set(`${hrid}:${level}`, price);
    };
    // Three tiles of one +15 piece (a stack listed once), a chest, an unpriced resource, priced ones
    for (let i = 0; i < 3; i++)
        add('/items/holy_sword', 1, 15, { equipmentDetail: { type: '/equipment_types/main_hand' } });
    inventory.splice(-2, 2);
    add('/items/purple_chest', 3, 0, { isOpenable: true }, null);
    add('/items/unpriced_thing', 4, 0, {}, null);
    for (let i = 0; i < 6; i++) add(`/items/res_${i}`, 10 + i, 0, {}, { ask: 100 + i, bid: 90 + i });

    mocks.initData = { itemDetailMap, actionDetailMap: {} };
    mocks.inventory = inventory;
    mocks.priceBatch = priceBatch;
    mocks.settings = { networth_highEnhancementUseCost: true, networth_highEnhancementMinLevel: 13 };
    mocks.priceVersion = 1;
    mocks.evGeneration = 0;
    networthCache.clear();

    const inv = document.createElement('div');
    inv.className = 'Inventory_items__x';
    grid = document.createElement('div');
    grid.className = 'Inventory_itemGrid__x';
    tiles.forEach((t) => grid.appendChild(t));
    inv.appendChild(grid);
    document.body.replaceChildren(inv);
    inventoryBadgeManager.initialize();
    inventoryBadgeManager.currentInventoryElem = inv;
    inventoryBadgeManager._lastPricing = null;
    inventoryBadgeManager.lastCalculationTime = 0;
    inventoryBadgeManager.lastRenderTime = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

/** Run one pricing pass past the cooldown, the way custom tabs forces one; count the tiles priced */
async function pricedTiles() {
    const spy = vi.spyOn(inventoryBadgeManager, 'getItemHridFromContainer');
    inventoryBadgeManager.lastCalculationTime = 0;
    await inventoryBadgeManager.calculatePricesForAllItems();
    const n = spy.mock.calls.length;
    spy.mockRestore();
    return n;
}

describe('a pass over unchanged inputs', () => {
    test('a forced pass right after a full one (custom tabs after the sort) prices no tile', async () => {
        expect(await pricedTiles()).toBe(tiles.length);
        const before = tiles.map((t) => ({ ...t.dataset }));
        expect(await pricedTiles()).toBe(0);
        // Every figure the first pass wrote stands
        expect(tiles.map((t) => ({ ...t.dataset }))).toEqual(before);
        expect(tiles[0].dataset.askValue).toBe('15000');
    });

    test('an items_updated prices every tile again', async () => {
        await pricedTiles();
        mocks.dataListeners.items_updated();
        expect(await pricedTiles()).toBe(tiles.length);
    });

    test('a pass right after an items_updated matches tiles against the new inventory', async () => {
        await pricedTiles();
        // The stack grows; the layout pass reacting to it runs before anything calls invalidateCache()
        mocks.inventory = mocks.inventory.map((item) =>
            item.itemHrid === '/items/holy_sword' ? { ...item, count: 2 } : item
        );
        for (const t of tiles.slice(0, 3)) t.querySelector('[class*="Item_count"]').textContent = '2';
        mocks.dataListeners.items_updated?.();
        await pricedTiles();
        expect(tiles[0].dataset.askValue).toBe(String(2 * 15000));
    });

    test('a tile whose count changed, or that React replaced, is priced; the rest are reused', async () => {
        await pricedTiles();
        tiles[4].querySelector('[class*="Item_count"]').textContent = '99';
        const replacement = tile('/items/res_3', 13, 0);
        grid.replaceChild(replacement, tiles[7]);
        expect(await pricedTiles()).toBe(2);
        expect(replacement.dataset.askValue).toBe(String(103 * 13));
    });

    test('a moved price, any setting, a reprice or new container values price every tile', async () => {
        await pricedTiles();
        mocks.priceVersion += 1;
        expect(await pricedTiles()).toBe(tiles.length);

        mocks.anySetting('invSort_netOfTax', true);
        expect(await pricedTiles()).toBe(tiles.length);

        // The game's value map reprices through its own forced pass
        const spy = vi.spyOn(inventoryBadgeManager, 'getItemHridFromContainer');
        inventoryBadgeManager.lastRenderTime = 0;
        mocks.dataListeners.market_item_values_updated();
        await vi.advanceTimersByTimeAsync(0);
        expect(spy.mock.calls.length).toBe(tiles.length);
        spy.mockRestore();

        mocks.evGeneration += 1;
        expect(await pricedTiles()).toBe(tiles.length);
        expect(await pricedTiles()).toBe(0);
    });

    test('past the backstop every tile is priced again', async () => {
        await pricedTiles();
        vi.advanceTimersByTime(29_000);
        expect(await pricedTiles()).toBe(0);
        vi.advanceTimersByTime(2_000);
        expect(await pricedTiles()).toBe(tiles.length);
    });

    test('a pass that failed leaves nothing to reuse', async () => {
        await pricedTiles();
        mocks.priceVersion += 1;
        const spy = vi.spyOn(inventoryBadgeManager, 'enhancementCostFor').mockImplementation(() => {
            throw new Error('boom');
        });
        await expect(inventoryBadgeManager.calculatePricesForAllItems(true)).rejects.toThrow('boom');
        spy.mockRestore();
        expect(await pricedTiles()).toBe(tiles.length);
    });

    test('a market without a version is never trusted', async () => {
        await pricedTiles();
        mocks.priceVersion = undefined;
        expect(await pricedTiles()).toBe(tiles.length);
        expect(await pricedTiles()).toBe(tiles.length);
    });
});

describe('item popper', () => {
    test('an open and a close together are one render, and it prices nothing', async () => {
        await pricedTiles();
        const render = vi.spyOn(inventoryBadgeManager, 'renderAllBadges');
        const priced = vi.spyOn(inventoryBadgeManager, 'getItemHridFromContainer');
        const popper = document.createElement('div');
        popper.className = 'MuiTooltip-popperInteractive';
        mocks.popper([{ addedNodes: [popper], removedNodes: [] }]);
        mocks.popper([{ addedNodes: [], removedNodes: [popper] }]);
        inventoryBadgeManager.lastRenderTime = 0;
        await vi.advanceTimersByTimeAsync(60);
        expect(render).toHaveBeenCalledTimes(1);
        expect(priced).not.toHaveBeenCalled();
    });
});
