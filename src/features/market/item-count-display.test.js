/**
 * @vitest-environment happy-dom
 *
 * The marketplace item tile badge shows how many of that item the current
 * character owns. The marketplace panel is not scoped to any one character,
 * so a browser running several characters in the same tab (1 main + 3
 * ironcow, say) that leaves the panel open across a character switch used to
 * keep showing the previous character's counts: the module only listened for
 * `items_updated`, and a character switch fires `character_switched` (before
 * the new character's inventory has even loaded) and `character_initialized`
 * (once it has) — neither of which is `items_updated`. The tile itself is
 * already on screen, so no childList mutation happens either.
 *
 * This drives the module purely through a `character_initialized` event with
 * a different inventory behind it, proving the badge refreshes.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const bus = vi.hoisted(() => ({ handlers: {} }));
const state = vi.hoisted(() => ({ inventory: [] }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => key === 'market_visibleItemCount',
        getSettingValue: (key, fallback) => fallback,
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInventory: () => state.inventory,
        getEquipment: () => new Map(),
        on: (event, handler) => {
            (bus.handlers[event] ||= []).push(handler);
        },
        off: (event, handler) => {
            bus.handlers[event] = (bus.handlers[event] || []).filter((h) => h !== handler);
        },
        emit: (event, payload) => {
            for (const handler of bus.handlers[event] || []) handler(payload);
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
    },
}));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('item count display — refresh on character switch', () => {
    let itemCountDisplay;
    let tile;

    beforeEach(async () => {
        vi.resetModules();
        bus.handlers = {};
        document.body.innerHTML = '';

        state.inventory = [{ itemHrid: '/items/sword', itemLocationHrid: '/item_locations/inventory', count: 2 }];

        const container = document.createElement('div');
        container.className = 'MarketplacePanel_marketItems';
        tile = document.createElement('div');
        tile.className = 'Item_clickable';
        const svgNS = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(svgNS, 'svg');
        const use = document.createElementNS(svgNS, 'use');
        use.setAttribute('href', 'items_sprite.svg#sword');
        svg.appendChild(use);
        tile.appendChild(svg);
        container.appendChild(tile);
        document.body.appendChild(container);

        ({ default: itemCountDisplay } = await import('./item-count-display.js'));
        itemCountDisplay.initialize();
    });

    afterEach(() => {
        itemCountDisplay.disable();
        document.body.innerHTML = '';
    });

    test("shows the current character's count on the tile", () => {
        expect(tile.querySelector('.mwi-item-count')?.textContent).toBe('2');
    });

    test('refreshes after switching to a character with a different inventory', async () => {
        // A different character's data lands — the marketplace tile itself
        // (and the DOM around it) is untouched, only the inventory data changes.
        state.inventory = [{ itemHrid: '/items/sword', itemLocationHrid: '/item_locations/inventory', count: 9 }];
        bus.handlers['character_initialized']?.forEach((h) => h({}));

        await wait(350);

        expect(tile.querySelector('.mwi-item-count')?.textContent).toBe('9');
    });
});
