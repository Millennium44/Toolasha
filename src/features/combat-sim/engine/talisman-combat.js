import {
    getBeltSlotCount,
    getTalismanPower,
    scaleTalismanModifier,
    talismanStatName,
} from '../../../utils/talisman-bonuses.js';

/** The `talismanModifierDetailMap` target of the lines that change a combat stat */
const TARGET_COMBAT = '/talisman_modifier_targets/combat_stat';

/**
 * The talisman-only mechanics: lines that are not a gear stat. They are carried on the player
 * (`player.talismanMechanics`) and the fight models them: Smite and Shatter and Overkill in
 * `CombatUtilities.processAttack`, Echo and Fortify in the simulator.
 */
export const TALISMAN_MECHANICS = Object.freeze(['echo', 'smite', 'shatter', 'fortify', 'overkill']);

/**
 * The combat lines of a sim player's talismans, scaled by the belt it wears.
 *
 * A line's value is `gradeValues[grade - 1] * (1 + talismanPower)`, the same arithmetic the server uses for the
 * `combatStats` it sends (checked against a live character: criticalDamage grade 3 is 0.03 * 1.258). Lines that
 * name the same stat add up. A slot the belt does not have is ignored, and so is a second record in one slot.
 *
 * Applied only when the game data payload says talismans exist (`gameData.talismansEnabled`, which the main
 * thread sets from the host): the engine runs in a worker, where the host is not visible, and a build saved on
 * the test server must not carry talismans onto the live one.
 *
 * @param {Object} params
 * @param {Array<{slotIndex: number, modifiers: Array<{hrid: string, grade: number}>}>|null} params.talismans
 * @param {{hrid: string, enhancementLevel?: number}|null} params.belt - The worn belt, an Equipment
 * @param {Object} params.gameData - The engine's game data (itemDetailMap, talismanModifierDetailMap, ...)
 * @param {Set<string>} params.modeledStats - The stat names the engine reads
 * @returns {{stats: Object, mechanics: Object, unmodeled: Object}} Stat name to total. `stats` holds the
 *   modeled stats, `mechanics` the five talisman-only ones, `unmodeled` any other name (none today)
 */
export function computeTalismanCombat({ talismans, belt, gameData, modeledStats }) {
    const result = { stats: {}, mechanics: {}, unmodeled: {} };
    if (!gameData?.talismansEnabled) return result;
    if (!belt?.hrid || !Array.isArray(talismans) || talismans.length === 0) return result;
    const modifierDetailMap = gameData.talismanModifierDetailMap;
    const itemDetailMap = gameData.itemDetailMap;
    if (!modifierDetailMap || !itemDetailMap) return result;

    const beltRef = { itemHrid: belt.hrid, enhancementLevel: belt.enhancementLevel || 0 };
    const slots = getBeltSlotCount(beltRef, itemDetailMap);
    if (slots === 0) return result;
    const power = getTalismanPower(beltRef, itemDetailMap, gameData.enhancementLevelTotalBonusMultiplierTable);

    const seenSlots = new Set();
    for (const talisman of talismans) {
        const slot = talisman?.slotIndex;
        if (!Number.isInteger(slot) || slot < 1 || slot > slots || seenSlots.has(slot)) continue;
        seenSlots.add(slot);
        // A saved or imported build can hold anything here; a non-list is no lines
        if (!Array.isArray(talisman.modifiers)) continue;
        for (const modifier of talisman.modifiers) {
            const scaled = scaleTalismanModifier(modifier, modifierDetailMap, power);
            if (!scaled || scaled.detail.targetHrid !== TARGET_COMBAT) continue;
            for (const key of scaled.detail.keys || []) {
                const name = talismanStatName(key);
                const into = TALISMAN_MECHANICS.includes(name)
                    ? result.mechanics
                    : modeledStats?.has(name)
                      ? result.stats
                      : result.unmodeled;
                into[name] = (into[name] || 0) + scaled.value;
            }
        }
    }
    return result;
}
