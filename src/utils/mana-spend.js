/**
 * Mana spend
 *
 * What your abilities cost to cast, and what that works out to per fight.
 *
 * Mana is the constraint nobody watches. Damage per second is visible in the
 * combat log; mana is visible only as the moment an ability does not fire, by
 * which point the fight has already gone differently. The figure worth having is
 * not the total — that grows all session — but **per fight**, which is stable
 * enough to compare one loadout against another.
 *
 * ## Casts are counted, costs are looked up
 *
 * The game announces a cast; it does not announce what the cast cost. So a cast
 * is a message and its cost is `abilityDetailMap[hrid].manaCost`, multiplied.
 * That means an ability the game has never described contributes casts and no
 * mana, which is reported rather than silently dropped — a mana total missing
 * one ability is worse than one that says it is incomplete.
 *
 * The model is MAna's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/**
 * A fresh tally.
 * @returns {{fights: number, byAbility: Object<string, Object>}}
 */
export function newManaTally() {
    return { fights: 0, byAbility: {} };
}

/**
 * Record one cast.
 *
 * @param {Object} tally - From `newManaTally`, mutated
 * @param {string} abilityHrid - What was cast
 * @param {number|null} manaCost - What it costs, or null when unknown
 * @returns {Object} The same tally
 */
export function recordCast(tally, abilityHrid, manaCost) {
    if (!abilityHrid) return tally;

    const entry = (tally.byAbility[abilityHrid] = tally.byAbility[abilityHrid] || {
        abilityHrid,
        casts: 0,
        mana: 0,
        // A cast whose cost nobody has told us about is not a free cast
        unknownCost: false,
    });

    entry.casts++;
    if (manaCost > 0) entry.mana += manaCost;
    else entry.unknownCost = true;

    return tally;
}

/**
 * Record that a fight began.
 * @param {Object} tally - From `newManaTally`, mutated
 * @returns {Object} The same tally
 */
export function recordFight(tally) {
    tally.fights++;
    return tally;
}

/**
 * What the tally says, per fight and in total.
 *
 * Per fight is the comparable figure: a total only says how long you have been
 * playing. With no fights recorded the per-fight figures are null rather than
 * the total, which would be a per-fight rate over a sample of zero.
 *
 * @param {Object} tally - From `newManaTally`
 * @returns {{fights: number, casts: number, mana: number, manaPerFight: number|null,
 *   castsPerFight: number|null, incomplete: boolean, abilities: Array<Object>}}
 */
export function manaSummary(tally) {
    const abilities = Object.values(tally?.byAbility || {}).map((entry) => ({
        ...entry,
        perFight: tally.fights > 0 ? entry.casts / tally.fights : null,
        manaPerFight: tally.fights > 0 ? entry.mana / tally.fights : null,
    }));

    const casts = abilities.reduce((sum, entry) => sum + entry.casts, 0);
    const mana = abilities.reduce((sum, entry) => sum + entry.mana, 0);
    const fights = tally?.fights || 0;

    return {
        fights,
        casts,
        mana,
        manaPerFight: fights > 0 ? mana / fights : null,
        castsPerFight: fights > 0 ? casts / fights : null,
        // Said out loud, because a total quietly missing an ability reads as a
        // measurement rather than as a gap
        incomplete: abilities.some((entry) => entry.unknownCost),
        abilities: abilities.sort((a, b) => b.mana - a.mana || a.abilityHrid.localeCompare(b.abilityHrid)),
    };
}
