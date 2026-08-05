/**
 * Task Slot Alerts
 *
 * Says so before the task board fills up, because a task that arrives with no
 * free slot is simply not given — there is no queue behind the board, and the
 * loss is invisible unless you happen to be counting.
 *
 * ## What it is warning about
 *
 * Two instants, a cadence apart. The board is **full** when the last free slot
 * takes a task; the first task is **wasted** one cadence after that. The warning
 * is timed off the first of the two, because that is the deadline for clearing
 * something — being told at the moment the waste starts is being told too late.
 *
 * The projection itself lives in `task-slot-forecast.js`, next to the rest of
 * what Toolasha knows about the task board, and is computed from the server's
 * own `taskSlotCap`, `taskCooldownHours`, `lastTaskTimestamp` and
 * `unreadTaskCount`. Nothing here reads the panel's "Next Task" countdown: that
 * string only exists while the task panel is open, and an alert that needs a
 * panel open cannot warn somebody who is away.
 *
 * ## Why it polls as well as listens
 *
 * Crossing the lead time is the passage of time and not an event, so nothing
 * announces it. The websocket messages that *do* move the projection —
 * `character_info_updated` when a task arrives or the cadence changes,
 * `quests_updated` when one is completed, claimed, rerolled or discarded — are
 * listened to as well, so a freed slot pushes the deadline out immediately
 * rather than at the next tick.
 *
 * ## Re-arming
 *
 * Keyed on the projected fill instant rather than on "already said this". A
 * cleared slot moves the instant, which is a different key, which re-arms the
 * warning by itself and gives the notification service a different event key
 * too. Rounded to the minute so that the same deadline re-derived a few hundred
 * milliseconds later is the same key and not a second alert.
 *
 * The board being full already is a separate, latched message: it is one state
 * rather than one instant, so it is announced once and re-armed by the board
 * having room again. Otherwise a full board would say so afresh every time the
 * server rolled the cooldown forward.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { countActiveTasks, forecastTaskSlots } from '../tasks/task-slot-forecast.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { timeReadable } from '../../utils/formatters.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_taskSlotsFull';

/** How many hours before the board fills to speak up */
export const LEAD_HOURS_SETTING = 'notifications_taskSlotsLeadHours';

/**
 * Bounds the lead time to the range the settings control offers.
 *
 * The upper bound is a whole board's worth of cadence and then some — ten slots
 * at three hours each is thirty — so a lead longer than this is a warning that
 * would fire the moment the board was last emptied, which is not a warning.
 */
export const MIN_LEAD_HOURS = 1;
export const MAX_LEAD_HOURS = 48;
export const DEFAULT_LEAD_HOURS = 8;

/**
 * How often the deadline is re-checked.
 *
 * A minute, against a lead time measured in hours: the check is a handful of
 * arithmetic over data already in memory, and the cost of a coarser poll is a
 * warning that arrives up to that late.
 */
export const CHECK_INTERVAL_MS = 60 * 1000;

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'task-slots';

/** The key used while the board is already full, which is a state and not an instant */
const FULL_KEY = `${EVENT_KEY_PREFIX}:full`;

/**
 * What the warning says.
 *
 * The cadence is in the message because it is what makes the deadline
 * actionable — "two slots left, one task every three hours" tells the player how
 * much clearing buys them, which the bare countdown does not.
 *
 * @param {Object} forecast - From `forecastTaskSlots`
 * @returns {string} The message
 */
export function fillingMessage(forecast) {
    const inTime = timeReadable(Math.round(forecast.msUntilFull / 1000));
    const slots = forecast.freeSlots === 1 ? '1 free slot' : `${forecast.freeSlots} free slots`;
    const cadence = `one task every ${forecast.cooldownHours}h`;
    return `Task slots fill in ${inTime} — ${slots} of ${forecast.slotCap}, ${cadence}. Tasks arriving after that are wasted.`;
}

/**
 * What the already-full message says.
 * @param {Object} forecast - From `forecastTaskSlots`
 * @returns {string} The message
 */
export function fullMessage(forecast) {
    return `All ${forecast.slotCap} task slots are full — tasks arriving from now on are wasted.`;
}

class TaskSlotAlerts {
    constructor() {
        /** The fill instant already announced, so a redraw cannot repeat it */
        this.announcedFillsAt = null;
        /** Whether the "board is full" message has been said for the current full spell */
        this.announcedFull = false;
        this.timers = createTimerRegistry();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching the task board's remaining room.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.registerWebSocketListeners();
        this.timers.registerInterval(setInterval(() => this.check(), CHECK_INTERVAL_MS));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);

        // The board can already be inside the lead window when the page loads,
        // and waiting out a full interval to notice would waste the warning
        this.check();
    }

    /** Listen for the messages that move the deadline */
    registerWebSocketListeners() {
        const recheck = () => {
            try {
                this.check();
            } catch (error) {
                console.error('[TaskSlotAlerts] Re-checking the task board failed:', error);
            }
        };

        // Both handlers run after dataManager's own, which is registered when
        // the core comes up and is what keeps `characterInfo` and
        // `characterQuests` current — so by the time this reads them they
        // already describe the message that woke it
        for (const messageType of ['character_info_updated', 'quests_updated']) {
            webSocketHook.on(messageType, recheck);
            this.unregisterHandlers.push(() => webSocketHook.off(messageType, recheck));
        }
    }

    /**
     * The configured lead time, clamped to what the control can express.
     * @returns {number} Hours before the board fills to notify
     */
    leadHours() {
        const raw = Number(config.getSetting(LEAD_HOURS_SETTING, DEFAULT_LEAD_HOURS));
        if (!Number.isFinite(raw)) return DEFAULT_LEAD_HOURS;
        return Math.min(MAX_LEAD_HOURS, Math.max(MIN_LEAD_HOURS, raw));
    }

    /**
     * The board as the server last described it.
     * @param {number} [now=Date.now()] - Clock, injectable for tests
     * @returns {Object} From `forecastTaskSlots`
     */
    forecast(now = Date.now()) {
        return forecastTaskSlots({
            characterInfo: dataManager.characterData?.characterInfo,
            activeTaskCount: countActiveTasks(dataManager.characterQuests),
            now,
        });
    }

    /**
     * Decide whether the board's remaining room is worth speaking about.
     * @param {number} [now=Date.now()] - Clock, injectable for tests
     * @returns {Object|null} What the service did, for tests
     */
    check(now = Date.now()) {
        if (!config.getSetting(MASTER_SETTING)) return null;

        const forecast = this.forecast(now);
        // No cap, no cadence or no last-task time: the character data has not
        // arrived yet, or this build stopped carrying one of them. Either way a
        // deadline would be invented rather than projected
        if (!forecast.ok) return null;

        if (forecast.isFull) return this._announceFull(forecast);

        // Room again: whatever was said about the board being full is over
        this.announcedFull = false;

        const leadMs = this.leadHours() * 3_600_000;
        // A deadline in the past with slots still free is a stale
        // `lastTaskTimestamp` — the page has been open across a gap in the
        // messages — and is not a warning about anything
        if (!(forecast.msUntilFull > 0) || forecast.msUntilFull > leadMs) return null;

        // To the minute, so the same deadline re-derived on the next tick is the
        // same key rather than a second alert
        const key = `${EVENT_KEY_PREFIX}:${Math.round(forecast.fillsAt / 60_000)}`;
        if (this.announcedFillsAt === key) return null;

        const result = notificationService.notify(key, fillingMessage(forecast), { title: 'Task slots filling up' });

        // Only a delivered alert counts as told; one that reached no channel is
        // left un-announced so the next tick retries it
        if (result?.fired) this.announcedFillsAt = key;
        return result;
    }

    /**
     * "There is no room left", once per full spell.
     * @param {Object} forecast - From `forecastTaskSlots`
     * @returns {Object|null} What the service did
     */
    _announceFull(forecast) {
        if (this.announcedFull) return null;

        const result = notificationService.notify(FULL_KEY, fullMessage(forecast), { title: 'Task slots full' });
        if (result?.fired) this.announcedFull = true;
        return result;
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }

        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.timers.clearAll();
        this.announcedFillsAt = null;
        this.announcedFull = false;
    }
}

const taskSlotAlerts = new TaskSlotAlerts();

export default taskSlotAlerts;
export { TaskSlotAlerts };
