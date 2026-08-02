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
import { newAttributionState, noteActions, attributeTick, foldEvents } from '../../utils/damage-attribution.js';

/** The counters this tick is measured against */
let state = newAttributionState();

/** Player index → damage, hits, crits, misses, and the same by ability */
let tally = {};

/** Player index → display name, from `new_battle` */
let names = {};

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
        };
    });

    return { seconds, startedAt, players: players.sort((a, b) => b.damage - a.damage) };
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
                const players = data?.players || {};
                noteActions(state, players);
                for (const [index, player] of Object.entries(players)) {
                    names[index] = player?.name || player?.character?.name || names[index];
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

                foldEvents(tally, attributeTick(data, state), { filterNonDamaging });

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
        resetDamageTracker();
    },
};
