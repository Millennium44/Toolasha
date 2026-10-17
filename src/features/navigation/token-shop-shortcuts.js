/**
 * Token Shop Shortcuts
 * Adds a "View <shop>" button to the item action menu of every token (and guild credit) that has a
 * shop, like the game's own "View Cowbell Store" button on the Cowbell item.
 */

import domObserver from '../../core/dom-observer.js';
import { getItemHridFromIconHref, getItemHridFromName, getIconHref } from '../../utils/game-lookups.js';
import { getGameObject } from '../../utils/item-navigation.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

const BUTTON_CLASS = 'mwi-token-shop-button';
const TAB_POLL_MS = 50;
const TAB_POLL_ATTEMPTS = 40;

/**
 * Where each shop lives: the game's top-level nav target, plus the tab inside that page.
 *
 * NEEDS A LIVE CHECK. `tabIndex` is a position within the page's own tab bar (labels are localized,
 * so they cannot be matched), ported from upstream and not yet confirmed against this client:
 * dungeon 1, labyrinth 3, task 1, guild 4. A wrong index lands on a neighboring tab; a missing tab
 * leaves the player on the shop page's default tab. Every index lives here and nowhere else.
 */
const DESTINATIONS = {
    dungeon: {
        label: 'View Dungeon Shop',
        navTarget: 'shop',
        tabContainerClass: 'ShopPanel_tabsComponentContainer',
        tabIndex: 1,
    },
    labyrinth: {
        label: 'View Labyrinth Shop',
        navTarget: 'labyrinth',
        tabContainerClass: 'LabyrinthPanel_tabsComponentContainer',
        tabIndex: 3,
    },
    task: {
        label: 'View Task Shop',
        navTarget: 'tasks',
        tabContainerClass: 'TasksPanel_tabsComponentContainer',
        tabIndex: 1,
    },
    guild: {
        label: 'View Guild Shop',
        navTarget: 'guild',
        tabContainerClass: 'GuildPanel_tabsComponentContainer',
        tabIndex: 4,
    },
};

const TOKEN_SHOPS = {
    '/items/chimerical_token': DESTINATIONS.dungeon,
    '/items/sinister_token': DESTINATIONS.dungeon,
    '/items/enchanted_token': DESTINATIONS.dungeon,
    '/items/pirate_token': DESTINATIONS.dungeon,
    '/items/labyrinth_token': DESTINATIONS.labyrinth,
    '/items/task_token': DESTINATIONS.task,
    '/items/guild_token': DESTINATIONS.guild,
    '/items/blue_guild_credit': DESTINATIONS.guild,
    '/items/brown_guild_credit': DESTINATIONS.guild,
    '/items/gold_guild_credit': DESTINATIONS.guild,
    '/items/green_guild_credit': DESTINATIONS.guild,
    '/items/purple_guild_credit': DESTINATIONS.guild,
    '/items/red_guild_credit': DESTINATIONS.guild,
    '/items/silver_guild_credit': DESTINATIONS.guild,
    '/items/white_guild_credit': DESTINATIONS.guild,
};

/**
 * @param {string} itemHrid
 * @returns {{label: string, navTarget: string, tabContainerClass: string, tabIndex: number}|null}
 */
export function getShopDestination(itemHrid) {
    return TOKEN_SHOPS[itemHrid] || null;
}

class TokenShopShortcuts {
    constructor() {
        this.unregisterHandlers = [];
        this.isInitialized = false;
        this.timerRegistry = createTimerRegistry();
        this.tabPoll = null;
    }

    initialize() {
        if (this.isInitialized) return;
        this.isInitialized = true;

        const unregister = domObserver.onClass('TokenShopShortcuts', 'Item_actionMenu', (actionMenu) => {
            this.injectButton(actionMenu);
        });
        this.unregisterHandlers.push(unregister);
    }

    /**
     * @param {HTMLElement} actionMenu - The Item_actionMenu element
     */
    injectButton(actionMenu) {
        if (!this.isInitialized) return;
        if (actionMenu.querySelector(`.${BUTTON_CLASS}`)) return;

        const nameEl = actionMenu.querySelector('[class*="Item_name"]');
        if (!nameEl) return;

        // The popup's own icon sprite is locale-independent; the translated name is the fallback.
        const itemHrid =
            getItemHridFromIconHref(getIconHref(actionMenu, 'items_sprite')) ||
            getItemHridFromName(nameEl.textContent.trim());
        const destination = itemHrid ? getShopDestination(itemHrid) : null;
        if (!destination) return;

        const button = document.createElement('button');
        button.textContent = destination.label;
        const existingButton = actionMenu.querySelector('button');
        if (existingButton) button.className = existingButton.className;
        button.classList.add(BUTTON_CLASS);

        button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.goToShop(destination);
        });

        // Sit above the native buttons, like the game's own Cowbell shop button
        if (existingButton) {
            actionMenu.insertBefore(button, existingButton);
        } else {
            actionMenu.appendChild(button);
        }
    }

    /**
     * Navigate to the shop's page, then select its tab once the page's tab bar has mounted.
     * If the tab never appears (or the nav method is gone) the player is left on the shop page's
     * default tab, or where they were.
     * @param {{navTarget: string, tabContainerClass: string, tabIndex: number}} destination
     */
    goToShop(destination) {
        const game = getGameObject();
        if (!game || typeof game.handleGoToNavTarget !== 'function') {
            console.warn('[TokenShopShortcuts] Game navigation is unavailable');
            return;
        }
        game.handleGoToNavTarget(destination.navTarget);

        // A second press supersedes the first poll
        if (this.tabPoll) clearInterval(this.tabPoll);
        let attempts = 0;
        const interval = setInterval(() => {
            attempts++;
            const tabs = document.querySelectorAll(`[class*="${destination.tabContainerClass}"] button[role="tab"]`);
            const tab = tabs[destination.tabIndex];
            if (tab) {
                clearInterval(interval);
                if (this.tabPoll === interval) this.tabPoll = null;
                if (!tab.matches('[aria-selected="true"]')) tab.click();
            } else if (attempts >= TAB_POLL_ATTEMPTS) {
                clearInterval(interval);
                if (this.tabPoll === interval) this.tabPoll = null;
            }
        }, TAB_POLL_MS);
        this.tabPoll = interval;
        this.timerRegistry.registerInterval(interval);
    }

    cleanup() {
        this.timerRegistry.clearAll();
        this.tabPoll = null;
        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        this.isInitialized = false;
    }
}

const tokenShopShortcuts = new TokenShopShortcuts();

export default {
    name: 'Token Shop Shortcuts',
    initialize: () => tokenShopShortcuts.initialize(),
    cleanup: () => tokenShopShortcuts.cleanup(),
};
export { TokenShopShortcuts };
