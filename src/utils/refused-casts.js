/**
 * Casts refused for lack of mana: an estimate, counted per ability.
 *
 * The game never says "not enough mana". What it does is fixed: on its turn a unit walks its abilities in
 * slot order and takes the first one that is ready and whose trigger holds, and when that one costs more mana
 * than it has it does not fall through to a later one — it auto attacks (`combat-simulator.js`, the
 * `skipNextAbility` walk). So an auto attack chosen while an ability was ready and cost more than the bar held
 * is one cast refused: the first such ability in slot order. A ready ability the bar could pay for, passed
 * over all the same, had a trigger that did not hold, and the walk goes on past it.
 *
 * Inferred, not stated, in three ways the panel says out loud:
 * - an ability's trigger conditions are not on the wire, so an ability that was ready but whose trigger was
 *   false (and so was skipped, not refused) still counts;
 * - only an ability seen cast this run is counted, since one never cast has no cooldown to time (so a refusal
 *   of one never cast is filed under the next ready one, or nowhere);
 * - the slot order is the stated kit's (`combatAbilities`, server order) sorted by the slot numbers the
 *   caller knows, which the server does not put on `new_battle`;
 * - the cooldown is the stated base sped up by the player's ability haste from `new_battle`, the same
 *   `base × 100 / (100 + haste)` the simulator uses.
 *
 * The join is the one every tick reader here makes: a `battle_updated` entry whose attack counter rose ran the
 * action the previous reading said was being prepared (`isAutoAtk`, or `abilityHrid`). That action was chosen
 * when the counter rose before it, so readiness and the bar are judged as they stood then.
 *
 * Pure: the caller passes the wire entries, the clock and the lookups.
 */

/** @returns {Object} A fresh count */
export function newRefusalState() {
    return {
        /** Refused turns: one auto attack refused one or more abilities */
        turns: 0,
        /** Ability hrid → times it was refused */
        byAbility: {},
        /** Ability hrid → when it was last seen cast (ms) */
        lastCastAt: {},
        /** The equipped abilities, in slot order, and their haste, from the last `new_battle` */
        kit: [],
        haste: 0,
        /** The previous reading of this character's unit; null until one is known */
        previous: null,
        /** When the action now being prepared was chosen (ms), and the bar then; null when not seen */
        decisionAt: null,
        decisionMana: null,
        /** Whether a baseline reading has ever existed: until then nothing is measured, not "none refused" */
        measured: false,
    };
}

/**
 * Seed the kit and the baseline reading from this character's `new_battle` entry.
 * @param {Object} state - From {@link newRefusalState}, mutated
 * @param {Object} player - This character's entry in `new_battle.players`; null forgets the baseline
 * @param {Object} [options]
 * @param {Object<string, number>} [options.slots] - Ability hrid → slot number, where known; the kit is walked
 *   in that order, an ability with no known slot after every slotted one in the server's order
 */
export function noteRefusalBattle(state, player, { slots = {} } = {}) {
    state.decisionAt = null;
    state.decisionMana = null;
    if (!player || typeof player !== 'object') {
        state.previous = null;
        return;
    }
    const abilities = Array.isArray(player.combatAbilities) ? player.combatAbilities : [];
    const slotOf = (hrid) => (Number(slots?.[hrid]) > 0 ? Number(slots[hrid]) : Infinity);
    state.kit = abilities
        .map((entry) => entry?.abilityHrid)
        .filter((hrid) => typeof hrid === 'string' && hrid)
        .map((hrid, index) => ({ hrid, index, slot: slotOf(hrid) }))
        .sort((a, b) => a.slot - b.slot || a.index - b.index)
        .map((entry) => entry.hrid);
    const haste = Number(player.combatDetails?.combatStats?.abilityHaste);
    state.haste = Number.isFinite(haste) && haste > 0 ? haste : 0;
    const counter = Number(player.attackAttemptCounter);
    const mana = Number(player.currentManapoints ?? player.combatDetails?.currentManapoints);
    state.previous = {
        counter: Number.isFinite(counter) ? counter : null,
        auto: Boolean(player.isPreparingAutoAttack),
        abilityHrid: player.isPreparingAutoAttack ? '' : player.preparingAbilityHrid || '',
        mana: Number.isFinite(mana) ? mana : null,
    };
    state.decisionMana = state.previous.mana;
    if (state.previous.counter !== null) state.measured = true;
}

/**
 * Forget the baseline reading (a pause, a battle nothing announced), keeping the counts.
 * @param {Object} state - From {@link newRefusalState}, mutated
 */
export function forgetRefusalBaseline(state) {
    state.previous = null;
    state.decisionAt = null;
    state.decisionMana = null;
}

/**
 * Fold one `battle_updated` entry for this character.
 * @param {Object} state - From {@link newRefusalState}, mutated
 * @param {Object} entry - This character's `pMap` entry
 * @param {Object} options
 * @param {number} options.at - When it arrived (ms)
 * @param {function(string): ?{manaCost: number, cooldownMs: number}} options.abilityInfo - Stated cost and
 *   base cooldown, null when the game data does not know the ability
 * @returns {string[]} The ability this entry counted as refused, or none (most entries)
 */
export function foldRefusalTick(state, entry, { at, abilityInfo }) {
    if (!entry || typeof entry !== 'object' || !Number.isFinite(at)) return [];
    const counter = Number(entry.atkCounter);
    const mana = Number(entry.cMP);
    const previous = state.previous;
    // A tick that states neither field changes nothing about what is prepared (the game omits them on some
    // ticks, as damage-attribution's noteActions allows for), so only an explicit statement replaces it
    const statesAbility = Boolean(entry.abilityHrid);
    const statesAuto = !statesAbility && typeof entry.isAutoAtk === 'boolean';
    const keepAction = !statesAbility && !statesAuto && previous !== null;
    const next = {
        counter: Number.isFinite(counter) ? counter : (previous?.counter ?? null),
        auto: keepAction ? previous.auto : Boolean(entry.isAutoAtk) && !statesAbility,
        abilityHrid: keepAction ? previous.abilityHrid : statesAbility ? entry.abilityHrid : '',
        mana: Number.isFinite(mana) ? mana : (previous?.mana ?? null),
    };
    state.previous = next;
    if (next.counter !== null) state.measured = true;

    const acted =
        previous !== null && previous.counter !== null && next.counter !== null && next.counter > previous.counter;
    if (!acted) return [];

    // When what just ran was chosen, and the bar then; this entry is when the next action was chosen
    const chosenAt = Number.isFinite(state.decisionAt) ? state.decisionAt : at;
    const chosenMana = Number.isFinite(state.decisionMana) ? state.decisionMana : previous.mana;
    state.decisionAt = at;
    state.decisionMana = next.mana;

    if (previous.abilityHrid) {
        state.lastCastAt[previous.abilityHrid] = at;
        return [];
    }
    if (!previous.auto || !Number.isFinite(chosenMana)) return [];

    let refused = null;
    for (const hrid of state.kit) {
        const castAt = state.lastCastAt[hrid];
        if (!Number.isFinite(castAt)) continue;
        const info = abilityInfo(hrid);
        if (!info) continue;
        const base = Number(info.cooldownMs) || 0;
        const cooldown = state.haste > 0 ? (base * 100) / (100 + state.haste) : base;
        if (chosenAt - castAt < cooldown) continue;
        // Ready and affordable, yet not cast: its trigger did not hold, and the walk went on past it
        if (!(info.manaCost > chosenMana)) continue;
        refused = hrid;
        break;
    }
    if (!refused) return [];

    state.turns += 1;
    state.byAbility[refused] = (state.byAbility[refused] || 0) + 1;
    return [refused];
}

/**
 * @param {Object} state - From {@link newRefusalState}
 * @returns {{measured: boolean, turns: number, abilities: Array<{abilityHrid: string, refused: number}>}}
 *   Most refused first; `measured` false until a reading of this character's bar has existed
 */
export function refusalSummary(state) {
    const abilities = Object.entries(state.byAbility)
        .map(([abilityHrid, refused]) => ({ abilityHrid, refused }))
        .sort((a, b) => b.refused - a.refused);
    return { measured: state.measured, turns: state.turns, abilities };
}
