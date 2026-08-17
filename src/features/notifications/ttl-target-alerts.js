/**
 * Time-to-Level Target Alerts
 *
 * Says so when a skill reaches the target level set in the Time to Level tile —
 * the "Stamina 120" a player types into the Combat Level panel so the tile can
 * count down "2d 19h" to it. When the level actually arrives, this announces it
 * once.
 *
 * ## Where the target comes from
 *
 * The Combat Level panel owns the committed selection and answers it through
 * `selectedTarget()` — `{ name, hrid, level, target, ... }`, where `level` is
 * the current level and `target` the one being aimed at. `currentSelection()`
 * says whether the target level was *chosen* (`level` set) rather than left at
 * the panel's implicit "next level": only a chosen target is worth announcing,
 * since a plain level-up is already the Skill Level-Up alert's job.
 *
 * ## Polling, not an event
 *
 * Nothing fires when a current level crosses a target — that crossing is the
 * passage of time. So this re-evaluates on `skills_updated` (the moment a level
 * can actually change) and on a slow interval as a backstop, and asks the panel
 * where things stand each time.
 *
 * ## Re-arming and the seed
 *
 * What is remembered is the target that was announced, per skill: `hrid →
 * target`. A newly chosen target is a different value, which re-arms on its own,
 * and the announced target is baked into the notification service's event key
 * too. On startup the current target is seeded silently if it is already
 * reached — a target the player set and long since passed should not greet them
 * with a stale "you reached it" on every reload.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import notificationService from './notification-service.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { selectedTarget, currentSelection } from '../ui/combat-level-panel.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_ttlTargetReached';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'ttl-target';

/**
 * How often the target is re-checked as a backstop to `skills_updated`.
 *
 * Crossing a target is the passage of time, and while `skills_updated` catches
 * the level actually moving, the interval covers a level that ticked over just
 * before this feature came up. A minute is ample against targets measured in
 * hours or days.
 */
export const CHECK_INTERVAL_MS = 60 * 1000;

class TtlTargetAlerts {
    constructor() {
        /** hrid → the target that has already been announced (or seeded) */
        this.notifiedTarget = new Map();
        this.timers = createTimerRegistry();
        this.skillsUpdatedHandler = null;
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching the Time-to-Level target.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        // A target already reached before this came up is recorded, not
        // announced — reaching it is old news the moment the page loads
        this.check(true);

        this.skillsUpdatedHandler = () => {
            try {
                this.check();
            } catch (error) {
                console.error('[TtlTargetAlerts] Reading a skills update failed:', error);
            }
        };
        dataManager.on('skills_updated', this.skillsUpdatedHandler);

        this.timers.registerInterval(setInterval(() => this.check(), CHECK_INTERVAL_MS));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Announce the committed target if the current level has reached it.
     * @param {boolean} [seedOnly] - Record an already-reached target without announcing
     */
    check(seedOnly = false) {
        if (!config.getSetting(MASTER_SETTING)) return;

        // Only a target the player actually chose — a null level is the panel's
        // implicit "next level", which is a level-up, not a set goal
        if (currentSelection().level == null) return;

        const chosen = selectedTarget();
        if (!chosen || !chosen.hrid) return;

        const target = Number(chosen.target);
        const level = Number(chosen.level);
        if (!Number.isFinite(target) || !Number.isFinite(level)) return;

        if (level < target) return;
        // Keyed on the target, not just the skill: raising the goal is a new
        // value here, which re-arms the alert by itself
        if (this.notifiedTarget.get(chosen.hrid) === target) return;

        if (seedOnly) {
            this.notifiedTarget.set(chosen.hrid, target);
            return;
        }

        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${chosen.hrid}:${target}`,
            `${chosen.name} reached level ${target} — your Time to Level target.`,
            { title: 'Target reached' }
        );

        // Only a delivered alert counts as told, so one that reached no channel
        // is retried on the next tick — the service's own rule
        if (result?.fired) {
            this.notifiedTarget.set(chosen.hrid, target);
        }
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.skillsUpdatedHandler) {
            dataManager.off('skills_updated', this.skillsUpdatedHandler);
            this.skillsUpdatedHandler = null;
        }
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }
        this.timers.clearAll();
        this.notifiedTarget.clear();
    }
}

const ttlTargetAlerts = new TtlTargetAlerts();

export default ttlTargetAlerts;
