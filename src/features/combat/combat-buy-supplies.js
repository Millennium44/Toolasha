/**
 * Combat Buy Supplies Button
 *
 * Adds a "Buy supplies" button beside the "Consumables" heading on the combat page that opens the
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

/** The longest a heading's text can be before it is treated as something else (a label is a word or two) */
const MAX_HEADING_CHARS = 40;

/**
 * The game's "Consumables" heading for a consumables grid, found by position and shape rather than
 * by text (players run the game in Chinese): the element just before the grid in its parent, holding
 * only a short piece of text, with no icons or buttons of its own. The one place to adjust if the
 * combat page's markup changes.
 * @param {Element} grid - The BattlePanel_combatConsumables element
 * @returns {Element|null} The heading, or null when the grid has no such neighbor
 */
export function findConsumablesHeading(grid) {
    const candidate = grid?.previousElementSibling;
    if (!candidate || candidate.contains(grid)) return null;
    if (candidate.classList.contains(BUTTON_CLASS) || candidate.querySelector(`.${BUTTON_CLASS}`)) return null;
    if (candidate.querySelector('svg, img, button, input, [class*="Item"]')) return null;
    const text = candidate.textContent.trim();
    if (!text || text.length > MAX_HEADING_CHARS) return null;
    return candidate;
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
        'margin: 0 0 0 10px; padding: 0 10px; font: inherit; line-height: inherit; color: #ffffff; ' +
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
 * Put the button beside the "Consumables" heading, once per rendered grid: appended inside the heading
 * so it shares the line. With no heading found it goes just before the grid instead. The heading itself
 * is left as the game drew it; `disable()` removes only the button.
 * @param {Element} grid - The BattlePanel_combatConsumables element
 */
export function injectButton(grid) {
    const parent = grid?.parentElement;
    if (!parent || parent.querySelector(`.${BUTTON_CLASS}`)) return;
    const button = createButton();
    const heading = findConsumablesHeading(grid);
    if (heading) {
        heading.appendChild(button);
        return;
    }
    button.style.margin = '0 0 4px 0';
    button.style.display = 'block';
    grid.insertAdjacentElement('beforebegin', button);
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
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
}

export default { name: 'Combat Buy Supplies Button', initialize, disable };
