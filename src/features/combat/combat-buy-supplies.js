/**
 * Combat Buy Supplies Button
 *
 * Replaces the "Consumables" heading on the combat page with a "Buy supplies" button that opens the
 * Consumables panel on its Combat tab: how long the food and drinks last, and the Buy-all walk for
 * whatever is short of the panel's target. The Labyrinth entry screen has the same button (see
 * labyrinth-missing-supplies.js), which opens the Labyrinth tab.
 *
 * The panel lives in the UI bundle, so it is reached through the bundle bridge at press time.
 * Nothing is bought until the player confirms in the game's own form.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { consumablesPanel } from '../../utils/bundle-bridge.js';

const BUTTON_CLASS = 'mwi-combat-buy-supplies-button';
const SETTING_KEY = 'combatBuySuppliesButton';
const GRID_CLASS = 'BattlePanel_combatConsumables';

const HIDDEN_LABEL_ATTR = 'data-mwi-combat-supplies-label-hidden';

/**
 * The game's "Consumables" heading: the block's own `BattlePanel_label` child, found by class rather than
 * by text (players run the game in Chinese). Live DOM (2026-11-14): BattlePanel_combatConsumables holds a
 * BattlePanel_label ("Consumables") and then the BattlePanel_combatConsumableGrid. The one place to adjust
 * if the combat page's markup changes.
 * @param {Element} block - The BattlePanel_combatConsumables element
 * @returns {Element|null} The heading, or null when the block has none
 */
export function findConsumablesHeading(block) {
    return block?.querySelector?.(':scope > [class*="BattlePanel_label"]') || null;
}

/** Open the Consumables panel on its Combat tab (opens it, or switches tab; never closes it). */
export function handleClick() {
    consumablesPanel()?.openTab('combat');
}

function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = 'Buy supplies';
    button.title =
        'Open the Consumables panel on its Combat tab: how long your food and drinks last, with a Buy all walk ' +
        'for whatever is short of your target';
    button.style.cssText =
        'margin: 0; padding: 0 10px; font: inherit; line-height: inherit; color: #ffffff; ' +
        'background: rgba(91, 141, 239, 0.15); border: none; box-shadow: inset 0 0 0 1px rgba(91, 141, 239, 0.5); ' +
        'border-radius: 6px; cursor: pointer;';
    button.addEventListener('click', () => {
        try {
            handleClick();
        } catch (error) {
            console.error('[CombatBuySupplies] Opening the Consumables panel failed:', error);
        }
    });
    return button;
}

/**
 * Replace the "Consumables" heading with the button, once per rendered block. With no heading found the
 * button goes at the top of the block instead. `disable()` takes the button out and shows the heading again.
 * @param {Element} grid - The BattlePanel_combatConsumables element
 */
export function injectButton(grid) {
    if (!grid || grid.querySelector(`.${BUTTON_CLASS}`)) return;
    const button = createButton();
    const heading = findConsumablesHeading(grid);
    if (!heading) {
        button.style.margin = '0 0 4px 0';
        button.style.display = 'block';
        grid.insertAdjacentElement('afterbegin', button);
        return;
    }
    // In the heading's place, as on the Labyrinth screen: same font and line from the heading's own class,
    // so the row keeps its height. The heading is hidden, not removed, so React still owns it.
    const holder = document.createElement('div');
    holder.className = heading.className;
    holder.appendChild(button);
    heading.setAttribute(HIDDEN_LABEL_ATTR, '');
    heading.style.display = 'none';
    heading.insertAdjacentElement('afterend', holder);
}

let unregister = null;

export function initialize() {
    if (unregister) return;
    if (!config.getSetting(SETTING_KEY)) return;
    unregister = domObserver.onClass('CombatBuySupplies', GRID_CLASS, (grid) => injectButton(grid));
    document.querySelectorAll(`[class*="${GRID_CLASS}"]`).forEach((grid) => injectButton(grid));
}

export function disable() {
    unregister?.();
    unregister = null;
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => {
        // The holder that stood in for the heading goes with it; a fallback button stands alone
        if (el.parentElement?.previousElementSibling?.hasAttribute(HIDDEN_LABEL_ATTR)) el.parentElement.remove();
        else el.remove();
    });
    document.querySelectorAll(`[${HIDDEN_LABEL_ATTR}]`).forEach((label) => {
        label.style.display = '';
        label.removeAttribute(HIDDEN_LABEL_ATTR);
    });
}

export default { name: 'Combat Buy Supplies Button', initialize, disable };
