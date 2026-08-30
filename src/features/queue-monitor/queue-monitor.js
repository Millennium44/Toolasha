/**
 * Queue Monitor
 * Cross-character queue monitor — shows estimated queue time remaining
 * for other characters by snapshotting queue state on character switch.
 */

import config from '../../core/config.js';
import queueSnapshot from './queue-snapshot.js';
import queueMonitorUI from './queue-monitor-ui.js';
import queueAlerts from './queue-alerts.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

let unregisterSettingChange = null;

/**
 * Kept at module scope so `disable` can hand the exact reference back.
 *
 * `onSettingChange` returns nothing, so the only way to unregister is
 * `offSettingChange` with the same function — and features are re-initialized on
 * every character switch, so a callback that is never removed is registered
 * again each time.
 */
let idleSettingHandler = null;

/** The palette entry's name, in one place so registering and withdrawing agree */
const QUEUE_COMMAND = 'Queue Monitor';

/**
 * Offer the panel in the command palette, for as long as it is switched on.
 *
 * Registered beside every call that brings the panel up rather than once in
 * `initialize`, because the panel has its own setting listener and can come
 * back mid-session without the feature being re-initialised.
 */
function registerQueueCommand() {
    registerCommand({
        name: QUEUE_COMMAND,
        hint: "Other characters' queues, and how long they have left",
        run: () => queueMonitorUI.toggle(),
    });
}

export default {
    name: 'Queue Monitor',

    initialize: () => {
        // Always init snapshot listener (must survive setting toggles)
        queueSnapshot.initialize();

        if (config.getSetting('queueMonitor')) {
            queueMonitorUI.initialize();
            registerQueueCommand();
        }

        // Independent of the panel: the point of the alert is that you are not
        // looking at the panel, so it is gated on its own setting only
        queueAlerts.initialize();

        unregisterSettingChange = config.onSettingChange('queueMonitor', (enabled) => {
            if (enabled) {
                queueMonitorUI.initialize();
                registerQueueCommand();
            } else {
                queueMonitorUI.disable();
                unregisterCommand(QUEUE_COMMAND);
            }
        });

        if (!idleSettingHandler) {
            idleSettingHandler = (enabled) => {
                if (enabled) {
                    queueAlerts.initialize();
                } else {
                    queueAlerts.disable();
                }
            };
            config.onSettingChange('notifications_otherCharacterIdle', idleSettingHandler);
        }
    },

    disable: () => {
        unregisterCommand(QUEUE_COMMAND);
        queueSnapshot.disable();
        queueMonitorUI.disable();
        queueAlerts.disable();

        if (unregisterSettingChange) {
            unregisterSettingChange();
            unregisterSettingChange = null;
        }

        if (idleSettingHandler) {
            config.offSettingChange('notifications_otherCharacterIdle', idleSettingHandler);
            idleSettingHandler = null;
        }
    },
};
