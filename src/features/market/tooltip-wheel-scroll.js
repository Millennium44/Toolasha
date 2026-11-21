/**
 * Tooltip Wheel Scroll
 *
 * A tooltip taller than the window is capped and made scrollable (tooltip-prices' styles and
 * `fixTooltipOverflow`), but the pointer sits on the item that opened it, and moving onto the
 * tooltip closes it, so its scrollbar could never be reached. This turns the mouse wheel over the
 * item into a scroll of its tooltip.
 *
 * Only while the open tooltip overflows and can still move in the wheel's direction. At either end
 * the wheel goes back to the page (the inventory or market list scrolls as before, which closes the
 * tooltip), and a wheel gesture that began on the page keeps going to the page even when a tall
 * tooltip opens under the pointer mid-scroll: a passive listener times every wheel event, tooltip or
 * not. The non-passive listener that can take a wheel exists only while a tooltip is open, so
 * ordinary scrolling never waits on it.
 */

import config from '../../core/config.js';
import tooltipObserver from '../../core/tooltip-observer.js';

export const WHEEL_SCROLL_SETTING = 'itemTooltip_wheelScroll';
const SUBSCRIBER = 'TooltipWheelScroll';
/** A wheel event this soon after one the page took belongs to the same page gesture */
const PAGE_GESTURE_MS = 300;
/** Pixels per line for a wheel reported in lines (Firefox with some mice) */
const LINE_PX = 16;
const LISTENER_OPTIONS = { capture: true, passive: false };
/** On the window in the capture phase, so it runs before the document listener that may take the wheel */
const TIMER_OPTIONS = { capture: true, passive: true };

/**
 * The wheel's vertical travel in pixels, whatever unit the browser reported it in.
 * @param {{deltaY: number, deltaMode?: number}} event
 * @param {number} pageHeight - What one "page" is, for deltaMode 2
 * @returns {number}
 */
export function wheelPixels(event, pageHeight) {
    const dy = Number(event?.deltaY) || 0;
    if (event?.deltaMode === 1) return dy * LINE_PX;
    if (event?.deltaMode === 2) return dy * pageHeight;
    return dy;
}

/**
 * The element inside a tooltip popper that actually scrolls, if it has anything to scroll.
 * @param {Element} popper
 * @returns {Element|null}
 */
export function overflowingScroller(popper) {
    for (const element of [popper.querySelector('.MuiTooltip-tooltip'), popper]) {
        if (element && element.scrollHeight > element.clientHeight + 1) return element;
    }
    return null;
}

/**
 * Whether a scroller can still move `dy` pixels' direction.
 * @param {Element} scroller
 * @param {number} dy
 * @returns {boolean}
 */
export function canScroll(scroller, dy) {
    if (dy > 0) return scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - 1;
    if (dy < 0) return scroller.scrollTop > 0;
    return false;
}

class TooltipWheelScroll {
    constructor() {
        this.isInitialized = false;
        /** Open hover tooltips, newest last */
        this.open = new Set();
        this.listening = false;
        /** When the last wheel event came, and whether a tooltip took it */
        this.lastWheel = -Infinity;
        this.lastTaken = false;
        /** The wheel event now being handled continues a gesture the page took */
        this.pageGesture = false;
        this.onWheel = (event) => this.handleWheel(event);
        this.onAnyWheel = (event) => this.timeWheel(event);
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.isFeatureEnabled(WHEEL_SCROLL_SETTING)) return;
        this.isInitialized = true;
        window.addEventListener('wheel', this.onAnyWheel, TIMER_OPTIONS);
        tooltipObserver.subscribe(SUBSCRIBER, (element, eventType, info) => {
            if (eventType === 'opened') this.track(element, info);
            else if (eventType === 'closed') this.untrack(element);
        });
    }

    /**
     * @param {Element} popper
     * @param {import('../../core/tooltip-observer.js').TooltipInfo} [info]
     */
    track(popper, info) {
        if (!info?.isTooltipPopper) return;
        // A click menu: the pointer can reach it, so its own scrolling works
        if (popper.classList?.contains('MuiTooltip-popperInteractive')) return;
        this.open.add(popper);
        if (!this.listening) {
            document.addEventListener('wheel', this.onWheel, LISTENER_OPTIONS);
            this.listening = true;
        }
    }

    /** @param {Element} popper */
    untrack(popper) {
        this.open.delete(popper);
        if (this.open.size === 0) this.stopListening();
    }

    stopListening() {
        if (!this.listening) return;
        document.removeEventListener('wheel', this.onWheel, LISTENER_OPTIONS);
        this.listening = false;
    }

    /**
     * Every wheel event, before any tooltip handling: is it part of a gesture the page has been taking?
     * @param {WheelEvent} event
     */
    timeWheel(event) {
        const now = Number(event.timeStamp) || Date.now();
        this.pageGesture = now - this.lastWheel < PAGE_GESTURE_MS && !this.lastTaken;
        this.lastWheel = now;
        this.lastTaken = false;
    }

    /** @param {WheelEvent} event */
    handleWheel(event) {
        if (!config.isFeatureEnabled(WHEEL_SCROLL_SETTING)) return;
        // Ctrl+wheel zooms the page; a sideways wheel is not ours
        if (event.ctrlKey || event.defaultPrevented) return;
        if (this.pageGesture) return;

        let popper = null;
        for (const candidate of this.open) {
            if (!candidate.isConnected) {
                this.open.delete(candidate);
                continue;
            }
            // Over the tooltip itself: the browser scrolls it already
            if (candidate.contains(event.target)) return;
            popper = candidate;
        }
        if (this.open.size === 0) this.stopListening();
        if (!popper) return;

        const scroller = overflowingScroller(popper);
        const dy = wheelPixels(event, scroller?.clientHeight || window.innerHeight);
        if (!scroller || !canScroll(scroller, dy)) return;

        event.preventDefault();
        this.lastTaken = true;
        scroller.scrollTop += dy;
    }

    cleanup() {
        tooltipObserver.unsubscribe(SUBSCRIBER);
        this.open.clear();
        this.stopListening();
        window.removeEventListener('wheel', this.onAnyWheel, TIMER_OPTIONS);
        this.lastWheel = -Infinity;
        this.lastTaken = false;
        this.pageGesture = false;
        this.isInitialized = false;
    }
}

const tooltipWheelScroll = new TooltipWheelScroll();

export { tooltipWheelScroll };

export default {
    name: 'Tooltip Wheel Scroll',
    initialize: async () => {
        tooltipWheelScroll.initialize();
    },
    cleanup: () => {
        tooltipWheelScroll.cleanup();
    },
    disable: () => {
        tooltipWheelScroll.cleanup();
    },
};
