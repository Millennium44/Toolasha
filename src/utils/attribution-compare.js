/**
 * Attribution comparison
 *
 * Two answers to "who dealt this damage", run over the same recording, with a
 * referee that says which one the payload itself supports.
 *
 * ## The two engines
 *
 * **Ours** (`damage-attribution.js`): a hit is a monster's `dmgCounter` rising,
 * and the attacker is named by the counters — the player whose `atkCounter`
 * rose, then the unique mana-spender, then the last player to swing. It refuses
 * bleed ticks (health falling with no counter) and refuses to guess when nobody
 * can be identified.
 *
 * **Presence** (KikiMeter v3, reimplemented faithfully here): the server is
 * claimed to group each `battle_updated` by actor, so *being in `pMap` is the
 * attribution*. All monster health lost in a tick goes to the lone player
 * present; with several present it goes to the unique mana-spender; with none
 * of that it is split equally. No counters are consulted at all.
 *
 * ## The referee
 *
 * The comparison never declares a winner from totals — both engines conserve
 * the team total by construction, so totals cannot distinguish them. Instead
 * every damage tick where the two disagree is adjudicated from signals neither
 * engine's verdict depends on:
 *
 * - A credited player whose own `atkCounter` rose this tick (or within the last
 *   {@link RECENT_SWING_TICKS}) really swung — crediting them is confirmed.
 * - A credited player who was only being *hit* — own `dmgCounter` rising or
 *   health falling, with no swing anywhere near — is the aggro-tank case, and
 *   crediting them is suspect.
 * - Health falling with no monster `dmgCounter` rise is a bleed; no counter can
 *   arbitrate it, so it is tallied apart rather than scored for either side.
 *
 * The same signals also test the presence method's foundational claim directly:
 * over every tick where a hit landed on a monster, how often was a player who
 * had provably swung actually present in `pMap`? Every miss of that is a
 * protocol-grouping violation — a tick whose actor was *not* the one shipped.
 */

import { newAttributionState, noteActions, attributeTick } from './damage-attribution.js';

/**
 * How many ticks back a swing still explains a hit.
 *
 * A swing and the damage it does are not always in the same payload — on the
 * recording that shaped the current engine, 76 of 82 suspect ticks had the real
 * attacker swinging exactly one real tick earlier. Two covers a duplicate
 * payload landing between the swing and its damage.
 */
export const RECENT_SWING_TICKS = 2;

/** Disagreement ticks kept verbatim in the report, so the classes can be spot-checked */
const MAX_SAMPLES = 25;

/**
 * @param {*} value - Anything the wire said
 * @returns {number|null}
 */
function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * A fresh presence-engine state.
 * @returns {Object}
 */
export function newPresenceState() {
    return { monstersHP: {}, playersMP: {}, haveBattle: false };
}

/**
 * Baseline the presence engine from a `new_battle`, exactly as KikiMeter does:
 * monster health and player mana from the wave's opening statement, everything
 * before it forgotten.
 *
 * @param {Object} state - From {@link newPresenceState}, mutated
 * @param {Object} payload - A `new_battle` payload
 */
export function presenceNewBattle(state, payload) {
    state.monstersHP = {};
    state.playersMP = {};
    for (const [index, monster] of Object.entries(payload?.monsters || {})) {
        const hp = num(monster?.currentHitpoints ?? monster?.combatDetails?.currentHitpoints ?? monster?.cHP);
        if (hp !== null) state.monstersHP[index] = hp;
    }
    for (const [index, player] of Object.entries(payload?.players || {})) {
        const mp = num(player?.currentManapoints ?? player?.combatDetails?.currentManapoints ?? player?.cMP);
        if (mp !== null) state.playersMP[index] = mp;
    }
    state.haveBattle = true;
}

/**
 * One tick through the presence method.
 *
 * Faithful to KikiMeter's normal-combat engine: damage is monster health
 * falling against the baseline, the credit order is lone-presence → unique
 * mana-drop → equal split, and a monster with no baseline is skipped rather
 * than seeded.
 *
 * @param {Object} tick - A `battle_updated` payload
 * @param {Object} state - From {@link newPresenceState}, mutated
 * @returns {{damage: number, credited: Object, mode: string}} `credited` is
 *   player index → amount; `mode` is one of `solo|cast|split|orphan|none`
 */
export function presenceTick(tick, state) {
    if (!state.haveBattle) return { damage: 0, credited: {}, mode: 'none' };

    const pMap = tick?.pMap || {};
    const mMap = tick?.mMap || {};
    const present = Object.keys(pMap);

    const droppers = [];
    for (const index of present) {
        const mp = Number(pMap[index]?.cMP) || 0;
        if (state.playersMP[index] !== undefined && mp < state.playersMP[index]) droppers.push(index);
        state.playersMP[index] = mp;
    }
    const castPlayer = droppers.length === 1 ? droppers[0] : null;

    let damage = 0;
    for (const [index, monster] of Object.entries(mMap)) {
        if (state.monstersHP[index] === undefined) continue;
        const hp = Number(monster?.cHP ?? monster?.currentHitpoints) || 0;
        const diff = state.monstersHP[index] - hp;
        state.monstersHP[index] = hp;
        if (diff > 0) damage += diff;
    }
    if (!(damage > 0)) return { damage: 0, credited: {}, mode: 'none' };

    const attributed = present.length === 1 ? present[0] : castPlayer;
    if (attributed !== null) {
        return { damage, credited: { [attributed]: damage }, mode: present.length === 1 ? 'solo' : 'cast' };
    }
    if (present.length > 1) {
        const share = damage / present.length;
        const credited = {};
        for (const index of present) credited[index] = share;
        return { damage, credited, mode: 'split' };
    }
    return { damage, credited: {}, mode: 'orphan' };
}

/**
 * A fresh referee state — the counter baselines the adjudication is diffed
 * against, kept apart from both engines so neither is marking its own homework.
 *
 * @returns {Object}
 */
function newObserver() {
    return { atk: {}, dmg: {}, hp: {}, mDmg: {}, mHP: {}, lastSwingTick: {}, tickIndex: 0 };
}

/**
 * Re-baseline the referee at a wave boundary.
 *
 * Monster baselines are rebuilt — the indices are reused and mean a different
 * monster every battle. The players' are kept: a player is the one thing that
 * is continuous across a battle boundary, and dropping their counter baselines
 * would blind the referee to the first swing of every wave.
 *
 * @param {Object} obs - From {@link newObserver}, mutated
 * @param {Object} payload - A `new_battle` payload
 */
function observeNewBattle(obs, payload) {
    obs.mDmg = {};
    obs.mHP = {};
    for (const [index, player] of Object.entries(payload?.players || {})) {
        const details = player?.combatDetails || {};
        const atk = num(details.atkCounter ?? player?.atkCounter);
        const dmg = num(details.dmgCounter ?? player?.dmgCounter);
        const hp = num(player?.currentHitpoints ?? details.currentHitpoints ?? player?.cHP);
        if (atk !== null) obs.atk[index] = atk;
        if (dmg !== null) obs.dmg[index] = dmg;
        if (hp !== null) obs.hp[index] = hp;
    }
    for (const [index, monster] of Object.entries(payload?.monsters || {})) {
        const details = monster?.combatDetails || {};
        const dmg = num(details.dmgCounter ?? monster?.dmgCounter);
        const hp = num(monster?.currentHitpoints ?? details.currentHitpoints ?? monster?.cHP);
        obs.mDmg[index] = dmg ?? 0;
        if (hp !== null) obs.mHP[index] = hp;
    }
}

/**
 * What one tick provably contains, before any attribution opinion.
 *
 * @param {Object} tick - A `battle_updated` payload
 * @param {Object} obs - From {@link newObserver}, mutated
 * @returns {{swungNow: Array<string>, gotHit: Array<string>, hitLanded: boolean,
 *   monsterHpLost: number, present: Array<string>}}
 */
function observeTick(tick, obs) {
    obs.tickIndex += 1;
    const pMap = tick?.pMap || {};
    const mMap = tick?.mMap || {};
    const swungNow = [];
    const gotHit = [];

    for (const [index, player] of Object.entries(pMap)) {
        const atk = num(player?.atkCounter);
        if (atk !== null) {
            if (obs.atk[index] !== undefined && atk > obs.atk[index]) {
                swungNow.push(index);
                obs.lastSwingTick[index] = obs.tickIndex;
            }
            obs.atk[index] = atk;
        }
        const dmg = num(player?.dmgCounter);
        const hp = num(player?.cHP ?? player?.currentHitpoints);
        const wasHit =
            (dmg !== null && obs.dmg[index] !== undefined && dmg > obs.dmg[index]) ||
            (hp !== null && obs.hp[index] !== undefined && hp < obs.hp[index]);
        if (wasHit) gotHit.push(index);
        if (dmg !== null) obs.dmg[index] = dmg;
        if (hp !== null) obs.hp[index] = hp;
    }

    let hitLanded = false;
    let monsterHpLost = 0;
    for (const [index, monster] of Object.entries(mMap)) {
        const dmg = num(monster?.dmgCounter);
        if (dmg !== null) {
            if (obs.mDmg[index] !== undefined && dmg > obs.mDmg[index]) hitLanded = true;
            obs.mDmg[index] = dmg;
        }
        const hp = num(monster?.cHP ?? monster?.currentHitpoints);
        if (hp !== null) {
            if (obs.mHP[index] !== undefined && obs.mHP[index] > hp) monsterHpLost += obs.mHP[index] - hp;
            obs.mHP[index] = hp;
        }
    }

    return { swungNow, gotHit, hitLanded, monsterHpLost, present: Object.keys(pMap) };
}

/**
 * Whether a player's last provable swing is close enough to explain a hit now.
 *
 * @param {Object} obs - The referee state
 * @param {string} index - A player index
 * @returns {boolean}
 */
function swungRecently(obs, index) {
    const at = obs.lastSwingTick[index];
    return at !== undefined && obs.tickIndex - at <= RECENT_SWING_TICKS;
}

/** One empty counting bucket */
function bucket() {
    return { ticks: 0, damage: 0 };
}

/** @param {Object} into - Mutated @param {number} damage - This tick's monster health lost */
function count(into, damage) {
    into.ticks += 1;
    into.damage += damage;
}

/**
 * Replay a recording through both engines and referee every disagreement.
 *
 * @param {Array<Object>} ticks - A combat recording's ticks, in order — each
 *   `{type, payload}` with `type` of `new_battle` or `battle_updated`
 * @param {Object} [options] - `{maxSamples}`
 * @returns {Object} The report — see the module note for how to read it
 */
export function compareRecording(ticks, { maxSamples = MAX_SAMPLES } = {}) {
    const ours = newAttributionState();
    const presence = newPresenceState();
    const obs = newObserver();
    const names = {};

    const players = {};
    const classes = {};
    const adjudication = {
        presenceConfirmed: bucket(),
        presenceVictim: bucket(),
        oursConfirmed: bucket(),
        bleed: bucket(),
        unresolved: bucket(),
    };
    const grouping = { hitTicks: 0, swungNow: 0, recentSwing: 0, victimOnly: 0, presentNoSignal: 0, nobodyPresent: 0 };
    const samples = [];

    let sawBattle = false;
    let tickCount = 0;
    let battles = 0;
    let damageTicks = 0;
    let missOnlyTicks = 0;
    let monsterHpLost = 0;
    let partySize = 0;

    const playerRow = (index) =>
        (players[index] = players[index] || { name: names[index] || null, ours: 0, presence: 0 });

    for (const tick of ticks || []) {
        if (tick?.type === 'new_battle') {
            const payload = tick.payload || {};
            battles += 1;
            sawBattle = true;
            partySize = Math.max(partySize, Object.keys(payload.players || {}).length);
            for (const [index, player] of Object.entries(payload.players || {})) {
                const name = player?.name || player?.character?.name;
                if (name) names[index] = name;
            }

            // All three sides re-baseline on the wave's own opening statement,
            // so none of them scores the first hit differently to the others
            noteActions(ours, payload.players);
            ours.monstersHP = {};
            ours.dmgCounter = {};
            ours.critCounter = {};
            for (const [index, monster] of Object.entries(payload.monsters || {})) {
                const details = monster?.combatDetails || {};
                const hp = num(details.currentHitpoints ?? monster?.currentHitpoints ?? details.maxHitpoints);
                if (hp === null) continue;
                ours.monstersHP[index] = hp;
                ours.dmgCounter[index] = num(details.dmgCounter ?? monster?.dmgCounter) ?? 0;
                ours.critCounter[index] = num(details.critCounter ?? monster?.critCounter) ?? 0;
            }
            presenceNewBattle(presence, payload);
            observeNewBattle(obs, payload);
            continue;
        }
        if (tick?.type !== 'battle_updated' || !sawBattle) continue;

        const payload = tick.payload || {};
        tickCount += 1;

        const seen = observeTick(payload, obs);
        const ourEvents = attributeTick(payload, ours);
        noteActions(ours, payload.pMap);
        const pres = presenceTick(payload, presence);

        const oursCredited = {};
        for (const event of ourEvents) {
            if (event.isKill || event.isMiss || event.isHeal) continue;
            oursCredited[event.playerIndex] = (oursCredited[event.playerIndex] || 0) + event.amount;
        }
        for (const [index, amount] of Object.entries(oursCredited)) playerRow(index).ours += amount;
        for (const [index, amount] of Object.entries(pres.credited)) playerRow(index).presence += amount;

        monsterHpLost += seen.monsterHpLost;
        if (!(seen.monsterHpLost > 0)) {
            if (ourEvents.some((event) => event.isMiss)) missOnlyTicks += 1;
            continue;
        }
        damageTicks += 1;

        // The presence method's foundational claim, tested on every landed hit:
        // was somebody who provably swung actually in this tick's pMap?
        if (seen.hitLanded) {
            grouping.hitTicks += 1;
            if (!seen.present.length) grouping.nobodyPresent += 1;
            else if (seen.swungNow.length) grouping.swungNow += 1;
            else if (seen.present.some((index) => swungRecently(obs, index))) grouping.recentSwing += 1;
            else if (seen.gotHit.length) grouping.victimOnly += 1;
            else grouping.presentNoSignal += 1;
        }

        const ourKeys = Object.keys(oursCredited);
        const presKeys = Object.keys(pres.credited);
        const sameSole = ourKeys.length === 1 && presKeys.length === 1 && ourKeys[0] === presKeys[0];

        let kind;
        if (!seen.hitLanded) kind = 'bleed';
        else if (sameSole) kind = 'agree';
        else if (ourKeys.length === 1 && presKeys.length > 1) kind = 'split-vs-single';
        else if (ourKeys.length === 1 && presKeys.length === 1) kind = 'single-conflict';
        else if (!ourKeys.length && presKeys.length) kind = 'ours-orphan';
        else if (ourKeys.length && !presKeys.length) kind = 'presence-orphan';
        else kind = 'both-orphan';
        count((classes[kind] = classes[kind] || bucket()), seen.monsterHpLost);
        if (kind === 'agree') continue;

        // The referee's verdict, from signals neither engine's answer used
        let verdict = 'unresolved';
        if (kind === 'bleed') {
            verdict = 'bleed';
        } else if ((kind === 'single-conflict' || kind === 'ours-orphan') && presKeys.length === 1) {
            const credited = presKeys[0];
            if (seen.swungNow.includes(credited) || swungRecently(obs, credited)) verdict = 'presenceConfirmed';
            else if (seen.gotHit.includes(credited)) verdict = 'presenceVictim';
        } else if (kind === 'split-vs-single' || kind === 'presence-orphan') {
            const credited = ourKeys[0];
            if (seen.swungNow.includes(credited) || swungRecently(obs, credited)) verdict = 'oursConfirmed';
        }
        count(adjudication[verdict], seen.monsterHpLost);

        if (samples.length < maxSamples) {
            samples.push({
                tick: obs.tickIndex,
                kind,
                verdict,
                damage: seen.monsterHpLost,
                ours: oursCredited,
                presence: pres.credited,
                swungNow: seen.swungNow,
                gotHit: seen.gotHit,
            });
        }
    }

    for (const [index, row] of Object.entries(players)) row.name = names[index] || row.name;

    const oursTotal = Object.values(players).reduce((total, row) => total + row.ours, 0);
    const presenceTotal = Object.values(players).reduce((total, row) => total + row.presence, 0);

    return {
        ticks: tickCount,
        battles,
        partySize,
        damageTicks,
        missOnlyTicks,
        monsterHpLost,
        totals: {
            ours: oursTotal,
            presence: presenceTotal,
            oursUncredited: monsterHpLost - oursTotal,
            presenceUncredited: monsterHpLost - presenceTotal,
        },
        players,
        classes,
        adjudication,
        grouping,
        samples,
    };
}
