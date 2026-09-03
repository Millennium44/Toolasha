/**
 * Equipment Level Display
 * Shows item level in top right corner of equipment icons
 * Based on original MWI Tools implementation
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';

/**
 * The DOM this feature annotates, as a class the shared observer can filter on.
 *
 * `addItemLevels` only ever looks at `Item_itemContainer__… > Item_item__…`
 * icons, and `Item_item` is a substring of both hashed names, so one entry
 * covers the container and the icon alike — whichever of the two the game
 * happens to insert. Anything without it cannot contain an icon this touches.
 */
const ITEM_ICON_CLASSES = ['Item_item'];

/**
 * EquipmentLevelDisplay class adds level overlays to equipment icons
 */
class EquipmentLevelDisplay {
    constructor() {
        this.unregisterHandler = null;
        this.unregisterReady = null;
        this.isActive = false;
        this.processedHrefs = new WeakMap(); // Track last href per div
        this.isInitialized = false;
        this.hrefObserver = null; // Watches SVG href swaps that don't add/remove nodes
        this.hrefDebounceTimer = null;
    }

    /**
     * Setup setting change listener (always active, even when feature is disabled)
     */
    setupSettingListener() {
        // Listen for main toggle changes
        config.onSettingChange('itemIconLevel', (enabled) => {
            if (enabled) {
                this.initialize();
            } else {
                this.disable();
            }
        });

        // Listen for key info toggle
        config.onSettingChange('showsKeyInfoInIcon', () => {
            if (this.isInitialized) {
                // Clear processed map and re-render
                this.processedHrefs = new WeakMap();
                this.addItemLevels();
            }
        });

        config.onSettingChange('color_accent', () => {
            if (this.isInitialized) {
                this.refresh();
            }
        });
    }

    /**
     * Initialize the equipment level display
     */
    initialize() {
        if (!config.getSetting('itemIconLevel')) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        // Register with centralized DOM observer, debounced and class-filtered.
        // Unfiltered this ran for every element inserted anywhere on the page.
        this.unregisterHandler = domObserver.onClass(
            'EquipmentLevelDisplay',
            ITEM_ICON_CLASSES,
            () => {
                this.addItemLevels();
            },
            { debounce: true, debounceDelay: 150 } // 150ms debounce to reduce update frequency
        );

        // Process any existing items on page. @run-at document-start: items rendered before the
        // shared observer attaches to document.body are invisible to it, so the catch-up waits
        // for the observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('EquipmentLevelDisplayCatchUp', () => {
            this.addItemLevels();
        });

        // The game frequently swaps an equipped/inventory item in place — the same
        // Item_item div stays mounted and only the SVG <use> href changes (e.g.
        // re-equipping a different enhancement level into the same slot). That is
        // an attribute mutation, not a childList one, so the shared domObserver
        // (childList/subtree only, see dom-observer.js) never re-fires for it and
        // the level overlay is left showing the previous item's requirement until
        // some unrelated childList change happens to sweep the page. Watch href
        // changes directly, the same way alchemy-profit-display.js does for its
        // catalyst icon.
        this.hrefObserver = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
                if (mutation.target.tagName === 'use') {
                    this._scheduleHrefUpdate();
                    return;
                }
            }
        });
        this.hrefObserver.observe(document.body, {
            subtree: true,
            attributes: true,
            attributeFilter: ['href', 'xlink:href'],
        });

        this.isActive = true;
        this.isInitialized = true;
    }

    /**
     * Debounce rapid href swaps (e.g. hovering across a row of equipment icons)
     * into a single re-scan.
     * @private
     */
    _scheduleHrefUpdate() {
        if (this.hrefDebounceTimer) {
            clearTimeout(this.hrefDebounceTimer);
        }
        this.hrefDebounceTimer = setTimeout(() => {
            this.hrefDebounceTimer = null;
            this.addItemLevels();
        }, 150);
    }

    /**
     * Clean up
     */
    cleanup() {
        if (this.unregisterHandler) {
            this.unregisterHandler();
            this.unregisterHandler = null;
        }
        if (this.unregisterReady) {
            this.unregisterReady();
            this.unregisterReady = null;
        }
        if (this.hrefObserver) {
            this.hrefObserver.disconnect();
            this.hrefObserver = null;
        }
        if (this.hrefDebounceTimer) {
            clearTimeout(this.hrefDebounceTimer);
            this.hrefDebounceTimer = null;
        }
        this.isActive = false;
    }

    /**
     * Add item levels to all equipment icons
     * Matches original MWI Tools logic with dungeon key zone info
     */
    addItemLevels() {
        // Find all item icon divs (the clickable containers)
        const iconDivs = document.querySelectorAll(
            'div.Item_itemContainer__x7kH1 div.Item_item__2De2O.Item_clickable__3viV6'
        );

        for (const div of iconDivs) {
            // Skip if already has a name element (tooltip is open)
            if (div.querySelector('div.Item_name__2C42x')) {
                continue;
            }

            // Get the use element inside this div
            const useElement = div.querySelector('use');
            if (!useElement) {
                continue;
            }

            const href = useElement.getAttribute('href');
            if (!href) {
                continue;
            }

            // Skip if this div already has the correct overlay for this href
            if (this.processedHrefs.get(div) === href) {
                continue;
            }

            // Remove stale overlay if item changed
            const existingOverlay = div.querySelector('div.script_itemLevel');
            if (existingOverlay) {
                existingOverlay.remove();
            }

            // Extract item HRID (e.g., "#cheese_sword" -> "/items/cheese_sword")
            const hrefName = href.split('#')[1];
            const itemHrid = `/items/${hrefName}`;

            // Get item details
            const itemDetails = dataManager.getItemDetails(itemHrid);
            if (!itemDetails) {
                this.processedHrefs.set(div, href);
                continue;
            }

            // For equipment, show the level requirement (not itemLevel)
            // For ability books, show the ability level requirement
            // For dungeon entry keys, show zone index
            let displayText = null;

            if (itemDetails.equipmentDetail) {
                // Equipment: Use levelRequirements from equipmentDetail
                const levelReq = itemDetails.equipmentDetail.levelRequirements;
                if (levelReq && levelReq.length > 0 && levelReq[0].level > 0) {
                    displayText = levelReq[0].level.toString();
                }
            } else if (itemDetails.abilityBookDetail) {
                // Ability book: Use level requirement from abilityBookDetail
                const abilityLevelReq = itemDetails.abilityBookDetail.levelRequirements;
                if (abilityLevelReq && abilityLevelReq.length > 0 && abilityLevelReq[0].level > 0) {
                    displayText = abilityLevelReq[0].level.toString();
                }
            } else if (config.getSetting('showsKeyInfoInIcon') && this.isKeyOrFragment(itemHrid)) {
                // Keys and fragments: Show zone/dungeon info
                displayText = this.getKeyDisplayText(itemHrid);
            }

            // Add overlay if we have valid text to display
            if (displayText) {
                div.style.position = 'relative';

                // Position: bottom left for all items (matches market value style)
                const position = 'bottom: 2px; left: 2px; text-align: left;';

                div.insertAdjacentHTML(
                    'beforeend',
                    `<div class="script_itemLevel" style="z-index: 1; position: absolute; ${position} color: ${config.SCRIPT_COLOR_MAIN}; text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 3px #000;">${displayText}</div>`
                );
            }

            this.processedHrefs.set(div, href);
        }
    }

    /**
     * Check if item is a key or fragment
     * @param {string} itemHrid - Item HRID
     * @returns {boolean} True if item is a key or fragment
     */
    isKeyOrFragment(itemHrid) {
        return itemHrid.includes('_key') || itemHrid.includes('_fragment');
    }

    /**
     * Get display text for keys and fragments
     * Uses hardcoded mapping like MWI Tools
     * @param {string} itemHrid - Key/fragment HRID
     * @returns {string|null} Display text (e.g., "D1", "Z3", "3.4.5.6") or null
     */
    getKeyDisplayText(itemHrid) {
        const keyMap = new Map([
            // Key fragments (zones where they drop)
            ['/items/blue_key_fragment', 'Z3'],
            ['/items/green_key_fragment', 'Z4'],
            ['/items/purple_key_fragment', 'Z5'],
            ['/items/white_key_fragment', 'Z6'],
            ['/items/orange_key_fragment', 'Z7'],
            ['/items/brown_key_fragment', 'Z8'],
            ['/items/stone_key_fragment', 'Z9'],
            ['/items/dark_key_fragment', 'Z10'],
            ['/items/burning_key_fragment', 'Z11'],

            // Entry keys (dungeon identifiers)
            ['/items/chimerical_entry_key', 'D1'],
            ['/items/sinister_entry_key', 'D2'],
            ['/items/enchanted_entry_key', 'D3'],
            ['/items/pirate_entry_key', 'D4'],

            // Chest keys (zones where they drop)
            ['/items/chimerical_chest_key', '3.4.5.6'],
            ['/items/sinister_chest_key', '5.7.8.10'],
            ['/items/enchanted_chest_key', '7.8.9.11'],
            ['/items/pirate_chest_key', '6.9.10.11'],
        ]);

        return keyMap.get(itemHrid) || null;
    }

    /**
     * Refresh colors (called when settings change)
     */
    refresh() {
        // Update color for all level overlays
        const overlays = document.querySelectorAll('div.script_itemLevel');
        overlays.forEach((overlay) => {
            overlay.style.color = config.COLOR_ACCENT;
        });
    }

    /**
     * Disable the feature
     */
    disable() {
        try {
            if (this.unregisterHandler) {
                this.unregisterHandler();
                this.unregisterHandler = null;
            }

            if (this.unregisterReady) {
                this.unregisterReady();
                this.unregisterReady = null;
            }

            if (this.hrefObserver) {
                this.hrefObserver.disconnect();
                this.hrefObserver = null;
            }
            if (this.hrefDebounceTimer) {
                clearTimeout(this.hrefDebounceTimer);
                this.hrefDebounceTimer = null;
            }

            // Remove all level overlays
            const overlays = document.querySelectorAll('div.script_itemLevel');
            for (const overlay of overlays) {
                overlay.remove();
            }

            // Clear processed tracking
            this.processedHrefs = new WeakMap();

            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Equipment Level Display] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const equipmentLevelDisplay = new EquipmentLevelDisplay();

equipmentLevelDisplay.setupSettingListener();

export { ITEM_ICON_CLASSES };
export default equipmentLevelDisplay;
