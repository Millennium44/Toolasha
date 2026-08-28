/**
 * Character Activity Status
 *
 * The character-scoped half of the feature: watch the active character's queue and offline
 * state, and persist a projection of it. The character-select half is always-on and wired
 * separately in the entrypoint (see `character-select-renderer.js`), because character select
 * can be the very first screen shown, before any character has ever been initialized.
 *
 * The collector runs whether or not the display setting is on. Turning the setting off should
 * hide the status, not throw away the history that makes it useful the moment it is turned back
 * on — the renderer honours the setting instead.
 */

import characterActivityCollector from './character-activity-collector.js';

export default {
    name: 'Character Activity Status',

    initialize: async () => {
        await characterActivityCollector.initialize();
    },

    cleanup: () => {
        characterActivityCollector.cleanup();
    },
};
