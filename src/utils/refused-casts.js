/**
 * Casts refused for lack of mana: an estimate, counted per ability.
 *
 * The game never says "not enough mana". What it does is fixed: on its turn a unit walks its abilities in
 * slot order and takes the first one that is ready, and when that one costs more mana than it has it does not
 * fall through to a cheaper one — it auto attacks (`combat-simulator.js`, the `skipNextAbility` walk). So an
 * auto attack made while an ability the player uses was off cooldown and cost more than the bar held is a cast
 * the bar refused.
 *
 * Inferred, not stated, in three ways the panel says out loud:
 * - an ability's trigger conditions are not on the wire, so an ability that was ready but whose trigger was
 *   false (and so was skipped, not refused) still counts;
 * - only an ability seen cast this run is counted, since one never cast has no cooldown to time;
 * - the cooldown is the stated base sped up by the player's ability haste from `new_battle`, the same
 *   `base × 100 / (100 + haste)` the simulator uses.
 *
 * The join is the one every tick reader here makes: a `battle_updated` entry whose attack counter rose ran the
 * action the previous reading said was being prepared (`isAutoAtk`, or `abilityHrid`), and the mana before
 * paying is the previous reading's `cMP`.
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
    };
}

/**
 * Seed the kit and the baseline reading from this character's `new_battle` entry.
 * @param {Object} state - From {@link newRefusalState}, mutated
 * @param {Object} player - This character's entry in `new_battle.players`; null forgets the baseline
 */
export function noteRefusalBattle(state, player) {
    if (!player || typeof player !== 'object') {
        state.previous = null;
        return;
    }
    const abilities = Array.isArray(player.combatAbilities) ? player.combatAbilities : [];
    state.kit = abilities.map((entry) => entry?.abilityHrid).filter((hrid) => typeof hrid === 'string' && hrid);
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
}

/**
 * Forget the baseline reading (a pause, a battle nothing announced), keeping the counts.
 * @param {Object} state - From {@link newRefusalState}, mutated
 */
export function forgetRefusalBaseline(state) {
    state.previous = null;
}

/**
 * Fold one `battle_updated` entry for this character.
 * @param {Object} state - From {@link newRefusalState}, mutated
 * @param {Object} entry - This character's `pMap` entry
 * @param {Object} options
 * @param {number} options.at - When it arrived (ms)
 * @param {function(string): ?{manaCost: number, cooldownMs: number}} options.abilityInfo - Stated cost and
 *   base cooldown, null when the game data does not know the ability
 * @returns {string[]} The abilities this entry counted as refused (empty for most)
 */
export function foldRefusalTick(state, entry, { at, abilityInfo }) {
    if (!entry || typeof entry !== 'object' || !Number.isFinite(at)) return [];
    const counter = Number(entry.atkCounter);
    const mana = Number(entry.cMP);
    const previous = state.previous;
    const next = {
        counter: Number.isFinite(counter) ? counter : (previous?.counter ?? null),
        auto: Boolean(entry.isAutoAtk),
        abilityHrid: entry.isAutoAtk ? '' : entry.abilityHrid || '',
        mana: Number.isFinite(mana) ? mana : (previous?.mana ?? null),
    };
    state.previous = next;

    const acted =
        previous !== null && previous.counter !== null && next.counter !== null && next.counter > previous.counter;
    if (!acted) return [];

    if (previous.abilityHrid) {
        state.lastCastAt[previous.abilityHrid] = at;
        return [];
    }
    if (!previous.auto || !Number.isFinite(previous.mana)) return [];

    const refused = [];
    for (const hrid of state.kit) {
        const castAt = state.lastCastAt[hrid];
        if (!Number.isFinite(castAt)) continue;
        const info = abilityInfo(hrid);
        if (!info || !(info.manaCost > previous.mana)) continue;
        const base = Number(info.cooldownMs) || 0;
        const cooldown = state.haste > 0 ? (base * 100) / (100 + state.haste) : base;
        if (at - castAt >= cooldown) refused.push(hrid);
    }
    if (!refused.length) return [];

    state.turns += 1;
    for (const hrid of refused) state.byAbility[hrid] = (state.byAbility[hrid] || 0) + 1;
    return refused;
}

/**
 * @param {Object} state - From {@link newRefusalState}
 * @returns {{turns: number, abilities: Array<{abilityHrid: string, refused: number}>}} Most refused first
 */
export function refusalSummary(state) {
    const abilities = Object.entries(state.byAbility)
        .map(([abilityHrid, refused]) => ({ abilityHrid, refused }))
        .sort((a, b) => b.refused - a.refused);
    return { turns: state.turns, abilities };
}
