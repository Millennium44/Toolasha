/**
 * Cross-device sync feature.
 *
 * The manager is self-starting: `initialize()` wires the setting listeners and
 * then decides whether to schedule anything, so this can be registered
 * unconditionally and turning sync on later takes effect without a reload.
 */

import syncManager from './sync-manager.js';

export default {
    name: 'Cross-Device Sync',
    initialize: async () => {
        await syncManager.initialize();
    },
    cleanup: () => {
        syncManager.cleanup();
    },
};

export { syncManager };
