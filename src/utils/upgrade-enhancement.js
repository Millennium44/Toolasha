/**
 * Enhancement carried through an upgrade craft.
 *
 * Crafting an upgrade item (a recipe with an `upgradeItemHrid`) from an enhanced copy carries
 * part of that copy's level to the output. The game's own recipe panel states the rule: "70% of
 * enhancement levels transferred. Decimals grant chance of 1 extra level", and for a recipe
 * flagged `retainAllEnhancement` (refining) "All enhancement levels transferred". The panel
 * shows `floor(0.7 × level)`; the fractional part is the chance of one more level.
 *
 * Rule adapted from Milkonomy by luyh7 (MIT) - `src/calculator/manufacture.ts`, `targetLevel` and
 * `productList` - and checked against the game client's recipe panel. See
 * docs/THIRD-PARTY-LICENSES.md.
 */

/**
 * The levels an upgrade craft can output and how likely each is.
 *
 * @param {number} inputLevel - Enhancement level of the upgrade item consumed
 * @param {Object} [options]
 * @param {boolean} [options.retainAll=false] - The recipe keeps the full level (`retainAllEnhancement`)
 * @returns {Array<{level: number, weight: number}>} One entry for a whole target level, two
 *   (floor and ceil) when the target has a fractional part; weights sum to 1
 */
export function upgradeOutputLevels(inputLevel, { retainAll = false } = {}) {
    const level = Number.isFinite(inputLevel) && inputLevel > 0 ? inputLevel : 0;
    if (level === 0) return [{ level: 0, weight: 1 }];
    if (retainAll) return [{ level, weight: 1 }];

    // Two decimals, as the 70% of a whole level only ever has one and float noise should not
    // turn 2.1 into 2.0999999 and a chance of 0.0999999
    const target = Math.round(level * 0.7 * 100) / 100;
    const floor = Math.floor(target);
    const chanceUp = Math.round((target - floor) * 100) / 100;
    if (chanceUp === 0) return [{ level: floor, weight: 1 }];
    return [
        { level: floor, weight: 1 - chanceUp },
        { level: floor + 1, weight: chanceUp },
    ];
}
