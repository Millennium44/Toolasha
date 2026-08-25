/**
 * Auto-Click Max Button
 * Automatically clicks the "Max" button in market listing dialogs
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';

class AutoClickMax {
    constructor() {
        this.isActive = false;
        this.unregisterHandlers = [];
        this.processedModals = new WeakSet();
        this.isInitialized = false;
    }

    /**
     * Initialize the auto-click max feature
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_autoClickMax')) {
            return;
        }

        this.isActive = true;
        this.registerDOMObservers();
        this.isInitialized = true;
    }

    /**
     * Register DOM observers to watch for market listing modals
     */
    registerDOMObservers() {
        const unregister = domObserver.onClass('auto-click-max', 'Modal_modalContainer', (modal) => {
            this.handleOrderModal(modal);
        });
        this.unregisterHandlers.push(unregister);
    }

    /**
     * Handle market order modal appearance
     * @param {HTMLElement} modal - Modal container element
     */
    handleOrderModal(modal) {
        if (!this.isActive || !modal || this.processedModals.has(modal)) {
            return;
        }

        // Check if this is a market modal
        const header = modal.querySelector('div[class*="MarketplacePanel_header"]');
        if (!header) {
            return;
        }

        const headerText = header.textContent;

        // Skip all buy modals (Buy Listing, Buy Now)
        if (headerText.includes('Buy')) {
            return;
        }

        // Only process sell modals (Sell Listing, Sell Now)
        if (!headerText.includes('Sell')) {
            return;
        }

        // Click the Max/All button, and only count the modal as dealt with once
        // that has actually happened. The observer can fire on a modal whose
        // shell React has committed but whose quantity row it has not; marking
        // on sight spent the one shot on that fire and refused the later one
        // that would have worked, leaving the quantity un-maxed.
        if (this.findAndClickMaxButton(modal)) {
            this.processedModals.add(modal);
        }
    }

    /**
     * Find and click the quantity Max/All button in the modal.
     *
     * Scoped to the quantity row on purpose. The 8/13/2026 layout gave the
     * *price* row its own "Max" button (jump to the top of the tradable range)
     * and placed it ahead of the quantity row in the DOM — so a blind search for
     * the first "Max"/"All" button clicked price-Max, which both slammed the
     * price to the ceiling and left the quantity un-maxed. This is the whole of
     * "it fills the max price and no longer maxes the items". So: search only the
     * quantity inputs, and belt-and-braces exclude anything in the price row.
     *
     * @param {HTMLElement} modal - Modal container element
     * @returns {boolean} Whether the button was there and was clicked
     */
    findAndClickMaxButton(modal) {
        if (!modal) {
            return false;
        }

        // "Max" on a Sell Listing quantity, "All" on a Sell Now quantity
        const quantityRow = modal.querySelector('div[class*="MarketplacePanel_quantityInputs"]');
        const priceRow = modal.querySelector('div[class*="MarketplacePanel_priceInputs"]');
        const scope = quantityRow || modal;

        const maxButton = Array.from(scope.querySelectorAll('button')).find((btn) => {
            if (priceRow && priceRow.contains(btn)) return false;
            const text = btn.textContent.trim();
            return text === 'Max' || text === 'All';
        });

        if (!maxButton) {
            return false;
        }

        // Don't click if button is disabled
        if (maxButton.disabled) {
            return false;
        }

        // Click the quantity Max/All button
        try {
            maxButton.click();
            return true;
        } catch (error) {
            console.error('[AutoClickMax] Failed to click Max/All button:', error);
            return false;
        }
    }

    /**
     * Disable and cleanup
     */
    disable() {
        try {
            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];
            this.processedModals = new WeakSet();
            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Auto Click Max] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const autoClickMax = new AutoClickMax();

export default autoClickMax;
