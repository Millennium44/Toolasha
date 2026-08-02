/**
 * Foundation Utils Library
 * All utility modules
 *
 * Exports to: window.Toolasha.Utils
 */

// All utils
import * as formatters from '../utils/formatters.js';
import * as efficiency from '../utils/efficiency.js';
import * as profitHelpers from '../utils/profit-helpers.js';
import * as profitConstants from '../utils/profit-constants.js';
import * as dom from '../utils/dom.js';
import * as domObserverHelpers from '../utils/dom-observer-helpers.js';
import * as timerRegistry from '../utils/timer-registry.js';
import * as bonusRevenueCalculator from '../utils/bonus-revenue-calculator.js';
import * as enhancementMultipliers from '../utils/enhancement-multipliers.js';
import * as experienceParser from '../utils/experience-parser.js';
import * as marketListings from '../utils/market-listings.js';
import * as actionCalculator from '../utils/action-calculator.js';
import * as actionPanelHelper from '../utils/action-panel-helper.js';
import * as teaParser from '../utils/tea-parser.js';
import * as buffParser from '../utils/buff-parser.js';
import * as selectors from '../utils/selectors.js';
import * as houseEfficiency from '../utils/house-efficiency.js';
import * as experienceCalculator from '../utils/experience-calculator.js';
import * as marketData from '../utils/market-data.js';
import * as abilityCalc from '../utils/ability-cost-calculator.js';
import * as equipmentParser from '../utils/equipment-parser.js';
import * as uiComponents from '../utils/ui-components.js';
import * as enhancementConfig from '../utils/enhancement-config.js';
import * as enhancementGearDetector from '../utils/enhancement-gear-detector.js';
import * as reactInput from '../utils/react-input.js';
import * as materialCalculator from '../utils/material-calculator.js';
import * as tokenValuation from '../utils/token-valuation.js';
import * as pricingHelper from '../utils/pricing-helper.js';
import * as cleanupRegistry from '../utils/cleanup-registry.js';
import * as houseCostCalculator from '../utils/house-cost-calculator.js';
import * as enhancementCalculator from '../utils/enhancement-calculator.js';
import * as overlayRows from '../utils/overlay-rows.js';
import * as overlayLayout from '../utils/overlay-layout.js';
import * as overlayFormat from '../utils/overlay-format.js';
import * as orderBook from '../utils/order-book.js';
import * as combatLevel from '../utils/combat-level.js';
import * as opanelConfig from '../utils/opanel-config.js';
import * as skillProgress from '../utils/skill-progress.js';
import * as abilityBooks from '../utils/ability-books.js';
import * as damageAttribution from '../utils/damage-attribution.js';
import * as panelGeometry from '../utils/panel-geometry.js';
import * as choiceDialog from '../utils/choice-dialog.js';
import * as dropLuck from '../utils/drop-luck.js';
import * as complexFft from '../utils/complex-fft.js';
import * as combatDropModel from '../utils/combat-drop-model.js';
import * as spawnExpectation from '../utils/spawn-expectation.js';
import * as chestTally from '../utils/chest-tally.js';
import * as floatingPanel from '../utils/floating-panel.js';
import * as workerPool from '../utils/worker-pool.js';
import * as evWorkerManager from '../utils/ev-worker-manager.js';
import * as enhancementWorkerManager from '../utils/enhancement-worker-manager.js';
import * as networthWorkerManager from '../utils/networth-worker-manager.js';
import * as panelZIndex from '../utils/panel-z-index.js';
import * as performanceMonitor from '../utils/performance-monitor.js';
import * as gameLookups from '../utils/game-lookups.js';
import * as itemNavigation from '../utils/item-navigation.js';
import * as marketplaceTabs from '../utils/marketplace-tabs.js';
import * as marketplaceAutofill from '../utils/marketplace-autofill.js';
import * as scrollBuffValues from '../utils/scroll-buff-values.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Utils = {
    formatters,
    efficiency,
    profitHelpers,
    profitConstants,
    dom,
    domObserverHelpers,
    timerRegistry,
    bonusRevenueCalculator,
    enhancementMultipliers,
    experienceParser,
    marketListings,
    actionCalculator,
    actionPanelHelper,
    teaParser,
    buffParser,
    selectors,
    houseEfficiency,
    experienceCalculator,
    marketData,
    abilityCalc,
    equipmentParser,
    uiComponents,
    enhancementConfig,
    enhancementGearDetector,
    reactInput,
    materialCalculator,
    tokenValuation,
    pricingHelper,
    cleanupRegistry,
    houseCostCalculator,
    enhancementCalculator,
    overlayRows,
    overlayLayout,
    overlayFormat,
    orderBook,
    combatLevel,
    opanelConfig,
    skillProgress,
    abilityBooks,
    damageAttribution,
    panelGeometry,
    choiceDialog,
    dropLuck,
    complexFft,
    combatDropModel,
    spawnExpectation,
    chestTally,
    floatingPanel,
    workerPool,
    evWorkerManager,
    enhancementWorkerManager,
    networthWorkerManager,
    panelZIndex,
    performanceMonitor,
    gameLookups,
    itemNavigation,
    marketplaceTabs,
    marketplaceAutofill,
    scrollBuffValues,
};

console.log('[Toolasha] Utils library loaded');
