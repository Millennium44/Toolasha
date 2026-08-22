/**
 * Tooltip Observer
 * Centralized observer for tooltip/popper appearances
 * Any feature can subscribe to be notified when tooltips appear
 */

import domObserver from './dom-observer.js';

class TooltipObserver {
    constructor() {
        this.subscribers = new Map(); // name -> callback
        this.unregisterObserver = null;
        this.isInitialized = false;
        /** Tooltips told "opened" whose "closed" is still owed */
        this.open = new Set();
        /** One observer for every open tooltip, attached only while any is open */
        this.removalObserver = null;
    }

    /**
     * Initialize the observer (call once)
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        // Watch for tooltip/popper elements appearing
        // These are the common classes used by MUI tooltips/poppers
        this.unregisterObserver = domObserver.onClass('TooltipObserver', ['MuiPopper', 'MuiTooltip'], (element) => {
            this.notifySubscribers(element);
        });
    }

    /**
     * Subscribe to tooltip appearance events
     * @param {string} name - Unique subscriber name
     * @param {Function} callback - Function(element) to call when tooltip appears
     */
    subscribe(name, callback) {
        this.subscribers.set(name, callback);

        // Auto-initialize if first subscriber
        if (!this.isInitialized) {
            this.initialize();
        }
    }

    /**
     * Unsubscribe from tooltip events
     * @param {string} name - Subscriber name
     */
    unsubscribe(name) {
        this.subscribers.delete(name);

        // If no subscribers left, could optionally stop observing
        // For now, keep observer active for simplicity
    }

    /**
     * Notify all subscribers that a tooltip appeared
     * @param {Element} element - The tooltip/popper element
     * @private
     */
    notifySubscribers(element) {
        // Watch for this tooltip leaving the document, so "closed" follows
        // "opened". One observer serves every open tooltip and is dropped once
        // the last one closes. It used to be one observer per tooltip on the
        // tooltip's parent, disconnected only when the tooltip itself was a
        // removed child — an ancestor torn down around it left that observer
        // attached for good, and a long session opened thousands.
        if (element.isConnected) {
            this.open.add(element);
            this._watchRemovals();
        }

        // Notify subscribers that tooltip opened
        for (const [name, callback] of this.subscribers.entries()) {
            try {
                callback(element, 'opened');
            } catch (error) {
                console.error(`[TooltipObserver] Error in subscriber "${name}" (open):`, error);
            }
        }
    }

    /**
     * Attach the shared removal observer, if it is not already up.
     * @private
     */
    _watchRemovals() {
        if (this.removalObserver) return;
        this.removalObserver = new MutationObserver((mutations) => {
            if (!mutations.some((mutation) => mutation.removedNodes.length > 0)) return;
            this._settleRemoved();
        });
        this.removalObserver.observe(document.body, { childList: true, subtree: true });
    }

    /**
     * Tell subscribers about every open tooltip that has left the document,
     * and let the observer go once none are left.
     * @private
     */
    _settleRemoved() {
        for (const element of this.open) {
            if (element.isConnected) continue;
            this.open.delete(element);
            for (const [name, callback] of this.subscribers.entries()) {
                try {
                    callback(element, 'closed');
                } catch (error) {
                    console.error(`[TooltipObserver] Error in subscriber "${name}" (close):`, error);
                }
            }
        }
        if (this.open.size === 0) this._unwatchRemovals();
    }

    /** @private */
    _unwatchRemovals() {
        this.removalObserver?.disconnect();
        this.removalObserver = null;
    }

    /**
     * Cleanup and disable
     */
    disable() {
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }
        this._unwatchRemovals();
        this.open.clear();
        this.subscribers.clear();
        this.isInitialized = false;
    }
}

const tooltipObserver = new TooltipObserver();

export default tooltipObserver;
