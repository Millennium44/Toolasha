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
 *
 * A THIRD live symptom (still zero tiles ordered, after the above fix): `applyCurrentSort()`
 * held `isCalculating` across an `await inventoryBadgeManager.renderAllBadges()`, inside a
 * try/finally most callers assume always clears the guard — but a finally block never runs while
 * its function is suspended on an await that never settles. One `renderAllBadges()` call (likely
 * from startup, competing with the extra calls the tab-switch watcher above makes) got a promise
 * that never resolved, so `isCalculating` stuck `true` forever and every later sort request was
 * silently dropped by the reentrancy guard.
 *
 * A FOURTH live symptom, after bounding that wait: re-sorting still took 3–5 s (target: the
 * ~300 ms debounce), because the order pass still *awaited* `renderAllBadges()` before touching
 * any tile — and that call is dominated by per-item price calculation, not by anything the order
 * pass needs beyond the `data-ask-value`/`data-bid-value` a tile already carries from its last
 * pricing pass. The order pass is now synchronous and never awaits the badge manager at all;
 * pricing runs in the background afterward and corrects the order once real values land. A FIFTH
 * symptom: switching to a single-category native tab (e.g. "Resources") produced no detectable
 * mutation for the `Inventory_categoryButton` watcher to see at all — a capture-phase click
 * listener on `[role="tab"]` inside the inventory is a second, independent trigger for the same
 * reapply, regardless of how the game ends up re-rendering that panel's tiles.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ invSort: true, invSort_sortEquipment: false }));
/** Callbacks registered with the DOM observer, so a test can play a class match or a tab switch */
const observer = vi.hoisted(() => ({ classHandlers: new Map() }));
/**
 * Controls the mocked badge manager's renderAllBadges(): resolves normally (running `onRender`
 * first, so a test can simulate prices landing) unless `hang` is set, in which case it never
 * settles at all.
 */
const badgeManager = vi.hoisted(() => ({ hang: false, calls: 0, onRender: null }));

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
        renderAllBadges: async () => {
            badgeManager.calls += 1;
            if (badgeManager.slow) {
                // Settles only when the test calls release(), after the sort's bound has elapsed
                return new Promise((resolve) => {
                    badgeManager.release = () => {
                        badgeManager.onRender?.();
                        resolve();
                    };
                });
            }
            if (badgeManager.hang) {
                // A promise that never resolves, matching the live symptom: renderAllBadges() got
                // stuck and never settled.
                return new Promise(() => {});
            }
            await Promise.resolve();
            badgeManager.onRender?.();
        },
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

function iconSvg(id) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `/static/media/sprites.abc.svg#${id}`);
    svg.appendChild(use);
    return svg;
}

/**
 * A single-category native tab's panel (checked live: "Resources", 136 tiles). Unlike a
 * multi-category panel, the grid here has no Inventory_label and no Inventory_categoryButton at
 * all — the only signal for what category this is is the selected tab's icon.
 * @param {string} selectedIconId - The icon id after "#" in the selected tab's sprite href
 * @param {Array<[string, number]>} items - [hrid, askValue] pairs
 */
function buildSingleCategoryInventory(selectedIconId, items) {
    const inv = el('div', 'Inventory_items__6SXv0');
    const tabsComponent = el('div', 'TabsComponent_tabsComponent__x TabsComponent_compact__y');
    const tabsContainer = el('div', 'TabsComponent_tabsContainer__a');
    const tabList = el('div');
    tabList.setAttribute('role', 'tablist');
    const otherTab = el('button');
    otherTab.setAttribute('role', 'tab');
    otherTab.setAttribute('aria-selected', 'false');
    otherTab.appendChild(iconSvg('inventory_all'));
    const selectedTab = el('button');
    selectedTab.setAttribute('role', 'tab');
    selectedTab.setAttribute('aria-selected', 'true');
    selectedTab.appendChild(iconSvg(selectedIconId));
    tabList.append(otherTab, selectedTab);
    tabsContainer.appendChild(tabList);
    const panelsContainer = el('div', 'TabsComponent_tabPanelsContainer__b');
    const panel = el('div', 'TabPanel_tabPanel__t');
    const grid = el('div', 'Inventory_itemGrid__g'); // no label, no button
    for (const [hrid, value] of items) grid.appendChild(tile(hrid, value));
    panel.appendChild(grid);
    panelsContainer.appendChild(panel);
    tabsComponent.append(tabsContainer, panelsContainer);
    inv.appendChild(tabsComponent);
    document.body.appendChild(inv);
    return inv;
}

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
        badgeManager.hang = false;
        badgeManager.onRender = null;
        badgeManager.calls = 0;
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

describe('InventorySort.applyCurrentSort — cannot wedge on a hung badge render', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        settings.invSort = true;
        settings.invSort_sortEquipment = false;
        badgeManager.hang = false;
        badgeManager.onRender = null;
        badgeManager.calls = 0;
        inventorySort.currentMode = 'ask';
        inventorySort.isCalculating = false;
        inventorySort.rerunRequested = false;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        inventorySort.currentInventoryElem = null;
    });

    test('the order pass does not wait on badge pricing: a hung renderAllBadges() never blocks it', async () => {
        badgeManager.hang = true;
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

        // Resolves right away — the tiles already carry their price data, and the order pass
        // never awaits the (hung) badge manager to use it.
        await inventorySort.applyCurrentSort();

        expect(inventorySort.isCalculating).toBe(false);
        const items = itemsByHrid(inv);
        expect(items.get('c2').style.order).toBe('0');
        expect(items.get('c1').style.order).toBe('1');

        // The background price refresh is still in flight (hung); letting its bound elapse must
        // not throw or leave stray state.
        await vi.advanceTimersByTimeAsync(inventorySort.BADGE_RENDER_TIMEOUT_MS);
        expect(inventorySort.isCalculating).toBe(false);
    });

    test('a hung background refresh does not block or drop a later sort request', async () => {
        badgeManager.hang = true;
        const inv = buildOldInventory([['Currencies', [['c1', 10]]]]);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort(); // starts a background refresh that never resolves

        // A second, unrelated sort request must work normally — isCalculating is not held open by
        // the background refresh the first call kicked off.
        inventorySort.currentMode = 'none';
        await inventorySort.applyCurrentSort();

        expect(inventorySort.isCalculating).toBe(false);
        expect(itemsByHrid(inv).get('c1').style.order).toBe('');
    });

    test('a call arriving while isCalculating is true is coalesced into a rerun, not dropped', async () => {
        const inv = buildOldInventory([['Currencies', [['c1', 10]]]]);
        inventorySort.currentInventoryElem = inv;
        inventorySort.isCalculating = true; // simulate a pass already in flight

        await inventorySort.applyCurrentSort();

        // Not dropped, and not run twice on top of the in-flight one either — just remembered.
        expect(inventorySort.rerunRequested).toBe(true);
        expect(itemsByHrid(inv).get('c1').style.order).toBe('');
    });
});

describe('InventorySort.applyCurrentSort — a render that outlasts the bound still corrects the order', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        settings.invSort = true;
        settings.invSort_sortEquipment = false;
        badgeManager.hang = false;
        badgeManager.slow = true;
        badgeManager.release = null;
        badgeManager.onRender = null;
        inventorySort.currentMode = 'ask';
        inventorySort.isCalculating = false;
        inventorySort.rerunRequested = false;
        vi.useFakeTimers();
    });

    afterEach(() => {
        badgeManager.slow = false;
        vi.useRealTimers();
        inventorySort.currentInventoryElem = null;
    });

    test('values that land after the bound are sorted once the render finishes', async () => {
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
        await inventorySort.applyCurrentSort();
        expect(itemsByHrid(inv).get('c2').style.order).toBe('0');

        // The bound elapses while prices are still being calculated
        await vi.advanceTimersByTimeAsync(inventorySort.BADGE_RENDER_TIMEOUT_MS);
        // ...then the render finishes and the real values reverse the order
        badgeManager.onRender = () => {
            itemsByHrid(inv).get('c1').dataset.askValue = '50';
        };
        badgeManager.release();
        await vi.advanceTimersByTimeAsync(0);

        expect(itemsByHrid(inv).get('c1').style.order).toBe('0');
        expect(itemsByHrid(inv).get('c2').style.order).toBe('1');
    });
});

describe('InventorySort.applyCurrentSort — background price refresh corrects the order', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        settings.invSort = true;
        settings.invSort_sortEquipment = false;
        badgeManager.hang = false;
        badgeManager.onRender = null;
        badgeManager.calls = 0;
        inventorySort.currentMode = 'ask';
        inventorySort.isCalculating = false;
        inventorySort.rerunRequested = false;
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        inventorySort.currentInventoryElem = null;
    });

    test('freshly-mounted tiles with no price data yet get ordered once pricing lands in the background', async () => {
        // Simulates a tab switch: the new tiles carry no data-ask-value/data-bid-value at all yet.
        const inv = buildOldInventory([
            [
                'Currencies',
                [
                    ['c1', 0],
                    ['c2', 0],
                ],
            ],
        ]);
        const items = itemsByHrid(inv);
        items.get('c1').removeAttribute('data-ask-value');
        items.get('c2').removeAttribute('data-ask-value');
        inventorySort.currentInventoryElem = inv;

        // Once the background "pricing" pass lands, give the tiles their real values.
        badgeManager.onRender = () => {
            items.get('c1').dataset.askValue = '10';
            items.get('c2').dataset.askValue = '30';
        };

        await inventorySort.applyCurrentSort();

        // Immediate pass: no price data yet, so the tiles are tied — the stable sort keeps them
        // in DOM order (c1, then c2) rather than reflecting the real prices that land afterward.
        expect(items.get('c1').style.order).toBe('0');
        expect(items.get('c2').style.order).toBe('1');

        // Let the background refresh's microtasks (and its own bounded wait) settle.
        await vi.advanceTimersByTimeAsync(0);

        expect(items.get('c2').style.order).toBe('0'); // value 30, highest first
        expect(items.get('c1').style.order).toBe('1');
    });
});

describe('InventorySort — reapplies sort when a native tab switch re-renders tiles', () => {
    beforeEach(() => {
        document.body.innerHTML = '';
        observer.classHandlers.clear();
        settings.invSort = true;
        settings.invSort_sortEquipment = false;
        badgeManager.hang = false;
        badgeManager.onRender = null;
        badgeManager.calls = 0;
        inventorySort.currentMode = 'none';
        inventorySort.isCalculating = false;
        inventorySort.rerunRequested = false;
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

    test('a click on the tab strip reapplies sort even when no mutation is observed', async () => {
        // Live symptom: switching to a single-category native tab ("Resources") produced no
        // detectable Inventory_categoryButton insertion at all -- unlike the multi-category "All"
        // tab, which does rebuild its category divs wholesale. This test never fires the
        // categoryButton watcher, so it only passes if the click listener itself is the trigger.
        await inventorySort.initialize();

        const { inv, panel } = buildNewInventory([['Currencies', [['c1', 10]]]]);
        observer.classHandlers.get('InventorySort:Inventory_items')(inv);
        inventorySort.currentMode = 'ask';
        // Let the initial mount's own sort pass fully settle before mutating further, so what
        // follows is unambiguously the click's doing and not a stray in-flight pass picking up
        // the later DOM change on its own.
        await vi.advanceTimersByTimeAsync(0);

        // Stand in for whatever the game did to the panel's tiles: change a value and add a tile,
        // without going through the categoryButton observer.
        const grid = panel.querySelector('[class*="Inventory_itemGrid"]');
        grid.appendChild(tile('c5', 999));

        const tabButton = document.createElement('button');
        tabButton.setAttribute('role', 'tab');
        inv.appendChild(tabButton); // inside the inventory, so it is in scope
        tabButton.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        await vi.advanceTimersByTimeAsync(inventorySort.DEBOUNCE_DELAY);

        const items = itemsByHrid(inv);
        expect(items.get('c5').style.order).toBe('0'); // value 999, highest first
        expect(items.get('c1').style.order).toBe('1');
    });

    test('a tab click outside the current inventory element is ignored', async () => {
        await inventorySort.initialize();

        const { inv } = buildNewInventory([['Currencies', [['c1', 10]]]]);
        observer.classHandlers.get('InventorySort:Inventory_items')(inv);
        inventorySort.currentMode = 'ask';
        await vi.advanceTimersByTimeAsync(0);

        // e.g. the CharacterManagement panel's own Inventory/Equipment tab strip, outside
        // Inventory_items entirely.
        const strayTab = document.createElement('button');
        strayTab.setAttribute('role', 'tab');
        document.body.appendChild(strayTab);
        strayTab.dispatchEvent(new MouseEvent('click', { bubbles: true }));

        await vi.advanceTimersByTimeAsync(inventorySort.DEBOUNCE_DELAY);

        // Nothing to reapply: the existing tile's order is untouched by this out-of-scope click.
        expect(itemsByHrid(inv).get('c1').style.order).toBe('0');
    });
});

describe('InventorySort.applyCurrentSort — single-category native tab (no category button)', () => {
    // Live symptom: a single-category native tab's grid ("Resources", 136 tiles) has no
    // Inventory_label or Inventory_categoryButton at all, so the button-driven category search
    // found zero categories there and it never sorted. The fix iterates Inventory_itemGrid
    // elements directly and, when a grid has no button, falls back to the selected
    // [role="tab"][aria-selected="true"]'s icon id.
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

    test('a button-less grid sorts using the selected tab icon (item_category_resource)', async () => {
        const inv = buildSingleCategoryInventory('item_category_resource', [
            ['r1', 10],
            ['r2', 30],
        ]);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('r2').style.order).toBe('0'); // value 30, highest first
        expect(items.get('r1').style.order).toBe('1');
    });

    test('a button-less Loots grid (item_category_loot) never sorts', async () => {
        const inv = buildSingleCategoryInventory('item_category_loot', [
            ['l1', 5],
            ['l2', 50],
        ]);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('l1').style.order).toBe('');
        expect(items.get('l2').style.order).toBe('');
    });

    test('a button-less Equipment grid (item_category_equipment) respects invSort_sortEquipment off', async () => {
        const inv = buildSingleCategoryInventory('item_category_equipment', [
            ['e1', 100],
            ['e2', 1],
        ]);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('e1').style.order).toBe('');
        expect(items.get('e2').style.order).toBe('');
    });

    test('a button-less Equipment grid sorts once invSort_sortEquipment is on', async () => {
        settings.invSort_sortEquipment = true;
        const inv = buildSingleCategoryInventory('item_category_equipment', [
            ['e1', 100],
            ['e2', 1],
        ]);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('e1').style.order).toBe('0'); // value 100, highest first
        expect(items.get('e2').style.order).toBe('1');
    });

    test('favorites_tab (a mixed category) sorts like any other category', async () => {
        const inv = buildSingleCategoryInventory('favorites_tab', [
            ['f1', 10],
            ['f2', 30],
        ]);
        inventorySort.currentInventoryElem = inv;

        await inventorySort.applyCurrentSort();

        const items = itemsByHrid(inv);
        expect(items.get('f2').style.order).toBe('0');
        expect(items.get('f1').style.order).toBe('1');
    });
});
