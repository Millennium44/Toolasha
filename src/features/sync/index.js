/**
 * Cross-device sync feature.
 *
 * The manager is self-starting: `initialize()` wires the setting listeners and
 * then decides whether to schedule anything, so this can be registered
 * unconditionally and turning sync on later takes effect without a reload.
 */

import syncManager from './sync-manager.js';
import { showSharedSettingsNotice } from './shared-settings-notice.js';

export default {
    name: 'Cross-Device Sync',
    initialize: async () => {
        await syncManager.initialize();
        // Only ever says anything when the one-time carry-over of the sync
        // settings to account-wide storage had to choose between characters
        await showSharedSettingsNotice();
    },
    cleanup: () => {
        syncManager.cleanup();
    },
};

export { syncManager };
