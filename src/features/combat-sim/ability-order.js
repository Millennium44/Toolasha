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

/** Ability slots a combat loadout has: the special slot, then four ordinary ones */
export const ABILITY_SLOT_COUNT = 5;

/**
 * Which ability slots a loadout can use. A slot opens at a base Intelligence level the game lists per slot
 * (`abilitySlotsLevelRequirementList`); an Intelligence bonus from gear or tea does not open one. The list is read
 * by the game's slot number: the list has an unused entry 0, so the ability bar's slot `i` (0 the special slot, as
 * `fillAbilities` lays it out) reads entry `i + 1`. Without the list or the player's Intelligence nothing is locked,
 * and a DTO marked `intelligenceUnknown` (an import or profile that never carried the level; its 1 is only the
 * simulation's default) has nothing locked either.
 * @param {Object} playerDTO - Player DTO with `intelligenceLevel`
 * @param {Object} gameData - Game data payload
 * @returns {boolean[]} One flag per slot, true where the slot is open
 */
export function abilitySlotUnlocks(playerDTO, gameData) {
    const list = gameData?.abilitySlotsLevelRequirementList;
    const level = playerDTO?.intelligenceUnknown ? NaN : Number(playerDTO?.intelligenceLevel);
    return Array.from({ length: ABILITY_SLOT_COUNT }, (_, index) => {
        const required = Array.isArray(list) ? Number(list[index + 1]) : NaN;
        return !Number.isFinite(required) || !Number.isFinite(level) || level >= required;
    });
}

/**
 * Move the ability in an ordinary slot one place up or down, swapping it with its neighbor.
 *
 * The slot order is the casting order: the engine casts the first ability whose trigger fires, and if that one
 * cannot be afforded (`skipNextAbility`) the later slots are blocked for that tick. So this is a
 * re-ordering and nothing else: each entry is carried whole, which keeps its level and its trigger rows with it.
 * Slot 0 is the special (aura) slot, which holds only a special ability, so it never moves and nothing moves into
 * it. A slot the Intelligence level has not opened is not entered or left either, as the game would not allow it.
 * An empty neighbor takes the swap, which moves the ability into the free slot.
 *
 * @param {Array<Object|null>} abilities - The loadout's ability slots (not mutated)
 * @param {number} slotIndex - The slot to move from
 * @param {number} direction - -1 toward the front (cast earlier), +1 toward the back
 * @param {boolean[]} [unlocked] - From {@link abilitySlotUnlocks}; a missing entry counts as open
 * @returns {{abilities: Array<Object|null>, moved: boolean, reason: string}} `reason` is '' when moved, else one of
 *   'invalid', 'special', 'empty', 'limit', 'locked'
 */
export function moveAbilitySlot(abilities, slotIndex, direction, unlocked = []) {
    const list = Array.isArray(abilities) ? abilities.slice() : [];
    const refuse = (reason) => ({ abilities: list, moved: false, reason });
    if (!Number.isInteger(slotIndex) || (direction !== -1 && direction !== 1)) return refuse('invalid');
    if (slotIndex === 0) return refuse('special');
    if (slotIndex < 0 || slotIndex >= ABILITY_SLOT_COUNT || !list[slotIndex]) return refuse('empty');
    const target = slotIndex + direction;
    if (target < 1 || target >= ABILITY_SLOT_COUNT) return refuse('limit');
    if (unlocked[slotIndex] === false || unlocked[target] === false) return refuse('locked');
    while (list.length <= target) list.push(null);
    [list[slotIndex], list[target]] = [list[target], list[slotIndex]];
    return { abilities: list, moved: true, reason: '' };
}
