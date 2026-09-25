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
 * The fix finds category containers structurally (the element that owns an
 * `Inventory_categoryButton` and an `Inventory_itemGrid`), which resolves correctly whichever DOM
 * shape is live, detected by structure rather than hostname.
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

/** A category's inner container: label, button and item grid as siblings, matching both DOM shapes */
function category(name, items) {
    const inner = el('div');
    const label = el('div', 'Inventory_label__q');
    label.textContent = name;
    const button = el('button', 'Inventory_categoryButton__r');
    button.textContent = name;
    const grid = el('div', 'Inventory_itemGrid__g');
    for (const [hrid, value] of items) grid.appendChild(tile(hrid, value));
    inner.append(label, button, grid);
    return inner;
}

/** Pre-patch DOM (still live on the main server until it updates): category divs are direct children */
function buildOldInventory(categories) {
    const inv = el('div', 'Inventory_items__6SXv0');
    for (const [name, items] of categories) {
        const wrap = el('div');
        wrap.appendChild(category(name, items));
        inv.appendChild(wrap);
    }
    document.body.appendChild(inv);
    return inv;
}

/** Post-patch DOM (2026-09 native inventory tabs): categories nest inside the selected tab panel */
function buildNewInventory(categories) {
    const inv = el('div', 'Inventory_items__6SXv0');
    const tabsComponent = el('div', 'TabsComponent_tabsComponent__x TabsComponent_compact__y');
    const panelsContainer = el('div', 'TabsComponent_tabPanelsContainer__b');
    const panel = el('div', 'TabPanel_tabPanel__t');
    const listWrap = el('div');
    for (const [name, items] of categories) {
        const wrap = el('div');
        wrap.appendChild(category(name, items));
        listWrap.appendChild(wrap);
    }
    panel.appendChild(listWrap);
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
        // Pre-fix, `inventoryElem.children` has one child (the TabsComponent), so the whole
        // inventory was named after whichever categoryButton `querySelector` found first and
        // every tile in every category was sorted or reset together as that one category.
        const { inv } = buildNewInventory(CATEGORIES);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('c2').style.order).toBe('0');
        expect(items.get('c1').style.order).toBe('1');
        // The bug this regression guards: Loots and Equipment tiles got an inline order too,
        // because they were folded into the single "Currencies" category found by querySelector.
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
        const wrap = el('div');
        wrap.appendChild(
            category('Currencies', [
                ['c3', 5],
                ['c4', 40],
            ])
        );
        listWrap.appendChild(wrap);
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
