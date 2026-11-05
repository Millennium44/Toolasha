/**
 * Gear stats check
 *
 * Compares what the equipment parser works out from the worn gear with the
 * game's own answer, `characterData.noncombatStats`, once per character per page
 * load. It exists because of 3.76.0: the enhancement table (which counts 2% steps,
 * +20 = 50) was read as a fraction, every skilling figure went 100x off, and
 * nothing noticed. The schema canary only checks that the data is present.
 *
 * ## One-sided on purpose
 *
 * The game's `noncombatStats` may include things the parser never sees (tea and
 * house buffs, community buffs, achievements, MooPass, guild) — that is not
 * established from the code, so it is treated as possible. Every one of those can
 * only ADD to the game's figure. So the check alarms only when OUR figure is
 * larger than the game's by more than rounding: an unknown extra source can never
 * cause that, a scale bug like 3.76.0 does. A parser that comes out too small is
 * not caught — the other safeguards cover it, and a false alarm costs more.
 *
 * ## What it compares
 *
 * Per gathering/production skill, efficiency and speed, each as the sum the
 * parser itself uses (skill-specific field plus the `skilling*` field), and
 * Drink Concentration. Stats the parser does not map are not compared. Missing
 * data (no stats, no item map, no worn gear) is "no comparison", never a mismatch.
 *
 * Reads only loaded data. No storage, no network. Never throws.
 */

import dataManager from './data-manager.js';
import { parseEquipmentEfficiencyBonuses, parseEquipmentSpeedBonuses } from '../utils/equipment-parser.js';
import { getDrinkConcentration } from '../utils/tea-parser.js';

/** Skills whose efficiency and speed fields the parser maps */
const SKILLS = [
    'milking',
    'foraging',
    'woodcutting',
    'cheesesmithing',
    'crafting',
    'tailoring',
    'brewing',
    'cooking',
    'alchemy',
];

/** Rounding allowance: half a percentage point, or 2% of the game's figure, whichever is larger */
const ABSOLUTE_TOLERANCE = 0.005;
const RELATIVE_TOLERANCE = 0.02;

/** Characters already compared this page load */
const checkedCharacters = new Set();

/**
 * @param {*} value - Candidate
 * @returns {boolean} True for a finite number
 */
function isNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Compare worn gear with the game's stats. Pure: everything comes in as arguments.
 *
 * @param {Map|null} equipment - Worn gear, as `dataManager.getEquipment()` returns it
 * @param {Object|null} itemDetailMap - `initClientData.itemDetailMap`
 * @param {Object|null} noncombatStats - The game's `characterData.noncombatStats`
 * @returns {{compared: number, mismatches: Array<{stat: string, ours: number, game: number}>}} Counts and
 *   the stats where ours exceeds the game's beyond rounding
 */
export function compareGearStats(equipment, itemDetailMap, noncombatStats) {
    const result = { compared: 0, mismatches: [] };
    if (!(equipment instanceof Map) || equipment.size === 0) return result;
    if (!itemDetailMap || typeof itemDetailMap !== 'object') return result;
    if (!noncombatStats || typeof noncombatStats !== 'object' || Object.keys(noncombatStats).length === 0) {
        return result;
    }

    const consider = (stat, ours, gameValue) => {
        if (!isNumber(ours) || !isNumber(gameValue)) return;
        result.compared++;
        const tolerance = Math.max(ABSOLUTE_TOLERANCE, Math.abs(gameValue) * RELATIVE_TOLERANCE);
        if (ours - gameValue > tolerance) result.mismatches.push({ stat, ours, game: gameValue });
    };

    for (const skill of SKILLS) {
        const actionType = `/action_types/${skill}`;
        const specificEfficiency = noncombatStats[`${skill}Efficiency`];
        const specificSpeed = noncombatStats[`${skill}Speed`];

        // A skill the game sent no field for is a skill it did not describe
        if (isNumber(specificEfficiency)) {
            const generic = isNumber(noncombatStats.skillingEfficiency) ? noncombatStats.skillingEfficiency : 0;
            consider(
                `${skill}Efficiency (+skillingEfficiency)`,
                parseEquipmentEfficiencyBonuses(equipment, actionType, itemDetailMap) / 100,
                specificEfficiency + generic
            );
        }
        if (isNumber(specificSpeed)) {
            const generic = isNumber(noncombatStats.skillingSpeed) ? noncombatStats.skillingSpeed : 0;
            consider(
                `${skill}Speed (+skillingSpeed)`,
                parseEquipmentSpeedBonuses(equipment, actionType, itemDetailMap),
                specificSpeed + generic
            );
        }
    }

    consider('drinkConcentration', getDrinkConcentration(equipment, itemDetailMap), noncombatStats.drinkConcentration);

    return result;
}

/**
 * Run the check for the current character, once per character per page load.
 *
 * A character is marked done only when something was actually compared, so data
 * that has not arrived yet leaves the door open for a later call.
 *
 * @returns {Array<{stat: string, ours: number, game: number}>} Mismatches found (empty when healthy,
 *   skipped, or already checked)
 */
export function runGearStatsCheck() {
    try {
        if (dataManager.isCharacterSwitching) return [];
        const characterId = dataManager.getCurrentCharacterId?.();
        if (characterId == null || checkedCharacters.has(characterId)) return [];

        const { compared, mismatches } = compareGearStats(
            dataManager.getEquipment(),
            dataManager.getInitClientData?.()?.itemDetailMap,
            dataManager.characterData?.noncombatStats
        );
        if (compared === 0) return [];
        checkedCharacters.add(characterId);

        if (mismatches.length > 0) {
            const lines = mismatches.map((m) => `${m.stat}: Toolasha ${m.ours.toFixed(4)}, game ${m.game.toFixed(4)}`);
            console.warn(
                '[GearStatsCheck] Worn-gear figures are higher than the game reports — a scale or table bug?\n' +
                    lines.join('\n')
            );
        }
        return mismatches;
    } catch (error) {
        console.error('[GearStatsCheck] The check itself failed:', error);
        return [];
    }
}

/** Forget which characters were checked (tests) */
export function _resetGearStatsCheck() {
    checkedCharacters.clear();
}

export default { compareGearStats, runGearStatsCheck };
