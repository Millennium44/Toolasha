/**
 * @vitest-environment happy-dom
 *
 * The 2026-09 game patch gave the inventory its own tab strip. Inventory_items now holds a
 * TabsComponent whose panels render tiles for the selected tab only, so the Toolasha view has
 * to select "All", hide the strip and flatten the panel chain — and hand the player's own tab
 * choice back on leaving. The pre-patch DOM (still on the main server) must behave as before.
 *
 * The fixture mirrors the DOM measured on test.milkywayidle.com on 2026-09-25:
 *
 *   Inventory_items
 *   └ TabsComponent_tabsComponent.TabsComponent_compact
 *       ├ TabsComponent_tabsContainer > MuiTabs-root > MuiTabs-scroller > [role=tablist] > [role=tab]…
 *       └ TabsComponent_tabPanelsContainer > TabPanel_tabPanel (one per tab, others TabPanel_hidden)
 *           └ div (category) > div > Inventory_itemGrid (+ Inventory_label, Inventory_categoryButton)
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    charId: 'char-1',
    settings: { inventoryTabs_showUnorganized: true },
    itemDetailMap: {
        '/items/cheese': { name: 'Cheese', categoryHrid: '/item_categories/food', sortIndex: 1 },
        '/items/milk': { name: 'Milk', categoryHrid: '/item_categories/resource', sortIndex: 2 },
        '/items/coin': { name: 'Coin', categoryHrid: '/item_categories/currency', sortIndex: 0 },
    },
    itemCategoryDetailMap: {
        '/item_categories/currency': { name: 'Currency', sortIndex: 0 },
        '/item_categories/food': { name: 'Food', sortIndex: 1 },
        '/item_categories/resource': { name: 'Resources', sortIndex: 2 },
    },
    inventory: [],
}));

const storageMock = vi.hoisted(() => {
    const map = new Map();
    return {
        map,
        get: vi.fn(async (key, _store, fallback = null) => (map.has(key) ? map.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            map.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            map.delete(key);
            return true;
        }),
    };
});

/** Callbacks registered with the DOM observer, so a test can play the game rendering a strip */
const observer = vi.hoisted(() => ({ classHandlers: new Map(), readyHandlers: [] }));

vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: (key) => game.settings[key] ?? false,
        getSettingValue: (key, fallback = null) => game.settings[key] ?? fallback,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, fn) => {
            observer.classHandlers.set(`${name}:${className}`, fn);
            return () => observer.classHandlers.delete(`${name}:${className}`);
        },
        onReady: (_name, fn) => {
            observer.readyHandlers.push(fn);
            return () => {};
        },
    },
}));
vi.mock('../../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.charId,
        on: () => {},
        off: () => {},
        getInventory: () => game.inventory,
        getInitClientData: () => ({
            itemDetailMap: game.itemDetailMap,
            itemCategoryDetailMap: game.itemCategoryDetailMap,
        }),
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: { currentMode: 'none', onModeChange: () => () => {} } }));
vi.mock('../inventory-badge-manager.js', () => ({
    default: { currentInventoryElem: {}, renderAllBadges: async () => {} },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => ({ onUpdate: () => {}, offUpdate: () => {} }),
}));
vi.mock('./custom-tabs-data.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadConfig: async () => ({ tabs: [] }),
}));

const { default: CustomTabsUI, PANEL_CSS } = await import('./custom-tabs-ui.js');

const NATIVE_TAB_ICONS = [
    'inventory_all',
    'item_category_currency',
    'item_category_loot',
    'item_category_food',
    'item_category_resource',
];
/** Which categories each native tab renders; "All" renders every one */
const TAB_CATEGORIES = {
    inventory_all: ['currency', 'food', 'resource'],
    item_category_currency: ['currency'],
    item_category_loot: [],
    item_category_food: ['food'],
    item_category_resource: ['resource'],
};
const CATEGORY_ITEMS = { currency: ['coin'], food: ['cheese'], resource: ['milk'] };

function el(tag, className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function iconSvg(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/static/media/sprites.abc.svg#${id}`);
    svg.appendChild(use);
    return svg;
}

function tile(itemId) {
    const node = el('div', 'Item_itemContainer__x1');
    node.appendChild(iconSvg(itemId));
    return node;
}

/** The character panel: its own tab strip (Inventory, Equipment) and its panels */
function buildCharacterPanel() {
    const root = el('div', 'CharacterManagement_tabsComponentContainer__c');
    const tabsContainer = el('div', 'TabsComponent_tabsContainer__a');
    const tabList = el('div', 'MuiTabs-flexContainer');
    tabList.setAttribute('role', 'tablist');
    for (const label of ['Inventory', 'Equipment']) {
        const tab = el('button', `MuiTab-root${label === 'Inventory' ? ' Mui-selected' : ''}`);
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(label === 'Inventory'));
        tab.textContent = label;
        tabList.appendChild(tab);
    }
    const scroller = el('div', 'MuiTabs-scroller');
    scroller.appendChild(tabList);
    tabsContainer.appendChild(scroller);
    const panels = el('div', 'TabsComponent_tabPanelsContainer__b');
    const inventoryPanel = el('div', 'TabPanel_tabPanel__tXMJF');
    const equipmentPanel = el('div', 'TabPanel_tabPanel__tXMJF TabPanel_hidden__26UM3');
    panels.append(inventoryPanel, equipmentPanel);
    root.append(tabsContainer, panels);
    document.body.appendChild(root);
    return { characterTabList: tabList, inventoryPanel };
}

/**
 * The post-patch inventory. Clicking a native tab behaves like the game: it becomes selected,
 * the other panels are hidden and emptied, and the selected panel renders its categories.
 * @param {HTMLElement} host
 * @param {string} selectedIcon
 * @param {{ignoreClicks?: boolean}} [options]
 */
function buildNewInventory(host, selectedIcon, { ignoreClicks = false } = {}) {
    const inv = el('div', 'Inventory_items__6SXv0');
    const tabsComponent = el('div', 'TabsComponent_tabsComponent__x TabsComponent_compact__y');
    const tabsContainer = el('div', 'TabsComponent_tabsContainer__a TabsComponent_wrap__z');
    const muiRoot = el('div', 'MuiTabs-root');
    const scroller = el('div', 'MuiTabs-scroller');
    const tabList = el('div', 'MuiTabs-flexContainer');
    tabList.setAttribute('role', 'tablist');
    const panelsContainer = el('div', 'TabsComponent_tabPanelsContainer__b');

    const tabs = [];
    const panels = [];
    const select = (icon) => {
        NATIVE_TAB_ICONS.forEach((id, i) => {
            const selected = id === icon;
            tabs[i].classList.toggle('Mui-selected', selected);
            tabs[i].setAttribute('aria-selected', String(selected));
            panels[i].className = `TabPanel_tabPanel__tXMJF${selected ? '' : ' TabPanel_hidden__26UM3'}`;
            panels[i].replaceChildren();
            if (!selected) return;
            for (const category of TAB_CATEGORIES[id]) {
                const categoryDiv = el('div');
                const inner = el('div');
                const label = el('div', 'Inventory_label__q');
                label.textContent = category;
                const button = el('button', 'Inventory_categoryButton__r');
                button.textContent = category;
                const grid = el('div', 'Inventory_itemGrid__g');
                for (const item of CATEGORY_ITEMS[category]) grid.appendChild(tile(item));
                inner.append(label, button, grid);
                categoryDiv.appendChild(inner);
                panels[i].appendChild(categoryDiv);
            }
        });
    };
    for (const icon of NATIVE_TAB_ICONS) {
        const tab = el('button', 'MuiTab-root');
        tab.setAttribute('role', 'tab');
        tab.appendChild(iconSvg(icon));
        if (!ignoreClicks) tab.addEventListener('click', () => select(icon));
        tabList.appendChild(tab);
        tabs.push(tab);
        panels.push(el('div'));
    }
    panelsContainer.append(...panels);
    scroller.appendChild(tabList);
    muiRoot.appendChild(scroller);
    tabsContainer.appendChild(muiRoot);
    tabsComponent.append(tabsContainer, panelsContainer);
    inv.appendChild(tabsComponent);
    host.appendChild(inv);
    select(selectedIcon);

    const tabFor = (icon) => tabs[NATIVE_TAB_ICONS.indexOf(icon)];
    const selectedIcon_ = () => NATIVE_TAB_ICONS.find((icon) => tabFor(icon).getAttribute('aria-selected') === 'true');
    return { inv, tabsComponent, tabsContainer, tabList, panelsContainer, panels, tabFor, selected: selectedIcon_ };
}

/** The pre-patch inventory: category wrappers directly under Inventory_items */
function buildOldInventory(host) {
    const inv = el('div', 'Inventory_items__6SXv0');
    for (const category of ['currency', 'food', 'resource']) {
        const categoryDiv = el('div');
        const inner = el('div');
        const label = el('div', 'Inventory_label__q');
        label.textContent = category;
        const grid = el('div', 'Inventory_itemGrid__g');
        for (const item of CATEGORY_ITEMS[category]) grid.appendChild(tile(item));
        inner.append(label, grid);
        categoryDiv.appendChild(inner);
        inv.appendChild(categoryDiv);
    }
    host.appendChild(inv);
    return { inv };
}

function newUI() {
    const ui = new CustomTabsUI();
    ui._config = {
        tabs: [{ id: 'food', name: 'Food', color: '', open: true, items: ['/items/cheese'], children: [] }],
    };
    ui._configCharId = game.charId;
    ui._isActive = true;
    return ui;
}

/** The whole-inventory state a layout pass must leave: one section plus Unorganized, all tiles shown */
function expectLaidOut(inv) {
    expect(inv.classList.contains('toolasha-ct-active')).toBe(true);
    expect([...inv.children].filter((c) => c.className.startsWith('toolasha-ct-')).length).toBeGreaterThan(0);
    const visible = [...inv.querySelectorAll('.toolasha-ct-visible')].map(
        (t) => t.querySelector('use').getAttribute('href').split('#')[1]
    );
    expect(visible.sort()).toEqual(['cheese', 'coin', 'milk']);
}

let rafQueue;
beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    storageMock.map.clear();
    storageMock.get.mockClear();
    storageMock.set.mockClear();
    storageMock.delete.mockClear();
    game.charId = 'char-1';
    game.settings.inventoryTabs_defaultTab = false;
    observer.classHandlers.clear();
    observer.readyHandlers.length = 0;
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (fn) => rafQueue.push(fn));
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('native inventory tabs (post-patch DOM)', () => {
    test('the Toolasha button goes into the character panel strip, never the inventory strip', () => {
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        // The inventory strip comes first in document order here, and one of its tabs reads
        // "Inventory": the strip must still never be taken for the character panel's.
        const host = el('div');
        document.body.prepend(host);
        const fixture = buildNewInventory(host, 'inventory_all');
        fixture.tabFor('inventory_all').appendChild(document.createTextNode('Inventory'));

        const ui = new CustomTabsUI();
        ui._isActive = true; // skip the default-tab activation path
        ui._tryInjectTabButton();

        expect(ui._findCharacterTabList()).toBe(characterTabList);
        expect(characterTabList.querySelector('.toolasha-inv-tab')).not.toBeNull();
        expect(fixture.tabList.querySelector('.toolasha-inv-tab')).toBeNull();
        expect(ui._findContentContainer()).toBe(inventoryPanel.parentElement);
        expect(ui._findNativeInventoryTabList(fixture.inv)).toBe(fixture.tabList);
    });

    test('selects "All" when another native tab is selected, then lays out the full inventory', () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'item_category_food');
        const ui = newUI();

        ui._applyLayoutSync(fixture.inv);

        expect(fixture.selected()).toBe('inventory_all');
        expect(ui._savedNativeInvTab).toEqual({ charId: 'char-1', key: 'item_category_food' });
        expect(storageMock.set).toHaveBeenCalledWith(
            'toolasha_local_inventoryNativeTab_char-1',
            'item_category_food',
            'settings'
        );
        // The pass waits for the re-render rather than drawing the Food subset
        expect(fixture.inv.querySelector('.toolasha-ct-section-header')).toBeNull();
        expect(rafQueue).toHaveLength(1);

        ui._applyLayoutSync(fixture.inv);
        expectLaidOut(fixture.inv);
        // Injected elements sit beside the TabsComponent, inside Inventory_items
        expect(fixture.inv.querySelector(':scope > .toolasha-ct-section-header')).not.toBeNull();
        expect(fixture.inv.querySelector(':scope > .toolasha-ct-unorg-header')).not.toBeNull();
    });

    test('leaves the native selection alone when "All" is already selected', () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'inventory_all');
        const click = vi.spyOn(fixture.tabFor('inventory_all'), 'click');
        const ui = newUI();

        ui._applyLayoutSync(fixture.inv);

        expect(click).not.toHaveBeenCalled();
        expect(ui._savedNativeInvTab).toBeNull();
        expect(storageMock.set).not.toHaveBeenCalled();
        expectLaidOut(fixture.inv);
    });

    test('stops clicking after the cap when the game ignores the click', () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'item_category_food', { ignoreClicks: true });
        const click = vi.spyOn(fixture.tabFor('inventory_all'), 'click');
        const ui = newUI();

        ui._applyLayoutSync(fixture.inv);
        ui._applyLayoutSync(fixture.inv);
        ui._applyLayoutSync(fixture.inv);

        expect(click).toHaveBeenCalledTimes(2);
        // Proceeds with what is rendered instead of looping
        expect(fixture.inv.querySelector('.toolasha-ct-section-header')).not.toBeNull();
    });

    test('leaving the Toolasha view restores the player tab and leaves nothing behind', () => {
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'item_category_food');
        const ui = newUI();
        ui._applyLayoutSync(fixture.inv);
        ui._applyLayoutSync(fixture.inv);

        ui._deactivatePanel(characterTabList.querySelector('[role="tab"]'));

        expect(fixture.selected()).toBe('item_category_food');
        expect(storageMock.delete).toHaveBeenCalledWith('toolasha_local_inventoryNativeTab_char-1', 'settings');
        expect(fixture.inv.classList.contains('toolasha-ct-active')).toBe(false);
        expect(fixture.inv.getAttribute('style') || '').toBe('');
        expect(fixture.inv.querySelector('[class*="toolasha-"]')).toBeNull();
        expect(fixture.tabsContainer.getAttribute('style')).toBeNull();
        expect(fixture.tabsComponent.getAttribute('style')).toBeNull();
        expect(fixture.panelsContainer.getAttribute('style')).toBeNull();
        for (const panel of fixture.panels) expect(panel.getAttribute('style')).toBeNull();
    });

    test('a choice stored before a reload inside the Toolasha view is restored on leaving', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        // After the reload the game remembers "All"; the player's choice only survives in storage
        storageMock.map.set('toolasha_local_inventoryNativeTab_char-1', 'item_category_resource');
        const fixture = buildNewInventory(inventoryPanel, 'inventory_all');
        const ui = newUI();
        ui._applyLayoutSync(fixture.inv);

        ui._deactivatePanel();
        await vi.waitFor(() => expect(fixture.selected()).toBe('item_category_resource'));
        expect(storageMock.map.has('toolasha_local_inventoryNativeTab_char-1')).toBe(false);
    });

    test('a stored choice is kept when the view is re-entered during the storage read', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        storageMock.map.set('toolasha_local_inventoryNativeTab_char-1', 'item_category_resource');
        const fixture = buildNewInventory(inventoryPanel, 'inventory_all');
        const ui = newUI();
        ui._applyLayoutSync(fixture.inv);

        const restore = ui._restoreNativeInventoryTab();
        ui._isActive = true;
        await restore;

        expect(fixture.selected()).toBe('inventory_all');
        expect(storageMock.map.get('toolasha_local_inventoryNativeTab_char-1')).toBe('item_category_resource');
    });

    test('a choice made on another character is not restored onto this one', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'item_category_food');
        const ui = newUI();
        ui._applyLayoutSync(fixture.inv);

        game.charId = 'char-2';
        ui._isActive = false;
        await ui._restoreNativeInventoryTab();

        expect(fixture.selected()).toBe('inventory_all');
    });

    test('a player choice made since is never overridden', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'item_category_food');
        const ui = newUI();
        ui._applyLayoutSync(fixture.inv);
        fixture.tabFor('item_category_resource').click();

        ui._isActive = false;
        await ui._restoreNativeInventoryTab();

        expect(fixture.selected()).toBe('item_category_resource');
    });

    test('the stylesheet flattens the panel chain and hides the native strip', () => {
        document.head.appendChild(Object.assign(document.createElement('style'), { textContent: PANEL_CSS }));
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'inventory_all');
        const ui = newUI();
        ui._applyLayoutSync(fixture.inv);

        const display = (node) => getComputedStyle(node).display;
        const selectedPanel = fixture.panels[0];
        const categoryDiv = selectedPanel.firstElementChild;
        expect(display(fixture.inv)).toBe('flex');
        expect(display(fixture.tabsComponent)).toBe('contents');
        expect(display(fixture.panelsContainer)).toBe('contents');
        expect(display(selectedPanel)).toBe('contents');
        expect(display(categoryDiv)).toBe('contents');
        expect(display(categoryDiv.firstElementChild)).toBe('contents');
        expect(display(fixture.inv.querySelector('[class*="Inventory_itemGrid"]'))).toBe('contents');
        expect(display(fixture.tabsContainer)).toBe('none');
        expect(display(fixture.inv.querySelector('[class*="Inventory_label"]'))).toBe('none');
        // A hidden panel is not flattened
        expect(display(fixture.panels[1])).not.toBe('contents');
        // Visible tiles are flex items; our headers are not flattened
        expect(display(fixture.inv.querySelector('.toolasha-ct-visible'))).toBe('flex');
        expect(display(fixture.inv.querySelector('.toolasha-ct-section-header'))).toBe('flex');

        ui._clearLayout();
        // Every rule above is scoped under .toolasha-ct-active (happy-dom's computed-style cache
        // does not see the class removal, so the scope is asserted directly)
        expect(fixture.inv.className).toBe('Inventory_items__6SXv0');
        expect(document.querySelector('.toolasha-ct-active')).toBeNull();
    });
});

describe('a page that starts outside the Toolasha view', () => {
    /** Play the game rendering its strips: the class watcher fires for each tabs container */
    function renderStrips() {
        const handler = observer.classHandlers.get('CustomTabs:TabsComponent_tabsContainer');
        for (const container of document.querySelectorAll('[class*="TabsComponent_tabsContainer"]')) {
            handler(container);
        }
    }

    test('hands back a choice stored by a reload inside the view once the native strip exists', async () => {
        // The previous page reloaded with the view open: the game came back on "All" and the
        // player's tab survives only in storage.
        storageMock.map.set('toolasha_local_inventoryNativeTab_char-1', 'item_category_loot');
        const { inventoryPanel } = buildCharacterPanel();
        const ui = new CustomTabsUI();
        await ui.initialize();
        for (const fn of observer.readyHandlers) fn();

        // The inventory strip renders after the character panel's
        const fixture = buildNewInventory(inventoryPanel, 'inventory_all');
        renderStrips();

        expect(ui._isActive).toBe(false);
        await vi.waitFor(() => expect(fixture.selected()).toBe('item_category_loot'));
        expect(storageMock.map.has('toolasha_local_inventoryNativeTab_char-1')).toBe(false);

        // Consumed once: a later strip render does not read or click again
        storageMock.get.mockClear();
        fixture.tabFor('inventory_all').click();
        renderStrips();
        await Promise.resolve();
        expect(storageMock.get).not.toHaveBeenCalled();
        expect(fixture.selected()).toBe('inventory_all');
        ui.cleanup();
    });

    test('leaves a stored choice of another character alone', async () => {
        storageMock.map.set('toolasha_local_inventoryNativeTab_char-2', 'item_category_loot');
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'inventory_all');
        const ui = new CustomTabsUI();
        await ui.initialize();
        for (const fn of observer.readyHandlers) fn();
        renderStrips();
        await Promise.resolve();
        await Promise.resolve();

        expect(fixture.selected()).toBe('inventory_all');
        expect(storageMock.map.get('toolasha_local_inventoryNativeTab_char-2')).toBe('item_category_loot');
        ui.cleanup();
    });

    test('when the view opens first, the stored choice waits for its exit', async () => {
        game.settings.inventoryTabs_defaultTab = true;
        storageMock.map.set('toolasha_local_inventoryNativeTab_char-1', 'item_category_loot');
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, 'inventory_all');
        const ui = new CustomTabsUI();
        await ui.initialize();
        for (const fn of observer.readyHandlers) fn();
        renderStrips();
        await Promise.resolve();

        expect(ui._isActive).toBe(true);
        expect(fixture.selected()).toBe('inventory_all');
        expect(storageMock.map.get('toolasha_local_inventoryNativeTab_char-1')).toBe('item_category_loot');

        ui._deactivatePanel();
        await vi.waitFor(() => expect(fixture.selected()).toBe('item_category_loot'));
        ui.cleanup();
    });
});

describe('pre-patch inventory DOM', () => {
    test('lays out as before, with no native-tab clicks or storage writes', () => {
        document.head.appendChild(Object.assign(document.createElement('style'), { textContent: PANEL_CSS }));
        const { inventoryPanel } = buildCharacterPanel();
        const { inv } = buildOldInventory(inventoryPanel);
        const ui = newUI();

        ui._applyLayoutSync(inv);

        expect(ui._findNativeInventoryTabList(inv)).toBeNull();
        expect(storageMock.set).not.toHaveBeenCalled();
        expect(rafQueue).toHaveLength(0);
        expectLaidOut(inv);
        const categoryDiv = inv.firstElementChild;
        expect(getComputedStyle(categoryDiv).display).toBe('contents');
        expect(getComputedStyle(inv.querySelector('[class*="Inventory_itemGrid"]')).display).toBe('contents');
    });

    test('leaving the view makes no native-tab restore attempt', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const { inv } = buildOldInventory(inventoryPanel);
        const ui = newUI();
        ui._applyLayoutSync(inv);

        ui._deactivatePanel();
        await Promise.resolve();

        expect(storageMock.get).not.toHaveBeenCalled();
        expect(inv.classList.contains('toolasha-ct-active')).toBe(false);
        expect(inv.querySelector('[class*="toolasha-"]')).toBeNull();
    });
});
