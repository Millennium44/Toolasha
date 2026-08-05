/**
 * Guild trial alerts
 *
 * Two moments in a trial week are worth interrupting somebody for, and both of
 * them are moments the player cannot see coming from inside the game: a trial
 * they signed up for is about to start, and the one they were in has finished
 * and paid out.
 *
 * ## Where the times come from
 *
 * Not from a socket message — there isn't one. The guild panel states the cycle
 * in words at the top of its trial tabs ("Scheduled Wed 04:00 PM 2h 24m",
 * "Completed Thu 09:00 AM"), and `guild-trials-scrape.js` reads it. So this
 * module is *pushed to* by the trials feature rather than watching anything
 * itself, which keeps the dependency running one way — a notifications module
 * that imported the guild feature would be a cycle, and the guild feature
 * already imports this one.
 *
 * That has a consequence worth stating plainly: **the countdown only advances
 * while the guild panel is open**, because that is the only time anything reads
 * it. A player who never opens the panel gets no starting alert. The panel is
 * usually open in the run-up to a trial the player has signed up for, which is
 * exactly the case this is for, and an alert that fires late is better than a
 * fabricated schedule that fires wrongly.
 *
 * ## Re-arming
 *
 * Keyed by the phase transition rather than by a timestamp: the same cycle
 * cannot announce its own start twice, and the next cycle is a different
 * transition. The service's own cooldown catches anything this misses.
 */

import config from '../../core/config.js';
import notificationService from './notification-service.js';
import { timeReadable } from '../../utils/formatters.js';

/** Master switch for the "a trial is about to start" alert */
export const START_SETTING = 'notifications_trialStarting';

/** Master switch for the "the trial finished" alert */
export const RESULTS_SETTING = 'notifications_trialResults';

/** How many minutes before the start to speak up */
export const LEAD_MINUTES_SETTING = 'notifications_trialStartLeadMinutes';

/** Bounds the lead time to the range the settings control offers */
export const MIN_LEAD_MINUTES = 1;
export const MAX_LEAD_MINUTES = 120;
export const DEFAULT_LEAD_MINUTES = 10;

/** Event key prefixes, so the service's cooldown can tell the two apart */
const START_KEY = 'guild-trial-start';
const RESULTS_KEY = 'guild-trial-results';

/**
 * The lead time, clamped to what the setting offers.
 * @param {Function} [read] - Settings reader, injectable for tests
 * @returns {number} Minutes
 */
export function leadMinutes(read) {
    const get = read || ((key, fallback) => config.getSettingValue?.(key, fallback) ?? fallback);
    const value = Number(get(LEAD_MINUTES_SETTING, DEFAULT_LEAD_MINUTES));
    if (!Number.isFinite(value)) return DEFAULT_LEAD_MINUTES;
    return Math.min(MAX_LEAD_MINUTES, Math.max(MIN_LEAD_MINUTES, value));
}

/**
 * What the results alert says.
 *
 * Built from the payout the panel has already worked out rather than from a
 * second calculation, so the number in the notification is the number on the
 * screen. Tokens are included because they are the part a player acts on — the
 * points are the guild's, the tokens are theirs.
 *
 * @param {Object} payout - `{guildPoints, eligibleTokens, participantTokens}`
 * @returns {string} The message
 */
export function resultsMessage(payout) {
    const round = (value) => (Number.isFinite(value) ? Math.round(value).toLocaleString('en-US') : null);
    const points = round(payout?.guildPoints);
    const eligible = round(payout?.eligibleTokens);
    const participant = round(payout?.participantTokens);

    const parts = [];
    if (points) parts.push(`${points} Guild Points`);
    if (eligible) parts.push(`${eligible} tokens for every eligible member`);
    if (participant && participant !== eligible) parts.push(`${participant} if you took part`);

    if (!parts.length) return 'The guild trial has finished.';
    return `Guild trial finished — ${parts.join(', ')}.`;
}

class GuildTrialAlerts {
    constructor() {
        /** The phase last seen, so a transition can be told from a redraw */
        this.phase = null;
        /** The phase this announced a start for, so it announces it once */
        this.announcedStartFor = null;
        /** Trials named in the cycle now scheduled or running */
        this.trials = [];
        /** The payout at the last live reading, for the results alert */
        this.lastPayout = null;
    }

    /** Forget everything; used on a character switch and by tests */
    reset() {
        this.phase = null;
        this.announcedStartFor = null;
        this.trials = [];
        this.lastPayout = null;
    }

    /**
     * The payout as the panel currently computes it.
     *
     * Kept as it goes past, because by the time the cycle reads "Completed" the
     * cards have been zeroed and the figure is gone — the results alert would
     * have nothing to report if it waited until then to ask.
     *
     * @param {Object} payout - `{guildPoints, eligibleTokens, participantTokens}`
     */
    notePayout(payout) {
        if (!payout) return;
        if (Number.isFinite(payout.guildPoints) && payout.guildPoints > 0) this.lastPayout = { ...payout };
    }

    /**
     * Where the cycle is, from the guild panel.
     *
     * @param {Object} status - `{phase, startsInMs, trials, at}`
     * @returns {Object|null} What was announced, for tests
     */
    noteTrialStatus({ phase = null, startsInMs = null, trials = [], at = Date.now() } = {}) {
        try {
            if (Array.isArray(trials) && trials.length) this.trials = trials;

            const previous = this.phase;
            if (phase) this.phase = phase;

            if (phase === 'scheduled') return this._maybeAnnounceStart(startsInMs, at);
            if (phase === 'live' && previous === 'scheduled') return this._announceStarted();
            if (phase === 'completed' && previous && previous !== 'completed') return this._announceResults();
            return null;
        } catch (error) {
            console.error('[GuildTrialAlerts] Reading the trial status failed:', error);
            return null;
        }
    }

    /**
     * "It starts soon", once the countdown is inside the lead time.
     * @param {number|null} startsInMs - From the panel's own countdown
     * @param {number} at - Clock
     * @returns {Object|null} The service's result
     */
    _maybeAnnounceStart(startsInMs, at) {
        if (!config.getSetting(START_SETTING, false)) return null;
        if (!Number.isFinite(startsInMs) || startsInMs <= 0) return null;

        const lead = leadMinutes() * 60_000;
        if (startsInMs > lead) return null;

        // One announcement per scheduled cycle. The countdown is re-read every
        // few seconds while the panel is open and would otherwise re-fire on
        // every one of them until the service's cooldown caught it
        const key = `${START_KEY}:${Math.round((at + startsInMs) / 60_000)}`;
        if (this.announcedStartFor === key) return null;
        this.announcedStartFor = key;

        const named = this.trials.length ? ` (${this.trials.join(', ')})` : '';
        return notificationService.notify(key, `Guild trial starts in ${timeReadable(startsInMs)}${named}.`, {
            title: 'Guild trial starting',
        });
    }

    /**
     * "It has started", the moment the panel stops saying scheduled.
     * @returns {Object|null} The service's result
     */
    _announceStarted() {
        if (!config.getSetting(START_SETTING, false)) return null;

        const named = this.trials.length ? ` — ${this.trials.join(', ')}` : '';
        return notificationService.notify(`${START_KEY}:live`, `The guild trial has started${named}.`, {
            title: 'Guild trial started',
        });
    }

    /**
     * "It finished, and here is what it paid".
     * @returns {Object|null} The service's result
     */
    _announceResults() {
        if (!config.getSetting(RESULTS_SETTING, false)) return null;

        const result = notificationService.notify(
            `${RESULTS_KEY}:${this.lastPayout?.guildPoints ?? 0}`,
            resultsMessage(this.lastPayout),
            {
                title: 'Guild trial finished',
            }
        );
        this.announcedStartFor = null;
        return result;
    }
}

const guildTrialAlerts = new GuildTrialAlerts();

export default guildTrialAlerts;
export { guildTrialAlerts };
