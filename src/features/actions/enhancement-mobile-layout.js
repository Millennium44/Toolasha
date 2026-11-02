/**
 * Phone layout for the Enhancement Calculator.
 *
 * The calculator is normally inserted beside the drop table, which on a phone is deep inside the
 * right-hand column of the game's two-column Enhancing panel (a nowrap flex row), so it can be no
 * wider than that column. CSS on its own parent cannot widen it past the column.
 *
 * Below the shared phone breakpoint the calculator is therefore placed as the last child of the
 * panel itself, the panel is allowed to wrap, and the calculator takes a full-width line under
 * both columns. Above the breakpoint the placement is exactly the old one (after the drop table,
 * or the experience line, otherwise at the end of the panel).
 *
 * The stylesheet is inert above the breakpoint and its rules only match a panel that directly
 * holds the calculator, so a wide layout never gains `flex-wrap`. A CSS rule cannot move a node,
 * so one `change` listener on the media query re-places an existing calculator when the window
 * is resized or rotated across the breakpoint. Release removes the listener and the stylesheet.
 */

import { MARKET_MOBILE_QUERY } from '../market/market-mobile-layout.js';

export const ENHANCEMENT_MOBILE_STYLE_ID = 'mwi-enhancement-mobile-layout';

const PANEL = '[class*="SkillActionDetail_enhancingComponent"]';
const CALCULATOR_ID = 'mwi-enhancement-stats';

/** The stylesheet text. Exported so tests can read the rules without a layout engine. */
export const ENHANCEMENT_MOBILE_CSS = `
    @media ${MARKET_MOBILE_QUERY} {
        ${PANEL}:has(> #${CALCULATOR_ID}) { flex-wrap: wrap; }
        ${PANEL} > #${CALCULATOR_ID} { flex: 1 1 100%; min-width: 0; box-sizing: border-box; }
    }
`;

let query = null;

/** @returns {boolean} Whether the window is currently phone width */
export function isPhoneWidth() {
    return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia(MARKET_MOBILE_QUERY).matches
        : false;
}

/**
 * Put the calculator where the current width wants it. Does nothing when it is already there, so
 * a redraw or a resize inside one width range causes no DOM mutation.
 * @param {HTMLElement} panel - The Enhancing panel
 * @param {HTMLElement} container - The calculator node (new or existing)
 */
export function placeCalculator(panel, container) {
    if (isPhoneWidth()) {
        if (container.parentNode !== panel || panel.lastElementChild !== container) {
            panel.appendChild(container);
        }
        return;
    }

    const dropTable = panel.querySelector('div.SkillActionDetail_dropTable__3ViVp');
    const expGain = panel.querySelector('div.SkillActionDetail_expGain__F5xHu');
    const insertAfter = dropTable || expGain;
    if (insertAfter) {
        if (insertAfter.nextSibling !== container) {
            insertAfter.parentNode.insertBefore(container, insertAfter.nextSibling);
        }
    } else if (container.parentNode !== panel || panel.lastElementChild !== container) {
        panel.appendChild(container);
    }
}

/** Re-place every calculator on the page for the new width */
function onBreakpointChange() {
    for (const container of document.querySelectorAll(`#${CALCULATOR_ID}`)) {
        const panel = container.closest(PANEL);
        if (panel) placeCalculator(panel, container);
    }
}

/** Install the stylesheet and the breakpoint listener, each once. Safe to call after every render. */
export function ensureEnhancementMobileStyles() {
    if (!document.getElementById(ENHANCEMENT_MOBILE_STYLE_ID)) {
        const style = document.createElement('style');
        style.id = ENHANCEMENT_MOBILE_STYLE_ID;
        style.textContent = ENHANCEMENT_MOBILE_CSS;
        document.head.appendChild(style);
    }
    if (!query && typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
        query = window.matchMedia(MARKET_MOBILE_QUERY);
        query.addEventListener?.('change', onBreakpointChange);
    }
}

/** Remove the listener and the rules. Called when the calculator is turned off or the observer is disabled. */
export function releaseEnhancementMobileStyles() {
    query?.removeEventListener?.('change', onBreakpointChange);
    query = null;
    document.getElementById(ENHANCEMENT_MOBILE_STYLE_ID)?.remove();
}
