/**
 * The game's character panel (inventory, loadouts and the tabs Toolasha adds).
 *
 * On a desktop it is usually open. On a phone it is hidden behind a header icon,
 * so a feature that wants one of its tabs has to open the panel first.
 */

import { clickThroughReact } from './react-click.js';
import { getIconHref } from './game-lookups.js';

const HEADER_SELECTOR = '[class*="Header_header"]';
// On a phone the header holds no panel toggle; the panel opens from a link in the left navigation, whose
// CSS-module class carries the name of what it opens (never its displayed text: the game may be in Chinese)
const NAV_SELECTOR = '[class*="NavigationBar_navigationLink__"]';
const NAV_LINK_TOKEN = 'NavigationBar_navigationLink__';
const NAV_CLASS_PREFIX = 'NavigationBar_characterManagement';
const NAV_ICON_PATTERN = /^loot$/i;
const PANEL_SELECTOR = '[class*="GamePage_characterManagementPanel"]';
// Toolasha's own Optimizer tab: an element we own, so it is found without reading any displayed text
const OWN_TAB_SELECTOR = '.toolasha-skilling-opt-tab';
// Sprite fragments (or aria keys) of the control that opens the panel. Matched whole, on the icon only
const TOGGLE_ICON_PATTERN = /^(?:[\w-]+\.)?(?:chest|inventory|character)$/i;

/**
 * The character panel's tab strip, found without its labels (the game may be in another language):
 * the strip holding Toolasha's own tab, else the first strip inside the game's character panel. The game draws
 * the panel twice (a side copy, and on a phone a copy inside the main panel that exists only while My Stuff is
 * open), each with its own tab, so the copy on screen wins.
 * @returns {HTMLElement|null}
 */
export function findCharacterTabList() {
    const tab = findVisibleOwnTab() ?? document.querySelector(OWN_TAB_SELECTOR);
    const own = tab?.closest('[role="tablist"]');
    if (own) return own;
    return document.querySelector(PANEL_SELECTOR)?.querySelector('[role="tablist"]') ?? null;
}

/**
 * Toolasha's own tab in whichever copy of the character panel is on screen.
 * @returns {HTMLElement|null}
 */
export function findVisibleOwnTab() {
    for (const tab of document.querySelectorAll(OWN_TAB_SELECTOR)) {
        if (tab.getClientRects().length > 0) return tab;
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
 * The left-navigation link that opens the panel on a phone, found by its CSS-module class prefix or by the
 * sprite fragment of its icon.
 * @returns {Element|null}
 */
function findNavLink() {
    // Only a single link: the plural `NavigationBar_navigationLinks__` container wraps every link, starts with
    // the same text and holds the same icons, so a substring match would press the container
    const hasToken = (el, prefix) => [...el.classList].some((token) => token.startsWith(prefix));
    const links = [...document.querySelectorAll(NAV_SELECTOR)].filter(
        (el) => hasToken(el, NAV_LINK_TOKEN) && !el.querySelector(NAV_SELECTOR)
    );
    const named = links.find((link) => hasToken(link, NAV_CLASS_PREFIX));
    if (named) return named;
    return (
        links.find((link) => {
            const fragment = (getIconHref(link, 'misc_sprite') || '').split('#')[1] || '';
            return NAV_ICON_PATTERN.test(fragment);
        }) ?? null
    );
}

/**
 * The control that opens the panel on a phone: the header icon, else the navigation link, found by its icon's
 * sprite fragment or aria key.
 * @returns {Element|null} null when no control matches exactly: a guess is never pressed
 */
function findPanelToggle() {
    const header = document.querySelector(HEADER_SELECTOR);
    for (const control of header?.querySelectorAll('button, [role="button"]') ?? []) {
        const label = control.querySelector('svg')?.getAttribute('aria-label') || '';
        const fragment = (getIconHref(control, 'misc_sprite') || '').split('#')[1] || '';
        if (TOGGLE_ICON_PATTERN.test(label) || TOGGLE_ICON_PATTERN.test(fragment)) return control;
    }
    return findNavLink();
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
