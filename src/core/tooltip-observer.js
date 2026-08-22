/**
 * Tooltip Observer
 * Centralized observer for tooltip/popper appearances
 * Any feature can subscribe to be notified when tooltips appear
 *
 * Every new popper is classified once — item tooltip, collection tooltip,
 * ability tooltip, or something else — with the name element, parsed
 * enhancement level and any item hrid the markup carries, and the
 * classification is handed to every subscriber. Six tooltip features used
 * to register their own class handler and each re-run the same probes over
 * the same popper on every hover.
 */

import domObserver from './dom-observer.js';

const REGEX_ENHANCEMENT_LEVEL = /\+(\d+)$/;
const REGEX_ITEM_LINK = /\/items\/(.+?)(?:\/|$)/;
const REGEX_SPRITE_NAME = /#(.+)$/;

/**
 * @typedef {Object} TooltipInfo
 * @property {boolean} isTooltipPopper - The popper carries `MuiTooltip-popper` (a hover tooltip, not a menu popper)
 * @property {'item'|'collection'|'ability'|'other'} kind - collection wins over item, item over ability
 * @property {boolean} isItemTooltip - An `ItemTooltipText_name` element is present
 * @property {boolean} isCollectionTooltip - A `Collection_tooltipContent` element is present
 * @property {Element|null} nameEl - The `div[class*="ItemTooltipText_name"]`, when present
 * @property {string|null} itemName - Trimmed text of `nameEl`, enhancement suffix included
 * @property {number} enhancementLevel - The `+N` suffix of `itemName`, 0 when absent
 * @property {Element|null} collectionContent - The `div[class*="Collection_tooltipContent"]`, when present
 * @property {Element|null} collectionNameEl - The `div[class*="Collection_name"]` of a collection tooltip
 * @property {Element|null} abilityTooltip - The `Ability_abilityTooltip` content of an ability tooltip
 * @property {string|null} itemHrid - From an item link or sprite reference in the popper, when it carries one
 */

/**
 * Classify a new popper once, with the probes the tooltip features share.
 * @param {Element} element - The popper
 * @returns {TooltipInfo}
 */
function classifyTooltip(element) {
    const className = typeof element.className === 'string' ? element.className : '';
    const info = {
        isTooltipPopper: className.includes('MuiTooltip-popper'),
        kind: 'other',
        isItemTooltip: false,
        isCollectionTooltip: false,
        nameEl: null,
        itemName: null,
        enhancementLevel: 0,
        collectionContent: null,
        collectionNameEl: null,
        abilityTooltip: null,
        itemHrid: null,
    };
    if (!info.isTooltipPopper) return info;

    info.collectionContent = element.querySelector('div[class*="Collection_tooltipContent"]');
    info.isCollectionTooltip = !!info.collectionContent;
    info.nameEl = element.querySelector('div[class*="ItemTooltipText_name"]');
    info.isItemTooltip = !!info.nameEl;

    if (info.nameEl) {
        info.itemName = info.nameEl.textContent.trim();
        const match = info.itemName.match(REGEX_ENHANCEMENT_LEVEL);
        if (match) info.enhancementLevel = parseInt(match[1], 10);
    }

    if (info.isCollectionTooltip) {
        info.kind = 'collection';
        info.collectionNameEl = element.querySelector('div[class*="Collection_name"]');
    } else if (info.isItemTooltip) {
        info.kind = 'item';
    } else {
        info.abilityTooltip = element.querySelector('[class*="Ability_abilityTooltip"]');
        if (info.abilityTooltip) info.kind = 'ability';
    }

    // An item link or sprite reference names the item outright; the hover
    // tracking features (alt-click, sell queue) read it before the name
    const itemLink = element.querySelector('a[href*="/items/"]');
    const linkMatch = itemLink?.getAttribute('href')?.match(REGEX_ITEM_LINK);
    if (linkMatch) {
        info.itemHrid = `/items/${linkMatch[1]}`;
    } else {
        const svgUse = element.querySelector('use[href*="items_sprite"]');
        const spriteMatch = svgUse?.getAttribute('href')?.match(REGEX_SPRITE_NAME);
        if (spriteMatch) info.itemHrid = `/items/${spriteMatch[1]}`;
    }

    return info;
}

class TooltipObserver {
    constructor() {
        this.subscribers = new Map(); // name -> callback
        this.unregisterObserver = null;
        this.isInitialized = false;
        /** Tooltips told "opened" whose "closed" is still owed */
        this.open = new Set();
        /** One observer for every open tooltip, attached only while any is open */
        this.removalObserver = null;
        /**
         * Poppers already delivered and still in the document. The DOM observer
         * can hand the same popper over twice — as the inserted node and again
         * as a descendant of an inserted container — and each used to reach
         * every feature twice.
         */
        this.delivered = new WeakSet();
        /** Classification per open popper, handed back with "closed" */
        this.infoByElement = new WeakMap();
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
     * Subscribe to tooltip appearance events.
     *
     * Subscribers are notified in subscription order, so features that append
     * sections to a tooltip stack them in the order they were initialized.
     * @param {string} name - Unique subscriber name
     * @param {Function} callback - Function(element, 'opened'|'closed', info) — `info` is the
     *   popper's {@link TooltipInfo} classification
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
     * Classify a popper the way new ones are classified on arrival
     * @param {Element} element - The tooltip/popper element
     * @returns {TooltipInfo}
     */
    classify(element) {
        return classifyTooltip(element);
    }

    /**
     * Notify all subscribers that a tooltip appeared
     * @param {Element} element - The tooltip/popper element
     * @private
     */
    notifySubscribers(element) {
        // Once per popper while it is in the document; a popper that leaves
        // and comes back (removal tracking below clears it) is delivered again
        if (this.delivered.has(element)) return;

        const info = classifyTooltip(element);

        // Watch for this tooltip leaving the document, so "closed" follows
        // "opened". One observer serves every open tooltip and is dropped once
        // the last one closes. It used to be one observer per tooltip on the
        // tooltip's parent, disconnected only when the tooltip itself was a
        // removed child — an ancestor torn down around it left that observer
        // attached for good, and a long session opened thousands.
        if (element.isConnected) {
            this.delivered.add(element);
            this.infoByElement.set(element, info);
            this.open.add(element);
            this._watchRemovals();
        }

        // Notify subscribers that tooltip opened
        for (const [name, callback] of this.subscribers.entries()) {
            try {
                callback(element, 'opened', info);
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
            this.delivered.delete(element);
            const info = this.infoByElement.get(element);
            this.infoByElement.delete(element);
            for (const [name, callback] of this.subscribers.entries()) {
                try {
                    callback(element, 'closed', info);
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
        for (const element of this.open) this.delivered.delete(element);
        this.open.clear();
        this.subscribers.clear();
        this.isInitialized = false;
    }
}

const tooltipObserver = new TooltipObserver();

export default tooltipObserver;
export { classifyTooltip };
