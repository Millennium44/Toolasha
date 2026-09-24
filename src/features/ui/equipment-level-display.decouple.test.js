/**
 * @vitest-environment happy-dom
 *
 * `itemIconLevel` ("Show equipment level") and `showsKeyInfoInIcon` ("key
 * icons: Show zone index") used to share one gate: the registry started this
 * module only off `itemIconLevel`, so turning that off silently killed the
 * key/fragment zone text too, even with `showsKeyInfoInIcon` still on. The
 * module now initializes when either setting is on, and draws each piece of
 * text under its own setting.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const ITEM_LEVELS = {
    '/items/sword_basic': 5,
};

const settings = { itemIconLevel: false, showsKeyInfoInIcon: true };

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => settings[key] ?? false,
        onSettingChange: () => {},
        SCRIPT_COLOR_MAIN: '#22c55e',
        COLOR_ACCENT: '#22c55e',
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getItemDetails: (itemHrid) => {
            const level = ITEM_LEVELS[itemHrid];
            if (level !== undefined) {
                return { equipmentDetail: { levelRequirements: [{ level }] } };
            }
            // A key/fragment has item details too — just neither equipmentDetail
            // nor abilityBookDetail — so addItemLevels falls through to the key branch.
            return {};
        },
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        register: () => () => {},
        onClass: () => () => {},
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('equipment level display — itemIconLevel and showsKeyInfoInIcon decoupled', () => {
    let equipmentLevelDisplay;

    beforeEach(async () => {
        vi.resetModules();
        settings.itemIconLevel = false;
        settings.showsKeyInfoInIcon = true;
        document.body.innerHTML = '';

        const equipmentContainer = document.createElement('div');
        equipmentContainer.className = 'Item_itemContainer__x7kH1';
        equipmentContainer.innerHTML = `
            <div class="Item_item__2De2O Item_clickable__3viV6">
                <svg><use href="#sword_basic"></use></svg>
            </div>
        `;
        document.body.appendChild(equipmentContainer);

        const keyContainer = document.createElement('div');
        keyContainer.className = 'Item_itemContainer__x7kH1';
        keyContainer.innerHTML = `
            <div class="Item_item__2De2O Item_clickable__3viV6">
                <svg><use href="#chimerical_entry_key"></use></svg>
            </div>
        `;
        document.body.appendChild(keyContainer);

        ({ default: equipmentLevelDisplay } = await import('./equipment-level-display.js'));
    });

    afterEach(() => {
        equipmentLevelDisplay.disable();
        document.body.innerHTML = '';
    });

    test('itemIconLevel off + showsKeyInfoInIcon on: module still initializes', () => {
        equipmentLevelDisplay.initialize();
        expect(equipmentLevelDisplay.isInitialized).toBe(true);
    });

    test('a key icon gets its zone text, an equipment icon gets no level', async () => {
        equipmentLevelDisplay.initialize();
        await wait(0);

        const equipmentOverlay = document
            .querySelectorAll('.Item_itemContainer__x7kH1')[0]
            .querySelector('.script_itemLevel');
        const keyOverlay = document
            .querySelectorAll('.Item_itemContainer__x7kH1')[1]
            .querySelector('.script_itemLevel');

        expect(equipmentOverlay).toBeNull();
        expect(keyOverlay?.textContent).toBe('D1');
    });
});
