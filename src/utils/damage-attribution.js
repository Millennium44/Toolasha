/**
 * Damage attribution
 *
 * Who hit what, derived from a payload that never says.
 *
 * `battle_updated` carries every unit's current state and no events. Working out
 * that "Bob crit the rat for 4,120" from two of those snapshots is the whole
 * problem, and there is no attribution field to read — the trick is elsewhere.
 *
 * ## An attack counter identifies the attacker
 *
 * Each player carries `atkCounter`, and it goes up when they attack. Across two
 * recorded runs it rose on **every** tick that dealt damage — sixty-nine of
 * sixty-nine — which makes it the join between a player and a monster's lost
 * health.
 *
 * It replaced mana, which was the original answer and a weaker one: only an
 * ability costs mana, so `cMP` falling identified the actor on eight of those
 * sixty-nine ticks. Mana is kept below the counter, for a payload that carries
 * no counter and for the tick where two people act at once and one of them cast.
 *
 * **In a party of two this changed nothing**, and it took five to show why it
 * mattered. `pMap` is a delta exactly as `mMap` is, so a character who did
 * nothing is not in the tick, and with two people "the only one here must be
 * them" is usually right — the old and new rules pick the same character on all
 * 137 damage ticks of a recorded pair.
 *
 * With five, one person tanks. The character a tick is about is then very often
 * the one being **hit**, not the one attacking: on 82 of 440 damage ticks the
 * lone character in the tick was there because their own health and damage
 * counter had moved. Crediting them handed 8,500 points of other people's
 * damage to whoever was holding aggro. That rung is now "the last character to
 * swing", because a swing and its damage are not always in the same tick —
 * 76 of those 82 had somebody else swinging one real tick earlier.
 *
 * ## Every payload arrives twice
 *
 * 757 of 1,465 `battle_updated` messages in that recording are byte-identical to
 * the one before. Nothing here has to care — a duplicate diffs to no change and
 * produces no events — but it is why the swing behind a hit looks two ticks back
 * rather than one.
 *
 * ## A counter distinguishes a hit from a tick
 *
 * Health falling is not sufficient — bleeds and regeneration move it too. A hit
 * is `dmgCounter` **rising**, and a crit is `critCounter` rising. Which also
 * gives the one case a health diff can never express: `dmgCounter` up with the
 * health unchanged is a **miss**, not a non-event.
 *
 * ## What it deliberately does not do
 *
 * It does not guess. A tick where several players act at once falls back to the
 * last mana drop, because the payload cannot separate them — and a tick that
 * names nobody at all credits nobody rather than the wrong body.
 *
 * The model is DPs' and the Floating Combat Text tool's, from MWI Combat Suite
 * by Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The code is Toolasha's own.
 */

/**
 * A fresh set of the counters a tick is measured against.
 * @returns {Object}
 */
export function newAttributionState() {
    return {
        playersMP: {},
        playersAtk: {},
        party: {},
        lastSwing: null,
        monstersHP: {},
        dmgCounter: {},
        critCounter: {},
        actions: {},
    };
}

/**
 * Note what each player is preparing, so a hit can be labelled with an ability.
 *
 * The ability when one is mid-cast, `auto` when it is an auto-attack, and
 * `idle` otherwise — the same three cases MCS distinguishes, and what the
 * non-damaging filter keys off.
 *
 * ## Two spellings of the same field
 *
 * `new_battle` writes `preparingAbilityHrid` and `isPreparingAutoAttack`; the
 * per-tick `battle_updated` abbreviates them to `abilityHrid` and `isAutoAtk`.
 * Reading only the long pair means the label is whatever was being prepared
 * when the battle began and never changes again — which credits the entire
 * fight to one ability, and to the wrong one at that.
 *
 * ## When to call it
 *
 * **After attributing a tick, not before.** The hit that lands on a tick was
 * cast by what was being prepared *before* it; by the time the payload arrives
 * the player has already begun the next thing. Updating first credits every hit
 * to the ability that follows it.
 *
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} players - A `new_battle` player list or a tick's `pMap`
 */
export function noteActions(state, players) {
    for (const [index, player] of Object.entries(players || {})) {
        // A `new_battle` carries the whole roster, which is the only place the
        // party's size is stated — and it is what tells a solo run apart from a
        // party where one member happens to be alone in this tick
        state.party[index] = true;
        const ability = player?.preparingAbilityHrid || player?.abilityHrid;
        const auto = player?.isPreparingAutoAttack || player?.isAutoAtk;

        state.actions[index] = ability ? ability : auto ? 'auto' : 'idle';
    }
}

/**
 * Which player acted this tick.
 *
 * @param {Object} pMap - This tick's players
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - `{soloFallback}`; see below
 * @param {boolean} [options.soloFallback] - Whether "only one character is known, so it was them"
 *   may be used. True for this client's own fights, where the party is genuinely known from
 *   `new_battle`. **False for a spectated guild trial**, where `pMap` is the only roster there is
 *   and a delta that has so far shown one person means one person has *moved*, not that one person
 *   is there — crediting them would hand the whole boss's health to whoever was being hit
 * @returns {string|null} The player index, or null when nobody can be identified
 */
export function findCaster(pMap, state, { soloFallback = true } = {}) {
    const indices = Object.keys(pMap || {});
    const swung = [];
    const spent = [];

    for (const index of indices) {
        const player = pMap[index];

        const attacks = Number(player?.atkCounter);
        const attacksBefore = state.playersAtk[index];
        if (Number.isFinite(attacks)) {
            if (attacksBefore !== undefined && attacks > attacksBefore) swung.push(index);
            state.playersAtk[index] = attacks;
        }

        const mana = Number(player?.cMP);
        if (Number.isFinite(mana)) {
            const before = state.playersMP[index];
            if (before !== undefined && mana < before) spent.push(index);
            state.playersMP[index] = mana;
        }
    }

    // `atkCounter` is what it sounds like, and it almost always names one person:
    // in a five-character party, two of them swung on the same tick three times
    // in fourteen hundred, one of which dealt damage. Rare enough to identify
    // by, not so rare that the tie can be pretended away.
    if (swung.length === 1) {
        state.lastSwing = swung[0];
        return swung[0];
    }

    // Two people acting at once. Mana at least separates a cast from a swing,
    // which is the older and worse answer rather than no answer.
    if (spent.length) return spent[spent.length - 1];

    // Nobody else it could have been. This is the rung that carries a solo run
    // on a payload with no attack counter at all — and the one rung a spectated
    // trial must not use, because there the party is not known.
    if (soloFallback) {
        const party = Object.keys(state.party);
        if (party.length === 1) return party[0];
        if (!party.length && indices.length === 1) return indices[0];
    }

    // The last character to swing. A swing and the damage it does are not always
    // in the same tick — see the note above — and the person the tick *is* about
    // is usually the one being hit, which is who this used to credit.
    return state.lastSwing;
}

/**
 * The hits in one tick.
 *
 * @param {Object} tick - A `battle_updated` payload
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - Passed to {@link findCaster}; `{soloFallback}`
 * @returns {Array<Object>} Hits as
 *   `{playerIndex, monsterIndex, amount, isCrit, isMiss, isHeal, action}`, and
 *   deaths as `{monsterIndex, isKill}` — the two are separate events because a
 *   bleed can land the killing blow on a tick where no counter moved
 */
export function attributeTick(tick, state, options) {
    const { mMap, pMap } = tick || {};
    const caster = findCaster(pMap, state, options);
    const events = [];

    for (const [index, monster] of Object.entries(mMap || {})) {
        const health = Number(monster?.currentHitpoints ?? monster?.cHP);
        if (!Number.isFinite(health)) continue;

        const beforeHealth = state.monstersHP[index];
        const beforeDamage = state.dmgCounter[index];
        const beforeCrits = state.critCounter[index];

        const damageCount = Number(monster?.dmgCounter) || 0;
        const critCount = Number(monster?.critCounter) || 0;

        state.monstersHP[index] = health;
        state.dmgCounter[index] = damageCount;
        state.critCounter[index] = critCount;

        // First sighting of a monster is not a hit for its entire health bar
        if (beforeHealth === undefined) continue;

        // A death is its own event, separate from the hit that caused it.
        // Merging the two would lose every kill landed by a bleed — the health
        // reaches zero on a tick where no counter moved — and a kill counted
        // only when a hit lands undercounts exactly the fights that take
        // longest, which are the ones worth measuring.
        if (beforeHealth > 0 && health <= 0) {
            events.push({ monsterIndex: index, isKill: true });
        }

        // A hit is the counter rising. Health falling on its own is a bleed or
        // a tick of something, and crediting it to whoever last cast would
        // hand a damage-over-time effect to the wrong ability.
        const hit = beforeDamage !== undefined && damageCount > beforeDamage;
        if (!hit) continue;
        if (caster === null) continue;

        const change = beforeHealth - health;
        events.push({
            playerIndex: caster,
            monsterIndex: index,
            amount: Math.abs(change),
            isCrit: beforeCrits !== undefined && critCount > beforeCrits,
            // The one case a health diff cannot express on its own
            isMiss: change === 0,
            isHeal: change < 0,
            action: state.actions[caster] || 'idle',
        });
    }
    return events;
}

/** Abilities that deal no damage, so a hit credited during one is not theirs */
const NON_DAMAGING = new Set(['idle']);

/**
 * Whether an action should count towards damage.
 *
 * @param {string} action - From an event
 * @param {Set<string>} [nonDamaging] - Ability hrids known to deal no damage
 * @returns {boolean}
 */
export function isDamagingAction(action, nonDamaging = NON_DAMAGING) {
    return !nonDamaging.has(action);
}

/**
 * Fold events into a per-player tally.
 *
 * @param {Object} tally - `{}` or a previous return, mutated
 * @param {Array<Object>} events - From `attributeTick`
 * @param {Object} [options] - `{filterNonDamaging, nonDamaging, nameOf}`. `nameOf`
 *   turns a monster index into a name; without it the per-enemy split is skipped.
 * @returns {Object} Player index → `{damage, hits, crits, misses, byAbility, byEnemy}`
 */
export function foldEvents(tally, events, { filterNonDamaging = true, nonDamaging, nameOf } = {}) {
    for (const event of events || []) {
        // A death is not a swing, and counting it as one would add a phantom
        // hit to whoever happened to be casting
        if (event.isKill) continue;

        const player = (tally[event.playerIndex] = tally[event.playerIndex] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
            byAbility: {},
            byEnemy: {},
        });

        // Counted before the filter: a miss is a swing that happened, and
        // dropping it would flatter the hit rate of whatever was cast
        if (event.isMiss) player.misses++;
        if (filterNonDamaging && !isDamagingAction(event.action, nonDamaging)) continue;

        if (!event.isMiss && !event.isHeal) {
            player.damage += event.amount;
            player.hits++;
            if (event.isCrit) player.crits++;
        }

        const ability = (player.byAbility[event.action] = player.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });
        if (event.isMiss) ability.misses++;
        else if (!event.isHeal) {
            ability.damage += event.amount;
            ability.hits++;
            if (event.isCrit) ability.crits++;
        }

        // The same split again, by what was being hit rather than by what was
        // swung. A party's enemy rows belong under the player who fought them —
        // one player kiting while another burns the boss is two different
        // fights, and a party-wide enemy total averages them into neither.
        const name = nameOf ? nameOf(event.monsterIndex) : null;
        if (!name) continue;

        const enemy = (player.byEnemy[name] = player.byEnemy[name] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
            byAbility: {},
        });
        const against = (enemy.byAbility[event.action] = enemy.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });

        if (event.isMiss) {
            enemy.misses++;
            against.misses++;
        } else if (!event.isHeal) {
            enemy.damage += event.amount;
            enemy.hits++;
            against.damage += event.amount;
            against.hits++;
            if (event.isCrit) {
                enemy.crits++;
                against.crits++;
            }
        }
    }
    return tally;
}

/**
 * Fold events into a per-monster tally.
 *
 * The player table answers "who is doing the damage". This answers "to what",
 * which is the other half of a fight: a run that looks slow is often one zone's
 * worth of a single tanky monster rather than a rotation problem, and no
 * per-ability figure can say so.
 *
 * Keyed by name rather than by index, because an index is one spawn — a zone
 * cycles through dozens of them and the question is about the kind of monster,
 * not this particular rat.
 *
 * @param {Object} tally - `{}` or a previous return, mutated
 * @param {Array<Object>} events - From `attributeTick`
 * @param {Function} nameOf - `(monsterIndex) => string|null`
 * @returns {Object} Monster name → `{damage, hits, crits, misses, kills, byAbility}`
 */
export function foldEnemies(tally, events, nameOf) {
    for (const event of events || []) {
        const name = nameOf(event.monsterIndex);
        if (!name) continue;

        const enemy = (tally[name] = tally[name] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
            kills: 0,
            byAbility: {},
        });

        if (event.isKill) {
            enemy.kills++;
            continue;
        }

        const ability = (enemy.byAbility[event.action] = enemy.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });

        if (event.isMiss) {
            enemy.misses++;
            ability.misses++;
        } else if (!event.isHeal) {
            enemy.damage += event.amount;
            enemy.hits++;
            ability.damage += event.amount;
            ability.hits++;
            if (event.isCrit) {
                enemy.crits++;
                ability.crits++;
            }
        }
    }
    return tally;
}
