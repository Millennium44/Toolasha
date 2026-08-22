/**
 * Alt+Click Item Navigation Feature
 * Adds Alt+click handlers to item tooltips and inventory/marketplace items
 */

import config from '../../core/config.js';
import tooltipObserver from '../../core/tooltip-observer.js';
import { navigateToItem } from '../../utils/item-navigation.js';

class AltClickNavigation {
    constructor() {
        this.isActive = false;
        this.unregisterObserver = null;
        this.clickHandler = null;
        this.currentItemHrid = null;
    }

    /**
     * Setup settings listener
     */
    setupSettingListener() {
        config.onSettingChange('altClickNavigation', (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    /**
     * Initialize Alt+click navigation
     */
    initialize() {
        if (this.isActive) {
            return;
        }

        if (!config.getSetting('altClickNavigation')) {
            return;
        }

        // Watch for tooltip poppers to track current hovered item
        tooltipObserver.subscribe('AltClickNav', (tooltipElement, eventType, info) => {
            if (eventType !== 'opened' || !info?.isTooltipPopper) return;
            this.handleTooltipAppear(tooltipElement, info);
        });
        this.unregisterObserver = () => tooltipObserver.unsubscribe('AltClickNav');

        // Create global click handler for Alt+click
        this.clickHandler = (event) => {
            // Only handle Alt+click
            if (!event.altKey) {
                return;
            }

            // Try multiple strategies to find item HRID
            let itemHrid = null;

            // Strategy 1: Check for data-item-hrid attribute (our custom tabs, etc.)
            const dataItemElement = event.target.closest('[data-item-hrid]');
            if (dataItemElement) {
                itemHrid = dataItemElement.getAttribute('data-item-hrid');
            }

            // Strategy 2: Check parent chain for item link hrefs
            if (!itemHrid) {
                const linkElement = event.target.closest('a[href*="/items/"]');
                if (linkElement) {
                    const href = linkElement.getAttribute('href');
                    const match = href.match(/\/items\/(.+?)(?:\/|$)/);
                    if (match) {
                        itemHrid = `/items/${match[1]}`;
                    }
                }
            }

            // Strategy 3: Use tracked item only while an item tooltip is actually visible
            // (currentItemHrid can be stale — nothing clears it when a tooltip closes)
            if (!itemHrid && this.currentItemHrid && this.isItemTooltipVisible()) {
                itemHrid = this.currentItemHrid;
            }

            if (!itemHrid) {
                return;
            }

            // Navigate to item
            event.preventDefault();
            event.stopPropagation();
            navigateToItem(itemHrid);
        };

        // Attach global click handler (capture phase to intercept before game handlers)
        document.addEventListener('click', this.clickHandler, true);

        this.isActive = true;
    }

    /**
     * Check whether an item tooltip popper is currently in the DOM
     * @returns {boolean} True if a visible tooltip contains item markup
     */
    isItemTooltipVisible() {
        const poppers = document.querySelectorAll('.MuiTooltip-popper');
        for (const popper of poppers) {
            if (
                popper.querySelector('a[href*="/items/"], use[href*="items_sprite"], [class*="ItemTooltipText_name"]')
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Handle tooltip appearance - extract item HRID
     * @param {HTMLElement} tooltipElement - Tooltip popper element
     * @param {import('../../core/tooltip-observer.js').TooltipInfo} [info] - Its classification
     *   (probed here when a caller has none)
     */
    handleTooltipAppear(tooltipElement, info = tooltipObserver.classify(tooltipElement)) {
        // Reset current item
        this.currentItemHrid = null;

        try {
            // An item link or sprite reference in the tooltip content names the
            // item outright — read once by the observer
            if (info.itemHrid) {
                this.currentItemHrid = info.itemHrid;
                return;
            }

            // Try to extract from ItemTooltipText_name div
            const nameElement = info.nameEl?.querySelector('span');
            if (nameElement) {
                const itemName = nameElement.textContent.trim();

                // Convert name to HRID format (lowercase, replace spaces with underscores)
                const itemHrid = `/items/${itemName.toLowerCase().replace(/\s+/g, '_')}`;
                this.currentItemHrid = itemHrid;
            }
        } catch (error) {
            console.error('[AltClickNav] Error parsing tooltip:', error);
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        try {
            if (this.clickHandler) {
                document.removeEventListener('click', this.clickHandler, true);
                this.clickHandler = null;
            }

            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }

            this.currentItemHrid = null;
            this.isActive = false;
        } catch (error) {
            console.error('[Alt+Click Navigation] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
        }
    }
}

const altClickNavigation = new AltClickNavigation();
altClickNavigation.setupSettingListener();

export default altClickNavigation;
