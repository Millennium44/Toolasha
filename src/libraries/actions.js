/**
 * Actions Library
 * Production, gathering, and alchemy features
 *
 * Exports to: window.Toolasha.Actions
 */

// Action features
import { initActionPanelObserver } from '../features/actions/panel-observer.js';
import actionTimeDisplay from '../features/actions/action-time-display.js';
import actionCountdown from '../features/actions/action-countdown.js';
import quickInputButtons from '../features/actions/quick-input-buttons.js';
import outputTotals from '../features/actions/output-totals.js';
import maxProduceable from '../features/actions/max-produceable.js';
import gatheringStats from '../features/actions/gathering-stats.js';
import requiredMaterials from '../features/actions/required-materials.js';
import missingMaterialsButton from '../features/actions/missing-materials-button.js';
import budgetCalculator from '../features/actions/budget-calculator.js';
import costSummary from '../features/actions/cost-summary.js';
import actionPanelLayout from '../features/actions/action-panel-layout.js';
import craftingPlan from '../features/crafting-plan/index.js';
import * as craftingPlanCalculator from '../features/crafting-plan/crafting-plan-calculator.js';
import * as craftArbitrage from '../features/crafting-plan/craft-arbitrage-adapter.js';
import teaRecommendation from '../features/actions/tea-recommendation.js';
import inventoryCountDisplay from '../features/actions/inventory-count-display.js';
import pinnedActionsPage from '../features/actions/pinned-actions-page.js';
import drinkTimer from '../features/actions/drink-timer.js';

// Alchemy features
import alchemyProfitDisplay from '../features/alchemy/alchemy-profit-display.js';
import alchemyBestItems from '../features/alchemy/alchemy-best-items.js';
import alchemyItemPins from '../features/alchemy/alchemy-item-pins.js';
import { describeAlchemyMenus } from '../features/alchemy/alchemy-item-selector.js';

// Skilling optimizer
import skillingOptimizer from '../features/skilling-optimizer/skilling-optimizer-ui.js';

// Goal planner. It lives here rather than in the ui bundle because everything it
// composes already does: the buy-vs-craft model above, and the enhancement path
// optimiser the missing-materials button pulls in.
import goalPlanner from '../features/planner/goal-planner-ui.js';

// Export to global namespace
const toolashaRoot = window.Toolasha || {};
window.Toolasha = toolashaRoot;

if (typeof unsafeWindow !== 'undefined') {
    unsafeWindow.Toolasha = toolashaRoot;
}

toolashaRoot.Actions = {
    initActionPanelObserver,
    actionTimeDisplay,
    actionCountdown,
    quickInputButtons,
    outputTotals,
    maxProduceable,
    gatheringStats,
    requiredMaterials,
    missingMaterialsButton,
    budgetCalculator,
    costSummary,
    actionPanelLayout,
    craftingPlan,
    // Reached by Equipment Watch, which lives in the market bundle: importing
    // it there would copy the whole recursive costing model into a second bundle
    craftingPlanCalculator,
    // The same costing model, narrowed to one read-only question — what would
    // one of these cost *me* to make — for callers outside this bundle
    craftArbitrage,
    alchemyProfitDisplay,
    alchemyBestItems,
    alchemyItemPins,
    teaRecommendation,
    inventoryCountDisplay,
    pinnedActionsPage,
    drinkTimer,
    skillingOptimizer,
    goalPlanner,
};

// Console-driven debug tools, kept out of the feature namespaces because
// nothing registers or schedules them — they only run when typed
toolashaRoot.Debug = {
    ...(toolashaRoot.Debug || {}),
    alchemyMenu: () => describeAlchemyMenus(),
};

console.log('[Toolasha] Actions library loaded');
