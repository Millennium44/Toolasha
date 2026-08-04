/**
 * Queue Monitor
 * Cross-character queue monitor — shows estimated queue time remaining
 * for other characters by snapshotting queue state on character switch.
 */

import config from '../../core/config.js';
import queueSnapshot from './queue-snapshot.js';
import queueMonitorUI from './queue-monitor-ui.js';
import queueAlerts from './queue-alerts.js';

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

export default {
    name: 'Queue Monitor',

    initialize: () => {
        // Always init snapshot listener (must survive setting toggles)
        queueSnapshot.initialize();

        if (config.getSetting('queueMonitor')) {
            queueMonitorUI.initialize();
        }

        // Independent of the panel: the point of the alert is that you are not
        // looking at the panel, so it is gated on its own setting only
        queueAlerts.initialize();

        unregisterSettingChange = config.onSettingChange('queueMonitor', (enabled) => {
            if (enabled) {
                queueMonitorUI.initialize();
            } else {
                queueMonitorUI.disable();
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
