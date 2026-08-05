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
 *    same encounter as the card is that trial. Without a combat card on the
 *    record — no trial this week, or the panel has never been opened — rule 2
 *    cannot fire at all, which is the conservative direction.
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
 * ## What it can say
 *
 * Damage, share of the party's total, hit rate, crit rate and deaths, per
 * player, across the whole trial and not merely the tier on screen — a trial is
 * a ladder of fights and the interesting comparison spans them. Deaths come from
 * the same feed for free: a player's health crossing zero in `pMap`.
 *
 * ## What it cannot
 *
 * **Only the fights this client is in.** A guild member watching a trial they
 * did not sign up for receives no battle traffic for it, so there is nothing
 * here to fold. That is the same limit the rest of the trials feature has and it
 * is reported the same way — the breakdown says nothing has been seen rather
 * than drawing zeroes.
 *
 * **Overkill is not counted**, and a tick that names nobody credits nobody —
 * both inherited from the attribution module, both documented there.
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import { attributeTick, foldEvents, newAttributionState, noteActions } from '../../utils/damage-attribution.js';
import { foldSupportTick, newSupportState, summariseSupport, supportCoverage } from './guild-trial-support.js';
import { COMBAT_ENCOUNTERS, TRIAL_ACTIVE_MS } from './guild-trials-math.js';

/** Below this the per-player rates are one exchange's luck rather than a rate */
export const MIN_SECONDS = 5;

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
        return { isTrial: false, encounter: null, reason: 'no combat trial on this week’s record' };
    }

    for (const name of monsterNames) {
        const encounter = encounterOf(name);
        if (encounter && wanted.has(encounter)) {
            return { isTrial: true, encounter, reason: 'the boss is this week’s trial encounter' };
        }
    }

    // Names the battle carried, in the reason. A gate that fails closed and says
    // only *that* it failed cannot be diagnosed from a bug report — this one was
    // reported as "no per-player split during a Trial Chameleon fight" and the
    // one fact needed to explain it, what the payload actually called those
    // monsters, was the one fact nothing recorded.
    const seen = [...new Set(monsterNames.map((name) => String(name || '').trim()).filter(Boolean))];
    const listed = seen.length ? ` (${seen.slice(0, 4).join(', ')})` : '';
    return {
        isTrial: false,
        encounter: null,
        reason: `the monsters${listed} are not this week’s trial encounter (${[...wanted].join(', ')})`,
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

class GuildTrialDamage {
    constructor() {
        this.initialized = false;
        this.onNewBattle = null;
        this.onBattleUpdated = null;
        /** Names of this week's combat trial cards, pushed in by the trials feature */
        this.trialNames = [];
        this.reset();
    }

    /** Forget the trial and measure the next one from scratch */
    reset() {
        this.state = newAttributionState();
        this.support = newSupportState();
        this.tally = {};
        this.names = {};
        this.deaths = {};
        this.playersHP = {};
        this.seconds = 0;
        this.lastTickAt = 0;
        this.battleId = null;
        this.active = false;
        this.encounter = null;
        this.reason = 'no trial fight seen yet';
        this.fights = 0;
        this.startedAt = 0;
        /** Every spelling of the monsters in the fight in progress, for a late verdict */
        this.monsterNames = [];
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

        this.onNewBattle = (data) => this._onNewBattle(data);
        this.onBattleUpdated = (data) => this._onBattleUpdated(data);
        webSocketHook.on('new_battle', this.onNewBattle);
        webSocketHook.on('battle_updated', this.onBattleUpdated);
    }

    cleanup() {
        if (this.onNewBattle) webSocketHook.off('new_battle', this.onNewBattle);
        if (this.onBattleUpdated) webSocketHook.off('battle_updated', this.onBattleUpdated);
        this.onNewBattle = null;
        this.onBattleUpdated = null;
        this.initialized = false;
        this.reset();
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
                this.reason = 'this fight was already under way — no start message to identify it';
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
     * @returns {{measured: boolean, active: boolean, encounter: string|null, reason: string,
     *   seconds: number, fights: number, players: Array<Object>, totalDamage: number,
     *   partyDps: number|null, ageMs: number|null}} The breakdown; `measured` is false when there
     *   is nothing to draw, and `reason` says which flavour of nothing it is
     */
    breakdown() {
        const ageMs = this.lastTickAt ? Date.now() - this.lastTickAt : null;

        // A trial runs an hour. Anything older describes an event that has ended,
        // and a DPS table under a live trial card that is actually last week's
        // is worse than no table
        const stale = ageMs !== null && ageMs > TRIAL_ACTIVE_MS;
        const summary = summariseTrialDamage({
            tally: this.tally,
            names: this.names,
            deaths: this.deaths,
            seconds: this.seconds,
        });

        return {
            measured: !stale && summary.players.length > 0,
            stale,
            active: this.active,
            encounter: this.encounter,
            reason: this.reason,
            seconds: this.seconds,
            fights: this.fights,
            ageMs,
            // What the last fight's payload called its monsters, and what the
            // gate was looking for. Both are in the export, so a gate that fails
            // closed can be diagnosed from a bug report rather than guessed at
            monsterNames: [...this.monsterNames],
            trialNames: [...this.trialNames],
            // Everything a tick says about a player besides damage, and a note
            // of what it cannot say — see `guild-trial-support.js`
            support: summariseSupport(this.support, this.names),
            supportCoverage: supportCoverage(),
            ...summary,
        };
    }
}

const guildTrialDamage = new GuildTrialDamage();

export default guildTrialDamage;
export { guildTrialDamage };
