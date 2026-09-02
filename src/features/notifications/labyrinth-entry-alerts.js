/**
 * Labyrinth Entry Alerts
 *
 * Says when a Labyrinth entry has regenerated, because entries are the gate on
 * every run and one that regenerates into a full-but-for-it stock is easy to
 * leave sitting — the stock only refills to five, and time spent at the cap is
 * regeneration wasted.
 *
 * ## Two ways it can tell
 *
 * The projection lives in `labyrinth-entry-forecast.js` and is computed from the
 * server's own `labyrinthEntries`, `labyrinthCooldownHours` and
 * `lastLabyrinthTimestamp`. This feature fires on whichever of two things
 * happens first:
 *
 * - the stock rising — the server pushes `character_info_updated` when an entry
 *   regenerates, so the count going up is the surest signal, and it survives a
 *   spell away because the higher count is waiting on the page's next message;
 * - the projected instant passing on an open-but-idle tab, where the count in
 *   memory has not moved yet — the poll notices the deadline crossed and says so
 *   rather than waiting for a push that a quiet tab may not get.
 *
 * ## Re-arming
 *
 * Keyed on the regeneration instant, because one regeneration is one event
 * however it was noticed: the projection names it as the deadline just crossed
 * (`nextEntryAt` now in the past) and the server names the same instant as the
 * new `lastLabyrinthTimestamp` once the count moves, so both signals resolve to
 * the same identity and only the first of them speaks. The stock count is
 * deliberately *not* part of the key — it differs between those two sightings of
 * one event, which is exactly how the same regeneration used to be announced
 * twice. The key is scoped by character id, because the notification service's
 * de-dup map is shared across bundles and outlives a switch: without it, two
 * characters regenerating in the same minute bucket would collide and the second
 * alert would be swallowed as a duplicate.
 *
 * Instants within `SAME_EVENT_TOLERANCE_MS` are the same event, so a server
 * that stamps the regeneration a second or two after the projected deadline
 * cannot split one event in two. Genuine regenerations are a cooldown (hours)
 * apart, so the tolerance can never merge two of them.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { forecastLabyrinthEntries } from './labyrinth-entry-forecast.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_labyrinthEntryAvailable';

/** A minute, against a cooldown measured in days: cheap arithmetic over memory */
export const CHECK_INTERVAL_MS = 60 * 1000;

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'labyrinth-entry';

/**
 * Two regeneration instants this close together are one event.
 *
 * The projected deadline and the server's own stamp for the same regeneration
 * can disagree by the time the server took to process it; a real gap between
 * regenerations is a cooldown, measured in hours.
 */
export const SAME_EVENT_TOLERANCE_MS = 60 * 1000;

/**
 * What the alert says.
 *
 * `entries` on the forecast is the count *as last pushed*, which on the
 * projected trigger is still the pre-regeneration one — the deadline passed but
 * the quiet tab has had no `character_info_updated` yet. Quoting it there would
 * print a number already stale at the moment it is shown, so the caller passes
 * the stock as of the event being announced.
 *
 * @param {Object} forecast - From forecastLabyrinthEntries
 * @param {Object} [options]
 * @param {number} [options.stock=forecast.entries] - Entries in stock as of the event
 * @returns {string}
 */
export function entryMessage(forecast, { stock = forecast.entries } = {}) {
    const held = `${stock}/${forecast.maxEntries}`;
    return stock >= forecast.maxEntries
        ? `Labyrinth entries are full (${held}) — spend one before the next regenerates and is wasted.`
        : `A Labyrinth entry has regenerated (${held} in stock).`;
}

class LabyrinthEntryAlerts {
    constructor() {
        /** The stock last seen, so a rise can be told from a redraw */
        this.lastEntries = null;
        /** The regeneration instant already announced, in ms */
        this.announcedAt = null;
        this.timers = createTimerRegistry();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching the entry stock.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) return;

        const recheck = () => {
            try {
                this.check();
            } catch (error) {
                console.error('[LabyrinthEntryAlerts] Re-checking labyrinth entries failed:', error);
            }
        };
        // Runs after dataManager's own handler, so characterInfo is current.
        webSocketHook.on('character_info_updated', recheck);
        this.unregisterHandlers.push(() => webSocketHook.off('character_info_updated', recheck));

        this.timers.registerInterval(setInterval(() => this.check(), CHECK_INTERVAL_MS));

        this.characterSwitchingHandler = () => this.disable();
        dataManager.on('character_switching', this.characterSwitchingHandler);

        // Seed the baseline without firing, so the first observation is a
        // reference point rather than a spurious "it went up from nothing".
        this.check({ seed: true });
    }

    /**
     * The stock as the server last described it.
     * @param {number} [now=Date.now()] - Clock, injectable for tests
     * @returns {Object} From forecastLabyrinthEntries
     */
    forecast(now = Date.now()) {
        return forecastLabyrinthEntries({ characterInfo: dataManager.characterData?.characterInfo, now });
    }

    /**
     * Decide whether the entry stock is worth speaking about.
     * @param {Object} [options]
     * @param {boolean} [options.seed=false] - Set the baseline without notifying
     * @param {number} [options.now=Date.now()] - Clock, injectable for tests
     * @returns {Object|null} What the service did, for tests
     */
    check({ seed = false, now = Date.now() } = {}) {
        if (!config.getSetting(MASTER_SETTING)) return null;

        const forecast = this.forecast(now);
        if (!forecast.ok) return null;

        const rose = this.lastEntries != null && forecast.entries > this.lastEntries;
        const projectedDue = forecast.available && forecast.entries < forecast.maxEntries;
        this.lastEntries = forecast.entries;

        if (seed) return null;
        if (!rose && !projectedDue) return null;

        // The instant the regeneration happened, named the same way by either
        // signal: a projected deadline already in the past is that instant, and
        // once the server has moved `lastLabyrinthTimestamp` the projection has
        // run on to the *next* deadline and the moved stamp is the instant.
        const due = forecast.nextEntryAt != null && now >= forecast.nextEntryAt;
        const instant = due ? forecast.nextEntryAt : (forecast.lastEntryAt ?? now);
        if (this.announcedAt != null && Math.abs(instant - this.announcedAt) < SAME_EVENT_TOLERANCE_MS) return null;

        // The projection fires before the count has moved, so the entry it is
        // announcing is not in `forecast.entries` yet.
        const stock = rose ? forecast.entries : Math.min(forecast.maxEntries, forecast.entries + 1);
        // Scope the key to the character: the service's de-dup map is shared across
        // bundles and outlives a switch, so two characters regenerating in the same
        // minute bucket would otherwise collide and swallow the second alert.
        const who = dataManager.getCurrentCharacterId?.() || 'unknown';
        const key = `${EVENT_KEY_PREFIX}:${who}:${Math.round(instant / 60_000)}`;
        const result = notificationService.notify(key, entryMessage(forecast, { stock }), {
            title: 'Labyrinth entry ready',
        });
        if (result?.fired) this.announcedAt = instant;
        return result;
    }

    /** Cleanup */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }
        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.timers.clearAll();
        this.lastEntries = null;
        this.announcedAt = null;
    }
}

const labyrinthEntryAlerts = new LabyrinthEntryAlerts();

export default labyrinthEntryAlerts;
export { LabyrinthEntryAlerts };
