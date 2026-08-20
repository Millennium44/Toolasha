/**
 * Auto-Fill Market Price
 * Automatically fills marketplace order forms with optimal competitive pricing
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { parseItemCount } from '../../utils/number-parser.js';
import { setReactInputValue } from '../../utils/react-input.js';

/**
 * The tradable range a listing modal states, when it states one.
 *
 * The game bounds each item's postable prices to a daily band ("Tradable
 * range: 307M – 375M"), but the best standing offer can sit OUTSIDE it — a
 * stale order from before the band moved. Matching that offer fills a price
 * the range no longer admits, and a buy listing under the floor is one nobody
 * can sell to.
 *
 * @param {string} text - The modal's text content
 * @returns {{min: number, max: number}|null} The band, or null when unstated
 */
export function tradableRangeFrom(text) {
    const match = String(text || '').match(/tradable range:?\s*([\d.,\s]+[kmbt]?)\s*[–—-]\s*([\d.,\s]+[kmbt]?)/i);
    if (!match) return null;
    const min = parseItemCount(match[1], NaN);
    const max = parseItemCount(match[2], NaN);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return null;
    return { min, max };
}

/**
 * Where a price outside the band should land: the nearest admitted bound.
 * @param {number} price - The filled price
 * @param {{min: number, max: number}} range - The band
 * @returns {number} The price, clamped into the band
 */
export function clampToRange(price, range) {
    return Math.min(Math.max(price, range.min), range.max);
}

class AutoFillPrice {
    constructor() {
        this.isActive = false;
        this.unregisterHandlers = [];
        this.processedModals = new WeakSet(); // Track processed modals to prevent duplicates
        this.isInitialized = false;
        this.timerRegistry = createTimerRegistry();
    }

    /**
     * Initialize auto-fill price feature
     */
    initialize() {
        // Guard FIRST (before feature check)
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('fillMarketOrderPrice')) {
            return;
        }

        this.isInitialized = true;

        // Register DOM observer for marketplace order modals
        this.registerDOMObservers();

        this.isActive = true;
    }

    /**
     * Register DOM observers for order modals
     */
    registerDOMObservers() {
        // Watch for order modals appearing
        const unregister = domObserver.onClass('auto-fill-price', 'Modal_modalContainer', (modal) => {
            // Check if this is a marketplace order modal (not instant buy/sell)
            const header = modal.querySelector('div[class*="MarketplacePanel_header"]');
            if (!header) return;

            const headerText = header.textContent.trim();

            // Skip instant buy/sell modals (contain "Now" in title)
            if (headerText.includes(' Now')) {
                return;
            }

            // Handle the order modal
            this.handleOrderModal(modal);
        });

        this.unregisterHandlers.push(unregister);
    }

    /**
     * Handle new order modal
     * @param {HTMLElement} modal - Modal container element
     */
    handleOrderModal(modal) {
        // Prevent duplicate processing (dom-observer can fire multiple times for same modal)
        if (this.processedModals.has(modal)) {
            return;
        }
        this.processedModals.add(modal);

        // Find the "Best Price" button/label
        const bestPriceLabel = modal.querySelector('span[class*="MarketplacePanel_bestPrice"]');
        if (!bestPriceLabel) {
            return;
        }

        // Determine if this is a buy or sell order
        const labelParent = bestPriceLabel.parentElement;
        const labelText = labelParent.textContent.toLowerCase();

        const isBuyOrder = labelText.includes('best buy');
        const isSellOrder = labelText.includes('best sell');

        if (!isBuyOrder && !isSellOrder) {
            return;
        }

        // Click the best price label to populate the suggested price
        bestPriceLabel.click();

        // Adjust price after clicking to be optimally competitive
        // For buy orders: increment by 1 to outbid
        // For sell orders: depends on user setting (match or undercut)
        const adjustTimeout = setTimeout(() => {
            this.adjustPrice(modal, isBuyOrder, isSellOrder);
        }, 50);
        this.timerRegistry.registerTimeout(adjustTimeout);

        // Once the strategy click has settled, pull a price the band no longer
        // admits back inside it — matching a stale offer under the floor fills
        // a listing nobody can trade against
        const clampTimeout = setTimeout(() => {
            this.clampPriceToTradableRange(modal);
        }, 150);
        this.timerRegistry.registerTimeout(clampTimeout);
    }

    /**
     * Adjust the price to be optimally competitive
     * @param {HTMLElement} modal - Modal container element
     * @param {boolean} isBuyOrder - True if buy order
     * @param {boolean} isSellOrder - True if sell order
     */
    adjustPrice(modal, isBuyOrder, isSellOrder) {
        // Find the price input container
        const inputContainer = modal.querySelector(
            'div[class*="MarketplacePanel_inputContainer"] div[class*="MarketplacePanel_priceInputs"]'
        );
        if (!inputContainer) {
            return;
        }

        // Find the increment/decrement buttons
        const buttonContainers = inputContainer.querySelectorAll('div[class*="MarketplacePanel_buttonContainer"]');

        if (buttonContainers.length < 3) {
            return;
        }

        if (isBuyOrder) {
            const buyStrategy = config.getSettingValue('market_autoFillBuyStrategy', 'outbid');

            if (buyStrategy === 'outbid') {
                // Click the 3rd button container's button (increment)
                const button = buttonContainers[2].querySelector('div button');
                if (button) button.click();
            } else if (buyStrategy === 'undercut') {
                // Click the 2nd button container's button (decrement)
                const button = buttonContainers[1].querySelector('div button');
                if (button) button.click();
            }
            // If 'match', do nothing (use best buy price as-is)
        } else if (isSellOrder) {
            const sellStrategy = config.getSettingValue('market_autoFillSellStrategy', 'match');

            if (sellStrategy === 'undercut') {
                // Click the 2nd button container's button (decrement)
                const button = buttonContainers[1].querySelector('div button');
                if (button) button.click();
            }
            // If 'match', do nothing (use best sell price as-is)
        }
    }

    /**
     * Rewrite the filled price to the nearest bound of the modal's tradable
     * range when it landed outside it. Modals stating no range (or in a locale
     * whose wording differs) are left exactly as filled.
     * @param {HTMLElement} modal - Modal container element
     */
    clampPriceToTradableRange(modal) {
        const range = tradableRangeFrom(modal.textContent);
        if (!range) return;

        const input = modal.querySelector(
            'div[class*="MarketplacePanel_inputContainer"] div[class*="MarketplacePanel_priceInputs"] input'
        );
        if (!input) return;

        const price = parseItemCount(input.value, NaN);
        if (!Number.isFinite(price)) return;

        const clamped = clampToRange(price, range);
        if (clamped !== price) {
            setReactInputValue(input, String(clamped));
        }
    }

    /**
     * Cleanup on disable
     */
    disable() {
        try {
            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];
            this.timerRegistry.clearAll();
            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Auto Fill Price] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const autoFillPrice = new AutoFillPrice();

export default autoFillPrice;
