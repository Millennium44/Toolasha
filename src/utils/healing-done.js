/**
 * Healing done
 *
 * Who healed, in a personal or party fight, from a payload that says only whose
 * health went up.
 *
 * `damage-taken.js` files a rise under the player who received it, which is the
 * right answer for "how much came back to me" and no answer for "who is
 * healing". KikiMeter credits a rise to the tick's caster and splits it when
 * there is none (v3.40.6, 18/08); this does the same with two things held out of
 * the ledger first, because neither is anybody's healing:
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
 * - on a tick where anyone's health and mana rose together and nobody cast a
 *   heal, every rise is regeneration — a player at full mana shows no mana rise;
 * - otherwise a rise of the learned amount (give or take a point), or a smaller
 *   one that topped the player up to full, is regeneration.
 *
 * On a tick with a heal cast only the learned-amount test applies, so a heal
 * landing beside a regeneration tick is not swallowed by it. A player whose mana
 * is always full never teaches an amount, and their regeneration is credited as
 * healing like any other rise — the residual this cannot see.
 *
 * ## What is left goes to the caster
 *
 * Strongest first: a lone heal cast this tick (the attack counter rose while a
 * healing ability was prepared), the lone player on the tick (the server groups
 * a tick by actor — a life-steal or self-heal), a lone ability cast of any kind
 * (an on-cast proc such as Bloom never labels itself a heal), a lone mana drop
 * (for payloads without attack counters). With none of those it is split equally
 * among the players present, as KikiMeter splits it, and the split is counted in
 * `shared` so a reader can see how much of a row is that.
 *
 * Each credit is labelled with what did it — the heal, the ability, `auto` for a
 * life-steal on a swing — so a row can be broken down per ability.
 */

import { classifyAbility } from '../features/guild/guild-trial-support.js';

/** The label a split rise is filed under on every player it was split between */
export const SHARED_HEAL = 'shared';

/** The label a credited rise is filed under when its owner neither cast nor swung */
export const OTHER_HEAL = 'other';

/** How far off a player's learned regeneration a rise may round and still be it, in HP */
const REGEN_TOLERANCE_HP = 1;

/**
 * A fresh healing state.
 * @returns {{lastHP: Object, lastMP: Object, lastAtk: Object, regenAmount: Object, players: Object,
 *   total: number, regen: number, revived: number, shared: number}}
 */
export function newHealingState() {
    return {
        lastHP: {},
        lastMP: {},
        lastAtk: {},
        /** Player index → the size of their regeneration tick, once seen */
        regenAmount: {},
        /** Player index → `{healing, byAbility}` */
        players: {},
        /** Healing credited to somebody, split shares included */
        total: 0,
        /** Regeneration, held out of every player's row */
        regen: 0,
        /** Health that came back with a revive, held out too */
        revived: 0,
        /** The part of `total` split among those present for want of a caster */
        shared: 0,
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
}

/**
 * Credit one amount to one player under one label.
 * @param {Object} state - Mutated
 * @param {string} index - Player index
 * @param {string} label - What did it
 * @param {number} amount - Health
 */
function credit(state, index, label, amount) {
    const row = (state.players[index] ||= { healing: 0, byAbility: {} });
    row.healing += amount;
    row.byAbility[label] = (row.byAbility[label] || 0) + amount;
}

/**
 * Fold one tick's `pMap` into the healing ledger.
 *
 * Call it before `noteActions` updates `actions` for the next tick: the heal
 * that landed on this tick was cast by what was being prepared before it.
 *
 * @param {Object} state - From {@link newHealingState}, mutated
 * @param {Object} pMap - The tick's players
 * @param {Object} [actions] - Player index → ability hrid, `auto` or `idle`, going into this tick
 * @param {Object} [detailMap] - `abilityDetailMap`, to tell a heal from any other cast
 */
export function foldHealingTick(state, pMap, actions = {}, detailMap) {
    const present = Object.keys(pMap || {}).filter((index) => pMap[index]);
    const rises = [];
    const healers = [];
    const casters = [];
    const spent = [];
    /** Player index → what they swung with this tick, auto included */
    const swungWith = {};

    for (const index of present) {
        const unit = pMap[index];

        let manaRose = false;
        const mana = Number(unit.cMP);
        if (Number.isFinite(mana)) {
            const before = state.lastMP[index];
            if (before !== undefined && mana > before) manaRose = true;
            else if (before !== undefined && mana < before) spent.push(index);
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

        const health = Number(unit.cHP);
        if (Number.isFinite(health)) {
            const before = state.lastHP[index];
            if (before !== undefined && health > before) {
                if (before <= 0) state.revived += health - before;
                else {
                    const max = Number(unit.mHP);
                    rises.push({
                        index,
                        amount: health - before,
                        manaRose,
                        capped: Number.isFinite(max) && max > 0 && health >= max,
                    });
                }
            }
            state.lastHP[index] = health;
        }
    }

    if (!rises.length) return;

    const regenTick = healers.length === 0 && rises.some((rise) => rise.manaRose);
    let remainder = 0;
    for (const rise of rises) {
        const learned = state.regenAmount[rise.index];
        const fits =
            learned > 0 &&
            (Math.abs(rise.amount - learned) <= REGEN_TOLERANCE_HP ||
                (rise.capped && rise.amount <= learned + REGEN_TOLERANCE_HP));
        const regen = healers.length ? fits || (rise.manaRose && !(learned > 0)) : fits || rise.manaRose || regenTick;

        if (!regen) {
            remainder += rise.amount;
            continue;
        }
        state.regen += rise.amount;
        if (rise.manaRose && !rise.capped && !healers.length) state.regenAmount[rise.index] = rise.amount;
    }
    if (!(remainder > 0)) return;
    state.total += remainder;

    let owner = null;
    if (healers.length === 1) owner = healers[0];
    else if (present.length === 1) owner = present[0];
    else if (casters.length === 1) owner = casters[0];
    else if (spent.length === 1) owner = spent[0];

    if (owner !== null) {
        credit(state, owner, swungWith[owner] || OTHER_HEAL, remainder);
        return;
    }

    const share = remainder / present.length;
    for (const index of present) credit(state, index, SHARED_HEAL, share);
    state.shared += remainder;
}
