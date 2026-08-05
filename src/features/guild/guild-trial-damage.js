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
import { COMBAT_ENCOUNTERS, TRIAL_ACTIVE_MS } from './guild-trials-math.js';

/** Below this the per-player rates are one exchange's luck rather than a rate */
export const MIN_SECONDS = 5;

/** A tick further from the last than this is a break, not a slow swing */
const MAX_TICK_GAP_MS = 2000;

/**
 * Which of the five encounters a name is, if any.
 * @param {string} name - A monster or trial card name
 * @returns {string|null} The encounter, lowercased, or null
 */
export function encounterOf(name) {
    const lowered = String(name || '').toLowerCase();
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

    return { isTrial: false, encounter: null, reason: 'the monsters are not this week’s trial encounter' };
}

/**
 * Every monster name in a `new_battle`, however the payload spells them.
 * @param {Object} data - `new_battle` payload
 * @returns {string[]} Names, in payload order
 */
export function battleMonsterNames(data) {
    const names = [];
    for (const monster of Object.values(data?.monsters || {})) {
        if (monster?.name) {
            names.push(monster.name);
            continue;
        }

        const hrid = monster?.combatMonsterHrid || monster?.monsterHrid || monster?.hrid;
        if (!hrid) continue;

        const detail = dataManager.getInitClientData?.()?.combatMonsterDetailMap?.[hrid];
        names.push(detail?.name || String(hrid).split('/').pop().replace(/_/g, ' '));
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
    }

    /**
     * Tell it which trials are running this week.
     *
     * Pushed in rather than read out of the trials record directly, so this
     * module does not import the feature that draws it — the dependency runs one
     * way and a cycle cannot form.
     *
     * @param {string[]} names - Combat trial card names, e.g. `['Trial Chameleon']`
     */
    setTrialNames(names) {
        this.trialNames = Array.isArray(names) ? names.filter(Boolean) : [];
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
            const verdict = isTrialBattle({
                monsterNames: battleMonsterNames(data),
                trialNames: this.trialNames,
            });

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
            ...summary,
        };
    }
}

const guildTrialDamage = new GuildTrialDamage();

export default guildTrialDamage;
export { guildTrialDamage };
