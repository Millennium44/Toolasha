/**
 * What a trial fight can say about a player besides damage.
 *
 * The trials feature already splits damage per player. The next four questions a
 * guild asks — who tanked it, who healed it, who kept the buffs up, and how much
 * was mitigated — are not four questions of the same kind, because the payload
 * answers three of them and cannot answer the fourth. This file is the three,
 * and the fourth is documented here rather than estimated somewhere else.
 *
 * ## What a tick actually carries
 *
 * Surveyed across five recorded runs — 6,700 `battle_updated` messages — a
 * `pMap` entry has exactly these fields and no others:
 *
 * ```
 * cHP  mHP  cMP  mMP  isActive  leftCombat
 * atkCounter  isAutoAtk  abilityHrid  int  dmgCounter  critCounter  isStunned
 * ```
 *
 * So:
 *
 * - **Damage taken** is health falling, and **healing received** is health
 *   rising. Both are measured here, per player, by diffing the same way
 *   `damage-attribution.js` diffs monsters. In a trial specifically these are
 *   cleaner than in the open world: the guide replaces food and drinks with a
 *   flat regeneration, so nobody is quietly topping themselves up from a
 *   consumable nobody else can see.
 * - **Casts** are `atkCounter` rising, and what was cast is the ability the
 *   player was preparing — the join `damage-attribution.js` already makes.
 *   Counting them per ability gives "who kept Provoke up" without inventing a
 *   number for it.
 * - **Damage mitigated cannot be derived.** Nothing in the payload states a hit
 *   before armour, resistance or parry took their share; only the health that
 *   was actually lost is on the wire. A "mitigated" figure would be this
 *   script's own combat model run against the loadout — a simulation with a
 *   measurement's name on it — so it is not offered. What *is* offered is the
 *   mitigation *ratings* each player brought, which `guild-loadouts.js` already
 *   captures from `battle_unit_fetched`, and damage actually taken, here.
 * - **Threat has no live figure either.** `combatStats.threat` is a rating on
 *   the loadout and is captured; which unit the boss is currently attacking is
 *   never stated. Damage taken is the observable proxy and is what the tank row
 *   shows.
 *
 * ## Crediting a heal to the healer
 *
 * The health rise lands on the *recipient*, and the payload does not say who
 * caused it. This uses the discipline the damage attribution uses rather than a
 * second, looser one: on a tick where exactly one player cast a healing ability,
 * the rises on that tick are credited to them; where none or several did, the
 * amount is kept as `unattributed` and shown as such. A guild would rather see
 * "1.2M healed, 300K of it unattributed" than a number quietly assigned to
 * whoever was most likely.
 *
 * Which abilities heal is read from the game's own data — an
 * `abilityDetailMap` entry whose `abilityEffects` carry an `effectType`
 * containing "heal" — with a small name fallback for a client that has not
 * loaded. Buff abilities are found the same way, from effects that carry
 * `buffs`.
 */

import dataManager from '../../core/data-manager.js';

/** Abilities that heal, when client data cannot be read */
const HEAL_NAME_PATTERN = /heal|rejuvenat|mend|restor|renew/i;

/** Abilities that buff, when client data cannot be read */
const BUFF_NAME_PATTERN = /aura|frenzy|berserk|precision|toughness|spike_shell|provoke|fury|might|blessing/i;

/**
 * What an ability does, as far as the game's own data says.
 *
 * Read from `abilityEffects` rather than from a list this file maintains: a list
 * goes stale the first time an ability is added, and the effect type is the
 * game's own statement of what the thing does.
 *
 * @param {string} hrid - Ability hrid, or `auto`/`idle` from the attribution state
 * @param {Object} [detailMap] - `abilityDetailMap`; read from client data when omitted
 * @returns {{heals: boolean, buffs: boolean, known: boolean}} What it does
 */
export function classifyAbility(hrid, detailMap) {
    const id = String(hrid || '');
    if (!id || id === 'auto' || id === 'idle') return { heals: false, buffs: false, known: true };

    const map = detailMap || dataManager.getInitClientData?.()?.abilityDetailMap || {};
    const detail = map?.[id];
    const effects = Array.isArray(detail?.abilityEffects) ? detail.abilityEffects : null;

    if (effects) {
        let heals = false;
        let buffs = false;
        for (const effect of effects) {
            if (String(effect?.effectType || '').includes('heal')) heals = true;
            if (Array.isArray(effect?.buffs) && effect.buffs.length) buffs = true;
        }
        return { heals, buffs, known: true };
    }

    // No client data. The names are a fallback and are marked as such, so a
    // caller can say "read from the ability names" rather than implying the game
    // confirmed it
    return { heals: HEAL_NAME_PATTERN.test(id), buffs: BUFF_NAME_PATTERN.test(id), known: false };
}

/**
 * A fresh support state.
 * @returns {{players: Object, lastHP: Object, lastMP: Object, lastAtk: Object, emptySince: Object,
 *   unattributedHealing: number, abilityKindsKnown: boolean}} State
 */
export function newSupportState() {
    return {
        players: {},
        lastHP: {},
        lastMP: {},
        lastAtk: {},
        emptySince: {},
        unattributedHealing: 0,
        abilityKindsKnown: true,
    };
}

/**
 * The per-player row this file keeps.
 * @returns {Object} An empty row
 */
function emptyRow() {
    return {
        damageTaken: 0,
        healingReceived: 0,
        healingDone: 0,
        manaSpent: 0,
        manaRestored: 0,
        casts: 0,
        healCasts: 0,
        buffCasts: 0,
        castsByAbility: {},
        lowestHealthFraction: null,
        // Running out of mana is the thing a caster notices and the log never
        // mentions: the bar simply stops moving. Counted as *transitions* to
        // empty rather than ticks at empty, so sitting at zero for a minute is
        // one dry spell and not sixty
        manaOuts: 0,
        emptyManaMs: 0,
        outOfMana: false,
    };
}

/**
 * Fold one tick's `pMap` into the support tally.
 *
 * Mutates `state`, in the shape the rest of the trials feature already uses for
 * its tallies, and returns nothing — the reader is {@link summariseSupport}.
 *
 * `actions` is the attribution state's own map of what each player was
 * preparing, which is why this must be called *before* `noteActions` updates it
 * for the next tick: the cast that healed on this tick is the one that was
 * being prepared before it, exactly as with damage.
 *
 * @param {Object} state - From {@link newSupportState}
 * @param {Object} pMap - The tick's players
 * @param {Object} [actions] - Player index → ability hrid, `auto` or `idle`
 * @param {Object} [detailMap] - `abilityDetailMap`, for tests
 * @param {number|null} [at] - When the tick arrived, for the time spent at empty
 */
export function foldSupportTick(state, pMap, actions = {}, detailMap, at = null) {
    const entries = Object.entries(pMap || {});
    if (!entries.length) return;

    const healers = [];
    const risesThisTick = [];

    for (const [index, player] of entries) {
        const row = (state.players[index] ||= emptyRow());

        const health = Number(player?.cHP);
        if (Number.isFinite(health)) {
            const before = state.lastHP[index];
            if (before !== undefined) {
                const change = health - before;
                if (change > 0) {
                    row.healingReceived += change;
                    risesThisTick.push({ index, amount: change });
                } else if (change < 0) {
                    row.damageTaken += -change;
                }
            }
            state.lastHP[index] = health;

            const max = Number(player?.mHP);
            if (Number.isFinite(max) && max > 0) {
                const fraction = Math.max(0, health) / max;
                row.lowestHealthFraction =
                    row.lowestHealthFraction === null ? fraction : Math.min(row.lowestHealthFraction, fraction);
            }
        }

        const mana = Number(player?.cMP);
        if (Number.isFinite(mana)) {
            const before = state.lastMP[index];
            if (before !== undefined) {
                const change = mana - before;
                if (change > 0) row.manaRestored += change;
                else if (change < 0) row.manaSpent += -change;
            }
            state.lastMP[index] = mana;

            // A dry spell begins when the bar reaches zero and ends when it
            // leaves; the time between is charged to whoever was empty
            const empty = mana <= 0;
            if (empty && !row.outOfMana) {
                row.manaOuts += 1;
                row.outOfMana = true;
                state.emptySince[index] = at;
            } else if (!empty && row.outOfMana) {
                const since = state.emptySince[index];
                if (Number.isFinite(since) && Number.isFinite(at)) row.emptyManaMs += Math.max(0, at - since);
                row.outOfMana = false;
                delete state.emptySince[index];
            } else if (empty && Number.isFinite(at)) {
                const since = state.emptySince[index];
                if (Number.isFinite(since)) {
                    row.emptyManaMs += Math.max(0, at - since);
                    state.emptySince[index] = at;
                }
            }
        }

        const attacks = Number(player?.atkCounter);
        if (Number.isFinite(attacks)) {
            const before = state.lastAtk[index];
            if (before !== undefined && attacks > before) {
                const action = actions?.[index] || 'idle';
                const kind = classifyAbility(action, detailMap);
                if (!kind.known) state.abilityKindsKnown = false;

                row.casts += 1;
                if (action && action !== 'idle' && action !== 'auto') {
                    row.castsByAbility[action] = (row.castsByAbility[action] || 0) + 1;
                }
                if (kind.heals) {
                    row.healCasts += 1;
                    healers.push(index);
                }
                if (kind.buffs) row.buffCasts += 1;
            }
            state.lastAtk[index] = attacks;
        }
    }

    // One healer casting on this tick is who the rises belong to. None or
    // several is not something the payload can separate, and a guess would put
    // one player's work on another's row
    const restored = risesThisTick.reduce((sum, rise) => sum + rise.amount, 0);
    if (restored <= 0) return;

    if (healers.length === 1) {
        const row = (state.players[healers[0]] ||= emptyRow());
        row.healingDone += restored;
    } else {
        state.unattributedHealing += restored;
    }
}

/**
 * The support tally as rows a table wants.
 *
 * @param {Object} state - From {@link newSupportState}
 * @param {Object} [names] - Player index → display name
 * @returns {{players: Array<Object>, totals: Object, unattributedHealing: number,
 *   abilityKindsKnown: boolean}} Rows, most damage taken first
 */
export function summariseSupport(state, names = {}) {
    const players = Object.entries(state?.players || {}).map(([index, row]) => ({
        index,
        name: names[index] || `Player ${Number(index) + 1}`,
        ...row,
        castsByAbility: { ...row.castsByAbility },
    }));

    const sum = (field) => players.reduce((total, row) => total + (row[field] || 0), 0);

    return {
        players: players.sort((a, b) => b.damageTaken - a.damageTaken),
        totals: {
            damageTaken: sum('damageTaken'),
            healingReceived: sum('healingReceived'),
            healingDone: sum('healingDone'),
            manaSpent: sum('manaSpent'),
            casts: sum('casts'),
            manaOuts: sum('manaOuts'),
        },
        unattributedHealing: state?.unattributedHealing || 0,
        abilityKindsKnown: state?.abilityKindsKnown !== false,
    };
}

/**
 * What this module can and cannot measure, in a form the export can carry.
 *
 * Shipped *with the data* rather than left in this comment, because the export
 * is read by somebody asking "where is the mitigation column" months later. A
 * field that is absent for a reason should say the reason.
 *
 * @returns {Object<string, string>} Metric → what is known about it
 */
export function supportCoverage() {
    return {
        damageTaken: 'measured — health falling, per player, per tick',
        healingReceived: 'measured — health rising, per player, per tick',
        healingDone: 'attributed only when exactly one player cast a heal on the tick; the rest is unattributed',
        manaSpent: 'measured — mana falling, per player, per tick',
        casts: 'measured — the attack counter rising, labelled with the ability being prepared',
        manaOuts:
            'measured — the mana bar reaching zero, counted per dry spell rather than per tick, ' +
            'with the time spent empty between the tick it emptied on and the tick it recovered on',
        damageMitigated:
            'not carried: no payload states a hit before armour, resistance or parry. ' +
            'The mitigation ratings are on each loadout instead, and damage actually taken is above',
        threat:
            'rating only: `combatStats.threat` is on the loadout. Which unit the boss is attacking ' +
            'is never stated, so live threat cannot be measured — damage taken is the observable proxy',
        amountBuffed:
            'buff *casts* are counted; the size of a buff is not on the wire. `combatBuffMap` arrives ' +
            'once per fight in `new_battle` and is captured with the loadout',
    };
}
