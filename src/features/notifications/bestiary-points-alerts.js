/**
 * Bestiary Points Alerts
 *
 * Says so once the character's total Bestiary points reach a chosen target.
 *
 * ## Where the reading comes from
 *
 * The total is `totalBestiaryPoints` over the counts in `monsters_updated`, which the
 * data manager keeps as `getCharacterMonsters()`. The game sends that message only when
 * something asks for the Bestiary (`get_monsters`), as its own Achievements tab does on
 * open, so nothing pushes it after a kill. This module therefore asks for it itself on a
 * slow interval while the alert is on and a target is set; the interval is the worst-case
 * lag between crossing the target and being told.
 *
 * ## The target
 *
 * See `utils/bestiary-target.js`: a per-character record, with a settings default for
 * characters that have none. It is re-read on every check, so a target set from the
 * Bestiary planner (which emits `bestiary_target_changed`) takes effect at once.
 *
 * ## Repeats
 *
 * One armed bit and the target it belongs to. A target this module has not seen before
 * (first look after load, or the player changed it) is armed only if the total is still
 * below it: reaching a target before anyone was listening is old news, and lowering a
 * target below the total is not a crossing. Raising it above the total re-arms. The bit
 * disarms only once the notice was actually delivered, as the savings-goal alert does.
 *
 * ## Character switches
 *
 * The target read is async, so the character id is captured before it and checked after:
 * a switch in between drops the reading rather than comparing one character's target
 * with another's points.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import notificationService from './notification-service.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { countsByMonster, totalBestiaryPoints } from '../../utils/bestiary.js';
import {
    ALERT_SETTING as MASTER_SETTING,
    TARGET_CHANGED_EVENT,
    getBestiaryTarget,
    requestBestiary,
} from '../../utils/bestiary-target.js';
import { formatWithSeparator } from '../../utils/formatters.js';

export { MASTER_SETTING };

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'bestiary-points';

/** How often the Bestiary is re-fetched while a target is being watched */
export const REFRESH_INTERVAL_MS = 2 * 60 * 1000;

class BestiaryPointsAlerts {
    constructor() {
        /** The target the armed bit belongs to, or null before the first reading */
        this.seenTarget = null;
        this.armed = false;
        this.handlers = [];
        this.timers = createTimerRegistry();
        this.isInitialized = false;
    }

    /**
     * Start watching the Bestiary total.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(MASTER_SETTING)) return;
        this.isInitialized = true;

        const on = (event, handler) => {
            dataManager.on(event, handler);
            this.handlers.push(() => dataManager.off(event, handler));
        };
        const run = () => {
            this.check().catch((error) => console.error('[BestiaryPointsAlerts] Check failed:', error));
        };
        on('monsters_updated', run);
        on(TARGET_CHANGED_EVENT, run);
        on('character_switching', () => this.disable());

        this.timers.registerInterval(
            setInterval(() => {
                requestBestiary();
            }, REFRESH_INTERVAL_MS)
        );
        // Counts may already be held from this session; otherwise this fetches them
        run();
        requestBestiary();
    }

    /**
     * Compare the total with the target and announce a crossing.
     * @returns {Promise<void>}
     */
    async check() {
        if (!this.isInitialized || !config.getSetting(MASTER_SETTING)) return;

        const who = dataManager.getCurrentCharacterId?.();
        const target = await getBestiaryTarget();
        // Dropped, not retried: the next monsters_updated for the new character checks again
        if (!this.isInitialized || dataManager.getCurrentCharacterId?.() !== who) return;
        if (target === null) {
            this.seenTarget = null;
            return;
        }

        const rows = dataManager.getCharacterMonsters?.();
        if (!Array.isArray(rows)) return;
        const total = totalBestiaryPoints(countsByMonster(rows));

        if (this.seenTarget !== target) {
            this.seenTarget = target;
            this.armed = total < target;
        }
        if (!this.armed || total < target) return;

        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${target}`,
            `Bestiary: ${formatWithSeparator(total)} points — target ${formatWithSeparator(target)} reached.`,
            { title: 'Bestiary target reached', subject: `${formatWithSeparator(target)} points` }
        );
        if (result?.fired) this.armed = false;
    }

    /**
     * Cleanup
     */
    disable() {
        this.handlers.forEach((off) => off());
        this.handlers = [];
        this.timers.clearAll();
        this.seenTarget = null;
        this.armed = false;
        this.isInitialized = false;
    }
}

const bestiaryPointsAlerts = new BestiaryPointsAlerts();

export default bestiaryPointsAlerts;
