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

    return {
        equipment: loadoutSnapshot.getSnapshotForSkill(actionTypeHrid) ?? dataManager.getEquipment(),
        drinks: activeDrinksOf(rawDrinks),
    };
}

/**
 * Only the drinks that will actually buff the next action.
 * @param {Array|null} rawDrinks - Slotted drinks
 * @returns {Array} The ones in stock or still running
 */
function activeDrinksOf(rawDrinks) {
    // Only include drinks that will actually buff the next action. A slot with no stock left
    // brews nothing — but the buff from the last cup keeps running until it expires, and the
    // slot says so (`isActive` with time remaining). Dropping it the moment the stack hit zero
    // made every prediction jump the instant the last tea was consumed, minutes before the buff
    // it was still enjoying actually ended.
    const inventory = dataManager.getInventory() || [];
    const inStock = (hrid) => inventory.some((i) => i.itemHrid === hrid && (i.count || 0) > 0);
    const stillRunning = (d) => d?.isActive === true && (d?.duration || 0) > 0;
    return (rawDrinks || []).filter((d) => d?.itemHrid && (inStock(d.itemHrid) || stillRunning(d)));
}

/**
 * The equipment and drinks a QUEUED action actually runs with. Every queued action carries the
 * characterLoadoutID it was queued under: a saved loadout's id, or 0 for "No Loadout" (the
 * gear worn right now). The per-skill default pick of 
esolveActionContext answers a different
 * question — what a fresh action would start with — and would cost a row at gear the game never
 * puts on for it.
 *
 * An id that is not a number (a row from before the field existed), or a saved id this build
 * has no snapshot for (loadout feature off, not yet loaded), falls back to
 * 
esolveActionContext. A saved loadout with no equipment (or no drinks) inherits the worn
 * gear (or current drinks) for that half, as the game does.
 *
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @param {number|null|undefined} characterLoadoutID - The queued action's loadout id
 * @returns {{equipment: Map, drinks: Array}}
 */
export function resolveLoadoutContext(actionTypeHrid, characterLoadoutID) {
    if (typeof characterLoadoutID !== 'number' || !Number.isFinite(characterLoadoutID)) {
        return resolveActionContext(actionTypeHrid);
    }
    if (characterLoadoutID <= 0) {
        return {
            equipment: dataManager.getEquipment(),
            drinks: activeDrinksOf(dataManager.getActionDrinkSlots(actionTypeHrid)),
        };
    }
    const store = loadouts();
    const snapshot = store.getSnapshotById?.(characterLoadoutID) ?? null;
    if (!snapshot) return resolveActionContext(actionTypeHrid);

    const worn = snapshot.equipment?.length
        ? new Map(store.resolveEquipment(snapshot).map((e) => [e.itemLocationHrid, e]))
        : null;
    const filled = (snapshot.drinks || []).filter((d) => d.itemHrid);
    return {
        equipment: worn ?? dataManager.getEquipment(),
        drinks: activeDrinksOf(filled.length > 0 ? filled : dataManager.getActionDrinkSlots(actionTypeHrid)),
    };
}

export default { resolveActionContext, resolveLoadoutContext };
