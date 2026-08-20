/**
 * @vitest-environment happy-dom
 *
 * Resolving an item from its icon sprite. The interesting failures are a wrong
 * identity: a translated label that no longer matches anything, and a sprite id
 * that is not an item at all.
 */

import { describe, test, expect } from 'vitest';
import { itemHridFromIcon } from './item-icon.js';

/**
 * A tile the way the game draws one: translated label, stable sprite.
 * @param {string} spriteId - The `<use>` fragment id
 * @param {string} label - The translated aria-label
 * @returns {Element} The tile
 */
function tile(spriteId, label) {
    document.body.innerHTML = `
        <div class="Item_itemContainer__q">
            <svg aria-label="${label}"><use href="/static/media/items_sprite.abc123.svg#${spriteId}"></use></svg>
        </div>`;
    return document.querySelector('[class*="Item_itemContainer"]');
}

describe('itemHridFromIcon', () => {
    test('reads the hrid off the sprite, whatever language the label is in', () => {
        expect(itemHridFromIcon(tile('radiant_fiber', 'Fibre radieuse'))).toBe('/items/radiant_fiber');
    });

    test('validates against the item detail map when given one', () => {
        const el = tile('radiant_fiber', 'Radiant Fiber');
        expect(itemHridFromIcon(el, { '/items/radiant_fiber': { name: 'Radiant Fiber' } })).toBe(
            '/items/radiant_fiber'
        );
        expect(itemHridFromIcon(el, { '/items/cheese': { name: 'Cheese' } })).toBeNull();
    });

    test('an icon with no sprite reference resolves nothing', () => {
        document.body.innerHTML = '<div class="Item_itemContainer__q"><svg aria-label="Cheese"></svg></div>';
        expect(itemHridFromIcon(document.querySelector('[class*="Item_itemContainer"]'))).toBeNull();
    });

    test('no container at all resolves nothing rather than throwing', () => {
        expect(itemHridFromIcon(null)).toBeNull();
        expect(itemHridFromIcon(undefined, {})).toBeNull();
    });
});
