/** @vitest-environment happy-dom
 *
 * Alchemy Item Sort and Alchemy Item Pins together, both real, both watching
 * the same open menu. Each reorders the grid and each reacts to the other's
 * writes, so the two orders they want must agree or the menu never settles.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        reset: () => stores.clear(),
        get: vi.fn(async (key, store = 'settings', fallback = null) => storeFor(store).get(key) ?? fallback),
        tryGet: vi.fn(async (key, store = 'settings') => {
            const map = storeFor(store);
            return map.has(key) ? { found: true, value: structuredClone(map.get(key)) } : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => storeFor(store).delete(key)),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const dataManagerMock = vi.hoisted(() => ({
    on: () => {},
    off: () => {},
    getCurrentCharacterId: () => 'char1',
    getCurrentCharacterGameMode: () => 'standard',
    getInitClientData: () => ({ itemDetailMap: {} }),
}));

const profitAnswers = vi.hoisted(() => new Map());

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true, getSettingValue: () => '#60a5fa' } }));
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../market/alchemy-profit-calculator.js', () => ({
    default: { calculateCoinifyProfit: (hrid) => profitAnswers.get(hrid) ?? null },
}));
vi.mock('./alchemy-rankings.js', () => ({ calcXpPerAction: () => 1 }));

const { default: alchemyItemPins } = await import('./alchemy-item-pins.js');
const { default: alchemyItemSort } = await import('./alchemy-item-sort.js');

/** Past this many reorders the two modules are fighting; the cap stops the fight so the test can report it */
const FIGHT_CAP = 40;

function buildTabs() {
    const tablist = document.createElement('div');
    tablist.setAttribute('role', 'tablist');
    for (const action of ['Coinify', 'Decompose', 'Transmute', 'Unrefine']) {
        const tab = document.createElement('div');
        tab.setAttribute('role', 'tab');
        tab.textContent = action;
        if (action === 'Coinify') tab.setAttribute('aria-selected', 'true');
        tablist.appendChild(tab);
    }
    document.body.appendChild(tablist);
}

function buildTile(itemHrid) {
    const wrap = document.createElement('div');
    const tile = document.createElement('div');
    tile.className = 'Item_itemContainer_x';
    tile.innerHTML = `<svg><use href="#${itemHrid.replace('/items/', '')}"></use></svg>`;
    wrap.appendChild(tile);
    return wrap;
}

function buildPicker(hrids) {
    const primary = document.createElement('div');
    primary.className = 'SkillActionDetail_primaryItemSelectorContainer_x';
    const menu = document.createElement('div');
    menu.className = 'ItemSelector_menu_x';
    const grid = document.createElement('div');
    for (const hrid of hrids) grid.appendChild(buildTile(hrid));
    menu.appendChild(grid);
    primary.appendChild(menu);
    document.body.appendChild(primary);
    return { menu, grid };
}

function tileHrids(grid) {
    return Array.from(grid.querySelectorAll('.Item_itemContainer_x')).map(
        (tile) => `/items/${tile.querySelector('use').getAttribute('href').slice(1)}`
    );
}

/** Let every queued MutationObserver delivery run */
async function settle() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('alchemy item sort with alchemy item pins', () => {
    let moves;
    let realMoveTiles;

    beforeEach(async () => {
        storageMock.reset();
        profitAnswers.clear();
        alchemyItemSort.disable();
        alchemyItemPins.disable();
        document.body.innerHTML = '';
        await alchemyItemSort.initialize();
        await alchemyItemPins.initialize();
        alchemyItemPins.pins = { coinify: ['/items/pinned'] };

        moves = 0;
        realMoveTiles = alchemyItemSort.moveTiles;
        alchemyItemSort.moveTiles = function (grid, tiles, desired) {
            if (sameOrderLocal(tiles, desired)) return;
            moves += 1;
            if (moves > FIGHT_CAP) return;
            realMoveTiles.call(this, grid, tiles, desired);
        };
    });

    afterEach(() => {
        alchemyItemSort.moveTiles = realMoveTiles;
        alchemyItemSort.disable();
        alchemyItemPins.disable();
    });

    test('Game order settles with a pinned tile at the front when Sort sees the menu first', async () => {
        buildTabs();
        const { grid } = buildPicker(['/items/a', '/items/pinned', '/items/b']);

        // Sort's pass first, then Pins': the order both register on the same menu event in
        alchemyItemSort.apply();
        alchemyItemPins.apply();
        await settle();

        expect(moves).toBeLessThan(FIGHT_CAP);
        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/a', '/items/b']);
    });

    test('pinning a tile in Game order settles instead of bouncing it between modules', async () => {
        buildTabs();
        alchemyItemPins.pins = {};
        const { grid } = buildPicker(['/items/a', '/items/pinned', '/items/b']);
        alchemyItemPins.apply();
        alchemyItemSort.apply();
        await settle();

        alchemyItemPins.toggle(grid.children[1]);
        await settle();

        expect(moves).toBeLessThan(FIGHT_CAP);
        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/a', '/items/b']);
    });

    test('Profit -> Game keeps the pinned tile first and the rest in the game order', async () => {
        buildTabs();
        profitAnswers.set('/items/a', { profitPerHour: 1 });
        profitAnswers.set('/items/b', { profitPerHour: 100 });
        profitAnswers.set('/items/pinned', { profitPerHour: 5 });
        const { menu, grid } = buildPicker(['/items/a', '/items/pinned', '/items/b']);
        alchemyItemSort.apply();
        alchemyItemPins.apply();
        await settle();

        menu.querySelector('[data-mwi-sort-mode="profit"]').click();
        await settle();
        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/b', '/items/a']);

        menu.querySelector('[data-mwi-sort-mode="game"]').click();
        await settle();

        expect(moves).toBeLessThan(FIGHT_CAP);
        expect(tileHrids(grid)).toEqual(['/items/pinned', '/items/a', '/items/b']);
    });
});

function sameOrderLocal(a, b) {
    return a.length === b.length && a.every((tile, index) => tile === b[index]);
}
