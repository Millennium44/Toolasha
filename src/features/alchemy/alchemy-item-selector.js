/**
 * Alchemy Item Selector
 *
 * Finding the "Alchemize Item" picker, and reading what is in it.
 *
 * Harder than it sounds, and worth having one definition of. The page carries
 * several item selectors — the catalyst has one, the guild has one — and they
 * are the same component with the same class names, so anything that goes
 * looking for "the item menu" will find the wrong one sooner or later. The
 * label is what distinguishes them, and even that has to be read carefully:
 * the menu is sometimes portalled out of its owner's subtree, and labels are
 * left mounted in hidden tab panels after you navigate away.
 *
 * The finding logic here is the version the item dimming feature arrived at
 * against the live DOM; it lives here so there is only one of it.
 */

const MENU_SELECTOR = 'div[class*="ItemSelector_menu"]';
const LABEL_SELECTOR = 'div[class*="ItemSelector_label"]';
const TILE_SELECTOR = 'div[class*="Item_itemContainer"]';
const ALCHEMIZE_LABEL = 'Alchemize Item';

/** The alchemy tabs, in the order the game lists them */
export const ALCHEMY_ACTIONS = ['coinify', 'decompose', 'transmute', 'unrefine'];

/**
 * The open "Alchemize Item" menu, if one is open.
 * @returns {HTMLElement|null}
 */
export function findAlchemizeMenu() {
    for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
        // Scope to the selector that owns this menu: the nearest ancestor
        // carrying a label identifies the owner, and the catalyst and guild
        // selectors have labels of their own
        let owned = false;
        let ancestor = menu.parentElement;
        while (ancestor && ancestor !== document.body) {
            const label = ancestor.querySelector(LABEL_SELECTOR);
            if (label) {
                owned = true;
                if (label.textContent.trim() === ALCHEMIZE_LABEL) return menu;
                break;
            }
            ancestor = ancestor.parentElement;
        }
        if (owned) continue;

        // Portalled menu, with no owning selector above it: accept only while a
        // visible label exists. Labels left mounted in hidden tab panels must
        // not claim a menu that belongs to something else.
        for (const label of document.querySelectorAll(LABEL_SELECTOR)) {
            if (label.textContent.trim() === ALCHEMIZE_LABEL && !label.closest('[class*="TabPanel_hidden"]')) {
                return menu;
            }
        }
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
 * The item tiles in a menu, and the element they all sit in.
 *
 * The grid holds more than items — the "Remove" button shares it — so the tiles
 * are picked out rather than the grid's children being taken wholesale.
 *
 * @param {HTMLElement} menu - An item selector menu
 * @returns {{grid: HTMLElement|null, tiles: HTMLElement[]}}
 */
export function menuTiles(menu) {
    const all = Array.from(menu?.querySelectorAll(TILE_SELECTOR) || []);
    if (!all.length) return { grid: null, tiles: [] };

    const grid = all[0].parentElement;
    return { grid, tiles: all.filter((tile) => tile.parentElement === grid) };
}

/**
 * The item a tile stands for, from the sprite it draws.
 * @param {HTMLElement} tile - An item tile
 * @returns {string} Item hrid, or '' for a tile that is not an item
 */
export function tileItemHrid(tile) {
    const href = tile?.querySelector('use')?.getAttribute('href') || '';
    const name = href.split('#')[1];
    return name ? `/items/${name}` : '';
}
