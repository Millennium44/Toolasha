/**
 * Combat Statistics Feature
 * Main entry point for combat statistics tracking and display
 */

import combatStatsDataCollector from './combat-stats-data-collector.js';
import combatStatsUI from './combat-stats-ui.js';
// Imported for its side effect: the module registers this feature's overlay rows
// at module scope, so they exist whether or not the feature has started
import './combat-stats-rows.js';

/**
 * Initialize combat statistics feature
 */
async function initialize() {
    // Initialize data collector (WebSocket listener + load persisted state)
    await combatStatsDataCollector.initialize();

    // Initialize UI (button injection and popup)
    combatStatsUI.initialize();
}

/**
 * Cleanup combat statistics feature
 */
function cleanup() {
    combatStatsDataCollector.cleanup();
    combatStatsUI.cleanup();
}

export default {
    name: 'Combat Statistics',
    initialize,
    cleanup,
};
