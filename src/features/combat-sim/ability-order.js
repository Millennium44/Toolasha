/**
 * Ability-order helpers shared by the Lab's ability-order check and the Combat
 * Sim upgrade analyzer's "Ability order" set. No imports, so both can use it
 * without a circular dependency on the upgrade advisor.
 *
 * @module ability-order
 */

/** The queued "Ability order" check: not an ability, but kept in the same queue (it starts with the ability prefix) */
export const ABILITY_ORDER_HRID = '/abilities/__order__';

/**
 * Hrids of the abilities that have no cooldown (always ready).
 * @param {Object} gameData - Game data payload
 * @returns {string[]}
 */
export function zeroCooldownAbilities(gameData) {
    return Object.entries(gameData?.abilityDetailMap || {})
        .filter(([, detail]) => detail?.cooldownDuration === 0)
        .map(([hrid]) => hrid);
}

/**
 * Every order a set of ordinary abilities may be cast in: the ones with a
 * cooldown in any order, then the always-ready ones (no cooldown) in any order,
 * since the game casts the first ready ability in slot order and anything after
 * an always-ready one never gets to cast.
 * @param {string[]} hrids - The ordinary abilities, current order
 * @param {Set<string>|string[]} zeroCooldown - Ability hrids with no cooldown
 * @returns {string[][]} Every consistent order, including the current one if it is consistent
 */
export function consistentAbilityOrders(hrids, zeroCooldown) {
    const zero = new Set(zeroCooldown);
    const permutations = (items) =>
        items.length <= 1
            ? [items]
            : items.flatMap((item, i) =>
                  permutations([...items.slice(0, i), ...items.slice(i + 1)]).map((rest) => [item, ...rest])
              );
    const cooling = permutations(hrids.filter((hrid) => !zero.has(hrid)));
    const ready = permutations(hrids.filter((hrid) => zero.has(hrid)));
    return cooling.flatMap((front) => ready.map((back) => [...front, ...back]));
}
