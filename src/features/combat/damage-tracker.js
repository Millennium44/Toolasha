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
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { pushManaSample } from './combat-estimates.js';
import { recoverMonsterNames } from '../../utils/battle-panel-monsters.js';
import { inferClass, newCastLog, noteCast } from '../../utils/class-inference.js';

/** The counters this tick is measured against */
let state = newAttributionState();

/** Player index → damage, hits, crits, misses, and the same by ability */
let tally = {};

/** Player index → display name, from `new_battle` */
let names = {};

/**
 * Player index → what they have been seen preparing this run, for the class
 * guess. The same evidence the trial scoreboard uses, gathered the same way:
 * a tick says what each slot is casting, and the modal style of that is the
 * role. Reset with the run, like the tally — a new party is new evidence.
 */
let castLogs = {};

/**
 * Player index → the kit and sheet `new_battle` stated for the slot: the
 * equipped abilities and the combat stats (weapon style, element, threat).
 * What answers before anyone has cast — an auto-attacker never will, and
 * their weapon still says what they are. Reset with the run.
 */
let sheets = {};

/** Who is fighting and since when; a change is a new run — see `sessionKeyFor` */
let sessionKey = null;

/** Monster name → damage, hits, crits, misses and kills */
let enemyTally = {};

/**
 * This fight only, cleared when the next one starts.
 *
 * The session tally answers "how has this run gone"; a portrait wants "how is
 * this fight going", and they diverge exactly when it matters — the fight you
 * are looking at is the one you can still do something about.
 *
 * Enemies are keyed by **slot** here rather than by name, unlike the session
 * tally. Two Veyes in one wave are two different fights against the same
 * monster, and a rate that averaged them would be on both tiles and true of
 * neither. A slot is stable for the length of a battle, which is exactly how
 * long this lives.
 */
let battle = { players: {}, enemies: {}, seconds: 0 };

/**
 * Monster index → `{name, enrageAt}`, from `new_battle`.
 *
 * Rebuilt every battle, because an index is a slot in this fight rather than an
 * identity — slot 0 is a rat now and a wolf in ninety seconds, and a stale map
 * credits one monster's damage to the other. `enrageAt` is when the monster
 * enrages (ms since epoch), from its sheet's `enrageTimerDuration` anchored at
 * `spawnTime`; null when the sheet carries neither.
 */
let monsters = {};

/**
 * Monster slot → its latest reported health, for time-to-kill.
 *
 * Seeded from `new_battle` — the one message that states every monster's
 * health at once — and then kept current from each tick's `mMap`, which is a
 * delta and only mentions the monsters the server touched. A slot never
 * reported is null, and stays null rather than being guessed at full.
 */
let battleHP = {};

/**
 * Whether `battleHP` was just seeded by a `new_battle` that the next tick's
 * battle-id change is about to announce. Without this flag the first tick of
 * every battle would wipe the seed it just received; without the *wipe*, a
 * reload that never saw `new_battle` would show last battle's health bars on
 * this battle's monsters.
 */
let battleSeeded = false;

/**
 * Player index → recent `{at, mana}` readings, for the mana runway.
 *
 * Kept across battles on purpose: a drain is only visible over a stretch
 * longer than one fight. Reset with the session, like the tally.
 */
let manaSeries = {};

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

/**
 * The same idea for a single fight, but far shorter.
 *
 * A fight lasts seconds, so waiting five of them to give a rate would mean most
 * fights never got one. One second is enough to divide by without the first hit
 * reading as an enormous rate.
 */
const MIN_BATTLE_SECONDS = 1;

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
    sessionKey = null;
    tally = {};
    castLogs = {};
    sheets = {};
    enemyTally = {};
    battle = { players: {}, enemies: {}, seconds: 0 };
    battleHP = {};
    manaSeries = {};
    seconds = 0;
    lastTickAt = 0;
    startedAt = Date.now();
}

/**
 * Each player's recent mana readings, for the runway estimate.
 *
 * @returns {Object} Player index → array of `{at, mana}`, oldest first
 */
export function manaSamples() {
    return manaSeries;
}

/**
 * What has happened in the fight on screen right now.
 *
 * Enemies cover every slot the battle has named or reported — not only the
 * ones already hit — so a tile can carry a health figure before the party has
 * touched its monster. `hp`, `maxHP` and `enrageAt` are null when the payload
 * never stated them.
 *
 * @returns {{seconds: number, players: Object, enemies: Object}} Keyed by slot;
 *   players are `{name, damage, dps}`, enemies add `hp`, `maxHP` and
 *   `enrageAt`. `dps` is null until there is enough of a fight to divide by —
 *   a different thing from zero, and it must not be drawn as one.
 */
export function battleBreakdown() {
    const measurable = battle.seconds >= MIN_BATTLE_SECONDS;
    const rate = (damage) => (measurable ? damage / battle.seconds : null);

    const players = {};
    for (const [index, damage] of Object.entries(battle.players)) {
        players[index] = { name: names[index] || null, damage, dps: rate(damage) };
    }

    const enemies = {};
    const slots = new Set([...Object.keys(battle.enemies), ...Object.keys(battleHP), ...Object.keys(monsters)]);
    for (const index of slots) {
        const damage = battle.enemies[index] || 0;
        const name = monsters[index]?.name || null;
        enemies[index] = {
            name,
            damage,
            dps: rate(damage),
            hp: battleHP[index] ?? null,
            maxHP: name ? (monsterHealth[name] ?? null) : null,
            enrageAt: monsters[index]?.enrageAt ?? null,
        };
    }

    return { seconds: battle.seconds, players, enemies };
}

/**
 * What each player has done this run.
 *
 * @returns {{seconds: number, players: Array<Object>}} Players biggest first,
 *   each with `damage`, `dotDamage`, `dps`, `hits`, `crits`, `misses`, `accuracy`, `critRate`
 *   and an `abilities` list. `dps` is null until there is enough of a run to
 *   divide by.
 */
/**
 * Record what each slot was preparing on one tick, as evidence for its class.
 * Auto-attacks and idling are not casts and `noteCast` drops them itself.
 * @param {Object} players - `pMap` from a tick, or `players` from `new_battle`
 */
function noteCasts(players) {
    for (const [index, player] of Object.entries(players || {})) {
        const ability = player?.preparingAbilityHrid || player?.abilityHrid;
        if (!ability) continue;
        noteCast((castLogs[index] ||= newCastLog()), ability);
    }
}

/**
 * The role each slot appears to be playing, from its casts this run.
 * @param {Object} [abilityDetailMap] - Game data; read from the client data by default
 * @returns {Object} Player index → verdict from `inferClass`, absent where nothing supports one
 */
export function runClasses(abilityDetailMap = dataManager.getInitClientData?.()?.abilityDetailMap || {}) {
    const out = {};
    for (const index of new Set([...Object.keys(sheets), ...Object.keys(castLogs)])) {
        const verdict = inferClass(
            { casts: castLogs[index] || null, kit: sheets[index]?.kit || null, stats: sheets[index]?.stats || null },
            abilityDetailMap
        );
        if (verdict) out[index] = verdict;
    }
    return out;
}

/**
 * Keep what `new_battle` states about each slot's build.
 * @param {Object} players - The `players` map from `new_battle`
 */
function noteSheets(players) {
    for (const [index, player] of Object.entries(players || {})) {
        const abilities = player?.combatDetails?.combatAbilities;
        const kit = Array.isArray(abilities)
            ? abilities.filter((entry) => entry?.abilityHrid).map((entry) => ({ hrid: entry.abilityHrid }))
            : null;
        const stats = player?.combatDetails?.combatStats || null;
        if (kit?.length || stats) sheets[index] = { kit, stats };
    }
}

export function damageBreakdown() {
    const measurable = seconds >= MIN_SECONDS;
    const classes = runClasses();

    const players = Object.entries(tally).map(([index, entry]) => {
        const swings = entry.hits + entry.misses;
        return {
            index,
            name: names[index] || `Player ${Number(index) + 1}`,
            // The class guess, from what this slot was seen casting this run
            // and the kit and weapon `new_battle` stated for it; null only
            // when nothing supports one
            classTag: classes[index] || null,
            damage: entry.damage,
            // The part of `damage` no swing counter confirmed — a bleed
            // ticking, thorns firing. Inside the total, named separately so a
            // breakdown can say "incl. X DoT/reflect"
            dotDamage: entry.dotDamage || 0,
            // Rounded here and nowhere earlier: a tick shared between the
            // players present carries a fractional swing, and the ledger keeps
            // the fraction so the sum stays exact
            hits: Math.round(entry.hits),
            crits: Math.round(entry.crits),
            misses: Math.round(entry.misses),
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
            dotDamage: entry.dotDamage || 0,
            hits: Math.round(entry.hits),
            crits: Math.round(entry.crits),
            misses: Math.round(entry.misses),
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
 * What a kill of each monster is worth, from the tick rather than the roster.
 *
 * Every monster a tick mentions carries `mHP`, its full health — on all 292
 * monster entries across two recorded runs, agreeing with `new_battle` every
 * time. Taking it here rather than only at the start of a battle means a monster
 * first met after a reload is priced like any other, without the battle panel
 * having to be read for it.
 *
 * @param {Object} mMap - The tick's monsters
 */
function noteMonsterHealth(mMap) {
    for (const [index, monster] of Object.entries(mMap || {})) {
        const name = monsters[index]?.name;
        const max = Number(monster?.mHP);

        // The largest seen, since a weakened spawn would understate the bar
        if (name && Number.isFinite(max) && max > (monsterHealth[name] || 0)) monsterHealth[name] = max;
    }
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

/**
 * Which run this is: who is in it, and when it started.
 *
 * Either half alone is not enough. The same party starting a new zone is a new
 * run, and the same zone with somebody gone is a different run measuring
 * different people — and a tally keyed by battle slot cannot survive the second
 * without handing one person's damage to whoever inherits their slot.
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
 * Borrow the party's names from the last run, so a reload does not draw the
 * party as "Player 1" through "Player 5".
 *
 * Damage arrives on `battle_updated`, which is constant, but names arrive on
 * `new_battle`, which in a dungeon is a wave apart — so after a refresh the DPS
 * table filled with real numbers against placeholder names until the next wave.
 *
 * The collector's snapshot is built from `new_battle`'s player list in order, so
 * its index is this index. It is a guess only in that the party could have
 * changed while the page was away, and the next `new_battle` overwrites it.
 */
function seedNames() {
    try {
        const players = combatStatsDataCollector.getLatestData()?.players || [];
        players.forEach((player, index) => {
            if (player?.name) names[index] = player.name;
        });
    } catch (error) {
        console.error('[DamageTracker] Borrowing names from the last run failed:', error);
    }
}

let onNewBattle = null;
let onBattleUpdated = null;

export default {
    name: 'Damage Tracker',
    initialize: () => {
        resetDamageTracker();
        seedNames();

        onNewBattle = (data) => {
            try {
                announced = true;
                const players = data?.players || {};

                // Leaving a party is a new session, and the run before it is not
                // this run. The tally is keyed by battle slot, so without this
                // the four people who left stayed in the DPS table forever — and
                // worse, your own name landed on two rows, because you were slot
                // 3 in the party and slot 0 alone. The roster and the start time
                // together are the session, which is how MCS names one too.
                const key = sessionKeyFor(data);
                if (key && key !== sessionKey) {
                    resetDamageTracker();
                    names = {};
                }
                sessionKey = key || sessionKey;

                noteActions(state, players);
                noteCasts(players);
                noteSheets(players);

                // Rebuilt rather than merged, for the same reason the monster map
                // below is: an index is a slot in this fight. Every battle names
                // every player, so nothing is lost by starting fresh.
                names = {};
                for (const [index, player] of Object.entries(players)) {
                    names[index] = player?.name || player?.character?.name || null;
                }

                // The fight on screen is a new one, so what was on the portraits
                // belongs to the last one
                battle = { players: {}, enemies: {}, seconds: 0 };
                battleHP = {};
                battleSeeded = true;

                // Rebuilt rather than merged: an index is a slot in this fight,
                // and last fight's slot 0 was a different monster
                monsters = {};
                for (const [index, monster] of Object.entries(data?.monsters || {})) {
                    const name = monsterName(monster);
                    if (!name) continue;

                    const maxHP = Number(monster?.combatDetails?.maxHitpoints ?? monster?.maxHitpoints);

                    // The enrage clock, where the sheet states one: a duration
                    // in nanoseconds anchored at the spawn. Either half missing
                    // means no countdown rather than a guessed one.
                    const enrageMs = Number(monster?.enrageTimerDuration) / 1e6 || null;
                    const spawnMs = Date.parse(monster?.spawnTime ?? '');
                    monsters[index] = {
                        name,
                        enrageAt: enrageMs && Number.isFinite(spawnMs) ? spawnMs + enrageMs : null,
                    };

                    // Stated current health, never assumed full — a weakened
                    // spawn is a real thing and inventing the difference would
                    // overstate the time to kill
                    const hp = Number(
                        monster?.currentHitpoints ?? monster?.combatDetails?.currentHitpoints ?? monster?.cHP
                    );
                    if (Number.isFinite(hp)) battleHP[index] = hp;

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
                    state.monstersMaxHP = {};
                    state.dmgCounter = {};
                    state.critCounter = {};

                    // The health map is per battle too, but `new_battle` has
                    // usually just rebuilt it for exactly this battle, and
                    // wiping that seed would blank every bar until its monster
                    // was next mentioned. Only a battle nothing announced — a
                    // reload mid-run — starts from nothing.
                    if (!battleSeeded) battleHP = {};
                    battleSeeded = false;
                }

                // A reload mid-fight never saw this battle's `new_battle`, so
                // nothing here knows what it is fighting — and an unnamed enemy
                // is dropped from the enemy tally rather than shown, which makes
                // the kill counts quietly short. The game is drawing the names.
                // Every tick until a battle is announced, not just while the map
                // is empty: `mMap` is a delta, so a wave arrives one monster at a
                // time and stopping early names the first and no other
                if (!announced) {
                    for (const [index, name] of Object.entries(recoverMonsterNames(data?.mMap))) {
                        if (!monsters[index]) monsters[index] = { name };
                    }
                }

                noteMonsterHealth(data?.mMap);

                // The latest health per slot, for time-to-kill. Read before
                // attribution so a killing blow shows the bar at zero rather
                // than where it was a tick ago.
                for (const [index, monster] of Object.entries(data?.mMap || {})) {
                    const hp = Number(monster?.currentHitpoints ?? monster?.cHP);
                    if (Number.isFinite(hp)) battleHP[index] = hp;
                }

                // Each player's mana reading, for the runway. The series keeps
                // its own window; nothing here decides what a drain is.
                for (const [index, player] of Object.entries(data?.pMap || {})) {
                    const mana = Number(player?.cMP);
                    if (Number.isFinite(mana)) pushManaSample((manaSeries[index] ||= []), now, mana);
                }

                const events = attributeTick(data, state);
                const nameOf = (index) => monsters[index]?.name || null;
                foldEvents(tally, events, { filterNonDamaging, nameOf });
                foldEnemies(enemyTally, events, nameOf);

                // The same events again, by slot and for this fight only. Folded
                // here rather than derived from the session tally because the
                // session tally has already lost the slot — it keys enemies by
                // name, which is the right choice for a run and the wrong one
                // for two identical monsters standing side by side.
                for (const event of events) {
                    if (event.isKill || event.isMiss || event.isHeal) continue;
                    const amount = event.amount || 0;
                    if (!amount) continue;

                    if (event.playerIndex !== null && event.playerIndex !== undefined) {
                        battle.players[event.playerIndex] = (battle.players[event.playerIndex] || 0) + amount;
                    }
                    if (event.monsterIndex !== null && event.monsterIndex !== undefined) {
                        battle.enemies[event.monsterIndex] = (battle.enemies[event.monsterIndex] || 0) + amount;
                    }
                }

                // After attributing, never before: the hit on this tick was cast
                // by what was prepared before it, and by the time the payload
                // arrives the player has started the next thing. Reading this
                // only once at `new_battle` froze the label at whatever was
                // being prepared when the fight began, which credited the whole
                // fight to one ability — and to the wrong one.
                noteActions(state, data?.pMap);
                noteCasts(data?.pMap);

                // Only the gap between two ticks of one run is time spent
                // fighting; the first tick after a break contributes none
                const gap = now - lastTickAt;
                if (lastTickAt && gap > 0 && gap < MAX_TICK_GAP_MS) {
                    seconds += gap / 1000;
                    battle.seconds += gap / 1000;
                }
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
        battleSeeded = false;
        announced = false;
        resetDamageTracker();
    },
};
