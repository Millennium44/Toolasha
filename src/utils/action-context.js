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
 *   3. Fall back to currently-equipped gear / current drinks (a non-default loadout is never picked;
 *      combat skips the All Skills one)
 *
 * One exception: while an action of the asked-for type is RUNNING, the answer is the loadout that
 * action was started with (its `characterLoadoutID`), because the game equipped that loadout when it
 * started. "No Loadout" (0) is the gear, talismans and drinks worn now, and so is an id this build
 * has no loadout for (deleted, loadouts off, not loaded): the game equipped it, so it is what is worn.
 *
 * Equipment and drinks are resolved independently — it's valid to inherit the
 * snapshot's equipment while no snapshot drinks exist, in which case the
 * current drinks are used (and vice-versa).
 */

import dataManager from '../core/data-manager.js';
import bundledLoadoutSnapshot from '../features/combat/loadout-snapshot.js';
import { loadoutSnapshot } from './bundle-bridge.js';
import { resolveLoadoutTalismans } from './talisman-bonuses.js';
import { runningAction } from './combat-actions.js';

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
 * The loadout id the running action carries, when that action is of this type.
 *
 * Through `runningAction`, never `actions[0]`, which may be queued behind it.
 *
 * @param {string} actionTypeHrid - e.g. "/action_types/enhancing"
 * @returns {number|null} The id (0 for "No Loadout"), or null when no action of this type runs or it carries no id
 */
function runningLoadoutIdFor(actionTypeHrid) {
    const running = runningAction(dataManager.getCurrentActions?.() || []);
    if (!running?.actionHrid) return null;
    if (dataManager.getActionDetails?.(running.actionHrid)?.type !== actionTypeHrid) return null;
    const id = running.characterLoadoutID;
    return typeof id === 'number' && Number.isFinite(id) ? id : null;
}

/**
 * Which gear the three public readers below describe, picked once so context, talismans and label agree.
 *
 * - `{kind: 'worn'}`: the running action of this type was started with No Loadout (or a saved loadout that names
 *   no gear), so it runs on what is worn and slotted now. `unloaded` when its id is one this build has no loadout
 *   for (deleted, loadouts off, not loaded): the game put it on at the start, so the worn kit is that loadout.
 * - `{kind: 'loadout', snapshot, id}`: the running action's own saved loadout.
 * - null: no action of this type runs, or it carries no numeric id: the per-skill pick.
 *
 * @param {string} actionTypeHrid
 * @returns {{kind: 'worn', id: number, unloaded?: boolean}|{kind: 'loadout', id: number, snapshot: Object}|null}
 */
function runningPick(actionTypeHrid) {
    const id = runningLoadoutIdFor(actionTypeHrid);
    if (id === null) return null;
    if (id <= 0) return { kind: 'worn', id: 0 };
    const snapshot = loadouts().getSnapshotById?.(id) ?? null;
    // Deleted, loadouts off, or not loaded yet: the game equipped it on start, so what is worn now is that loadout
    // (as resolveRunningContext reads it), closer than the skill default
    if (!snapshot) return { kind: 'worn', id, unloaded: true };
    if (!snapshot.equipment?.length) return { kind: 'worn', id };
    return { kind: 'loadout', id, snapshot };
}

/**
 * The equipment and drinks to predict an action of this type with: the running action's own loadout while one of
 * this type runs (see the file header), else the per-skill pick.
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @returns {{equipment: Map, drinks: Array}}
 */
export function resolveActionContext(actionTypeHrid) {
    const pick = runningPick(actionTypeHrid);
    if (pick) return resolveLoadoutContext(actionTypeHrid, pick.kind === 'worn' ? 0 : pick.id);
    return skillDefaultContext(actionTypeHrid);
}

/**
 * The per-skill pick, ignoring any running action: what a fresh action of this type would start with.
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @returns {{equipment: Map, drinks: Array}}
 */
function skillDefaultContext(actionTypeHrid) {
    const loadoutSnapshot = loadouts();
    const rawDrinks =
        loadoutSnapshot.getSnapshotDrinksForSkill(actionTypeHrid) ?? dataManager.getActionDrinkSlots(actionTypeHrid);

    return {
        equipment: loadoutSnapshot.getSnapshotForSkill(actionTypeHrid) ?? dataManager.getEquipment(),
        drinks: activeDrinksOf(rawDrinks),
    };
}

/**
 * The talisman records the gear {@link resolveActionContext} puts on carries: the loadout the skill equips names its
 * own (resolved against what the character owns, slot as the loadout puts it), else those slotted now. The context's
 * equipment Map holds their summed bonuses only; a reader that needs the lines themselves takes them here, in the
 * same tick as the context.
 *
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @returns {Array<Object>} `{id, talismanTypeHrid, modifiers, slotIndex}` records; empty for none
 */
export function resolveActionTalismans(actionTypeHrid) {
    const pick = runningPick(actionTypeHrid);
    if (pick?.kind === 'worn') return dataManager.getSlottedTalismans?.() || [];
    const snapshot = pick ? pick.snapshot : (loadouts().findSnapshotForSkill?.(actionTypeHrid) ?? null);
    if (snapshot) return resolveLoadoutTalismans(snapshot.talismanIdMap, dataManager.getCharacterTalismans?.() || []);
    return dataManager.getSlottedTalismans?.() || [];
}

/**
 * Which gear {@link resolveActionContext} puts on for this action type, in words: the loadout it wears, or the gear
 * worn now. Read in the same tick as the context so a label never names other gear than the numbers used.
 *
 * @param {string} actionTypeHrid - e.g. "/action_types/cooking"
 * @returns {{key: string, label: string}}
 */
export function describeActionContextSource(actionTypeHrid) {
    const pick = runningPick(actionTypeHrid);
    if (pick?.kind === 'worn' && pick.unloaded) {
        return {
            key: `running:${actionTypeHrid}:${pick.id}:unloaded`,
            label: "The gear you wear now (this run's loadout is not loaded)",
        };
    }
    if (pick?.kind === 'worn') {
        return { key: `running:${actionTypeHrid}:${pick.id}`, label: 'No loadout: the gear you wear now' };
    }
    if (pick) {
        return {
            key: `running:${actionTypeHrid}:${pick.id}:${pick.snapshot.name}`,
            label: `${pick.snapshot.name}${pick.snapshot.isDefault ? ' ★' : ''} (the loadout the running action uses)`,
        };
    }
    const snapshot = loadouts().findSnapshotForSkill?.(actionTypeHrid) ?? null;
    if (!snapshot) return { key: `worn:${actionTypeHrid}`, label: 'The gear you wear now (no loadout for this skill)' };
    return {
        key: `skill:${actionTypeHrid}:${snapshot.name}`,
        label: `${snapshot.name}${snapshot.isDefault ? ' ★' : ''} (the loadout this skill equips)`,
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
 * @param {{running?: boolean}} [options] - `running`: the action is the one running now, so an unknown saved id reads
 *   the worn gear, as {@link resolveRunningContext} does
 * @returns {{equipment: Map, drinks: Array}}
 */
export function resolveLoadoutContext(actionTypeHrid, characterLoadoutID, { running = false } = {}) {
    if (typeof characterLoadoutID !== 'number' || !Number.isFinite(characterLoadoutID)) {
        return skillDefaultContext(actionTypeHrid);
    }
    if (characterLoadoutID <= 0) {
        return {
            equipment: dataManager.getEquipment(),
            drinks: activeDrinksOf(dataManager.getActionDrinkSlots(actionTypeHrid)),
        };
    }
    const store = loadouts();
    const snapshot = store.getSnapshotById?.(characterLoadoutID) ?? null;
    // A RUNNING action's saved id with no loadout behind it (deleted since, loadouts off, not loaded) is gear the
    // game already put on: what is worn. The per-skill pick would be a different loadout's gear
    if (!snapshot) return running ? resolveLoadoutContext(actionTypeHrid, 0) : skillDefaultContext(actionTypeHrid);

    const worn = snapshot.equipment?.length
        ? (store.equipmentMapOf?.(snapshot) ??
          new Map(store.resolveEquipment(snapshot).map((e) => [e.itemLocationHrid, e])))
        : null;
    const filled = (snapshot.drinks || []).filter((d) => d.itemHrid);
    return {
        equipment: worn ?? dataManager.getEquipment(),
        drinks: activeDrinksOf(filled.length > 0 ? filled : dataManager.getActionDrinkSlots(actionTypeHrid)),
    };
}

/**
 * The gear and drinks the RUNNING action is using, by the loadout id it carries.
 *
 * The game applies a loadout when its action starts (gear swap, drink slots rewritten), so what
 * is worn and slotted now is what the action runs on. Unlike {@link resolveLoadoutContext} this
 * never answers with the per-skill default pick: an id that is 0 ("No Loadout"), or a saved id
 * this build has no snapshot for (deleted, feature off, not loaded), reads the live gear and
 * slots, which are what is really in force. Null for an action with no numeric id.
 *
 * @param {string} actionTypeHrid - e.g. "/action_types/foraging"
 * @param {number|null|undefined} characterLoadoutID - The running action's loadout id
 * @returns {{equipment: Map, drinks: Array}|null}
 */
export function resolveRunningContext(actionTypeHrid, characterLoadoutID) {
    if (typeof characterLoadoutID !== 'number' || !Number.isFinite(characterLoadoutID)) return null;
    return resolveLoadoutContext(actionTypeHrid, characterLoadoutID, { running: true });
}

export default {
    resolveActionContext,
    resolveActionTalismans,
    describeActionContextSource,
    resolveLoadoutContext,
    resolveRunningContext,
};
