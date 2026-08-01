/**
 * Consumables shopping list
 *
 * The whole restock, as marketplace tabs.
 *
 * The Buy figure on each row sends one item to the marketplace, which is the
 * right gesture for topping up one thing. Restocking for a week is not that
 * gesture — it is six items, and doing it a row at a time means six trips back
 * to a panel that is behind the marketplace you are standing in.
 *
 * So the whole shortfall goes across at once, as the same "Missing: N" tabs the
 * missing-materials features put there. Each tab opens its item with the
 * quantity already filled in, and the row of tabs is the list: what is left to
 * buy is what is still red.
 *
 * ## Reusing the missing-materials machinery
 *
 * Nothing here is new. `createMaterialTab` draws them, `createAutofillManager`
 * fills the quantity in, and `setupMarketplaceCleanupObserver` takes them away
 * when you leave — the same three pieces, given a different list. Which is the
 * point: a second implementation of marketplace tabs would be a second set of
 * bugs about where the game moved its tab bar.
 */

import {
    createMaterialTab,
    removeMaterialTabs,
    setupMarketplaceCleanupObserver,
    navigateToMarketplace,
} from '../../utils/marketplace-tabs.js';
import { createAutofillManager } from '../../utils/marketplace-autofill.js';

/**
 * How long to keep putting the tabs back.
 *
 * Not just how long to wait for the tab bar — the bar is frequently already
 * there from a previous visit, so the tabs go in immediately and are then wiped
 * when React re-renders the marketplace for the item being navigated to. So the
 * check keeps running for a few seconds and re-adds them whenever they have
 * gone, which survives however many times the panel rebuilds itself.
 */
const WATCH_MS = 6000;
const WATCH_INTERVAL_MS = 150;

const autofill = createAutofillManager('Consumables-Shopping');
let tabs = [];
let cleanupObserver = null;
let watchTimer = null;

/**
 * Put a shopping list on the marketplace and go there.
 *
 * @param {Array<{itemHrid: string, name: string, count: number}>} items - What to buy
 */
export function openShoppingList(items) {
    const wanted = (items || []).filter((item) => item.itemHrid && item.count > 0);
    if (!wanted.length) return;

    autofill.initialize?.();

    // The first item opens the marketplace, and the tabs are put in behind it
    navigateToMarketplace(wanted[0].itemHrid, 0);
    autofill.setQuantity(wanted[0].count);
    watchForTabBar(wanted);
}

/** Take the tabs away, and stop watching for the marketplace to close */
export function clearShoppingList() {
    clearInterval(watchTimer);
    watchTimer = null;
    removeMaterialTabs();
    tabs = [];
    cleanupObserver?.();
    cleanupObserver = null;
    autofill.clearQuantity?.();
}

/**
 * Keep the tabs on the marketplace while it settles.
 *
 * React rebuilds the marketplace panel when it navigates to an item, and a tab
 * added a moment before that rebuild is gone a moment after it — which is why
 * adding them once, immediately, put them nowhere. This re-adds them whenever
 * they are missing, for long enough to outlast the rebuilds.
 *
 * @param {Array<Object>} items - What to buy
 */
function watchForTabBar(items) {
    clearInterval(watchTimer);
    const until = Date.now() + WATCH_MS;

    watchTimer = setInterval(() => {
        const container = document.querySelector('.MuiTabs-flexContainer[role="tablist"]');
        const reference =
            container && Array.from(container.children).find((tab) => tab.textContent.includes('My Listings'));

        // Still ours and still on screen: nothing to do
        const present = tabs.length && tabs.every((tab) => document.body.contains(tab));
        if (reference && !present) addTabs(container, reference, items);

        if (Date.now() > until) {
            clearInterval(watchTimer);
            watchTimer = null;
        }
    }, WATCH_INTERVAL_MS);
}

/**
 * @param {HTMLElement} container - The game's tab bar
 * @param {HTMLElement} reference - A tab to clone the structure from
 * @param {Array<Object>} items - What to buy
 */
function addTabs(container, reference, items) {
    removeMaterialTabs();
    tabs = [];

    // Several tabs will not fit on one line, and the game's bar does not wrap
    // on its own
    container.style.flexWrap = 'wrap';

    const heading = document.createElement('div');
    heading.textContent = `Restock: ${items.length} item${items.length === 1 ? '' : 's'}`;
    Object.assign(heading.style, {
        alignSelf: 'center',
        padding: '0 10px',
        color: '#7fd6a3',
        fontWeight: 'bold',
        fontSize: '1.2rem',
    });
    container.appendChild(heading);
    tabs.push(heading);

    for (const item of items) {
        const tab = createMaterialTab(
            {
                itemHrid: item.itemHrid,
                name: item.name,
                missing: item.count,
                needed: item.count,
                available: 0,
                isTradeable: true,
            },
            reference,
            handlerFor(item)
        );
        container.appendChild(tab);
        tabs.push(tab);
    }

    cleanupObserver?.();
    cleanupObserver = setupMarketplaceCleanupObserver(clearShoppingList, tabs);
}

/**
 * The click handler for one tab.
 *
 * Built outside the loop so the item it closes over is the tab's own, rather
 * than whichever the loop finished on.
 *
 * @param {Object} item - What that tab buys
 * @returns {Function}
 */
function handlerFor(item) {
    return () => {
        autofill.setQuantity(item.count);
        navigateToMarketplace(item.itemHrid, 0);
    };
}
