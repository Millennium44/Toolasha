/**
 * Damage taken tracker
 *
 * The incoming half of combat: what is hitting the party, for how much, and how
 * much of it is being healed back.
 *
 * `damage-tracker.js` answers what the party is putting out. That is the half
 * you tune a rotation against, and it says nothing about whether a zone is
 * survivable — which is the question that actually decides whether you can idle
 * somewhere overnight. Damage taken against regeneration is that question, and a
 * per-monster breakdown is what answers the follow-up: a wave whose average hit
 * is comfortable can still contain one monster that ends runs.
 *
 * The arithmetic — including why a hit is a counter rather than a health drop,
 * and why attributing incoming damage to a particular monster is a ladder of
 * guesses — is in `utils/damage-taken.js` with tests.
 *
 * ## Deaths are not counted here
 *
 * The panel reads deaths from `combat-stats-data-collector`, which takes them
 * from the server. This module can see a health bar cross zero and does, but two
 * sources for one number is two numbers that eventually disagree, and the
 * server's is the one that is right. What is derived here is what the server
 * does not report at all.
 *
 * The model is IHurt's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { newTakenState, attributeIncoming, foldTaken, foldTakenByEnemy, waveKey } from '../../utils/damage-taken.js';
import { recoverMonsterNames } from '../../utils/battle-panel-monsters.js';

/** The counters this tick is measured against */
let state = newTakenState();

/** Player index → damage, regen, hits, misses */
let tally = {};

/** Monster name → damage, hits, range, and the same per player */
let enemyTally = {};

/** Wave name → encounters, damage, range */
let waves = {};

/** Player index → display name, from `new_battle` */
let names = {};

/**
 * Monster index → name, from `new_battle`.
 *
 * Rebuilt every battle rather than merged, because an index is a slot in this
 * fight — slot 0 is an Eye now and an Eyes in ninety seconds, and a stale map
 * files one monster's hits under the other's name.
 */
let monsters = {};

/** The wave currently being fought, so its damage lands in the right bucket */
let currentWave = null;

/**
 * Whether this session has seen a battle begin.
 *
 * Until it has, the monster map is whatever could be read off the screen, and
 * it has to keep being read: `mMap` is a delta, so the monsters arrive one at a
 * time over several ticks rather than all at once.
 */
let announced = false;

let encounters = 0;
let startedAt = 0;
let lastTickAt = 0;
let seconds = 0;
let battleId = null;

/** Below this the per-second figures are one swing's luck rather than a rate */
const MIN_SECONDS = 5;

/** A tick further from the last than this is a new session, not a long swing */
const MAX_TICK_GAP_MS = 2000;

/** Forget the run and measure again from here */
export function resetDamageTaken() {
    state = newTakenState();
    tally = {};
    enemyTally = {};
    waves = {};
    encounters = 0;
    seconds = 0;
    lastTickAt = 0;
    startedAt = Date.now();
}

/**
 * A monster's readable name.
 *
 * @param {Object} monster - From `new_battle`
 * @returns {string|null}
 */
function monsterName(monster) {
    if (monster?.name) return monster.name;

    const hrid = monster?.combatMonsterHrid || monster?.monsterHrid || monster?.hrid;
    if (!hrid) return null;

    const detail = dataManager.getInitClientData?.()?.combatMonsterDetailMap?.[hrid];
    return detail?.name || String(hrid).split('/').pop().replace(/_/g, ' ');
}

/**
 * What the party has taken this run.
 *
 * @returns {{seconds: number, encounters: number, players: Array<Object>,
 *   enemies: Array<Object>, waves: Array<Object>}} Players in party order,
 *   enemies and waves worst first. Per-second figures are null until there is
 *   enough of a run to divide by.
 */
export function takenBreakdown() {
    const measurable = seconds >= MIN_SECONDS;

    const players = Object.entries(tally)
        .map(([index, entry]) => ({
            index,
            name: names[index] || `Player ${Number(index) + 1}`,
            damage: entry.damage,
            regen: entry.regen,
            hits: entry.hits,
            misses: entry.misses,
            dps: measurable ? entry.damage / seconds : null,
            hps: measurable ? entry.regen / seconds : null,
        }))
        .sort((a, b) => Number(a.index) - Number(b.index));

    const enemies = Object.entries(enemyTally)
        .map(([name, entry]) => ({
            name,
            damage: entry.damage,
            hits: entry.hits,
            min: entry.min,
            max: entry.max,
            players: Object.entries(entry.byPlayer)
                .map(([index, stats]) => ({ index, name: names[index] || `Player ${Number(index) + 1}`, ...stats }))
                .sort((a, b) => b.damage - a.damage),
        }))
        .sort((a, b) => b.damage - a.damage);

    // By average rather than by total: a wave met once for 800 is more dangerous
    // than one met forty times for 3,000, and the total says the opposite
    const waveList = Object.entries(waves)
        .map(([name, entry]) => ({
            name,
            encounters: entry.encounters,
            damage: entry.damage,
            average: entry.encounters > 0 ? entry.damage / entry.encounters : 0,
            min: entry.min,
            max: entry.max,
        }))
        .sort((a, b) => b.average - a.average);

    return { seconds, encounters, startedAt, players, enemies, waves: waveList };
}

/**
 * Fill the monster map from what the game is drawing.
 *
 * Called on every tick until a battle is announced, not just while the map is
 * empty. `mMap` is a delta: a wave of three arrives over several ticks, one
 * monster at a time. Stopping as soon as the map had anything in it named the
 * first monster to report and left the rest of the wave Unknown for the whole
 * fight — which on a recorded refresh was the difference between two monsters
 * and one.
 *
 * Once `new_battle` arrives the payload is authoritative and this stops being
 * consulted for the rest of the session.
 *
 * The wave keeps whatever name it was given, which after a reload is nothing —
 * a composition recovered halfway through is not the composition that was
 * fought, and filing part of a battle under a full wave's name would make the
 * per-encounter average wrong for that wave from then on.
 *
 * @param {Object} mMap - The tick's monsters
 */
function recoverNames(mMap) {
    for (const [index, found] of Object.entries(recoverMonsterNames(mMap))) {
        // Never overwrite: an earlier tick's reading was taken when that monster
        // was actually on screen, and a later health match could be a coincidence
        if (!monsters[index]) monsters[index] = found.name;
    }
}

let onNewBattle = null;
let onBattleUpdated = null;

export default {
    name: 'Damage Taken Tracker',
    initialize: () => {
        resetDamageTaken();

        onNewBattle = (data) => {
            try {
                announced = true;
                for (const [index, player] of Object.entries(data?.players || {})) {
                    names[index] = player?.name || player?.character?.name || names[index];
                    // So a party member who has not been touched yet still gets
                    // a card, rather than appearing the moment they are hit
                    tally[index] ||= { damage: 0, regen: 0, hits: 0, misses: 0, deaths: 0 };
                }

                monsters = {};
                for (const [index, monster] of Object.entries(data?.monsters || {})) {
                    const name = monsterName(monster);
                    if (name) monsters[index] = name;
                }

                currentWave = waveKey(data?.monsters, monsterName);
                if (currentWave) {
                    const wave = (waves[currentWave] ||= { encounters: 0, damage: 0, min: null, max: null });
                    wave.encounters += 1;
                    encounters += 1;
                }
            } catch (error) {
                console.error('[DamageTakenTracker] Reading a new battle failed:', error);
            }
        };

        onBattleUpdated = (data) => {
            try {
                const now = Date.now();

                // A new battle is a new set of units, so the counters belong to
                // somebody else and diffing against them invents huge hits
                if (data?.battleId !== battleId) {
                    battleId = data?.battleId;
                    state = newTakenState();
                }

                // A page reloaded mid-fight never saw this battle's `new_battle`,
                // so nothing here knows what it is fighting and the whole rest of
                // the battle would be filed under Unknown Enemy. The game is
                // drawing the names; they are matched back on health.
                if (!announced) recoverNames(data?.mMap);

                const events = attributeIncoming(data, state);
                foldTaken(tally, events);
                foldTakenByEnemy(enemyTally, events, (index) => monsters[index] || null);

                const wave = currentWave ? waves[currentWave] : null;
                if (wave) {
                    for (const event of events) {
                        if (event.isDeath || event.isRegen || event.isMiss) continue;
                        wave.damage += event.damage;
                        wave.min = wave.min === null ? event.damage : Math.min(wave.min, event.damage);
                        wave.max = wave.max === null ? event.damage : Math.max(wave.max, event.damage);
                    }
                }

                // Only the gap between two ticks of one run is time spent
                // fighting; the first tick after a break contributes none
                const gap = now - lastTickAt;
                if (lastTickAt && gap > 0 && gap < MAX_TICK_GAP_MS) seconds += gap / 1000;
                lastTickAt = now;
            } catch (error) {
                console.error('[DamageTakenTracker] Reading a combat tick failed:', error);
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
        currentWave = null;
        announced = false;
        resetDamageTaken();
    },
};
