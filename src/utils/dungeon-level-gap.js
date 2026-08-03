/**
 * The level gap debuff
 *
 * A character fighting alongside people far above their level takes a penalty to
 * what drops for them. It starts once somebody in the party is 20% above them
 * and deepens fast: three points of penalty for every point of ratio past that,
 * capped at 90%.
 *
 * ## Why this is its own file
 *
 * The formula lived inside the simulator's party builder, where it was applied
 * to per-monster drops and to nothing else. The live drop model — the one behind
 * Party Luck and the Drop Luck tile — did not have it at all, so the two
 * disagreed about the same party: the simulator would predict a level-gapped
 * player taking a fraction of the loot, and the panel measuring that same player
 * afterwards would call them unlucky for it.
 *
 * Shared here so they cannot drift apart again. The simulator imports it rather
 * than keeping its copy.
 *
 * ## What it deliberately does not claim
 *
 * **Whether this is what reduces a dungeon's chests, and by how much.** The
 * simulator applies the debuff to per-monster drops and leaves the chest line
 * alone, and a dungeon can visibly pay a low-level character nothing at all —
 * which a 90% cap cannot produce. So the two are not obviously the same
 * mechanic, and guessing a chest multiplier from a monster-drop formula would
 * produce a confident number with nothing behind it.
 *
 * What the caller gets is the gap itself. What to do with it — here, suppress a
 * luck verdict that would otherwise blame the player for their party — is the
 * caller's decision, and the honest one while the chest penalty is unmeasured.
 */

/** Below this ratio between the party's top level and yours there is no penalty */
export const LEVEL_GAP_RATIO = 1.2;

/** However far below the party you are, the penalty stops here */
export const MAX_LEVEL_GAP_DEBUFF = 0.9;

/**
 * One character's penalty for being below the party.
 *
 * @param {number} level - Their combat level
 * @param {number} topLevel - The highest combat level in the party
 * @returns {number|null} A negative fraction, 0 for no penalty, or null when a
 *   level was not available — which is not the same as no penalty and should not
 *   be shown as one
 */
export function levelGapDebuff(level, topLevel) {
    if (!(level > 0) || !(topLevel > 0)) return null;

    const ratio = topLevel / level;
    if (ratio <= LEVEL_GAP_RATIO) return 0;

    // Floored to whole percent before scaling, matching the game's own rounding —
    // an unfloored version drifts by a fraction of a percent at every ratio
    const levelPercent = Math.floor((ratio - LEVEL_GAP_RATIO) * 100) / 100;
    return -Math.min(MAX_LEVEL_GAP_DEBUFF, 3 * levelPercent);
}

/**
 * Every party member's penalty, measured against whoever is highest.
 *
 * @param {Array<number|null>} levels - Combat levels, in party order
 * @returns {Array<number|null>} Debuffs in the same order
 */
export function partyLevelGaps(levels) {
    const known = (levels || []).filter((level) => level > 0);

    // Alone there is nobody to be below, and with no levels at all there is
    // nothing to measure against — either way, no penalty rather than a guess
    if (known.length < 2) return (levels || []).map((level) => (level > 0 ? 0 : null));

    const topLevel = Math.max(...known);
    return levels.map((level) => levelGapDebuff(level, topLevel));
}

/**
 * Whether a penalty is big enough that a luck reading would be about it.
 *
 * A percentile computed against a full share is a verdict on the player's gear
 * when the player is actually being penalised for their party. Better to say
 * which it is.
 *
 * @param {number|null} debuff - From `levelGapDebuff`
 * @returns {boolean}
 */
export function isLevelGapped(debuff) {
    return typeof debuff === 'number' && debuff < 0;
}
