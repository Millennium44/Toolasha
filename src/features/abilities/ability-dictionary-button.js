/**
 * Ability Dictionary Button
 * Adds an "Open Item Dictionary" button to the ability action menu (the popup
 * shown when clicking an ability in the Abilities panel), opening the
 * dictionary entry for that ability's book item.
 *
 * The menu's class name isn't known ahead of time, so menus are matched by
 * content: a "Lv.N <Ability Name>" heading whose name resolves to a real
 * ability. Item action menus are left alone — they already have this button.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { openItemDictionary } from '../../utils/item-navigation.js';

const BTN_CLASS = 'mwi-ability-dictionary-btn';

class AbilityDictionaryButton {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this._abilityNameToHrid = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('abilities_dictionaryButton')) return;
        this.isInitialized = true;

        const unregister = domObserver.onClass('AbilityDictionaryButton', 'actionMenu', (menu) =>
            this._injectButton(menu)
        );
        this.unregisterHandlers.push(unregister);

        document.querySelectorAll('[class*="actionMenu"]').forEach((menu) => this._injectButton(menu));
    }

    /**
     * Lazy ability-name → hrid lookup built from game data.
     * @returns {Map<string, string>}
     * @private
     */
    _getAbilityNameMap() {
        if (this._abilityNameToHrid) return this._abilityNameToHrid;
        const map = new Map();
        const abilityMap = dataManager.getInitClientData()?.abilityDetailMap || {};
        for (const [hrid, details] of Object.entries(abilityMap)) {
            if (details?.name) map.set(details.name.toLowerCase(), hrid);
        }
        // Only cache once game data is actually loaded
        if (map.size > 0) this._abilityNameToHrid = map;
        return map;
    }

    /**
     * Resolve the ability an action menu belongs to via its "Lv.N Name" heading.
     * @param {HTMLElement} menu
     * @returns {string|null} Ability HRID
     * @private
     */
    _findAbilityHrid(menu) {
        // Item menus carry an item name node — never treat those as abilities
        if (menu.querySelector('[class*="Item_name"]')) return null;

        const match = (menu.textContent || '').match(/Lv\.\s*\d+\s+([^\n]+?)\s*(?:Link to Chat|$)/);
        if (!match) return null;
        return this._getAbilityNameMap().get(match[1].trim().toLowerCase()) || null;
    }

    /**
     * Inject the dictionary button into an ability action menu.
     * @param {HTMLElement} menu
     * @private
     */
    _injectButton(menu) {
        if (!menu || menu.querySelector(`.${BTN_CLASS}`)) return;

        const abilityHrid = this._findAbilityHrid(menu);
        if (!abilityHrid) return;

        // Ability books share the ability's slug: /abilities/puncture → /items/puncture
        const bookHrid = abilityHrid.replace('/abilities/', '/items/');
        if (!dataManager.getItemDetails(bookHrid)) return;

        // Match the game's own menu buttons (e.g. Link to Chat)
        const referenceBtn = menu.querySelector('button');
        const btn = document.createElement('button');
        btn.className = `${referenceBtn?.className || ''} ${BTN_CLASS}`.trim();
        btn.textContent = 'Open Item Dictionary';
        btn.style.cssText = 'cursor: pointer; width: 100%;';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!openItemDictionary(bookHrid)) {
                console.warn('[AbilityDictionaryButton] Could not open dictionary for', bookHrid);
            }
        });

        if (referenceBtn) {
            referenceBtn.insertAdjacentElement('afterend', btn);
        } else {
            menu.appendChild(btn);
        }
    }

    disable() {
        for (const unregister of this.unregisterHandlers) {
            unregister();
        }
        this.unregisterHandlers = [];
        document.querySelectorAll(`.${BTN_CLASS}`).forEach((btn) => btn.remove());
        this._abilityNameToHrid = null;
        this.isInitialized = false;
    }
}

const abilityDictionaryButton = new AbilityDictionaryButton();

export default {
    name: 'Ability Dictionary Button',
    initialize: () => {
        abilityDictionaryButton.initialize();
    },
    cleanup: () => {
        abilityDictionaryButton.disable();
    },
    disable: () => {
        abilityDictionaryButton.disable();
    },
};
