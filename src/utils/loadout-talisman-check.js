/**
 * Loadout talisman checks (test server only)
 *
 * Starting an action re-equips its loadout, talismans included. A loadout can name talismans that will not
 * do what the player expects:
 *  - `deleted`: the id it names is no longer owned (the slot is skipped silently);
 *  - `slot`: the talisman sits in a slot its own belt does not have (a Small belt has one slot);
 *  - `type`: a combat loadout holds a skilling talisman, or a skilling loadout a combat one. The type decides
 *    which kind of action the talisman's lines apply to, so it does nothing for this loadout.
 *
 * The same talisman in several loadouts is normal and is not reported.
 *
 * Fails quiet: anything the data does not settle (talisman list not delivered, belt not in the loadout, belt
 * without a slot count, a talisman type this code does not know) reports nothing rather than a false warning.
 */

import { isTestServer } from './game-server.js';
import { parseWearable } from './loadout-equipment.js';
import { BELT_LOCATION } from './talisman-bonuses.js';

export const COMBAT_ACTION_TYPE = '/action_types/combat';
const TYPE_COMBAT = '/talisman_types/combat';
const TYPE_SKILLING = '/talisman_types/skilling';

/**
 * @typedef {Object} LoadoutTalismanWarning
 * @property {'deleted'|'slot'|'type'} code
 * @property {number} slot - The loadout slot (1..3)
 * @property {string} text - Why, in a short sentence
 */

/**
 * Check one loadout's talisman setup.
 * @param {Object} params
 * @param {Object|null} params.loadout - A `characterLoadoutMap` entry (`talismanIdMap`, `wearableMap`, `actionTypeHrid`)
 * @param {Array<Object>|null} params.ownedTalismans - `characterData.characterTalismans`; null when not delivered
 * @param {Object} params.itemDetailMap - Item details from init_client_data
 * @returns {LoadoutTalismanWarning[]} Empty off the test server and when all is well
 */
export function checkLoadoutTalismans({ loadout, ownedTalismans, itemDetailMap }) {
    if (!isTestServer()) return [];
    const idMap = loadout?.talismanIdMap;
    if (!idMap || typeof idMap !== 'object' || !Array.isArray(ownedTalismans)) return [];

    const byId = new Map(ownedTalismans.map((row) => [String(row.id), row]));
    const beltHash = loadout.wearableMap?.[BELT_LOCATION];
    const belt = beltHash ? parseWearable(BELT_LOCATION, beltHash) : null;
    const rawSlots = belt ? itemDetailMap?.[belt.itemHrid]?.equipmentDetail?.combatStats?.talismanSlots : undefined;
    const beltSlots = Number.isFinite(rawSlots) && rawSlots > 0 ? Math.floor(rawSlots) : null;
    const wantedType = loadout.actionTypeHrid === COMBAT_ACTION_TYPE ? TYPE_COMBAT : TYPE_SKILLING;
    const wantedName = wantedType === TYPE_COMBAT ? 'combat' : 'skilling';
    const otherName = wantedType === TYPE_COMBAT ? 'skilling' : 'combat';

    const out = [];
    for (const [slotKey, id] of Object.entries(idMap)) {
        const slot = Number(slotKey);
        if (!Number.isInteger(slot) || slot < 1 || !id) continue;
        const owned = byId.get(String(id));
        if (!owned) {
            out.push({ code: 'deleted', slot, text: `Slot ${slot}: the talisman no longer exists.` });
            continue;
        }
        if (beltSlots !== null && slot > beltSlots) {
            out.push({
                code: 'slot',
                slot,
                text: `Slot ${slot}: this loadout's belt has ${beltSlots} slot${beltSlots === 1 ? '' : 's'}, so this talisman does nothing.`,
            });
        }
        const type = owned.talismanTypeHrid;
        if ((type === TYPE_COMBAT || type === TYPE_SKILLING) && type !== wantedType) {
            out.push({
                code: 'type',
                slot,
                text: `Slot ${slot}: a ${otherName} talisman does nothing in a ${wantedName} loadout.`,
            });
        }
    }
    return out.sort((a, b) => a.slot - b.slot);
}

/**
 * Warnings that hold for every one of several loadouts (loadouts are told apart by name in the panel, and
 * names are not unique): only what all of them agree on is shown, so a namesake never causes a false warning.
 * @param {LoadoutTalismanWarning[][]} lists
 * @returns {LoadoutTalismanWarning[]}
 */
export function commonWarnings(lists) {
    if (lists.length === 0) return [];
    const [first, ...rest] = lists;
    // The whole warning must match, reason text included: two namesakes can share a code and slot for different
    // causes (a Small and a Medium belt both lack slot 3), and the shown text must hold for the selected one
    return first.filter((w) =>
        rest.every((l) => l.some((x) => x.code === w.code && x.slot === w.slot && x.text === w.text))
    );
}
