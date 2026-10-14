/**
 * @vitest-environment happy-dom
 *
 * The Toolasha-tab toolbar: + Tab, expand, collapse and a "⋯" menu holding the rarely used actions.
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
vi.mock('../../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => null,
}));
vi.mock('../../../utils/item-icon.js', () => ({ itemHridFromIcon: () => '/items/cheese' }));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');

describe('toolbar "⋯" overflow menu', () => {
    let ui;
    let addSpy;
    let removeSpy;

    beforeEach(() => {
        addSpy = vi.spyOn(document, 'addEventListener');
        removeSpy = vi.spyOn(document, 'removeEventListener');
        ui = new CustomTabsUI();
        ui._exportLayout = vi.fn();
        ui._onImportNativeCategories = vi.fn();
        ui._onClearAllTabs = vi.fn();
        ui._handleImportFile = vi.fn();
        const sort = document.createElement('div');
        sort.className = 'mwi-inventory-sort-controls';
        document.body.appendChild(sort);
        ui._injectActionButtons();
    });

    afterEach(() => {
        vi.restoreAllMocks();
        document.body.innerHTML = '';
    });

    const bar = () => document.querySelector('.toolasha-ct-action-btns');
    const more = () => bar().querySelector('[data-ct-action="more"]');
    const menu = () => document.querySelector('.toolasha-ct-overflow-menu');
    const entries = () => [...menu().querySelectorAll('button')].map((b) => b.dataset.ctAction);
    const added = (type) => addSpy.mock.calls.filter(([t]) => t === type);
    const removed = (type) => removeSpy.mock.calls.filter(([t]) => t === type);

    test('the toolbar keeps + Tab, expand, collapse and the menu button only', () => {
        const labels = [...bar().querySelectorAll('button')].map((b) => b.textContent);
        expect(labels).toEqual(['+ Tab', '⊞', '⊟', '⋯']);
        expect(more().title).not.toBe('');
    });

    test('the menu is portaled to <body> and starts closed', () => {
        expect(menu().parentElement).toBe(document.body);
        expect(menu().style.display).toBe('none');
    });

    test('opening lists the four entries', () => {
        more().click();
        expect(menu().style.display).toBe('flex');
        expect(entries()).toEqual(['export', 'import', 'import-categories', 'clear-all']);
    });

    test.each([
        ['export', () => ui._exportLayout],
        ['import-categories', () => ui._onImportNativeCategories],
        ['clear-all', () => ui._onClearAllTabs],
    ])('choosing %s runs its handler and closes the menu', (action, handler) => {
        more().click();
        menu().querySelector(`[data-ct-action="${action}"]`).click();
        expect(handler()).toHaveBeenCalledTimes(1);
        expect(menu().style.display).toBe('none');
    });

    test('choosing Import opens the file picker', () => {
        const input = bar().querySelector('input[type="file"]');
        const pick = vi.spyOn(input, 'click').mockImplementation(() => {});
        more().click();
        menu().querySelector('[data-ct-action="import"]').click();
        expect(pick).toHaveBeenCalledTimes(1);
        expect(menu().style.display).toBe('none');
    });

    test('an outside click closes the menu', () => {
        more().click();
        document.body.click();
        expect(menu().style.display).toBe('none');
    });

    test('Escape closes the menu', () => {
        more().click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menu().style.display).toBe('none');
    });

    test('document listeners exist only while open and are removed on close', () => {
        expect(added('click')).toHaveLength(0);
        more().click();
        expect(added('click')).toHaveLength(1);
        more().click();
        expect(removed('click')).toHaveLength(1);
    });

    test('cleanup while open removes the document listeners and the panel', () => {
        more().click();
        ui.cleanup();
        expect(removed('click')).toHaveLength(1);
        expect(removed('keydown')).toHaveLength(1);
        expect(menu()).toBeNull();
    });
});

describe('toolbar "⋯" menu follows its button', () => {
    test('scrolling a box that holds the button closes the open menu', () => {
        const sort = document.createElement('div');
        sort.className = 'mwi-inventory-sort-controls';
        document.body.appendChild(sort);
        const ui = new CustomTabsUI();
        ui._injectActionButtons();
        const button = sort.querySelector('[data-ct-action="more"]');
        const panel = document.querySelector('.toolasha-ct-overflow-menu');
        button.click();
        expect(panel.style.display).toBe('flex');
        sort.dispatchEvent(new Event('scroll'));
        expect(panel.style.display).toBe('none');
        document.body.innerHTML = '';
    });
});
