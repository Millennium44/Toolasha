/**
 * Alchemy Item Selector
 *
 * Finding the "Alchemize Item" picker, and reading what is in it.
 *
 * Harder than it sounds, and worth having one definition of. The page carries
 * more than one item selector — the alchemized item has one, the catalyst has
 * another — and they are the same component with the same class names. Worse,
 * the menu is **portalled**: it is rendered outside the selector that owns it,
 * so it cannot be identified by what it sits inside.
 *
 * Two earlier attempts failed here and are worth recording, because both looked
 * right:
 *
 * - Matching a label reading "Alchemize Item". There is no such label — the
 *   alchemized-item slot is unlabelled, and only the catalyst names itself
 *   ("Consumed Item").
 * - Walking up from the menu for the nearest `ItemSelector_label`. The menu's
 *   own "Remove" tile carries that class, so the search found the menu's own
 *   contents and concluded the selector was called "Remove".
 *
 * What does work is watching which selector was clicked. A menu opens because
 * something was clicked, and the thing clicked is in the DOM where it belongs
 * whatever the menu does afterwards.
 */

import { MENU_SELECTOR, TILE_SELECTOR, tileItemHrid, menuTiles } from '../../utils/item-selector-dom.js';

export { tileItemHrid, menuTiles };

const LABEL_SELECTOR = 'div[class*="ItemSelector_label"]';
/** The action panel's own name for the slot the alchemized item goes in */
const PRIMARY_SELECTOR = '[class*="SkillActionDetail_primaryItemSelectorContainer"]';
/** The one selector on the panel that does name itself */
const CATALYST_LABEL = 'Consumed Item';

/** The alchemy tabs, in the order the game lists them */
export const ALCHEMY_ACTIONS = ['coinify', 'decompose', 'transmute', 'unrefine'];

/** Which selector was opened last, since the menu itself will not say */
let lastOpened = { primary: false, at: 0 };
let tracking = false;

/**
 * Start remembering which item selector gets clicked.
 *
 * Installed on first use rather than by a caller, so that every reader of this
 * module gets it without having to know it exists. Capture phase, because the
 * game stops the event on its way back up.
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

            const primary = !!target.closest(PRIMARY_SELECTOR);
            if (primary || target.closest('[class*="ItemSelector"]')) {
                lastOpened = { primary, at: Date.now() };
            }
        },
        true
    );
}

/**
 * The label of the selector that owns a menu, ignoring the menu's own contents.
 *
 * The "Remove" tile inside every menu carries the label class, so a plain
 * subtree search finds it and reports the menu as being called "Remove".
 *
 * @param {HTMLElement} menu - An item selector menu
 * @returns {string} Label text, or '' when the menu is portalled away from one
 */
function ownerLabel(menu) {
    let ancestor = menu.parentElement;
    while (ancestor && ancestor !== document.body) {
        for (const label of ancestor.querySelectorAll(LABEL_SELECTOR)) {
            if (!menu.contains(label)) return label.textContent.trim();
        }
        ancestor = ancestor.parentElement;
    }
    return '';
}

/**
 * The open "Alchemize Item" menu, if one is open.
 * @returns {HTMLElement|null}
 */
export function findAlchemizeMenu() {
    trackSelectorClicks();

    // Nothing to identify unless the alchemy panel is up
    if (!document.querySelector(PRIMARY_SELECTOR) || !activeAlchemyAction()) return null;

    for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
        // Not portalled after all: the structure answers it outright
        if (menu.closest(PRIMARY_SELECTOR)) return menu;
        // The catalyst is the one selector that names itself
        if (ownerLabel(menu) === CATALYST_LABEL) continue;
        if (lastOpened.primary) return menu;
    }
    return null;
}

/**
 * Which alchemy action the page is showing.
 *
 * Read off the selected tab rather than tracked, because the tab bar is the
 * only thing that knows — the item menu looks identical whichever action is
 * open, and the same item means different things in each.
 *
 * @returns {string} One of ALCHEMY_ACTIONS, or '' on a tab that is none of them
 */
export function activeAlchemyAction() {
    for (const tablist of document.querySelectorAll('[role="tablist"]')) {
        const tabs = Array.from(tablist.children);
        if (!tabs.some((tab) => tab.textContent.includes('Coinify'))) continue;

        const selected = tabs.find(
            (tab) => tab.getAttribute('aria-selected') === 'true' || tab.classList.contains('Mui-selected')
        );
        const text = (selected?.textContent || '').toLowerCase();
        return ALCHEMY_ACTIONS.find((action) => text.includes(action)) || '';
    }
    return '';
}

/**
 * Report what is on the page and which of it this module can see.
 *
 * Everything here hangs off recognising one menu among several identical ones,
 * and when that recognition fails the feature does not break loudly — it simply
 * does nothing, which is indistinguishable from not being installed. This says
 * which step failed, and dumps the menu's ancestry so a wrong answer can be
 * corrected rather than guessed at again.
 *
 * Console: open the alchemy item picker, then `Toolasha.Debug.alchemyMenu()`
 * @returns {Object} What was found
 */
export function describeAlchemyMenus() {
    const menus = Array.from(document.querySelectorAll(MENU_SELECTOR));
    const found = findAlchemizeMenu();

    const rows = menus.map((menu, index) => {
        const chain = [];
        let ancestor = menu.parentElement;
        while (ancestor && ancestor !== document.body && chain.length < 8) {
            const cls = typeof ancestor.className === 'string' ? ancestor.className : '';
            chain.push(`${ancestor.tagName.toLowerCase()}.${cls.split(' ')[0] || '(no class)'}`);
            ancestor = ancestor.parentElement;
        }
        const { grid, tiles } = menuTiles(menu);
        const raw = menu.querySelectorAll(TILE_SELECTOR).length;
        const parents = new Set(Array.from(menu.querySelectorAll(TILE_SELECTOR)).map((el) => el.parentElement)).size;
        return {
            menu: index,
            matched: menu === found,
            insidePrimarySlot: !!menu.closest(PRIMARY_SELECTOR),
            ownerLabel: ownerLabel(menu) || '(none)',
            // rawTiles well above movable means each tile is wrapped; the two
            // being equal means they are siblings in one grid
            rawTiles: raw,
            distinctTileParents: parents,
            movable: tiles.length,
            grid: grid ? `${grid.tagName.toLowerCase()}.${(grid.className || '').split(' ')[0]}` : '(none)',
            ancestors: chain.join(' < ') || '(portalled to body)',
        };
    });

    const labels = Array.from(document.querySelectorAll(LABEL_SELECTOR)).map((el) => el.textContent.trim());
    console.log(
        `[Toolasha] ${menus.length} item selector menu(s) open. ` +
            `findAlchemizeMenu() ${found ? `matched menu ${menus.indexOf(found)}` : 'matched nothing'}; ` +
            `activeAlchemyAction() = ${activeAlchemyAction() || '(none)'}; ` +
            `primary slot on page = ${!!document.querySelector(PRIMARY_SELECTOR)}; ` +
            `last selector clicked was the primary one = ${lastOpened.primary}.\n` +
            `Every ItemSelector label on the page: ${labels.length ? labels.join(' | ') : '(none)'}\n` +
            'Open the Alchemize Item picker before running this — with no menu open there is nothing to find.'
    );
    if (rows.length) console.table(rows);

    return { menus: rows, matched: menus.indexOf(found), action: activeAlchemyAction(), labels, lastOpened };
}
