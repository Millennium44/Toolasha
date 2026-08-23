/**
 * Action context resolver
 *
 * Returns the equipment and active drinks to use when predicting an action's
 * outcome (XP, time, profit, materials). When the loadoutSnapshot feature is
 * enabled and a saved loadout matches the action type, that snapshot is used
 * — so predictions reflect the gear the user would auto-equip rather than
 * whatever happens to be on their character right now.
 *
 * Resolution priority (handled inside loadoutSnapshot._findSnapshot):
 *   1. Skill-specific default loadout
 *   2. All-skills default loadout
 *   3. Skill-specific non-default
 *   4. All-skills non-default
 *   5. Fall back to currently-equipped gear / current drinks
 *
 * Equipment and drinks are resolved independently — it's valid to inherit the
 * snapshot's equipment while no snapshot drinks exist, in which case the
 * current drinks are used (and vice-versa).
 */

import dataManager from '../core/data-manager.js';
import bundledLoadoutSnapshot from '../features/combat/loadout-snapshot.js';
import { loadoutSnapshot } from './bundle-bridge.js';

/**
 * The loadout store that actually has the loadouts in it.
 *
 * In the multi-bundle build every bundle that imports this file gets its own
 * copy of the snapshot singleton, and only the Combat one has `initialize`
 * called on it — the others never read storage, so they answer "no loadout" to
 * everything and every caller quietly falls back to whatever is worn right now.
 * The global is the initialized one. The bundled copy is the dev build, where
 * there is only ever one.
 *
 * @returns {Object} The snapshot store
 */
function loadouts() {
    return loadoutSnapshot() || bundledLoadoutSnapshot;
}

/**
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @returns {{equipment: Map, drinks: Array}}
 */
export function resolveActionContext(actionTypeHrid) {
    const loadoutSnapshot = loadouts();
    const rawDrinks =
        loadoutSnapshot.getSnapshotDrinksForSkill(actionTypeHrid) ?? dataManager.getActionDrinkSlots(actionTypeHrid);

    // Only include drinks that will actually buff the next action. A slot with no stock left
    // brews nothing — but the buff from the last cup keeps running until it expires, and the
    // slot says so (`isActive` with time remaining). Dropping it the moment the stack hit zero
    // made every prediction jump the instant the last tea was consumed, minutes before the buff
    // it was still enjoying actually ended.
    const inventory = dataManager.getInventory() || [];
    const inStock = (hrid) => inventory.some((i) => i.itemHrid === hrid && (i.count || 0) > 0);
    const stillRunning = (d) => d?.isActive === true && (d?.duration || 0) > 0;
    const drinks = (rawDrinks || []).filter((d) => d?.itemHrid && (inStock(d.itemHrid) || stillRunning(d)));

    return {
        equipment: loadoutSnapshot.getSnapshotForSkill(actionTypeHrid) ?? dataManager.getEquipment(),
        drinks,
    };
}

export default { resolveActionContext };
