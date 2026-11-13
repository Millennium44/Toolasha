/**
 * Labyrinth Missing Supplies Button
 *
 * Adds a button next to the Labyrinth entry screen's "Supplies" label that opens the marketplace
 * on whatever Torch/Shroud/Beacon (and selected crates) is short of the stock target, quantities
 * already filled in.
 *
 * The fork already restocked labyrinth supplies from the Consumables panel (its Labyrinth block's
 * "Buy all" hands a shortfall to the shared shopping list). This button reaches the same shopping
 * list (utils/shopping-list.js) from the entry screen itself, sized to that same stock target
 * (labyrinth-stock-target.js: runs x per-run need, less what is held). It only opens the
 * marketplace; nothing is bought until the player presses the game's own confirm button.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { showToast } from '../../utils/toast.js';
import { openShoppingList } from '../../utils/shopping-list.js';
import { heldInInventory } from '../../utils/dungeon-key-forecast.js';
import { resolveSupplyHrids, bestOwnedTier, readSupplyCounts, SUPPLY_KINDS } from './labyrinth-supplies.js';
import {
    labCapacity,
    labPerRunNeed,
    labShortfall,
    readLabStockTarget,
    CRATE_SLOTS,
    DEFAULT_LAB_RUNS,
} from './labyrinth-stock-target.js';

const BUTTON_CLASS = 'mwi-labyrinth-missing-supplies-button';
const SETTING_KEY = 'labyrinthMissingSuppliesButton';

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
 * What is short of the Consumables panel's stock target, for the selected tier of each supply.
 * Sized exactly as the panel's Labyrinth block sizes it (per-run need x run target, less what the
 * inventory holds), crates included, through the shared labyrinth-stock-target helpers.
 * @param {{runs: number, ledgerRuns: Array<Object>, basis: string}} [target] - From readLabStockTarget
 * @returns {Array<{itemHrid: string, name: string, count: number}>} Shopping-list lines; empty
 *   when nothing is short, or game data is not up yet
 */
export function calculateMissingSupplies(target = { runs: DEFAULT_LAB_RUNS, ledgerRuns: [], basis: 'measured' }) {
    const itemMap = dataManager.getInitClientData?.()?.itemDetailMap;
    if (!itemMap) return [];
    const inventory = dataManager.getInventory?.() || [];
    const hrids = resolveSupplyHrids(itemMap);
    const counts = readSupplyCounts(inventory, hrids);
    const info = dataManager.characterData?.characterInfo;
    const data = dataManager.characterData;
    const lab = data?.characterLabyrinth || data?.labyrinth;

    // Untradable supplies cannot be bought; nothing to put on the list. The game omits
    // `isTradable` on untradable items, so a known item is tradable only when it says so.
    // An item with no details at all stays on the list (nothing says it cannot be bought).
    const line = (itemHrid, perRun) => {
        const details = itemMap[itemHrid];
        if (details && details.isTradable !== true) return null;
        const count = labShortfall(perRun, target.runs, heldInInventory(inventory, itemHrid));
        if (count <= 0) return null;
        return { itemHrid, name: details?.name || itemHrid.split('/').pop(), count };
    };

    const missing = [];
    for (const kind of SUPPLY_KINDS) {
        const itemHrid = selectedTier(kind, hrids, counts);
        if (!itemHrid) continue;
        const { perRun } = labPerRunNeed(kind, labCapacity(info, kind), target.ledgerRuns, target.basis);
        const entry = line(itemHrid, perRun);
        if (entry) missing.push(entry);
    }
    // One crate per selected slot per run, as the panel stocks them
    for (const slot of CRATE_SLOTS) {
        if (!lab?.[slot]) continue;
        const entry = line(lab[slot], 1);
        if (entry) missing.push(entry);
    }
    return missing;
}

/** Open the marketplace on the current shortfall. Recomputed at press time, never cached. */
export async function handleClick() {
    // Game data not up yet: nothing was counted, so claim nothing about the supplies
    if (!dataManager.getInitClientData?.()?.itemDetailMap) {
        showToast('Supply data is still loading. Try again in a moment.');
        return;
    }
    // The run target and ledger are read from storage at press time, the way the Consumables
    // panel loads them, so this works with that panel closed or never opened
    const characterId = dataManager.getCurrentCharacterId?.();
    let target;
    try {
        target = await readLabStockTarget();
    } catch (error) {
        console.error('[LabyrinthMissingSupplies] Reading the stock target failed:', error);
        showToast('Could not read your supply target. Try again in a moment.');
        return;
    }
    // A character switch mid-read would size one character's shortfall off another's ledger
    if (dataManager.getCurrentCharacterId?.() !== characterId) return;
    if (!dataManager.getInitClientData?.()?.itemDetailMap) return;
    const missing = calculateMissingSupplies(target);
    if (!missing.length) {
        // Evaluated at press time, so the notice can never go stale the way a disabled state could.
        // An untradable shortfall is skipped too, so the wording covers both.
        showToast(
            `Nothing to buy: you hold enough for ${target.runs} run${target.runs === 1 ? '' : 's'} of every ` +
                'supply that can be bought (Consumables panel target).'
        );
        return;
    }
    openShoppingList(missing, { heading: 'Lab supplies' });
}

function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = 'Buy missing supplies';
    button.title =
        'Open the marketplace on whichever supplies are short of your stock target: the run count set in the ' +
        'Consumables panel (default 5), at the per-run need it plans for, crates included';
    button.style.cssText =
        'margin: 0 0 0 8px; padding: 0 8px; line-height: 14px; vertical-align: top; ' +
        'background: rgba(91, 141, 239, 0.15); color: #ffffff; border: 1px solid rgba(91, 141, 239, 0.4); ' +
        'border-radius: 6px; cursor: pointer; font-size: 11px; font-weight: 600;';
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
 * Inject the button inline at the end of the "Supplies" label, once per rendered panel instance. On a line of its
 * own it made the supplies column taller than the floor column beside it, and the whole bottom row grew. It hangs
 * from a zero-width holder, so the centered label text stays centered over the supplies.
 * @param {Element} grid - The LabyrinthPanel_suppliesGrid element
 */
export function injectButton(grid) {
    const wrapper = grid?.parentElement;
    if (!wrapper || wrapper.querySelector(`.${BUTTON_CLASS}`)) return;
    const label = wrapper.querySelector('[class*="LabyrinthPanel_label"]');
    if (!label) return;
    const holder = document.createElement('span');
    holder.style.cssText = 'display: inline-block; width: 0; white-space: nowrap; vertical-align: top;';
    holder.appendChild(createButton());
    label.appendChild(holder);
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
