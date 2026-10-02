/**
 * Getting to the Tester shop, and narrowing it to one item.
 *
 * The DOM half of `tester-shop.js`: that module prices against the shop, this
 * one walks there. Several surfaces need the same walk — the missing-materials
 * bill and the Item Dictionary's ability-book panel to the Tester tab, the
 * dungeon-token spend planner to the Dungeon tab — so it lives here rather than
 * as a copy in each.
 *
 * Nothing here buys anything. The walk ends with the shop filtered to the item
 * and (the caller's job) a quantity armed; the player presses Buy. One click,
 * one game action is the rule, and a helper that clicked a shop card for you
 * would break it.
 */

import { createTimerRegistry } from './timer-registry.js';
import { setReactInputValue } from './react-input.js';

const timerRegistry = createTimerRegistry();

/** Resolve after `ms`, through the registry so a teardown cancels it */
function wait(ms) {
    return new Promise((resolve) => {
        timerRegistry.scheduleTimeout(resolve, ms);
    });
}

/**
 * A Shop tab by its label, when its strip is on screen.
 * @param {RegExp} label - Matches the tab's whole text, e.g. `/^\s*tester\s*$/i`
 * @returns {HTMLElement|null}
 */
export function findShopTab(label) {
    // Inside the Shop panel only: other panels (Combat) have their own "Dungeon" tab
    for (const container of document.querySelectorAll('[class*="ShopPanel"] .MuiTabs-flexContainer[role="tablist"]')) {
        if (container.offsetParent === null) continue;
        const tab = Array.from(container.children).find((el) => label.test(el.textContent || ''));
        if (tab) return tab;
    }
    return null;
}

/**
 * The Shop's Tester tab, when its strip is on screen.
 * @returns {HTMLElement|null}
 */
export function findTesterTab() {
    return findShopTab(/^\s*tester\s*$/i);
}

/**
 * Type a name into the shop's item filter, when the box is on screen.
 * @param {string} itemName - The item, as the shop names it
 * @returns {boolean} Whether a filter box was there to type into
 */
export function setShopFilter(itemName) {
    // The Shop's own filter only. Its Dungeon tab hides that box, and the first
    // visible "Item Filter" on the page is then the inventory's (measured on the
    // test server) — typing the item there filtered the wrong panel.
    const input = Array.from(document.querySelectorAll('[class*="ShopPanel_"] input')).find(
        (el) => el.offsetParent !== null && /filter/i.test(el.placeholder || '')
    );
    if (input) setReactInputValue(input, itemName || '');
    return Boolean(input);
}

/**
 * Open the Shop on one of its tabs.
 *
 * The shop's nav entry, then the tab whose text matches. Each step that cannot
 * be found is logged and reported as a failure, so the caller can fall back
 * rather than leave the player nowhere.
 *
 * @param {RegExp} label - Matches the tab's whole text
 * @param {() => boolean} [isCancelled] - Checked before every step that touches the
 *   game (the initial nav click, and again before the tab click). A stale caller —
 *   the character switched, or the feature was disabled — while this was waiting for
 *   the tab strip to appear must not go on to click a tab for whoever is here now.
 *   Defaults to never cancelling.
 * @returns {Promise<HTMLElement|null>} The tab once selected, else null
 */
export async function openShopTab(label, isCancelled = () => false) {
    if (isCancelled()) return null;

    const navButtons = document.querySelectorAll('.NavigationBar_nav__3uuUl');
    const shopButton = Array.from(navButtons).find((nav) => nav.querySelector('svg[aria-label="navigationBar.shop"]'));
    if (!shopButton) {
        console.error('[TesterShopNav] Shop navbar button not found');
        return null;
    }
    shopButton.click();

    for (let i = 0; i < 30; i++) {
        await wait(100);
        if (isCancelled()) return null;
        const tab = findShopTab(label);
        if (tab) {
            if (isCancelled()) return null;
            tab.click();
            await wait(150);
            return tab;
        }
    }
    console.error(`[TesterShopNav] Shop tab ${label} not found`);
    return null;
}

/**
 * Open the Shop on its Tester tab.
 * @param {() => boolean} [isCancelled] - See {@link openShopTab}
 * @returns {Promise<HTMLElement|null>} The Tester tab once selected, else null
 */
export async function openTesterShopPage(isCancelled = () => false) {
    return openShopTab(/^\s*tester\s*$/i, isCancelled);
}

export default { findShopTab, findTesterTab, setShopFilter, openShopTab, openTesterShopPage };
