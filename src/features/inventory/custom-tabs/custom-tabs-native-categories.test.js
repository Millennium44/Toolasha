/**
 * @vitest-environment happy-dom
 *
 * The game omits item tiles from the DOM when their native inventory category is collapsed.
 * Custom Tabs used to display only a warning (and only when a whole custom section was empty),
 * leaving owned items unavailable until the player visited Inventory and expanded the category.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    inventory: [],
    itemDetailMap: {
        '/items/knights_boots': { categoryHrid: '/item_categories/equipment' },
        '/items/cheese': { categoryHrid: '/item_categories/food' },
        '/items/blueberry': { categoryHrid: '/item_categories/food' },
    },
    itemCategoryDetailMap: {
        '/item_categories/equipment': { name: 'Equipment', sortIndex: 1 },
        '/item_categories/food': { name: 'Food', sortIndex: 2 },
    },
}));

vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'inventoryTabs_showUnorganized' && false,
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getInventory: () => game.inventory,
        getInitClientData: () => ({
            itemDetailMap: game.itemDetailMap,
            itemCategoryDetailMap: game.itemCategoryDetailMap,
        }),
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: {} }));
vi.mock('../inventory-badge-manager.js', () => ({ default: {} }));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');

function categoryButton(label) {
    const button = document.createElement('button');
    button.className = 'Inventory_categoryButton__game';
    button.textContent = label;
    return button;
}

function category(label) {
    const wrapper = document.createElement('section');
    wrapper.className = 'Inventory_category__game';
    wrapper.appendChild(categoryButton(label));
    return wrapper;
}

describe('collapsed native inventory category recovery', () => {
    let ui;
    let container;

    beforeEach(() => {
        game.inventory = [];
        ui = new CustomTabsUI();
        ui._config = { tabs: [{ id: 'gear', items: ['/items/knights_boots'], children: [] }] };
        ui._assignedHrids = new Set(['/items/knights_boots']);
        container = document.createElement('div');
    });

    test('recognizes a missing owned enhanced tile using the live player inventory shape', () => {
        game.inventory = [
            {
                itemHrid: '/items/knights_boots',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 7,
                count: 1,
            },
            {
                itemHrid: '/items/cheese',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 0,
                count: 40,
            },
            {
                itemHrid: '/items/bagged_item',
                itemLocationHrid: '/item_locations/bag',
                enhancementLevel: 0,
                count: 1,
            },
        ];
        const tileMap = new Map([['/items/cheese', [document.createElement('div')]]]);

        expect(ui._getMissingOwnedCategoryHrids(tileMap)).toEqual(new Set(['/item_categories/equipment']));

        tileMap.set('/items/knights_boots+7', [document.createElement('div')]);
        expect(ui._getMissingOwnedCategoryHrids(tileMap)).toEqual(new Set());
    });

    test('requests each collapsed category once while React is still rendering', () => {
        const equipment = categoryButton('+ Equipment (1)');
        const food = categoryButton('Food (40)');
        const equipmentClick = vi.spyOn(equipment, 'click');
        const foodClick = vi.spyOn(food, 'click');
        container.append(equipment, food);

        expect(ui._expandCollapsedNativeCategories(container, new Set(['/item_categories/equipment']))).toBe(1);
        expect(ui._expandCollapsedNativeCategories(container, new Set(['/item_categories/equipment']))).toBe(0);
        expect(equipmentClick).toHaveBeenCalledTimes(1);
        expect(foodClick).not.toHaveBeenCalled();
    });

    test('allows a later player-initiated collapse to be expanded again', () => {
        const equipment = categoryButton('+ Equipment (1)');
        const click = vi.spyOn(equipment, 'click');
        container.appendChild(equipment);

        ui._expandCollapsedNativeCategories(container, new Set(['/item_categories/equipment']));
        equipment.textContent = 'Equipment (1)';
        ui._expandCollapsedNativeCategories(container, new Set(['/item_categories/equipment']));
        equipment.textContent = '+ Equipment (1)';
        ui._expandCollapsedNativeCategories(container, new Set(['/item_categories/equipment']));

        expect(click).toHaveBeenCalledTimes(2);
    });

    test('can retry a still-collapsed category after the custom layout is disabled', () => {
        const equipment = categoryButton('+ Equipment (1)');
        const click = vi.spyOn(equipment, 'click');
        container.appendChild(equipment);
        const missing = new Set(['/item_categories/equipment']);

        ui._expandCollapsedNativeCategories(container, missing);
        ui._clearLayout();
        ui._expandCollapsedNativeCategories(container, missing);

        expect(click).toHaveBeenCalledTimes(2);
    });

    test('expands only the category containing the missing assigned item', () => {
        game.inventory = [
            {
                itemHrid: '/items/knights_boots',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 0,
                count: 1,
            },
            {
                itemHrid: '/items/blueberry',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 0,
                count: 12,
            },
        ];
        const equipment = category('+ Equipment (1)');
        const food = category('+ Food (12)');
        const equipmentClick = vi.spyOn(equipment.querySelector('button'), 'click');
        const foodClick = vi.spyOn(food.querySelector('button'), 'click');
        container.append(equipment, food);

        const missingCategories = ui._getMissingOwnedCategoryHrids(new Map());
        expect(missingCategories).toEqual(new Set(['/item_categories/equipment']));
        expect(ui._expandCollapsedNativeCategories(container, missingCategories)).toBe(1);
        expect(equipmentClick).toHaveBeenCalledTimes(1);
        expect(foodClick).not.toHaveBeenCalled();
    });

    test('ignores non-positive inventory rows when deciding that a tile is missing', () => {
        game.inventory = [
            {
                itemHrid: '/items/knights_boots',
                itemLocationHrid: '/item_locations/inventory',
                enhancementLevel: 0,
                count: 0,
            },
        ];

        expect(ui._getMissingOwnedCategoryHrids(new Map())).toEqual(new Set());
    });

    test('recognizes an aria-expanded category control whose visible text has no plus prefix', () => {
        const equipment = category('Equipment (1)');
        const button = equipment.querySelector('button');
        button.setAttribute('aria-expanded', 'false');
        const click = vi.spyOn(button, 'click');
        container.appendChild(equipment);

        expect(ui._expandCollapsedNativeCategories(container, new Set(['/item_categories/equipment']))).toBe(1);
        expect(click).toHaveBeenCalledTimes(1);
    });
});
