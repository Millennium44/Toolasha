/**
 * @vitest-environment happy-dom
 *
 * Equipment level overlays are keyed off an SVG `<use href>` inside an
 * otherwise-stable `Item_item` div. The game frequently swaps that href in
 * place — re-equipping a different item (or a different enhancement level of
 * the same item) into the same slot reuses the DOM node and only changes the
 * icon reference — which is an attribute mutation, not a childList one.
 *
 * The shared `domObserver` this feature used to rely on exclusively only
 * watches `childList`/`subtree` (see dom-observer.js), so an href-only swap
 * never reached `addItemLevels()` and the overlay kept showing the previous
 * item's level requirement. This file drives a real MutationObserver against
 * a real DOM (happy-dom) to prove the overlay refreshes on an attribute-only
 * change, not just when nodes are added or removed.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ITEM_LEVELS = {
    '/items/sword_basic': 5,
    '/items/sword_advanced': 40,
};

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => {
            if (key === 'itemIconLevel') return true;
            return false;
        },
        onSettingChange: () => {},
        SCRIPT_COLOR_MAIN: '#22c55e',
        COLOR_ACCENT: '#22c55e',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (itemHrid) => {
            const level = ITEM_LEVELS[itemHrid];
            if (level === undefined) return null;
            return { equipmentDetail: { levelRequirements: [{ level }] } };
        },
    },
}));

// Only the childList-based scan this feature layers on top of; the fix under
// test is the dedicated href-attribute observer, wired directly in the module.
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        register: () => () => {},
    },
}));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('equipment level display — href-only item swaps', () => {
    let equipmentLevelDisplay;
    let container;

    beforeEach(async () => {
        vi.resetModules();
        document.body.innerHTML = '';

        container = document.createElement('div');
        container.className = 'Item_itemContainer__x7kH1';
        container.innerHTML = `
            <div class="Item_item__2De2O Item_clickable__3viV6">
                <svg><use href="#sword_basic"></use></svg>
            </div>
        `;
        document.body.appendChild(container);

        ({ default: equipmentLevelDisplay } = await import('./equipment-level-display.js'));
        equipmentLevelDisplay.initialize();
        // Initial synchronous scan
        await wait(0);
    });

    afterEach(() => {
        equipmentLevelDisplay.disable();
        document.body.innerHTML = '';
    });

    test('shows the level for the initially-mounted item', () => {
        const overlay = container.querySelector('.script_itemLevel');
        expect(overlay?.textContent).toBe('5');
    });

    test('updates the overlay when only the SVG href changes (no childList mutation)', async () => {
        const use = container.querySelector('use');

        // Swap the icon reference in place — the div and the <use> element
        // themselves are never removed or replaced, matching how the game
        // reuses the slot's DOM node for a different equipped item.
        use.setAttribute('href', '#sword_advanced');

        // Let the MutationObserver's microtask fire and the 150ms debounce elapse.
        await wait(250);

        const overlay = container.querySelector('.script_itemLevel');
        expect(overlay?.textContent).toBe('40');
    });
});
