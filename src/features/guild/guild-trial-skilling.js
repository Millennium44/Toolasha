/**
 * The skilling half of a guild trial, off the socket instead of the screen.
 *
 * Everything the trials panel knows about a skilling trial has been scraped: the
 * pool off a progress bar, the tier off a badge, the player's own success rate
 * off a footer, and whether they are even in it off a sign-up sheet. Each of
 * those is a reading that exists only while the right tab is open, and each has
 * had its own bug.
 *
 * `guild_skilling_updated` states all four outright:
 *
 * ```
 * {trialHrid, tier, currentProgress, currentWorkValue, targetWorkValue,
 *  participantIds[], successRate, efficiency, doubleProgressChance,
 *  progressPerAction, actionTimeMs, actionCounter, timeoutAt}
 * ```
 *
 * - **The pool**, as `currentWorkValue / targetWorkValue`, which is the bar to
 *   the unit. It confirms the derived ladder on arrival: a Crafting trial with
 *   seventeen participants reads a 88,920 target, and `76,000 × (1 + 0.01 × 17)`
 *   is 88,920 exactly.
 * - **The tier**, stated. Every other route to it is a badge that counts what is
 *   *finished* plus an assumption.
 * - **Who is in it**, as `participantIds` — character ids, so "am I in this
 *   trial" is an answer rather than an inference off a sign-up sheet that may
 *   never have been on screen.
 * - **The personal figures** — `successRate`, `efficiency`, `progressPerAction`,
 *   `actionTimeMs` — which are exactly what the DOM footer was being read for,
 *   and which arrive here already attached to the tier they describe.
 *
 * `end_guild_skilling` closes it, and states the tier **banked**: the recording
 * has `tier: 9` arriving while tier 10 was in progress, which is the game
 * confirming the badge semantics this feature reasoned its way to.
 *
 * `new_guild_skilling` is in the game's own type list and produced no events in
 * the capture. It is listened for anyway, read defensively, and expected to
 * mirror `new_guild_battle`.
 *
 * ## What this deliberately does not do
 *
 * **It does not assume it will arrive.** Whether these messages are broadcast to
 * the guild or sent only to a client with the trial on screen is not something
 * the capture can answer — the recorder's view state is unknown. So this is a
 * bonus signal: everything it fills is something the DOM path also fills, the
 * DOM path stays, and a trial that never produces one of these is exactly as
 * well served as before.
 *
 * **It does not write to storage.** It holds the last reading per trial and the
 * trials feature folds it into the record on its own schedule, the same way the
 * spectated combat pool is folded in — so the record has one writer.
 */

import webSocketHook from '../../core/websocket.js';
import { trialFromHrid } from './guild-trials-math.js';

/** Live pool and personal figures for a skilling trial */
export const SKILLING_MESSAGE = 'guild_skilling_updated';

/** The message that opens one — unobserved so far, listened for anyway */
export const NEW_SKILLING_MESSAGE = 'new_guild_skilling';

/** The message that closes one, stating the tier banked */
export const END_SKILLING_MESSAGE = 'end_guild_skilling';

/**
 * How stale a socket reading may be before it stops standing in for the bar.
 *
 * The stream ticks every second or two while a trial runs. Fifteen seconds is
 * long enough to bridge a quiet patch and short enough that a trial that has
 * stopped sending stops feeding the card a pool that is no longer moving.
 */
export const SKILLING_FRESH_MS = 15_000;

/**
 * The per-tier personal figures a payload carries, and nothing else.
 *
 * Pure, and the list is explicit rather than "everything numeric": these four
 * are the ones the panel already reports and the success-decline model already
 * fits. A field the game adds later is picked up when somebody looks at it,
 * which is better than a record full of fields nobody can name.
 *
 * @param {Object} data - A `guild_skilling_updated` payload
 * @returns {Object<string, string>} Label → the value, formatted as the panel writes it
 */
export function personalFromSkilling(data) {
    const personal = {};
    const percent = (value) => (Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : null);

    const success = percent(Number(data?.successRate));
    if (success) personal['Success Rate'] = success;

    const efficiency = percent(Number(data?.efficiency));
    if (efficiency) personal.Efficiency = efficiency;

    const double = percent(Number(data?.doubleProgressChance));
    if (double) personal['Double Progress'] = double;

    const perAction = Number(data?.progressPerAction);
    if (Number.isFinite(perAction) && perAction > 0) personal['Work Power'] = String(perAction);

    const actionMs = Number(data?.actionTimeMs);
    if (Number.isFinite(actionMs) && actionMs > 0) personal['Work Time'] = `${(actionMs / 1000).toFixed(2)}s`;

    return personal;
}

/**
 * What one payload says about a trial, in the shape the record wants.
 *
 * Pure and exported, so the reading is tested without a socket.
 *
 * @param {Object} data - A `guild_skilling_updated` payload
 * @param {number} [at] - When it arrived
 * @returns {Object|null} `{trial, tier, reading, personal, participantIds, at}` or null
 */
export function readSkillingUpdate(data, at = Date.now()) {
    const trial = trialFromHrid(data?.trialHrid);
    if (!trial || trial.kind !== 'skilling') return null;

    const tier = Number(data?.tier);
    const current = Number(data?.currentWorkValue);
    const max = Number(data?.targetWorkValue);
    const reading = Number.isFinite(current) && Number.isFinite(max) && max > 0 ? { current, max } : null;

    const participantIds = (Array.isArray(data?.participantIds) ? data.participantIds : [])
        .map(Number)
        .filter((id) => Number.isFinite(id) && id > 0);

    return {
        trial,
        tier: Number.isFinite(tier) && tier > 0 ? tier : null,
        reading,
        personal: personalFromSkilling(data),
        participantIds,
        actionCounter: Number(data?.actionCounter) || null,
        at,
    };
}

class GuildTrialSkilling {
    constructor() {
        this.initialized = false;
        this.handlers = [];
        this.reset();
    }

    /** Forget every trial and read the next one from scratch */
    reset() {
        /** Trial key (`crafting`) → the last update seen */
        this.updates = {};
        /** Trial key → `{tier, at}` from `end_guild_skilling` */
        this.ended = {};
    }

    initialize() {
        if (this.initialized) return;
        this.initialized = true;

        const on = (type, handler) => {
            const bound = (data) => handler(data);
            webSocketHook.on(type, bound);
            this.handlers.push(() => webSocketHook.off(type, bound));
        };

        on(SKILLING_MESSAGE, (data) => this._onUpdate(data));
        on(NEW_SKILLING_MESSAGE, (data) => this._onUpdate(data));
        on(END_SKILLING_MESSAGE, (data) => this._onEnd(data));
    }

    cleanup() {
        for (const off of this.handlers) off();
        this.handlers = [];
        this.initialized = false;
        this.reset();
    }

    /**
     * A tick of a skilling trial.
     *
     * `new_guild_skilling` is routed here too: nothing has ever been seen of it,
     * and reading it with the same defensive parser means an opening message
     * that turns out to carry a pool is used, and one that does not is ignored.
     *
     * @param {Object} data - A `guild_skilling_updated` or `new_guild_skilling` payload
     */
    _onUpdate(data) {
        try {
            const update = readSkillingUpdate(data);
            if (!update) return;

            // A trial that reports again has not ended, whatever was said before
            delete this.ended[update.trial.key];
            this.updates[update.trial.key] = update;
        } catch (error) {
            console.error('[GuildTrialSkilling] Reading a skilling trial update failed:', error);
        }
    }

    /**
     * A skilling trial has finished, and the game states what it banked.
     * @param {Object} data - An `end_guild_skilling` payload
     */
    _onEnd(data) {
        try {
            const trial = trialFromHrid(data?.trialHrid);
            if (!trial || trial.kind !== 'skilling') return;

            const tier = Number(data?.tier);
            // The tier here counts what is *banked* — the recording has tier 9
            // arriving while tier 10 was in progress
            this.ended[trial.key] = { tier: Number.isFinite(tier) ? tier : null, at: Date.now() };
        } catch (error) {
            console.error('[GuildTrialSkilling] Reading the end of a skilling trial failed:', error);
        }
    }

    /**
     * What the socket last said about a trial, if it is still fresh.
     *
     * @param {string} name - A trial's card name, e.g. `Crafting`
     * @param {number} [now] - Clock
     * @returns {Object|null} The update, or null when there is none or it is stale
     */
    forTrial(name, now = Date.now()) {
        const key = String(name || '')
            .trim()
            .toLowerCase();
        const update = this.updates[key];
        if (!update) return null;

        return now - update.at <= SKILLING_FRESH_MS ? update : null;
    }

    /**
     * Whether a trial has been declared over, and at what tier.
     * @param {string} name - A trial's card name
     * @returns {{tier: number|null, at: number}|null} The ending, or null
     */
    endedFor(name) {
        const key = String(name || '')
            .trim()
            .toLowerCase();
        return this.ended[key] || null;
    }

    /**
     * Whether a character is signed up for a trial, as the game states it.
     *
     * `null` rather than false when no update has arrived: absent is not absent
     * from the trial, and the sign-up sheet remains the answer meanwhile.
     *
     * @param {string} name - A trial's card name
     * @param {number|string|null} characterId - Whose
     * @returns {boolean|null} In it, not in it, or not knowable from here
     */
    participating(name, characterId) {
        const key = String(name || '')
            .trim()
            .toLowerCase();
        const ids = this.updates[key]?.participantIds;
        if (!Array.isArray(ids) || !ids.length) return null;

        const id = Number(characterId);
        return Number.isFinite(id) ? ids.includes(id) : null;
    }

    /** @returns {Object} Everything held, for the export */
    snapshot() {
        return {
            updates: { ...this.updates },
            ended: { ...this.ended },
        };
    }
}

const guildTrialSkilling = new GuildTrialSkilling();

export default guildTrialSkilling;
export { guildTrialSkilling };
