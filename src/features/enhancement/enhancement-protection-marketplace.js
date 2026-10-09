/**
 * Enhancement Protection Marketplace Button
 * Adds a "Buy Cheapest" button to the Protection item selector popup in the Enhancing panel. It
 * opens the Marketplace on the cheapest protection option (the item itself, Mirror of
 * Protection, or a specific protection item), ranked by the live market ask (an option with no ask on the book is not offered).
 *
 * The picker's menu is portalled out of the protection slot, so the menu cannot say which picker
 * it belongs to. A capture-phase document click listener remembers whether the last click opened
 * the protection slot (the same approach enhancement-item-selector.js uses for the primary slot),
 * and the shared `ItemSelector_menu` observer injects the button only into a menu that opened
 * right after such a click. Opening the Marketplace is navigation, not a game spend.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { MENU_SELECTOR } from '../../utils/item-selector-dom.js';
import { getItemPriceInfo } from '../../utils/market-data.js';

const PROTECTION_SELECTOR = '[class*="protectionItemInputContainer"]';
const ENHANCING_PANEL_SELECTOR = '[class*="SkillActionDetail_enhancing"]';
/** How long after a protection-slot click a new menu is still taken to be its picker */
const MENU_WINDOW_MS = 2000;
const BUTTON_CLASS = 'mwi-protection-marketplace-button';
const MARK_ATTR = 'data-mwi-prot-mkt-button';

/**
 * The protection option with the lowest live ask. Unlike the shared cheapest-protection estimate
 * this never falls back to production cost, the bid or a value-map figure: the button sends the
 * player to buy, so only a price they can actually pay counts.
 * @param {string} itemHrid - The item being enhanced
 * @returns {{price: number, itemHrid: string}|null} Null when no option has an ask
 */
function cheapestListedProtection(itemHrid) {
    const options = [
        itemHrid,
        '/items/mirror_of_protection',
        ...(dataManager.getItemDetails(itemHrid)?.protectionItemHrids ?? []),
    ];
    let best = null;
    for (const hrid of new Set(options)) {
        const { price, source } = getItemPriceInfo(hrid, { mode: 'ask', side: 'buy', marketQuote: true });
        if (source !== 'book' || !(price > 0)) continue;
        if (!best || price < best.price) best = { price, itemHrid: hrid };
    }
    return best;
}

class EnhancementProtectionMarketplace {
    constructor() {
        this.isInitialized = false;
        this.unregisterMenuObserver = null;
        this.clickHandler = null;
        this.lastProtectionClick = null;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('enhanceSim_protectionMarketplaceButton')) return;

        this.isInitialized = true;

        // Capture phase, because the game stops the event on its way back up
        this.clickHandler = (event) => {
            const target = event.target;
            if (!(target instanceof Element)) return;
            // Picking an item (or our own button) inside an open menu is not opening a picker
            if (target.closest(MENU_SELECTOR)) return;
            const container = target.closest(PROTECTION_SELECTOR);
            this.lastProtectionClick = container ? { container, at: Date.now() } : null;
        };
        document.addEventListener('click', this.clickHandler, true);

        this.unregisterMenuObserver = domObserver.onClass('EnhancementProtectionMarketplace', 'ItemSelector_menu', () =>
            this._scan()
        );
        this._scan();
    }

    _scan() {
        const click = this.lastProtectionClick;
        if (!click || Date.now() - click.at > MENU_WINDOW_MS) return;
        for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
            if (menu.hasAttribute(MARK_ATTR)) continue;
            this._injectButton(menu, click.container);
        }
    }

    _injectButton(menu, container) {
        menu.setAttribute(MARK_ATTR, 'true');

        const itemHrid = this._getEnhancingItemHrid(container);
        if (!itemHrid) return;

        const cheapest = cheapestListedProtection(itemHrid);
        if (!cheapest?.itemHrid || !cheapest.price) return;

        const itemName = dataManager.getItemDetails(cheapest.itemHrid)?.name || cheapest.itemHrid;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = BUTTON_CLASS;
        btn.style.cssText =
            'display:block; width:100%; box-sizing:border-box; margin-bottom:6px; padding:6px 10px; ' +
            'border:1px solid #4caf50; border-radius:4px; background:rgba(76,175,80,0.15); color:#8bc34a; ' +
            'cursor:pointer; font-family:inherit; font-size:13px;';
        btn.textContent = `🛒 Buy Cheapest: ${itemName} (${formatLargeNumber(cheapest.price)})`;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            navigateToMarketplace(cheapest.itemHrid, 0);
            // The button lives inside the popup's own subtree, so the game's click-away listener
            // never sees this as a dismissal; send it the outside click it is waiting for.
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
            document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        });

        menu.insertBefore(btn, menu.firstChild);
    }

    _getEnhancingItemHrid(container) {
        const panel = container.closest(ENHANCING_PANEL_SELECTOR);
        return panel?.dataset?.mwiItemHrid || null;
    }

    disable() {
        this.unregisterMenuObserver?.();
        this.unregisterMenuObserver = null;
        if (this.clickHandler) {
            document.removeEventListener('click', this.clickHandler, true);
            this.clickHandler = null;
        }
        this.lastProtectionClick = null;
        document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
        document.querySelectorAll(`[${MARK_ATTR}]`).forEach((el) => el.removeAttribute(MARK_ATTR));
        this.isInitialized = false;
    }
}

const enhancementProtectionMarketplace = new EnhancementProtectionMarketplace();
export { EnhancementProtectionMarketplace };
export default enhancementProtectionMarketplace;
