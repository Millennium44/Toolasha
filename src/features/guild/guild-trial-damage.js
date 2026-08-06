/**
 * Who is doing the damage in a guild combat trial.
 *
 * The trial card already says what the party is doing — "Party DPS 521 dmg/s,
 * kill in 17m" — measured off the boss bar on the In Progress tab. That figure
 * is the sum of five people and it cannot say which of them is carrying it,
 * which is the question a guild actually asks after a trial fails a tier.
 *
 * From the websocket's point of view a trial fight is an ordinary battle:
 * `new_battle` names the party and the boss, `battle_updated` ticks several
 * times a second, and neither carries a word about who struck. So this reuses
 * the attribution the combat features already run on
 * (`utils/damage-attribution.js` — the attack counter identifies the attacker, a
 * hit is `dmgCounter` rising, a bleed is not a hit) rather than inventing a
 * second answer that would disagree with the DPS panel.
 *
 * ## What counts, and how a trial fight is told from any other
 *
 * This is the whole risk of the feature. Attributing every battle would credit
 * an evening of Chimerical grinding to the trial and report a party DPS the
 * guild never produced, so the gate is deliberately narrow and it fails closed:
 *
 * 1. **A monster that says it is a trial.** Any monster name containing "trial"
 *    arms the tally on its own. Nothing else on the wire spells that word.
 * 2. **This week's encounter, by name.** The guild trials record knows the
 *    week's combat trial card ("Trial Chameleon"), and the five encounters are a
 *    closed list (`COMBAT_ENCOUNTERS`). A battle whose monster reduces to the
 *    same encounter as the card is that trial.
 *    Without a combat card on the record — no trial this week, or the panel has
 *    never been opened — rule 2 cannot fire at all, which is the conservative
 *    direction.
 * 3. **Nothing else.** A battle that matches neither is not attributed, and the
 *    breakdown says so rather than showing an empty table that reads as zero
 *    damage.
 *
 * Re-decided on every `new_battle`, because each tier of a trial is its own
 * fight and so is the zone the player returns to afterwards. A `battle_updated`
 * carrying a battle id this module never saw announced disarms the tally until
 * the next `new_battle` confirms what is being fought — a reload mid-trial
 * therefore measures nothing rather than measuring the wrong thing.
 *
 * This gate has never once armed, and it is not supposed to: a trial fight is
 * not on this client's own battle feed. That is why it is no longer the only
 * source.
 *
 * ## The spectator stream, which is the real one
 *
 * Opening the In Progress **fight view** subscribes the client to
 * `guild_battle_updated`, and it is a firehose: 127 messages in a minute of
 * watching, each one
 *
 * ```
 * {type, battleId, tier, pMap, mMap}
 * ```
 *
 * with `pMap`/`mMap` entries in exactly the shape a normal battle tick uses —
 * `cHP mHP cMP mMP isActive leftCombat atkCounter isAutoAtk abilityHrid int
 * dmgCounter critCounter`. `mMap["0"]` is the boss, its `cHP` is the pool bar to
 * the unit (454,807 of 618,000 in the capture, which is the T2 Chameleon pool
 * exactly), and `tier` states outright what the DOM badge had to be reasoned
 * about. So the fight *is* real and server-run, and spectating streams it.
 *
 * Everything below therefore runs twice over: the same `attributeTick`,
 * `foldEvents` and `foldSupportTick` this module already used, fed from a second
 * listener. Nothing about the arithmetic changes, because the payload shape does
 * not.
 *
 * ### What that costs, and what it does not
 *
 * - **Only after somebody watches.** Opening the fight view is what starts the
 *   stream — and, observed live, the stream then keeps flowing while other game
 *   tabs are browsed rather than stopping the moment the view closes. Every
 *   tick that arrives is counted: the measurement is the stream as received,
 *   gaps and all, and the recorder's session gaps model the gaps.
 * - **Units are indexes.** `pMap` is `{"1": …}` with no roster on it, so names
 *   come from `guild-trial-units.js` — the fight view's own portraits first, the
 *   captured builds' maximum health and mana second, and a placeholder when
 *   neither can say. A wrong name is worse than no name.
 * - **A per-player damage split needs the players' own counters.** Boss health
 *   falling is party damage and is unambiguous; splitting it needs `atkCounter`
 *   on the `pMap` entries, which the attribution module requires and refuses to
 *   guess without. Ticks that carried them are counted, so the panel can say
 *   which of the two it has rather than drawing an empty table.
 *
 * ### What is shown when nothing has been watched
 *
 * {@link estimateDamageSplit} — a per-player split derived from the members'
 * captured builds, labelled as an estimate. Measured beats estimated whenever
 * measured exists, and the panels name the source either way.
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { attributeTick, foldEvents, newAttributionState, noteActions } from '../../utils/damage-attribution.js';
import { guildLoadoutCapture } from './guild-loadout-capture.js';
import { isMonsterUnit } from './guild-loadouts.js';
import { autoAttackDps } from './guild-trial-forecast.js';
import {
    foldSupportRow,
    foldSupportTick,
    newSupportState,
    summariseSupport,
    supportCoverage,
} from './guild-trial-support.js';
import {
    fightViewBossNames,
    fightViewNames,
    fightViewPartyNames,
    nameCoverage,
    resolveUnitNames,
    rosterFromBattle,
} from './guild-trial-units.js';
import { COMBAT_ENCOUNTERS, TRIAL_ACTIVE_MS, tierFromLevel, trialFromHrid } from './guild-trials-math.js';
import { loadTrialRoster, saveTrialRoster } from './guild-trials-store.js';

/** Below this the per-player rates are one exchange's luck rather than a rate */
export const MIN_SECONDS = 5;

/**
 * Where a trial's figures come from, in one sentence.
 *
 * This used to say the fight did not exist — that trial combat was simulated and
 * no measurement was possible. A wire capture disproved it: the fight is a real
 * server-run battle and `guild_battle_updated` streams it to anyone who opens
 * the fight view. The condition is not "impossible", it is "once watched", and
 * that is a very different thing to tell a player, because they can act on it.
 *
 * "Once watched" rather than "while watching", and the difference was reported
 * as a contradiction: the figures kept accruing while the player browsed other
 * game tabs, against a caption claiming only the open-view stretch counted. The
 * behaviour is the honest half — the ticks really do keep arriving after the
 * view is left, and they are real measurements — so the words now match it.
 */
export const SPECTATED_TRIAL_NOTE =
    'a trial fight runs on the game’s own server and streams to this client once the In Progress fight view ' +
    'has been opened — the stream often keeps flowing while other tabs are browsed, and every tick that ' +
    'arrives is counted';

/** The stream that carries a spectated trial fight */
export const GUILD_BATTLE_MESSAGE = 'guild_battle_updated';

/** The message that opens a tier, with the roster and the tier-scaled boss on it */
export const NEW_GUILD_BATTLE_MESSAGE = 'new_guild_battle';

/** The message that closes a combat trial */
export const END_GUILD_BATTLE_MESSAGE = 'end_guild_battle';

/** A tick further from the last than this is a break, not a slow swing */
const MAX_TICK_GAP_MS = 2000;

/**
 * Which of the five encounters a name is, if any.
 *
 * Hrids as well as display names: `/monsters/trial_chameleon` and "Trial
 * Chameleon" are the same encounter, and only one of the two is guaranteed to be
 * in English. Separators are flattened to spaces so a name is compared on its
 * letters rather than on how the payload happened to punctuate them.
 *
 * @param {string} name - A monster name, a monster hrid, or a trial card name
 * @returns {string|null} The encounter, lowercased, or null
 */
export function encounterOf(name) {
    const lowered = String(name || '')
        .toLowerCase()
        .replace(/[/_-]+/g, ' ');
    return COMBAT_ENCOUNTERS.find((encounter) => lowered.includes(encounter)) || null;
}

/**
 * Whether the fight that just started is a guild combat trial.
 *
 * Pure, and the single decision the whole module hangs off — see the module note
 * for why it fails closed.
 *
 * @param {Object} input - Inputs
 * @param {string[]} input.monsterNames - Names of the monsters in the battle
 * @param {string[]} [input.trialNames] - Names of this week's combat trial cards
 * @returns {{isTrial: boolean, encounter: string|null, reason: string}} The verdict and why
 */
export function isTrialBattle({ monsterNames = [], trialNames = [] } = {}) {
    for (const name of monsterNames) {
        if (/trial/i.test(String(name || ''))) {
            return { isTrial: true, encounter: encounterOf(name), reason: 'the monster says it is a trial' };
        }
    }

    const wanted = new Set((trialNames || []).map(encounterOf).filter(Boolean));
    if (!wanted.size) {
        return {
            isTrial: false,
            encounter: null,
            reason: `no combat trial on this week’s record — ${SPECTATED_TRIAL_NOTE}`,
        };
    }

    for (const name of monsterNames) {
        const encounter = encounterOf(name);
        if (encounter && wanted.has(encounter)) {
            return { isTrial: true, encounter, reason: 'the boss is this week’s trial encounter' };
        }
    }

    // Names the battle carried, in the reason. A gate that fails closed and says
    // only *that* it failed cannot be diagnosed from a bug report — this one was
    // reported as "no per-player split during a Trial Chameleon fight", and what
    // the payload called those monsters is the fact that answered it: ordinary
    // zone monsters, because the battle was the player's own grinding while the
    // trial ran on the server, where the spectator stream now reads it.
    const seen = [...new Set(monsterNames.map((name) => String(name || '').trim()).filter(Boolean))];
    const listed = seen.length ? ` (${seen.slice(0, 4).join(', ')})` : '';
    return {
        isTrial: false,
        encounter: null,
        reason:
            `this client's own battle${listed} is not this week’s trial encounter ` +
            `(${[...wanted].join(', ')}) — ${SPECTATED_TRIAL_NOTE}`,
    };
}

/**
 * An estimated per-player split, from the builds that have been captured.
 *
 * The honest replacement for a measurement that cannot exist. Each member's own
 * sheet says what their auto-attack is worth a second; summing those and taking
 * shares is the same arithmetic the forecast's estimated party rate already
 * uses, so the two agree by construction. It is a *shape* — the sheet's
 * auto-attack figure is a multiplier on a weapon whose own damage is not on it,
 * abilities are not modelled, and a build seen a week ago is not what that
 * member is wearing now. Everything that draws this must lead with that.
 *
 * Members whose sheet has never been captured are returned by name rather than
 * dropped: a leaderboard that silently omits three people reads as three people
 * who did nothing.
 *
 * @param {Object} input - Inputs
 * @param {Array<Object>} [input.loadouts] - Snapshots from `guild-loadout-capture.js`
 * @param {string[]} [input.members] - Everyone the split should cover, e.g. the signed-up roster
 * @returns {{players: Array<Object>, unestimated: string[], total: number, covered: number, of: number,
 *   oldestAt: number|null}} The split, biggest first
 */
export function estimateDamageSplit({ loadouts = [], members = [] } = {}) {
    const byName = new Map();
    for (const loadout of loadouts || []) {
        const name = String(loadout?.name || '').trim();
        if (!name) continue;
        const key = name.toLowerCase();
        // `seen()` is most-recent-first, so the first spelling of a name wins
        if (!byName.has(key)) byName.set(key, loadout);
    }

    const wanted = (members || []).map((name) => String(name || '').trim()).filter(Boolean);
    const roster = wanted.length ? wanted : [...byName.values()].map((loadout) => loadout.name);

    const rows = [];
    const unestimated = [];
    const counted = new Set();

    for (const name of roster) {
        const key = name.toLowerCase();
        if (counted.has(key)) continue;
        counted.add(key);

        const loadout = byName.get(key);
        const dps = autoAttackDps(loadout?.stats);
        if (dps === null) {
            unestimated.push(name);
            continue;
        }
        rows.push({ name: loadout.name || name, dps, at: Number.isFinite(loadout.at) ? loadout.at : null });
    }

    const total = rows.reduce((sum, row) => sum + row.dps, 0);
    const stamps = rows.map((row) => row.at).filter((at) => Number.isFinite(at));

    return {
        players: rows
            .map((row) => ({ ...row, share: total > 0 ? (row.dps / total) * 100 : null }))
            .sort((a, b) => b.dps - a.dps),
        unestimated,
        total,
        covered: rows.length,
        of: rows.length + unestimated.length,
        oldestAt: stamps.length ? Math.min(...stamps) : null,
    };
}

/**
 * Every way a `new_battle` names the monsters in it.
 *
 * Every spelling, not the first one that exists. The payload observed from a
 * live client carries both — `hrid: '/monsters/the_watcher'` and `name: 'The
 * Watcher'` — and the previous version took the display name and stopped, which
 * threw away the only identifier that is stable across a localised client, a
 * renamed monster, or a trial whose boss the game displays under a title it does
 * not put in `name`. A trial fight that went unrecognised while the party was
 * visibly fighting "Trial Chameleon" is what that cost.
 *
 * `monsters` is an array on the wire; `Object.values` reads an array and a map
 * alike, so both shapes are handled without asking which one this is.
 *
 * @param {Object} data - `new_battle` payload
 * @returns {string[]} Names and hrids, in payload order, without duplicates
 */
export function battleMonsterNames(data) {
    const names = [];
    const add = (value) => {
        const text = String(value || '').trim();
        if (text && !names.includes(text)) names.push(text);
    };

    for (const monster of Object.values(data?.monsters || {})) {
        if (!monster || typeof monster !== 'object') continue;

        add(monster.name);
        add(monster.character?.name);

        const hrid = monster.combatMonsterHrid || monster.monsterHrid || monster.hrid;
        if (!hrid) continue;

        // The hrid itself, so `encounterOf` can match on it directly, and the
        // client's own name for it, which is what the panel displays
        add(hrid);
        add(dataManager.getInitClientData?.()?.combatMonsterDetailMap?.[hrid]?.name);
    }
    return names;
}

/**
 * Fold a tally into the rows a table wants.
 *
 * Pure and exported so the arithmetic — shares, rates, hit rates — is tested
 * without a socket.
 *
 * @param {Object} input - Inputs
 * @param {Object} input.tally - Player index → the `foldEvents` shape
 * @param {Object} [input.names] - Player index → display name
 * @param {Object} [input.deaths] - Player index → death count
 * @param {number} [input.seconds] - Seconds of fighting measured
 * @returns {{players: Array<Object>, totalDamage: number, partyDps: number|null}} Rows, biggest first
 */
export function summariseTrialDamage({ tally = {}, names = {}, deaths = {}, seconds = 0 } = {}) {
    const measurable = seconds >= MIN_SECONDS;
    const totalDamage = Object.values(tally).reduce((sum, entry) => sum + (entry?.damage || 0), 0);

    const players = Object.entries(tally).map(([index, entry]) => {
        const swings = (entry.hits || 0) + (entry.misses || 0);
        return {
            index,
            name: names[index] || `Player ${Number(index) + 1}`,
            // Every tally row is measured off the stream: the server groups
            // each tick by actor, so the attribution names its owner without
            // needing that player's own counters — the boss's counters gate
            // the hits and mark the crits for everybody
            measured: true,
            damage: entry.damage || 0,
            hits: entry.hits || 0,
            crits: entry.crits || 0,
            misses: entry.misses || 0,
            deaths: deaths[index] || 0,
            // Null rather than zero: no swings is nothing to compute a hit rate
            // from, and drawing it as 0% accuses somebody of missing everything
            accuracy: swings > 0 ? entry.hits / swings : null,
            critRate: entry.hits > 0 ? entry.crits / entry.hits : null,
            dps: measurable ? (entry.damage || 0) / seconds : null,
            share: totalDamage > 0 ? ((entry.damage || 0) / totalDamage) * 100 : null,
        };
    });

    return {
        players: players.sort((a, b) => b.damage - a.damage),
        totalDamage,
        partyDps: measurable && seconds > 0 ? totalDamage / seconds : null,
    };
}

/**
 * Fold one tally row into another, numerically.
 *
 * The rows are numbers all the way down — `damage`, `hits`, and the nested
 * `byAbility`/`byEnemy` maps of the same shape — so a recursive numeric sum is
 * the whole of it. `target` is copied, never mutated: banked history must be
 * immutable, and a helper that quietly mutated it would defeat the reason it
 * exists.
 *
 * @param {Object|null} target - The row folded into, or null to start one
 * @param {Object} row - The row to fold in
 * @returns {Object} A new row holding both
 */
export function foldTallyRow(target, row) {
    const merged = { ...(target || {}) };
    for (const [key, value] of Object.entries(row || {})) {
        if (typeof value === 'number') merged[key] = (merged[key] || 0) + value;
        else if (value && typeof value === 'object') merged[key] = foldTallyRow(merged[key], value);
    }
    return merged;
}

/**
 * The whole trial's figures, merged by NAME across wave boundaries.
 *
 * The live tallies are keyed by actor index, and an index is only meaningful
 * within one wave: `new_guild_battle` re-states `players[]` at every tier and
 * the ordering is not stable. Displaying a trial-long index-keyed tally under
 * the *current* wave's names is what made per-name totals swap at a tier
 * rollover — NPD "lost" 132K to whoever inherited their slot. So each wave's
 * figures are banked under the names its slots held when it ended, and this
 * merges the banked history with the live wave for display. A slot that never
 * earned a name banks under its placeholder, and placeholders from different
 * waves merge — an unknown is an unknown either way.
 *
 * @param {Object} input - Inputs
 * @param {Object} [input.bankedTally] - Name → tally row, from ended waves
 * @param {Object} [input.bankedDeaths] - Name → deaths, from ended waves
 * @param {Object} [input.bankedSupport] - Name → support row, from ended waves
 * @param {Object} [input.tally] - Index → tally row, the live wave
 * @param {Object} [input.names] - Index → display name, the live wave
 * @param {Object} [input.deaths] - Index → deaths, the live wave
 * @param {Object} [input.supportPlayers] - Index → support row, the live wave
 * @returns {{tally: Object, deaths: Object, support: Object, names: Object}} Everything keyed by name
 */
export function mergeWaveTallies({
    bankedTally = {},
    bankedDeaths = {},
    bankedSupport = {},
    tally = {},
    names = {},
    deaths = {},
    supportPlayers = {},
} = {}) {
    const nameOf = (index) => names[index] || `Player ${Number(index) + 1}`;
    const merged = { tally: {}, deaths: {}, support: {}, names: {} };
    const claim = (name) => {
        merged.names[name] = name;
        return name;
    };

    for (const [name, row] of Object.entries(bankedTally)) merged.tally[claim(name)] = foldTallyRow(null, row);
    for (const [index, row] of Object.entries(tally)) {
        const name = claim(nameOf(index));
        merged.tally[name] = foldTallyRow(merged.tally[name], row);
    }

    for (const [name, count] of Object.entries(bankedDeaths)) merged.deaths[claim(name)] = count;
    for (const [index, count] of Object.entries(deaths)) {
        const name = claim(nameOf(index));
        merged.deaths[name] = (merged.deaths[name] || 0) + count;
    }

    for (const [name, row] of Object.entries(bankedSupport)) merged.support[claim(name)] = foldSupportRow(null, row);
    for (const [index, row] of Object.entries(supportPlayers)) {
        const name = claim(nameOf(index));
        merged.support[name] = foldSupportRow(merged.support[name], row);
    }

    return merged;
}

class GuildTrialDamage {
    constructor() {
        this.initialized = false;
        this.onNewBattle = null;
        this.onBattleUpdated = null;
        /** Names of this week's combat trial cards, pushed in by the trials feature */
        this.trialNames = [];
        /**
         * The persisted `{battleId, roster, at}` a refreshed session reads
         * back. Survives {@link reset} on purpose: the battle id is what says
         * whether it may be used, not this module's lifecycle.
         */
        this.storedRoster = null;
        this.reset();
    }

    /** Forget the trial and measure the next one from scratch */
    reset() {
        this.state = newAttributionState();
        this.support = newSupportState();
        this.tally = {};
        this.names = {};
        this.deaths = {};
        /**
         * Ended waves' figures, keyed by NAME and immutable once written —
         * see {@link _bankCurrentWave}. The live index-keyed maps above cover
         * only the wave in progress.
         */
        this.bankedTally = {};
        this.bankedDeaths = {};
        this.bankedSupport = {};
        this.playersHP = {};
        this.seconds = 0;
        this.lastTickAt = 0;
        this.battleId = null;
        this.active = false;
        this.encounter = null;
        this.reason = SPECTATED_TRIAL_NOTE;
        this.fights = 0;
        this.startedAt = 0;
        /** Every spelling of the monsters in the fight in progress, for a late verdict */
        this.monsterNames = [];

        // ── The spectator stream ────────────────────────────────────────────
        /** `'spectated'` once a `guild_battle_updated` tick has been folded in */
        this.source = null;
        /** The battle the spectated ticks belong to */
        this.guildBattleId = null;
        /** The tier the stream states outright, which beats reasoning about a badge */
        this.tier = null;
        /** The boss's own bar, to the unit, and when it was read */
        this.pool = null;
        /** Index → `{name, source}`, from `guild-trial-units.js` */
        this.unitNames = {};
        /**
         * How much of the stream has been seen, and how much of it could be split.
         *
         * `playerActionTicks` is the one that decides what the panel may claim: a
         * boss losing health is party damage no matter what, but naming who did
         * it needs `atkCounter` on the `pMap` entries. Counting the ticks that
         * carried one lets the caption say which of the two this trial has.
         */
        this.spectator = { ticks: 0, playerActionTicks: 0, bossTicks: 0, lastAt: 0, firstAt: 0 };
        /** The boss's own stat sheet, per tier, from clicking it in the fight view */
        this.bossSheets = {};
        /** What the fight view says is being watched, exactly as it wrote it */
        this.spectatedBossName = null;
        /** Slot → `{name, characterId}`, from `new_guild_battle` */
        this.roster = {};
        /** Slots whose own action counters have been seen — your character, and only yours */
        this.countedSlots = new Set();
        /** When each tier started, from the message that opens it */
        this.tierStarts = {};
        /** Set once `end_guild_battle` has been seen for this trial */
        this.endedAt = null;
        /** The party size the game stated, which is what the ladders scale by */
        this.participants = null;
    }

    /**
     * Tell it which trials are running this week.
     *
     * Pushed in rather than read out of the trials record directly, so this
     * module does not import the feature that draws it — the dependency runs one
     * way and a cycle cannot form.
     *
     * The verdict on the fight already in progress is re-taken, because the
     * order these two arrive in is not controllable: the trials record learns
     * this week's combat card when the guild panel is first drawn, which is
     * routinely *after* the party has started swinging. Deciding only on
     * `new_battle` meant a trial joined before the panel was ever opened stayed
     * unattributed for its whole first fight, with the record sitting there
     * naming the encounter.
     *
     * @param {string[]} names - Combat trial card names, e.g. `['Trial Chameleon']`
     */
    setTrialNames(names) {
        const next = Array.isArray(names) ? names.filter(Boolean) : [];
        const changed = next.join('|') !== this.trialNames.join('|');
        this.trialNames = next;
        if (changed && !this.active && this.monsterNames.length) this._reconsider();
    }

    /**
     * Judge the fight in progress again, against the trial names now known.
     *
     * Only ever arms — a fight that has been counted is not un-counted here,
     * because the tally already holds its damage.
     */
    _reconsider() {
        const verdict = isTrialBattle({ monsterNames: this.monsterNames, trialNames: this.trialNames });
        this.reason = verdict.reason;
        if (!verdict.isTrial) return;

        this.active = true;
        this.encounter = verdict.encounter;
        if (!this.startedAt) this.startedAt = Date.now();
        if (!this.fights) this.fights = 1;
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;

        // Read back the roster a previous page-load wrote down, so a refresh
        // mid-tier does not lose every name until the next tier restates them
        this._restoreStoredRoster();

        this.onNewBattle = (data) => this._onNewBattle(data);
        this.onBattleUpdated = (data) => this._onBattleUpdated(data);
        this.onGuildBattle = (data) => this._onGuildBattleTick(data);
        this.onUnitFetched = (data) => this._onUnitFetched(data);
        this.onNewGuildBattle = (data) => this._onNewGuildBattle(data);
        this.onEndGuildBattle = (data) => this._onEndGuildBattle(data);
        webSocketHook.on('new_battle', this.onNewBattle);
        webSocketHook.on('battle_updated', this.onBattleUpdated);
        webSocketHook.on(GUILD_BATTLE_MESSAGE, this.onGuildBattle);
        webSocketHook.on('battle_unit_fetched', this.onUnitFetched);
        webSocketHook.on(NEW_GUILD_BATTLE_MESSAGE, this.onNewGuildBattle);
        webSocketHook.on(END_GUILD_BATTLE_MESSAGE, this.onEndGuildBattle);
    }

    cleanup() {
        if (this.onNewBattle) webSocketHook.off('new_battle', this.onNewBattle);
        if (this.onBattleUpdated) webSocketHook.off('battle_updated', this.onBattleUpdated);
        if (this.onGuildBattle) webSocketHook.off(GUILD_BATTLE_MESSAGE, this.onGuildBattle);
        if (this.onUnitFetched) webSocketHook.off('battle_unit_fetched', this.onUnitFetched);
        if (this.onNewGuildBattle) webSocketHook.off(NEW_GUILD_BATTLE_MESSAGE, this.onNewGuildBattle);
        if (this.onEndGuildBattle) webSocketHook.off(END_GUILD_BATTLE_MESSAGE, this.onEndGuildBattle);
        this.onNewBattle = null;
        this.onBattleUpdated = null;
        this.onGuildBattle = null;
        this.onUnitFetched = null;
        this.onNewGuildBattle = null;
        this.onEndGuildBattle = null;
        this.initialized = false;
        this.reset();
    }

    /**
     * A tier of the trial has begun.
     *
     * The single most useful message in the family, and it fires at *every*
     * tier. Four things arrive with it that nothing else on this client has:
     *
     * - **The roster, in slot order.** `players[]` carries `character.id` and
     *   `character.name`, and a tick's `pMap` keys are indexes into that array.
     *   That is the join the spectator stream never had, and it retires the
     *   guessing for anyone watching from the start.
     * - **The tier-scaled boss.** `monsters[]` are whole sheets — health, the
     *   enrage timer, the full `combatDetails` — so a boss sheet no longer needs
     *   anybody to click the thing. It confirms the rule again on arrival: a
     *   330,000-health Badger with thirty players in the trial reads 429,000,
     *   which is `330,000 × (1 + 0.01 × 30)` exactly.
     * - **The tier boundary.** Stated, rather than inferred from the boss's
     *   health jumping. The baselines are dropped here and the walk over the
     *   pool never sees a wave reset as a heal.
     * - **The encounter**, from `monsters[].hrid`.
     *
     * @param {Object} data - A `new_guild_battle` payload
     */
    _onNewGuildBattle(data) {
        try {
            if (!data || typeof data !== 'object') return;

            const now = Date.now();
            const tier = Number.isFinite(Number(data.tier)) ? Number(data.tier) : null;
            const battleId = data.battleId ?? null;

            // The stated boundary, which is what this message is *for*
            if (battleId !== this.guildBattleId || tier !== this.tier) {
                this._newSpectatedWave(battleId, tier, now);
            }
            this.tier = tier;
            this.guildBattleId = battleId;
            this.source = this.source || 'spectated';
            // The game saying a tier has begun is the strongest statement that a
            // trial is running that this module has ever had
            this.active = true;
            this.reason = SPECTATED_TRIAL_NOTE;
            this.endedAt = null;
            if (!this.startedAt) this.startedAt = now;
            if (Number.isFinite(tier)) this.tierStarts[tier] = now;

            // The roster replaces every weaker source, and a new battle restates
            // it — a slot that changed hands must not keep the old name
            const roster = rosterFromBattle(data);
            if (Object.keys(roster).length) {
                this.roster = roster;
                for (const [index, entry] of Object.entries(roster)) {
                    this.unitNames[index] = { name: entry.name, source: 'roster', characterId: entry.characterId };
                    this.names[index] = entry.name;
                }
                // …and written down with the battle it belongs to. This message
                // fires once per tier and never again, so a page refresh
                // mid-tier used to lose every name — "Player 2" on a
                // leaderboard whose roster had been on the wire minutes before
                // Keyed by battle AND tier: the slots re-deal per tier, so a
                // roster adopted across tiers would re-create the very
                // mislabelling the per-wave re-deal exists to prevent
                if (battleId) {
                    this.storedRoster = { battleId, tier, roster, at: now };
                    saveTrialRoster(this.storedRoster).catch(() => {});
                }
            }

            this._noteBattleMonsters(data.monsters, tier, now);
            // The party size the pool and health ladders scale by, stated rather
            // than counted off a sign-up sheet
            const participants = Object.keys(roster).length;
            if (participants) this.participants = participants;
        } catch (error) {
            console.error('[GuildTrialDamage] Reading the start of a trial tier failed:', error);
        }
    }

    /**
     * The boss sheets a tier's opening message carries.
     *
     * Filed exactly where a clicked sheet goes, so the two sources are one store
     * and a trial watched from the start needs no clicking at all.
     *
     * @param {Array<Object>} monsters - `new_guild_battle.monsters`
     * @param {number|null} tier - The tier it opened
     * @param {number} at - Now
     */
    _noteBattleMonsters(monsters, tier, at) {
        for (const monster of Array.isArray(monsters) ? monsters : []) {
            const name = String(monster?.name || '');
            const encounter = encounterOf(monster?.hrid || name);
            if (!encounter) continue;

            if (!this.encounter) {
                this.encounter = encounter;
                this.spectatedBossName = name || this.spectatedBossName;
            }
            if (!Number.isFinite(tier)) continue;

            const details =
                monster.combatDetails && typeof monster.combatDetails === 'object' ? monster.combatDetails : {};
            this.bossSheets[tier] = {
                name,
                tier,
                hrid: monster.hrid ?? null,
                level: Number(details.combatLevel) || null,
                maxHitpoints: Number(monster.maxHitpoints ?? details.maxHitpoints) || null,
                maxManapoints: Number(monster.maxManapoints ?? details.maxManapoints) || null,
                // Nanoseconds on the wire — ten minutes, which is the stack cap
                enrageTimerMs: Number(monster.enrageTimerDuration) / 1e6 || null,
                spawnTime: monster.spawnTime ?? null,
                stats: { ...details },
                source: 'new_guild_battle',
                at,
            };
            return;
        }
    }

    /**
     * The combat trial is over, stated by the game.
     *
     * It carries a battle id and a trial hrid and nothing else — no result, no
     * tier, no rewards — so what it settles is the *lifecycle*: this is the
     * moment a session can be finalised and a result reported with certainty,
     * rather than inferred from ticks going quiet.
     *
     * @param {Object} data - An `end_guild_battle` payload
     */
    _onEndGuildBattle(data) {
        try {
            const trial = trialFromHrid(data?.trialHrid);
            // A different trial's ending is not this one's
            if (trial && this.encounter && trial.key !== this.encounter) return;
            if (trial && !this.encounter) this.encounter = trial.key;

            this.endedAt = Date.now();
            this.active = false;
        } catch (error) {
            console.error('[GuildTrialDamage] Reading the end of a trial failed:', error);
        }
    }

    /**
     * A tick of the trial fight, as streamed to a spectator.
     *
     * The same arithmetic as `_onBattleUpdated` over the same payload shape, with
     * three differences that all come from this being somebody else's fight:
     *
     * - **No gate.** A `guild_battle_updated` is a guild trial by construction —
     *   it is the only thing that produces one — so there is no encounter to
     *   recognise and no battle to mistake it for.
     * - **The tier is stated.** It replaces the badge inference for as long as
     *   the stream runs, and a change of tier is a new wave: the boss is a fresh
     *   unit at full health and the party is topped up between them, so the
     *   diff baselines are dropped or the reset reads as a heal for the pool.
     * - **Names are indexes**, resolved by `guild-trial-units.js` rather than
     *   read off a roster the payload does not carry.
     *
     * @param {Object} data - `guild_battle_updated` payload
     */
    _onGuildBattleTick(data) {
        try {
            if (!data || typeof data !== 'object') return;

            const now = Date.now();
            const battleId = data.battleId ?? null;
            const tier = Number.isFinite(Number(data.tier)) ? Number(data.tier) : null;

            // A different battle, or a different wave of the same one. Either way
            // the units on screen are not the units the baselines describe
            if (battleId !== this.guildBattleId || tier !== this.tier) {
                this._newSpectatedWave(battleId, tier, now);
            }

            this.source = 'spectated';
            this.active = true;
            this.reason = SPECTATED_TRIAL_NOTE;
            if (!this.startedAt) this.startedAt = now;
            if (!this.spectator.firstAt) this.spectator.firstAt = now;

            const pMap = data.pMap || {};
            const mMap = data.mMap || {};

            this._identifyEncounter();
            // A session that missed the tier's opening message — a refresh —
            // reads the persisted roster back, gated on the battle id matching
            if (!Object.keys(this.roster).length) this._adoptStoredRoster(battleId, tier);
            this._nameUnits(pMap);
            this._readPool(mMap, tier, now);

            // Before `noteActions`, exactly as the ordinary path does it: the hit
            // that lands on this tick was cast by what was prepared before it.
            //
            // The server groups each tick by actor, so the attribution's
            // presence rung measures every player here — the lone unit in a
            // tick owns its action, reflect and damage-over-time included.
            // (The 1,405-health tick this module once refused as "the tank was
            // merely being hit" carried the boss's own hit counter rising: the
            // boss struck the tank and bled on their thorns, and refusing it
            // was the error.) `soloFallback: false` still holds — it gates the
            // party-of-one rung, and no roster message states a party here.
            const events = attributeTick(data, this.state, { soloFallback: false });
            // No non-damaging filter: `abilityHrid` streams for your own unit
            // only, so every other player's action reads as idle — on this
            // stream that means unlabeled, not idle, and the hit gate (the
            // boss's own counter) already keeps non-hits out
            foldEvents(this.tally, events, { filterNonDamaging: false });
            this._noteDeaths(pMap);
            foldSupportTick(this.support, pMap, this.state.actions, undefined, now);
            noteActions(this.state, pMap);

            this.spectator.ticks += 1;
            // Which *slots* carried counters, not merely whether any did. The
            // recording shows exactly one player entry ever carrying them — the
            // client's own unit — so "can this be split" is a fact about a row
            // rather than about the trial
            let counted = false;
            for (const [index, unit] of Object.entries(pMap)) {
                if (!Number.isFinite(Number(unit?.atkCounter))) continue;
                this.countedSlots.add(index);
                counted = true;
            }
            if (counted) this.spectator.playerActionTicks += 1;
            if (Object.keys(mMap).length) this.spectator.bossTicks += 1;

            const gap = now - this.lastTickAt;
            if (this.lastTickAt && gap > 0 && gap < MAX_TICK_GAP_MS) this.seconds += gap / 1000;
            this.lastTickAt = now;
            this.spectator.lastAt = now;
        } catch (error) {
            console.error('[GuildTrialDamage] Reading a spectated trial tick failed:', error);
        }
    }

    /**
     * The boss's own sheet, from clicking it in the fight view.
     *
     * Clicking the boss fires `battle_unit_fetched` exactly as clicking a member
     * does, and the sheet that comes back is the *tier-scaled* one — Lv.110,
     * 618,000 health, and every accuracy, damage and evasion rating with it.
     * That is worth keeping, and it is emphatically not a loadout: it is filed
     * here by tier and `guild-loadouts.js` refuses it as a member outright.
     *
     * Kept per tier because that is the whole value of it. The health ladder is
     * derived and verified; whether the *other* ratings scale the same way has
     * only ever been assumed, and two tiers' sheets in one export settle it.
     *
     * @param {Object} data - `battle_unit_fetched` payload
     */
    _onUnitFetched(data) {
        try {
            const unit = data?.unit || data;
            if (!unit || typeof unit !== 'object' || !isMonsterUnit(unit)) return;

            const name = String(unit.character?.name || unit.name || '');
            // Only a trial's boss. An ordinary zone monster clicked during the
            // hour is not a trial sheet and would sit here pretending to be one
            if (!encounterOf(name)) return;

            const details = unit.combatDetails && typeof unit.combatDetails === 'object' ? unit.combatDetails : {};
            const level = Number(details.combatLevel ?? unit.character?.combatLevel);
            // The stream states the tier outright while it runs; the sheet's own
            // level is what answers when nobody is watching
            const tier = this.tier ?? tierFromLevel(level);
            if (!Number.isFinite(tier)) return;

            // One click on the boss is enough to say which trial this is, and it
            // outlives the fight view being closed
            if (!this.encounter) {
                this.encounter = encounterOf(name);
                this.spectatedBossName = name;
            }

            this.bossSheets[tier] = {
                name,
                tier,
                level: Number.isFinite(level) ? level : null,
                maxHitpoints: Number(details.maxHitpoints) || null,
                maxManapoints: Number(details.maxManapoints) || null,
                stats: { ...(details.combatStats || {}) },
                at: Date.now(),
            };
        } catch (error) {
            console.error('[GuildTrialDamage] Reading a trial boss sheet failed:', error);
        }
    }

    /**
     * A new battle or a new wave: drop the baselines, keep the tally.
     *
     * The tally spans the whole trial deliberately — a trial is a ladder of
     * fights and the comparison a guild wants spans them. What must not span
     * them is the *diff*: a fresh boss at full health read against the last one's
     * corpse is a 618,000-point heal, and a party topped up between waves is
     * everybody healing everybody.
     *
     * @param {*} battleId - The battle this tick belongs to
     * @param {number|null} tier - The tier it states
     * @param {number} at - Now
     */
    _newSpectatedWave(battleId, tier, at) {
        const newFight = battleId !== this.guildBattleId;

        // The wave that just ended is banked under the names its slots held —
        // BEFORE anything below re-deals them. Observed live at a tier
        // rollover: per-name totals *swapped* (NPD lost 132K to whoever
        // inherited their slot), because the trial-long tally is index-keyed
        // and `new_guild_battle` re-states `players[]` per tier in an order
        // that is not stable. Banked history is by name and immutable; a name
        // correction may relabel the live wave's slots, never the past.
        this._bankCurrentWave();

        this.state.monstersHP = {};
        this.state.dmgCounter = {};
        this.state.critCounter = {};
        // The counter baselines, actions and party keys are all per-slot, and
        // the slots have just been re-dealt: a new wave's counters compared
        // against another player's baselines mis-swing the first tick
        this.state.playersAtk = {};
        this.state.playersMP = {};
        this.state.actions = {};
        this.state.party = {};
        this.state.lastSwing = null;
        this.support.lastHP = {};
        this.support.lastMP = {};
        this.playersHP = {};

        // Every wave re-deals the slots — a tier change included, which the
        // rule this replaces ("the same thirty people fight every tier")
        // learned the hard way: the *people* are the same, the *ordering* is
        // not. The names come back on the wave's own `new_guild_battle`
        // roster, or through the resolver's rungs for a wave without one.
        this.roster = {};
        this.unitNames = {};
        this.names = {};
        // …and the own-unit binding re-confirms per wave, by counters, rather
        // than carrying an index across a re-deal
        this.countedSlots = new Set();

        if (newFight) {
            // A different battle is a different encounter until something says
            // otherwise. Carrying the last one over is how a Chameleon fight
            // gets filed under Hedgehog
            this.spectatedBossName = null;
            this.encounter = null;
        }

        this.guildBattleId = battleId;
        this.tier = tier;
        this.fights += 1;
        // A gap in the watching is not a gap in the fight, but it is a gap in
        // what was measured, and folding it into the elapsed seconds would
        // divide the damage by an hour nobody watched
        if (newFight) this.lastTickAt = 0;
        this.pool = null;
        this.spectator.lastAt = at;
    }

    /**
     * Bank the live wave's figures under the names its slots hold now.
     *
     * Called at every wave boundary, before the slots re-deal. Once banked, a
     * name's history is immutable: later corrections apply to the live wave's
     * slots only, and can never transplant past damage between names. A slot
     * that never earned a name banks under its placeholder — an unknown then,
     * an unknown forever, which is the honest end of it.
     */
    _bankCurrentWave() {
        const nameOf = (index) => this.names[index] || `Player ${Number(index) + 1}`;

        for (const [index, row] of Object.entries(this.tally)) {
            const name = nameOf(index);
            this.bankedTally[name] = foldTallyRow(this.bankedTally[name], row);
        }
        for (const [index, count] of Object.entries(this.deaths)) {
            if (!(count > 0)) continue;
            const name = nameOf(index);
            this.bankedDeaths[name] = (this.bankedDeaths[name] || 0) + count;
        }
        for (const [index, row] of Object.entries(this.support.players || {})) {
            const name = nameOf(index);
            this.bankedSupport[name] = foldSupportRow(this.bankedSupport[name], row);
        }

        this.tally = {};
        this.deaths = {};
        this.support.players = {};
        this.support.lastAtk = {};
        this.support.emptySince = {};
    }

    /**
     * Which encounter is being watched.
     *
     * The stream carries a `battleId` and a `tier` and no name at all, so the
     * identity has to come from beside it. Two sources, and neither is a guess:
     *
     * 1. **The fight view's own boss tile.** It draws "Trial Chameleon" in the
     *    monsters area exactly as it draws the party's names in the players
     *    area, and this reads it the same way.
     * 2. **A boss sheet already clicked.** `battle_unit_fetched` names the unit
     *    outright, so one click identifies a fight for the rest of it.
     *
     * When neither can say, the answer stays null and the pool attaches to *no*
     * card. That is the whole point: standing in for every barless combat card
     * is what filed a Chameleon fight under Hedgehog, and "no data" on both is
     * strictly better than the right number on the wrong trial.
     */
    _identifyEncounter() {
        if (this.encounter) return;

        for (const name of fightViewBossNames()) {
            const encounter = encounterOf(name);
            if (!encounter) continue;

            this.spectatedBossName = name;
            this.encounter = encounter;
            return;
        }

        // A sheet for the tier being fought first, then any sheet at all — one
        // click on the boss identifies the fight even after the view is shut
        const sheets = Object.values(this.bossSheets);
        const preferred = sheets.find((sheet) => sheet.tier === this.tier) || sheets[sheets.length - 1];
        const fromSheet = encounterOf(preferred?.name || '');
        if (!fromSheet) return;

        this.spectatedBossName = preferred.name;
        this.encounter = fromSheet;
    }

    /**
     * Read the persisted roster back at startup.
     *
     * Fire-and-forget from {@link initialize}; nothing waits on it, and a tick
     * that beats the read simply resolves names without it and better on the
     * next one.
     */
    async _restoreStoredRoster() {
        try {
            const held = await loadTrialRoster();
            if (held) this.storedRoster = held;
        } catch (error) {
            console.error('[GuildTrialDamage] Restoring the trial roster failed:', error);
        }
    }

    /**
     * Adopt the persisted roster, when it is provably this fight's.
     *
     * The battle id and the tier are the whole gate, together: the id says
     * this trial, and the tier says this *deal* of the slots — `players[]` is
     * re-stated per tier in an order that is not stable, so a roster from
     * another tier names the wrong slots as surely as another battle's would.
     * Anything else, including an entry with no id, stays unused. The age
     * bound is belt and braces: a trial runs an hour, so an older entry is
     * another trial's even if an id were ever reused.
     *
     * @param {*} battleId - The battle the current stream belongs to
     * @param {number|null} tier - The tier it states
     */
    _adoptStoredRoster(battleId, tier) {
        const held = this.storedRoster;
        if (!held || !battleId || String(held.battleId) !== String(battleId)) return;
        if ((held.tier ?? null) !== (tier ?? null)) return;
        if (Number.isFinite(held.at) && Date.now() - held.at > TRIAL_ACTIVE_MS) return;

        const roster = held.roster && typeof held.roster === 'object' ? held.roster : {};
        if (!Object.keys(roster).length) return;

        this.roster = { ...roster };
        for (const [index, entry] of Object.entries(this.roster)) {
            if (!entry?.name) continue;
            this.unitNames[index] = { name: entry.name, source: 'roster', characterId: entry.characterId ?? null };
            this.names[index] = entry.name;
        }
        if (!this.participants) this.participants = Object.keys(this.roster).length;
    }

    /**
     * Put names to the tick's unit indexes.
     * @param {Object} pMap - The tick's players
     */
    _nameUnits(pMap) {
        // The one slot the stream carries attack counters for is the watcher's
        // own unit — the only slot their own name may bind to
        const ownSlot = this.countedSlots.size === 1 ? [...this.countedSlots][0] : null;

        const resolved = resolveUnitNames({
            pMap,
            roster: this.roster,
            portraits: fightViewNames(),
            partyNames: fightViewPartyNames(),
            loadouts: guildLoadoutCapture.seen?.() || [],
            known: this.unitNames,
            own: { slot: ownSlot, name: dataManager.getCurrentCharacterName?.() || null },
        });

        for (const [index, entry] of Object.entries(resolved)) {
            this.unitNames[index] = entry;
            this.names[index] = entry.name;
        }
    }

    /**
     * The boss's own bar, which is the pool to the unit.
     *
     * A second and better source for the figure the trials panel has been
     * scraping off the DOM: the same number, per tick rather than per redraw, and
     * available when the card is not on screen.
     *
     * @param {Object} mMap - The tick's monsters
     * @param {number|null} tier - The tier the payload states
     * @param {number} at - Now
     */
    _readPool(mMap, tier, at) {
        for (const unit of Object.values(mMap || {})) {
            const current = Number(unit?.cHP);
            const max = Number(unit?.mHP);
            if (!Number.isFinite(current) || !Number.isFinite(max) || max <= 0) continue;

            // The encounter travels with the reading. A pool with no name on it
            // is a pool no card may claim
            this.pool = { current, max, tier, at, encounter: this.encounter, bossName: this.spectatedBossName };
            return;
        }
    }

    /**
     * A fight started. Decide whether it is the trial's.
     * @param {Object} data - `new_battle` payload
     */
    _onNewBattle(data) {
        try {
            const monsterNames = battleMonsterNames(data);
            const verdict = isTrialBattle({ monsterNames, trialNames: this.trialNames });
            this.monsterNames = monsterNames;

            this.battleId = data?.battleId ?? null;
            this.active = verdict.isTrial;
            this.reason = verdict.reason;

            // Counters belong to the units of the fight they were read from
            this.state.monstersHP = {};
            this.state.dmgCounter = {};
            this.state.critCounter = {};

            if (!verdict.isTrial) return;

            // A different encounter is a different trial, and folding the two
            // together would report one party's damage against another's boss
            if (verdict.encounter && verdict.encounter !== this.encounter) {
                const names = this.names;
                this.reset();
                this.names = names;
                this.monsterNames = monsterNames;
                this.active = true;
                this.battleId = data?.battleId ?? null;
                this.reason = verdict.reason;
            }
            this.encounter = verdict.encounter;
            if (!this.startedAt) this.startedAt = Date.now();
            this.fights += 1;

            // The fight that just ended banks under its own names before the
            // roster below re-deals the slots — the same immutability rule the
            // spectated path enforces at every wave
            this._bankCurrentWave();

            const players = data?.players || {};
            noteActions(this.state, players);

            // Rebuilt rather than merged: an index is a slot in this fight
            this.names = {};
            for (const [index, player] of Object.entries(players)) {
                this.names[index] = player?.character?.name || player?.name || null;
            }
        } catch (error) {
            console.error('[GuildTrialDamage] Reading the start of a fight failed:', error);
        }
    }

    /**
     * A tick of the fight.
     * @param {Object} data - `battle_updated` payload
     */
    _onBattleUpdated(data) {
        try {
            // A battle this module never saw announced cannot be shown to be the
            // trial's, so it is not counted. That is the reload-mid-trial case,
            // and measuring nothing there is the honest outcome
            if (data?.battleId !== this.battleId) {
                this.battleId = data?.battleId ?? null;
                this.active = false;
                this.reason =
                    'this fight was already under way — no start message to identify it. ' +
                    `In any case, ${SPECTATED_TRIAL_NOTE}`;
                return;
            }
            if (!this.active) return;

            const now = Date.now();
            const events = attributeTick(data, this.state);
            foldEvents(this.tally, events);
            this._noteDeaths(data?.pMap);

            // Damage taken, healing, mana and casts, from the same tick and the
            // same before-picture of who was preparing what
            foldSupportTick(this.support, data?.pMap, this.state.actions, undefined, now);

            // After attributing, never before: the hit on this tick was cast by
            // what was prepared before it
            noteActions(this.state, data?.pMap);

            const gap = now - this.lastTickAt;
            if (this.lastTickAt && gap > 0 && gap < MAX_TICK_GAP_MS) this.seconds += gap / 1000;
            this.lastTickAt = now;
        } catch (error) {
            console.error('[GuildTrialDamage] Reading a trial tick failed:', error);
        }
    }

    /**
     * Deaths, from health crossing zero.
     *
     * `pMap` is a delta, so a player who did not change is not in the tick — the
     * last known health is kept per player rather than read fresh, or a member
     * absent from one tick would appear to have been resurrected.
     *
     * @param {Object} pMap - The tick's players
     */
    _noteDeaths(pMap) {
        for (const [index, player] of Object.entries(pMap || {})) {
            const health = Number(player?.cHP);
            if (!Number.isFinite(health)) continue;

            const before = this.playersHP[index];
            if (Number.isFinite(before) && before > 0 && health <= 0) {
                this.deaths[index] = (this.deaths[index] || 0) + 1;
            }
            this.playersHP[index] = health;
        }
    }

    /**
     * What the trial has looked like so far.
     *
     * `support` fills from the spectator stream even when the damage split does
     * not: health falling, health rising and mana are per-unit facts on every
     * tick, where naming the *attacker* needs `atkCounter` on the players. So a
     * breakdown can honestly carry a full tank-and-healer table and an empty
     * damage table, and `splitFromCounters` is what says which.
     *
     * @returns {{measured: boolean, active: boolean, encounter: string|null, reason: string,
     *   seconds: number, fights: number, players: Array<Object>, totalDamage: number,
     *   partyDps: number|null, ageMs: number|null, source: string|null, tier: number|null,
     *   pool: Object|null, spectator: Object, names: Object}} The breakdown; `measured` is false
     *   when there is nothing to draw, and `reason` says which flavour of nothing it is
     */
    breakdown() {
        const ageMs = this.lastTickAt ? Date.now() - this.lastTickAt : null;

        // A trial runs an hour. Anything older describes an event that has ended,
        // and a DPS table under a live trial card that is actually last week's
        // is worse than no table
        const stale = ageMs !== null && ageMs > TRIAL_ACTIVE_MS;
        // The banked waves and the live one, merged by name — the only key
        // that survives the per-tier slot re-deal. See `mergeWaveTallies`.
        const merged = mergeWaveTallies({
            bankedTally: this.bankedTally,
            bankedDeaths: this.bankedDeaths,
            bankedSupport: this.bankedSupport,
            tally: this.tally,
            names: this.names,
            deaths: this.deaths,
            supportPlayers: this.support.players,
        });
        const summary = summariseTrialDamage({
            tally: merged.tally,
            names: merged.names,
            deaths: merged.deaths,
            seconds: this.seconds,
        });
        const support = summariseSupport({ ...this.support, players: merged.support }, merged.names, merged.deaths);

        return {
            measured: !stale && summary.players.length > 0,
            // A watched trial that produced no damage split still produced a
            // tank-and-healer table, and a panel that only looks at `measured`
            // would throw it away
            measuredSupport: !stale && support.players.length > 0,
            stale,
            active: this.active,
            encounter: this.encounter,
            reason: this.reason,
            seconds: this.seconds,
            fights: this.fights,
            ageMs,
            // Where these figures came from, which every caption has to state
            source: this.source,
            // The stream says the tier outright; nothing else on this client does
            tier: this.tier,
            // The boss's own bar, per tick — the pool reading the panel scrapes
            // off the DOM, from the wire instead
            pool: this.pool ? { ...this.pool } : null,
            spectator: { ...this.spectator },
            // What the fight view called the thing being fought, verbatim
            bossName: this.spectatedBossName,
            // The boss's tier-scaled sheet, per tier, for the export. Not a
            // loadout and never stored as one — see `isMonsterUnit`
            bossSheets: { ...this.bossSheets },
            // Whether any player's own attack counters have been seen. The
            // split no longer depends on them — the presence rung measures
            // every actor — but a row they confirm directly is worth naming,
            // and the export keeps the fact either way
            splitFromCounters: this.spectator.playerActionTicks > 0,
            // Which slots the game streamed counters for. In every recording so
            // far that is exactly one — the viewer's own character
            countedSlots: [...this.countedSlots],
            countedNames: [...this.countedSlots].map((index) => this.names[index]).filter(Boolean),
            // The roster the game stated, and the party size the ladders scale by
            roster: { ...this.roster },
            participants: this.participants ?? null,
            // When each tier started, so a trial's tier durations are exact
            tierStarts: { ...this.tierStarts },
            endedAt: this.endedAt,
            // How each unit was identified, so a placeholder can be shown as one
            names: Object.fromEntries(Object.entries(this.unitNames).map(([index, e]) => [index, { ...e }])),
            nameCoverage: nameCoverage(this.unitNames),
            // What the last fight's payload called its monsters, and what the
            // gate was looking for. Both are in the export, so a gate that fails
            // closed can be diagnosed from a bug report rather than guessed at
            monsterNames: [...this.monsterNames],
            trialNames: [...this.trialNames],
            // Everything a tick says about a player besides damage, and a note
            // of what it cannot say — see `guild-trial-support.js`
            support,
            supportCoverage: supportCoverage(),
            ...summary,
        };
    }
}

const guildTrialDamage = new GuildTrialDamage();

export default guildTrialDamage;
export { guildTrialDamage };
