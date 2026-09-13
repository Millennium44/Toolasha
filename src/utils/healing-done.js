/**
 * Healing done
 *
 * Who healed, in a personal or party fight, from a payload that says only whose
 * health went up.
 *
 * `damage-taken.js` files a rise under the player who received it, which is the
 * right answer for "how much came back to me" and no answer for "who is
 * healing". This credits a rise to a player only when the stream shows that
 * player causing it, and puts everything else on one team-level line.
 *
 * ## A revive is not a heal
 *
 * Zero to positive is a whole bar arriving at once. Crediting it hands the
 * tick's caster a burst several times anything they can cast, on a tick they may
 * not have acted on. Counted in `revived`, nowhere else.
 *
 * ## Regeneration identifies itself by the mana beside it
 *
 * The personal stream's regeneration arrives every ten seconds as a player's
 * health **and** mana rising together — on the five recordings, every such tick
 * sits on that cadence with a constant amount per player (79 and 54 in one
 * party, 22 solo). It is not the trial's uniform fraction of maximum: those two
 * party members regenerate 3.6% and 2.5% of their bars on the same tick, so the
 * trial's shape test would never learn it. So:
 *
 * - a rise with the player's own mana rising is regeneration, and teaches that
 *   player's regeneration amount when it did not top them up to full;
 * - on a tick with no heal source (below) where anyone's health and mana rose
 *   together, every rise is regeneration — a player at full mana shows no mana
 *   rise;
 * - otherwise a rise of the learned amount (give or take a point), or a smaller
 *   one that topped the player up to full, is regeneration.
 *
 * On a tick with a heal source only the learned-amount test applies (and the
 * mana test for a player with nothing learned), so a heal landing beside a
 * regeneration tick is not swallowed by it. Regeneration is held in `regen`.
 *
 * ## Only three things earn a player healing
 *
 * What the combat engine can put on a bar for somebody else's doing
 * (`features/combat-sim/engine/combat-simulator.js` `tryUseAbility`,
 * `processAbilityHealEffect`; `combat-utilities.js` `processAttack`):
 *
 * 1. **Life-steal on the hitter's own bar.** An auto-attack that landed, from a
 *    player whose sheet states `lifeSteal`, heals `floor(lifeSteal × damage)`;
 *    an ability hit whose effect states `hpDrainRatio` (Life Drain) heals
 *    `floor(ratio × damage × (1 + healingAmplify))`. Credited to the hitter up
 *    to that amount (plus a point), from the damage their events carry this
 *    tick. On a tick their hit killed, the health lost undercounts the damage
 *    (overkill), so no cap; nor when the sheet that states `healingAmplify` is
 *    missing. Labelled {@link LIFESTEAL_HEAL} or the draining ability.
 * 2. **A healing ability cast.** The attack counter rose while an ability whose
 *    effects heal was prepared. Its casters share the rises that are left, each
 *    under their own heal. A heal whose every heal effect targets `self` owns
 *    only its caster's rise.
 * 3. **Bloom.** Any ability cast — never an auto-attack — by a unit with `bloom`
 *    on its sheet rolls that chance to heal the living ally lowest by health
 *    fraction, ties to the earlier slot, by up to
 *    `(0.15 × magicMaxDamage + 10) × (1 + healingAmplify)`. The rise on that ally
 *    is credited to the caster, up to that amount when `magicMaxDamage` is
 *    known, under `bloom:<ability>` — the proc, not the ability. The target is
 *    judged on health going *into* the tick: damage and heals the server applied
 *    earlier in the same tick can have moved who was lowest when it rolled, and
 *    the rise on the ally it really picked then goes uncredited.
 *
 * The stream cannot tell a proc that landed from one that did not: a rise on the
 * Bloom target on a Bloom caster's tick — food, or regeneration the target has
 * not taught — is credited as Bloom, up to the cap. What cannot be told apart is
 * credited to Bloom rather than dropped only because the target, the tick and
 * the caster all match; a rise on anybody else is not.
 *
 * Everything else — food and drink, regeneration nothing taught, a life-steal
 * or Bloom from a unit whose sheet was never stated, rises beyond a cap — goes
 * to `uncredited`, a team-level figure on nobody's row. `total + uncredited +
 * regen` is every non-revive rise.
 */

import { classifyAbility } from '../features/guild/guild-trial-support.js';

/** The label a life-steal on an auto-attack is filed under */
export const LIFESTEAL_HEAL = 'lifesteal';

/** Prefix of the label a Bloom proc is filed under; the rest is the ability that rolled it */
export const BLOOM_HEAL_PREFIX = 'bloom:';

/** Bloom's heal: flat and per-`magicMaxDamage` parts, as `combat-sim/engine/ability.js` states the proc */
const BLOOM_FLAT = 10;
const BLOOM_RATIO = 0.15;

/** How far off a player's learned regeneration a rise may round and still be it, in HP */
const REGEN_TOLERANCE_HP = 1;

/** Slack on a computed heal cap for the game's rounding, in HP */
const CAP_TOLERANCE_HP = 1;

/**
 * A fresh healing state.
 * @returns {{lastHP: Object, lastMP: Object, lastAtk: Object, lastMax: Object, regenAmount: Object,
 *   players: Object, total: number, uncredited: number, regen: number, revived: number, shared: number}}
 */
export function newHealingState() {
    return {
        lastHP: {},
        lastMP: {},
        lastAtk: {},
        /** Player index → maximum health, for Bloom's lowest-fraction target */
        lastMax: {},
        /** Player index → the size of their regeneration tick, once seen */
        regenAmount: {},
        /** Player index → `{healing, byAbility}` */
        players: {},
        /** Healing credited to somebody */
        total: 0,
        /** Rises no heal, life-steal or Bloom accounts for; on nobody's row */
        uncredited: 0,
        /** Regeneration, held out of every player's row */
        regen: 0,
        /** Health that came back with a revive, held out too */
        revived: 0,
        /** The part of `total` split between several casters on one tick */
        shared: 0,
    };
}

/**
 * The healing-relevant figures off one unit's sheet.
 *
 * `combatStats` omits a stat that is zero, so a stated sheet without `bloom` is
 * a unit with none; no sheet at all is unknown, and returns null.
 *
 * @param {Object|null} stats - `combatDetails.combatStats`
 * @param {number|null} [magicMaxDamage] - `combatDetails.magicMaxDamage`
 * @returns {{bloom: number, lifeSteal: number, healingAmplify: number, magicMaxDamage: number|null}|null}
 */
export function healingUnitStats(stats, magicMaxDamage = null) {
    if (!stats || typeof stats !== 'object') return null;
    const figure = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);
    const max = Number(magicMaxDamage);
    return {
        bloom: figure(stats.bloom),
        lifeSteal: figure(stats.lifeSteal),
        healingAmplify: figure(stats.healingAmplify),
        magicMaxDamage: magicMaxDamage !== null && Number.isFinite(max) && max > 0 ? max : null,
    };
}

/**
 * Take this battle's stated health and mana as the baselines.
 * @param {Object} state - From {@link newHealingState}, mutated
 * @param {Object} players - `new_battle`'s `players`
 */
export function seedHealingState(state, players) {
    for (const [index, player] of Object.entries(players || {})) {
        const hp = Number(player?.currentHitpoints ?? player?.combatDetails?.currentHitpoints);
        if (Number.isFinite(hp)) state.lastHP[index] = hp;
        const mp = Number(player?.currentManapoints ?? player?.combatDetails?.currentManapoints);
        if (Number.isFinite(mp)) state.lastMP[index] = mp;
        const max = Number(player?.maxHitpoints ?? player?.combatDetails?.maxHitpoints);
        if (Number.isFinite(max) && max > 0) (state.lastMax ||= {})[index] = max;
    }
}

/**
 * Forget the baselines — for a battle nothing announced, whose slots may be
 * somebody else's. Learned regeneration and the ledger are kept.
 * @param {Object} state - From {@link newHealingState}, mutated
 */
export function resetHealingBaselines(state) {
    state.lastHP = {};
    state.lastMP = {};
    state.lastAtk = {};
    state.lastMax = {};
}

/**
 * Credit one amount to one player under one label.
 * @param {Object} state - Mutated
 * @param {string} index - Player index
 * @param {string} label - What did it
 * @param {number} amount - Health
 */
function credit(state, index, label, amount) {
    if (!(amount > 0)) return;
    const row = (state.players[index] ||= { healing: 0, byAbility: {} });
    row.healing += amount;
    row.byAbility[label] = (row.byAbility[label] || 0) + amount;
    state.total += amount;
}

/**
 * The largest `hpDrainRatio` an ability's effects state.
 * @param {string} action - Ability hrid
 * @param {Object} [detailMap] - `abilityDetailMap`
 * @returns {number} 0 when none, or when the ability is not in the map
 */
function drainRatio(action, detailMap) {
    const effects = detailMap?.[action]?.abilityEffects;
    if (!Array.isArray(effects)) return 0;
    return effects.reduce((most, effect) => Math.max(most, Number(effect?.hpDrainRatio) || 0), 0);
}

/**
 * Whether every heal effect of an ability targets its caster alone.
 * @param {string} action - Ability hrid
 * @param {Object} [detailMap] - `abilityDetailMap`
 * @returns {boolean} False when the data does not say
 */
function healsSelfOnly(action, detailMap) {
    const effects = detailMap?.[action]?.abilityEffects;
    if (!Array.isArray(effects)) return false;
    const heals = effects.filter((effect) => String(effect?.effectType || '').includes('heal'));
    return heals.length > 0 && heals.every((effect) => effect?.targetType === 'self');
}

/**
 * Fold one tick's `pMap` into the healing ledger.
 *
 * Call it after `attributeTick` (its events say who landed what) and before
 * `noteActions` updates `actions` for the next tick: the heal that landed on this
 * tick was cast by what was being prepared before it.
 *
 * @param {Object} state - From {@link newHealingState}, mutated
 * @param {Object} pMap - The tick's players
 * @param {Object} [actions] - Player index → ability hrid, `auto` or `idle`, going into this tick
 * @param {Object} [detailMap] - `abilityDetailMap`, to tell a heal or a drain from any other cast
 * @param {Object} [context] - What else the tick is known by
 * @param {Array<Object>} [context.events] - `attributeTick`'s events for this tick
 * @param {Object} [context.units] - Player index → {@link healingUnitStats}, where a sheet was stated
 */
export function foldHealingTick(state, pMap, actions = {}, detailMap, { events = [], units = {} } = {}) {
    state.lastMax ||= {};
    const present = Object.keys(pMap || {}).filter((index) => pMap[index]);
    // Bloom picks its target off health going into the tick
    const hpBefore = { ...state.lastHP };
    const maxBefore = { ...state.lastMax };
    const rises = [];
    const healers = [];
    const casters = [];
    /** Player index → what they swung with this tick, auto included */
    const swungWith = {};

    for (const index of present) {
        const unit = pMap[index];

        let manaRose = false;
        const mana = Number(unit.cMP);
        if (Number.isFinite(mana)) {
            const before = state.lastMP[index];
            if (before !== undefined && mana > before) manaRose = true;
            state.lastMP[index] = mana;
        }

        const attacks = Number(unit.atkCounter);
        if (Number.isFinite(attacks)) {
            const before = state.lastAtk[index];
            if (before !== undefined && attacks > before) {
                const action = actions?.[index] || 'idle';
                swungWith[index] = action;
                if (action !== 'auto' && action !== 'idle') {
                    casters.push(index);
                    if (classifyAbility(action, detailMap).heals) healers.push(index);
                }
            }
            state.lastAtk[index] = attacks;
        }

        const max = Number(unit.mHP);
        if (Number.isFinite(max) && max > 0) state.lastMax[index] = max;

        const health = Number(unit.cHP);
        if (Number.isFinite(health)) {
            const before = state.lastHP[index];
            if (before !== undefined && health > before) {
                if (before <= 0) state.revived += health - before;
                else {
                    const cap = state.lastMax[index];
                    rises.push({
                        index,
                        amount: health - before,
                        manaRose,
                        capped: cap > 0 && health >= cap,
                    });
                }
            }
            state.lastHP[index] = health;
        }
    }

    if (!rises.length) return;

    // Damage each player's own events landed this tick, and whether one killed
    const hits = {};
    for (const event of events || []) {
        if (event?.isKill) {
            if (event.killerIndex !== null && event.killerIndex !== undefined) {
                (hits[event.killerIndex] ||= { damage: 0, killed: false }).killed = true;
            }
            continue;
        }
        if (event?.playerIndex === null || event?.playerIndex === undefined || event.isUnattributed) continue;
        if (event.isMiss || event.isHeal || event.isDot || event.isReflect || !(event.amount > 0)) continue;
        (hits[event.playerIndex] ||= { damage: 0, killed: false }).damage += event.amount;
    }

    /** Player index → `{label, cap}` for a life-steal their hit can have put on their own bar */
    const leeches = {};
    for (const [index, hit] of Object.entries(hits)) {
        if (!(hit.damage > 0)) continue;
        const action = swungWith[index] || actions?.[index];
        const unit = units?.[index] || null;
        if (action === 'auto') {
            const ratio = unit?.lifeSteal;
            if (!(ratio > 0)) continue;
            leeches[index] = {
                label: LIFESTEAL_HEAL,
                cap: hit.killed ? Infinity : Math.floor(ratio * hit.damage) + CAP_TOLERANCE_HP,
            };
            continue;
        }
        const ratio = action && action !== 'idle' ? drainRatio(action, detailMap) : 0;
        if (!(ratio > 0)) continue;
        leeches[index] = {
            label: action,
            cap:
                hit.killed || !Number.isFinite(unit?.healingAmplify)
                    ? Infinity
                    : Math.floor(ratio * hit.damage * (1 + unit.healingAmplify)) + CAP_TOLERANCE_HP,
        };
    }

    const bloomers = casters.filter((index) => units?.[index]?.bloom > 0);
    let bloomTarget = null;
    if (bloomers.length) {
        let lowest = Infinity;
        for (const index of Object.keys(hpBefore).sort((a, b) => Number(a) - Number(b))) {
            const hp = hpBefore[index];
            const max = maxBefore[index];
            if (!(hp > 0) || !(max > 0)) continue;
            if (hp / max < lowest) {
                lowest = hp / max;
                bloomTarget = index;
            }
        }
    }

    const healSourced = healers.length > 0 || bloomers.length > 0 || Object.keys(leeches).length > 0;
    const regenTick = !healSourced && rises.some((rise) => rise.manaRose);
    const rest = [];
    for (const rise of rises) {
        const learned = state.regenAmount[rise.index];
        const fits =
            learned > 0 &&
            (Math.abs(rise.amount - learned) <= REGEN_TOLERANCE_HP ||
                (rise.capped && rise.amount <= learned + REGEN_TOLERANCE_HP));
        const regen = healSourced ? fits || (rise.manaRose && !(learned > 0)) : fits || rise.manaRose || regenTick;

        if (!regen) {
            rest.push(rise);
            continue;
        }
        state.regen += rise.amount;
        if (rise.manaRose && !rise.capped && !healSourced) state.regenAmount[rise.index] = rise.amount;
    }

    for (const rise of rest) {
        let amount = rise.amount;

        const leech = leeches[rise.index];
        if (leech) {
            const part = Math.min(amount, leech.cap);
            credit(state, rise.index, leech.label, part);
            amount -= part;
        }

        const reaching = healers.filter((index) => index === rise.index || !healsSelfOnly(swungWith[index], detailMap));
        if (amount > 0 && reaching.length) {
            for (const index of reaching) credit(state, index, swungWith[index], amount / reaching.length);
            if (reaching.length > 1) state.shared += amount;
            amount = 0;
        }

        if (amount > 0 && rise.index === bloomTarget) {
            const cap = bloomers.reduce((sum, index) => {
                const unit = units[index];
                if (unit.magicMaxDamage === null || !Number.isFinite(unit.healingAmplify)) return Infinity;
                return (
                    sum +
                    Math.floor((BLOOM_RATIO * unit.magicMaxDamage + BLOOM_FLAT) * (1 + unit.healingAmplify)) +
                    CAP_TOLERANCE_HP
                );
            }, 0);
            const part = Math.min(amount, cap);
            for (const index of bloomers) {
                credit(state, index, `${BLOOM_HEAL_PREFIX}${swungWith[index]}`, part / bloomers.length);
            }
            if (bloomers.length > 1) state.shared += part;
            amount -= part;
        }

        if (amount > 0) state.uncredited += amount;
    }
}
