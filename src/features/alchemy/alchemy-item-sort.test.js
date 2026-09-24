/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

/** Handlers the module registered against `dataManager.on`, so a test can fire them like the game would */
const dataManagerEvents = vi.hoisted(() => new Map());
const dataManagerMock = vi.hoisted(() => ({
    on: (event, handler) => dataManagerEvents.set(event, handler),
    off: (event) => dataManagerEvents.delete(event),
    // Only itemLevel matters to xpValueFor(); the module reads it off this map by hrid
    getInitClientData: vi.fn(() => ({ itemDetailMap: {} })),
}));

/** Every profit answer a test wants, keyed the same way `calculateCoinifyProfit` etc. are called */
const profitAnswers = vi.hoisted(() => new Map());
const calculatorMock = vi.hoisted(() => ({
    calculateCoinifyProfit: vi.fn((itemHrid, enhancementLevel) =>
        profitAnswers.get(`coinify:${itemHrid}:${enhancementLevel ?? 0}`)
    ),
    calculateDecomposeProfit: vi.fn((itemHrid, enhancementLevel) =>
        profitAnswers.get(`decompose:${itemHrid}:${enhancementLevel ?? 0}`)
    ),
    calculateUnrefineProfit: vi.fn((itemHrid, enhancementLevel) =>
        profitAnswers.get(`unrefine:${itemHrid}:${enhancementLevel ?? 0}`)
    ),
    calculateTransmuteProfit: vi.fn((itemHrid) => profitAnswers.get(`transmute:${itemHrid}:0`)),
}));

const pinsMock = vi.hoisted(() => ({ pinnedFor: vi.fn(() => []) }));

/** calcXpPerAction is real math tested in alchemy-rankings.test.js; here it just needs to be deterministic */
const rankingsMock = vi.hoisted(() => ({
    calcXpPerAction: vi.fn((action, itemLevel, successRate) => (itemLevel + 1) * successRate),
}));

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => '#60a5fa' } }));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../market/alchemy-profit-calculator.js', () => ({ default: calculatorMock }));
vi.mock('./alchemy-item-pins.js', () => ({ default: pinsMock }));
vi.mock('./alchemy-rankings.js', () => rankingsMock);

const { default: alchemyItemSort } = await import('./alchemy-item-sort.js');

const TOGGLE_SELECTOR = '.mwi-alchemy-sort-toggle';
const RATE_SELECTOR = '.mwi-alchemy-sort-rate';

/** A tablist matching what `activeAlchemyAction()` looks for */
function buildTabs(selectedAction) {
    const tablist = document.createElement('div');
    tablist.setAttribute('role', 'tablist');
    for (const action of ['Coinify', 'Decompose', 'Transmute', 'Unrefine']) {
        const tab = document.createElement('div');
        tab.setAttribute('role', 'tab');
        tab.textContent = action;
        if (action.toLowerCase() === selectedAction) tab.setAttribute('aria-selected', 'true');
        tablist.appendChild(tab);
    }
    document.body.appendChild(tablist);
    return tablist;
}

/** One item tile, matching `Item_itemContainer` / the sprite `tileItemHrid` reads / `Item_enhancementLevel` */
function buildTile(itemHrid, enhancementLevel = 0) {
    const wrap = document.createElement('div');
    const tile = document.createElement('div');
    tile.className = 'Item_itemContainer_x';
    tile.innerHTML = `<svg><use href="#${itemHrid.replace('/items/', '')}"></use></svg>`;
    if (enhancementLevel > 0) {
        const badge = document.createElement('div');
        badge.className = 'Item_enhancementLevel_x';
        badge.textContent = `+${enhancementLevel}`;
        tile.appendChild(badge);
    }
    wrap.appendChild(tile);
    return wrap;
}

/** The alchemize picker: a primary selector container holding a portalled-in-place menu */
function buildPicker(tileSpecs) {
    const primary = document.createElement('div');
    primary.className = 'SkillActionDetail_primaryItemSelectorContainer_x';
    const menu = document.createElement('div');
    menu.className = 'ItemSelector_menu_x';
    const grid = document.createElement('div');
    for (const [itemHrid, enhancementLevel] of tileSpecs) {
        grid.appendChild(buildTile(itemHrid, enhancementLevel));
    }
    menu.appendChild(grid);
    primary.appendChild(menu);
    document.body.appendChild(primary);
    return { primary, menu, grid };
}

function tileHrids(grid) {
    return Array.from(grid.querySelectorAll('.Item_itemContainer_x')).map(
        (tile) => `/items/${tile.querySelector('use').getAttribute('href').slice(1)}`
    );
}

describe('alchemy item sort', () => {
    beforeEach(async () => {
        storageMock.reset();
        dataManagerEvents.clear();
        profitAnswers.clear();
        pinsMock.pinnedFor.mockReturnValue([]);
        calculatorMock.calculateCoinifyProfit.mockClear();
        calculatorMock.calculateDecomposeProfit.mockClear();
        calculatorMock.calculateUnrefineProfit.mockClear();
        calculatorMock.calculateTransmuteProfit.mockClear();
        dataManagerMock.getInitClientData.mockReturnValue({ itemDetailMap: {} });
        rankingsMock.calcXpPerAction.mockClear();
        alchemyItemSort.disable();
        document.body.innerHTML = '';
        await alchemyItemSort.initialize();
    });

    test('the toggle renders in the picker, defaulting to Game', () => {
        buildTabs('coinify');
        const { menu } = buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();

        const bar = menu.querySelector(TOGGLE_SELECTOR);
        expect(bar).toBeTruthy();
        const buttons = Array.from(bar.querySelectorAll('button'));
        expect(buttons.map((b) => b.dataset.mwiSortMode)).toEqual(['game', 'profit', 'xp']);
        expect(buttons[0].classList.contains('mwi-alchemy-sort-btn-active')).toBe(true);
        expect(buttons[1].classList.contains('mwi-alchemy-sort-btn-active')).toBe(false);
        expect(buttons[2].classList.contains('mwi-alchemy-sort-btn-active')).toBe(false);
    });

    test('default order is untouched: Game mode never reorders the tiles', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        const { grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();

        expect(tileHrids(grid)).toEqual(['/items/a', '/items/b']);
        expect(calculatorMock.calculateCoinifyProfit).not.toHaveBeenCalled();
    });

    test('profit order: pinned first, then best profit, unpriced last — and no NaN/undefined labels', () => {
        buildTabs('coinify');
        pinsMock.pinnedFor.mockReturnValue(['/items/pinned']);
        profitAnswers.set('coinify:/items/low:0', { profitPerHour: 50 });
        profitAnswers.set('coinify:/items/high:0', { profitPerHour: 500 });
        profitAnswers.set('coinify:/items/pinned:0', { profitPerHour: 1 });
        profitAnswers.set('coinify:/items/unpriced:0', null);
        const { menu, grid } = buildPicker([
            ['/items/low', 0],
            ['/items/unpriced', 0],
            ['/items/pinned', 0],
            ['/items/high', 0],
        ]);
        alchemyItemSort.apply();

        // Still Game order until the toggle is switched — with the pin first, as Pins itself orders it
        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/low', '/items/unpriced', '/items/high']);

        menu.querySelector('[data-mwi-sort-mode="profit"]').click();

        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/high', '/items/low', '/items/unpriced']);

        const rateTexts = Array.from(menu.querySelectorAll(RATE_SELECTOR)).map((el) => el.textContent);
        expect(rateTexts.length).toBe(3); // one per priced tile, none for the unpriced one
        for (const text of rateTexts) {
            expect(text).not.toContain('NaN');
            expect(text).not.toContain('undefined');
        }
        expect(grid.lastElementChild.querySelector(RATE_SELECTOR)).toBeNull();
    });

    test('enhanced tiles are priced at their own enhancement level (decompose)', () => {
        buildTabs('decompose');
        profitAnswers.set('decompose:/items/gear:0', { profitPerHour: 10 });
        profitAnswers.set('decompose:/items/gear:3', { profitPerHour: 900 });
        const { menu, grid } = buildPicker([
            ['/items/gear', 0],
            ['/items/gear', 3],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();

        const tiles = Array.from(grid.querySelectorAll('.Item_itemContainer_x'));
        // The +3 copy outranks the unenhanced one because it was costed separately
        expect(tiles[0].querySelector('.Item_enhancementLevel_x')?.textContent).toBe('+3');
    });

    test('the order choice is remembered per tab, not shared across tabs', async () => {
        buildTabs('coinify');
        const { menu: coinifyMenu } = buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();
        coinifyMenu.querySelector('[data-mwi-sort-mode="profit"]').click();
        await alchemyItemSort.flushOrderWrites();

        expect(alchemyItemSort.order).toEqual({ coinify: 'profit' });

        document.body.innerHTML = '';
        buildTabs('decompose');
        const { menu: decomposeMenu } = buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();

        const buttons = Array.from(decomposeMenu.querySelectorAll(`${TOGGLE_SELECTOR} button`));
        expect(
            buttons.find((b) => b.dataset.mwiSortMode === 'game').classList.contains('mwi-alchemy-sort-btn-active')
        ).toBe(true);
    });

    test('re-applies after the game redraws the tiles (Item Filter keystroke)', async () => {
        buildTabs('coinify');
        pinsMock.pinnedFor.mockReturnValue([]);
        profitAnswers.set('coinify:/items/low:0', { profitPerHour: 10 });
        profitAnswers.set('coinify:/items/high:0', { profitPerHour: 200 });
        const { menu, grid } = buildPicker([
            ['/items/low', 0],
            ['/items/high', 0],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(tileHrids(grid)).toEqual(['/items/high', '/items/low']);

        // The game's own filter narrows the tiles in place, out of order
        grid.innerHTML = '';
        grid.appendChild(buildTile('/items/low', 0));
        grid.appendChild(buildTile('/items/high', 0));

        await new Promise((resolve) => queueMicrotask(resolve));

        expect(tileHrids(grid)).toEqual(['/items/high', '/items/low']);
    });

    test('a market price refresh drops the cache, so the next reorder re-prices', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 10 });
        const { menu } = buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(calculatorMock.calculateCoinifyProfit).toHaveBeenCalledTimes(1);

        alchemyItemSort.apply();
        expect(calculatorMock.calculateCoinifyProfit).toHaveBeenCalledTimes(1); // cached, no re-price

        dataManagerEvents.get('market_item_values_updated')();
        alchemyItemSort.apply();
        expect(calculatorMock.calculateCoinifyProfit).toHaveBeenCalledTimes(2);
    });

    test('cleanup removes the toggle, rate labels and style element', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 10 });
        const { menu } = buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();

        expect(document.querySelector(TOGGLE_SELECTOR)).toBeTruthy();
        expect(document.querySelector(RATE_SELECTOR)).toBeTruthy();
        expect(document.getElementById('mwi-alchemy-sort-style')).toBeTruthy();

        alchemyItemSort.disable();

        expect(document.querySelector(TOGGLE_SELECTOR)).toBeNull();
        expect(document.querySelector(RATE_SELECTOR)).toBeNull();
        expect(document.getElementById('mwi-alchemy-sort-style')).toBeNull();
        expect(alchemyItemSort.isInitialized).toBe(false);
    });

    test('Profit -> Game restores the exact original sequence and removes labels', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        profitAnswers.set('coinify:/items/c:0', { profitPerHour: 50 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
            ['/items/c', 0],
        ]);
        alchemyItemSort.apply();
        const original = tileHrids(grid);

        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(tileHrids(grid)).toEqual(['/items/b', '/items/c', '/items/a']);
        expect(menu.querySelectorAll(RATE_SELECTOR).length).toBe(3);

        menu.querySelector('[data-mwi-sort-mode="game"]').click();

        expect(tileHrids(grid)).toEqual(original);
        expect(menu.querySelectorAll(RATE_SELECTOR).length).toBe(0);
        expect(
            menu.querySelector('[data-mwi-sort-mode="game"]').classList.contains('mwi-alchemy-sort-btn-active')
        ).toBe(true);
    });

    test('toggling repeatedly between Game and Profit is stable', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();
        const original = tileHrids(grid);

        for (let i = 0; i < 3; i++) {
            menu.querySelector('[data-mwi-sort-mode="profit"]').click();
            expect(tileHrids(grid)).toEqual(['/items/b', '/items/a']);
            menu.querySelector('[data-mwi-sort-mode="game"]').click();
            expect(tileHrids(grid)).toEqual(original);
            expect(menu.querySelectorAll(RATE_SELECTOR).length).toBe(0);
        }
    });

    test('game mode after a game redraw still does not price or label tiles', () => {
        // Regression: switching to Game must stop applying immediately, not just stop
        // ranking a stale tile set — a later game redraw (Item Filter keystroke) must
        // not trip the profit branch back on for brand-new tiles either.
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        menu.querySelector('[data-mwi-sort-mode="game"]').click();
        calculatorMock.calculateCoinifyProfit.mockClear();

        // The game's own filter redraws the tiles as brand-new elements
        grid.innerHTML = '';
        grid.appendChild(buildTile('/items/b', 0));
        grid.appendChild(buildTile('/items/a', 0));
        alchemyItemSort.apply();

        expect(tileHrids(grid)).toEqual(['/items/b', '/items/a']); // this render's own order, untouched
        expect(menu.querySelectorAll(RATE_SELECTOR).length).toBe(0);
        expect(calculatorMock.calculateCoinifyProfit).not.toHaveBeenCalled();
    });

    test('Game order keeps pinned tiles first, the order alchemy-item-pins.js itself writes', () => {
        // Anything else and the two modules' menu watchers undo each other's
        // writes forever — see alchemy-item-sort.pins-interplay.test.js
        buildTabs('coinify');
        pinsMock.pinnedFor.mockReturnValue(['/items/pinned']);
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/pinned:0', { profitPerHour: 1 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/pinned', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        menu.querySelector('[data-mwi-sort-mode="game"]').click();

        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/a', '/items/b']);
    });

    test('a tile added while Profit/hr is showing goes back to its own place on Game', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 1 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 2 });
        profitAnswers.set('coinify:/items/c:0', { profitPerHour: 3 });
        profitAnswers.set('coinify:/items/d:0', { profitPerHour: 4 });
        profitAnswers.set('coinify:/items/new:0', { profitPerHour: 9 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
            ['/items/c', 0],
            ['/items/d', 0],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(tileHrids(grid)).toEqual(['/items/d', '/items/c', '/items/b', '/items/a']);

        // The game's order is now a, b, c, new, d: React inserts the new node
        // directly before the node of the item that follows it — d, first in
        // the sorted grid. Its DOM index, 0, is a's stamp, not its own place.
        grid.insertBefore(buildTile('/items/new', 0), grid.children[0]);
        alchemyItemSort.apply();
        expect(tileHrids(grid)[0]).toBe('/items/new');

        menu.querySelector('[data-mwi-sort-mode="game"]').click();
        expect(tileHrids(grid)).toEqual(['/items/a', '/items/b', '/items/c', '/items/new', '/items/d']);
    });

    test('tiles added at the end, and a run added together, keep their own places', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(tileHrids(grid)).toEqual(['/items/b', '/items/a']);

        // Game order a, x, y, b, z: x and y land before b, z is appended
        const tileB = grid.children[0];
        grid.insertBefore(buildTile('/items/x', 0), tileB);
        grid.insertBefore(buildTile('/items/y', 0), tileB);
        grid.appendChild(buildTile('/items/z', 0));
        alchemyItemSort.apply();

        menu.querySelector('[data-mwi-sort-mode="game"]').click();
        expect(tileHrids(grid)).toEqual(['/items/a', '/items/x', '/items/y', '/items/b', '/items/z']);
    });

    test('an unrecognized stored mode reads as Game and highlights Game', async () => {
        storageMock.storeFor('settings').set('alchemyItemSortOrder', { coinify: 'value' });
        alchemyItemSort.disable();
        await alchemyItemSort.initialize();
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();

        expect(tileHrids(grid)).toEqual(['/items/a', '/items/b']);
        expect(
            menu.querySelector('[data-mwi-sort-mode="game"]').classList.contains('mwi-alchemy-sort-btn-active')
        ).toBe(true);
    });

    test("a newly opened menu re-prices rather than reusing the last menu's answers", () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 10 });
        const first = buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();
        first.menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(calculatorMock.calculateCoinifyProfit).toHaveBeenCalledTimes(1);

        // Closed and opened again: a different menu element, the same tab
        first.primary.remove();
        buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();

        expect(calculatorMock.calculateCoinifyProfit).toHaveBeenCalledTimes(2);
    });

    test('equal values and unpriced tiles keep the game order, whichever mode came before', () => {
        buildTabs('coinify');
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: { '/items/c': { itemLevel: 50 } },
        });
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 7, actionsPerHour: 1, successRate: 1 });
        profitAnswers.set('coinify:/items/b:0', null);
        profitAnswers.set('coinify:/items/c:0', { profitPerHour: 7, actionsPerHour: 1, successRate: 1 });
        profitAnswers.set('coinify:/items/d:0', null);
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
            ['/items/c', 0],
            ['/items/d', 0],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="xp"]').click();
        expect(tileHrids(grid)).toEqual(['/items/c', '/items/a', '/items/b', '/items/d']);

        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(tileHrids(grid)).toEqual(['/items/a', '/items/c', '/items/b', '/items/d']);
    });

    test('turning the feature off puts an open menu back in Game order', () => {
        buildTabs('coinify');
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 5 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 500 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(tileHrids(grid)).toEqual(['/items/b', '/items/a']);

        alchemyItemSort.disable();

        expect(tileHrids(grid)).toEqual(['/items/a', '/items/b']);
    });

    test('XP order: pinned first, then highest XP/hr, unknowns last — and no NaN/undefined labels', () => {
        buildTabs('decompose');
        pinsMock.pinnedFor.mockReturnValue(['/items/pinned']);
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: {
                '/items/low': { itemLevel: 9 },
                '/items/high': { itemLevel: 49 },
                '/items/pinned': { itemLevel: 1 },
            },
        });
        // rankingsMock.calcXpPerAction returns (itemLevel + 1) * successRate, so
        // /items/high (level 49) outranks /items/low (level 9) once multiplied by actionsPerHour
        profitAnswers.set('decompose:/items/low:0', { profitPerHour: 1, actionsPerHour: 10, successRate: 1 });
        profitAnswers.set('decompose:/items/high:0', { profitPerHour: 1, actionsPerHour: 10, successRate: 1 });
        profitAnswers.set('decompose:/items/pinned:0', { profitPerHour: 1, actionsPerHour: 10, successRate: 1 });
        profitAnswers.set('decompose:/items/unknown:0', null);
        const { menu, grid } = buildPicker([
            ['/items/low', 0],
            ['/items/unknown', 0],
            ['/items/pinned', 0],
            ['/items/high', 0],
        ]);
        alchemyItemSort.apply();

        menu.querySelector('[data-mwi-sort-mode="xp"]').click();

        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/high', '/items/low', '/items/unknown']);
        expect(menu.querySelector('[data-mwi-sort-mode="xp"]').classList.contains('mwi-alchemy-sort-btn-active')).toBe(
            true
        );

        const rateTexts = Array.from(menu.querySelectorAll(RATE_SELECTOR)).map((el) => el.textContent);
        expect(rateTexts.length).toBe(3);
        for (const text of rateTexts) {
            expect(text).not.toContain('NaN');
            expect(text).not.toContain('undefined');
        }
        expect(grid.lastElementChild.querySelector(RATE_SELECTOR)).toBeNull();
    });

    test('XP figure is the shared helper times the calculator actionsPerHour, not re-derived', () => {
        buildTabs('coinify');
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: { '/items/a': { itemLevel: 19 } },
        });
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 1, actionsPerHour: 20, successRate: 0.5 });
        const { menu } = buildPicker([['/items/a', 0]]);
        alchemyItemSort.apply();
        menu.querySelector('[data-mwi-sort-mode="xp"]').click();

        expect(rankingsMock.calcXpPerAction).toHaveBeenCalledWith('coinify', 19, 0.5);
        // (19 + 1) * 0.5 successRate(mock) * 20 actionsPerHour = 200
        const rateText = menu.querySelector(RATE_SELECTOR).textContent;
        expect(rateText).toContain('200');
    });

    test('switching among all three modes reorders and restores correctly', () => {
        buildTabs('coinify');
        dataManagerMock.getInitClientData.mockReturnValue({
            itemDetailMap: { '/items/a': { itemLevel: 5 }, '/items/b': { itemLevel: 50 } },
        });
        profitAnswers.set('coinify:/items/a:0', { profitPerHour: 500, actionsPerHour: 10, successRate: 1 });
        profitAnswers.set('coinify:/items/b:0', { profitPerHour: 5, actionsPerHour: 10, successRate: 1 });
        const { menu, grid } = buildPicker([
            ['/items/a', 0],
            ['/items/b', 0],
        ]);
        alchemyItemSort.apply();
        const original = tileHrids(grid);

        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        expect(tileHrids(grid)).toEqual(['/items/a', '/items/b']); // a has the higher profit

        menu.querySelector('[data-mwi-sort-mode="xp"]').click();
        expect(tileHrids(grid)).toEqual(['/items/b', '/items/a']); // b has the higher item level -> higher xp
        // Switching straight from Profit to XP must not leave a profit label behind
        expect(menu.querySelectorAll(RATE_SELECTOR).length).toBe(2);

        menu.querySelector('[data-mwi-sort-mode="game"]').click();
        expect(tileHrids(grid)).toEqual(original);
        expect(menu.querySelectorAll(RATE_SELECTOR).length).toBe(0);
    });
});
