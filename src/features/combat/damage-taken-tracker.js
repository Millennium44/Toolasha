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

/**
 * This fight only: monster slot → damage dealt to the party.
 *
 * The mirror of the damage tracker's per-battle enemy fold, and keyed by slot
 * for the same reason — an enemy tile is a slot, and two of the same monster
 * are two different threats. Only a hit the attribution ladder pinned to
 * exactly one slot lands here: a hit with two candidates would have to go on
 * both tiles or an arbitrary one, and either is a wrong number.
 */
let battleTaken = { enemies: {}, seconds: 0 };

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

/** Who is fighting and since when; a change is a new run — see `sessionKeyFor` */
let sessionKey = null;

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

/**
 * The same idea for a single fight, but far shorter — the same floor the
 * damage tracker uses for its per-battle rates, for the same reason: a fight
 * lasts seconds, and waiting five of them would leave most fights rateless.
 */
const MIN_BATTLE_SECONDS = 1;

/** A tick further from the last than this is a new session, not a long swing */
const MAX_TICK_GAP_MS = 2000;

/** Forget the run and measure again from here */
export function resetDamageTaken() {
    state = newTakenState();
    sessionKey = null;
    tally = {};
    enemyTally = {};
    waves = {};
    battleTaken = { enemies: {}, seconds: 0 };
    encounters = 0;
    seconds = 0;
    lastTickAt = 0;
    startedAt = Date.now();
}

/**
 * Which run this is: who is in it, and when it started.
 *
 * Mirrors `damage-tracker.js`'s function of the same name, and for the same
 * reason: `tally` and `enemyTally` are keyed by player slot and by name, and a
 * party that changes mid-session reuses those slots for somebody else. Without
 * this a member who left stayed in the taken-damage table forever, and worse,
 * a new member landing in their old slot inherited their damage-taken total —
 * the exact bug the outgoing tracker fixed here first.
 *
 * @param {Object} data - `new_battle` message
 * @returns {string|null} A key, or null when the message cannot say
 */
export function sessionKeyFor(data) {
    const players = Object.values(data?.players || {});
    if (!players.length) return null;

    const roster = players.map((player) => player?.name || player?.character?.name || '?').join(',');
    return `${roster}|${data?.combatStartTime || ''}`;
}

/**
 * What each enemy slot is doing to the party in the fight on screen.
 *
 * @returns {{seconds: number, enemies: Object}} Keyed by slot, each
 *   `{damage, dps}`. `dps` is null until there is enough of a fight to divide
 *   by. A slot the ladder could never pin a hit to is simply absent.
 */
export function battleTakenBreakdown() {
    const measurable = battleTaken.seconds >= MIN_BATTLE_SECONDS;

    const enemies = {};
    for (const [index, damage] of Object.entries(battleTaken.enemies)) {
        enemies[index] = { damage, dps: measurable ? damage / battleTaken.seconds : null };
    }

    return { seconds: battleTaken.seconds, enemies };
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
    for (const [index, name] of Object.entries(recoverMonsterNames(mMap))) {
        // Never overwrite: an earlier tick's reading was taken when that monster
        // was actually on screen, and a later health match could be a coincidence
        if (!monsters[index]) monsters[index] = name;
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
                const players = data?.players || {};

                // Leaving a party is a new session, and the run before it is not
                // this run — see `sessionKeyFor`. Adopted rather than reset on the
                // very first statement, exactly as the outgoing tracker does: a
                // reload lands ticks before anything names the run, and those
                // ticks belong to the fight still on screen.
                const key = sessionKeyFor(data);
                if (key && key !== sessionKey) {
                    const seenSlots = Object.keys(state.playersHP || {});
                    const adoptable = sessionKey === null && seenSlots.every((index) => index in players);
                    if (!adoptable) {
                        resetDamageTaken();
                        names = {};
                    }
                }
                sessionKey = key || sessionKey;

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

                // The fight on screen is a new one, and last fight's slots
                // were different monsters
                battleTaken = { enemies: {}, seconds: 0 };

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
                    // A reload mid-fight never saw this battle's `new_battle`,
                    // so this is the only boundary that clears the per-fight
                    // fold for it. After a normal battle start it clears a map
                    // that is already empty, which is harmless.
                    battleTaken = { enemies: {}, seconds: 0 };
                }

                // A page reloaded mid-fight never saw this battle's `new_battle`,
                // so nothing here knows what it is fighting and the whole rest of
                // the battle would be filed under Unknown Enemy. The game is
                // drawing the names; they are matched back on health.
                if (!announced) recoverNames(data?.mMap);

                const events = attributeIncoming(data, state);
                foldTaken(tally, events);
                foldTakenByEnemy(enemyTally, events, (index) => monsters[index] || null);

                // The same hits again, by slot and for this fight only —
                // what an enemy tile can carry. Only a hit with exactly one
                // candidate slot is filed; "either of the two Eyes" is a fine
                // answer for a name and no answer at all for a tile.
                for (const event of events) {
                    if (event.isDeath || event.isRegen || event.isMiss) continue;
                    if (!Array.isArray(event.monsters) || event.monsters.length !== 1) continue;

                    const slot = event.monsters[0];
                    battleTaken.enemies[slot] = (battleTaken.enemies[slot] || 0) + event.damage;
                }

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
                if (lastTickAt && gap > 0 && gap < MAX_TICK_GAP_MS) {
                    seconds += gap / 1000;
                    battleTaken.seconds += gap / 1000;
                }
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
