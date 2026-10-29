/**
 * The Alchemy panel's tab strip, read without depending on the client language.
 *
 * Kept free of imports so any alchemy feature that draws into the strip can use it
 * without pulling the panel reader (and its data-manager) into its own tests.
 */

/**
 * The game's own alchemy tabs, by position. The tab elements carry no React props
 * or icons, and their labels are translated, so the position is the identity:
 * the game's tabs always come first in this order, and any tab after them
 * (Current Action, Best Items, Alchemy History...) is not an alchemy action.
 */
export const ALCHEMY_TAB_TYPES = ['coinify', 'decompose', 'transmute', 'unrefine'];

const ALCHEMY_TABS_SELECTOR = '[class*="AlchemyPanel_tabsComponentContainer"]';

/**
 * The alchemy panel's tab elements, in strip order.
 *
 * @param {ParentNode} [root=document] - Where to look for the tab strip
 * @returns {Element[]} The role=tab elements, or an empty array without a strip
 */
export function getAlchemyTabElements(root = document) {
    const tabContainer = root.querySelector?.(ALCHEMY_TABS_SELECTOR) || document.querySelector(ALCHEMY_TABS_SELECTOR);
    return tabContainer ? Array.from(tabContainer.querySelectorAll('[role="tab"]')) : [];
}

/**
 * Which alchemy tab is selected, from the panel's tab strip.
 *
 * Identified by the selected tab's position (`ALCHEMY_TAB_TYPES`), so it works in
 * any client language. The English label is only a fallback for a strip whose
 * tabs cannot be indexed.
 *
 * @param {ParentNode} [root=document] - Where to look for the tab strip
 * @returns {'coinify'|'decompose'|'transmute'|'unrefine'|null} The selected tab, or null
 */
export function readAlchemyTabType(root = document) {
    const tabs = getAlchemyTabElements(root);
    const index = tabs.findIndex((tab) => tab.getAttribute('aria-selected') === 'true');
    if (index >= 0) return ALCHEMY_TAB_TYPES[index] ?? null;

    const tabContainer = root.querySelector?.(ALCHEMY_TABS_SELECTOR) || document.querySelector(ALCHEMY_TABS_SELECTOR);
    const selectedTab = tabContainer?.querySelector('[role="tab"][aria-selected="true"]');
    const tabText = selectedTab?.textContent?.trim()?.toLowerCase() || '';
    if (tabText.includes('unrefine')) return 'unrefine';
    if (tabText.includes('coinify')) return 'coinify';
    if (tabText.includes('transmute')) return 'transmute';
    if (tabText.includes('decompose')) return 'decompose';
    return null;
}

/**
 * The strip's tablist element: the game's own, which holds the alchemy tabs.
 *
 * Found through the panel's tab container, so a tablist elsewhere on the page is never
 * mistaken for it and no tab label has to be matched. Null when the container is not on
 * screen; callers that still want a best guess then fall back to the first tablist.
 *
 * @param {ParentNode} [root=document] - Where to look for the container
 * @returns {Element|null} The tablist, or null without a container
 */
export function findAlchemyTablist(root = document) {
    const container = root.querySelector?.(ALCHEMY_TABS_SELECTOR) || document.querySelector(ALCHEMY_TABS_SELECTOR);
    if (!container) return null;
    if (container.matches?.('[role="tablist"]')) return container;
    return container.querySelector('[role="tablist"]') || container;
}
