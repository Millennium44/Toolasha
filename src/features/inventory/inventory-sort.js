/**
 * Inventory Sort Module
 * Sorts inventory items by Ask/Bid price with optional stack value badges
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import { formatKMB } from '../../utils/formatters.js';
import dataManager from '../../core/data-manager.js';
import inventoryBadgeManager from './inventory-badge-manager.js';
import { BADGE_MODE_SETTING, stackBadgeValueKey } from './inventory-badge-mode.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

/**
 * Wait for `promise`, but never past `timeoutMs`.
 *
 * `applyCurrentSort()` holds its `isCalculating` guard across an await on
 * `inventoryBadgeManager.renderAllBadges()`, inside a try/finally most callers assume clears the
 * guard no matter what — but a finally block never runs while its function is suspended on an
 * await that never settles, so a wedged badge render left `isCalculating` stuck true forever and
 * with it every later sort request (measured live: 532 tiles, isCalculating never clearing across
 * 8 s of sampling, while a fresh renderAllBadges() call from the console resolved fine). Racing
 * the real promise against a timer guarantees the awaiting function is always resumed, whatever
 * the real promise ends up doing.
 * @param {Promise<*>} promise - What to wait for
 * @param {number} timeoutMs - How long to wait before giving up
 * @returns {Promise<*>} The promise's value, or undefined on timeout
 */
async function withBoundedWait(promise, timeoutMs) {
    let timer;
    try {
        return await Promise.race([
            promise,
            new Promise((resolve) => {
                timer = setTimeout(resolve, timeoutMs);
            }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * InventorySort class manages inventory sorting and price badges
 */
class InventorySort {
    constructor() {
        this.currentMode = 'none'; // 'ask', 'bid', 'none'
        this.modeChangeListeners = [];
        this.unregisterHandlers = [];
        this.controlsContainer = null;
        this.currentInventoryElem = null;
        this.warnedItems = new Set(); // Track items we've already warned about
        this.isCalculating = false; // Guard flag to prevent recursive calls
        // A sort request that arrived while one was already running. Coalesced rather than
        // dropped: the in-flight run finishes (or times out — see withBoundedWait) and, if this
        // is set, runs exactly once more instead of leaving the newer request unanswered.
        this.rerunRequested = false;
        this.BADGE_RENDER_TIMEOUT_MS = 8000; // Bound on the badge-manager await; see withBoundedWait
        this.isInitialized = false;
        this.initPromise = null;
        this.itemsUpdatedHandler = null;
        this.itemsUpdatedDebounceTimer = null; // Debounce timer for items_updated events
        this.priceUpdateHandler = null; // Handler for market price updates
        this.priceUpdateDebounceTimer = null; // Debounce timer for price updates
        this.tabSwitchDebounceTimer = null; // Debounce timer for native-inventory-tab switches
        this.tabClickHandler = null; // Capture-phase click fallback for native tab switches
        this.DEBOUNCE_DELAY = 300; // 300ms debounce for event handlers
        this.timerRegistry = createTimerRegistry();
    }

    /**
     * Setup settings listeners for feature toggle and color changes
     */
    setupSettingListener() {
        config.onSettingChange('invSort', async (value) => {
            if (value) {
                await this.initialize();
            } else {
                this.disable();
            }
        });

        config.onSettingChange('color_accent', () => {
            if (this.isInitialized) {
                this.refresh();
            }
        });

        config.onSettingChange(BADGE_MODE_SETTING, () => {
            if (this.isInitialized) {
                this.refresh();
                // Force badge re-render so changing the setting adds/removes badges immediately
                inventoryBadgeManager.clearProcessedTracking();
                inventoryBadgeManager.renderAllBadges();
            }
        });
    }

    /**
     * Initialize inventory sort feature
     *
     * The re-entry guard (`unregisterHandlers`) only fills after the settings
     * read, so a second call inside that read — this module's own `invSort`
     * listener and the feature registry's live start both answer the same
     * switch-on — shares the first one's promise instead of registering again.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.initPromise) return this.initPromise;
        const pending = this._initialize();
        this.initPromise = pending;
        try {
            await pending;
        } finally {
            if (this.initPromise === pending) this.initPromise = null;
        }
    }

    /**
     * The body of `initialize()`.
     * @returns {Promise<void>}
     * @private
     */
    async _initialize() {
        if (!config.getSetting('invSort')) {
            return;
        }

        if (this.unregisterHandlers.length > 0) {
            return;
        }

        // Taken before the read, checked after it. A `character_switching`
        // teardown landing inside `loadSettings()` has already emptied
        // `unregisterHandlers` and dropped the badge provider; carrying on here
        // registered a provider and two observers over that teardown and left
        // `unregisterHandlers` non-empty, which is the re-entry guard above — so
        // the switch's own re-initialise early-returned and the sort controls
        // and stack-price badges stayed gone until the page was reloaded.
        const ticket = captureOwner(this);
        // Load persisted settings
        await this.loadSettings();
        if (!stillOurs(ticket)) return;

        // Register with badge manager for coordinated rendering (MUST BE BEFORE checking existing inventory)
        inventoryBadgeManager.registerProvider(
            'inventory-stack-price',
            (itemElem) => this.renderBadgesForItem(itemElem),
            50 // Priority: render before bid/ask badges (lower = earlier)
        );

        // Check if inventory is already open. @run-at document-start: an inventory rendered
        // before the shared observer attaches to document.body is invisible to the class
        // watcher, so the catch-up waits for its actual-ready signal (immediate if attached).
        this.unregisterHandlers.push(
            domObserver.onReady('InventorySortCatchUp', () => {
                const existingInv = document.querySelector('[class*="Inventory_items"]');
                if (existingInv) {
                    this.currentInventoryElem = existingInv;
                    this.injectSortControls(existingInv);
                    this.applyCurrentSort();
                }
            })
        );

        // Watch for inventory panel (for future opens/reloads)
        const unregister = domObserver.onClass('InventorySort', 'Inventory_items', (elem) => {
            this.currentInventoryElem = elem;
            this.injectSortControls(elem);
            this.applyCurrentSort();
        });
        this.unregisterHandlers.push(unregister);

        // Native inventory tabs (2026-09 patch) re-render the selected tab's category tiles
        // in place when the player switches tabs — Inventory_items itself is never re-inserted,
        // so the watcher above only fires once, on the first open. A category button landing
        // anywhere inside the still-mounted inventory means a panel just (re)rendered its tiles,
        // in both the old DOM (initial category mount) and the new one (every tab switch), so
        // reuse that signal to reapply sort and badges. Structural (a class match), never keyed
        // on hostname, since the old and new DOM shapes can both be live depending on the server.
        const unregisterTabSwitch = domObserver.onClass(
            'InventorySortTabSwitch',
            'Inventory_categoryButton',
            (elem) => {
                if (!this.currentInventoryElem || !this.currentInventoryElem.contains(elem)) return;
                this.scheduleApplyCurrentSort();
            }
        );
        this.unregisterHandlers.push(unregisterTabSwitch);

        // A second, independent trigger for the same reapply: switching to a single-category
        // native tab (e.g. "Resources") was measured live to produce no detectable mutation at
        // all — no fresh Inventory_categoryButton insertion, unlike the multi-category "All" tab,
        // which does re-render its category divs wholesale. Whatever the game does differently for
        // a single panel (React reusing/patching existing nodes instead of replacing them is the
        // likely cause, though it was not directly observable), a click on the tab strip itself is
        // a reliable signal regardless: capture-phase so it is seen even if the game's own handler
        // stops propagation, structural (role="tab", not a class name the game could rename), and
        // scoped to the current inventory so it ignores the character panel's own Inventory/
        // Equipment tab strip, which sits outside Inventory_items entirely.
        this.tabClickHandler = (event) => {
            const tab = event.target?.closest?.('[role="tab"]');
            if (!tab || !this.currentInventoryElem?.contains(tab)) return;
            this.scheduleApplyCurrentSort();
        };
        document.addEventListener('click', this.tabClickHandler, true);
        this.unregisterHandlers.push(() => {
            document.removeEventListener('click', this.tabClickHandler, true);
            this.tabClickHandler = null;
        });

        // Store handler reference for cleanup with debouncing
        this.itemsUpdatedHandler = () => {
            clearTimeout(this.itemsUpdatedDebounceTimer);
            this.itemsUpdatedDebounceTimer = setTimeout(() => {
                if (this.currentInventoryElem) {
                    inventoryBadgeManager.invalidateCache();
                    this.applyCurrentSort();
                }
            }, this.DEBOUNCE_DELAY);
        };

        // Listen for inventory changes to recalculate prices
        dataManager.on('items_updated', this.itemsUpdatedHandler);

        // Listen for market data updates to refresh badges
        this.setupMarketDataListener();

        this.isInitialized = true;
    }

    /**
     * Setup listener for market data updates
     */
    setupMarketDataListener() {
        // Listen for market price updates
        const priceUpdateHandler = () => {
            // Debounce price updates to avoid excessive recalculation
            clearTimeout(this.priceUpdateDebounceTimer);
            this.priceUpdateDebounceTimer = setTimeout(() => {
                if (this.currentInventoryElem && this.isInitialized) {
                    this.applyCurrentSort();
                }
            }, 500); // 500ms debounce for price updates
        };

        marketAPI.on(priceUpdateHandler);

        // Store handler for cleanup
        this.priceUpdateHandler = priceUpdateHandler;

        // If market data isn't loaded yet, retry periodically
        if (!marketAPI.isLoaded()) {
            let retryCount = 0;
            const maxRetries = 10;
            const retryInterval = 500; // 500ms between retries

            const retryCheck = setInterval(() => {
                retryCount++;

                if (marketAPI.isLoaded()) {
                    clearInterval(retryCheck);

                    // Refresh if inventory is still open
                    if (this.currentInventoryElem) {
                        this.applyCurrentSort();
                    }
                } else if (retryCount >= maxRetries) {
                    console.warn('[InventorySort] Market data still not available after', maxRetries, 'retries');
                    clearInterval(retryCheck);
                }
            }, retryInterval);

            this.timerRegistry.registerInterval(retryCheck);
        }
    }

    /**
     * Load settings from storage
     */
    async loadSettings() {
        try {
            // Read on initialize, and initialize runs again after a character
            // switch, so the key is always the current character's
            const settings = await readScoped('inventorySort', 'settings', null, { migrate: 'adopt' });
            if (settings && settings.mode) {
                this.currentMode = settings.mode;
            }
        } catch (error) {
            console.error('[InventorySort] Failed to load settings:', error);
        }
    }

    /**
     * Save settings to storage
     */
    saveSettings() {
        try {
            writeScoped(
                'inventorySort',
                {
                    mode: this.currentMode,
                },
                'settings',
                true // immediate write for user preference
            );
        } catch (error) {
            console.error('[InventorySort] Failed to save settings:', error);
        }
    }

    /**
     * Inject sort controls into inventory panel
     * @param {Element} inventoryElem - Inventory items container
     */
    injectSortControls(inventoryElem) {
        // Set current inventory element
        this.currentInventoryElem = inventoryElem;

        // Check if controls already exist
        if (this.controlsContainer && document.body.contains(this.controlsContainer)) {
            return;
        }

        // Create controls container
        this.controlsContainer = document.createElement('div');
        this.controlsContainer.className = 'mwi-inventory-sort-controls';
        this.controlsContainer.style.cssText = `
            color: ${config.COLOR_ACCENT};
            font-size: 0.875rem;
            text-align: left;
            margin-top: -8px;
            margin-bottom: 0;
            display: flex;
            align-items: center;
            gap: 3px;
        `;

        // Sort label and buttons
        const sortLabel = document.createElement('span');
        sortLabel.textContent = 'Sort:';

        const askButton = this.createSortButton('Ask', 'ask');
        const bidButton = this.createSortButton('Bid', 'bid');
        const noneButton = this.createSortButton('None', 'none');

        // Assemble controls
        this.controlsContainer.appendChild(sortLabel);
        this.controlsContainer.appendChild(askButton);
        this.controlsContainer.appendChild(bidButton);
        this.controlsContainer.appendChild(noneButton);

        // Insert before inventory
        inventoryElem.insertAdjacentElement('beforebegin', this.controlsContainer);

        // Update button states
        this.updateButtonStates();
    }

    /**
     * Create a sort button
     * @param {string} label - Button label
     * @param {string} mode - Sort mode
     * @returns {Element} Button element
     */
    createSortButton(label, mode) {
        const button = document.createElement('button');
        button.textContent = label;
        button.dataset.mode = mode;
        button.style.cssText = `
            border-radius: 4px;
            padding: 2px 8px;
            border: none;
            cursor: pointer;
            font-size: 12px;
            transition: all 0.2s;
        `;

        button.addEventListener('click', () => {
            this.setSortMode(mode);
        });

        return button;
    }

    /**
     * Update button visual states based on current mode
     */
    updateButtonStates() {
        if (!this.controlsContainer) return;

        const buttons = this.controlsContainer.querySelectorAll('button');
        buttons.forEach((button) => {
            const isActive = button.dataset.mode === this.currentMode;

            if (isActive) {
                button.style.backgroundColor = config.COLOR_ACCENT;
                button.style.color = 'black';
                button.style.fontWeight = 'bold';
            } else {
                button.style.backgroundColor = '#444';
                button.style.color = '#aaa';
                button.style.fontWeight = 'normal';
            }
        });
    }

    /**
     * Set sort mode and apply sorting
     * @param {string} mode - Sort mode ('ask', 'bid', 'none')
     */
    setSortMode(mode) {
        this.currentMode = mode;
        this.saveSettings();
        this.updateButtonStates();

        // Clear badge manager's processed tracking to force re-render with new mode
        inventoryBadgeManager.clearProcessedTracking();

        // Remove all existing stack price badges so they can be recreated with new settings
        const badges = document.querySelectorAll('.mwi-stack-price');
        badges.forEach((badge) => badge.remove());

        this.modeChangeListeners.forEach((fn) => fn(mode));
        this.applyCurrentSort();
    }

    /**
     * Register a callback to be called when sort mode changes.
     * Returns an unregister function.
     * @param {Function} fn
     * @returns {Function}
     */
    onModeChange(fn) {
        this.modeChangeListeners.push(fn);
        return () => {
            this.modeChangeListeners = this.modeChangeListeners.filter((f) => f !== fn);
        };
    }

    /**
     * Debounced trigger for a native-tab switch: invalidates the badge cache and reapplies sort,
     * the same way a debounced `items_updated` does. Coalesces the several category-button
     * insertions a single tab switch produces into one reapply.
     */
    scheduleApplyCurrentSort() {
        clearTimeout(this.tabSwitchDebounceTimer);
        this.tabSwitchDebounceTimer = setTimeout(() => {
            if (this.currentInventoryElem) {
                inventoryBadgeManager.invalidateCache();
                this.applyCurrentSort();
            }
        }, this.DEBOUNCE_DELAY);
    }

    /**
     * Find the container that owns a category's button and item grid.
     *
     * The real nesting (checked live, both DOM shapes) is `Inventory_categoryButton` inside
     * `Inventory_label` inside `Inventory_itemGrid`, with the item tiles as the grid's *other*
     * direct children alongside that label — so the item grid itself is already the smallest
     * element that owns both the button and the tiles. Only the wrapper divs *above* the grid
     * differ: none in the old DOM (the grid is a direct child of Inventory_items), several in the
     * new native-inventory-tabs DOM (2026-09 patch), where the grid sits inside the selected
     * TabsComponent panel. `closest()` checks the button's ancestors including itself, so it
     * lands on the grid in both shapes without needing to know which one is live.
     *
     * A descendant search from a *wrapper* div, by contrast, is wrong in the new DOM: a wrapper
     * above the grid is also an ancestor of every sibling category's grid, so every category
     * resolved to the same over-broad container and each category's own shouldSort/reset in turn
     * clobbered every other category's tile order — measured live as zero tiles ending up with
     * any order at all, since whichever category is processed last always wins.
     * @param {Element} categoryButton - An `Inventory_categoryButton` element
     * @returns {Element|null} The category's `Inventory_itemGrid`, or null if none is found
     */
    findCategoryContainer(categoryButton) {
        return categoryButton.closest('[class*="Inventory_itemGrid"]');
    }

    /**
     * Apply current sort mode to inventory.
     *
     * The category/order pass is synchronous and does not wait on the badge manager: live testing
     * measured 3–5 s for a re-sort with badge display OFF, because the old code awaited
     * `renderAllBadges()` — dominated by per-item price calculation, not by anything the order
     * pass itself needs beyond the `data-ask-value`/`data-bid-value` a tile already carries from
     * its last pricing pass — before touching a single tile's `order`. Pricing now runs in the
     * background (`_refreshPricesInBackground`) and corrects the order once real values land, so
     * the visible reorder is bounded by the debounce (~300 ms) instead of by pricing.
     *
     * `isCalculating` is only ever set/cleared synchronously around `_applyCategoryOrderPass()`,
     * which does no awaiting at all — so this method's `finally` always runs and the guard can
     * never stick. A call that arrives while one is already running is not dropped: it sets
     * `rerunRequested`, and the in-flight run performs one more pass before returning, so a
     * legitimate request made during that window is not lost.
     */
    async applyCurrentSort() {
        if (!this.currentInventoryElem) return;

        if (this.isCalculating) {
            this.rerunRequested = true;
            return;
        }
        this.isCalculating = true;

        const inventoryElem = this.currentInventoryElem;
        try {
            this._applyCategoryOrderPass(inventoryElem);
        } finally {
            this.isCalculating = false;
        }

        if (this.rerunRequested) {
            this.rerunRequested = false;
            await this.applyCurrentSort();
            return; // the rerun's own background refresh below covers this pass too
        }

        // Fire-and-forget: never awaited, so the visible reorder above is never held up by it.
        this._refreshPricesInBackground(inventoryElem);
    }

    /**
     * Refresh prices (and, if enabled, badges) in the background, then correct the order pass
     * once real values land. Not awaited by `applyCurrentSort()` — see there for why. Bounded by
     * `withBoundedWait`, and applied at most once per call (it does not re-schedule itself), so a
     * still-in-cooldown or no-op refresh cannot loop.
     * @param {Element} inventoryElem - The inventory element this refresh is for
     */
    async _refreshPricesInBackground(inventoryElem) {
        try {
            await withBoundedWait(inventoryBadgeManager.renderAllBadges(), this.BADGE_RENDER_TIMEOUT_MS);
            // Only reapply if nothing else moved on in the meantime: a different inventory is now
            // showing, or another pass is already in flight and will see the fresh values itself.
            if (this.currentInventoryElem === inventoryElem && !this.isCalculating) {
                this._applyCategoryOrderPass(inventoryElem);
            }
        } catch (error) {
            console.error('[InventorySort] Background price refresh failed:', error);
        }
    }

    /**
     * The category/order pass: no awaiting, so it can never hold `isCalculating` open. Uses
     * whatever `data-ask-value`/`data-bid-value` each tile currently carries — freshly-mounted
     * tiles (e.g. right after a native tab switch) may not have those yet, in which case this
     * pass is a harmless no-op (ties keep DOM order) until `_refreshPricesInBackground` corrects
     * it once real values land.
     * @param {Element} inventoryElem - The Inventory_items element to sort
     * @private
     */
    _applyCategoryOrderPass(inventoryElem) {
        // Skip order assignments when custom tabs has taken over the layout —
        // badges are still refreshed in the background, but tile order is managed by custom tabs.
        if (inventoryElem.classList.contains('toolasha-ct-active')) {
            return;
        }

        // Process each category. Found structurally by its Inventory_categoryButton rather
        // than by walking inventoryElem.children: the old DOM has category divs as direct
        // children of Inventory_items, but the new native-inventory-tabs DOM (2026-09 patch)
        // nests them inside the selected TabsComponent panel instead, and only that panel
        // renders any tiles — so a plain descendant search finds exactly the categories that
        // are actually on screen in either shape.
        const categoryButtons = inventoryElem.querySelectorAll('[class*="Inventory_categoryButton"]');

        for (const categoryButton of categoryButtons) {
            const categoryDiv = this.findCategoryContainer(categoryButton);
            if (!categoryDiv || !inventoryElem.contains(categoryDiv)) continue;

            const categoryName = categoryButton.textContent.trim();

            // Equipment category: check setting for whether to enable sorting
            // Loots category: always disable sorting (but allow badges)
            const isEquipmentCategory = categoryName === 'Equipment';
            const isLootsCategory = categoryName === 'Loots';
            const shouldSort = isLootsCategory
                ? false
                : isEquipmentCategory
                  ? config.getSetting('invSort_sortEquipment')
                  : true;

            // Ensure category label stays at top
            const label = categoryDiv.querySelector('[class*="Inventory_label"]');
            if (label) {
                label.style.order = Number.MIN_SAFE_INTEGER;
            }

            // Get all item elements
            const itemElems = categoryDiv.querySelectorAll('[class*="Item_itemContainer"]');

            if (shouldSort && this.currentMode !== 'none') {
                // Sort by price (prices already calculated by badge manager)
                this.sortItemsByPrice(itemElems, this.currentMode);
            } else {
                // Reset to default order. Removed rather than pinned at "0": every tile
                // already defaults to order 0, so leaving an inline "0" behind is inert but
                // leftover — clearing the property is the honest reset and does not shadow
                // an order another feature sets later.
                itemElems.forEach((itemElem) => {
                    itemElem.style.removeProperty('order');
                });
            }
        }
    }

    /**
     * Sort items by price (ask or bid)
     * @param {NodeList} itemElems - Item elements
     * @param {string} mode - 'ask' or 'bid'
     */
    sortItemsByPrice(itemElems, mode) {
        // Convert NodeList to array with values
        const items = Array.from(itemElems).map((elem) => ({
            elem,
            value: parseFloat(elem.dataset[mode + 'Value']) || 0,
        }));

        // Sort by value descending (highest first)
        items.sort((a, b) => b.value - a.value);

        // Assign sequential order values (0, 1, 2, 3...)
        items.forEach((item, index) => {
            item.elem.style.order = index;
        });
    }

    /**
     * Render stack price badge for a single item (called by badge manager)
     * @param {Element} itemElem - Item container element
     */
    renderBadgesForItem(itemElem) {
        // Determine if badges should be shown and which value to use
        let showBadges = false;
        let badgeValueKey = null;

        // One setting answers both sort states: whether a stack badge belongs
        // here at all, and which side it is priced on
        badgeValueKey = stackBadgeValueKey(this.currentMode);
        showBadges = badgeValueKey !== null;

        // Show badge if enabled
        if (showBadges && badgeValueKey) {
            const stackValue = parseFloat(itemElem.dataset[badgeValueKey]) || 0;
            const existingBadge = itemElem.querySelector('.mwi-stack-price');

            if (stackValue > 0) {
                if (existingBadge) {
                    existingBadge.textContent = formatKMB(stackValue, 0);
                } else {
                    this.renderPriceBadge(itemElem, stackValue);
                }
            } else if (existingBadge) {
                existingBadge.remove();
            }
        } else {
            // Badges disabled — remove any leftover badge so it does not linger with stale values
            itemElem.querySelector('.mwi-stack-price')?.remove();
        }
    }

    /**
     * Update price badges on all items (legacy method - now delegates to manager)
     */
    updatePriceBadges() {
        inventoryBadgeManager.renderAllBadges();
    }

    /**
     * Render price badge on item
     * @param {Element} itemElem - Item container element
     * @param {number} stackValue - Total stack value
     */
    renderPriceBadge(itemElem, stackValue) {
        // Ensure item has relative positioning
        itemElem.style.position = 'relative';

        // Create badge element
        const badge = document.createElement('div');
        badge.className = 'mwi-stack-price';
        badge.style.cssText = `
            position: absolute;
            top: 2px;
            right: 2px;
            z-index: 1;
            color: ${config.COLOR_ACCENT};
            font-size: 0.7rem;
            font-weight: bold;
            text-align: right;
            pointer-events: none;
            text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000;
        `;
        badge.textContent = formatKMB(stackValue, 2);

        // Insert into item
        const itemInner = itemElem.querySelector('[class*="Item_item"]');
        if (itemInner) {
            itemInner.appendChild(badge);
        }
    }

    /**
     * Refresh badges (called when badge setting changes)
     */
    refresh() {
        // Update controls container color
        if (this.controlsContainer) {
            this.controlsContainer.style.color = config.COLOR_ACCENT;
        }

        // Update button states (which includes colors)
        this.updateButtonStates();

        // Update all price badge colors
        document.querySelectorAll('.mwi-stack-price').forEach((badge) => {
            badge.style.color = config.COLOR_ACCENT;
        });
    }

    /**
     * Disable and cleanup
     */
    disable() {
        noteTeardown(this);
        this.initPromise = null;
        try {
            // Clear debounce timers
            clearTimeout(this.itemsUpdatedDebounceTimer);
            this.itemsUpdatedDebounceTimer = null;
            clearTimeout(this.priceUpdateDebounceTimer);
            this.priceUpdateDebounceTimer = null;
            clearTimeout(this.tabSwitchDebounceTimer);
            this.tabSwitchDebounceTimer = null;

            if (this.itemsUpdatedHandler) {
                dataManager.off('items_updated', this.itemsUpdatedHandler);
                this.itemsUpdatedHandler = null;
            }

            if (this.priceUpdateHandler) {
                marketAPI.off(this.priceUpdateHandler);
                this.priceUpdateHandler = null;
            }

            this.timerRegistry.clearAll();

            // Unregister from badge manager
            inventoryBadgeManager.unregisterProvider('inventory-stack-price');

            // Remove controls
            if (this.controlsContainer) {
                this.controlsContainer.remove();
                this.controlsContainer = null;
            }

            // Remove all badges
            const badges = document.querySelectorAll('.mwi-stack-price');
            badges.forEach((badge) => badge.remove());

            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];

            // Clear caches and state
            this.warnedItems.clear();
            this.currentInventoryElem = null;
            this.isInitialized = false;
            this.isCalculating = false;
            this.rerunRequested = false;
        } catch (error) {
            console.error('[Inventory Sort] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const inventorySort = new InventorySort();
inventorySort.setupSettingListener();

export default inventorySort;
