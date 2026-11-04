/**
 * The Combat Sim / Lab Sim tab button, sized to sit in the game's tab strip.
 *
 * The button carries the game's own tab class, so on a phone it takes the
 * neighboring tabs' font size, padding and height by itself. The compact
 * 12px / 4px 10px sizing only belongs on a wide screen, so it is a stylesheet
 * rule scoped to wide screens rather than inline styles, which would also win
 * on a phone. Same breakpoint as MARKET_MOBILE_QUERY. It is `!important` because
 * the game's tab class has the same specificity and, measured live, wins without it.
 */

import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'toolasha-sim-tab-style';
const SIM_TAB_SELECTOR = '.toolasha-combat-sim-btn, .toolasha-lab-sim-btn';
const CSS = `@media (min-width: 769px) {
    ${SIM_TAB_SELECTOR} { padding: 4px 10px !important; font-size: 12px !important; }
}`;

/**
 * Build a sim tab button (gradient kept) and make sure the wide-screen sizing rule is installed.
 * @param {string} label - Button text
 * @param {string} buttonClass - Feature's own class
 * @param {Function} onClick - Click handler
 * @returns {HTMLElement} The button, not yet attached
 */
export function createSimTabButton(label, buttonClass, onClick) {
    addStyles(CSS, STYLE_ID);
    const button = document.createElement('div');
    button.className = 'MuiButtonBase-root MuiTab-root MuiTab-textColorPrimary css-1q2h7u5 ' + buttonClass;
    button.textContent = label;
    button.style.cssText =
        'cursor: pointer; background: linear-gradient(135deg, #3a7bd5, #5f3dc4); color: #fff; border-radius: 4px; white-space: nowrap;';
    button.addEventListener('click', onClick);
    return button;
}

/** Drop the rule once neither sim tab button is left on the page. */
export function removeSimTabStyleIfUnused() {
    if (!document.querySelector(SIM_TAB_SELECTOR)) {
        removeStyles(STYLE_ID);
    }
}
