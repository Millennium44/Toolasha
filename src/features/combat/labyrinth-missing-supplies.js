/**
 * Labyrinth Missing Supplies Button
 *
 * Adds a button next to the Labyrinth entry screen's "Supplies" label that opens the marketplace
 * on whatever Torch/Shroud/Beacon is short of its carry cap, quantities already filled in.
 *
 * The fork already restocked labyrinth supplies from the Consumables panel (its Labyrinth block's
 * "Buy all" hands a shortfall to the shared shopping list). This button reaches the same shopping
 * list (utils/shopping-list.js) from the entry screen itself, sized to the carry caps rather than
 * to a run count. It only opens the marketplace; nothing is bought until the player presses the
 * game's own confirm button.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { showToast } from '../../utils/toast.js';
import { openShoppingList } from '../../utils/shopping-list.js';
import { heldInInventory } from '../../utils/dungeon-key-forecast.js';
import { resolveSupplyHrids, bestOwnedTier, readSupplyCounts, SUPPLY_KINDS } from './labyrinth-supplies.js';

const BUTTON_CLASS = 'mwi-labyrinth-missing-supplies-button';
const SETTING_KEY = 'labyrinthMissingSuppliesButton';

// The client's base carry caps, standing in only until characterInfo states the real ones
// (upgrades already applied) - the same fallbacks the Consumables panel uses.
const BASE_CAPS = { torch: 100, shroud: 4, beacon: 5 };
const CAP_FIELD = { torch: 'labyrinthTorchCap', shroud: 'labyrinthShroudCap', beacon: 'labyrinthBeaconCap' };
const SETTING_FIELD = {
    torch: 'labyrinthTorchHrid',
    shroud: 'labyrinthShroudHrid',
    beacon: 'labyrinthBeaconHrid',
};

/**
 * The tier of a supply the player has selected for the next run: the character setting if the
 * game states one, else what the labyrinth record carried, else the best tier held, else basic.
 * @param {string} kind - torch | shroud | beacon
 * @param {Object} hrids - From resolveSupplyHrids
 * @param {Object} counts - From readSupplyCounts
 * @returns {string|null}
 */
function selectedTier(kind, hrids, counts) {
    const data = dataManager.characterData;
    const lab = data?.characterLabyrinth || data?.labyrinth;
    return (
        data?.characterSetting?.[SETTING_FIELD[kind]] ||
        lab?.[`${kind}ItemHrid`] ||
        bestOwnedTier(counts, kind, hrids) ||
        hrids[kind]?.[0] ||
        null
    );
}

/**
 * What is short of each carry cap, for the selected tier of each supply.
 * @returns {Array<{itemHrid: string, name: string, count: number}>} Shopping-list lines; empty
 *   when nothing is short, or game data is not up yet
 */
export function calculateMissingSupplies() {
    const itemMap = dataManager.getInitClientData?.()?.itemDetailMap;
    if (!itemMap) return [];
    const inventory = dataManager.getInventory?.() || [];
    const hrids = resolveSupplyHrids(itemMap);
    const counts = readSupplyCounts(inventory, hrids);
    const info = dataManager.characterData?.characterInfo;

    const missing = [];
    for (const kind of SUPPLY_KINDS) {
        const itemHrid = selectedTier(kind, hrids, counts);
        if (!itemHrid) continue;
        const details = itemMap[itemHrid];
        // Untradable supplies cannot be bought; nothing to put on the list
        if (details?.isTradable === false) continue;

        const stated = Number(info?.[CAP_FIELD[kind]]);
        const cap = stated > 0 ? stated : BASE_CAPS[kind];
        const count = Math.max(0, cap - heldInInventory(inventory, itemHrid));
        if (count <= 0) continue;
        missing.push({ itemHrid, name: details?.name || itemHrid.split('/').pop(), count });
    }
    return missing;
}

/** Open the marketplace on the current shortfall. Recomputed at press time, never cached. */
export function handleClick() {
    // Game data not up yet: nothing was counted, so claim nothing about the supplies
    if (!dataManager.getInitClientData?.()?.itemDetailMap) {
        showToast('Supply data is still loading. Try again in a moment.');
        return;
    }
    const missing = calculateMissingSupplies();
    if (!missing.length) {
        // Evaluated at press time, so the notice can never go stale the way a disabled state could.
        // An untradable shortfall is skipped too, so the wording covers both.
        showToast('Nothing to buy: every supply is at its carry cap or cannot be bought.');
        return;
    }
    openShoppingList(missing, { heading: 'Lab supplies' });
}

function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = 'Buy missing supplies';
    button.title = 'Open the marketplace on whichever supplies are short of your carry cap';
    button.style.cssText =
        'margin: 4px 0 8px 0; padding: 4px 10px; background: rgba(91, 141, 239, 0.15); color: #ffffff; ' +
        'border: 1px solid rgba(91, 141, 239, 0.4); border-radius: 6px; cursor: pointer; font-size: 12px; ' +
        'font-weight: 600;';
    button.addEventListener('click', () => {
        try {
            handleClick();
        } catch (error) {
            console.error('[LabyrinthMissingSupplies] Opening the marketplace failed:', error);
        }
    });
    return button;
}

/**
 * Inject the button after the "Supplies" label, once per rendered panel instance.
 * @param {Element} grid - The LabyrinthPanel_suppliesGrid element
 */
export function injectButton(grid) {
    const wrapper = grid?.parentElement;
    if (!wrapper || wrapper.querySelector(`.${BUTTON_CLASS}`)) return;
    const label = wrapper.querySelector('[class*="LabyrinthPanel_label"]');
    if (!label) return;
    label.insertAdjacentElement('afterend', createButton());
}

let unregister = null;

export function initialize() {
    if (unregister) return;
    if (!config.getSetting(SETTING_KEY)) return;
    unregister = domObserver.onClass('LabyrinthMissingSupplies', 'LabyrinthPanel_suppliesGrid', (grid) =>
        injectButton(grid)
    );
    document.querySelectorAll('[class*="LabyrinthPanel_suppliesGrid"]').forEach((grid) => injectButton(grid));
}

export function disable() {
    unregister?.();
    unregister = null;
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.remove());
}

export default { name: 'Labyrinth Missing Supplies Button', initialize, disable };
