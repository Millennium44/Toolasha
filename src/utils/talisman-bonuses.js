/**
 * Talisman bonuses
 *
 * Talismans exist on the test server only. A character wears a Talisman Belt, the belt has 1 to 3 slots,
 * and each slotted talisman carries up to four modifier lines, each with a grade from 1 to 6. A line's value is
 * `gradeValues[grade - 1] * (1 + talismanPower)`, where talismanPower comes from the worn belt
 * (`combatStats.talismanPower + combatEnhancementBonuses.talismanPower * steps(level)`).
 *
 * The server's own totals (`characterData.noncombatStats`, `character_stats_updated`) already include talismans.
 * This module exists for the readers that rebuild skilling bonuses from equipment instead; they get the talisman
 * share through the equipment Map they already pass around (see {@link attachTalismanBonuses}), so a reader that
 * reads server totals never calls it and cannot double count.
 *
 * Everything here returns an empty result on a live server and whenever there is no belt or no talisman.
 */

import { isTestServer } from './game-server.js';
import { enhancementSteps } from './enhancement-steps.js';

/** The item location a Talisman Belt is worn in */
export const BELT_LOCATION = '/item_locations/belt';

/** The `talismanModifierDetailMap` target hrids */
const TARGET_NONCOMBAT = '/talisman_modifier_targets/noncombat_stat';
const TARGET_COMBAT = '/talisman_modifier_targets/combat_stat';
const TARGET_BUFF = '/talisman_modifier_targets/buff';

/**
 * @returns {{noncombat: Object, buffs: Object, combat: Object}} A fresh empty result
 */
export function emptyTalismanBonuses() {
    return { noncombat: {}, buffs: {}, combat: {} };
}

/**
 * Whether a result carries nothing.
 * @param {{noncombat?: Object, buffs?: Object, combat?: Object}|null|undefined} bonuses
 * @returns {boolean}
 */
export function isEmptyTalismanBonuses(bonuses) {
    return (
        !bonuses ||
        (Object.keys(bonuses.noncombat || {}).length === 0 &&
            Object.keys(bonuses.buffs || {}).length === 0 &&
            Object.keys(bonuses.combat || {}).length === 0)
    );
}

/**
 * The belt's Talisman Power: `talismanPower + steps(level) * enhancement bonus`, the same way the game adds
 * a worn item's enhancement bonus (the table counts steps, 2% of the base each, not fractions).
 * @param {{itemHrid: string, enhancementLevel?: number}|null} belt - The worn belt
 * @param {Object} itemDetailMap - Item details from init_client_data
 * @param {number[]|undefined} enhancementTable - `enhancementLevelTotalBonusMultiplierTable`
 * @returns {number} Fraction (0.258 for a Large belt +10); 0 for no belt
 */
export function getTalismanPower(belt, itemDetailMap, enhancementTable) {
    const detail = belt?.itemHrid ? itemDetailMap?.[belt.itemHrid]?.equipmentDetail : null;
    if (!detail) return 0;
    const base = detail.combatStats?.talismanPower || 0;
    const perStep = detail.combatEnhancementBonuses?.talismanPower || 0;
    return base + enhancementSteps(belt.enhancementLevel || 0, enhancementTable) * perStep;
}

/**
 * How many talisman slots the worn belt gives (0 for no belt).
 * @param {{itemHrid: string}|null} belt
 * @param {Object} itemDetailMap
 * @returns {number}
 */
export function getBeltSlotCount(belt, itemDetailMap) {
    const detail = belt?.itemHrid ? itemDetailMap?.[belt.itemHrid]?.equipmentDetail : null;
    const slots = detail?.combatStats?.talismanSlots;
    return Number.isFinite(slots) && slots > 0 ? Math.floor(slots) : 0;
}

/**
 * One modifier line's scaled value, or null for a line the game tables do not describe.
 * @param {{hrid: string, grade: number}} modifier - A line of a talisman record
 * @param {Object} modifierDetailMap - `talismanModifierDetailMap`
 * @param {number} power - Talisman Power
 * @returns {{detail: Object, value: number}|null}
 */
export function scaleTalismanModifier(modifier, modifierDetailMap, power) {
    const detail = modifier?.hrid ? modifierDetailMap?.[modifier.hrid] : null;
    if (!detail || !Array.isArray(detail.gradeValues)) return null;
    const grade = Math.floor(Number(modifier.grade));
    if (!(grade >= 1 && grade <= detail.gradeValues.length)) return null;
    const base = detail.gradeValues[grade - 1];
    if (!Number.isFinite(base)) return null;
    return { detail, value: base * (1 + power) };
}

/**
 * The stat name a modifier key feeds: the key with its first letter lowercased
 * (`MilkingSpeed` becomes `milkingSpeed`, the name gear uses in `noncombatStats`).
 * @param {string} key
 * @returns {string}
 */
export function talismanStatName(key) {
    return key ? key.charAt(0).toLowerCase() + key.slice(1) : key;
}

/**
 * Add a talisman list's bonuses up.
 *
 * @param {Object} params
 * @param {Array<Object>} params.talismans - Talisman records ({slotIndex, modifiers:[{hrid, grade}]}). Slots the
 *   belt does not have, and unslotted records, are ignored
 * @param {{itemHrid: string, enhancementLevel?: number}|null} params.belt - The worn belt; none means nothing
 * @param {Object} params.itemDetailMap - Item details from init_client_data
 * @param {Object} params.modifierDetailMap - `talismanModifierDetailMap` from init_client_data
 * @param {number[]} [params.enhancementTable] - `enhancementLevelTotalBonusMultiplierTable`
 * @returns {{noncombat: Object, buffs: Object, combat: Object}} Empty off the test server
 */
export function computeTalismanBonuses({ talismans, belt, itemDetailMap, modifierDetailMap, enhancementTable }) {
    const result = emptyTalismanBonuses();
    if (!isTestServer()) return result;
    if (!belt?.itemHrid || !Array.isArray(talismans) || talismans.length === 0) return result;
    if (!itemDetailMap || !modifierDetailMap) return result;

    const slots = getBeltSlotCount(belt, itemDetailMap);
    if (slots === 0) return result;
    const power = getTalismanPower(belt, itemDetailMap, enhancementTable);

    for (const talisman of talismans) {
        const slot = talisman?.slotIndex;
        if (!Number.isInteger(slot) || slot < 1 || slot > slots) continue;
        for (const modifier of talisman.modifiers || []) {
            const scaled = scaleTalismanModifier(modifier, modifierDetailMap, power);
            if (!scaled) continue;
            const { detail, value } = scaled;
            const into =
                detail.targetHrid === TARGET_NONCOMBAT
                    ? result.noncombat
                    : detail.targetHrid === TARGET_COMBAT
                      ? result.combat
                      : detail.targetHrid === TARGET_BUFF
                        ? result.buffs
                        : null;
            if (!into) continue;
            for (const key of detail.keys || []) {
                const name = detail.targetHrid === TARGET_BUFF ? key : talismanStatName(key);
                into[name] = (into[name] || 0) + value;
            }
        }
    }
    return result;
}

/**
 * The slotted talismans a loadout's `talismanIdMap` names, resolved against what the character owns.
 * `{"1": 2624, "2": 0, "3": 0}`: string slot keys, 0 for an empty slot. An id no longer owned is skipped; a
 * loadout with no map names none. The record's own slotIndex is replaced by the loadout's slot.
 * @param {Object|null|undefined} talismanIdMap - A loadout's map
 * @param {Array<Object>} ownedTalismans - `dataManager.getCharacterTalismans()`
 * @returns {Array<Object>} Records with `slotIndex` set to the loadout's slot
 */
export function resolveLoadoutTalismans(talismanIdMap, ownedTalismans) {
    if (!talismanIdMap || typeof talismanIdMap !== 'object' || !Array.isArray(ownedTalismans)) return [];
    const byId = new Map(ownedTalismans.map((row) => [String(row.id), row]));
    const out = [];
    for (const [slotKey, id] of Object.entries(talismanIdMap)) {
        const slot = Number(slotKey);
        if (!Number.isInteger(slot) || slot < 1 || !id) continue;
        const owned = byId.get(String(id));
        if (owned) out.push({ ...owned, slotIndex: slot });
    }
    return out;
}

/**
 * The unscaled form of a talisman list that a sim player carries: slot and modifier lines only. The scaled
 * values depend on the belt, which the editor can change, so they are worked out where they are used.
 * @param {Array<Object>} talismans - Talisman records
 * @returns {Array<{slotIndex: number, modifiers: Array<{hrid: string, grade: number}>}>}
 */
export function toSimTalismans(talismans) {
    return (talismans || []).map((t) => ({
        slotIndex: t.slotIndex,
        modifiers: (t.modifiers || []).map((m) => ({ hrid: m.hrid, grade: m.grade })),
    }));
}

/**
 * A loadout's talisman bonuses: its own belt (from its saved equipment) and its own talismans.
 * @param {Object} params
 * @param {Object|null} params.talismanIdMap - The loadout's map
 * @param {Array<{itemHrid: string, itemLocationHrid: string, enhancementLevel?: number}>} params.equipment -
 *   The loadout's resolved equipment
 * @param {Array<Object>} params.ownedTalismans - `dataManager.getCharacterTalismans()`
 * @param {Object} params.itemDetailMap
 * @param {Object} params.modifierDetailMap
 * @param {number[]} [params.enhancementTable]
 * @returns {{noncombat: Object, buffs: Object, combat: Object}}
 */
export function computeLoadoutTalismanBonuses({
    talismanIdMap,
    equipment,
    ownedTalismans,
    itemDetailMap,
    modifierDetailMap,
    enhancementTable,
}) {
    const belt = (equipment || []).find((e) => e?.itemLocationHrid === BELT_LOCATION && e.itemHrid) || null;
    return computeTalismanBonuses({
        talismans: resolveLoadoutTalismans(talismanIdMap, ownedTalismans),
        belt,
        itemDetailMap,
        modifierDetailMap,
        enhancementTable,
    });
}

// A bonus set rides on the equipment Map it was computed for, as a non-enumerable own property under a
// registered Symbol. Not module state: the userscript is built as several bundles and a util that is not shared
// is bundled once per consumer, so a module-level WeakMap here could be a different, empty one in the bundle
// that reads than in the one that wrote. `Symbol.for` is the same symbol in every bundle. The property is invisible
// to every reader that iterates the Map, and a copy (`new Map(map)`) or a hypothetical Map a reader builds carries
// nothing: the safe default.
const BONUS_KEY = Symbol.for('toolasha.talismanBonuses');

/**
 * Tie a bonus set to an equipment Map. An empty set is not stored (and clears an earlier one).
 * @param {Map} equipment - The Map a reader will hand to the equipment parsers
 * @param {{noncombat: Object, buffs: Object, combat: Object}|null} bonuses
 * @returns {Map} The same Map
 */
export function attachTalismanBonuses(equipment, bonuses) {
    if (equipment && typeof equipment === 'object') {
        if (isEmptyTalismanBonuses(bonuses)) {
            delete equipment[BONUS_KEY];
        } else {
            Object.defineProperty(equipment, BONUS_KEY, {
                value: bonuses,
                configurable: true,
                writable: true,
                enumerable: false,
            });
        }
    }
    return equipment;
}

/**
 * The bonus set tied to an equipment Map, or an empty one.
 * @param {Map|null|undefined} equipment
 * @returns {{noncombat: Object, buffs: Object, combat: Object}}
 */
export function talismanBonusesOf(equipment) {
    return (equipment && typeof equipment === 'object' && equipment[BONUS_KEY]) || emptyTalismanBonuses();
}

/**
 * One noncombat stat's talisman share for an equipment Map.
 * @param {Map|null|undefined} equipment
 * @param {...(string|null)} statNames - Stats to add up (null entries are skipped)
 * @returns {number} Fraction in the game's units (0.05 is 5%)
 */
export function talismanStat(equipment, ...statNames) {
    const noncombat = talismanBonusesOf(equipment).noncombat;
    let total = 0;
    for (const name of statNames) {
        if (name && noncombat[name]) total += noncombat[name];
    }
    return total;
}

/**
 * One buff type's talisman share for an equipment Map.
 * @param {Map|null|undefined} equipment
 * @param {string} buffTypeHrid - e.g. '/buff_types/gourmet'
 * @returns {number} Fraction (0.015 is 1.5%)
 */
export function talismanBuff(equipment, buffTypeHrid) {
    return talismanBonusesOf(equipment).buffs[buffTypeHrid] || 0;
}
