/**
 * Queue Alerts
 *
 * Tells you when one of your *other* characters has stopped.
 *
 * ## What this can and cannot know
 *
 * There is no live feed for a character you are not logged into. What exists is
 * a snapshot, taken by `queue-snapshot.js` at the moment you switch away, which
 * records how many seconds of work were queued. Everything here is a projection
 * from that: the snapshot said four hours, four hours have passed, the character
 * has presumably stopped.
 *
 * That makes the alert honest but not omniscient, and the setting's help text
 * says so rather than implying a live check. Concretely it cannot see: actions
 * queued from another browser, a character that ran out early because an action
 * was slower than estimated, or one that never started. What it *is* reliably
 * right about is the useful case — you queued eight hours on an alt, switched
 * away, and eight hours later nobody told you.
 *
 * ## Why a poll rather than an event
 *
 * The event this wants does not exist. Nothing happens when a queue quietly
 * finishes on a character nobody is watching; the only thing that changes is the
 * wall clock. So the clock is what gets watched, slowly — a minute's resolution
 * on something that was already measured in hours costs nothing.
 */

import config from '../../core/config.js';
import notificationService from '../notifications/notification-service.js';
import { newlyIdleCharacters } from '../notifications/notification-predicates.js';
import queueSnapshot from './queue-snapshot.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** How often to compare the snapshots against the clock */
const CHECK_INTERVAL_MS = 60 * 1000;

class QueueAlerts {
    constructor() {
        /** characterId → the snapshot timestamp already announced for it */
        this.announced = new Map();
        this.timers = createTimerRegistry();
        this.running = false;
    }

    /** Start polling, if the setting is on */
    initialize() {
        if (this.running) return;
        if (!config.getSetting('notifications_otherCharacterIdle')) return;

        this.running = true;
        this.timers.registerInterval(setInterval(() => this.check(), CHECK_INTERVAL_MS));

        // Once immediately: an alt that ran out while the page was closed is
        // exactly the thing worth being told about on the way back in
        this.check();
    }

    /**
     * Compare every other character's snapshot against the clock.
     * @returns {Array<Object>} The characters announced this pass
     */
    check() {
        if (!config.getSetting('notifications_otherCharacterIdle')) return [];

        try {
            const idle = newlyIdleCharacters(queueSnapshot.getOtherCharacterSnapshots(), Date.now(), this.announced);

            for (const character of idle) {
                this.announced.set(character.characterId, character.timestamp);
                notificationService.notify(
                    `character-idle:${character.characterId}`,
                    `${character.characterName} has probably run out of queued actions.`
                );
            }
            return idle;
        } catch (error) {
            console.error('[QueueAlerts] Failed to check snapshots:', error);
            return [];
        }
    }

    disable() {
        this.timers.clearAll();
        this.announced.clear();
        this.running = false;
    }
}

const queueAlerts = new QueueAlerts();
export default queueAlerts;
