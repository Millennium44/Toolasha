/**
 * The game's character panel (inventory, loadouts and the tabs Toolasha adds).
 *
 * On a desktop it is usually open. On a phone it is hidden behind a header icon,
 * so a feature that wants one of its tabs has to open the panel first.
 */

import { clickThroughReact } from './react-click.js';
import { getIconHref } from './game-lookups.js';

const HEADER_SELECTOR = '[class*="Header_header"]';
// Sprite or aria names of the control that opens the panel: matched on the icon, not on any label
const TOGGLE_ICON_PATTERN = /chest|inventory|character|menu/i;

/**
 * The character panel's tab strip: the one holding the Loadouts tab (every tab strip shares classes).
 * @returns {HTMLElement|null}
 */
export function findCharacterTabList() {
    for (const list of document.querySelectorAll('[role="tablist"]')) {
        for (const tab of list.querySelectorAll('[role="tab"]')) {
            if (tab.textContent.trim().startsWith('Loadouts')) return list;
        }
    }
    return null;
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
 * The header control that opens the panel on a phone, found by its icon.
 * @returns {Element|null}
 */
function findPanelToggle() {
    const header = document.querySelector(HEADER_SELECTOR);
    for (const control of header?.querySelectorAll('button, [role="button"]') ?? []) {
        const label = control.querySelector('svg')?.getAttribute('aria-label') || '';
        if (TOGGLE_ICON_PATTERN.test(label) || getIconHref(control, 'misc_sprite')?.match(TOGGLE_ICON_PATTERN)) {
            return control;
        }
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
    return clickThroughReact(toggle) !== 'none';
}
