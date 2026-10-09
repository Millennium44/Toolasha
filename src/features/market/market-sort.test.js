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
    // itemHrid → details ({ equipmentDetail, alchemyDetail }) for the chain mode
    itemDetails: {},
    // itemHrid → bid price (the 'sell' side); absent = unpriced
    bids: {},
    // hrids whose price (either side) is a value-map estimate, not a book quote
    estimated: new Set(),
    // itemHrid → decompose results, one per catalyst/tea candidate
    candidates: {},
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
        getItemDetails: (hrid) => engine.itemDetails[hrid] ?? null,
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
            calculateCandidateResults: (action, itemHrid) => engine.candidates[itemHrid] ?? [],
        },
    };
});

vi.mock('../../utils/profit-helpers.js', () => ({ calculatePriceAfterTax: (price) => price * 0.96 }));

vi.mock('../../utils/market-data.js', () => ({
    getItemPrice: (hrid) => engine.bids[hrid] ?? null,
    getItemPriceInfo: (hrid) => ({
        price: engine.bids[hrid] ?? null,
        estimated: engine.estimated.has(hrid),
    }),
    isPriceEstimated: (hrid) => engine.estimated.has(hrid),
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
    engine.itemDetails = {};
    engine.bids = {};
    engine.estimated = new Set();
    engine.candidates = {};

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
    test('offers one absolute alchemy mode, one per-hour variant and the whole-chain mode', () => {
        expect(SORT_MODES.map((mode) => mode.value)).toEqual([
            'profit',
            'alchemyProfit',
            'alchemyProfitPerHour',
            'decomposeChainPerHour',
        ]);
        expect(SORT_MODES.filter((mode) => mode.metric !== null)).toHaveLength(3);
        expect(isAlchemyMode('decomposeChainPerHour')).toBe(true);
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

/**
 * A decompose calculator answer carrying only what the chain reads.
 * @param {number} ask - The input's ask price
 * @param {number} actionsPerHour - Units decomposed per hour
 * @returns {Object} A minimal decompose result
 */
function step(ask, actionsPerHour) {
    return {
        actionsPerHour,
        successRate: 1,
        requirementCosts: [{ itemHrid: '/items/x', count: 1, price: ask }],
        dropRevenues: [],
    };
}

/**
 * Item details for a piece of gear that decomposes into the given outputs.
 * @param {Array<Array>} outputs - [itemHrid, count] pairs
 * @returns {Object} Item details
 */
function gearDetails(outputs) {
    return {
        equipmentDetail: {},
        alchemyDetail: { decomposeItems: outputs.map(([itemHrid, count]) => ({ itemHrid, count })) },
    };
}

describe('decompose chain mode', () => {
    function twoLevel() {
        engine.itemDetails = {
            '/items/item_a': gearDetails([['/items/mid_b', 1]]),
            '/items/mid_b': gearDetails([['/items/term_c', 2]]),
            '/items/term_c': { alchemyDetail: null },
        };
        engine.answers = {
            '/items/item_a': { decompose: step(500, 3600) },
            '/items/mid_b': { decompose: step(300, 1800) },
        };
        engine.bids = { '/items/term_c': 1000 };
    }

    test('ranks by the whole chain per hour, terminals taxed, and pins conservative pricing', async () => {
        twoLevel();
        // A second item decomposing straight to the same terminal, slower per hour
        engine.itemDetails['/items/item_d'] = gearDetails([['/items/term_c', 2]]);
        engine.answers['/items/item_d'] = { decompose: step(500, 360) };
        const container = buildGrid(['item_d', 'item_a']);

        marketSort.sortMode = 'decomposeChainPerHour';
        await marketSort.sortByProfitability();

        expect(order(container)).toEqual(['item_a', 'item_d']);
        // item_a: 2 x 960 terminal - 500 ask = 1420 over 1s + 2s = 3s -> 1,704,000/hr
        expect(marketSort.profitCache.get('decomposeChainPerHour:/items/item_a').profit).toBeCloseTo(1_704_000);
        // item_d: (1920 - 500) over 10s
        expect(marketSort.profitCache.get('decomposeChainPerHour:/items/item_d').profit).toBeCloseTo(511_200);
        expect(engine.pricingModes).toContain('conservative');
        expect(badges(container)[0]).toBe('+1.7M');
        expect(container.querySelector('.toolasha-profit-indicator').title).toContain('decompose chain');
    });

    test('an item with no decompose has no value and sinks, bare', async () => {
        twoLevel();
        engine.itemDetails['/items/item_e'] = { alchemyDetail: null };
        const container = buildGrid(['item_e', 'item_a']);

        marketSort.sortMode = 'decomposeChainPerHour';
        await marketSort.sortByProfitability();

        expect(order(container)).toEqual(['item_a', 'item_e']);
        expect(badges(container)).toEqual(['+1.7M', null]);
    });

    test('an unpriced terminal leaves the item without a figure', async () => {
        twoLevel();
        engine.bids = {};
        buildGrid(['item_a']);

        marketSort.sortMode = 'decomposeChainPerHour';
        await marketSort.sortByProfitability();

        expect(marketSort.profitCache.get('decomposeChainPerHour:/items/item_a')).toEqual({
            profit: null,
            detail: null,
        });
    });

    test('a terminal with only an estimated bid is not insta-sellable, so the chain is unpriced', async () => {
        twoLevel();
        engine.estimated.add('/items/term_c');
        buildGrid(['item_a']);

        marketSort.sortMode = 'decomposeChainPerHour';
        await marketSort.sortByProfitability();

        expect(marketSort.profitCache.get('decomposeChainPerHour:/items/item_a').profit).toBeNull();
    });

    test('an estimated ask on the item itself leaves the chain unpriced', async () => {
        twoLevel();
        engine.estimated.add('/items/item_a');
        buildGrid(['item_a']);

        marketSort.sortMode = 'decomposeChainPerHour';
        await marketSort.sortByProfitability();

        expect(marketSort.profitCache.get('decomposeChainPerHour:/items/item_a').profit).toBeNull();
    });

    test('a step picks the setup that is best for the chain below it, not the seller pick', async () => {
        twoLevel();
        // The calculator's own (seller) answer for the middle gear: cheap but only half succeeds
        engine.answers['/items/mid_b'] = { decompose: { ...step(300, 1800), successRate: 0.5 } };
        // The candidate list also holds a catalyst setup: always succeeds, costs 100 per unit
        engine.candidates['/items/mid_b'] = [
            { ...step(300, 1800), successRate: 0.5 },
            { ...step(300, 1800), successRate: 1, catalystCostPerHour: 180_000 },
        ];
        buildGrid(['item_a']);

        marketSort.sortMode = 'decomposeChainPerHour';
        await marketSort.sortByProfitability();

        // 2 x 960 terminal - 500 ask - 100 catalyst = 1320 over 3s
        expect(marketSort.profitCache.get('decomposeChainPerHour:/items/item_a').profit).toBeCloseTo(1_584_000);
    });

    test('shares one calculator pass per piece of gear across tiles and sorts', async () => {
        twoLevel();
        engine.itemDetails['/items/item_f'] = gearDetails([['/items/mid_b', 1]]);
        engine.answers['/items/item_f'] = { decompose: step(500, 3600) };
        let midCalls = 0;
        const mid = engine.answers['/items/mid_b'];
        Object.defineProperty(engine.answers, '/items/mid_b', {
            configurable: true,
            get() {
                midCalls += 1;
                return mid;
            },
        });
        buildGrid(['item_a', 'item_f']);

        marketSort.sortMode = 'decomposeChainPerHour';
        await marketSort.sortByProfitability();
        await marketSort.sortByProfitability();

        expect(midCalls).toBe(1);
    });

    test('the mode persists, and an unknown stored value still falls back', () => {
        marketSort.handleModeChange('decomposeChainPerHour');
        expect(engine.writes).toEqual([['marketSort_mode', 'decomposeChainPerHour']]);

        marketSort.disable();
        engine.settings.marketSort_mode = 'decomposeChainPerHour';
        marketSort.initialize();
        expect(marketSort.sortMode).toBe('decomposeChainPerHour');

        marketSort.disable();
        engine.settings.marketSort_mode = 'retiredMode';
        marketSort.initialize();
        expect(marketSort.sortMode).toBe('profit');
    });
});
