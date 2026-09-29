/**
 * @vitest-environment happy-dom
 *
 * Where the inventory has its own tab strip (game patch 2026-09, test server first), the
 * Toolasha tab lives in that strip, first, before All Items, instead of in the character
 * panel. The pre-patch layout keeps the character-panel button exactly as before.
 *
 * The inventory fixture mirrors the DOM measured on test.milkywayidle.com (see
 * custom-tabs-native-tabs.test.js) and plays React's part in two ways that matter here:
 *  - the strip is reconciled by key: a tab that appears is inserted before its next sibling,
 *    or appended at the end (after anything foreign), and a vanished one is removed;
 *  - a tab click that does not change the selected tab re-renders nothing, so marks cleared
 *    by us stay cleared.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    charId: 'char-1',
    settings: {
        inventoryTabs: true,
        inventoryTabs_showUnorganized: true,
        inventoryTabs_defaultTab: false,
        inventoryTabs_iconRowTab: true,
    },
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

const observer = vi.hoisted(() => ({ classHandlers: new Map(), readyHandlers: [] }));
/** Live setting-change callbacks, so a test can flip a setting the way the settings panel does */
const settingHandlers = vi.hoisted(() => new Map());

vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: (key) => game.settings[key] ?? false,
        getSettingValue: (key, fallback = null) => game.settings[key] ?? fallback,
        onSettingChange: (key, fn) => {
            settingHandlers.set(key, fn);
            return () => settingHandlers.delete(key);
        },
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
    default: { currentInventoryElem: {}, isCalculating: false, isRendering: false, renderAllBadges: async () => {} },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: {} }));
vi.mock('../../../utils/bundle-bridge.js', () => ({
    loadoutSnapshot: () => ({ onUpdate: () => {}, offUpdate: () => {} }),
}));
vi.mock('./custom-tabs-data.js', async (importOriginal) => ({
    ...(await importOriginal()),
    loadConfig: async () => ({
        tabs: [{ id: 'food', name: 'Food', color: '', open: true, items: ['/items/cheese'], children: [] }],
    }),
}));

const { default: CustomTabsUI, PANEL_CSS } = await import('./custom-tabs-ui.js');
const { default: customTabsFeature } = await import('./custom-tabs-feature.js');

const STRIP_TAB = '[data-mwi-toolasha-inv-tab]';
/** Which categories each native tab renders */
const TAB_CATEGORIES = {
    inventory_all: ['currency', 'food', 'resource'],
    favorites_tab: ['food'],
    item_category_currency: ['currency'],
    item_category_food: ['food'],
    item_category_resource: ['resource'],
    item_category_loot: [],
};
const CATEGORY_ITEMS = { currency: ['coin'], food: ['cheese'], resource: ['milk'] };

function el(tag, className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function iconSvg(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'Icon_icon__2LtL_ Icon_small__x');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/static/media/items_sprite.abc.svg#${id}`);
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
    const scroller = el('div', 'MuiTabs-scroller');
    const tabList = el('div', 'MuiTabs-flexContainer');
    tabList.setAttribute('role', 'tablist');
    for (const label of ['Inventory', 'Equipment']) {
        const tab = el('button', `MuiTab-root${label === 'Inventory' ? ' Mui-selected' : ''}`);
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-selected', String(label === 'Inventory'));
        tab.textContent = label;
        tabList.appendChild(tab);
    }
    scroller.appendChild(tabList);
    tabsContainer.appendChild(scroller);
    const panels = el('div', 'TabsComponent_tabPanelsContainer__b');
    const inventoryPanel = el('div', 'TabPanel_tabPanel__tXMJF');
    const equipmentPanel = el('div', 'TabPanel_tabPanel__tXMJF TabPanel_hidden__26UM3');
    panels.append(inventoryPanel, equipmentPanel);
    root.append(tabsContainer, panels);
    document.body.appendChild(root);
    return { characterTabList: tabList, characterScroller: scroller, contentContainer: panels, inventoryPanel };
}

/**
 * The post-patch inventory, driven like React: `state.selected` is the game's selection, the
 * marks on the tabs are its last render of it.
 * @param {HTMLElement} host
 * @param {string[]} icons - Tabs in order
 * @param {string} selected
 */
function buildNewInventory(host, icons, selected) {
    const state = { selected, icons: [] };
    const inv = el('div', 'Inventory_items__6SXv0');
    const tabsComponent = el('div', 'TabsComponent_tabsComponent__x TabsComponent_compact__y');
    const tabsContainer = el('div', 'TabsComponent_tabsContainer__a TabsComponent_wrap__z');
    const muiRoot = el('div', 'MuiTabs-root');
    const scroller = el('div', 'MuiTabs-scroller');
    let tabList = el('div', 'MuiTabs-flexContainer MuiTabs-flexContainerWrap');
    tabList.setAttribute('role', 'tablist');
    const indicator = el('span', 'MuiTabs-indicator css-ttwr4n');
    const panelsContainer = el('div', 'TabsComponent_tabPanelsContainer__b');
    const panel = el('div', 'TabPanel_tabPanel__tXMJF');
    panelsContainer.appendChild(panel);
    const tabEls = new Map();

    const renderPanel = () => {
        panel.replaceChildren();
        for (const category of TAB_CATEGORIES[state.selected] || []) {
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
            panel.appendChild(categoryDiv);
        }
    };
    const markTab = (icon) => {
        const tab = tabEls.get(icon);
        const isSelected = icon === state.selected;
        tab.className = `MuiButtonBase-root MuiTab-root TabsComponent_tab__t css-1q2h7u5${isSelected ? ' Mui-selected' : ''}`;
        tab.setAttribute('aria-selected', String(isSelected));
        tab.setAttribute('tabindex', isSelected ? '0' : '-1');
    };
    const makeTab = (icon) => {
        const tab = el('button');
        tab.setAttribute('role', 'tab');
        tab.setAttribute('type', 'button');
        tab.id = `tab-${icon}`;
        tab.setAttribute('aria-controls', `panel-${icon}`);
        const badge = el('span', 'TabsComponent_badge__b');
        badge.appendChild(iconSvg(icon));
        badge.appendChild(document.createTextNode('12'));
        tab.append(badge, el('span', 'MuiTouchRipple-root css-w0pj6f'));
        tab.addEventListener('click', () => select(icon));
        tabEls.set(icon, tab);
        markTab(icon);
        return tab;
    };
    /** A click: re-renders only what changed, as React does */
    const select = (icon) => {
        if (icon === state.selected) return;
        const previous = state.selected;
        state.selected = icon;
        if (tabEls.has(previous)) markTab(previous);
        markTab(icon);
        renderPanel();
    };
    /** Reconcile the strip to a new tab list, keyed by icon */
    const setTabs = (nextIcons) => {
        for (const icon of state.icons) {
            if (!nextIcons.includes(icon)) {
                tabEls.get(icon).remove();
                tabEls.delete(icon);
            }
        }
        nextIcons.forEach((icon, i) => {
            if (tabEls.has(icon)) return;
            const tab = makeTab(icon);
            const nextKnown = nextIcons.slice(i + 1).find((n) => tabEls.has(n) && state.icons.includes(n));
            if (nextKnown) tabList.insertBefore(tab, tabEls.get(nextKnown));
            else tabList.appendChild(tab);
        });
        state.icons = [...nextIcons];
    };
    /** Remount the whole strip: a new tablist with fresh tabs */
    const remountStrip = () => {
        const fresh = el('div', tabList.className);
        fresh.setAttribute('role', 'tablist');
        tabList.replaceWith(fresh);
        tabList = fresh;
        tabEls.clear();
        const icons_ = state.icons;
        state.icons = [];
        setTabs(icons_);
        return fresh;
    };

    scroller.append(tabList, indicator);
    muiRoot.appendChild(scroller);
    tabsContainer.appendChild(muiRoot);
    tabsComponent.append(tabsContainer, panelsContainer);
    inv.appendChild(tabsComponent);
    host.appendChild(inv);
    setTabs(icons);
    renderPanel();

    return {
        inv,
        tabsContainer,
        indicator,
        get tabList() {
            return tabList;
        },
        tabFor: (icon) => tabEls.get(icon),
        /** The game's selection (its state, not the marks) */
        gameSelected: () => state.selected,
        /** Tabs visually marked selected */
        marked: () =>
            [...tabList.querySelectorAll('[role="tab"]')].filter(
                (t) => t.classList.contains('Mui-selected') || t.getAttribute('aria-selected') === 'true'
            ),
        /** Strip order as icon ids, ours as "toolasha" */
        order: () =>
            [...tabList.children].map((t) =>
                t.matches(STRIP_TAB) ? 'toolasha' : t.querySelector('use').getAttribute('href').split('#')[1]
            ),
        setTabs,
        remountStrip,
    };
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

const CATEGORY_ICONS = ['inventory_all', 'item_category_currency', 'item_category_food', 'item_category_resource'];

/** Let MutationObserver callbacks and promise continuations run */
async function flush() {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Start a UI the way the feature does, and let the game render its strips */
async function startUI() {
    const ui = new CustomTabsUI();
    await ui.initialize();
    for (const fn of observer.readyHandlers) fn();
    renderStrips();
    await flush();
    return ui;
}

/** Play the game rendering its strips: the class watcher fires for each tabs container */
function renderStrips() {
    const handler = observer.classHandlers.get('CustomTabs:TabsComponent_tabsContainer');
    for (const container of document.querySelectorAll('[class*="TabsComponent_tabsContainer"]')) handler?.(container);
}

function visibleTiles(inv) {
    return [...inv.querySelectorAll('.toolasha-ct-visible')]
        .map((t) => t.querySelector('use').getAttribute('href').split('#')[1])
        .sort();
}

let ui = null;
beforeEach(() => {
    document.head.replaceChildren();
    document.body.replaceChildren();
    storageMock.map.clear();
    storageMock.get.mockClear();
    storageMock.set.mockClear();
    storageMock.delete.mockClear();
    game.charId = 'char-1';
    game.settings.inventoryTabs_defaultTab = false;
    game.settings.inventoryTabs_iconRowTab = true;
    settingHandlers.clear();
    observer.classHandlers.clear();
    observer.readyHandlers.length = 0;
    vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0));
});
afterEach(() => {
    ui?.cleanup();
    ui = null;
    customTabsFeature.disable();
    vi.unstubAllGlobals();
});

describe('inventory with its own tab strip', () => {
    test('the Toolasha tab goes first, before All Items, modelled on a native tab', async () => {
        const { characterTabList, characterScroller, contentContainer, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();

        expect(fixture.order()).toEqual(['toolasha', ...CATEGORY_ICONS]);
        const tab = fixture.tabList.querySelector(STRIP_TAB);
        expect(tab.getAttribute('role')).toBe('tab');
        expect(tab.getAttribute('title')).toBe('Toolasha');
        expect(tab.classList.contains('MuiTab-root')).toBe(true);
        expect(tab.classList.contains('TabsComponent_tab__t')).toBe(true);
        expect(tab.classList.contains('Mui-selected')).toBe(false);
        expect(tab.getAttribute('aria-selected')).toBe('false');
        // Icon-only like the natives: the icon's classes, none of the model's text, id or panel
        const icon = tab.querySelector('svg');
        expect(icon.getAttribute('class')).toBe('Icon_icon__2LtL_ Icon_small__x');
        expect(icon.querySelector('use')).toBeNull();
        expect(tab.querySelector('[class*="TabsComponent_badge"]').textContent).toBe('T');
        expect(tab.id).toBe('');
        expect(tab.hasAttribute('aria-controls')).toBe(false);

        // Nothing in the character panel: no button, Inventory tab shown, scroller and content untouched
        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
        expect(characterTabList.querySelector('[role="tab"]').style.display).toBe('');
        expect(characterScroller.getAttribute('style')).toBeNull();
        expect(contentContainer.getAttribute('style')).toBeNull();
        expect(ui._isActive).toBe(false);
    });

    test('stays first whenever React rebuilds the strip', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();

        // Favorites appears after All
        fixture.setTabs(['inventory_all', 'favorites_tab', ...CATEGORY_ICONS.slice(1)]);
        await flush();
        expect(fixture.order()).toEqual(['toolasha', 'inventory_all', 'favorites_tab', ...CATEGORY_ICONS.slice(1)]);

        // A category fills: React appends it, after our tab
        fixture.setTabs(['inventory_all', 'favorites_tab', ...CATEGORY_ICONS.slice(1), 'item_category_loot']);
        await flush();
        expect(fixture.order()[0]).toBe('toolasha');
        expect(fixture.order().at(-1)).toBe('item_category_loot');

        // React moves a keyed tab to the front, ahead of ours
        fixture.tabList.insertBefore(fixture.tabFor('inventory_all'), fixture.tabList.firstChild);
        await flush();
        expect(fixture.order().slice(0, 2)).toEqual(['toolasha', 'inventory_all']);

        // Favorites disappears and a category empties
        fixture.setTabs(['inventory_all', 'item_category_currency', 'item_category_loot']);
        await flush();
        expect(fixture.order()).toEqual(['toolasha', 'inventory_all', 'item_category_currency', 'item_category_loot']);

        // The whole strip is remounted: the class watcher sees the new container's strip
        fixture.remountStrip();
        renderStrips();
        await flush();
        expect(fixture.order()).toEqual(['toolasha', 'inventory_all', 'item_category_currency', 'item_category_loot']);
        expect(document.querySelectorAll(STRIP_TAB)).toHaveLength(1);
    });

    test('clicking it opens the view: our tab takes the selection, the game is forced to All', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        const tab = fixture.tabList.querySelector(STRIP_TAB);

        tab.click();
        await flush();

        expect(ui._isActive).toBe(true);
        expect(fixture.gameSelected()).toBe('inventory_all');
        expect(fixture.marked()).toEqual([tab]);
        expect(tab.getAttribute('aria-selected')).toBe('true');
        expect(ui._savedNativeInvTab).toEqual({ charId: 'char-1', key: 'item_category_food' });
        expect(visibleTiles(fixture.inv)).toEqual(['cheese', 'coin', 'milk']);

        // A strip rebuild while the view is open keeps only ours marked
        fixture.setTabs(['inventory_all', 'favorites_tab', ...CATEGORY_ICONS.slice(1)]);
        await flush();
        expect(fixture.marked()).toEqual([tab]);
        expect(fixture.order()[0]).toBe('toolasha');
    });

    test('only our tab is a tab stop while the view is open; the native one gets its own back', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();
        const tab = fixture.tabList.querySelector(STRIP_TAB);
        const allTab = fixture.tabFor('inventory_all');
        expect(allTab.getAttribute('tabindex')).toBe('0');

        tab.click();
        await flush();
        const stops = [...fixture.tabList.querySelectorAll('[role="tab"]')].filter(
            (t) => t.getAttribute('tabindex') === '0'
        );
        expect(stops).toEqual([tab]);
        expect(allTab.getAttribute('tabindex')).toBe('-1');

        // Leaving by All (a no-op for the game) puts its selection and tab stop back
        allTab.click();
        await flush();
        expect(allTab.getAttribute('tabindex')).toBe('0');
        expect(allTab.getAttribute('aria-selected')).toBe('true');
        expect(tab.getAttribute('tabindex')).toBe('-1');
    });

    test('a tablist React replaces inside the same tabs container gets our tab back', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();

        // No class-watcher pass: the tabs container stays mounted, only the tablist is new
        const fresh = fixture.remountStrip();
        await flush();

        expect(fresh.querySelector(STRIP_TAB)).not.toBeNull();
        expect(fixture.order()[0]).toBe('toolasha');
        expect(fixture.marked()).toEqual([fresh.querySelector(STRIP_TAB)]);
        // The capture listener follows too: a native click on the new tablist leaves the view
        fixture.tabFor('item_category_food').click();
        await flush();
        expect(ui._isActive).toBe(false);
        expect(fixture.gameSelected()).toBe('item_category_food');
    });

    test('the strip stays visible in the view, with the native indicator hidden', async () => {
        document.head.appendChild(Object.assign(document.createElement('style'), { textContent: PANEL_CSS }));
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();

        expect(fixture.inv.classList.contains('toolasha-ct-active')).toBe(true);
        expect(getComputedStyle(fixture.tabsContainer).display).not.toBe('none');
        expect(getComputedStyle(fixture.indicator).display).toBe('none');
    });

    test('a native tab click leaves the view; the player choice wins over the saved one', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        const tab = fixture.tabList.querySelector(STRIP_TAB);
        tab.click();
        await flush();
        const savedTabClick = vi.spyOn(fixture.tabFor('item_category_food'), 'click');

        fixture.tabFor('item_category_resource').click();
        await flush();
        expect(savedTabClick).not.toHaveBeenCalled();

        expect(ui._isActive).toBe(false);
        expect(fixture.gameSelected()).toBe('item_category_resource');
        expect(fixture.marked()).toEqual([fixture.tabFor('item_category_resource')]);
        expect(tab.getAttribute('aria-selected')).toBe('false');
        expect(fixture.inv.classList.contains('toolasha-ct-active')).toBe(false);
        expect(fixture.inv.querySelector('[class*="toolasha-ct-"]')).toBeNull();
        // Not clicked back to the tab saved on entry, and the saved choice is gone
        expect(ui._savedNativeInvTab).toBeNull();
        expect(storageMock.map.has('toolasha_local_inventoryNativeTab_char-1')).toBe(false);
        // Our tab stays in the strip for next time
        expect(fixture.order()[0]).toBe('toolasha');
    });

    test('clicking All, which the game already has selected, shows it selected again', async () => {
        // React re-renders nothing for a click on the selected tab, so only our restore can
        // bring back the marks the view cleared.
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();
        expect(fixture.marked()).toEqual([fixture.tabList.querySelector(STRIP_TAB)]);

        fixture.tabFor('inventory_all').click();
        await flush();

        expect(ui._isActive).toBe(false);
        expect(fixture.marked()).toEqual([fixture.tabFor('inventory_all')]);
        expect(fixture.gameSelected()).toBe('inventory_all');
    });

    test('character panel tabs do not leave the view', async () => {
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();

        ui._deactivatePanel(characterTabList.querySelectorAll('[role="tab"]')[1]);
        characterTabList.querySelectorAll('[role="tab"]')[1].click();
        await flush();

        expect(ui._isActive).toBe(true);
    });

    test('"Toolasha tab by default" opens the inventory on our tab and hides nothing', async () => {
        game.settings.inventoryTabs_defaultTab = true;
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_currency');
        ui = await startUI();

        expect(ui._isActive).toBe(true);
        expect(fixture.gameSelected()).toBe('inventory_all');
        expect(fixture.marked()).toEqual([fixture.tabList.querySelector(STRIP_TAB)]);
        expect(visibleTiles(fixture.inv)).toEqual(['cheese', 'coin', 'milk']);
        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
        const inventoryTab = characterTabList.querySelector('[role="tab"]');
        expect(inventoryTab.style.display).toBe('');
        expect(inventoryTab.classList.contains('Mui-selected')).toBe(true);
        expect(contentContainer.getAttribute('style')).toBeNull();
        for (const child of contentContainer.children) expect(child.getAttribute('style')).toBeNull();

        // Leaving through a native tab sticks while the strip only rebuilds...
        fixture.tabFor('item_category_food').click();
        await flush();
        fixture.setTabs(['inventory_all', 'favorites_tab', ...CATEGORY_ICONS.slice(1)]);
        await flush();
        expect(ui._isActive).toBe(false);

        // ...and while React replaces only the tablist inside the same tabs container
        const fresh = fixture.remountStrip();
        renderStrips();
        await flush();
        expect(ui._isActive).toBe(false);
        expect(fixture.gameSelected()).toBe('item_category_food');
        expect(fixture.marked()).toEqual([fixture.tabFor('item_category_food')]);
        expect(fresh.querySelector(STRIP_TAB)).not.toBeNull();
        expect(fixture.order()[0]).toBe('toolasha');

        // The next time the inventory itself mounts, it opens on our tab again
        fixture.inv.remove();
        const remounted = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        renderStrips();
        await flush();
        expect(ui._isActive).toBe(true);
        expect(remounted.gameSelected()).toBe('inventory_all');
    });

    test('with the default on, a tablist swap alone does not reopen the view after the player left', async () => {
        // No class-watcher pass at all: only the strip observer sees the swap
        game.settings.inventoryTabs_defaultTab = true;
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_currency');
        ui = await startUI();
        expect(ui._isActive).toBe(true);

        fixture.tabFor('item_category_resource').click();
        await flush();
        expect(ui._isActive).toBe(false);

        const fresh = fixture.remountStrip();
        await flush();

        expect(ui._isActive).toBe(false);
        expect(fixture.gameSelected()).toBe('item_category_resource');
        expect(fixture.marked()).toEqual([fixture.tabFor('item_category_resource')]);
        expect(fresh.querySelector(STRIP_TAB)).not.toBeNull();
        expect(fixture.order()[0]).toBe('toolasha');
    });

    test('an inventory mounting after the character panel moves the tab into its strip', async () => {
        // Before the inventory exists nothing tells the layouts apart, so the character panel
        // gets the old button; the strip's arrival retires it.
        game.settings.inventoryTabs_defaultTab = true;
        const { characterTabList, characterScroller, contentContainer, inventoryPanel } = buildCharacterPanel();
        ui = await startUI();
        expect(characterTabList.querySelector('.toolasha-inv-tab')).not.toBeNull();

        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        renderStrips();
        await flush();

        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
        const inventoryTab = characterTabList.querySelector('[role="tab"]');
        expect(inventoryTab.style.display).toBe('');
        expect(inventoryTab.classList.contains('Mui-selected')).toBe(true);
        expect(characterScroller.style.overflow).toBe('');
        expect(contentContainer.style.display).toBe('');
        for (const child of contentContainer.children) expect(child.style.display).toBe('');
        expect(ui._isActive).toBe(true);
        expect(fixture.marked()).toEqual([fixture.tabList.querySelector(STRIP_TAB)]);
        expect(fixture.gameSelected()).toBe('inventory_all');

        // The strip unmounting later does not bring the old button back
        fixture.inv.remove();
        ui._tryInjectTabButton();
        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
    });
});

describe('control row', () => {
    /** @param {HTMLElement} root */
    async function checkIconButtons(root) {
        const expand = root.querySelector('[aria-label="Expand all tabs"]');
        const collapse = root.querySelector('[aria-label="Collapse all tabs"]');
        expect(expand.title).toBe('Expand all tabs');
        expect(collapse.title).toBe('Collapse all tabs');
        expect(expand.classList.contains('toolasha-ct-add-btn')).toBe(true);
        expect(expand.textContent).not.toMatch(/Expand/i);
        expect(collapse.textContent).not.toMatch(/Collapse/i);
        const setAll = vi.spyOn(ui, '_onSetAllTabsOpen').mockImplementation(() => {});
        collapse.click();
        expand.click();
        expect(setAll.mock.calls).toEqual([[false], [true]]);
        setAll.mockRestore();
    }

    test('Expand/Collapse all are titled icon buttons with the same handlers, on the strip layout', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();
        await checkIconButtons(fixture.inv);
    });

    test('...and on the pre-patch layout', async () => {
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        const { inv } = buildOldInventory(inventoryPanel);
        ui = await startUI();
        characterTabList.querySelector('.toolasha-inv-tab').click();
        await flush();
        await checkIconButtons(inv);
    });
});

describe('cleanup', () => {
    test('cleanup with the view open removes our tab and restores the native selection', async () => {
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();
        expect(fixture.gameSelected()).toBe('inventory_all');

        ui.cleanup();
        ui = null;
        await flush();

        expect(document.querySelector(STRIP_TAB)).toBeNull();
        expect(fixture.tabsContainer.hasAttribute('data-mwi-toolasha-inv-strip')).toBe(false);
        expect(fixture.gameSelected()).toBe('item_category_food');
        expect(fixture.marked()).toEqual([fixture.tabFor('item_category_food')]);
        expect(fixture.inv.querySelector('[class*="toolasha-"]')).toBeNull();

        // Nothing is watching any more
        fixture.setTabs(['inventory_all', 'favorites_tab', ...CATEGORY_ICONS.slice(1)]);
        await flush();
        expect(document.querySelector(STRIP_TAB)).toBeNull();
    });

    test('the feature turning off, or a character switch tearing it down, removes the tab', async () => {
        // The registry runs disable() for both
        const { inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        await customTabsFeature.initialize();
        for (const fn of observer.readyHandlers) fn();
        await flush();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();
        expect(fixture.marked()).toEqual([fixture.tabList.querySelector(STRIP_TAB)]);

        customTabsFeature.disable();
        await flush();

        expect(document.querySelector(STRIP_TAB)).toBeNull();
        expect(fixture.marked()).toEqual([fixture.tabFor('inventory_all')]);
        expect(fixture.inv.classList.contains('toolasha-ct-active')).toBe(false);

        // The next character's UI builds its own tab
        game.charId = 'char-2';
        observer.readyHandlers.length = 0;
        await customTabsFeature.initialize();
        for (const fn of observer.readyHandlers) fn();
        await flush();
        expect(document.querySelectorAll(STRIP_TAB)).toHaveLength(1);
        expect(fixture.order()[0]).toBe('toolasha');
    });
});

describe('inventory behind another character panel tab', () => {
    /** Character panel on Equipment: the Inventory panel is hidden, its inventory still mounted */
    function showEquipment(characterTabList, contentContainer) {
        const [inventoryTab, equipmentTab] = characterTabList.querySelectorAll('[role="tab"]');
        inventoryTab.classList.remove('Mui-selected');
        inventoryTab.setAttribute('aria-selected', 'false');
        equipmentTab.classList.add('Mui-selected');
        equipmentTab.setAttribute('aria-selected', 'true');
        contentContainer.children[0].className = 'TabPanel_tabPanel__tXMJF TabPanel_hidden__26UM3';
        contentContainer.children[1].className = 'TabPanel_tabPanel__tXMJF';
    }
    function showInventory(characterTabList, contentContainer) {
        const [inventoryTab, equipmentTab] = characterTabList.querySelectorAll('[role="tab"]');
        equipmentTab.classList.remove('Mui-selected');
        equipmentTab.setAttribute('aria-selected', 'false');
        inventoryTab.classList.add('Mui-selected');
        inventoryTab.setAttribute('aria-selected', 'true');
        contentContainer.children[0].className = 'TabPanel_tabPanel__tXMJF';
        contentContainer.children[1].className = 'TabPanel_tabPanel__tXMJF TabPanel_hidden__26UM3';
    }
    const DETACHED = 'CustomTabs_detachedRestore:TabsComponent_tabsContainer';

    test('the default setting leaves the character panel alone and the inventory opens on Toolasha', async () => {
        // The setting means: whenever the inventory is shown, it shows the Toolasha view. It
        // never switches the character panel away from what the player has open.
        game.settings.inventoryTabs_defaultTab = true;
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        showEquipment(characterTabList, contentContainer);
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();

        const [inventoryTab, equipmentTab] = characterTabList.querySelectorAll('[role="tab"]');
        expect(equipmentTab.classList.contains('Mui-selected')).toBe(true);
        expect(inventoryTab.classList.contains('Mui-selected')).toBe(false);
        expect(contentContainer.children[0].className).toContain('TabPanel_hidden');
        for (const panel of contentContainer.children) expect(panel.getAttribute('style')).toBeNull();

        // The player opens the inventory: it is already the Toolasha view
        showInventory(characterTabList, contentContainer);
        await flush();
        expect(ui._isActive).toBe(true);
        expect(fixture.marked()).toEqual([fixture.tabList.querySelector(STRIP_TAB)]);
        expect(fixture.gameSelected()).toBe('inventory_all');
        expect(visibleTiles(fixture.inv)).toEqual(['cheese', 'coin', 'milk']);
    });

    test('the same holds when the game remounts the inventory on showing it', async () => {
        game.settings.inventoryTabs_defaultTab = true;
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        showEquipment(characterTabList, contentContainer);
        const first = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        expect(ui._isActive).toBe(true);

        first.inv.remove();
        showInventory(characterTabList, contentContainer);
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        renderStrips();
        await flush();

        expect(ui._isActive).toBe(true);
        expect(fixture.marked()).toEqual([fixture.tabList.querySelector(STRIP_TAB)]);
        expect(visibleTiles(fixture.inv)).toEqual(['cheese', 'coin', 'milk']);
    });

    test('disabled while the inventory is unmounted, the saved tab comes back when it remounts', async () => {
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        const first = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        first.tabList.querySelector(STRIP_TAB).click();
        await flush();
        expect(first.gameSelected()).toBe('inventory_all');

        // Equipment unmounts the inventory, then the feature is turned off
        first.inv.remove();
        showEquipment(characterTabList, contentContainer);
        ui.cleanup();
        ui = null;
        await flush();
        expect(storageMock.map.get('toolasha_local_inventoryNativeTab_char-1')).toBe('item_category_food');

        // The game remounts the inventory on its remembered tab, the forced All
        showInventory(characterTabList, contentContainer);
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        const restore = observer.classHandlers.get(DETACHED);
        expect(restore).toBeTypeOf('function');
        // The character panel strip is not the inventory's: ignored, still pending
        restore(characterTabList.closest('[class*="TabsComponent_tabsContainer"]'));
        expect(observer.classHandlers.has(DETACHED)).toBe(true);
        restore(fixture.tabsContainer);
        await flush();

        expect(fixture.gameSelected()).toBe('item_category_food');
        expect(storageMock.map.has('toolasha_local_inventoryNativeTab_char-1')).toBe(false);
        // One-shot
        expect(observer.classHandlers.has(DETACHED)).toBe(false);
    });

    test('the left-behind restore skips another character and yields to a new instance', async () => {
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        const first = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        first.tabList.querySelector(STRIP_TAB).click();
        await flush();
        first.inv.remove();
        showEquipment(characterTabList, contentContainer);
        ui.cleanup();
        ui = null;

        // Another character: no click, and the first character's stored choice stays
        game.charId = 'char-2';
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        observer.classHandlers.get(DETACHED)(fixture.tabsContainer);
        await flush();
        expect(fixture.gameSelected()).toBe('inventory_all');
        expect(storageMock.map.get('toolasha_local_inventoryNativeTab_char-1')).toBe('item_category_food');
        expect(observer.classHandlers.has(DETACHED)).toBe(false);

        // A new instance cancels a pending one (it restores from storage itself)
        game.charId = 'char-1';
        fixture.inv.remove();
        const again = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        observer.readyHandlers.length = 0; // the mock's onReady cannot unregister the dead instance's
        ui = await startUI();
        again.tabList.querySelector(STRIP_TAB).click();
        await flush();
        again.inv.remove();
        ui.cleanup();
        ui = null;
        expect(observer.classHandlers.has(DETACHED)).toBe(true);
        observer.readyHandlers.length = 0;
        ui = new CustomTabsUI();
        await ui.initialize();
        // Not yet: this instance has no strip to act on
        expect(observer.classHandlers.has(DETACHED)).toBe(true);
        const mounted = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        renderStrips();
        await flush();
        expect(observer.classHandlers.has(DETACHED)).toBe(false);
        // It restored through the stored choice itself
        await vi.waitFor(() => expect(mounted.gameSelected()).toBe('item_category_food'));
    });

    test('an instance enabled and disabled while the inventory stays unmounted keeps the restorer', async () => {
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        const first = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        first.tabList.querySelector(STRIP_TAB).click();
        await flush();
        first.inv.remove();
        showEquipment(characterTabList, contentContainer);
        ui.cleanup();
        ui = null;

        // Enabled (its config loads) and disabled again, never seeing an inventory strip
        observer.readyHandlers.length = 0;
        const between = await startUI();
        expect(between._invTabBtn).toBeNull();
        between.cleanup();
        expect(observer.classHandlers.has(DETACHED)).toBe(true);

        showInventory(characterTabList, contentContainer);
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        observer.classHandlers.get(DETACHED)(fixture.tabsContainer);
        await flush();
        expect(fixture.gameSelected()).toBe('item_category_food');
    });

    test('the icon-row setting turned off meanwhile still hands the saved tab back on remount', async () => {
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        const first = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        first.tabList.querySelector(STRIP_TAB).click();
        await flush();
        expect(first.gameSelected()).toBe('inventory_all');

        // Equipment unmounts the inventory; the tab moves to the character panel meanwhile
        first.inv.remove();
        showEquipment(characterTabList, contentContainer);
        game.settings.inventoryTabs_iconRowTab = false;
        settingHandlers.get('inventoryTabs_iconRowTab')();
        await flush();
        expect(ui._isActive).toBe(false);

        // The game remounts the inventory on the forced All
        showInventory(characterTabList, contentContainer);
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        renderStrips();
        await flush();

        expect(fixture.gameSelected()).toBe('item_category_food');
        expect(storageMock.map.has('toolasha_local_inventoryNativeTab_char-1')).toBe(false);
    });

    test('an instance torn down before its config loads leaves the restorer in place', async () => {
        const { characterTabList, contentContainer, inventoryPanel } = buildCharacterPanel();
        const first = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        first.tabList.querySelector(STRIP_TAB).click();
        await flush();
        first.inv.remove();
        showEquipment(characterTabList, contentContainer);
        ui.cleanup();
        ui = null;
        expect(observer.classHandlers.has(DETACHED)).toBe(true);

        // Enabled, then disabled again while loadConfig is still pending
        const shortLived = new CustomTabsUI();
        const init = shortLived.initialize();
        shortLived.cleanup();
        await init;
        expect(observer.classHandlers.has(DETACHED)).toBe(true);

        // ...so the saved tab still comes back when the inventory remounts
        showInventory(characterTabList, contentContainer);
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        observer.classHandlers.get(DETACHED)(fixture.tabsContainer);
        await flush();
        expect(fixture.gameSelected()).toBe('item_category_food');
    });
});

describe('"Toolasha tab in the inventory\'s icon row" setting', () => {
    test('off: the character-panel button on the new layout, and the view still forces All', async () => {
        game.settings.inventoryTabs_iconRowTab = false;
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();

        expect(document.querySelector(STRIP_TAB)).toBeNull();
        const tabs = [...characterTabList.querySelectorAll('[role="tab"]')];
        expect(tabs.map((t) => t.textContent)).toEqual(['Inventory', 'Toolasha', 'Equipment']);

        tabs[1].click();
        await flush();
        expect(ui._isActive).toBe(true);
        expect(fixture.gameSelected()).toBe('inventory_all');
        expect(visibleTiles(fixture.inv)).toEqual(['cheese', 'coin', 'milk']);
        expect(document.querySelector(STRIP_TAB)).toBeNull();

        // Leaving through the character panel hands the native tab back
        tabs[2].click();
        await flush();
        expect(ui._isActive).toBe(false);
        expect(fixture.gameSelected()).toBe('item_category_food');
    });

    test('on: the strip tab, and no character-panel button', async () => {
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'inventory_all');
        ui = await startUI();

        expect(fixture.order()[0]).toBe('toolasha');
        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
    });

    test('switching it live moves the tab, closing the view on the way', async () => {
        const { characterTabList, characterScroller, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        fixture.tabList.querySelector(STRIP_TAB).click();
        await flush();
        expect(ui._isActive).toBe(true);

        // On → off
        game.settings.inventoryTabs_iconRowTab = false;
        settingHandlers.get('inventoryTabs_iconRowTab')();
        await flush();
        expect(ui._isActive).toBe(false);
        expect(document.querySelector(STRIP_TAB)).toBeNull();
        expect(fixture.tabsContainer.hasAttribute('data-mwi-toolasha-inv-strip')).toBe(false);
        expect(fixture.gameSelected()).toBe('item_category_food');
        expect(fixture.marked()).toEqual([fixture.tabFor('item_category_food')]);
        expect(characterTabList.querySelector('.toolasha-inv-tab')).not.toBeNull();

        // Off → on
        game.settings.inventoryTabs_iconRowTab = true;
        settingHandlers.get('inventoryTabs_iconRowTab')();
        await flush();
        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
        expect(characterScroller.style.overflow).toBe('');
        expect(fixture.order()[0]).toBe('toolasha');
        expect(document.querySelectorAll(STRIP_TAB)).toHaveLength(1);
    });
    test('switched on from an open character-panel view, the character tab the game has is marked again', async () => {
        game.settings.inventoryTabs_iconRowTab = false;
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        const fixture = buildNewInventory(inventoryPanel, CATEGORY_ICONS, 'item_category_food');
        ui = await startUI();
        characterTabList.querySelector('.toolasha-inv-tab').click();
        await flush();
        const inventoryTab = characterTabList.querySelector('[role="tab"]');
        expect(inventoryTab.classList.contains('Mui-selected')).toBe(false);

        game.settings.inventoryTabs_iconRowTab = true;
        settingHandlers.get('inventoryTabs_iconRowTab')();
        await flush();

        expect(ui._isActive).toBe(false);
        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
        // The game never left Inventory; its tab shows that again
        expect(inventoryTab.classList.contains('Mui-selected')).toBe(true);
        expect(inventoryTab.getAttribute('aria-selected')).toBe('true');
        expect(fixture.gameSelected()).toBe('item_category_food');
        expect(fixture.order()[0]).toBe('toolasha');
    });
});

describe('pre-patch layout (no native strip)', () => {
    test('keeps the character-panel button after Inventory, exactly as before', async () => {
        const { characterTabList, characterScroller, inventoryPanel } = buildCharacterPanel();
        const { inv } = buildOldInventory(inventoryPanel);
        ui = await startUI();

        const tabs = [...characterTabList.querySelectorAll('[role="tab"]')];
        expect(tabs.map((t) => t.textContent)).toEqual(['Inventory', 'Toolasha', 'Equipment']);
        expect(tabs[1].classList.contains('toolasha-inv-tab')).toBe(true);
        expect(tabs[1].hasAttribute('data-mwi-toolasha-inv-tab')).toBe(false);
        expect(characterScroller.style.overflow).toBe('auto');
        expect(document.querySelector(STRIP_TAB)).toBeNull();

        tabs[1].click();
        await flush();
        expect(ui._isActive).toBe(true);
        expect(tabs[1].classList.contains('Mui-selected')).toBe(true);
        expect(tabs[0].classList.contains('Mui-selected')).toBe(false);
        expect(visibleTiles(inv)).toEqual(['cheese', 'coin', 'milk']);

        // A character panel tab leaves the view
        tabs[2].click();
        expect(ui._isActive).toBe(false);
        expect(tabs[2].classList.contains('Mui-selected')).toBe(true);
    });

    test('"Toolasha tab by default" still hides the Inventory tab and opens the view', async () => {
        game.settings.inventoryTabs_defaultTab = true;
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        const { inv } = buildOldInventory(inventoryPanel);
        ui = await startUI();

        expect(ui._isActive).toBe(true);
        expect(characterTabList.querySelector('[role="tab"]').style.display).toBe('none');
        expect(visibleTiles(inv)).toEqual(['cheese', 'coin', 'milk']);

        ui.cleanup();
        ui = null;
        expect(characterTabList.querySelector('[role="tab"]').style.display).toBe('');
        expect(characterTabList.querySelector('.toolasha-inv-tab')).toBeNull();
    });

    test('cleanup with the view open marks the character tab the game has again', async () => {
        const { characterTabList, inventoryPanel } = buildCharacterPanel();
        buildOldInventory(inventoryPanel);
        ui = await startUI();
        characterTabList.querySelector('.toolasha-inv-tab').click();
        await flush();

        ui.cleanup();
        ui = null;

        const inventoryTab = characterTabList.querySelector('[role="tab"]');
        expect(inventoryTab.classList.contains('Mui-selected')).toBe(true);
        expect(inventoryTab.getAttribute('aria-selected')).toBe('true');
    });
});
