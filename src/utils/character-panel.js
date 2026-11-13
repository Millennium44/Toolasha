/**
 * The game's character panel (inventory, loadouts and the tabs Toolasha adds).
 *
 * On a desktop it is usually open. On a phone it is hidden behind a header icon,
 * so a feature that wants one of its tabs has to open the panel first.
 */

import { clickThroughReact } from './react-click.js';
import { getIconHref } from './game-lookups.js';

const HEADER_SELECTOR = '[class*="Header_header"]';
const PANEL_SELECTOR = '[class*="GamePage_characterManagementPanel"]';
// Toolasha's own Optimizer tab: an element we own, so it is found without reading any displayed text
const OWN_TAB_SELECTOR = '.toolasha-skilling-opt-tab';
// Sprite fragments (or aria keys) of the control that opens the panel. Matched whole, on the icon only
const TOGGLE_ICON_PATTERN = /^(?:[\w-]+\.)?(?:chest|inventory|character)$/i;

/**
 * The character panel's tab strip, found without its labels (the game may be in another language):
 * the strip holding Toolasha's own tab, else the first strip inside the game's character panel.
 * @returns {HTMLElement|null}
 */
export function findCharacterTabList() {
    const own = document.querySelector(OWN_TAB_SELECTOR)?.closest('[role="tablist"]');
    if (own) return own;
    return document.querySelector(PANEL_SELECTOR)?.querySelector('[role="tablist"]') ?? null;
}

/**
 * Whether the character panel is drawn and on screen.
 * @returns {boolean}
 */
export function isCharacterPanelOpen() {
    const list = findCharacterTabList();
    return Boolean(list && list.getClientRects().length > 0);
}

/**
 * The header control that opens the panel on a phone, found by its icon's sprite fragment or aria key.
 * @returns {Element|null} null when no control matches exactly: a guess is never pressed
 */
function findPanelToggle() {
    const header = document.querySelector(HEADER_SELECTOR);
    for (const control of header?.querySelectorAll('button, [role="button"]') ?? []) {
        const label = control.querySelector('svg')?.getAttribute('aria-label') || '';
        const fragment = (getIconHref(control, 'misc_sprite') || '').split('#')[1] || '';
        if (TOGGLE_ICON_PATTERN.test(label) || TOGGLE_ICON_PATTERN.test(fragment)) return control;
    }
    return null;
}

/**
 * Make the character panel visible: nothing to do if it already is, else press the header icon.
 * @returns {boolean} Whether the panel is open, or a press was made to open it
 */
export function ensureCharacterPanelOpen() {
    if (isCharacterPanelOpen()) return true;
    const toggle = findPanelToggle();
    if (!toggle) return false;
    // The game ignores an untrusted click on its own controls
    return clickThroughReact(toggle, { reactFirst: true }) !== 'none';
}
