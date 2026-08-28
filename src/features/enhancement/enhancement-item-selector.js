/**
 * Enhancement Item Selector
 *
 * Finding the "Enhance Item" picker on the enhancing panel, and reading what
 * is in it.
 *
 * The container this module first looked for —
 * `SkillActionDetail_upgradeItemSelectorInput` — does not exist. Live-DOM
 * inspection on the test server found the item-to-enhance slot wrapped in
 * `SkillActionDetail_primaryItemSelectorContainer`, the exact same class
 * alchemy's own primary slot uses (`alchemy-item-selector.js`). The two
 * panels are never open at once, so the shared name is harmless as long as a
 * caller also confirms the enhancing panel itself
 * (`SkillActionDetail_enhancing…`) is what is on screen — otherwise this
 * module would just as happily answer for alchemy's slot.
 *
 * The open menu is **portalled** further than alchemy's ever is: it does not
 * even land inside the `SkillActionDetail` panel, only under a detached MUI
 * tooltip popper at the document root (`ItemSelector_menu` > `MuiTooltip-*`
 * > `MuiPopper-root` > unclassed). So unlike alchemy, where the menu is
 * sometimes still contained in its owning slot, here it never is — the
 * "watch which selector was clicked" fallback from alchemy-item-selector.js
 * is not a fallback here, it is the only mechanism that works. The
 * protection item selector does not name itself with a label either
 * (alchemy's catalyst selector at least has one), so this uses the same
 * click-tracking approach rather than a label comparison.
 */

import { MENU_SELECTOR, TILE_SELECTOR, tileItemHrid, menuTiles } from '../../utils/item-selector-dom.js';

export { tileItemHrid, menuTiles };

/** The enhancing panel itself, so the shared PRIMARY_SELECTOR class below is never read as alchemy's */
const ENHANCING_PANEL_SELECTOR = '[class*="SkillActionDetail_enhancing"]';
/** The slot the item to enhance goes in — the same class alchemy's primary slot uses */
const PRIMARY_SELECTOR = '[class*="SkillActionDetail_primaryItemSelectorContainer"]';
/** The other item selector on the same panel, which must never be mistaken for the primary one */
const PROTECTION_SELECTOR = '[class*="protectionItemInputContainer"]';

/** Only one bucket: the enhance picker has no tabs to keep separate lists for */
export const ENHANCE_BUCKET = 'enhance';

/** Which selector was opened last, since the menu itself will not say */
let lastOpened = { primary: false, at: 0 };
let tracking = false;

/**
 * Start remembering which item selector gets clicked.
 *
 * Installed on first use rather than by a caller, so that every reader of
 * this module gets it without having to know it exists. Capture phase,
 * because the game stops the event on its way back up.
 */
function trackSelectorClicks() {
    if (tracking || typeof document === 'undefined') return;
    tracking = true;

    document.addEventListener(
        'click',
        (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            // A click inside an open menu is picking an item, not opening a
            // selector, and must not overwrite which selector we are in
            if (target.closest(MENU_SELECTOR)) return;

            if (target.closest(PROTECTION_SELECTOR)) {
                lastOpened = { primary: false, at: Date.now() };
                return;
            }
            const primary = !!target.closest(PRIMARY_SELECTOR);
            if (primary || target.closest('[class*="ItemSelector"]')) {
                lastOpened = { primary, at: Date.now() };
            }
        },
        true
    );
}

/**
 * The open "Enhance Item" menu, if one is open.
 * @returns {HTMLElement|null}
 */
export function findEnhanceItemMenu() {
    trackSelectorClicks();

    // Nothing to identify unless the enhancing panel is actually up — the
    // slot's own class is shared with alchemy's primary slot, so this gate is
    // what keeps the two apart
    const panel = document.querySelector(ENHANCING_PANEL_SELECTOR);
    if (!panel || !panel.querySelector(PRIMARY_SELECTOR)) return null;

    for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
        // Kept in case a future layout nests the menu after all; today the
        // menu is portalled to a detached tooltip popper and never matches
        if (menu.closest(PRIMARY_SELECTOR)) return menu;
        // Never claim the protection item's own menu
        if (menu.closest(PROTECTION_SELECTOR)) continue;
        if (lastOpened.primary) return menu;
    }
    return null;
}

/**
 * Report what is on the page and which of it this module can see.
 *
 * Console: open the Enhance Item picker, then `Toolasha.Debug.enhanceMenu()`
 * @returns {Object} What was found
 */
export function describeEnhanceMenus() {
    const menus = Array.from(document.querySelectorAll(MENU_SELECTOR));
    const found = findEnhanceItemMenu();

    const rows = menus.map((menu, index) => {
        const { grid, tiles } = menuTiles(menu);
        const raw = menu.querySelectorAll(TILE_SELECTOR).length;
        return {
            menu: index,
            matched: menu === found,
            insidePrimarySlot: !!menu.closest(PRIMARY_SELECTOR),
            insideProtectionSlot: !!menu.closest(PROTECTION_SELECTOR),
            rawTiles: raw,
            movable: tiles.length,
            grid: grid ? `${grid.tagName.toLowerCase()}.${(grid.className || '').split(' ')[0]}` : '(none)',
        };
    });

    const panel = document.querySelector(ENHANCING_PANEL_SELECTOR);
    console.log(
        `[Toolasha] ${menus.length} item selector menu(s) open. ` +
            `findEnhanceItemMenu() ${found ? `matched menu ${menus.indexOf(found)}` : 'matched nothing'}; ` +
            `enhancing panel on page = ${!!panel}; ` +
            `primary slot inside it = ${!!panel?.querySelector(PRIMARY_SELECTOR)}; ` +
            `last selector clicked was the primary one = ${lastOpened.primary}.\n` +
            'Open the Enhance Item picker before running this — with no menu open there is nothing to find.'
    );
    if (rows.length) console.table(rows);

    return { menus: rows, matched: menus.indexOf(found), lastOpened };
}
