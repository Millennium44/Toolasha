/** @vitest-environment happy-dom
 *
 * Tests for the marketplace sort's alchemy modes.
 *
 * The arithmetic is not here and is not tested here — it belongs to
 * `alchemy-profit-calculator.js`, which has its own tests. What these cover is
 * everything the sorter adds around it: that the best-paying alchemy action
 * wins the tile, that an item nothing can be done with sinks to the bottom
 * bare rather than claiming a zero, that the badge says what the engine said,
 * that the flow is priced insta-buy/insta-sell whatever the global setting is,
 * and that the chosen mode survives being chosen.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const engine = vi.hoisted(() => ({
    // itemHrid → { coinify, decompose, transmute } of profit data or null
    answers: {},
    pricingModes: [],
    settings: { marketSort: true, marketSort_mode: 'profit' },
    writes: [],
    gatheringProfit: null,
    gameData: { itemDetailMap: {}, actionDetailMap: {} },
    marketListeners: new Set(),
    marketOnCalls: 0,
    marketOffCalls: 0,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => engine.settings[key],
        getSettingValue: (key, fallback = null) => engine.settings[key] ?? fallback,
        setSettingValue: (key, value) => {
            engine.settings[key] = value;
            engine.writes.push([key, value]);
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => engine.gameData,
    },
}));

vi.mock('../../api/marketplace.js', () => ({
    default: {
        lastFetchTimestamp: 1000,
        on: (callback) => {
            engine.marketListeners.add(callback);
            engine.marketOnCalls += 1;
        },
        off: (callback) => {
            engine.marketListeners.delete(callback);
            engine.marketOffCalls += 1;
        },
        emitPricePatch: () => {
            for (const callback of [...engine.marketListeners]) callback();
        },
    },
}));

// Production and gathering profit are the other mode's business
vi.mock('./profit-calculator.js', () => ({ default: { calculateProfit: async () => null } }));
vi.mock('../actions/gathering-profit.js', () => ({ calculateGatheringProfit: async () => engine.gatheringProfit }));

vi.mock('./alchemy-profit-calculator.js', () => {
    const answer = (itemHrid, action) => engine.answers[itemHrid]?.[action] ?? null;
    return {
        default: {
            calculateCoinifyProfit: (itemHrid) => answer(itemHrid, 'coinify'),
            calculateDecomposeProfit: (itemHrid) => answer(itemHrid, 'decompose'),
            calculateTransmuteProfit: (itemHrid) => answer(itemHrid, 'transmute'),
        },
    };
});

vi.mock('../../utils/market-data.js', () => ({
    withProfitPricingMode: (mode, fn) => {
        engine.pricingModes.push(mode);
        return fn();
    },
}));

const { default: marketSort, SORT_MODES, getSortMode, isAlchemyMode } = await import('./market-sort.js');

/**
 * A calculator answer, in the shape the sorter reads off it.
 * @param {number} perAction - Profit per action
 * @param {number} perHour - Profit per hour
 * @returns {Object} A minimal profit-data object
 */
function priced(perAction, perHour) {
    return { profitPerAction: perAction, profitPerHour: perHour, winningCatalystHrid: null };
}

/**
 * Build a marketplace grid holding the given items, in the given order.
 * @param {Array<string>} names - Item names, as they appear in the sprite href
 * @returns {HTMLElement} The market items container
 */
function buildGrid(names) {
    document.body.innerHTML = '';
    const container = document.createElement('div');
    container.className = 'MarketplacePanel_marketItems__abc';
    for (const name of names) {
        const tile = document.createElement('div');
        tile.className = 'Item_itemContainer__xyz';
        tile.innerHTML = `<svg><use href="/static/media/items_sprite.svg#${name}"></use></svg>`;
        container.appendChild(tile);
    }
    document.body.appendChild(container);
    return container;
}

/**
 * The sprite names of the grid's tiles, in DOM order.
 * @param {HTMLElement} container - The market items container
 * @returns {Array<string>} Item names
 */
function order(container) {
    return Array.from(container.querySelectorAll('div[class*="Item_itemContainer"]')).map(
        (tile) => tile.querySelector('use').getAttribute('href').split('#')[1]
    );
}

/**
 * The badge text on each tile, in DOM order — null where no badge was drawn.
 * @param {HTMLElement} container - The market items container
 * @returns {Array<string|null>} Badge texts
 */
function badges(container) {
    return Array.from(container.querySelectorAll('div[class*="Item_itemContainer"]')).map(
        (tile) => tile.querySelector('.toolasha-profit-indicator')?.textContent ?? null
    );
}

beforeEach(() => {
    marketSort.disable();
    engine.answers = {};
    engine.pricingModes = [];
    engine.writes = [];
    engine.settings = { marketSort: true, marketSort_mode: 'profit' };
    engine.gatheringProfit = null;
    engine.gameData = { itemDetailMap: {}, actionDetailMap: {} };
    engine.marketListeners.clear();
    engine.marketOnCalls = 0;
    engine.marketOffCalls = 0;

    marketSort.clearCaches();
    marketSort.originalOrder = [];
    marketSort.hasSorted = false;
    marketSort.hasCapturedOrder = false;
    marketSort.sortDirection = 'desc';
    marketSort.sortMode = 'profit';
    marketSort.sortButton = null;
    marketSort.modeSelect = null;
    marketSort.isInitialized = false;
});

describe('sort modes', () => {
    test('offers exactly one absolute alchemy mode and one per-hour variant', () => {
        expect(SORT_MODES.map((mode) => mode.value)).toEqual(['profit', 'alchemyProfit', 'alchemyProfitPerHour']);
        expect(SORT_MODES.filter((mode) => mode.metric !== null)).toHaveLength(2);
    });

    test('production profit stays the default', () => {
        expect(SORT_MODES[0].value).toBe('profit');
        expect(isAlchemyMode('profit')).toBe(false);
        expect(isAlchemyMode('alchemyProfit')).toBe(true);
    });

    test('an unknown mode falls back to the default rather than sorting by nothing', () => {
        expect(getSortMode('nonsense').value).toBe('profit');
        expect(getSortMode(undefined).value).toBe('profit');
    });
});

describe('alchemy ranking', () => {
    test('ranks by alchemy profit and sinks the unpriceable to the bottom', async () => {
        const container = buildGrid(['item_a', 'item_b', 'item_c']);
        engine.answers = {
            '/items/item_a': { transmute: priced(100, 1000) },
            '/items/item_b': {},
            '/items/item_c': { transmute: priced(300, 900) },
        };

        marketSort.sortMode = 'alchemyProfit';
        await marketSort.sortByProfitability();

        expect(order(container)).toEqual(['item_c', 'item_a', 'item_b']);
    });

    test('picks the best-paying alchemy action for each item', async () => {
        buildGrid(['item_a']);
        engine.answers = {
            '/items/item_a': {
                coinify: priced(10, 10),
                decompose: priced(500, 20),
                transmute: priced(80, 5000),
            },
        };

        marketSort.sortMode = 'alchemyProfit';
        expect(marketSort.bestAlchemyCandidate('/items/item_a', 'profitPerAction').action).toBe('decompose');

        // The per-hour mode is allowed to prefer a different action on the same item
        expect(marketSort.bestAlchemyCandidate('/items/item_a', 'profitPerHour').action).toBe('transmute');
    });

    test('the per-hour mode ranks by the per-hour figure, not the per-item one', async () => {
        const container = buildGrid(['item_a', 'item_c']);
        engine.answers = {
            '/items/item_a': { transmute: priced(100, 9000) },
            '/items/item_c': { transmute: priced(300, 90) },
        };

        marketSort.sortMode = 'alchemyProfitPerHour';
        await marketSort.sortByProfitability();

        expect(order(container)).toEqual(['item_a', 'item_c']);
    });

    test('ascending puts the worst first but still leaves the unpriceable last', async () => {
        const container = buildGrid(['item_a', 'item_b', 'item_c']);
        engine.answers = {
            '/items/item_a': { transmute: priced(100, 1) },
            '/items/item_b': {},
            '/items/item_c': { transmute: priced(300, 1) },
        };

        marketSort.sortMode = 'alchemyProfit';
        marketSort.sortDirection = 'asc';
        await marketSort.sortByProfitability();

        expect(order(container)).toEqual(['item_a', 'item_c', 'item_b']);
    });

    test('a calculator that throws costs that item its figure, not the sort', async () => {
        const container = buildGrid(['item_a', 'item_b']);
        engine.answers = {
            '/items/item_a': { transmute: priced(100, 1) },
            get '/items/item_b'() {
                throw new Error('no such item');
            },
        };

        marketSort.sortMode = 'alchemyProfit';
        await marketSort.sortByProfitability();

        expect(order(container)).toEqual(['item_a', 'item_b']);
    });
});

describe('badges', () => {
    test('shows the engine figure in K/M/B, and nothing at all where there is none', async () => {
        const container = buildGrid(['item_a', 'item_b', 'item_c']);
        engine.answers = {
            '/items/item_a': { transmute: priced(2_500_000, 1) },
            '/items/item_b': {},
            '/items/item_c': { decompose: priced(-1200, 1) },
        };

        marketSort.sortMode = 'alchemyProfit';
        await marketSort.sortByProfitability();

        // Sorted: item_a (2.5M), item_c (-1.2K), item_b (nothing)
        expect(badges(container)).toEqual(['+2.5M', '-1.2K', null]);
    });

    test('the badge names the action it is quoting', async () => {
        const container = buildGrid(['item_a']);
        engine.answers = { '/items/item_a': { decompose: priced(400, 1) } };

        marketSort.sortMode = 'alchemyProfit';
        await marketSort.sortByProfitability();

        const badge = container.querySelector('.toolasha-profit-indicator');
        expect(badge.title).toContain('decompose');
        expect(badge.title).toContain('insta-sell at bid');
    });
});

describe('pricing', () => {
    test('quotes the insta flow regardless of the global pricing mode', async () => {
        buildGrid(['item_a']);
        engine.answers = { '/items/item_a': { transmute: priced(100, 1) } };
        engine.settings.profitCalc_pricingMode = 'optimistic';

        marketSort.sortMode = 'alchemyProfit';
        await marketSort.sortByProfitability();

        expect(engine.pricingModes).toContain('conservative');
    });

    test('the production mode does not pin the pricing mode at all', async () => {
        buildGrid(['item_a']);

        marketSort.sortMode = 'profit';
        await marketSort.sortByProfitability();

        expect(engine.pricingModes).toEqual([]);
    });
});

describe('gathering prices', () => {
    test('an incompletely priced gathering result has no ranking value', async () => {
        engine.gameData.actionDetailMap = {
            '/actions/foraging/apple': {
                type: '/action_types/foraging',
                dropTable: [{ itemHrid: '/items/apple', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        };
        engine.gatheringProfit = { profitPerHour: 800, hasMissingPrices: true };

        await expect(marketSort.calculateItemProfit('/items/apple', engine.gameData)).resolves.toEqual({
            profit: null,
            detail: null,
        });
    });
});

describe('caching', () => {
    test('prices an item once per sort run, however many times it is sorted', async () => {
        buildGrid(['item_a', 'item_a']);
        let calls = 0;
        Object.defineProperty(engine.answers, '/items/item_a', {
            configurable: true,
            get() {
                calls += 1;
                return { transmute: priced(100, 1) };
            },
        });

        marketSort.sortMode = 'alchemyProfit';
        await marketSort.sortByProfitability();
        await marketSort.sortByProfitability();

        // Three calculator methods asked, once, for the one distinct item
        expect(calls).toBe(3);
    });

    test('market price patches invalidate null results so a repaired quote ranks on the next sort', async () => {
        const container = buildGrid(['apple']);
        engine.gameData.actionDetailMap = {
            '/actions/foraging/apple': {
                type: '/action_types/foraging',
                dropTable: [{ itemHrid: '/items/apple', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        };
        let calculations = 0;
        engine.gatheringProfit = { profitPerHour: 800, hasMissingPrices: true };
        const originalCalculateItemProfit = marketSort.calculateItemProfit.bind(marketSort);
        vi.spyOn(marketSort, 'calculateItemProfit').mockImplementation(async (...args) => {
            calculations += 1;
            return originalCalculateItemProfit(...args);
        });
        marketSort.initialize();
        await marketSort.sortByProfitability();

        expect(marketSort.profitCache.get('profit:/items/apple')).toEqual({ profit: null, detail: null });
        expect(badges(container)).toEqual(['—']);

        engine.gatheringProfit = { profitPerHour: 12_000, hasMissingPrices: false };
        const marketplace = (await import('../../api/marketplace.js')).default;
        marketplace.emitPricePatch();
        await marketSort.sortByProfitability();

        expect(calculations).toBe(2);
        expect(marketSort.profitCache.get('profit:/items/apple')).toEqual({ profit: 12_000, detail: null });
        expect(badges(container)).toEqual(['+12K']);
        marketSort.disable();
        expect(engine.marketListeners.size).toBe(0);
        expect(engine.marketOffCalls).toBe(1);
    });

    test('an in-flight old calculation cannot repopulate the cache after a market patch', async () => {
        const container = buildGrid(['apple']);
        engine.gameData.actionDetailMap = {
            '/actions/foraging/apple': {
                type: '/action_types/foraging',
                dropTable: [{ itemHrid: '/items/apple', dropRate: 1, minCount: 1, maxCount: 1 }],
            },
        };
        let resolveOld;
        engine.gatheringProfit = new Promise((resolve) => {
            resolveOld = resolve;
        });
        marketSort.initialize();
        const pendingSort = marketSort.sortByProfitability();
        await Promise.resolve();
        await Promise.resolve();

        const marketplace = (await import('../../api/marketplace.js')).default;
        marketplace.emitPricePatch();
        resolveOld({ profitPerHour: 100, hasMissingPrices: false });
        await pendingSort;

        expect(marketSort.profitCache.has('profit:/items/apple')).toBe(false);
        expect(badges(container)).toEqual([null]);
    });
});

describe('persistence', () => {
    test('a mode change is written to settings', () => {
        marketSort.handleModeChange('alchemyProfit');
        expect(engine.writes).toEqual([['marketSort_mode', 'alchemyProfit']]);
        expect(marketSort.sortMode).toBe('alchemyProfit');
    });

    test('the saved mode is what the sorter starts in', () => {
        engine.settings.marketSort_mode = 'alchemyProfitPerHour';
        marketSort.initialize();
        expect(marketSort.sortMode).toBe('alchemyProfitPerHour');
    });

    test('a saved mode that no longer exists degrades to the default', () => {
        engine.settings.marketSort_mode = 'retiredMode';
        marketSort.initialize();
        expect(marketSort.sortMode).toBe('profit');
    });

    test('changing mode clears the previous mode badges and restarts the direction toggle', async () => {
        const container = buildGrid(['item_a']);
        engine.answers = { '/items/item_a': { transmute: priced(100, 1) } };

        marketSort.sortMode = 'alchemyProfit';
        await marketSort.sortByProfitability();
        expect(badges(container)).toEqual(['+100']);

        marketSort.handleModeChange('alchemyProfitPerHour');
        expect(badges(container)).toEqual([null]);
        expect(marketSort.sortDirection).toBe('desc');
        expect(marketSort.hasSorted).toBe(false);
    });
});
