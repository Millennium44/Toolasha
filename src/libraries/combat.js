/**
 * Combat Library
 * Combat, abilities, and combat stats features
 *
 * Exports to: window.Toolasha.Combat
 */

// Combat features
import zoneIndices from '../features/combat/zone-indices.js';
import loadoutEnhancementDisplay from '../features/combat/loadout-enhancement-display.js';
import loadoutSnapshot from '../features/combat/loadout-snapshot.js';
import scrollSimulator from '../features/combat/scroll-simulator.js';
import scrollSimulatorUI from '../features/combat/scroll-simulator-ui.js';
import dungeonTracker from '../features/combat/dungeon-tracker.js';
import dungeonTrackerUI from '../features/combat/dungeon-tracker-ui.js';
import dungeonTrackerChatAnnotations from '../features/combat/dungeon-tracker-chat-annotations.js';
import combatSummary from '../features/combat/combat-summary.js';
import combatBattleCounter from '../features/combat/combat-battle-counter.js';
import combatDropLuck from '../features/combat/combat-drop-luck.js';
import labyrinthTracker from '../features/combat/labyrinth-tracker.js';
import labyrinthBestLevel from '../features/combat/labyrinth-best-level.js';
import labyrinthShopPrices from '../features/combat/labyrinth-shop-prices.js';
import labyrinthClearRate from '../features/combat/labyrinth-clear-rate.js';
import labyrinthRoomLogs from '../features/combat/labyrinth-room-logs.js';
import labyrinthCapture from '../features/combat/labyrinth-capture.js';
import * as combatSimIntegration from '../features/combat/combat-sim-integration.js';
import { constructExportObject } from '../features/combat/combat-sim-export.js';
import { constructMilkonomyExport } from '../features/combat/milkonomy-export.js';
import combatSim from '../features/combat-sim/combat-sim.js';
import labSim from '../features/combat-sim/lab-sim.js';

// Combat stats
import combatStats from '../features/combat-stats/combat-stats.js';

// Abilities
import abilityBookCalculator from '../features/abilities/ability-book-calculator.js';
import abilityDictionaryButton from '../features/abilities/ability-dictionary-button.js';

// Profile (combat score)
import combatScore from '../features/profile/combat-score.js';
import characterCardButton from '../features/profile/character-card-button.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Combat = {
    zoneIndices,
    loadoutEnhancementDisplay,
    loadoutSnapshot,
    scrollSimulator,
    scrollSimulatorUI,
    dungeonTracker,
    dungeonTrackerUI,
    dungeonTrackerChatAnnotations,
    combatSummary,
    combatBattleCounter,
    combatDropLuck,
    labyrinthTracker,
    labyrinthBestLevel,
    labyrinthShopPrices,
    labyrinthClearRate,
    labyrinthRoomLogs,
    labyrinthCapture,
    combatSimIntegration,
    combatSimExport: {
        constructExportObject,
        constructMilkonomyExport,
    },
    combatStats,
    abilityBookCalculator,
    abilityDictionaryButton,
    combatScore,
    characterCardButton,
    combatSim,
    labSim,
};

// Console-driven debug tools, kept out of the feature namespaces because
// nothing registers or schedules them — they only run when typed
toolashaRoot.Debug = {
    ...(toolashaRoot.Debug || {}),
    ...labyrinthCapture,
    labAccuracy: () => labyrinthClearRate.labAccuracy(),
    labRooms: () => labyrinthClearRate.labRooms(),
};

console.log('[Toolasha] Combat library loaded');
