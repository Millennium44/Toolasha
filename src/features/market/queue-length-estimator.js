/**
 * Queue Length Estimator Module
 *
 * Displays total quantity available at the best price in order books
 * - Shows below Buy/Sell buttons on the market order book page
 * - Estimates total queue depth when all 20 visible listings have the same price
 * - Uses listing timestamps to extrapolate queue length
 * Ported from Ranged Way Idle's estimateQueueLength feature
 *
 * Layout has two modes, chosen live by `isVolumeStatsPanelActive()`
 * (market-volume-stats.js):
 * - Trade-stats overlay off: the original layout — ask sits left of center,
 *   bid sits right of center, no labels.
 * - Trade-stats overlay on: that overlay anchors to the current-item card's
 *   top-right corner, which is the icon corner the bid count used to sit
 *   next to below the buttons. The two counts collapse into one "Ask 1.1K ·
 *   Bid 15" group in the ask's old spot so nothing sits under the overlay.
 */

import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import config from '../../core/config.js';
import { formatKMB } from '../../utils/formatters.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { GAME } from '../../utils/selectors.js';
import {
    isVolumeStatsPanelActive,
    isVolumeStatsCompact,
    COMBINED_COUNTS_FONT_FULL,
    COMBINED_COUNTS_FONT_COMPACT,
} from './market-volume-stats.js';

/**
 * How long order-book messages are gathered before the display is redrawn.
 *
 * Opening an item sends one message per enhancement level — about twenty in
 * a row — and each used to clear and rebuild the display. The book is stashed
 * the moment it arrives; only the DOM pass waits for the burst to end.
 */
const REPAINT_DEBOUNCE_MS = 50;

class QueueLengthEstimator {
    constructor() {
        this.unregisterWebSocket = null;
        this.unregisterObserver = null;
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.orderBooksCache = {}; // itemHrid → { data: marketItemOrderBooks, lastUpdated }
        this._repaintTimer = null;
    }

    /**
     * Initialize the queue length estimator
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_showQueueLength')) {
            return;
        }

        this.isInitialized = true;

        this.setupWebSocketListeners();
        this.setupObserver();
        this.setupVolumeStatsListener();
    }

    /**
     * Setup WebSocket listeners for order book updates
     */
    setupWebSocketListeners() {
        const orderBookHandler = (data) => {
            if (data.marketItemOrderBooks) {
                const itemHrid = data.marketItemOrderBooks.itemHrid;
                if (itemHrid) {
                    this.orderBooksCache[itemHrid] = {
                        data: data.marketItemOrderBooks,
                        lastUpdated: Date.now(),
                    };
                }

                this.scheduleRepaint();
            }
        };

        dataManager.on('market_item_order_books_updated', orderBookHandler);

        this.unregisterWebSocket = () => {
            dataManager.off('market_item_order_books_updated', orderBookHandler);
            clearTimeout(this._repaintTimer);
            this._repaintTimer = null;
        };

        this.cleanupRegistry.registerCleanup(() => {
            if (this.unregisterWebSocket) {
                this.unregisterWebSocket();
                this.unregisterWebSocket = null;
            }
        });
    }

    /**
     * Redraw whenever the trade-stats overlay (market-volume-stats.js) is
     * switched on or off — that is what decides whether the counts are shown
     * combined or separate — so the layout updates immediately rather than on
     * the next order-book message.
     */
    setupVolumeStatsListener() {
        const handleChange = () => this.repaint();
        const unregisterPooledHistory = config.onSettingChange('market_pooledHistory', handleChange);
        const unregisterVolumeStats = config.onSettingChange('market_volumeStats', handleChange);
        this.cleanupRegistry.registerCleanup(() => {
            unregisterPooledHistory();
            unregisterVolumeStats();
        });
    }

    /**
     * Redraw the queue lengths once the current run of order-book messages
     * has ended.
     */
    scheduleRepaint() {
        if (this._repaintTimer) {
            return;
        }
        this._repaintTimer = setTimeout(() => {
            this._repaintTimer = null;
            this.repaint();
        }, REPAINT_DEBOUNCE_MS);
    }

    /**
     * Clear the processed flags and re-process every order book container on
     * the page with the books now in hand.
     */
    repaint() {
        // Clear processed flags to re-render with new data
        document.querySelectorAll('.mwi-queue-length-set').forEach((container) => {
            container.classList.remove('mwi-queue-length-set');
        });

        // Manually re-process any existing containers
        const existingContainers = document.querySelectorAll('[class*="MarketplacePanel_orderBooksContainer"]');
        existingContainers.forEach((container) => {
            this.processOrderBook(container);
        });
    }

    /**
     * Setup DOM observer to watch for order book container
     */
    setupObserver() {
        this.unregisterObserver = domObserver.onClass(
            'QueueLengthEstimator',
            'MarketplacePanel_orderBooksContainer',
            (container) => {
                this.processOrderBook(container);
            }
        );

        this.cleanupRegistry.registerCleanup(() => {
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }
        });
    }

    /**
     * Process the order book container and inject queue length displays
     * @param {HTMLElement} _container - Order book container (unused - we query directly)
     */
    processOrderBook(_container) {
        // Find the button container where we'll inject the queue lengths
        const buttonContainer = document.querySelector(GAME.MARKETPLACE_NEW_LISTING_BUTTONS);
        if (!buttonContainer) {
            return;
        }

        // Check if already processed
        if (buttonContainer.classList.contains('mwi-queue-length-set')) {
            return;
        }

        // Nothing to say about this item means saying nothing — not leaving the
        // last item's figures standing under the button. Every "we don't know"
        // path below wipes first, because the container is shared between items
        // and enhancement levels.
        const forget = () => buttonContainer.querySelectorAll('.mwi-queue-length').forEach((el) => el.remove());

        // Get current item and order book data from estimated-listing-age module
        const currentItemHrid = this.getCurrentItemHrid();
        if (!currentItemHrid) {
            forget();
            return;
        }

        const orderBooksCache = this.orderBooksCache;
        if (!orderBooksCache[currentItemHrid]) {
            forget();
            return;
        }

        const cacheEntry = orderBooksCache[currentItemHrid];
        const orderBookData = cacheEntry.data || cacheEntry;

        // Get current enhancement level
        const enhancementLevel = this.getCurrentEnhancementLevel();
        const orderBookAtLevel = orderBookData.orderBooks?.[enhancementLevel];

        if (!orderBookAtLevel) {
            forget();
            return;
        }

        // Mark as processed
        buttonContainer.classList.add('mwi-queue-length-set');

        this.renderQueueLengths(buttonContainer, orderBookAtLevel.asks, orderBookAtLevel.bids);
    }

    /**
     * Draw the ask/bid counts in whichever of the two layouts currently
     * applies. Always wipes first: the container is shared between items and
     * this can be reached from a settings toggle as well as a fresh order
     * book, and the previous layout's elements must not linger alongside (or
     * instead of) the new one's.
     * @param {HTMLElement} buttonContainer
     * @param {Array} asks
     * @param {Array} bids
     */
    renderQueueLengths(buttonContainer, asks, bids) {
        buttonContainer.querySelectorAll('.mwi-queue-length').forEach((el) => el.remove());

        if (isVolumeStatsPanelActive()) {
            this.displayCombinedQueueLength(buttonContainer, asks, bids);
        } else {
            this.displayQueueLength(buttonContainer, asks, true);
            this.displayQueueLength(buttonContainer, bids, false);
        }
    }

    /**
     * Work out the displayed queue length and whether it is estimated, the
     * same RWI-derived formula for either side of the book.
     * @param {Array} listings - Array of listings (asks or bids)
     * @returns {{queueLength: number, isEstimated: boolean, visibleCount: number}|null}
     *   null when there is nothing resting on this side.
     */
    computeQueueStats(listings) {
        if (!listings || listings.length === 0) {
            return null;
        }

        // Calculate visible count at top price
        const topPrice = listings[0].price;
        let visibleCount = 0;
        for (const listing of listings) {
            if (listing.price === topPrice) {
                visibleCount += listing.quantity;
            }
        }

        // Check if we should estimate (all 20 visible listings at same price)
        let queueLength = visibleCount;
        let isEstimated = false;

        if (listings.length === 20 && listings[19].price === topPrice) {
            // All 20 visible listings are at the same price - estimate total queue
            const firstTimestamp = new Date(listings[0].createdTimestamp).getTime();
            const lastTimestamp = new Date(listings[19].createdTimestamp).getTime();
            const now = Date.now();

            const timeSpan = lastTimestamp - firstTimestamp;
            const timeSinceNow = now - lastTimestamp;

            if (timeSpan > 0) {
                // RWI formula: 1 + 19/20 * (timeSinceNow / timeSpan)
                // This extrapolates based on the assumption that listings arrive at a constant rate
                const queueMultiplier = 1 + (19 / 20) * (timeSinceNow / timeSpan);
                queueLength = visibleCount * queueMultiplier;
                isEstimated = true;
            }
        }

        return { queueLength, isEstimated, visibleCount: listings.length };
    }

    /**
     * Original layout: one unlabeled figure per side, ask left of center and
     * bid right of center in the button row.
     * @param {HTMLElement} buttonContainer - Button container element
     * @param {Array} listings - Array of listings (asks or bids)
     * @param {boolean} isAsk - True for asks (sell side), false for bids (buy side)
     */
    displayQueueLength(buttonContainer, listings, isAsk) {
        // The old figure goes FIRST, before anything can return early — an item
        // whose side of the book is empty must not leave the previous item's
        // queue length sitting under the button.
        buttonContainer.querySelector(`.mwi-queue-length-${isAsk ? 'ask' : 'bid'}`)?.remove();

        const stats = this.computeQueueStats(listings);
        if (!stats) {
            return;
        }

        const displayElement = document.createElement('div');
        displayElement.classList.add('mwi-queue-length', `mwi-queue-length-${isAsk ? 'ask' : 'bid'}`);
        displayElement.style.fontSize = '1.2rem';
        displayElement.style.textAlign = 'center';
        displayElement.textContent = formatKMB(stats.queueLength, 1);
        displayElement.style.color = this.colorFor(stats.isEstimated);
        displayElement.title = this.tooltipFor(stats, isAsk);

        // Ask goes before the second child (between first button and sell button),
        // bid goes before the last child (before buy button)
        if (isAsk) {
            buttonContainer.insertBefore(displayElement, buttonContainer.children[1]);
        } else {
            buttonContainer.insertBefore(displayElement, buttonContainer.lastChild);
        }
    }

    /**
     * Compact layout used while the trade-stats overlay (market-volume-stats.js)
     * is on screen: both sides in one "Ask 1.1K · Bid 15" group, in the ask's
     * original spot, so the button row's other side keeps only the Buy button
     * clear of the overlay.
     * @param {HTMLElement} buttonContainer
     * @param {Array} asks
     * @param {Array} bids
     */
    displayCombinedQueueLength(buttonContainer, asks, bids) {
        buttonContainer
            .querySelectorAll('.mwi-queue-length-combined, .mwi-queue-length-spacer')
            .forEach((el) => el.remove());

        const askStats = this.computeQueueStats(asks);
        const bidStats = this.computeQueueStats(bids);
        if (!askStats && !bidStats) {
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.classList.add('mwi-queue-length', 'mwi-queue-length-combined');
        // The row is space-between: with a lone middle item the group would land
        // dead center, under the item icon. Growing the group and an equal spacer
        // after it puts the group in the middle of the left half instead, where
        // the ask count sits in the separate layout.
        wrapper.style.cssText = 'display:flex;flex:1;justify-content:center;align-items:center;gap:5px;min-width:0;';
        // Full size in the expanded view; the table's fit step keeps this in step on resize
        wrapper.style.fontSize = isVolumeStatsCompact() ? COMBINED_COUNTS_FONT_COMPACT : COMBINED_COUNTS_FONT_FULL;

        if (askStats) {
            wrapper.appendChild(this.buildLabeledSide('Ask', askStats, true));
        }
        if (askStats && bidStats) {
            const separator = document.createElement('span');
            separator.textContent = '·';
            separator.style.color = '#AAAAAA';
            wrapper.appendChild(separator);
        }
        if (bidStats) {
            wrapper.appendChild(this.buildLabeledSide('Bid', bidStats, false));
        }

        buttonContainer.insertBefore(wrapper, buttonContainer.children[1]);

        const spacer = document.createElement('div');
        spacer.classList.add('mwi-queue-length', 'mwi-queue-length-spacer');
        spacer.style.flex = '1';
        buttonContainer.insertBefore(spacer, wrapper.nextSibling);
    }

    /**
     * One "Ask 1.1K" (or "Bid 15") span for the combined layout: a small dim
     * label plus the figure in its usual color, sharing the figure's tooltip.
     * @param {string} label - "Ask" or "Bid"
     * @param {{queueLength: number, isEstimated: boolean, visibleCount: number}} stats
     * @param {boolean} isAsk
     * @returns {HTMLElement}
     */
    buildLabeledSide(label, stats, isAsk) {
        const side = document.createElement('span');
        side.classList.add(`mwi-queue-length-${isAsk ? 'ask' : 'bid'}`);
        side.title = this.tooltipFor(stats, isAsk);

        const labelEl = document.createElement('span');
        labelEl.textContent = `${label} `;
        labelEl.style.cssText = 'font-size:0.8em;color:#AAAAAA;';
        side.appendChild(labelEl);

        const valueEl = document.createElement('span');
        valueEl.textContent = formatKMB(stats.queueLength, 1);
        valueEl.style.color = this.colorFor(stats.isEstimated);
        side.appendChild(valueEl);

        return side;
    }

    /**
     * @param {boolean} isEstimated
     * @returns {string} The configured (or default) color for a known vs. estimated figure
     */
    colorFor(isEstimated) {
        const colorSetting = isEstimated ? 'color_queueLength_estimated' : 'color_queueLength_known';
        return config.getSettingValue(colorSetting, isEstimated ? '#60a5fa' : '#ffffff');
    }

    /**
     * @param {{isEstimated: boolean, visibleCount: number}} stats
     * @param {boolean} isAsk
     * @returns {string}
     */
    tooltipFor(stats, isAsk) {
        return stats.isEstimated
            ? `Estimated total queue depth (extrapolated from ${stats.visibleCount} visible orders)`
            : `Total quantity at best ${isAsk ? 'sell' : 'buy'} price`;
    }

    /**
     * Get current item HRID being viewed in order book
     * @returns {string|null} Item HRID or null
     */
    getCurrentItemHrid() {
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        if (currentItemElement) {
            const useElement = currentItemElement.querySelector('use');
            if (useElement && useElement.href && useElement.href.baseVal) {
                const itemHrid = '/items/' + useElement.href.baseVal.split('#')[1];
                return itemHrid;
            }
        }
        return null;
    }

    /**
     * Get current enhancement level being viewed in order book
     * @returns {number} Enhancement level (0 for non-equipment)
     */
    getCurrentEnhancementLevel() {
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        if (currentItemElement) {
            const enhancementElement = currentItemElement.querySelector('[class*="Item_enhancementLevel"]');
            if (enhancementElement) {
                const match = enhancementElement.textContent.match(/\+(\d+)/);
                if (match) {
                    return parseInt(match[1], 10);
                }
            }
        }
        return 0;
    }

    /**
     * Clear all injected displays
     */
    clearDisplays() {
        document.querySelectorAll('.mwi-queue-length-set').forEach((container) => {
            container.classList.remove('mwi-queue-length-set');
        });
        document.querySelectorAll('.mwi-queue-length').forEach((el) => el.remove());
    }

    /**
     * Disable the queue length estimator
     */
    disable() {
        try {
            this.clearDisplays();
            this.cleanupRegistry.cleanupAll();
            this.isInitialized = false;
        } catch (error) {
            console.error('[Queue Length Estimator] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Cleanup when feature is disabled or character switches
     */
    cleanup() {
        this.disable();
    }
}

const queueLengthEstimator = new QueueLengthEstimator();

export default queueLengthEstimator;
