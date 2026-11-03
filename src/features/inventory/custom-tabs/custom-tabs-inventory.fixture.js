/**
 * A game-shaped inventory DOM for the custom tabs tests, so a test can run the real layout (`_applyLayout`,
 * `_applyLayoutSync`) instead of standing in for it.
 *
 * Mirrors the DOM measured on test.milkywayidle.com on 2026-09-25:
 *
 *   Inventory_items
 *   └ TabsComponent_tabsComponent.TabsComponent_compact
 *       ├ TabsComponent_tabsContainer > MuiTabs-root > MuiTabs-scroller > [role=tablist] > [role=tab]…
 *       └ TabsComponent_tabPanelsContainer > TabPanel_tabPanel (one per tab, others TabPanel_hidden)
 *           └ div (category) > div > Inventory_itemGrid (+ Inventory_label, Inventory_categoryButton)
 *
 * Each tile is an `Item_itemContainer` holding an icon whose sprite id names the item (`#cheese` is
 * `/items/cheese`), the way the layout reads a tile's hrid. The items are coin (currency), cheese (food) and
 * milk (resource). `buildOldInventory` is the pre-patch shape: category wrappers directly under
 * `Inventory_items`, no tab strip.
 */

export const NATIVE_TAB_ICONS = [
    'inventory_all',
    'item_category_currency',
    'item_category_loot',
    'item_category_food',
    'item_category_resource',
];
/** Which categories each native tab renders; "All" renders every one */
export const TAB_CATEGORIES = {
    inventory_all: ['currency', 'food', 'resource'],
    item_category_currency: ['currency'],
    item_category_loot: [],
    item_category_food: ['food'],
    item_category_resource: ['resource'],
};
export const CATEGORY_ITEMS = { currency: ['coin'], food: ['cheese'], resource: ['milk'] };

export function el(tag, className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

export function iconSvg(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/static/media/sprites.abc.svg#${id}`);
    svg.appendChild(use);
    return svg;
}

export function tile(itemId) {
    const node = el('div', 'Item_itemContainer__x1');
    node.appendChild(iconSvg(itemId));
    return node;
}

/** The character panel: its own tab strip (Inventory, Equipment) and its panels */
export function buildCharacterPanel() {
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
export function buildNewInventory(host, selectedIcon, { ignoreClicks = false } = {}) {
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
    // The game's own state: the panel it renders. The Toolasha tab in the strip clears the
    // selected tab's marks visually while its view is open, so the marks are not the state.
    const selectedIcon_ = () => NATIVE_TAB_ICONS.find((_icon, i) => !panels[i].className.includes('TabPanel_hidden'));
    return { inv, tabsComponent, tabsContainer, tabList, panelsContainer, panels, tabFor, selected: selectedIcon_ };
}

/** The pre-patch inventory: category wrappers directly under Inventory_items */
export function buildOldInventory(host) {
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
