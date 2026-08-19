/**
 * Alchemy Item Dimming
 * Dims items in alchemy panel that require higher level than player has
 * Player must have Alchemy level >= itemLevel to perform alchemy actions
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { findAlchemizeMenu } from '../alchemy/alchemy-item-selector.js';

/**
 * AlchemyItemDimming class dims items based on level requirements
 */
class AlchemyItemDimming {
    constructor() {
        this.unregisterObserver = null; // Unregister function from centralized observer
        this.isActive = false;
        this.isInitialized = false;
    }

    /**
     * Initialize the alchemy item dimming
     */
    initialize() {
        // Guard FIRST (before feature check)
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('alchemyItemDimming')) {
            return;
        }

        this.isInitialized = true;

        // Register with centralized observer to watch for alchemy panel
        this.unregisterObserver = domObserver.onClass('AlchemyItemDimming', 'ItemSelector_menu', () => {
            this.processAlchemyItems();
        });

        // Process any existing items on page
        this.processAlchemyItems();

        this.isActive = true;
    }

    /**
     * Process all items in the alchemy panel
     */
    processAlchemyItems() {
        // Check if alchemy panel is open
        const alchemyPanel = findAlchemizeMenu();
        if (!alchemyPanel) {
            return;
        }

        // Get player's Alchemy level
        const skills = dataManager.getSkills();
        if (!skills) {
            return;
        }

        const alchemySkill = skills.find((s) => s.skillHrid === '/skills/alchemy');
        if (!alchemySkill) {
            console.error('[AlchemyItemDimming] Skill not found: /skills/alchemy');
        }
        const playerAlchemyLevel = alchemySkill?.level || 1;

        // Find all item icon divs within the alchemy panel
        // Matched on the class prefix, not the full name. The suffixes are
        // regenerated on every game build, so a selector carrying one stops
        // matching at the next patch and the feature just quietly does nothing.
        const iconDivs = alchemyPanel.querySelectorAll(
            'div[class*="Item_itemContainer"] div[class*="Item_item"][class*="Item_clickable"]'
        );

        // Always re-evaluate every tile — skipping processed divs would freeze the
        // dim state and never un-dim items after the player levels up
        for (const div of iconDivs) {
            // Get the use element inside this div
            const useElement = div.querySelector('use');
            if (!useElement) {
                continue;
            }

            const href = useElement.getAttribute('href');
            if (!href) {
                continue;
            }

            // Extract item HRID (e.g., "#cheese_sword" -> "/items/cheese_sword")
            const hrefName = href.split('#')[1];
            const itemHrid = `/items/${hrefName}`;

            // Get item details
            const itemDetails = dataManager.getItemDetails(itemHrid);
            if (!itemDetails) {
                continue;
            }

            // Get item's alchemy level requirement
            const itemLevel = itemDetails.itemLevel || 0;

            // Apply dimming if player level is too low
            if (playerAlchemyLevel < itemLevel) {
                div.style.opacity = '0.5';
                div.style.pointerEvents = 'auto'; // Still clickable
                div.classList.add('mwi-alchemy-dimmed');
            } else {
                // Remove dimming if level is now sufficient (player leveled up)
                div.style.opacity = '1';
                div.classList.remove('mwi-alchemy-dimmed');
            }
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        try {
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }

            // Remove all dimming effects
            const dimmedItems = document.querySelectorAll('.mwi-alchemy-dimmed');
            for (const item of dimmedItems) {
                item.style.opacity = '1';
                item.classList.remove('mwi-alchemy-dimmed');
            }

            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Alchemy Item Dimming] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const alchemyItemDimming = new AlchemyItemDimming();

export default alchemyItemDimming;
