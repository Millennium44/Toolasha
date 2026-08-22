/**
 * Ability Dictionary Button
 * Adds an "Open Item Dictionary" button to the ability action menu (the popup
 * shown when clicking an ability in the Abilities panel), opening the
 * dictionary entry for that ability's book item.
 *
 * The popup's class name is unknown and varies with game builds, so menus are
 * found purely by content: a container holding a "Link to Chat" button plus a
 * "Lv.N <Ability Name>" heading whose name resolves to a real ability. Item
 * action menus are left alone — they already have this button.
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

        // Class-agnostic: scan added subtrees for the popup's "Link to Chat"
        // button and work up to its menu container
        const unregister = domObserver.register('AbilityDictionaryButton', (node) => this._scan(node));
        this.unregisterHandlers.push(unregister);

        this._scan(document.body);

        // Right-click any ability icon — a slot in Abilities, Equipment or
        // Loadouts, a learned ability, the combat bar — to open its book in the
        // Item Dictionary without going through the popup. The icon is known
        // by its sprite: the game draws every ability off `abilities_sprite`
        // with the ability's slug as the fragment
        this._onContextMenu = (event) => {
            try {
                this._rightClick(event);
            } catch (error) {
                console.error('[AbilityDictionaryButton] Right-click handling failed:', error);
            }
        };
        document.addEventListener('contextmenu', this._onContextMenu, true);
        this.unregisterHandlers.push(() => document.removeEventListener('contextmenu', this._onContextMenu, true));
    }

    /**
     * The ability an element draws, from its sprite, or null.
     * @param {Element|null} target - Where the click landed
     * @returns {string|null} Ability hrid
     */
    static abilityAt(target) {
        // The click rarely lands on the <svg> itself: the game lays the level
        // label ("Lv.100") and the slot's own overlay over the icon. Walk up a
        // few ancestors and take the one ability sprite beneath — and stop at
        // the first ancestor holding several, which is the row, not an icon
        const isAbilityUse = (use) => {
            const href = use?.getAttribute('href') || use?.getAttribute('xlink:href') || '';
            return href.includes('abilities_sprite') ? href : null;
        };
        let node = target;
        for (let depth = 0; node && depth < 5; depth++) {
            const uses = Array.from(node.querySelectorAll?.('use') || []).filter(isAbilityUse);
            if (node.tagName === 'use' && isAbilityUse(node)) uses.unshift(node);
            if (uses.length > 1) return null;
            if (uses.length === 1) {
                const tail = isAbilityUse(uses[0]).split('#')[1];
                return tail ? `/abilities/${tail}` : null;
            }
            node = node.parentElement;
        }
        return null;
    }

    /**
     * Open the book of the ability under a right-click.
     * @param {MouseEvent} event
     * @private
     */
    _rightClick(event) {
        const abilityHrid = AbilityDictionaryButton.abilityAt(event.target);
        if (!abilityHrid) return;
        const bookHrid = abilityHrid.replace('/abilities/', '/items/');
        if (!dataManager.getItemDetails(bookHrid)?.abilityBookDetail) return;
        event.preventDefault();
        event.stopPropagation();
        if (!openItemDictionary(bookHrid)) {
            console.warn('[AbilityDictionaryButton] Could not open dictionary for', bookHrid);
        }
    }

    /**
     * Find ability menus inside an added subtree via their Link to Chat button.
     * @param {HTMLElement} root
     * @private
     */
    _scan(root) {
        if (!root || root.nodeType !== Node.ELEMENT_NODE) return;
        const buttons = [];
        if (root.tagName === 'BUTTON') buttons.push(root);
        if (root.childElementCount > 0) buttons.push(...root.querySelectorAll('button'));

        for (const btn of buttons) {
            if (btn.textContent.trim() !== 'Link to Chat') continue;
            // The menu is the nearest ancestor that also holds the "Lv.N" heading
            let menu = btn.parentElement;
            for (let depth = 0; menu && depth < 4; depth++) {
                if (/Lv\.\s*\d+/.test(menu.textContent || '')) break;
                menu = menu.parentElement;
            }
            if (menu) this._injectButton(menu, btn);
        }
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

        const match = (menu.textContent || '').match(/Lv\.\s*\d+\s*([^\n]+?)\s*(?:Link to Chat|$)/);
        if (!match) return null;
        return this._getAbilityNameMap().get(match[1].trim().toLowerCase()) || null;
    }

    /**
     * Inject the dictionary button into an ability action menu.
     * @param {HTMLElement} menu - Menu container
     * @param {HTMLElement} referenceBtn - The menu's Link to Chat button (style + anchor)
     * @private
     */
    _injectButton(menu, referenceBtn) {
        if (!menu || menu.querySelector(`.${BTN_CLASS}`)) return;

        const abilityHrid = this._findAbilityHrid(menu);
        if (!abilityHrid) return;

        // Ability books share the ability's slug: /abilities/puncture → /items/puncture
        const bookHrid = abilityHrid.replace('/abilities/', '/items/');
        if (!dataManager.getItemDetails(bookHrid)?.abilityBookDetail) return;

        const btn = document.createElement('button');
        btn.className = `${referenceBtn?.className || ''} ${BTN_CLASS}`.trim();
        btn.textContent = 'Open Item Dictionary';
        btn.style.cssText = 'cursor: pointer; width: 100%; margin-top: 4px;';
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!openItemDictionary(bookHrid)) {
                console.warn('[AbilityDictionaryButton] Could not open dictionary for', bookHrid);
            }
        });

        // Place directly under Link to Chat, at whatever depth it lives
        if (referenceBtn?.parentElement) {
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
        this._onContextMenu = null;
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
        try {
            abilityDictionaryButton.disable();
        } catch (error) {
            console.error('[Ability Dictionary Button] Disable failed part-way:', error);
        } finally {
            abilityDictionaryButton.isInitialized = false;
        }
    },
};
