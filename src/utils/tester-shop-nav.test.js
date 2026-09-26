/** @vitest-environment happy-dom */
import { afterEach, describe, expect, test } from 'vitest';

import { setShopFilter } from './tester-shop-nav.js';

/** An "Item Filter" box inside a container with the given class */
function filterBox(containerClass) {
    const container = document.createElement('div');
    container.className = containerClass;
    const input = document.createElement('input');
    input.placeholder = 'Item Filter';
    container.appendChild(input);
    document.body.appendChild(container);
    // happy-dom lays nothing out; stand in for "on screen"
    Object.defineProperty(input, 'offsetParent', { get: () => container });
    return input;
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('setShopFilter', () => {
    test('types into the Shop panel filter', () => {
        const shop = filterBox('ShopPanel_itemFilterContainer__1raSg');

        expect(setShopFilter('Chaotic Chain')).toBe(true);
        expect(shop.value).toBe('Chaotic Chain');
    });

    test('never falls back to the inventory filter when the Shop has none on screen', () => {
        // Measured on the test server: the Dungeon tab hides the Shop's filter
        const inventory = filterBox('Inventory_filterInput__3OXXy');

        expect(setShopFilter('Chaotic Chain')).toBe(false);
        expect(inventory.value).toBe('');
    });
});
