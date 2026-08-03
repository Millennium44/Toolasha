/**
 * Damage tracker
 *
 * Per-player, per-ability damage, derived from a payload that attributes nothing.
 *
 * `combat-dps.js` already answers "how much damage is this party doing" by
 * diffing total health. That is enough for a tile and not enough for anything
 * else: it cannot say who is doing it, with what, how often they miss, or how
 * often they crit. Those are the questions a DPS panel exists to answer, and
 * none of them survives summing a side.
 *
 * ## How attribution works
 *
 * There is no attribution field. The caster is whoever's mana fell this tick,
 * and a hit is a monster's `dmgCounter` rising rather than its health falling —
 * the arithmetic is in `utils/damage-attribution.js` with tests, including the
 * cases that make it worth having: a bleed is not a hit, a miss is a hit for
 * nothing, and a monster seen for the first time has not been hit at all.
 *
 * ## Why it is separate from combat-dps
 *
 * They measure different things and would disagree. `combat-dps` counts every
 * point of health a side lost, including bleeds nobody cast and damage while the
 * counters were not yet known; this counts only attributable hits. The tile's
 * total is the honest one for "output"; this one is honest for "who and what".
 * Merging them would force one of those to be wrong.
 *
 * The model is DPs', from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import {
    newAttributionState,
    noteActions,
    attributeTick,
    foldEvents,
    foldEnemies,
} from '../../utils/damage-attribution.js';
import { recoverMonsterNames } from '../../utils/battle-panel-monsters.js';

/** The counters this tick is measured against */
let state = newAttributionState();

/** Player index → damage, hits, crits, misses, and the same by ability */
let tally = {};

/** Player index → display name, from `new_battle` */
let names = {};

/** Monster name → damage, hits, crits, misses and kills */
let enemyTally = {};

/**
 * Monster index → `{name, maxHP}`, from `new_battle`.
 *
 * Rebuilt every battle, because an index is a slot in this fight rather than an
 * identity — slot 0 is a rat now and a wolf in ninety seconds, and a stale map
 * credits one monster's damage to the other.
 */
let monsters = {};

/** Monster name → its full health bar, which is what a kill is worth */
let monsterHealth = {};

/** Whether this session has seen a battle begin; see the taken tracker for why */
let announced = false;

let startedAt = 0;
let lastTickAt = 0;
let seconds = 0;
let battleId = null;

/**
 * Whether damage credited while no ability was preparing is dropped.
 *
 * On by default, as MCS has it: a hit that lands while the player is idle is
 * usually a lingering effect rather than an attack, and counting it inflates
 * whatever happens to be next in the rotation.
 */
let filterNonDamaging = true;

/** Below this the averages are one fight's luck rather than a measurement */
const MIN_SECONDS = 5;

/** A tick further from the last than this is a new session, not a long swing */
const MAX_TICK_GAP_MS = 2000;

/** @returns {boolean} */
export function isFilteringNonDamaging() {
    return filterNonDamaging;
}

/**
 * @param {boolean} value - Whether to drop damage credited while idle
 */
export function setFilterNonDamaging(value) {
    filterNonDamaging = Boolean(value);
}

/** Forget the run and measure again from here */
export function resetDamageTracker() {
    state = newAttributionState();
    tally = {};
    enemyTally = {};
    seconds = 0;
    lastTickAt = 0;
    startedAt = Date.now();
}

/**
 * What each player has done this run.
 *
 * @returns {{seconds: number, players: Array<Object>}} Players biggest first,
 *   each with `damage`, `dps`, `hits`, `crits`, `misses`, `accuracy`, `critRate`
 *   and an `abilities` list. `dps` is null until there is enough of a run to
 *   divide by.
 */
export function damageBreakdown() {
    const measurable = seconds >= MIN_SECONDS;

    const players = Object.entries(tally).map(([index, entry]) => {
        const swings = entry.hits + entry.misses;
        return {
            index,
            name: names[index] || `Player ${Number(index) + 1}`,
            damage: entry.damage,
            hits: entry.hits,
            crits: entry.crits,
            misses: entry.misses,
            // Null rather than zero: no swings is not a 0% hit rate, it is
            // nothing to compute one from
            accuracy: swings > 0 ? entry.hits / swings : null,
            critRate: entry.hits > 0 ? entry.crits / entry.hits : null,
            dps: measurable ? entry.damage / seconds : null,
            abilities: Object.entries(entry.byAbility)
                .map(([action, stats]) => ({ action, ...stats }))
                .sort((a, b) => b.damage - a.damage),
            enemies: Object.entries(entry.byEnemy || {})
                .map(([name, stats]) => ({
                    name,
                    ...stats,
                    dps: measurable ? stats.damage / seconds : null,
                    abilities: Object.entries(stats.byAbility || {})
                        .map(([action, ability]) => ({ action, ...ability }))
                        .sort((a, b) => b.damage - a.damage),
                }))
                .sort((a, b) => b.damage - a.damage),
        };
    });

    const enemies = Object.entries(enemyTally).map(([name, entry]) => {
        const swings = entry.hits + entry.misses;
        return {
            name,
            damage: entry.damage,
            hits: entry.hits,
            crits: entry.crits,
            misses: entry.misses,
            kills: entry.kills,
            // What a kill is worth: the health bar it took to empty. Null when
            // the monster has never been seen alive this session, because a
            // guess here would be a claim about how hard the fight was.
            maxHP: monsterHealth[name] ?? null,
            accuracy: swings > 0 ? entry.hits / swings : null,
            critRate: entry.hits > 0 ? entry.crits / entry.hits : null,
            dps: measurable ? entry.damage / seconds : null,
            abilities: Object.entries(entry.byAbility || {})
                .map(([action, stats]) => ({ action, ...stats }))
                .sort((a, b) => b.damage - a.damage),
        };
    });

    // Wall clock against time actually swinging. The gap between them is what
    // walking between fights costs, which is the figure DPs leads its enemy
    // card with — a rotation cannot fix it and a zone change can.
    const logging = startedAt ? (Date.now() - startedAt) / 1000 : 0;

    return {
        seconds,
        startedAt,
        logging,
        players: players.sort((a, b) => b.damage - a.damage),
        enemies: enemies.sort((a, b) => b.damage - a.damage),
    };
}

/**
 * A monster's readable name.
 *
 * The payload carries an hrid and sometimes a name; the hrid is the reliable
 * one, so it is what the fallback derives from.
 *
 * @param {Object} monster - From `new_battle`
 * @returns {string|null}
 */
function monsterName(monster) {
    // `name` first, because that is what the payload actually carries — a
    // recorded battle has `name` and `hrid` and neither of the two hrid
    // spellings this used to look for
    if (monster?.name) return monster.name;

    const hrid = monster?.combatMonsterHrid || monster?.monsterHrid || monster?.hrid;
    if (!hrid) return null;

    const detail = dataManager.getInitClientData?.()?.combatMonsterDetailMap?.[hrid];
    return detail?.name || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * @param {string} action - `auto`, `idle`, or an ability hrid
 * @returns {string} Something readable
 */
export function actionLabel(action) {
    if (action === 'auto') return 'Auto attack';
    if (action === 'idle') return 'No ability';

    const detail = dataManager.getInitClientData?.()?.abilityDetailMap?.[action];
    if (detail?.name) return detail.name;

    return String(action).split('/').pop().replace(/_/g, ' ');
}

let onNewBattle = null;
let onBattleUpdated = null;

export default {
    name: 'Damage Tracker',
    initialize: () => {
        resetDamageTracker();

        onNewBattle = (data) => {
            try {
                announced = true;
                const players = data?.players || {};
                noteActions(state, players);
                for (const [index, player] of Object.entries(players)) {
                    names[index] = player?.name || player?.character?.name || names[index];
                }

                // Rebuilt rather than merged: an index is a slot in this fight,
                // and last fight's slot 0 was a different monster
                monsters = {};
                for (const [index, monster] of Object.entries(data?.monsters || {})) {
                    const name = monsterName(monster);
                    if (!name) continue;

                    const maxHP = Number(monster?.combatDetails?.maxHitpoints ?? monster?.maxHitpoints);
                    monsters[index] = { name };
                    // The largest seen, since a weakened spawn would understate
                    // what killing one is worth
                    if (Number.isFinite(maxHP) && maxHP > (monsterHealth[name] || 0)) monsterHealth[name] = maxHP;
                }
            } catch (error) {
                console.error('[DamageTracker] Reading a new battle failed:', error);
            }
        };

        onBattleUpdated = (data) => {
            try {
                const now = Date.now();

                // A new battle is a new set of units, so the counters belong to
                // somebody else and comparing against them invents huge hits
                if (data?.battleId !== battleId) {
                    battleId = data?.battleId;
                    state.monstersHP = {};
                    state.dmgCounter = {};
                    state.critCounter = {};
                }

                // A reload mid-fight never saw this battle's `new_battle`, so
                // nothing here knows what it is fighting — and an unnamed enemy
                // is dropped from the enemy tally rather than shown, which makes
                // the kill counts quietly short. The game is drawing the names.
                // Every tick until a battle is announced, not just while the map
                // is empty: `mMap` is a delta, so a wave arrives one monster at a
                // time and stopping early names the first and no other
                if (!announced) {
                    for (const [index, found] of Object.entries(recoverMonsterNames(data?.mMap))) {
                        if (monsters[index]) continue;
                        monsters[index] = { name: found.name };
                        // What a kill is worth, which without this would have no
                        // figure at all for a monster first met after a reload
                        if (found.max > (monsterHealth[found.name] || 0)) monsterHealth[found.name] = found.max;
                    }
                }

                const events = attributeTick(data, state);
                const nameOf = (index) => monsters[index]?.name || null;
                foldEvents(tally, events, { filterNonDamaging, nameOf });
                foldEnemies(enemyTally, events, nameOf);

                // After attributing, never before: the hit on this tick was cast
                // by what was prepared before it, and by the time the payload
                // arrives the player has started the next thing. Reading this
                // only once at `new_battle` froze the label at whatever was
                // being prepared when the fight began, which credited the whole
                // fight to one ability — and to the wrong one.
                noteActions(state, data?.pMap);

                // Only the gap between two ticks of one run is time spent
                // fighting; the first tick after a break contributes none
                const gap = now - lastTickAt;
                if (lastTickAt && gap > 0 && gap < MAX_TICK_GAP_MS) seconds += gap / 1000;
                lastTickAt = now;
            } catch (error) {
                console.error('[DamageTracker] Reading a combat tick failed:', error);
            }
        };

        webSocketHook.on('new_battle', onNewBattle);
        webSocketHook.on('battle_updated', onBattleUpdated);
    },
    cleanup: () => {
        if (onNewBattle) webSocketHook.off('new_battle', onNewBattle);
        if (onBattleUpdated) webSocketHook.off('battle_updated', onBattleUpdated);
        onNewBattle = null;
        onBattleUpdated = null;
        names = {};
        monsters = {};
        monsterHealth = {};
        announced = false;
        resetDamageTracker();
    },
};
