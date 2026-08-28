/**
 * Shopping list
 *
 * A whole restock, as marketplace tabs.
 *
 * The Buy figure on a panel row sends one item to the marketplace, which is the
 * right gesture for topping up one thing. Restocking for a week is not that
 * gesture — it is six items, and doing it a row at a time means six trips back
 * to a panel that is behind the marketplace you are standing in.
 *
 * So the whole shortfall goes across at once, as the same "Missing: N" tabs the
 * missing-materials features put there. Each tab opens its item with the
 * quantity already filled in, and the row of tabs is the list: what is left to
 * buy is what is still red.
 *
 * ## Why this lives in utils rather than beside the panel that first wanted it
 *
 * It was `features/ui/consumables-shopping-list.js`, and then the goal planner
 * wanted the same hand-off. The planner is in the **actions** bundle and the
 * consumables panel is in the **ui** bundle, so rollup gave each of them its own
 * copy — and with it, its own `tabs` and `watchTimer`. Two lists opened inside
 * the six-second watch window then fought over the same tab bar: each copy's
 * interval saw tabs it had not built, tore them down and put its own back.
 *
 * The state below is module-level on purpose — there is one marketplace tab bar,
 * so there should be one list watching it. That is only true if there is one
 * module, which is what `Toolasha.Utils.shoppingList` in `rollup.config.js`
 * buys. The old path re-exports from here so nothing had to move to get it.
 *
 * ## There is more than one marketplace
 *
 * It opens as a popout over whatever you were doing, and the full marketplace
 * page keeps its own tab bar in the document behind it — so the tabs have to go
 * on the one being displayed rather than the one that comes first.
 * `visibleTabsContainer` handles that, and every feature that adds marketplace
 * tabs now goes through it.
 *
 * ## Reusing the missing-materials machinery
 *
 * Nothing here is new. `createMaterialTab` draws them, `createAutofillManager`
 * fills the quantity in, and `setupMarketplaceCleanupObserver` takes them away
 * when you leave — the same three pieces, given a different list. Which is the
 * point: a second implementation of marketplace tabs would be a second set of
 * bugs about where the game moved its tab bar.
 */

import webSocketHook from '../core/websocket.js';
import dataManager from '../core/data-manager.js';
import {
    createMaterialTab,
    removeMaterialTabs,
    setupMarketplaceCleanupObserver,
    navigateToMarketplace,
    visibleTabsContainer,
    updateTabBadge,
} from './marketplace-tabs.js';
import { createAutofillManager } from './marketplace-autofill.js';
import { unclaimedBoughtCount } from './material-calculator.js';

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

const autofill = createAutofillManager('Shopping-List');
let tabs = [];
let cleanupObserver = null;
let watchTimer = null;
let heading = '';
/** The open list, each with the holdings it opened against, so buys move the badges */
let watchedItems = [];
let inventoryHandler = null;

/**
 * What the character effectively holds of an item right now: the inventory,
 * plus units a buy order has bought that are still sitting unclaimed on the
 * listing. The second half is what makes a badge fall WHILE the order fills.
 * @param {string} itemHrid - Item
 * @returns {number} Units
 */
function ownedNow(itemHrid) {
    const inventory = dataManager.getInventory?.() || [];
    const held = inventory
        .filter((i) => i.itemHrid === itemHrid && !i.enhancementLevel)
        .reduce((sum, i) => sum + (i.count || 0), 0);
    return held + unclaimedBoughtCount(itemHrid);
}

/**
 * How many of one list line are still to buy: the original shortfall, less
 * whatever has been acquired since the list opened. Against a baseline rather
 * than recomputed from need, because the list's counts are the caller's bill
 * (a shortfall already netted, an estimate, a plan) — this module only knows
 * what changed since it was handed over.
 * @param {Object} item - A watched line
 * @returns {number} Remaining count
 */
function remainingFor(item) {
    const gained = ownedNow(item.itemHrid) - item.baseline;
    return Math.max(0, item.count - Math.max(0, gained));
}

/** Redraw every built tab's badge from what has been bought since the open */
function refreshTabBadges() {
    for (const tab of tabs) {
        const itemHrid = tab.getAttribute?.('data-item-hrid');
        if (!itemHrid) continue;
        const item = watchedItems.find((entry) => entry.itemHrid === itemHrid);
        if (!item) continue;
        const remaining = remainingFor(item);
        if (remaining === item.remaining) continue;
        item.remaining = remaining;
        updateTabBadge(tab, {
            itemHrid,
            itemName: item.name,
            missing: remaining,
            required: item.count,
            isTradeable: true,
        });
    }
}

function startInventoryWatch() {
    if (inventoryHandler) return;
    inventoryHandler = (data) => {
        if (
            data?.type?.includes('item') ||
            data?.type?.includes('inventory') ||
            data?.type?.includes('market') ||
            data?.endCharacterItems
        ) {
            refreshTabBadges();
        }
    };
    webSocketHook.on('*', inventoryHandler);
}

function stopInventoryWatch() {
    if (inventoryHandler) {
        webSocketHook.off('*', inventoryHandler);
        inventoryHandler = null;
    }
}

/**
 * Put a shopping list on the marketplace and go there.
 *
 * @param {Array<{itemHrid: string, name: string, count: number}>} items - What to buy
 * @param {Object} [options] - Options
 * @param {string} [options.heading] - What the row of tabs calls itself. The default counts
 *   the items; a caller whose counts are an estimate rather than a bill should say so here,
 *   because the marketplace is where somebody decides how many to actually buy.
 */
export function openShoppingList(items, { heading: headingText = '' } = {}) {
    const wanted = (items || []).filter((item) => item.itemHrid && item.count > 0);
    if (!wanted.length) return;

    // Idempotent since the observer leak was fixed: this used to register a
    // fresh DOM observer on every open and drop the previous unregister
    autofill.initialize?.();
    heading = headingText;

    // Each line remembers the holdings it opened against, so what is bought
    // from here on moves its badge — and only what is bought from here on:
    // the caller already netted (or chose not to net) what was held before
    watchedItems = wanted.map((item) => ({ ...item, baseline: ownedNow(item.itemHrid), remaining: item.count }));
    startInventoryWatch();

    // The first item opens the marketplace, and the tabs are put in behind it
    navigateToMarketplace(wanted[0].itemHrid, 0);
    autofill.setQuantity(wanted[0].count);
    watchForTabBar(watchedItems);
}

/** Take the tabs away, and stop watching for the marketplace to close */
export function clearShoppingList() {
    clearInterval(watchTimer);
    watchTimer = null;
    stopInventoryWatch();
    watchedItems = [];
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
        const container = visibleTabsContainer();
        const reference =
            container && Array.from(container.children).find((tab) => tab.textContent.includes('My Listings'));

        // Judged on the item tabs rather than on having run: the heading alone
        // is what a failed build leaves behind, and counting that as success is
        // what let one bad attempt stand until something else rebuilt the bar
        const built = tabs.filter((tab) => tab.hasAttribute('data-item-hrid'));
        const present = built.length === items.length && built.every((tab) => document.body.contains(tab));
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

    const title = document.createElement('div');
    // Marked as one of ours, or `removeMaterialTabs` leaves it behind and every
    // re-add stacks another heading beside the last
    title.setAttribute('data-mwi-custom-tab', 'true');
    title.textContent = heading || `Restock: ${items.length} item${items.length === 1 ? '' : 's'}`;
    Object.assign(title.style, {
        alignSelf: 'center',
        padding: '0 10px',
        color: '#7fd6a3',
        fontWeight: 'bold',
        fontSize: '1.2rem',
    });
    container.appendChild(title);
    tabs.push(title);

    for (const item of items) {
        // `itemName` rather than `name`: the tab helper reads that field, and
        // passing the wrong one threw on the first item, leaving the heading
        // standing alone above no tabs at all
        try {
            const tab = createMaterialTab(
                {
                    itemHrid: item.itemHrid,
                    itemName: item.name,
                    missing: item.remaining ?? item.count,
                    required: item.count,
                    isTradeable: true,
                },
                reference,
                handlerFor(item)
            );
            container.appendChild(tab);
            tabs.push(tab);
        } catch (error) {
            // One unbuildable tab must not cost the rest of the list. Logged
            // rather than swallowed, because a list that silently arrives short
            // is indistinguishable from one that had nothing to add.
            console.error(`[ShoppingList] Could not build a tab for ${item.itemHrid}:`, error);
        }
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
        // What is STILL missing, not the original bill — half-filled lines
        // arm the buy box with the half that is left
        autofill.setQuantity(item.remaining ?? item.count);
        navigateToMarketplace(item.itemHrid, 0);
    };
}
