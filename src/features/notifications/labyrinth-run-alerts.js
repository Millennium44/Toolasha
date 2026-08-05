/**
 * Labyrinth Run Finished Alerts
 *
 * Says so when a labyrinth run stops being a labyrinth run — which is the one
 * moment a lab run has that nothing in the game announces, and the moment you
 * are least likely to be looking, because a run you are watching is a run you
 * are steering.
 *
 * ## What "finished" means here
 *
 * Both endings, deliberately. A run that walked out of its last cleared floor
 * and a run that ended on a lost fight are the same event to somebody who is
 * not at the screen: the labyrinth is no longer running, and whatever was
 * queued behind it is what the character is doing now. Exiting on purpose
 * counts too.
 *
 * ## Why the text does not say *which*
 *
 * Because the server does not. `labyrinth_updated` carries `isActive`, the
 * floor, the grid, the queued path and the run's `startedAt`; nothing on it
 * distinguishes a run that ended well from one that ended badly — there is no
 * outcome, result or reason field anywhere in the payload this codebase has
 * ever read. The floor reached *is* the score of a lab run, so that is what
 * gets reported, and the alert says the run ended rather than guessing at how.
 * Inventing "you died" from the absence of evidence would be the kind of
 * confident wrong that makes a notification worth turning off.
 *
 * ## Why the transition and not the state
 *
 * `isActive: false` is the resting state of a character who is not in the
 * labyrinth, so it is true far more often than it is news, and the server
 * re-sends labyrinth messages for a while after a run ends. Only a run that was
 * *seen active* and is now not counts, and each run announces once — keyed on
 * the run's own `startedAt`, so a stale "still active" message arriving after
 * the end cannot re-arm the alert for a run that already fired.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import notificationService from './notification-service.js';
import { labyrinthRunState } from './notification-predicates.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_labyrinthRunFinished';

/** Prefix for the notification service's event keys */
const EVENT_KEY_PREFIX = 'labyrinth-run-finished';

class LabyrinthRunAlerts {
    constructor() {
        /** What the last usable payload said: 'active', 'ended' or 'unknown' */
        this.state = 'unknown';
        /** The run currently believed to be going: { key, floor } */
        this.run = null;
        /** Run keys already announced, so a stale message cannot repeat one */
        this.announced = new Set();
        /** Stands in for `startedAt` on a payload that omits it */
        this.runSeq = 0;
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
    }

    /**
     * Start watching for the end of a labyrinth run.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        this.seedFromCharacterData();
        this.registerWebSocketListeners();

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);
    }

    /**
     * Adopt the run the character is already in, if there is one.
     *
     * Features initialize after the character is up, so a run that was already
     * going when the page loaded would otherwise never be seen as active — and
     * a run that was never seen active can never be seen to finish.
     */
    seedFromCharacterData() {
        try {
            this.observe(dataManager.characterData?.characterLabyrinth);
        } catch (error) {
            console.error('[LabyrinthRunAlerts] Reading the character’s labyrinth failed:', error);
        }
    }

    /** Listen for the message that carries the run's state */
    registerWebSocketListeners() {
        const update = (data) => {
            try {
                this.observe(data?.labyrinth);
            } catch (error) {
                console.error('[LabyrinthRunAlerts] Handling a labyrinth update failed:', error);
            }
        };

        webSocketHook.on('labyrinth_updated', update);
        this.unregisterHandlers.push(() => webSocketHook.off('labyrinth_updated', update));
    }

    /**
     * Fold one sighting of the run into what is known, and announce an ending.
     * @param {Object|null} labyrinth - A payload's `labyrinth`, or the character's
     */
    observe(labyrinth) {
        if (!config.getSetting(MASTER_SETTING)) return;

        const state = labyrinthRunState(labyrinth);
        // A payload that says nothing about the run leaves everything standing:
        // it is not evidence the run ended, and treating it as such is the one
        // way this feature could lie
        if (state === 'unknown') return;

        if (state === 'active') {
            this.rememberRun(labyrinth);
            this.state = 'active';
            return;
        }

        const wasActive = this.state === 'active';
        this.state = 'ended';
        if (!wasActive) return;

        const run = this.run;
        this.run = null;
        if (!run || this.announced.has(run.key)) return;

        const floor = run.floor;
        const where = floor > 0 ? ` Floor ${floor} was as far as it got.` : '';
        const result = notificationService.notify(
            `${EVENT_KEY_PREFIX}:${run.key}`,
            `Your labyrinth run has finished.${where}`,
            { title: 'Labyrinth run finished' }
        );

        // Only a delivered alert counts as told; one that reached no channel is
        // left un-announced so a later sighting of the same ending can retry
        if (result?.fired) this.announced.add(run.key);
    }

    /**
     * Note which run is going, and how deep it has got.
     *
     * The floor is taken from every active sighting rather than only the first,
     * because the run that matters at the end is the run at its deepest — and
     * the message that reports the ending carries no grid to read it from.
     *
     * @param {Object} labyrinth - An active run's payload
     */
    rememberRun(labyrinth) {
        const startedAt = labyrinth?.startedAt ? String(labyrinth.startedAt) : '';
        const floor = Math.max(0, Math.floor(Number(labyrinth?.currentFloor) || 0));

        if (this.run && (startedAt === '' || this.run.key === startedAt)) {
            this.run.floor = Math.max(this.run.floor, floor);
            return;
        }

        // A run with no `startedAt` still needs an identity of its own, or two
        // runs in one session would share a key and the second would be counted
        // as already announced
        const key = startedAt || `run:${++this.runSeq}`;
        this.run = { key, floor };
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
        this.state = 'unknown';
        this.run = null;
        this.announced.clear();
        this.runSeq = 0;
    }
}

const labyrinthRunAlerts = new LabyrinthRunAlerts();

export default labyrinthRunAlerts;
