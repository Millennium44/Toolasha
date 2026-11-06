/**
 * Inventory Tooltip Beside
 * Keeps an inventory item's tooltip off the hovered item itself. The game's placement above or below is
 * kept whenever it clears the item; a tooltip that would land on it (too tall for either side) moves to
 * the left or right of the item, whichever has more room.
 *
 * Rides the shared tooltip observer for open and close. Positioning is a class on the popper plus two
 * CSS custom properties: Popper.js keeps rewriting the inline transform on its own updates, and a class
 * rule with !important wins over it without a fight. Re-checked when the game moves the popper (its
 * inline style; the first placement lands a frame after open) and when it resizes (features append
 * lines after open); nothing runs on a timer or on pointer move. With no room on either side, or on a
 * phone, the game's own placement is left alone.
 */

import config from '../../core/config.js';
import tooltipObserver from '../../core/tooltip-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';
import { isMobileMode } from '../../utils/mobile.js';

const SUBSCRIBER = 'InventoryTooltipBeside';
const SETTING_KEY = 'inventoryTooltipBeside';
const STYLE_ID = 'toolasha-tip-beside-style';
const CLASS_NAME = 'toolasha-tip-beside';
const INVENTORY_SELECTOR = '[class*="Inventory_items"]';
const TILE_SELECTOR = '[class*="Item_itemContainer"]';
/** Gap between the tooltip and the hovered item, and the least margin kept from the viewport edge */
const PANEL_GAP = 8;
const VIEWPORT_MARGIN = 8;

const CSS = `
.${CLASS_NAME} {
    position: fixed !important;
    inset: 0 auto auto 0 !important;
    margin: 0 !important;
    transform: translate3d(var(--tl-tip-x, 0px), var(--tl-tip-y, 0px), 0) !important;
}
.${CLASS_NAME} .MuiTooltip-tooltip {
    max-height: calc(100vh - ${VIEWPORT_MARGIN * 2}px);
    overflow-y: auto;
}
.${CLASS_NAME} .MuiTooltip-arrow,
.${CLASS_NAME} [data-popper-arrow] {
    display: none !important;
}
`;

/**
 * Whether two rects overlap by more than a pixel.
 * @param {{left: number, top: number, right?: number, bottom?: number, width?: number, height?: number}} a
 * @param {{left: number, top: number, right?: number, bottom?: number, width?: number, height?: number}} b
 * @returns {boolean}
 */
export function rectsOverlap(a, b) {
    const right = (r) => (Number.isFinite(r.right) ? r.right : r.left + (r.width || 0));
    const bottom = (r) => (Number.isFinite(r.bottom) ? r.bottom : r.top + (r.height || 0));
    return a.left < right(b) - 1 && b.left < right(a) - 1 && a.top < bottom(b) - 1 && b.top < bottom(a) - 1;
}

/**
 * Where a tooltip should go so it never covers the hovered item, or null to keep the game's placement.
 *
 * The one rule (the maintainer's): the item itself must stay in view. The game's own placement above or
 * below is kept whenever it already clears the tile; only when it would land on the tile does the
 * tooltip move beside it, to whichever side, left or right, has room (the roomier one when both do),
 * top aligned to the tile and clamped into the viewport. With room on neither side the game decides.
 * @param {DOMRect|Object} gameRect - Where the game placed the tooltip
 * @param {DOMRect|Object} tile - Hovered tile rect
 * @param {{width: number, height: number}} viewport - Viewport size
 * @returns {{x: number, y: number}|null}
 */
export function placeClear(gameRect, tile, viewport) {
    const width = gameRect.width;
    const height = gameRect.height;
    if (!(width > 0)) return null;
    if (!rectsOverlap(gameRect, tile)) return null;

    const tileRight = Number.isFinite(tile.right) ? tile.right : tile.left + (tile.width || 0);
    const leftX = tile.left - PANEL_GAP - width;
    const rightX = tileRight + PANEL_GAP;
    const leftRoom = tile.left - PANEL_GAP - VIEWPORT_MARGIN;
    const rightRoom = viewport.width - VIEWPORT_MARGIN - tileRight - PANEL_GAP;
    const leftFits = leftX >= VIEWPORT_MARGIN;
    const rightFits = rightX + width <= viewport.width - VIEWPORT_MARGIN;
    let x;
    if (leftFits && rightFits) x = leftRoom >= rightRoom ? leftX : rightX;
    else if (leftFits) x = leftX;
    else if (rightFits) x = rightX;
    else return null;

    let y = tile.top;
    if (y + height > viewport.height - VIEWPORT_MARGIN) y = viewport.height - VIEWPORT_MARGIN - height;
    if (y < VIEWPORT_MARGIN) y = VIEWPORT_MARGIN;
    return { x: Math.round(x), y: Math.round(y) };
}

class InventoryTooltipBeside {
    constructor() {
        this.isInitialized = false;
        /** popper -> ResizeObserver, for every tooltip currently tracked */
        this.tracked = new Map();
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.isFeatureEnabled(SETTING_KEY)) return;
        this.isInitialized = true;
        addStyles(CSS, STYLE_ID);
        tooltipObserver.subscribe(SUBSCRIBER, (element, eventType, info) => {
            if (eventType === 'closed') {
                this.release(element);
            } else if (eventType === 'opened') {
                this.handleOpen(element, info);
            }
        });
    }

    /**
     * @param {Element} popper
     * @param {import('../../core/tooltip-observer.js').TooltipInfo} [info]
     */
    handleOpen(popper, info) {
        if (!info?.isTooltipPopper || !info.isItemTooltip) return;
        if (!config.isFeatureEnabled(SETTING_KEY) || isMobileMode()) return;
        if (!this.findTile(popper)) return;
        this.reposition(popper);
        if (this.tracked.has(popper)) return;
        // The game positions the popper a frame after it is added, so the first check usually sees it
        // unplaced. Re-check whenever the game moves it (its inline style) or it resizes (lines appended).
        const update = () => {
            if (!popper.isConnected) this.release(popper);
            else this.reposition(popper);
        };
        const observers = [];
        if (typeof MutationObserver === 'function') {
            const mutationObserver = new MutationObserver(update);
            mutationObserver.observe(popper, { attributes: true, attributeFilter: ['style'] });
            observers.push(mutationObserver);
        }
        if (typeof ResizeObserver === 'function') {
            const resizeObserver = new ResizeObserver(update);
            resizeObserver.observe(popper);
            observers.push(resizeObserver);
        }
        this.tracked.set(popper, observers);
    }

    /**
     * The hovered inventory tile a tooltip belongs to, or null when its anchor is not in the inventory.
     * @param {Element} popper
     * @returns {Element|null}
     */
    findTile(popper) {
        const trigger = popper.id ? document.querySelector(`[aria-describedby="${popper.id}"]`) : null;
        if (!trigger?.closest(INVENTORY_SELECTOR)) return null;
        return trigger.closest(TILE_SELECTOR) || trigger;
    }

    /**
     * Measure and set the position. When the game's placement already clears the item, or there is no
     * room beside it, takes the class off so the game's placement applies.
     * @param {Element} popper
     * @returns {boolean} Whether the tooltip is now moved beside the item
     */
    reposition(popper) {
        if (!config.isFeatureEnabled(SETTING_KEY) || isMobileMode()) {
            this.unplace(popper);
            return false;
        }
        const tile = this.findTile(popper);
        if (!tile) {
            this.unplace(popper);
            return false;
        }
        // Where the game itself puts it: measured with the class off, in the same task, so nothing paints
        // in between and the net size the ResizeObserver sees is unchanged
        const wasPlaced = popper.classList.contains(CLASS_NAME);
        if (wasPlaced) popper.classList.remove(CLASS_NAME);
        const gameRect = popper.getBoundingClientRect();
        if (wasPlaced) popper.classList.add(CLASS_NAME);
        const spot = placeClear(gameRect, tile.getBoundingClientRect(), {
            width: window.innerWidth,
            height: window.innerHeight,
        });
        if (!spot) {
            this.unplace(popper);
            return false;
        }
        const x = `${spot.x}px`;
        const y = `${spot.y}px`;
        if (popper.style.getPropertyValue('--tl-tip-x') !== x) popper.style.setProperty('--tl-tip-x', x);
        if (popper.style.getPropertyValue('--tl-tip-y') !== y) popper.style.setProperty('--tl-tip-y', y);
        popper.classList.add(CLASS_NAME);
        return true;
    }

    /** @param {Element} popper */
    unplace(popper) {
        if (popper.classList.contains(CLASS_NAME)) popper.classList.remove(CLASS_NAME);
        // Only touch the style when there is something to remove: every style write wakes the observer
        if (popper.style.getPropertyValue('--tl-tip-x')) popper.style.removeProperty('--tl-tip-x');
        if (popper.style.getPropertyValue('--tl-tip-y')) popper.style.removeProperty('--tl-tip-y');
    }

    /** Stop tracking a tooltip and hand it back to the game's placement. */
    release(popper) {
        for (const observer of this.tracked.get(popper) || []) observer.disconnect();
        this.tracked.delete(popper);
        this.unplace(popper);
    }

    cleanup() {
        for (const popper of [...this.tracked.keys()]) this.release(popper);
        tooltipObserver.unsubscribe(SUBSCRIBER);
        removeStyles(STYLE_ID);
        this.isInitialized = false;
    }
}

const inventoryTooltipBeside = new InventoryTooltipBeside();

export default {
    name: 'Inventory Tooltip Beside',
    initialize: async () => {
        await inventoryTooltipBeside.initialize();
    },
    cleanup: () => {
        inventoryTooltipBeside.cleanup();
    },
    disable: () => {
        inventoryTooltipBeside.cleanup();
    },
};
export { InventoryTooltipBeside };
