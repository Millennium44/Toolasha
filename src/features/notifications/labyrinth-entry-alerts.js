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
 * Keyed on the regeneration instant (rounded to the minute), so the same
 * deadline re-derived a few hundred milliseconds later is one alert, and the
 * next regeneration — a cooldown later, a different instant — re-arms by itself.
 * Spending an entry moves `lastLabyrinthTimestamp`, which moves the instant.
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
 * What the alert says.
 * @param {Object} forecast - From forecastLabyrinthEntries
 * @returns {string}
 */
export function entryMessage(forecast) {
    const stock = `${forecast.entries}/${forecast.maxEntries}`;
    return forecast.entries >= forecast.maxEntries
        ? `Labyrinth entries are full (${stock}) — spend one before the next regenerates and is wasted.`
        : `A Labyrinth entry has regenerated (${stock} in stock).`;
}

class LabyrinthEntryAlerts {
    constructor() {
        /** The stock last seen, so a rise can be told from a redraw */
        this.lastEntries = null;
        /** The regeneration instant already announced */
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

        // Keyed on the regeneration instant so a redraw does not repeat it. When
        // the count rose without a projected instant (already at cap, or a stale
        // timestamp), the stock count keys it instead.
        const instant = forecast.nextEntryAt ?? forecast.lastEntryAt ?? now;
        const key = `${EVENT_KEY_PREFIX}:${Math.round(instant / 60_000)}:${forecast.entries}`;
        if (this.announcedAt === key) return null;

        const result = notificationService.notify(key, entryMessage(forecast), { title: 'Labyrinth entry ready' });
        if (result?.fired) this.announcedAt = key;
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
