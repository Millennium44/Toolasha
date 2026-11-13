/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterData: {},
    inventory: [],
    itemDetailMap: {},
    unregister: vi.fn(),
    gridCallback: null,
    stored: {},
    ledger: [],
    ledgerError: false,
    characterId: 'char1',
    basis: 'measured',
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetailMap }),
        getCurrentCharacterId: () => game.characterId,
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: vi.fn(() => true), getSettingValue: (_key, fallback) => game.basis || fallback },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback) => game.stored[key] ?? fallback,
        // Like the real tryGet: null when the read fails, {found, value} otherwise
        tryGet: async (key) => {
            if (game.targetReadFails) return null;
            return key in game.stored ? { found: true, value: game.stored[key] } : { found: false, value: null };
        },
    },
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async () => game.ledger,
    // Like the real readScopedChecked: a failed read is {ok: false}, never a throw or a default
    readScopedChecked: async () => (game.ledgerError ? { ok: false, value: null } : { ok: true, value: game.ledger }),
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _cls, cb) => {
            game.gridCallback = cb;
            return game.unregister;
        }),
    },
}));
vi.mock('../../utils/toast.js', () => ({ showToast: vi.fn() }));
vi.mock('../../utils/shopping-list.js', () => ({ openShoppingList: vi.fn() }));

import config from '../../core/config.js';
import { showToast } from '../../utils/toast.js';
import { openShoppingList } from '../../utils/shopping-list.js';
import feature, { calculateMissingSupplies, injectButton, handleClick } from './labyrinth-missing-supplies.js';

// One run at full capacity: the old "up to the carry cap" shape, for the cap-arithmetic tests
const oneRun = { runs: 1, ledgerRuns: [], basis: 'capacity' };

// A ledger record as the run ledger stores them: watched from the door, torches/shrouds/beacons spent
const ledgerRun = (key, torch, shroud = 2, beacon = 3) => ({
    key,
    startTrusted: true,
    floor: 5,
    left: { torch: 0, shroud: 0, beacon: 0 },
    start: { torch, shroud, beacon },
    spent: { torch, shroud, beacon },
    endedAt: 1000,
});

const inv = (itemHrid, count) => ({ itemHrid, count, itemLocationHrid: '/item_locations/inventory' });

// The entry screen: a wrapper holding the "Supplies" label and the supplies grid.
function makeSuppliesBlock() {
    const wrapper = document.createElement('div');
    const label = document.createElement('div');
    label.className = 'LabyrinthPanel_label__2xYzA';
    label.textContent = 'Supplies';
    const grid = document.createElement('div');
    grid.className = 'LabyrinthPanel_suppliesGrid__9qPlm';
    wrapper.append(label, grid);
    document.body.appendChild(wrapper);
    return { wrapper, label, grid };
}

describe('labyrinth missing supplies', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        game.stored = {};
        game.ledger = [];
        game.ledgerError = false;
        game.targetReadFails = false;
        game.characterId = 'char1';
        game.basis = 'measured';
        config.getSetting.mockReturnValue(true);
        game.characterData = {
            characterSetting: {
                labyrinthTorchHrid: '/items/expert_torch',
                labyrinthShroudHrid: '/items/expert_shroud',
            },
            characterInfo: { labyrinthTorchCap: 320, labyrinthShroudCap: 10, labyrinthBeaconCap: 5 },
        };
        game.inventory = [inv('/items/expert_torch', 44)];
        game.itemDetailMap = {
            '/items/basic_torch': { name: 'Basic Torch', isTradable: true },
            '/items/expert_torch': { name: 'Expert Torch', isTradable: true },
            '/items/basic_shroud': { name: 'Basic Shroud', isTradable: true },
            '/items/expert_shroud': { name: 'Expert Shroud', isTradable: true },
            '/items/basic_beacon': { name: 'Basic Beacon', isTradable: true },
        };
    });

    afterEach(() => {
        feature.disable();
        document.body.innerHTML = '';
    });

    test('one run at full capacity: missing is cap minus held for the selected tier of each supply', () => {
        expect(calculateMissingSupplies(oneRun)).toEqual([
            { itemHrid: '/items/expert_torch', name: 'Expert Torch', count: 276 },
            { itemHrid: '/items/expert_shroud', name: 'Expert Shroud', count: 10 },
            { itemHrid: '/items/basic_beacon', name: 'Basic Beacon', count: 5 },
        ]);
    });

    test('a supply already at its cap is left off, and untradable supplies are skipped', () => {
        game.inventory = [inv('/items/expert_torch', 320), inv('/items/expert_shroud', 10)];
        game.itemDetailMap['/items/basic_beacon'].isTradable = false;
        expect(calculateMissingSupplies(oneRun)).toEqual([]);
    });

    test('a supply whose isTradable field is absent (the game omits it when untradable) is skipped', () => {
        game.inventory = [inv('/items/expert_torch', 320), inv('/items/expert_shroud', 10)];
        delete game.itemDetailMap['/items/basic_beacon'].isTradable;
        expect(calculateMissingSupplies(oneRun)).toEqual([]);
    });

    test('a supply with no item details at all stays on the list', () => {
        game.inventory = [inv('/items/expert_torch', 320), inv('/items/expert_shroud', 10)];
        delete game.itemDetailMap['/items/basic_beacon'];
        expect(calculateMissingSupplies(oneRun)).toEqual([
            { itemHrid: '/items/basic_beacon', name: 'basic_beacon', count: 5 },
        ]);
    });

    test('falls back to the base caps before characterInfo states any', () => {
        game.characterData = { characterSetting: {} };
        game.inventory = [];
        const result = calculateMissingSupplies(oneRun);
        expect(result.map((r) => r.count)).toEqual([100, 4, 5]);
        expect(result.map((r) => r.itemHrid)).toEqual([
            '/items/basic_torch',
            '/items/basic_shroud',
            '/items/basic_beacon',
        ]);
    });

    test('nothing without game data', () => {
        game.itemDetailMap = null;
        expect(calculateMissingSupplies(oneRun)).toEqual([]);
    });

    test('injectButton puts one button in place of the Supplies label, with the label hidden, not removed', () => {
        const { wrapper, label, grid } = makeSuppliesBlock();
        injectButton(grid);
        injectButton(grid);
        const buttons = wrapper.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(buttons[0].textContent).toBe('Buy supplies');
        // The button's line takes the heading's own class, sits where it was, and the heading stays in the DOM
        const holder = buttons[0].parentElement;
        expect(holder.className).toBe(label.className);
        expect(label.nextElementSibling).toBe(holder);
        expect(holder.nextElementSibling).toBe(grid);
        expect(label.isConnected).toBe(true);
        expect(label.style.display).toBe('none');
    });

    test('pressing the button hands the live shortfall to the shopping list', async () => {
        const { grid } = makeSuppliesBlock();
        injectButton(grid);
        game.stored.consumablesLabRuns = 1;
        game.basis = 'capacity';
        game.inventory = [inv('/items/expert_torch', 20)];
        await handleClick();
        expect(openShoppingList).toHaveBeenCalledTimes(1);
        const [items] = openShoppingList.mock.calls[0];
        expect(items[0]).toEqual({ itemHrid: '/items/expert_torch', name: 'Expert Torch', count: 300 });
    });

    test('pressing with nothing short opens nothing and names the target', async () => {
        game.stored.consumablesLabRuns = 3;
        game.basis = 'capacity';
        game.inventory = [
            inv('/items/expert_torch', 960),
            inv('/items/expert_shroud', 30),
            inv('/items/basic_beacon', 15),
        ];
        await handleClick();
        expect(openShoppingList).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast.mock.calls[0][0]).toContain('3 runs');
        expect(showToast.mock.calls[0][0]).toContain('Consumables panel target');
    });

    test('holding enough for one run but not the stocked target is still short (the reported bug)', async () => {
        // Default target is 5 runs, never stored; one run's worth held is not enough for five
        game.basis = 'capacity';
        game.inventory = [
            inv('/items/expert_torch', 320),
            inv('/items/expert_shroud', 10),
            inv('/items/basic_beacon', 5),
        ];
        await handleClick();
        expect(openShoppingList).toHaveBeenCalledTimes(1);
        expect(openShoppingList.mock.calls[0][0].map((l) => l.count)).toEqual([1280, 40, 20]);
    });

    test('measured basis sizes each supply off the average of recorded runs, times the run target', async () => {
        game.stored.consumablesLabRuns = 10;
        game.ledger = [ledgerRun('a', 60), ledgerRun('b', 81)];
        game.inventory = [inv('/items/expert_torch', 100)];
        await handleClick();
        // torches average ceil(70.5) = 71 a run -> 710 less 100 held; shrouds 2 a run, beacons 3 a run
        expect(openShoppingList.mock.calls[0][0].map((l) => [l.itemHrid, l.count])).toEqual([
            ['/items/expert_torch', 610],
            ['/items/expert_shroud', 20],
            ['/items/basic_beacon', 30],
        ]);
    });

    test('measured basis with no usable ledger plans at full capacity, as the panel does', () => {
        const result = calculateMissingSupplies({ runs: 2, ledgerRuns: [], basis: 'measured' });
        expect(result.map((r) => r.count)).toEqual([596, 20, 10]);
    });

    test('untrusted runs are not measurements', () => {
        const untrusted = { ...ledgerRun('x', 5), startTrusted: false };
        const result = calculateMissingSupplies({ runs: 1, ledgerRuns: [untrusted], basis: 'measured' });
        expect(result[0].count).toBe(276);
    });

    test('selected crates are stocked one per run, and untradable crates are skipped', () => {
        game.characterData.characterLabyrinth = {
            teaCrateItemHrid: '/items/tea_crate',
            foodCrateItemHrid: '/items/food_crate',
        };
        game.itemDetailMap['/items/tea_crate'] = { name: 'Tea Crate', isTradable: true };
        game.itemDetailMap['/items/food_crate'] = { name: 'Food Crate' };
        game.inventory = [inv('/items/tea_crate', 2)];
        const result = calculateMissingSupplies({ runs: 5, ledgerRuns: [], basis: 'capacity' });
        expect(result.find((r) => r.itemHrid === '/items/tea_crate')).toEqual({
            itemHrid: '/items/tea_crate',
            name: 'Tea Crate',
            count: 3,
        });
        expect(result.find((r) => r.itemHrid === '/items/food_crate')).toBeUndefined();
    });

    test('an unreadable ledger says so instead of guessing a target', async () => {
        game.ledgerError = true;
        await handleClick();
        expect(openShoppingList).not.toHaveBeenCalled();
        expect(showToast.mock.calls[0][0]).toMatch(/could not read/i);
    });

    test('a failed read of the run target says so instead of falling back to five runs', async () => {
        game.stored = { consumablesLabRuns: 10 };
        game.targetReadFails = true;
        await handleClick();
        expect(openShoppingList).not.toHaveBeenCalled();
        expect(showToast.mock.calls[0][0]).toMatch(/could not read/i);
    });

    test('a target that was never saved uses the default of five runs', async () => {
        game.targetReadFails = false;
        await handleClick();
        expect(showToast.mock.calls.some((c) => /could not read/i.test(c[0]))).toBe(false);
    });

    test('a character switch during the read drops the press', async () => {
        const pending = handleClick();
        game.characterId = 'char2';
        await pending;
        expect(openShoppingList).not.toHaveBeenCalled();
        expect(showToast).not.toHaveBeenCalled();
    });

    test('pressing before game data is up says it is loading, not that supplies are full', async () => {
        game.itemDetailMap = null;
        await handleClick();
        expect(openShoppingList).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast.mock.calls[0][0]).toMatch(/loading/i);
        expect(showToast.mock.calls[0][0]).not.toMatch(/full/i);
    });

    test('initialize sweeps existing grids and watches new ones; disable removes the buttons', () => {
        makeSuppliesBlock();
        feature.initialize();
        expect(document.querySelectorAll('button')).toHaveLength(1);

        const later = makeSuppliesBlock();
        game.gridCallback(later.grid);
        expect(document.querySelectorAll('button')).toHaveLength(2);

        feature.disable();
        expect(game.unregister).toHaveBeenCalled();
        expect(document.querySelectorAll('button')).toHaveLength(0);
        // Every hidden heading shows again, and no empty holder is left behind
        for (const label of document.querySelectorAll('[class*="LabyrinthPanel_label"]')) {
            expect(label.style.display).toBe('');
        }
        expect(document.querySelectorAll('[class*="LabyrinthPanel_label"]')).toHaveLength(2);
    });

    test('does nothing when the setting is off', () => {
        config.getSetting.mockReturnValue(false);
        makeSuppliesBlock();
        feature.initialize();
        expect(document.querySelectorAll('button')).toHaveLength(0);
    });
});
