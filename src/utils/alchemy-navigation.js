/**
 * Open the Alchemy panel on one item and one alchemy tab.
 *
 * Shared by the Missing Materials "return to action" trip and the achievement
 * tier finisher. Both only navigate: nothing here presses an alchemy button.
 */

import dataManager from '../core/data-manager.js';
import { ALCHEMY_TAB_TYPES, getAlchemyTabElements } from '../features/alchemy/alchemy-tabs.js';
import { buildItemHash } from './item-hash.js';

const INVENTORY_LOCATION = '/item_locations/inventory';

/**
 * Open the Alchemy panel on an item.
 *
 * The game's own `handleAlchemizeItem` takes a stack hash and opens Alchemy with
 * that stack selected, which is the call its inventory menu makes; the hash is a
 * +0 stack in the bag. With no stack, or no such handler, the panel is opened on
 * the alchemy action alone.
 *
 * @param {Object} game - Game component instance
 * @param {{itemHrid: string, actionType: string|null}} ctx - The item and alchemy tab
 * @returns {boolean} Whether a navigation was made
 */
export function openAlchemyOnItem(game, ctx) {
    if (!game) return false;
    const inventory = dataManager.getInventory?.() || [];
    const stack = inventory.find(
        (item) =>
            item &&
            item.itemHrid === ctx.itemHrid &&
            (item.itemLocationHrid || INVENTORY_LOCATION) === INVENTORY_LOCATION &&
            !(Number(item.enhancementLevel) > 0) &&
            (item.count == null || item.count > 0)
    );
    const hash = stack
        ? stack.hash || buildItemHash(dataManager.getCurrentCharacterId?.(), INVENTORY_LOCATION, ctx.itemHrid, 0)
        : null;

    if (hash && typeof game.handleAlchemizeItem === 'function') {
        game.handleAlchemizeItem(hash);
        return true;
    }
    if (ctx.actionType && typeof game.handleGoToAction === 'function') {
        game.handleGoToAction(`/actions/alchemy/${ctx.actionType}`);
        return true;
    }
    return false;
}

/**
 * Select an alchemy tab (Coinify, Decompose, Transmute...) by its position, not its
 * translated label, once the panel's tab strip has mounted. A tab click is
 * navigation, so a plain click is enough. Fails soft: if the tab never appears the
 * player is left on whatever tab the game shows.
 *
 * @param {string} actionType - The tab, e.g. 'transmute'
 * @param {(fn: Function, ms: number) => void} schedule - The caller's timer registry `scheduleTimeout`,
 *   so its teardown cancels the wait
 * @param {() => boolean} [stillWanted] - Checked before each try; false stops the wait
 * @returns {Promise<void>}
 */
export async function selectAlchemyTab(actionType, schedule, stillWanted = () => true) {
    const index = ALCHEMY_TAB_TYPES.indexOf(String(actionType).toLowerCase());
    if (index < 0) return;
    for (let i = 0; i < 20; i++) {
        if (!stillWanted()) return;
        const tab = getAlchemyTabElements()[index];
        if (tab) {
            if (tab.getAttribute('aria-selected') !== 'true') tab.click();
            return;
        }
        await new Promise((resolve) => {
            schedule(resolve, 100);
        });
    }
}
