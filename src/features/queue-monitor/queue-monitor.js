/**
 * Queue Monitor
 * Cross-character queue monitor — shows estimated queue time remaining
 * for other characters by snapshotting queue state on character switch.
 */

import queueSnapshot from './queue-snapshot.js';
import queueMonitorUI from './queue-monitor-ui.js';

export default {
    name: 'Queue Monitor',

    initialize: () => {
        queueSnapshot.initialize();
        queueMonitorUI.initialize();
    },

    disable: () => {
        queueSnapshot.disable();
        queueMonitorUI.disable();
    },
};
