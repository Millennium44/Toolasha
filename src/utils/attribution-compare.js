/**
 * Attribution comparison
 *
 * Two answers to "who dealt this damage", run over the same recording, with a
 * referee that says which one the payload itself supports.
 *
 * ## The two engines
 *
 * **Ours** (`damage-attribution.js`): a hit is a monster's `dmgCounter` rising,
 * and the attacker is named by the counters first — the player whose
 * `atkCounter` rose — then by presence (a lone player in the tick owns its
 * action: their reflect, their DoT), then the unique mana-spender, then the
 * last player to swing. It credits bleed ticks (health falling with no counter)
 * to the same actor its rungs name, as a labelled class of their own, and
 * splits a multi-player tick nothing can separate rather than awarding it. Both
 * of those and the presence rung above were adopted *from* the methods under
 * comparison, after the referee below proved them right on every
 * counter-decidable tick.
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
 *   arbitrate it, so it is tallied apart rather than scored for either side —
 *   both engines now credit it, so the class measures its volume rather than a
 *   disagreement.
 *
 * The same signals also test the presence method's foundational claim directly:
 * over every tick where a hit landed on a monster, how often was a player who
 * had provably swung actually present in `pMap`? Every miss of that is a
 * protocol-grouping violation — a tick whose actor was *not* the one shipped.
 *
 * ## Trial mode
 *
 * `{mode: 'trial'}` replays a guild trial's `new_guild_battle`/
 * `guild_battle_updated` stream instead of a personal fight's `new_battle`/
 * `battle_updated` one — the same payload shape (`pMap`/`mMap`), a different
 * pair of message names, and the options `guild-trial-damage.js` runs the live
 * measurement with: `soloFallback: false` (no roster states a party of one on
 * a spectated trial), `unattributed: true` (health nobody could be credited
 * with is counted rather than silently dropped), and a reflect rung fed by the
 * same 33 s remembered-cast window, built from the two facts worth sharing
 * ({@link import('../features/guild/guild-trial-damage.js').REFLECT_ABILITIES}
 * and `REFLECT_WINDOW_MS`) rather than a live instance's own tracking.
 *
 * Names come from {@link import('../features/guild/guild-trial-units.js').rosterFromBattle}
 * on every `new_guild_battle`, and — when the trace also carries
 * `guild_trial_stats_updated` — a per-player total from the game itself, so
 * `compareRecording`'s report includes the one number a personal recording
 * never has: how far our own measurement actually landed from what the trial
 * credited.
 *
 * **The reflect-tank caveat.** {@link presenceVictim} flags a credited player
 * who was only being hit as suspect — the aggro-tank read. For a player with
 * Spike Shell or Retribution up, being hit is exactly what triggers *their
 * own* damage: thorns fire off the wearer being struck, so presence crediting
 * them is right, not suspect. In trial mode such a tick is filed as
 * `reflectTank` instead, and is excluded from suspicion.
 */

import {
    encounterOfMonster,
    foldTallyRow,
    REFLECT_ABILITIES,
    REFLECT_WINDOW_MS,
} from '../features/guild/guild-trial-damage.js';
import { rosterFromBattle } from '../features/guild/guild-trial-units.js';
import { trialFromHrid } from '../features/guild/guild-trials-math.js';
import { newAttributionState, noteActions, attributeTick } from './damage-attribution.js';

/**
 * Which message names carry a battle's opening statement and its per-tick
 * payload, by replay mode. Both pairs deliver the same `pMap`/`mMap` shape.
 */
const MESSAGE_TYPES = {
    personal: { open: 'new_battle', tick: 'battle_updated' },
    trial: { open: 'new_guild_battle', tick: 'guild_battle_updated' },
};

/** Assumed spacing between ticks that carry no timestamp of their own, for the reflect window */
const SYNTHETIC_TICK_MS = 100;

/**
 * A slot's remembered reflect casts, tracked the same way
 * `guild-trial-damage.js`'s `_noteReflectCasts`/`_reflectingAt` do — not
 * imported from there directly, since the tracking itself is a couple of
 * lines tied to a live instance's own `reflectCasts` map, tightly coupled to
 * the class it lives on. {@link REFLECT_ABILITIES} and {@link REFLECT_WINDOW_MS}
 * are the two facts actually worth sharing, and are imported rather than
 * retyped.
 *
 * @returns {{note: function(Object, number): void, at: function(string, number): (string|null)}}
 */
function newReflectTracker() {
    const casts = {};
    return {
        /** @param {Object} pMap - This tick's players @param {number} now - Replay clock */
        note(pMap, now) {
            for (const [index, unit] of Object.entries(pMap || {})) {
                const hrid = unit?.abilityHrid;
                if (REFLECT_ABILITIES.has(hrid)) casts[index] = { hrid, at: now };
            }
        },
        /** @param {string} index - Player slot @param {number} now - Replay clock @returns {string|null} */
        at(index, now) {
            const cast = casts[index];
            return cast && now - cast.at <= REFLECT_WINDOW_MS ? cast.hrid : null;
        },
    };
}

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
 * Fold a finished wave's index-keyed rows into the trial-long name-keyed
 * bank, the way `guild-trial-damage.js`'s own `_bankCurrentWave` does — a slot
 * index is only meaningful within the wave that dealt it, and `new_guild_battle`
 * re-deals every slot at each tier in an order the game does not promise to
 * keep. A tally that stayed index-keyed across tiers was seen swapping
 * per-name totals at a rollover — one member's damage moving to whoever
 * inherited their slot — which is exactly the failure a trial-long comparison
 * cannot afford to reproduce.
 *
 * @param {Object} bankedByName - Mutated: name → `{ours, presence}`
 * @param {Object} players - The finishing wave's index-keyed rows
 * @param {Object} names - Index → display name, for this same wave
 */
function bankWave(bankedByName, players, names) {
    for (const [index, row] of Object.entries(players)) {
        const name = names[index] || `Player ${Number(index) + 1}`;
        bankedByName[name] = foldTallyRow(bankedByName[name], { ours: row.ours, presence: row.presence });
    }
}

/**
 * A trial's per-player error against the game's own end-of-trial totals.
 *
 * @param {Object} players - `report.players` in trial mode, name → `{name, ours, presence}`
 * @param {Object} reported - Name → `{damage, healing, taken}`, from `guild_trial_stats_updated`
 * @returns {Object} Name → `{reportedDamage, measuredOurs, measuredPresence, absErrorOurs,
 *   absErrorPresence, relErrorOurs, relErrorPresence}`; the two `rel*` fields are null when the
 *   game itself reported no damage for that name — a relative error against zero says nothing
 */
function playerErrors(players, reported) {
    const errors = {};
    for (const row of Object.values(players)) {
        const name = row.name;
        if (!name || !(name in reported)) continue;
        const reportedDamage = Number(reported[name]?.damage) || 0;
        const absErrorOurs = Math.abs(row.ours - reportedDamage);
        const absErrorPresence = Math.abs(row.presence - reportedDamage);
        errors[name] = {
            reportedDamage,
            measuredOurs: row.ours,
            measuredPresence: row.presence,
            absErrorOurs,
            absErrorPresence,
            relErrorOurs: reportedDamage > 0 ? absErrorOurs / reportedDamage : null,
            relErrorPresence: reportedDamage > 0 ? absErrorPresence / reportedDamage : null,
        };
    }
    return errors;
}

/** @param {Array<number>} values @returns {number|null} */
function mean(values) {
    return values.length ? values.reduce((total, value) => total + value, 0) / values.length : null;
}

/** @param {Array<number>} values @returns {number|null} */
function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The one comparison a personal recording never has: how far each engine's
 * measurement landed from what the trial itself credited.
 *
 * `reportedGroups` can hold more than one trial's rows — the message is
 * resent whenever the native Stats panel is opened, and it has been seen
 * carrying another trial's rows alongside this one's. `encounter`, read off
 * every `new_guild_battle`'s monsters the same way `guild-trial-damage.js`
 * identifies its own fight, picks which group is this replay's; with no
 * encounter identified and more than one group in hand, guessing would pin
 * the comparison to the wrong fight, so none is picked and the ambiguity is
 * reported rather than papered over.
 *
 * @param {Object} players - `report.players`
 * @param {Object<string, Object>} reportedGroups - Trial key → name → `{damage, healing, taken}`
 * @param {string|null} encounter - The trial key this replay's own monsters resolved to
 * @returns {Object|null} The trial-stats report, or null when nothing was reported at all
 */
function buildTrialStats(players, reportedGroups, encounter) {
    const keys = Object.keys(reportedGroups);
    if (!keys.length) return null;

    const ownKey = encounter && reportedGroups[encounter] ? encounter : keys.length === 1 ? keys[0] : null;
    const reported = ownKey ? reportedGroups[ownKey] : null;
    const errors = reported ? playerErrors(players, reported) : {};

    const relOurs = Object.values(errors)
        .map((row) => row.relErrorOurs)
        .filter((value) => value !== null);
    const relPresence = Object.values(errors)
        .map((row) => row.relErrorPresence)
        .filter((value) => value !== null);
    const sumAbsOurs = Object.values(errors).reduce((total, row) => total + row.absErrorOurs, 0);
    const sumAbsPresence = Object.values(errors).reduce((total, row) => total + row.absErrorPresence, 0);
    const sumReported = reported ? Object.values(reported).reduce((total, row) => total + (row.damage || 0), 0) : 0;

    return {
        encounter: ownKey,
        // More than one trial's rows landed in this replay and neither this
        // client's own fight nor a lone group said which is which
        ambiguous: !ownKey && keys.length > 1,
        otherEncounters: keys.filter((key) => key !== ownKey),
        reported,
        errors,
        // The headline figure: total absolute error over the total the game
        // itself reported — not an average of per-player percentages, which a
        // handful of tiny-damage players can swing wildly on their own
        meanAbsPercentOurs: sumReported > 0 ? (sumAbsOurs / sumReported) * 100 : null,
        meanAbsPercentPresence: sumReported > 0 ? (sumAbsPresence / sumReported) * 100 : null,
        // Per-player relative error, mean and median, for the fuller picture
        meanRelErrorOursPercent: mean(relOurs) === null ? null : mean(relOurs) * 100,
        medianRelErrorOursPercent: median(relOurs) === null ? null : median(relOurs) * 100,
        meanRelErrorPresencePercent: mean(relPresence) === null ? null : mean(relPresence) * 100,
        medianRelErrorPresencePercent: median(relPresence) === null ? null : median(relPresence) * 100,
    };
}

/**
 * Replay a recording through both engines and referee every disagreement.
 *
 * @param {Array<Object>} ticks - A recording's ticks, in order — each
 *   `{type, payload, at}`, `at` optional. In `personal` mode (the default)
 *   `type` is `new_battle` or `battle_updated`; in `trial` mode it is
 *   `new_guild_battle`, `guild_battle_updated`, or `guild_trial_stats_updated`
 *   — see the module note. `at`, when given, is a wall-clock ms timestamp; a
 *   tick without one is spaced {@link SYNTHETIC_TICK_MS} after the last, which
 *   only matters to the reflect rung's 33 s window
 * @param {Object} [options] - `{maxSamples, mode}`; `mode` is `'personal'` (default) or `'trial'`
 * @returns {Object} The report — see the module note for how to read it. Trial mode adds
 *   `trialStats` (see {@link buildTrialStats}), null when the recording carried no
 *   `guild_trial_stats_updated`
 */
export function compareRecording(ticks, { maxSamples = MAX_SAMPLES, mode = 'personal' } = {}) {
    const trial = mode === 'trial';
    const { open: OPEN_TYPE, tick: TICK_TYPE } = MESSAGE_TYPES[trial ? 'trial' : 'personal'];
    const ours = newAttributionState();
    const presence = newPresenceState();
    const obs = newObserver();
    const names = {};
    const namesByCharacterId = {};
    const reflectTracker = trial ? newReflectTracker() : null;
    let encounter = null;
    const reportedGroups = {};
    // Trial mode only: `players` below is a live wave's index-keyed rows, and
    // {@link bankWave} folds a finishing wave into this trial-long name-keyed
    // total before the next wave re-deals the same indices to different people
    const bankedByName = {};

    const players = {};
    const classes = {};
    const adjudication = {
        presenceConfirmed: bucket(),
        presenceVictim: bucket(),
        reflectTank: bucket(),
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
    let syntheticClock = 0;

    const playerRow = (index) =>
        (players[index] = players[index] || { name: names[index] || null, ours: 0, presence: 0 });

    for (const rawTick of ticks || []) {
        const clock = Number.isFinite(rawTick?.at) ? rawTick.at : (syntheticClock += SYNTHETIC_TICK_MS);

        if (trial && rawTick?.type === 'guild_trial_stats_updated') {
            const list = Array.isArray(rawTick.payload?.guildTrialStatList) ? rawTick.payload.guildTrialStatList : [];
            for (const entry of list) {
                const trialInfo = trialFromHrid(entry?.trialHrid);
                if (!trialInfo || trialInfo.kind !== 'combat') continue;
                const characterId = Number(entry?.characterId);
                const name = namesByCharacterId[characterId] || `Character ${characterId}`;
                const group = reportedGroups[trialInfo.key] || (reportedGroups[trialInfo.key] = {});
                const row = group[name] || (group[name] = { damage: 0, healing: 0, taken: 0 });
                row.damage += Number(entry?.damageDealt) || 0;
                row.healing += Number(entry?.healingDone) || 0;
                row.taken += Number(entry?.premitigatedDamageTaken) || 0;
            }
            continue;
        }

        if (rawTick?.type === OPEN_TYPE) {
            const payload = rawTick.payload || {};
            if (trial && battles > 0) {
                // A new wave: bank the one just ending by name before its
                // indices are re-dealt to whoever this wave's roster names
                bankWave(bankedByName, players, names);
                for (const index of Object.keys(players)) delete players[index];
                for (const index of Object.keys(names)) delete names[index];
                // Every per-slot baseline describes the *previous* occupant —
                // `guild-trial-damage.js`'s own `_resetWaveBaselines` clears
                // exactly these for the same reason. Without it, a slot's new
                // occupant inherits a stranger's last attack count and either a
                // real first swing goes unseen or a swing that never happened
                // is invented, purely from the counter having moved on someone
                // else's turn in an earlier wave
                ours.playersAtk = {};
                ours.playersMP = {};
                ours.playersHP = {};
                ours.actions = {};
                obs.atk = {};
                obs.dmg = {};
                obs.hp = {};
                obs.lastSwingTick = {};
            }
            battles += 1;
            sawBattle = true;
            partySize = Math.max(partySize, Object.keys(payload.players || {}).length);
            for (const [index, player] of Object.entries(payload.players || {})) {
                const name = player?.name || player?.character?.name;
                if (name) names[index] = name;
            }
            if (trial) {
                // The name-bearing view of the same roster, id included — a
                // fifty-player trial has been seen trimming a slot's name but
                // keeping its id, which is what `guild_trial_stats_updated`
                // reports by. A trimmed slot still gets a name when an earlier
                // wave already named this same id
                const roster = rosterFromBattle(payload, (characterId) => namesByCharacterId[characterId] || null);
                for (const [index, entry] of Object.entries(roster)) {
                    names[index] = entry.name;
                    if (entry.characterId) namesByCharacterId[entry.characterId] = entry.name;
                }
                const seenEncounter = (Array.isArray(payload.monsters) ? payload.monsters : [])
                    .map((monster) => encounterOfMonster(monster?.hrid || monster?.name || ''))
                    .find(Boolean);
                if (seenEncounter) encounter = seenEncounter;
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
        if (rawTick?.type !== TICK_TYPE || !sawBattle) continue;

        const payload = rawTick.payload || {};
        tickCount += 1;

        const seen = observeTick(payload, obs);
        const ourEvents = attributeTick(
            payload,
            ours,
            trial
                ? { soloFallback: false, unattributed: true, reflecting: (index) => reflectTracker.at(index, clock) }
                : undefined
        );
        noteActions(ours, payload.pMap);
        if (trial) reflectTracker.note(payload.pMap, clock);
        const pres = presenceTick(payload, presence);

        const oursCredited = {};
        for (const event of ourEvents) {
            if (event.isKill || event.isMiss || event.isHeal || event.isUnattributed) continue;
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
            // The reflect-tank case: presence crediting a hurt reflector is
            // right, not the aggro-tank suspicion `presenceVictim` names —
            // thorns fire off the wearer being struck, so being hit *is* how
            // this player's own damage happened
            else if (trial && reflectTracker.at(credited, clock)) verdict = 'reflectTank';
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

    let finalPlayers;
    if (trial) {
        // The last wave never saw a following `new_guild_battle` to bank it
        bankWave(bankedByName, players, names);
        finalPlayers = {};
        for (const [name, row] of Object.entries(bankedByName)) {
            finalPlayers[name] = { name, ours: row.ours || 0, presence: row.presence || 0 };
        }
    } else {
        for (const [index, row] of Object.entries(players)) row.name = names[index] || row.name;
        finalPlayers = players;
    }

    const oursTotal = Object.values(finalPlayers).reduce((total, row) => total + row.ours, 0);
    const presenceTotal = Object.values(finalPlayers).reduce((total, row) => total + row.presence, 0);

    return {
        mode: trial ? 'trial' : 'personal',
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
        players: finalPlayers,
        classes,
        adjudication,
        grouping,
        samples,
        trialStats: trial ? buildTrialStats(finalPlayers, reportedGroups, encounter) : null,
    };
}
