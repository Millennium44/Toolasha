/**
 * Character ability reconciliation.
 *
 * The equipped kit is not something the client is ever handed whole after login.
 * `init_character_data` carries `combatUnit.combatAbilities` once, and from then
 * on the server sends deltas: `abilities_updated` with an `endCharacterAbilities`
 * array where `slotNumber > 0` means "this ability now sits in that slot" and
 * `slotNumber <= 0` means "this ability is no longer equipped". Only the rows
 * that changed are sent, so the update has to be applied against the current
 * list rather than replacing it.
 *
 * Two things make a naive merge wrong, and both are what leaves a stale kit on
 * screen after the labyrinth (which swaps loadouts between rooms):
 *
 * - An unequip is a row, not an absence. Dropping rows whose `slotNumber` is 0
 *   instead of removing the matching ability leaves the old ability equipped.
 * - A slot holds one ability. When a new ability claims a slot, whatever was in
 *   that slot has to leave even if the server did not bother to say so.
 *
 * The helpers are pure so the message sequence can be replayed in a test.
 */

/**
 * The learned-ability list with an update applied.
 *
 * This is the list that carries experience, so entries are merged field by field
 * rather than replaced — an update that only reports a level must not erase the
 * experience already known for that ability.
 *
 * @param {Array<Object>} owned - Current `characterAbilities` (not mutated)
 * @param {Array<Object>} updates - `endCharacterAbilities` from the message
 * @returns {Array<Object>} New list
 */
export function mergeOwnedAbilities(owned, updates) {
    const next = (Array.isArray(owned) ? owned : []).map((entry) => ({ ...entry }));
    if (!Array.isArray(updates)) return next;

    for (const update of updates) {
        const hrid = update?.abilityHrid;
        if (!hrid) continue;

        const index = next.findIndex((entry) => entry?.abilityHrid === hrid);
        if (index !== -1) {
            next[index] = { ...next[index], ...update };
        } else {
            next.push({ ...update });
        }
    }

    return next;
}

/**
 * The equipped kit with an `endCharacterAbilities` delta applied.
 *
 * An update with no `slotNumber` at all is treated as progress on an ability
 * that is already equipped, never as an equip: `action_completed` reports
 * experience the same way and appending those rows would fill the kit with
 * abilities the character is not actually using.
 *
 * Ordering is left alone unless every surviving entry carries a slot number, in
 * which case the array is sorted by it. The initial list from
 * `init_character_data` may not number its slots, and inventing numbers for it
 * would risk colliding with the server's own numbering — so entries already
 * present keep their position and new ones are appended.
 *
 * @param {Array<Object>} current - Current `combatUnit.combatAbilities` (not mutated)
 * @param {Array<Object>} updates - `endCharacterAbilities` from the message
 * @returns {Array<Object>} New equipped list
 */
export function reconcileEquippedAbilities(current, updates) {
    let next = (Array.isArray(current) ? current : [])
        .filter((entry) => entry?.abilityHrid)
        .map((entry) => ({ ...entry }));

    if (!Array.isArray(updates)) return next;

    for (const update of updates) {
        const hrid = update?.abilityHrid;
        if (!hrid) continue;

        const slot = Number(update.slotNumber);
        const hasSlot = Number.isFinite(slot);
        const index = next.findIndex((entry) => entry.abilityHrid === hrid);

        // An explicit non-positive slot is an unequip, and is the only thing
        // that ever removes an ability from the kit
        if (hasSlot && !(slot > 0)) {
            if (index !== -1) next.splice(index, 1);
            continue;
        }

        if (index !== -1) {
            next[index] = { ...next[index], ...update };
        } else if (hasSlot && slot > 0) {
            next.push({ ...update });
        } else {
            // Progress on an ability that is not equipped — nothing to do here
            continue;
        }

        // One ability per slot: whatever else claimed this one has been displaced
        if (hasSlot && slot > 0) {
            next = next.filter((entry) => entry.abilityHrid === hrid || Number(entry.slotNumber) !== slot);
        }
    }

    const allSlotted = next.every((entry) => Number(entry.slotNumber) > 0);
    if (allSlotted) {
        next.sort((a, b) => Number(a.slotNumber) - Number(b.slotNumber));
    }

    return next;
}

/**
 * Level and experience applied to a kit without touching which abilities are in it.
 *
 * `action_completed` reports ability experience during a fight. Those rows are
 * progress only — running them through the slot reconciler would let an
 * experience tick reshuffle the kit.
 *
 * @param {Array<Object>} current - Current equipped list (not mutated)
 * @param {Array<Object>} updates - `endCharacterAbilities` from the message
 * @returns {Array<Object>} New equipped list, same abilities in the same order
 */
export function applyAbilityProgress(current, updates) {
    const next = (Array.isArray(current) ? current : []).map((entry) => ({ ...entry }));
    if (!Array.isArray(updates)) return next;

    for (const update of updates) {
        const hrid = update?.abilityHrid;
        if (!hrid) continue;

        const index = next.findIndex((entry) => entry?.abilityHrid === hrid);
        if (index === -1) continue;

        if (update.level !== undefined) next[index].level = update.level;
        if (update.experience !== undefined) next[index].experience = update.experience;
    }

    return next;
}

/**
 * The kit the server says it is fighting with, from a `new_battle` message.
 *
 * This is the one place the equipped list arrives whole rather than as a delta,
 * which makes it the backstop for any ability change that reached the client
 * through a message shape nothing here recognises.
 *
 * @param {Object} battle - `new_battle` message
 * @param {Object} [identity]
 * @param {string|number} [identity.characterId] - Own character id
 * @param {string} [identity.characterName] - Own character name
 * @returns {Array<Object>|null} Equipped abilities, or null when the message is not about us
 */
export function equippedAbilitiesFromBattle(battle, { characterId, characterName } = {}) {
    const players = Array.isArray(battle?.players) ? battle.players : [];
    if (players.length === 0) return null;

    const me = players.find(
        (player) =>
            (characterId !== null && characterId !== undefined && player?.character?.id === characterId) ||
            (characterName && player?.character?.name === characterName)
    );

    const abilities = me?.combatDetails?.combatAbilities;
    if (!Array.isArray(abilities)) return null;

    return abilities.filter((entry) => entry?.abilityHrid).map((entry) => ({ ...entry }));
}

/**
 * Whether two equipped kits differ in anything worth telling a listener about.
 * @param {Array<Object>} a - One kit
 * @param {Array<Object>} b - The other
 * @returns {boolean} True when the abilities or their levels differ
 */
export function abilityKitsDiffer(a, b) {
    const signature = (list) =>
        (Array.isArray(list) ? list : [])
            .map((entry) => `${entry?.abilityHrid}@${entry?.level ?? 0}`)
            .sort()
            .join('|');
    return signature(a) !== signature(b);
}
