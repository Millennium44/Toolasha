/**
 * Enhancement Item Selector
 *
 * Finding the "Enhance Item" picker on the enhancing panel, and reading what
 * is in it.
 *
 * The enhancing panel carries two item selectors that share the same
 * component and class names — the item to enhance, and the protection item —
 * and, as with alchemy's pickers, the open menu is **portalled**: rendered
 * outside the selector that owns it, so it cannot be identified by what it
 * sits inside.
 *
 * Unlike alchemy's catalyst selector, the protection selector does not name
 * itself with a label either, so the same "watch which selector was clicked"
 * approach from alchemy-item-selector.js is used here instead of a label
 * comparison.
 */

import { MENU_SELECTOR, TILE_SELECTOR, tileItemHrid, menuTiles } from '../../utils/item-selector-dom.js';

export { tileItemHrid, menuTiles };

/** The enhancing panel's own name for the slot the item to enhance goes in */
const PRIMARY_SELECTOR = '[class*="SkillActionDetail_upgradeItemSelectorInput"]';
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

    // Nothing to identify unless the enhance item slot is on the page
    if (!document.querySelector(PRIMARY_SELECTOR)) return null;

    for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
        // Not portalled after all: the structure answers it outright
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

    console.log(
        `[Toolasha] ${menus.length} item selector menu(s) open. ` +
            `findEnhanceItemMenu() ${found ? `matched menu ${menus.indexOf(found)}` : 'matched nothing'}; ` +
            `primary slot on page = ${!!document.querySelector(PRIMARY_SELECTOR)}; ` +
            `last selector clicked was the primary one = ${lastOpened.primary}.\n` +
            'Open the Enhance Item picker before running this — with no menu open there is nothing to find.'
    );
    if (rows.length) console.table(rows);

    return { menus: rows, matched: menus.indexOf(found), lastOpened };
}
