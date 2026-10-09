/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterData: {},
    inventory: [],
    itemDetailMap: {},
    unregister: vi.fn(),
    gridCallback: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        get characterData() {
            return game.characterData;
        },
        getInventory: () => game.inventory,
        getInitClientData: () => ({ itemDetailMap: game.itemDetailMap }),
    },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: vi.fn(() => true) } }));
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

    test('missing is cap minus held for the selected tier of each supply', () => {
        expect(calculateMissingSupplies()).toEqual([
            { itemHrid: '/items/expert_torch', name: 'Expert Torch', count: 276 },
            { itemHrid: '/items/expert_shroud', name: 'Expert Shroud', count: 10 },
            { itemHrid: '/items/basic_beacon', name: 'Basic Beacon', count: 5 },
        ]);
    });

    test('a supply already at its cap is left off, and untradable supplies are skipped', () => {
        game.inventory = [inv('/items/expert_torch', 320), inv('/items/expert_shroud', 10)];
        game.itemDetailMap['/items/basic_beacon'].isTradable = false;
        expect(calculateMissingSupplies()).toEqual([]);
    });

    test('falls back to the base caps before characterInfo states any', () => {
        game.characterData = { characterSetting: {} };
        game.inventory = [];
        const result = calculateMissingSupplies();
        expect(result.map((r) => r.count)).toEqual([100, 4, 5]);
        expect(result.map((r) => r.itemHrid)).toEqual([
            '/items/basic_torch',
            '/items/basic_shroud',
            '/items/basic_beacon',
        ]);
    });

    test('nothing without game data', () => {
        game.itemDetailMap = null;
        expect(calculateMissingSupplies()).toEqual([]);
    });

    test('injectButton puts one button right after the Supplies label', () => {
        const { wrapper, label, grid } = makeSuppliesBlock();
        injectButton(grid);
        injectButton(grid);
        const buttons = wrapper.querySelectorAll('button');
        expect(buttons).toHaveLength(1);
        expect(label.nextElementSibling).toBe(buttons[0]);
    });

    test('pressing the button hands the live shortfall to the shopping list', () => {
        const { grid } = makeSuppliesBlock();
        injectButton(grid);
        game.inventory = [inv('/items/expert_torch', 20)];
        grid.parentElement.querySelector('button').click();
        expect(openShoppingList).toHaveBeenCalledTimes(1);
        const [items] = openShoppingList.mock.calls[0];
        expect(items[0]).toEqual({ itemHrid: '/items/expert_torch', name: 'Expert Torch', count: 300 });
    });

    test('pressing with nothing short opens nothing', () => {
        game.inventory = [
            inv('/items/expert_torch', 320),
            inv('/items/expert_shroud', 10),
            inv('/items/basic_beacon', 5),
        ];
        handleClick();
        expect(openShoppingList).not.toHaveBeenCalled();
        expect(showToast).toHaveBeenCalledTimes(1);
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
    });

    test('does nothing when the setting is off', () => {
        config.getSetting.mockReturnValue(false);
        makeSuppliesBlock();
        feature.initialize();
        expect(document.querySelectorAll('button')).toHaveLength(0);
    });
});
