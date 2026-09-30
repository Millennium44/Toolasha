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
 * Each player carries `atkCounter`, and it goes up when they attack. On a
 * five-player recording it decided 89% of all damage exactly — the join
 * between a player and a monster's lost health, and the one signal that also
 * expresses misses, crits and the per-ability split.
 *
 * That recording predates a server change: counters then arrived for the
 * viewer's own unit alone, and now arrive for every present player. In a small
 * party a lone riser is still the swinger, so the rung is unchanged there; in a
 * full trial snapshot it is one of fifty-seven rosters ticking over and no
 * longer proof, so it is capped at {@link COLLISION_SPLIT_THRESHOLD} like the
 * mana rung. The rung's own comment carries the measurement.
 *
 * ## Presence is the attribution when no counter moved
 *
 * The server groups each `battle_updated` by **actor**: the player in a tick's
 * `pMap` is the one whose action the tick reports — their swing's damage,
 * their damage-over-time effect ticking, their thorns firing. So when nobody's
 * counter rose and exactly one player is in the tick, the damage is theirs.
 *
 * This module used to believe the opposite, and the correction is worth
 * keeping on record. On that five-player recording, 82 of 440 damage ticks
 * had the lone character present because their own health and damage counter
 * had moved — being *hit*, not attacking — and crediting them looked like
 * handing 8,500 points of other people's damage to whoever held aggro. So the
 * fallback became "the last character to swing". Adjudicating the same
 * recording against the counters showed the diagnosis was wrong: every one of
 * those ticks also carried the **monster's own attack counter rising** — the
 * monster attacked, the tank was hit, and the health the monster lost in the
 * same breath was the tank's **thorns**. The last-swinger fallback was not
 * protecting the tank's teammates; it was stealing the tank's reflect, 5.7%
 * of the party's damage, tick by provable tick. The remaining lone-present
 * ticks were players present with *nothing* changed about them while the
 * monster took a counted hit — their DoT ticking, which is itself the
 * actor-grouping stated as plainly as a payload can state it.
 *
 * Mana sits below both: only an ability costs mana, so a **unique** `cMP` drop
 * still separates the caster out of a *small* party. Unique, not
 * last-of-several — with synchronized builds two casts land on the same tick,
 * and "whoever iterated last wins" is an iteration-order artifact, not an
 * attribution. And only up to {@link COLLISION_SPLIT_THRESHOLD} present
 * players: past that, "exactly one person spent mana" stops being evidence,
 * because most of a trial's roster auto-attacks and leaves no mana trace, so
 * the one caster on the tick would collect everybody's damage. The last swinger
 * remains as the final fallback for the multi-player tick nothing else can
 * split.
 *
 * ## Every payload arrives twice
 *
 * 757 of 1,465 `battle_updated` messages in that recording are byte-identical to
 * the one before. Nothing here has to care — a duplicate diffs to no change and
 * produces no events — but it is why the swing behind a hit looks two ticks back
 * rather than one.
 *
 * ## Two counters distinguish a hit from a tick
 *
 * Health falling is not sufficient — regeneration moves it too. `dmgCounter`
 * **rising** is damage landing, `critCounter` rising is a crit, and
 * `dmgCounter` up with the health unchanged is a **miss** — the one case a
 * health diff can never express. But `dmgCounter` counts damage *splats*, and a
 * bleed tick rings it exactly as a swing does, so on its own it cannot tell the
 * two apart. The player's `atkCounter` rising on the same tick is what makes a
 * rise a swing; see {@link attributeTick}.
 *
 * ## What it deliberately does not do
 *
 * It does not guess. A small tick where several players act at once falls back
 * to the lone mana drop, because the payload cannot separate them otherwise —
 * and a tick that names nobody at all credits nobody rather than the wrong body.
 *
 * ## Damage over time is damage, and not a swing
 *
 * Damage-over-time ticks are their own event class (`isDot`), attributed by the
 * same rungs as a hit and folded into a `dotDamage` subtotal that rides *inside*
 * `damage`, so every total stays right and the breakdown can still name the
 * share. Hit, miss and crit counts do not move for them: a bleed is not a swing.
 *
 * This file once said a bleed tick moves a monster's health **without** moving
 * its damage counter, and filed a tick as damage-over-time only when the
 * counter stood still. Measured, that is false: across 31 labyrinth tick
 * captures not one monster health drop came without a `dmgCounter` rise, and
 * every Maim bleed tick rang it. So a solo fight credited each bleed tick to the
 * player as a landed non-crit hit — `dotTicks` read zero, the hit rate was
 * inflated and crit rate and damage per hit were diluted (a Pyre Hunter room
 * read 72.9% / 26.5% / 166 per hit against 68.5% / 32.8% / 195 once its 47
 * ticks were taken out). A tick is now a rise that no swing paid for, on a tick
 * the monster did not attack. Health falling with no counter at all — a payload
 * from before the counter was streamed — is still a tick.
 *
 * ## Thorns do move the hit counter
 *
 * This file once filed reflect with bleeds. Measured, it is not one: on every
 * tick where a monster attacked, the players present were hurt and none of them
 * swung, the monster's `dmgCounter` rose for the health it lost — 46 of 46 on
 * the five-player run, 1,381 of 1,381 on a 57-player trial. So a reflect reads
 * as a hit, filed under whatever the tank was preparing, and only the caller's
 * buff state can tell it apart: see the `reflecting` option.
 *
 * ## A collision too big to adjudicate is split, not awarded
 *
 * When several players act on one tick and nothing above can separate them, the
 * last rung used to hand the whole tick to whoever swung most recently. In a
 * five-person party that is a rounding error; in a thirty-person guild trial it
 * is a systematic bias towards one slot, and the slot is chosen by iteration
 * order rather than by anything that happened. Above
 * {@link COLLISION_SPLIT_THRESHOLD} players present, the tick's damage is split
 * equally between them instead — imperfect, but bounded: nobody who acted reads
 * zero, and nobody collects a crowd's work. A rise a present player's own attack
 * counter paid for is not part of the collision and stays with that player; see
 * {@link attributeTick}.
 *
 * Equal rather than weighted by damage already confirmed. KikiMeter tried the
 * weighted version on real trial captures and abandoned it: players who never
 * won a solo-confirmed tick stayed at zero while the early winners took the
 * whole ambiguous stream — rich-get-richer, 56% mean error against the game's
 * own end-of-trial figures.
 *
 * ## A slot's maximum health changing is a new monster in it
 *
 * `new_guild_battle` arrives once to three times in a whole hour, so a trial's
 * baselines have no periodic safety net the way a personal fight's do (a
 * `new_battle` every wave). A monster respawning into the same slot would read
 * as its predecessor healing, or worse as phantom damage. Any change to a
 * slot's `mHP` is therefore a new instance: re-baseline the slot and count
 * nothing across the transition.
 *
 * The model is DPs' and the Floating Combat Text tool's, from MWI Combat Suite
 * by Frotty (MIT) — see `third-party/mwi-combat-suite/` and
 * `docs/THIRD-PARTY-LICENSES.md`. The un-countered-damage event class, the
 * bounded equal split and the max-health respawn guard are KikiMeter v3.32.1's
 * by ZhuLiMoon (MIT) — see `third-party/kikimeter/`. The code is Toolasha's own.
 */

import { abilityProfile } from './class-inference.js';

/**
 * A fresh set of the counters a tick is measured against.
 * @returns {Object}
 */
export function newAttributionState() {
    return {
        playersMP: {},
        playersAtk: {},
        // Each player's last health, so "hurt this tick" is known for the reflect rung
        playersHP: {},
        party: {},
        lastSwing: null,
        monstersHP: {},
        // Each slot's stated maximum, so a respawn into it is recognised
        monstersMaxHP: {},
        dmgCounter: {},
        critCounter: {},
        // Each monster's own attack counter, so a counter-attack on the tick it
        // attacked is told apart from a damage-over-time tick
        monstersAtk: {},
        actions: {},
    };
}

/**
 * Seed a monster's attack-counter baseline from a `new_battle` statement.
 *
 * Wherever a caller seeds a slot's health and damage counter it should seed
 * this too: without it, the first tick measured against the seed cannot tell a
 * parry answering the monster's first attack from a damage-over-time tick, and
 * reads the rise as a hit the way it always did.
 *
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {string|number} index - The monster's slot
 * @param {Object} monster - The `new_battle` unit, long or short spelling
 */
export function seedMonsterAttacks(state, index, monster) {
    const attacks = Number(
        monster?.attackAttemptCounter ?? monster?.atkCounter ?? monster?.combatDetails?.attackAttemptCounter
    );
    const baselines = (state.monstersAtk ||= {});
    if (Number.isFinite(attacks)) baselines[index] = attacks;
    else delete baselines[index];
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
 * ## An entry that names neither is not a statement of idleness
 *
 * The tick never sends `isAutoAtk: false`: across every recording the two
 * fields are mutually exclusive and one of them is simply absent the rest of the
 * time (70 of 1,766 entries in the five-player run carry neither). Reading that
 * absence as `idle` filed the player's next landed hit under a label the
 * non-damaging filter drops — and on the five-player run all 12 such hits
 * (4,671 damage) had the player's own attack counter rising on or just before
 * the tick. So an entry with neither field keeps the action already known;
 * only an explicit `false` with no ability, or no history at all, reads idle.
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
        const auto = player?.isPreparingAutoAttack ?? player?.isAutoAtk;

        if (ability) state.actions[index] = ability;
        else if (auto) state.actions[index] = 'auto';
        else if (auto === false || !state.actions[index]) state.actions[index] = 'idle';

        // Only `new_battle` states a unit's combat stats, and its long-spelled
        // splat counter; a tick states neither, so a tick leaves both alone
        const stats = player?.combatDetails?.combatStats;
        if (stats && typeof stats === 'object') (state.counterStats ||= {})[index] = counterStatsOf(stats);
        const splats = Number(player?.damageSplatCounter);
        if (Number.isFinite(splats)) (state.playersDmg ||= {})[index] = splats;
    }
}

/**
 * What a player can answer a monster's attack with, from `new_battle`'s stats.
 *
 * The game leaves a zero stat out of `combatStats` rather than sending 0, so a
 * missing key is a real "cannot".
 *
 * @param {Object} stats - `combatDetails.combatStats`
 * @returns {{parry: boolean, strikesBack: boolean}} Whether they can parry, and whether
 *   being struck deals damage back (retaliation, physical or elemental thorns)
 */
function counterStatsOf(stats) {
    const positive = (key) => Number(stats?.[key]) > 0;
    return {
        parry: positive('parry'),
        strikesBack: positive('retaliation') || positive('physicalThorns') || positive('elementalThorns'),
    };
}

/**
 * How many players may be present in one tick before an unresolved collision is
 * split rather than awarded.
 *
 * Three is where a party stops being adjudicable by inspection. Below it the
 * existing chain — mana, then the last swinger — is a reasonable guess about a
 * handful of people; above it, in a guild trial's twenty-plus, "whoever swung
 * last" is an iteration-order artifact dressed as an attribution. KikiMeter's
 * field figures on real trial captures: ~13% of messages are collisions, up to
 * 23 actors at once.
 *
 * It gates the **counter and mana rungs as well as the fallback**, and for the
 * same reason rather than a merely similar one: a lone `cMP` drop identifies the caster
 * only while everybody present could plausibly have cast. In a twelve- to
 * twenty-three-player trial most of the roster is auto-attacking and never
 * touches its mana, so "exactly one drop" is temporal coincidence — the one
 * spender is simply the only person who *could* leave a trace — and awarding
 * them the tick systematically inflates whoever casts most. The counter rung
 * joined it once the server began streaming `atkCounter` for every present
 * player rather than the viewer's own unit — see the note on that rung. Above
 * the threshold all three are skipped and the tick reaches the equal split.
 */
export const COLLISION_SPLIT_THRESHOLD = 3;

/** A single-target swing count below this is spent: shared splats leave fractional counts behind */
const PENDING_EPSILON = 1e-6;

/**
 * Who acted this tick, and whether the tick had to be shared between them.
 *
 * The rungs, strongest first: a lone attack counter rising in a party no larger
 * than {@link COLLISION_SPLIT_THRESHOLD}, a lone player in the tick, a lone
 * mana drop in a party no larger than the same threshold, a party of one. When
 * none of them fires and more
 * than {@link COLLISION_SPLIT_THRESHOLD} players are present, the tick is
 * *shared* — every present player gets an equal fraction of it — and below that
 * it falls to the last swinger as it always did.
 *
 * @param {Object} pMap - This tick's players
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - `{soloFallback, collisionThreshold}`
 * @param {boolean} [options.soloFallback] - Whether "the party has one member, so it was them"
 *   may be used on a tick that names nobody at all. True for this client's own fights, where
 *   the party is genuinely known from `new_battle`; false for a spectated guild trial, where
 *   there is no party statement and the rung would fire off whichever slot happened to appear
 *   first. The presence rung above it is unaffected — it reads this tick's own payload
 * @param {number} [options.collisionThreshold] - Overrides {@link COLLISION_SPLIT_THRESHOLD}
 * @param {boolean} [options.lastSwingFallback] - Whether an unresolved tick with at most
 *   `collisionThreshold` players present goes to the last swinger. Defaults to `soloFallback`:
 *   on a spectated trial the last lone riser can be anyone in a 57-slot wave and is usually not
 *   in the tick at all, so there the tick is split among those present and a tick nobody is
 *   present in credits nobody
 * @param {Function|Map|Set|Object} [options.reflecting] - Which players have a reflect (Spike
 *   Shell, Retribution) up this tick: `(index, player) => hrid|true|null`, or a Map, Set or object
 *   keyed by player index. When exactly one present player has one up and lost health this tick,
 *   they own a tick nothing above resolved, whatever the crowd size — thorns fire only when
 *   their wearer is struck, a causal link a crowd does not dilute. Omitted, nothing changes
 * @returns {{actors: string[], shared: boolean, hurt: Set<string>, swung: Set<string>,
 *   swings: Map<string, number>, countersKnown: boolean, present: string[]}} The players the tick
 *   belongs to, whether it is divided between them, who lost health and who swung this tick, how
 *   many swings each made, whether every swing this tick is visible, and who is in the tick
 */
function resolveActors(
    pMap,
    state,
    {
        soloFallback = true,
        collisionThreshold = COLLISION_SPLIT_THRESHOLD,
        lastSwingFallback = soloFallback,
        reflecting,
    } = {}
) {
    const indices = Object.keys(pMap || {});
    const swung = [];
    const spent = [];
    const hurt = new Set();
    // Who had a monster's attack land on them this tick
    const struck = new Set();
    const struckBefore = (state.playersDmg ||= {});
    // How many swings each present player made this tick, for `attributeTick`'s
    // pending-swing pool
    const swings = new Map();
    // Whether every swing this tick is visible: a present player with no attack
    // counter, or none measured before, could have swung unseen. With nobody
    // present it is whether this fight streams attack counters at all
    let countersKnown = indices.length > 0 || Object.keys(state.playersAtk).length > 0;
    // A state built before this field existed, or reset field by field
    const health = (state.playersHP ||= {});

    for (const index of indices) {
        const player = pMap[index];

        const attacks = Number(player?.atkCounter);
        const attacksBefore = state.playersAtk[index];
        if (Number.isFinite(attacks)) {
            if (attacksBefore === undefined) countersKnown = false;
            else if (attacks > attacksBefore) {
                swung.push(index);
                swings.set(index, attacks - attacksBefore);
            }
            state.playersAtk[index] = attacks;
        } else {
            countersKnown = false;
        }

        const mana = Number(player?.cMP);
        if (Number.isFinite(mana)) {
            const before = state.playersMP[index];
            if (before !== undefined && mana < before) spent.push(index);
            state.playersMP[index] = mana;
        }

        const hp = Number(player?.cHP ?? player?.currentHitpoints);
        if (Number.isFinite(hp)) {
            if (health[index] !== undefined && hp < health[index]) hurt.add(index);
            health[index] = hp;
        }

        // The player's own damage counter: an attack that landed on them, hit or
        // miss, rings it; one they parried does not
        const splats = Number(player?.dmgCounter);
        if (Number.isFinite(splats)) {
            if (struckBefore[index] !== undefined && splats > struckBefore[index]) struck.add(index);
            struckBefore[index] = splats;
        }
    }

    const acted = { hurt, struck, swung: new Set(swung), swings, countersKnown, present: indices };
    const one = (index) => ({ actors: [index], shared: false, ...acted });
    const split = () => ({ actors: [...indices], shared: true, ...acted });
    const none = () => ({ actors: [], shared: false, ...acted });

    // `atkCounter` is what it sounds like, and it almost always names one person:
    // in a five-character party, two of them swung on the same tick three times
    // in fourteen hundred, one of which dealt damage. Rare enough to identify
    // by, not so rare that the tie can be pretended away.
    //
    // Gated on the same threshold as the mana rung, and for a reason that only
    // became true later. The rung was written when the server streamed action
    // counters for the **viewer's own unit alone**: a counter rise was then a
    // statement that this player acted and an absence of one said nothing about
    // anybody else, so "exactly one riser" really did mean "exactly one known
    // swinger, and the tick is his". The server now sends `atkCounter`,
    // `critCounter` and `dmgCounter` for **every player present** — all 57 slots
    // of a guild trial, in every tick bucket — and the same shape means
    // something much weaker: one of a full roster ticked over while the rest
    // were mid-swing. Measured over a 150,642-tick trial, treating the lone
    // riser as the owner moves 1,332 ticks and 100,379 damage (0.32% of 31.6M)
    // off the party and onto one name, and it is the only rung in the new
    // stream that *concentrates* rather than spreads.
    //
    // So above the threshold a lone riser is no longer authoritative and the
    // tick falls through to the equal split below: it spreads the uncertainty
    // instead of piling it on whoever happened to tick over first, and it keeps
    // figures recorded either side of the server change comparable. Below the
    // threshold nothing changes — with a couple of units in play a lone counter
    // rise is still the swinger, which is what this rung was always for.
    if (swung.length === 1) {
        // Recorded whether or not the rung fires: the swing is a fact about who
        // acted, and the small-collision fallback below still wants it
        state.lastSwing = swung[0];
        if (indices.length <= collisionThreshold) return one(swung[0]);
    }

    // The delta names the actor. A tick's `pMap` carries the player whose
    // action this tick reports, so a lone entry with no counter movement is a
    // DoT ticking or thorns firing — theirs either way. Adjudicated against
    // the counters on a five-player recording: this rung was right on every
    // tick the counters could decide, and the last-swinger fallback it
    // replaces was provably wrong on 5.7% of the party's damage.
    if (indices.length === 1) return one(indices[0]);

    // Several people at once. A unique mana drop separates the caster; two
    // drops on one tick separate nothing, and "whoever iterated last" is an
    // artifact of key order, not an attribution.
    //
    // Only in a party small enough for "exactly one person cast" to be a fact
    // rather than a coincidence. In a five-person fight a lone mana drop is the
    // caster; in a twenty-three-person trial most actors are auto-attacking and
    // leave no mana trace at all, so the one member who happened to spend mana
    // this tick collects the whole crowd's damage. KikiMeter's field hardening
    // (26/07) capped the same rung at the same threshold for the same reason.
    // Above it the rung is skipped outright and the tick falls to the equal
    // split below, which is wrong about every individual and right about the
    // shape.
    if (spent.length === 1 && indices.length <= collisionThreshold) return one(spent[0]);

    // A tick that names nobody at all, in a fight whose party is one person.
    if (soloFallback && Object.keys(state.party).length === 1) {
        return one(Object.keys(state.party)[0]);
    }

    // Thorns fire only when their wearer is struck, so one present player with a
    // reflect up who lost health this tick is the source of what nothing above
    // resolved — a causal link rather than a statistical one, which is why it is
    // not capped by the crowd size the counter and mana rungs are. KikiMeter's
    // trial rung (30/08). Needs the caller's buff state; without it this is inert.
    if (reflecting && indices.length > 1) {
        const reflectors = indices.filter((index) => hurt.has(index) && reflectOf(reflecting, index, pMap[index]));
        if (reflectors.length === 1) return one(reflectors[0]);
    }

    // A crowd nothing could separate. Splitting it equally is wrong about every
    // individual and right about the shape: the alternative awards the whole
    // thing to one slot for no reason a player could point at.
    if (indices.length > collisionThreshold) return split();

    // Without a known party the last swinger is not a guess about a handful of
    // people: on a 150,642-tick trial, 261 of the 268 small unresolved damage
    // ticks went to a `lastSwing` who was not in the tick at all. Those present
    // share it, and a tick with nobody present is nobody's.
    if (!lastSwingFallback) {
        return indices.length > 1 ? split() : none();
    }

    // The last character to swing — still the fallback for the small collision
    // in this client's own fight, where a handful of people is a guess rather
    // than a bias.
    return state.lastSwing ? one(state.lastSwing) : none();
}

/**
 * Who acted this tick, and whether the tick had to be shared between them.
 *
 * The rungs and every option are {@link resolveActors}'.
 *
 * @param {Object} pMap - This tick's players
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - `{soloFallback, collisionThreshold, lastSwingFallback, reflecting}`
 * @returns {{actors: string[], shared: boolean}}
 */
export function findActors(pMap, state, options) {
    const { actors, shared } = resolveActors(pMap, state, options);
    return { actors, shared };
}

/**
 * Which player acted this tick.
 *
 * The single-owner view of {@link findActors}, kept for callers that want one
 * name or nothing: a shared tick answers null, because no one player owns it.
 *
 * @param {Object} pMap - This tick's players
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - Passed to {@link findActors}
 * @returns {string|null} The player index, or null when nobody can be identified
 */
export function findCaster(pMap, state, options) {
    const { actors, shared } = findActors(pMap, state, options);
    return shared ? null : (actors[0] ?? null);
}

/**
 * The label an un-countered health loss is filed under.
 *
 * Not the ability the player was preparing: a bleed landing now was applied
 * some seconds ago. Filing it under whatever happened to be mid-cast would
 * credit a rotation with damage it did not do. Thorns are not in it — they move
 * the hit counter; see {@link REFLECT_ACTION}.
 */
export const DOT_ACTION = 'dot';

/**
 * The label reflect damage is filed under when the caller's buff state says a
 * reflect was up but not which one. Given an ability hrid, that hrid is the label.
 */
export const REFLECT_ACTION = 'reflect';

/**
 * A caller's reflect input, read for one player.
 *
 * @param {Function|Map|Set|Object} reflecting - See {@link resolveActors}
 * @param {string} index - Player index, as a `pMap` key
 * @param {Object} [player] - This tick's entry
 * @returns {string|null} The reflect ability hrid, {@link REFLECT_ACTION} when the input names
 *   none, or null when no reflect is up
 */
function reflectOf(reflecting, index, player) {
    let value;
    if (typeof reflecting === 'function') value = reflecting(index, player);
    else if (reflecting instanceof Map) value = reflecting.get(index) ?? reflecting.get(Number(index));
    else if (reflecting instanceof Set) value = reflecting.has(index) || reflecting.has(Number(index));
    else value = reflecting?.[index];
    if (!value) return null;
    return typeof value === 'string' ? value : REFLECT_ACTION;
}

/**
 * The label health lost on a tick that credits no player is filed under.
 *
 * A zero-present spectated tick, or a small collision in a party with no known
 * swinger: the monster really lost the health, and dropping it silently is what
 * made a board total (the sum of players) disagree with the boss bar. With
 * `unattributed: true` such damage is emitted as its own event so a tracker can
 * show the team total as all health lost plus an explicit "unattributed" line.
 */
export const UNATTRIBUTED_ACTION = 'unattributed';

/**
 * The label a swing is filed under.
 *
 * What was being prepared, except an ability the game data says deals no damage:
 * a hit that lands while a player is preparing Toughness or a heal is the
 * auto-attack that ran before the cast, and filing it under the buff credits a
 * rotation row with damage the ability cannot do. KikiMeter reached the same
 * correction in the field ("Toughness/Invincible showing damage"). An ability
 * the data does not know, or no data at all, keeps its label — guessing would be
 * worse than the bug.
 *
 * @param {string} [action] - From `state.actions`
 * @param {Object} [abilityDetailMap] - Game data; without it nothing is relabelled
 * @returns {string}
 */
function swingLabel(action, abilityDetailMap) {
    const label = action || 'idle';
    if (!abilityDetailMap) return label;
    const profile = abilityProfile(label, abilityDetailMap);
    return profile && !profile.damages ? 'auto' : label;
}

/**
 * Whether anybody could have answered a monster's attack this tick with damage.
 *
 * An unpaid damage-counter rise on a tick the monster attacked is a counter-
 * attack only if somebody could have made one. Three ways, each read from what
 * the payload can show:
 *
 * - **Parry** blocks the attack and swings back. A parried attack does not land,
 *   so the parrier's own damage counter stays still: on all 62 parry
 *   counter-attacks in the four Pyre Hunter captures it did not move, and no
 *   bleed tick in them shared a tick with a monster attack that landed.
 * - **Retaliation and thorns** answer an attack that did land: their wearer was
 *   struck or hurt this tick.
 * - **A reflect buff** the caller knows is up (`reflecting`), on a player hurt
 *   this tick.
 *
 * Anyone else's bleed ticking in the same update as the monster's attack is a
 * bleed. What stays ambiguous: in a party, a parry-capable player who was not
 * struck could be answering an attack aimed at them or standing idle while the
 * monster hit someone else, and either reads as "could have countered"; and a
 * bleed landing on the very tick a parry answered is read as the parry.
 *
 * Without the stats — no `new_battle` seen, or one that states no
 * `combatStats` for some member — nobody can be ruled out, and the rise stays a
 * hit as it always was.
 *
 * @param {Object} state - From `newAttributionState`
 * @param {Set<string>} struck - Players a monster's attack landed on this tick
 * @param {Set<string>} hurt - Players who lost health this tick
 * @param {Object} [pMap] - This tick's players
 * @param {Function|Map|Set|Object} [reflecting] - The caller's reflect input
 * @returns {boolean}
 */
function couldCounter(state, struck, hurt, pMap, reflecting) {
    const stats = state.counterStats || {};
    const party = Object.keys(state.party || {});
    const members = party.length ? party : Object.keys(pMap || {});
    if (!members.length || members.some((index) => !stats[index])) return true;

    return members.some((index) => {
        const { parry, strikesBack } = stats[index];
        const landed = struck.has(index) || hurt.has(index);
        if (parry && !struck.has(index)) return true;
        if (strikesBack && landed) return true;
        return Boolean(reflecting && hurt.has(index) && reflectOf(reflecting, index, pMap?.[index]));
    });
}

/**
 * Whether a swing is known to strike one monster only.
 *
 * An auto-attack does, and so does an ability whose damaging effects the game
 * data names no `allEnemies` target for. Anything the data cannot answer — no
 * data, an unknown hrid, no label — is not known to, and is read as a swing that
 * may have struck every monster: an area cast (Frost Surge, Crippling Slash,
 * Penetrating Shot) raises the caster's attack counter once and rings each
 * monster it reaches, and reading its second target as a bleed tick is the
 * worse mistake.
 *
 * @param {string} [action] - From `state.actions`, the swing's label
 * @param {Object} [abilityDetailMap] - Game data
 * @returns {boolean}
 */
function isSingleTarget(action, abilityDetailMap) {
    if (action === 'auto') return true;
    const effects = abilityDetailMap?.[action]?.abilityEffects;
    if (!Array.isArray(effects)) return false;
    // A piercing effect (Penetrating Strike/Shot) targets one enemy but carries
    // on to the next on a successful pierce, so it can ring several monsters
    return !effects.some(
        (effect) => String(effect?.targetType || '') === 'allEnemies' || Number(effect?.pierceChance) > 0
    );
}

/**
 * The hits in one tick.
 *
 * ## A rise of the damage counter is a swing, a counter-attack or a tick
 *
 * `dmgCounter` counts damage splats, not swings: a bleed tick rings it exactly
 * as a sword does. So each rise is classified before it is credited, the way
 * the labyrinth uptime harness pays off its queue of pending swings:
 *
 * - A **swing** is a rise paid off by a present player's `atkCounter` rising on
 *   the same tick. Each rise pays off one pending swing — on each monster, for
 *   a swing that may be an area cast, since one cast rings every monster it
 *   reaches and raises the caster's counter once (seen on every Frost Surge,
 *   Crippling Slash and Penetrating Shot/Strike tick in the party, five-player
 *   and dungeon recordings); and once in the whole tick for a swing known to be
 *   single-target (an auto-attack, or an ability the game data gives no
 *   `allEnemies` target and no pierce chance), so a bleed ticking on a second monster stays a tick.
 * - A **counter-attack** is an unpaid rise on a tick where the monster's own
 *   attack counter rose: it attacked and was answered by a parry or a reflect.
 *   The game counts those as attacks — they miss and crit like swings, and the
 *   sim tallies `parry` and `retaliation` as swings — so they stay hits.
 * - A **damage-over-time tick** is an unpaid rise on a tick where the monster
 *   did not attack: `isDot`, never a hit, crit or miss.
 *
 * Pending swings last one tick. Across 31 labyrinth captures every swing that
 * dealt anything did it on the tick its attack counter rose, while 984 attack
 * counter rises resolved nothing at all — buffs, heals and the phantom swing a
 * respawn gap coalesces into the next battle's first message. A queue that kept
 * those would pay the next bleed tick off as a hit.
 *
 * Ownership is the actor rungs' ({@link findActors}), with two refinements the
 * pool makes possible. A paid swing goes to the player whose swing paid it, so
 * two players striking one monster on one tick get a hit each rather than both
 * going to the last swinger. With a single swinger that holds whatever the
 * crowd size; in a crowd with several swingers the pairing is by slot order, not
 * evidence, so there the splat is shared between the swingers alone. A paid swing is a
 * monster's `dmgCounter` rise matched to one present player's own `atkCounter`
 * rise on the same tick, which is evidence about that swing and not merely
 * about who moved — {@link COLLISION_SPLIT_THRESHOLD} does not gate it. Gating
 * it split every Mana Spring among the ~50 party members its mana restore puts
 * in the tick: on a 53-player Trial Swarm the casters read ~22% under the
 * game's own totals and the rest of the roster 8–78% over; paid-to-swinger
 * brought the damage-weighted error from 17.5% to 2.0% there, and lowered it
 * on each of four single-boss trial traces checked beside it. And a
 * damage-over-time tick on a tick somebody swung goes to the one present player
 * who did not, when there is exactly one — the server groups a tick by actor,
 * and the swingers' swings are already paid for.
 *
 * A merged rise splits the health lost evenly between its splats, as the
 * harness does. A fight whose payloads carry no attack counters (older
 * recordings, or a player whose counter has no baseline yet) keeps the old
 * reading: every rise is a hit.
 *
 * @param {Object} tick - A `battle_updated` payload
 * @param {Object} state - From `newAttributionState`, mutated
 * @param {Object} [options] - Passed to {@link findActors}; `{soloFallback, collisionThreshold}`, plus
 * @param {Object} [options.abilityDetailMap] - Game data. When given, a swing credited while the
 *   player was preparing an ability with no damaging effect is labelled `auto` instead
 * @param {boolean} [options.unattributed] - Emit health lost on a tick that credits nobody as
 *   `{playerIndex: null, isUnattributed: true, action: UNATTRIBUTED_ACTION, weight: 1}` rather
 *   than dropping it. Off by default, because a caller iterating events must skip a null player
 * @returns {Array<Object>} Hits as
 *   `{playerIndex, monsterIndex, amount, isCrit, isMiss, isHeal, isDot, weight, action}`, and
 *   deaths as `{monsterIndex, isKill, killerIndex}` — the two are separate events because a
 *   bleed can land the killing blow on a tick where no counter moved. `killerIndex` is the
 *   player who owns the killing tick, or null when it was shared or credited nobody. `weight`
 *   is 1 for a tick one player owns and 1/n for one shared between n of them,
 *   so a swing count still sums to the number of swings
 */
export function attributeTick(tick, state, options) {
    const { mMap, pMap } = tick || {};
    const { actors, shared, hurt, struck, swung, swings, countersKnown, present } = resolveActors(pMap, state, options);
    const abilityDetailMap = options?.abilityDetailMap;
    const reflecting = options?.reflecting;
    const emitUnattributed = options?.unattributed === true;
    const monsterAttacks = (state.monstersAtk ||= {});
    const events = [];
    const weight = actors.length ? 1 / actors.length : 0;
    // A kill goes to the tick's one owner or to nobody. Not a fraction: "0.05
    // kills" on twenty rows says nothing a player can read, and the shared tick
    // is exactly the one where nobody knows who landed the blow
    const killerIndex = !shared && actors.length === 1 ? actors[0] : null;

    const tickOwners = actors.map((index) => ({ index, weight }));
    // The swings still waiting for a resolution this tick. A swing known to be
    // single-target pays off one rise anywhere; any other can be an area swing,
    // which rings every monster it reaches, so it pays off one rise on each.
    // Coalesced swings (the counter up by 2+) of a known single-target action
    // stay in the tick-wide pool with their full count: two Water Strikes can
    // land two hits, not one on every monster that rang (combat-party.json)
    const singleTarget = new Set(
        [...swings].filter(([index]) => isSingleTarget(state.actions[index], abilityDetailMap)).map(([index]) => index)
    );
    const tickPending = new Map([...swings].filter(([index]) => singleTarget.has(index)));
    // Returns the swing taken and the pool it was taken from: every swing that could still pay a rise on
    // this monster at that moment, with what it has left
    const takeSwing = (monsterPending) => {
        const pool = [];
        let taken = null;
        for (const index of swings.keys()) {
            const pending = singleTarget.has(index) ? tickPending : monsterPending;
            const left = pending.get(index) || 0;
            if (left <= PENDING_EPSILON) continue;
            pool.push([index, left]);
            if (taken === null) taken = { index, pending, left };
        }
        if (taken === null) return null;
        taken.pending.set(taken.index, taken.left - 1);
        return { swinger: taken.index, pool };
    };
    // Who a paid swing belongs to. With one swinger in the tick the pairing is
    // exact whatever the crowd; in a small tick the swings pair off one by one.
    // In a crowd with several swingers `takeSwing` only picks the first pending
    // one in slot order, not the one whose swing landed here, so the splat is
    // shared between the swingers — never the bystanders a party-wide mana
    // restore put in the tick.
    const collisionThreshold = options?.collisionThreshold ?? COLLISION_SPLIT_THRESHOLD;
    // Shared by remaining swing count among the swingers who could still pay a rise on this monster: a
    // counter up by 2 coalesced two attacks, and owns two of three splats against a counter up by 1. A
    // single-target swing already spent on another monster is not a candidate here
    const swingOwners = ({ swinger, pool }) => {
        const total = pool.reduce((sum, [, left]) => sum + left, 0);
        return swings.size <= 1 || present.length <= collisionThreshold || pool.length <= 1 || total <= 0
            ? [{ index: swinger, weight: 1 }]
            : // A single-target swinger's tick-wide count is spent by what it is credited, so its share of a splat
              // is capped at what it has left; area counts reset per monster and are never fractional
              pool.map(([index, left]) => ({
                  index,
                  weight: singleTarget.has(index) ? Math.min(left, left / total) : left / total,
              }));
    };
    // A shared splat spends each single-target owner's tick-wide count by its share, not one whole swing from the
    // slot-order winner `takeSwing` picked: otherwise one swing is credited in full on every monster that rang.
    // Refunds run before any share is spent, or a clamp at zero eats the share
    const refundShared = (taken, owners) => {
        if (owners.length <= 1 || !singleTarget.has(taken.swinger)) return;
        tickPending.set(taken.swinger, (tickPending.get(taken.swinger) || 0) + 1);
    };
    const spendShared = (owners) => {
        if (owners.length <= 1) return;
        for (const owner of owners) {
            if (!singleTarget.has(owner.index)) continue;
            tickPending.set(owner.index, Math.max(0, (tickPending.get(owner.index) || 0) - owner.weight));
        }
    };
    const nonSwingers = present.filter((index) => !swung.has(index));
    const dotOwners =
        countersKnown && swung.size > 0 && nonSwingers.length === 1
            ? [{ index: nonSwingers[0], weight: 1 }]
            : tickOwners;

    const unattributed = (monsterIndex, amount, isDot, isCrit) => {
        if (!emitUnattributed || !(amount > 0)) return;
        events.push({
            playerIndex: null,
            monsterIndex,
            amount,
            isCrit,
            isMiss: false,
            isHeal: false,
            isDot,
            isUnattributed: true,
            weight: 1,
            action: UNATTRIBUTED_ACTION,
        });
    };

    // Real damage with no swing behind it: credited by the rungs like a hit, and
    // carrying no crit, miss or ability of its own
    const dotTick = (monsterIndex, amount) => {
        if (!(amount > 0)) return;
        if (!dotOwners.length) {
            unattributed(monsterIndex, amount, true, false);
            return;
        }
        for (const owner of dotOwners) {
            events.push({
                playerIndex: owner.index,
                monsterIndex,
                amount: amount * owner.weight,
                isCrit: false,
                isMiss: false,
                isHeal: false,
                isDot: true,
                weight: owner.weight,
                action: DOT_ACTION,
            });
        }
    };

    const swingEvent = (owner, monsterIndex, change, isCrit) => ({
        playerIndex: owner.index,
        monsterIndex,
        amount: Math.abs(change) * owner.weight,
        isCrit,
        // The one case a health diff cannot express on its own
        isMiss: change === 0,
        isHeal: change < 0,
        isDot: false,
        weight: owner.weight,
        action: swingLabel(state.actions[owner.index], abilityDetailMap),
    });

    for (const [index, monster] of Object.entries(mMap || {})) {
        const health = Number(monster?.currentHitpoints ?? monster?.cHP);
        if (!Number.isFinite(health)) continue;

        const maxHealth = Number(monster?.maxHitpoints ?? monster?.mHP);
        const beforeHealth = state.monstersHP[index];
        const beforeMax = state.monstersMaxHP[index];
        const beforeDamage = state.dmgCounter[index];
        const beforeCrits = state.critCounter[index];
        const beforeAttacks = monsterAttacks[index];

        const damageCount = Number(monster?.dmgCounter) || 0;
        const critCount = Number(monster?.critCounter) || 0;
        const attacks = Number(monster?.atkCounter);

        state.monstersHP[index] = health;
        state.dmgCounter[index] = damageCount;
        state.critCounter[index] = critCount;
        if (Number.isFinite(maxHealth)) state.monstersMaxHP[index] = maxHealth;
        if (Number.isFinite(attacks)) monsterAttacks[index] = attacks;

        // First sighting of a monster is not a hit for its entire health bar
        if (beforeHealth === undefined) continue;

        // A different maximum in the same slot is a different monster in it.
        // The trial stream only restates its roster once or twice an hour, so
        // a respawn between those has nothing else to announce it — and the
        // slot's previous corpse read against the newcomer's full bar is
        // either a phantom heal or, with residual health, phantom damage.
        if (Number.isFinite(maxHealth) && beforeMax !== undefined && maxHealth !== beforeMax) continue;

        // A death is its own event, separate from the hit that caused it.
        // Merging the two would lose every kill landed by a bleed, and a kill
        // counted only when a hit lands undercounts exactly the fights that
        // take longest, which are the ones worth measuring.
        const killEvent = beforeHealth > 0 && health <= 0 ? { monsterIndex: index, isKill: true, killerIndex } : null;
        if (killEvent) events.push(killEvent);

        const change = beforeHealth - health;
        const rises = beforeDamage !== undefined ? Math.max(0, damageCount - beforeDamage) : 0;

        // Health falling with no counter rise at all — a payload without the
        // counter. Real damage, and no swing behind it
        if (!rises) {
            dotTick(index, change);
            continue;
        }

        const perSplat = change / rises;
        const crit = beforeCrits !== undefined && critCount > beforeCrits;

        // Each rise pays off one of this tick's swings. What is left over is a
        // counter-attack when the monster attacked and a tick when it did not;
        // with a swing that could not be seen, or a monster whose attacks could
        // not, it stays what it always was — a hit
        const paid = [];
        let monsterAreaPending = new Map();
        if (countersKnown) {
            const monsterPending = new Map([...swings].filter(([swinger]) => !singleTarget.has(swinger)));
            monsterAreaPending = new Map(monsterPending);
            for (let n = 0; n < rises; n++) {
                const taken = takeSwing(monsterPending);
                if (taken === null) break;
                paid.push(taken);
            }
        }
        const unpaid = rises - paid.length;
        // A counter that went backwards is a different monster in the slot, and
        // says nothing about whether this one attacked
        const attackKnown = beforeAttacks !== undefined && Number.isFinite(attacks) && attacks >= beforeAttacks;
        const isTick =
            countersKnown &&
            attackKnown &&
            (attacks === beforeAttacks || !couldCounter(state, struck, hurt, pMap, reflecting));
        const counted = isTick ? 0 : unpaid;

        const sharedOwners = paid.map((taken) => swingOwners({ swinger: taken.swinger, pool: paid[0].pool }));
        paid.forEach((taken, n) => refundShared(taken, sharedOwners[n]));
        // What each swinger can still be credited on this monster: every splat reuses the first rise's pool, so
        // without a cap a fractional single-target balance (or an area swing) is credited once per splat
        const budget = new Map(monsterAreaPending);

        // A bleed cannot crit, so a crit belongs to the last counted splat
        paid.forEach((taken, n) => {
            const isCrit = crit && counted === 0 && n === paid.length - 1;
            // The pool as it stood before this monster's first rise: consuming a swing per rise must not shift
            // the shares between the monster's own splats, but a share never exceeds what the swinger has left
            const owners =
                sharedOwners[n].length <= 1
                    ? sharedOwners[n]
                    : sharedOwners[n].map((owner) => {
                          const left = singleTarget.has(owner.index)
                              ? tickPending.get(owner.index) || 0
                              : (budget.get(owner.index) ?? owner.weight);
                          const weight = Math.max(0, Math.min(owner.weight, left));
                          if (!singleTarget.has(owner.index)) budget.set(owner.index, left - weight);
                          return { index: owner.index, weight };
                      });
            // The killing splat is the last rise. The kill is someone's only when one player could have made
            // any of this monster's splats: with several possible swingers the counters say nothing about
            // which splat came last, and the last one paid is just the last in slot order
            if (killEvent && killEvent.killerIndex === null && unpaid === 0 && n === paid.length - 1) {
                if (owners.length === 1 && paid[0].pool.length === 1) killEvent.killerIndex = owners[0].index;
            }
            spendShared(owners);
            for (const owner of owners) events.push(swingEvent(owner, index, perSplat, isCrit));
            // A capped splat's owners can sum to under one: the rise was paid, so the remainder belongs to no
            // swing and no hit, but the health it took is real and stays in the team total
            if (owners.length > 1 && perSplat > 0) {
                const owned = owners.reduce((sum, owner) => sum + owner.weight, 0);
                unattributed(index, perSplat * Math.max(0, 1 - owned), false, false);
            }
        });

        if (isTick) {
            for (let n = 0; n < unpaid; n++) dotTick(index, perSplat);
            continue;
        }
        if (!counted) continue;

        const countedChange = perSplat * counted;
        if (!tickOwners.length) {
            // Only lost health: a miss or a heal with no owner has no total to join
            unattributed(index, countedChange, false, crit);
            continue;
        }

        for (const owner of tickOwners) {
            const actor = owner.index;
            // A reflect moves the hit counter too, so it is told apart from a
            // swing by the caller's buff state: a reflect up, hurt this tick, and
            // no swing of their own. Damage, not a swing — no hit, crit or miss
            const reflect =
                reflecting && countedChange > 0 && hurt.has(actor) && !swung.has(actor)
                    ? reflectOf(reflecting, actor, pMap?.[actor])
                    : null;
            if (reflect) {
                events.push({
                    playerIndex: actor,
                    monsterIndex: index,
                    amount: countedChange * owner.weight,
                    isCrit: false,
                    isMiss: false,
                    isHeal: false,
                    isDot: false,
                    isReflect: true,
                    weight: owner.weight,
                    action: reflect,
                });
                continue;
            }
            events.push(swingEvent(owner, index, countedChange, crit));
        }
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
 * ## Fractions are expected
 *
 * A tick shared between the players present carries `weight` below 1, and both
 * the damage and the swing counts take that weight — so a party's hits still
 * sum to the number of swings the payload showed, and nothing is rounded here
 * where the rounding would compound. Display code rounds; the ledger does not.
 *
 * ## `damage` includes `dotDamage`
 *
 * Deliberately, and it is the reason nothing downstream had to be taught about
 * damage-over-time to stop under-reporting it: `damage` is the whole of what a
 * player did, and `dotDamage` is the part of that which no swing counter ever
 * confirmed. A breakdown can name the share ("incl. X DoT"); a total cannot
 * get it wrong by forgetting to add a second field. Reflect is not in
 * `dotDamage` — it moves the hit counter (see below) and gets its own named
 * ability row instead of riding inside this one.
 *
 * @param {Object} tally - `{}` or a previous return, mutated
 * @param {Array<Object>} events - From `attributeTick`
 * @param {Object} [options] - `{filterNonDamaging, nonDamaging, nameOf}`. `nameOf`
 *   turns a monster index into a name; without it the per-enemy split is skipped.
 * @returns {Object} Player index → `{damage, dotDamage, dotTicks, hits, crits, misses, byAbility, byEnemy}`
 */
export function foldEvents(tally, events, { filterNonDamaging = true, nonDamaging, nameOf } = {}) {
    for (const event of events || []) {
        // A death is not a swing, and counting it as one would add a phantom
        // hit to whoever happened to be casting. Unattributed damage has no
        // player row to land in — `foldTeam` is where it is counted
        if (event.isKill || event.isUnattributed) continue;

        const player = (tally[event.playerIndex] = tally[event.playerIndex] || {
            damage: 0,
            dotDamage: 0,
            dotTicks: 0,
            hits: 0,
            crits: 0,
            misses: 0,
            byAbility: {},
            byEnemy: {},
        });
        // A row banked before these fields existed, or merged from one
        if (!Number.isFinite(player.dotDamage)) player.dotDamage = 0;
        if (!Number.isFinite(player.dotTicks)) player.dotTicks = 0;
        const weight = Number.isFinite(event.weight) && event.weight > 0 ? event.weight : 1;

        // Counted before the filter: a miss is a swing that happened, and
        // dropping it would flatter the hit rate of whatever was cast
        if (event.isMiss) player.misses += weight;
        if (filterNonDamaging && !isDamagingAction(event.action, nonDamaging)) continue;

        if (event.isDot) {
            player.damage += event.amount;
            player.dotDamage += event.amount;
            // Counted, not merely summed. A tick lands for a fraction of the
            // blow that applied it, so the RATIO of ticks to swings moves
            // damage-per-hit on its own — and the damage subtotal cannot say
            // how many ticks made it up. The labyrinth replay compares this
            // ratio against the sim's to decide whether a soft-hit gap is the
            // monster's mitigation or just a different hit mix.
            player.dotTicks += weight;
        } else if (event.isReflect) {
            player.damage += event.amount;
        } else if (!event.isMiss && !event.isHeal) {
            player.damage += event.amount;
            player.hits += weight;
            if (event.isCrit) player.crits += weight;
        }

        const ability = (player.byAbility[event.action] = player.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });
        if (event.isMiss) ability.misses += weight;
        // A bleed has no swing behind it on this tick, so it moves the damage
        // under its own label and leaves the counts alone
        else if (event.isDot || event.isReflect) ability.damage += event.amount;
        else if (!event.isHeal) {
            ability.damage += event.amount;
            ability.hits += weight;
            if (event.isCrit) ability.crits += weight;
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
            enemy.misses += weight;
            against.misses += weight;
        } else if (event.isDot || event.isReflect) {
            enemy.damage += event.amount;
            against.damage += event.amount;
        } else if (!event.isHeal) {
            enemy.damage += event.amount;
            enemy.hits += weight;
            against.damage += event.amount;
            against.hits += weight;
            if (event.isCrit) {
                enemy.crits += weight;
                against.crits += weight;
            }
        }
    }
    return tally;
}

/**
 * The bucket a kill on a monster {@link foldEnemies}'s `nameOf` cannot name is
 * counted under, rather than dropped.
 *
 * `nameOf` answers null for a monster a reload mid-fight never saw a
 * `new_battle` for (see `damage-tracker.js`'s `recoverMonsterNames` fallback,
 * which fills in what it can but not always a name). The per-player kill
 * tally (`damage-tracker.js`'s `kills`) has no such gate at all — every
 * killing tick's sole owner is credited whether or not the monster it killed
 * has a name — so dropping the kill here instead of naming it made the sum of
 * every row in this table read lower than the sum of every player's kills by
 * exactly the kills this client could never label.
 */
export const UNKNOWN_ENEMY = 'Unknown enemy';

/** A fresh per-monster tally row, shared by a named enemy and {@link UNKNOWN_ENEMY} */
function newEnemyTally() {
    return { damage: 0, hits: 0, crits: 0, misses: 0, kills: 0, dotDamage: 0, byAbility: {} };
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
 * Unattributed damage (see {@link UNATTRIBUTED_ACTION}) is counted here like any
 * other — the monster lost the health whoever dealt it — and also named in an
 * `unattributedDamage` subtotal that appears once there is any. A kill on a
 * monster `nameOf` cannot name lands in {@link UNKNOWN_ENEMY} rather than
 * being dropped, so this table's kills always sum to the player table's.
 *
 * @param {Function} nameOf - `(monsterIndex) => string|null`
 * @returns {Object} Monster name → `{damage, dotDamage, hits, crits, misses, kills, byAbility, unattributedDamage?}`
 */
export function foldEnemies(tally, events, nameOf) {
    for (const event of events || []) {
        const name = nameOf(event.monsterIndex);

        if (event.isKill) {
            const key = name || UNKNOWN_ENEMY;
            const enemy = (tally[key] = tally[key] || newEnemyTally());
            enemy.kills++;
            continue;
        }
        if (!name) continue;

        const enemy = (tally[name] = tally[name] || newEnemyTally());

        const ability = (enemy.byAbility[event.action] = enemy.byAbility[event.action] || {
            damage: 0,
            hits: 0,
            crits: 0,
            misses: 0,
        });

        const weight = Number.isFinite(event.weight) && event.weight > 0 ? event.weight : 1;
        if (event.isUnattributed) enemy.unattributedDamage = (enemy.unattributedDamage || 0) + event.amount;
        if (event.isMiss) {
            enemy.misses += weight;
            ability.misses += weight;
        } else if (event.isReflect) {
            enemy.damage += event.amount;
            ability.damage += event.amount;
        } else if (event.isDot) {
            // Real damage the monster took, with no swing behind it here
            enemy.damage += event.amount;
            enemy.dotDamage = (enemy.dotDamage || 0) + event.amount;
            ability.damage += event.amount;
        } else if (!event.isHeal) {
            enemy.damage += event.amount;
            enemy.hits += weight;
            ability.damage += event.amount;
            ability.hits += weight;
            if (event.isCrit) {
                enemy.crits += weight;
                ability.crits += weight;
            }
        }
    }
    return tally;
}

/**
 * Fold events into the team's totals.
 *
 * The board's team figure used to be the sum of its player rows, so health a
 * tick could credit to nobody fell out of it silently. This is the whole of
 * what the monsters lost — attributed and unattributed — with the unattributed
 * share named, so a tracker can show "team total" and an "unattributed" line
 * that add up. It needs events from `attributeTick(..., {unattributed: true})`;
 * without them `unattributed` stays 0 and `damage` equals the attributed sum.
 *
 * Deliberately ignores the non-damaging filter: that decides which rows a
 * player's damage is shown in, not whether the monster lost the health.
 *
 * @param {Object} team - `{}` or a previous return, mutated
 * @param {Array<Object>} events - From `attributeTick`
 * @returns {{damage: number, attributed: number, unattributed: number, unattributedEvents: number}}
 */
export function foldTeam(team, events) {
    team.damage = team.damage || 0;
    team.attributed = team.attributed || 0;
    team.unattributed = team.unattributed || 0;
    team.unattributedEvents = team.unattributedEvents || 0;

    for (const event of events || []) {
        if (event.isKill || event.isMiss || event.isHeal) continue;
        const amount = Number(event.amount) || 0;
        team.damage += amount;
        if (event.isUnattributed) {
            team.unattributed += amount;
            team.unattributedEvents += 1;
        } else {
            team.attributed += amount;
        }
    }
    return team;
}
