/** @vitest-environment happy-dom
 *
 * Inventory Sort — native inventory tabs (2026-09 game patch).
 *
 * `applyCurrentSort()` used to find categories by walking `inventoryElem.children` and reading
 * the first `Inventory_categoryButton` found inside each child. On the old DOM each child *is* a
 * category div, so that worked. The 2026-09 patch gave the inventory its own tab strip:
 * `Inventory_items` now has a single child, the `TabsComponent`, so the whole inventory was
 * treated as one category named after whichever button `querySelector` happened to find first
 * (e.g. "Currencies") — measured live giving every tile in Loots and Equipment an inline `order`,
 * though Loots must never sort and Equipment must not sort with `invSort_sortEquipment` off.
 *
 * A first fix climbed from the button looking for an ancestor whose *subtree contained* an
 * `Inventory_itemGrid` — but the real nesting (checked live on the new DOM) is
 * `Inventory_categoryButton` inside `Inventory_label` inside `Inventory_itemGrid`, with the tiles
 * as the grid's other direct children. That climb necessarily skips the grid itself (a
 * descendant search never matches the node it starts from) and lands one level too high, on a
 * wrapper div that is also an ancestor of every *sibling* category's grid — so every category
 * resolved to the same over-broad container, and each category's own shouldSort/reset in turn
 * clobbered every other category's order. Measured live: zero tiles ended up with any order at
 * all, since whichever category is processed last always wins.
 *
 * The real fix: `categoryButton.closest('[class*="Inventory_itemGrid"]')`. `closest()` checks the
 * element itself before its ancestors, so it lands on the grid — already the smallest container
 * that owns both the button and the tiles, in both DOM shapes, since only the wrapper divs above
 * the grid differ between them.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ invSort: true, invSort_sortEquipment: false }));
/** Callbacks registered with the DOM observer, so a test can play a class match or a tab switch */
const observer = vi.hoisted(() => ({ classHandlers: new Map() }));

vi.mock('../../core/config.js', () => ({
    default: {
        COLOR_ACCENT: '#fff',
        getSetting: (key) => settings[key],
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, fn) => {
            observer.classHandlers.set(`${name}:${className}`, fn);
            return () => observer.classHandlers.delete(`${name}:${className}`);
        },
        // The shared observer is already attached in these tests, so a ready handler runs at once.
        onReady: (_name, fn) => {
            fn();
            return () => {};
        },
    },
}));
vi.mock('../../api/marketplace.js', () => ({
    default: { on: () => {}, off: () => {}, isLoaded: () => true },
}));
vi.mock('../../utils/formatters.js', () => ({ formatKMB: (v) => String(v) }));
vi.mock('../../core/data-manager.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('./inventory-badge-manager.js', () => ({
    default: {
        registerProvider: () => {},
        unregisterProvider: () => {},
        invalidateCache: () => {},
        clearProcessedTracking: () => {},
        renderAllBadges: async () => {},
    },
}));
vi.mock('./inventory-badge-mode.js', () => ({ BADGE_MODE_SETTING: 'invBadgeMode', stackBadgeValueKey: () => null }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerInterval: () => {}, registerTimeout: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/character-key.js', () => ({ readScoped: async () => null, writeScoped: () => {} }));
vi.mock('../../utils/init-ownership.js', () => ({
    captureOwner: () => ({}),
    stillOurs: () => true,
    noteTeardown: () => {},
}));

const { default: inventorySort } = await import('./inventory-sort.js');

function el(tag, className = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    return node;
}

function tile(hrid, askValue) {
    const node = el('div', 'Item_itemContainer__x1');
    node.dataset.hrid = hrid;
    node.dataset.askValue = String(askValue);
    return node;
}

/**
 * A category, built to the real measured nesting: the button lives inside the label, and the
 * label and the item tiles are direct siblings inside the item grid. The grid is the returned
 * element — it is already the container that owns both the button (via the label) and the tiles.
 */
function category(name, items) {
    const grid = el('div', 'Inventory_itemGrid__g');
    const label = el('div', 'Inventory_label__q');
    const button = el('button', 'Inventory_categoryButton__r');
    button.textContent = name;
    label.append(button);
    grid.append(label);
    for (const [hrid, value] of items) grid.appendChild(tile(hrid, value));
    return grid;
}

/** Pre-patch DOM (still live on the main server until it updates): item grids are direct children */
function buildOldInventory(categories) {
    const inv = el('div', 'Inventory_items__6SXv0');
    for (const [name, items] of categories) inv.appendChild(category(name, items));
    document.body.appendChild(inv);
    return inv;
}

/**
 * Post-patch DOM (2026-09 native inventory tabs): every category's grid is a direct sibling
 * under one shared wrapper div, itself inside another wrapper under the selected tab panel — the
 * measured live chain is `categoryButton < label < itemGrid < div (shared) < div < TabPanel_tabPanel
 * < TabsComponent_tabPanelsContainer`. Only these extra layers above the grid differ from the old
 * DOM; the grid's own contents (label+button, tiles) are unchanged.
 *
 * The shared immediate wrapper matters: it is what made the first attempt at this fix (climbing
 * from the button until an ancestor's subtree *contains* an item grid, rather than checking the
 * button's ancestors for being one) land on the same container for every category — see the file
 * header.
 */
function buildNewInventory(categories) {
    const inv = el('div', 'Inventory_items__6SXv0');
    const tabsComponent = el('div', 'TabsComponent_tabsComponent__x TabsComponent_compact__y');
    const panelsContainer = el('div', 'TabsComponent_tabPanelsContainer__b');
    const panel = el('div', 'TabPanel_tabPanel__t');
    const outerWrap = el('div'); // transitively "contains a grid" too, matching the measured depth
    const listWrap = el('div'); // shared immediate parent of every category's grid in this panel
    for (const [name, items] of categories) {
        listWrap.appendChild(category(name, items));
    }
    outerWrap.appendChild(listWrap);
    panel.appendChild(outerWrap);
    panelsContainer.appendChild(panel);
    tabsComponent.appendChild(panelsContainer);
    inv.appendChild(tabsComponent);
    document.body.appendChild(inv);
    return { inv, panel, listWrap };
}

const CATEGORIES = [
    [
        'Currencies',
        [
            ['c1', 10],
            ['c2', 30],
        ],
    ],
    [
        'Loots',
        [
            ['l1', 5],
            ['l2', 50],
        ],
    ],
    [
        'Equipment',
        [
            ['e1', 100],
            ['e2', 1],
        ],
    ],
];

function itemsByHrid(root) {
    const map = new Map();
    for (const node of root.querySelectorAll('[class*="Item_itemContainer"]')) {
        map.set(node.dataset.hrid, node);
    }
    return map;
}

describe('InventorySort.applyCurrentSort — category scoping', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        settings.invSort = true;
        settings.invSort_sortEquipment = false;
        inventorySort.currentMode = 'ask';
        inventorySort.isCalculating = false;
    });

    afterEach(() => {
        inventorySort.currentInventoryElem = null;
    });

    test('old DOM: sorts Currencies, never sorts Loots, respects invSort_sortEquipment off', async () => {
        const inv = buildOldInventory(CATEGORIES);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        // Currencies: sorted descending by ask value (c2=30 first, order 0; c1=10 second, order 1)
        expect(items.get('c2').style.order).toBe('0');
        expect(items.get('c1').style.order).toBe('1');
        // Loots never sorts, regardless of price
        expect(items.get('l1').style.order).toBe('');
        expect(items.get('l2').style.order).toBe('');
        // Equipment does not sort while invSort_sortEquipment is off
        expect(items.get('e1').style.order).toBe('');
        expect(items.get('e2').style.order).toBe('');
    });

    test('new DOM (native inventory tabs): same per-category behavior as old DOM', async () => {
        // Regression for the bug described above: every category must resolve to its own grid,
        // not a shared wrapper, or Loots/Equipment either get sorted or wipe Currencies' order.
        const { inv } = buildNewInventory(CATEGORIES);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('c2').style.order).toBe('0');
        expect(items.get('c1').style.order).toBe('1');
        expect(items.get('l1').style.order).toBe('');
        expect(items.get('l2').style.order).toBe('');
        expect(items.get('e1').style.order).toBe('');
        expect(items.get('e2').style.order).toBe('');
    });

    test('new DOM: Equipment sorts once invSort_sortEquipment is on', async () => {
        settings.invSort_sortEquipment = true;
        const { inv } = buildNewInventory(CATEGORIES);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('e1').style.order).toBe('0'); // value 100, highest first
        expect(items.get('e2').style.order).toBe('1'); // value 1
        // Loots still never sorts
        expect(items.get('l1').style.order).toBe('');
        expect(items.get('l2').style.order).toBe('');
    });

    test('new DOM: a sorting category does not clobber a non-sorting sibling sharing a wrapper', async () => {
        // The specific failure mode measured live: if categories resolved to a shared ancestor,
        // processing Loots (shouldSort=false) after Currencies (shouldSort=true) would remove the
        // order Currencies had just set, because both categories' "itemElems" were the same set.
        const { inv } = buildNewInventory([
            [
                'Currencies',
                [
                    ['c1', 10],
                    ['c2', 30],
                ],
            ],
            ['Loots', [['l1', 5]]],
        ]);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('c2').style.order).toBe('0');
        expect(items.get('c1').style.order).toBe('1');
        expect(items.get('l1').style.order).toBe('');
    });

    test('mode "none" clears a previously-assigned inline order rather than pinning it at "0"', async () => {
        const inv = buildOldInventory([
            [
                'Currencies',
                [
                    ['c1', 10],
                    ['c2', 30],
                ],
            ],
        ]);
        inventorySort.currentInventoryElem = inv;
        inventorySort.currentMode = 'ask';
        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('c2').style.order).toBe('0');

        inventorySort.currentMode = 'none';
        await inventorySort.applyCurrentSort();

        // Removed, not left as a literal "0" — same rendered result (0 is the CSS default), but
        // no leftover inline style shadowing anything that reads it later.
        expect(items.get('c1').style.order).toBe('');
        expect(items.get('c2').style.order).toBe('');
        expect(items.get('c1').style.cssText).not.toContain('order');
    });
});

describe('InventorySort — reapplies sort when a native tab switch re-renders tiles', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        observer.classHandlers.clear();
        settings.invSort = true;
        settings.invSort_sortEquipment = false;
        inventorySort.currentMode = 'none';
        inventorySort.isCalculating = false;
        inventorySort.isInitialized = false;
        inventorySort.unregisterHandlers = [];
        inventorySort.initPromise = null;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        inventorySort.disable();
        inventorySort.currentInventoryElem = null;
    });

    test('a fresh Inventory_categoryButton lands and sort reapplies after the debounce', async () => {
        await inventorySort.initialize();

        const { inv, panel, listWrap } = buildNewInventory([['Currencies', [['c1', 10]]]]);
        // Simulate the shared observer's initial class match for Inventory_items.
        observer.classHandlers.get('InventorySort:Inventory_items')(inv);
        inventorySort.currentMode = 'ask';

        // Player switches tabs: the panel's category is replaced with a fresh one carrying new
        // tiles. Inventory_items itself is not re-inserted, so only the categoryButton watcher —
        // not the Inventory_items one — sees this.
        listWrap.replaceChildren();
        listWrap.appendChild(
            category('Currencies', [
                ['c3', 5],
                ['c4', 40],
            ])
        );
        const newButton = panel.querySelector('[class*="Inventory_categoryButton"]');
        observer.classHandlers.get('InventorySortTabSwitch:Inventory_categoryButton')(newButton);

        // Not yet — still inside the debounce window.
        const items = itemsByHrid(inv);
        expect(items.get('c4').style.order).toBe('');

        await vi.advanceTimersByTimeAsync(inventorySort.DEBOUNCE_DELAY);

        expect(items.get('c4').style.order).toBe('0'); // value 40, highest first
        expect(items.get('c3').style.order).toBe('1');
    });

    test('a categoryButton outside the current inventory element is ignored', async () => {
        await inventorySort.initialize();

        const { inv } = buildNewInventory([['Currencies', [['c1', 10]]]]);
        observer.classHandlers.get('InventorySort:Inventory_items')(inv);
        inventorySort.currentMode = 'ask';

        const strayButton = el('button', 'Inventory_categoryButton__stray');
        document.body.appendChild(strayButton);
        observer.classHandlers.get('InventorySortTabSwitch:Inventory_categoryButton')(strayButton);

        await vi.advanceTimersByTimeAsync(inventorySort.DEBOUNCE_DELAY);

        // Nothing to reapply: the existing tile's order is untouched by this no-op trigger.
        const items = itemsByHrid(inv);
        expect(items.get('c1').style.order).toBe('0');
    });
});
