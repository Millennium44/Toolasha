/**
 * @vitest-environment happy-dom
 *
 * The item action menu's "Add to Tab" dropdown. The game's menu is a short, overflow-clipped box,
 * so the tab list is portaled to <body> instead of nesting inside it.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: () => false, Z_POPUP: 10000 },
}));
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getInventory: () => [],
        getInitClientData: () => ({ itemDetailMap: {}, itemCategoryDetailMap: {} }),
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: {} }));
vi.mock('../inventory-badge-manager.js', () => ({ default: {} }));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
vi.mock('../../../utils/item-icon.js', () => ({ itemHridFromIcon: () => '/items/cheese' }));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');

function tab(id, name, items = []) {
    return { id, name, color: null, open: false, items, children: [], updatedAt: 1 };
}

function makeMenu() {
    const menu = document.createElement('div');
    menu.innerHTML =
        '<div class="Item_itemContainer__x"></div><div class="Item_name__x">Cheese</div><button>Equip</button>';
    document.body.appendChild(menu);
    return menu;
}

describe('"Add to Tab" dropdown portal', () => {
    let ui;
    let menu;

    beforeEach(() => {
        ui = new CustomTabsUI();
        ui._save = vi.fn().mockResolvedValue(undefined);
        ui._config = { tabs: [tab('a', 'Food'), tab('b', 'Misc')], selectedTabId: null };
        menu = makeMenu();
        ui._injectAddToTabButton(menu);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    const toggle = () => menu.querySelector('.toolasha-ct-add-to-tab button');
    const panel = () => document.querySelector('.toolasha-ct-add-to-tab-panel');

    test('the panel lives in <body>, not inside the clipped game menu', () => {
        expect(panel()).not.toBeNull();
        expect(menu.contains(panel())).toBe(false);
        expect(panel().style.position).toBe('fixed');
        expect(panel().style.display).toBe('none');
    });

    test('opening shows the panel positioned from the toggle', () => {
        toggle().click();
        expect(panel().style.display).toBe('flex');
        expect(panel().style.top).not.toBe('');
        expect(panel().style.left).not.toBe('');
    });

    test('a click outside the toggle and panel closes it, a click inside does not', async () => {
        toggle().click();
        await new Promise((r) => setTimeout(r, 5));
        panel().dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(panel().style.display).toBe('flex');
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(panel().style.display).toBe('none');
    });

    test('removing the native menu while open takes the portaled panel with it', async () => {
        toggle().click();
        menu.remove();
        await new Promise((r) => setTimeout(r, 5));
        expect(panel()).toBeNull();
    });

    test('a closed panel orphaned by the game is swept on the next injection', () => {
        menu.remove();
        const next = makeMenu();
        ui._injectAddToTabButton(next);
        expect(document.querySelectorAll('.toolasha-ct-add-to-tab-panel')).toHaveLength(1);
    });
});

describe('"Add to Tab" dropdown rows', () => {
    let ui;
    let menu;

    beforeEach(() => {
        ui = new CustomTabsUI();
        ui._save = vi.fn().mockResolvedValue(undefined);
        ui._openEditor = vi.fn();
        ui._config = { tabs: [tab('a', 'Food', ['/items/cheese']), tab('b', 'Misc')], selectedTabId: null };
        menu = makeMenu();
        ui._injectAddToTabButton(menu);
    });

    afterEach(() => {
        document.body.innerHTML = '';
    });

    const rows = () => [...document.querySelectorAll('.toolasha-ct-add-to-tab-panel button')];

    test('a tab already holding the item is checked and clicking it removes the item', () => {
        expect(rows()[0].textContent).toBe('✓ Food');
        rows()[0].click();
        expect(ui._config.tabs[0].items).toEqual([]);
        expect(rows()[0].textContent).toBe('Food');
        expect(ui._save).toHaveBeenCalled();
    });

    test('clicking an unchecked tab adds the item and keeps the panel for more', () => {
        rows()[1].click();
        expect(ui._config.tabs[1].items).toEqual(['/items/cheese']);
        expect(rows()[1].textContent).toBe('✓ Misc');
    });

    test('"+ New Tab" creates a tab holding the item and opens its editor', () => {
        const newTab = rows().at(-1);
        expect(newTab.textContent).toBe('+ New Tab');
        newTab.click();
        expect(ui._config.tabs).toHaveLength(3);
        const created = ui._config.tabs[2];
        expect(created.items).toEqual(['/items/cheese']);
        expect(ui._openEditor).toHaveBeenCalledWith(created.id);
    });
});
