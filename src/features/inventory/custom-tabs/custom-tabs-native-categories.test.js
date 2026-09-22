/**
 * @vitest-environment happy-dom
 *
 * The game omits item tiles from the DOM when their native inventory category is collapsed.
 * Custom Tabs used to display only a warning (and only when a whole custom section was empty),
 * leaving owned items unavailable until the player visited Inventory and expanded the category.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ inventory: [] }));

vi.mock('../../../core/config.js', () => ({ default: {} }));
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getInventory: () => game.inventory,
        getInitClientData: () => ({}),
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

describe('collapsed native inventory category recovery', () => {
    let ui;
    let container;

    beforeEach(() => {
        game.inventory = [];
        ui = new CustomTabsUI();
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

        expect(ui._hasOwnedItemsMissingFromDom(tileMap)).toBe(true);

        tileMap.set('/items/knights_boots+7', [document.createElement('div')]);
        expect(ui._hasOwnedItemsMissingFromDom(tileMap)).toBe(false);
    });

    test('requests each collapsed category once while React is still rendering', () => {
        const equipment = categoryButton('+ Equipment (1)');
        const food = categoryButton('Food (40)');
        const equipmentClick = vi.spyOn(equipment, 'click');
        const foodClick = vi.spyOn(food, 'click');
        container.append(equipment, food);

        expect(ui._expandCollapsedNativeCategories(container)).toBe(1);
        expect(ui._expandCollapsedNativeCategories(container)).toBe(0);
        expect(equipmentClick).toHaveBeenCalledTimes(1);
        expect(foodClick).not.toHaveBeenCalled();
    });

    test('allows a later player-initiated collapse to be expanded again', () => {
        const equipment = categoryButton('+ Equipment (1)');
        const click = vi.spyOn(equipment, 'click');
        container.appendChild(equipment);

        ui._expandCollapsedNativeCategories(container);
        equipment.textContent = 'Equipment (1)';
        ui._expandCollapsedNativeCategories(container);
        equipment.textContent = '+ Equipment (1)';
        ui._expandCollapsedNativeCategories(container);

        expect(click).toHaveBeenCalledTimes(2);
    });
});
