/**
 * Bundle Bridge
 *
 * The one place cross-bundle reach-throughs live.
 *
 * The production build is several iife bundles that load in order and publish
 * their initialized singletons on `window.Toolasha.*`. A module that needs a
 * singleton from a bundle that loads after its own — or one whose import would
 * copy a second, uninitialized instance into its own bundle — cannot import it;
 * it has to read the namespace at call time. Those reads used to be ~80 bare
 * `window.Toolasha?...` expressions scattered across the codebase, invisible to
 * grep-by-intent and unmockable in tests.
 *
 * Every accessor here returns the live, initialized module the namespace holds
 * — or `null`, honestly, when the owning bundle has not loaded (or the code is
 * running off-page, as in tests and workers). No accessor caches anything: the
 * namespace is the state, this module has none, which is also why a copy of it
 * per bundle would be harmless.
 *
 * Callers keep their own fallbacks where they had them (`loadoutSnapshot() ||
 * bundledCopy` for the single-bundle dev build); the bridge only answers "what
 * does the namespace hold right now".
 */

/**
 * The published namespace itself, or null off-page.
 * @returns {Object|null} `window.Toolasha`, or null when there is no window or no namespace
 */
export function toolashaRoot() {
    return globalThis.window?.Toolasha || null;
}

// ---------------------------------------------------------------------------
// Core (loads first; reached from later bundles whose own copy is uninstalled)
// ---------------------------------------------------------------------------

/**
 * The installed WebSocket hook. Only the Core bundle's instance has
 * `install()` called on it; a bundle-local copy hears nothing.
 * @returns {Object|null} The hook, or null before Core has loaded
 */
export function webSocketHook() {
    return toolashaRoot()?.Core?.webSocketHook || null;
}

/**
 * The initialized data manager, for the rare caller that cannot import it.
 * @returns {Object|null} The manager, or null before Core has loaded
 */
export function dataManager() {
    return toolashaRoot()?.Core?.dataManager || null;
}

/**
 * The performance monitor the startup timeline was recorded on.
 * @returns {Object|null} The monitor, or null before Core has loaded
 */
export function performanceMonitor() {
    return toolashaRoot()?.Core?.performanceMonitor || null;
}

// ---------------------------------------------------------------------------
// Utils
// ---------------------------------------------------------------------------

/**
 * The enhancement Markov-chain calculator module (namespace with
 * `calculateEnhancement`), read lazily by code that only sometimes needs it.
 * @returns {Object|null} The module, or null before the utils bundle has loaded
 */
export function enhancementCalculator() {
    return toolashaRoot()?.Utils?.enhancementCalculator || null;
}

/**
 * The enhancement config module (namespace with `getAutoDetectedParams`).
 * @returns {Object|null} The module, or null before the utils bundle has loaded
 */
export function enhancementConfig() {
    return toolashaRoot()?.Utils?.enhancementConfig || null;
}

// ---------------------------------------------------------------------------
// Market bundle singletons
// ---------------------------------------------------------------------------

/**
 * The treasure tracker's measured chest returns.
 * @returns {Object|null} The tracker, or null when the market bundle is absent
 */
export function treasureTracker() {
    return toolashaRoot()?.Market?.treasureTracker || null;
}

/**
 * The order-book cache behind the queue-length estimator.
 * @returns {Object|null} The estimator, or null when the market bundle is absent
 */
export function queueLengthEstimator() {
    return toolashaRoot()?.Market?.queueLengthEstimator || null;
}

/**
 * The market-order totals calculator (coins committed to listings).
 * @returns {Object|null} The module, or null when the market bundle is absent
 */
export function marketOrderTotals() {
    return toolashaRoot()?.Market?.marketOrderTotals || null;
}

/**
 * The expected-value calculator for openable containers — the one copy that ran
 * initialize() (its cache is empty and calculateExpectedValue() returns null
 * until then, which only the market bundle's copy does).
 * @returns {Object|null} The calculator, or null when the market bundle is absent
 */
export function expectedValueCalculator() {
    return toolashaRoot()?.Market?.expectedValueCalculator || null;
}

// ---------------------------------------------------------------------------
// Actions bundle singletons
// ---------------------------------------------------------------------------

/**
 * The planner's market-volume measurement — the one copy with the cache in it.
 * @returns {Object|null} The module, or null when the actions bundle is absent
 */
export function marketLiquidity() {
    return toolashaRoot()?.Actions?.marketLiquidity || null;
}

/**
 * The action-panel sort/pin singleton — the one copy the actions bundle fills
 * with per-action cachedStats and the persisted pinned-action set. Other
 * bundles' copies stay empty, and writing to them can clobber the shared store.
 * @returns {Object|null} The module, or null when the actions bundle is absent
 */
export function actionPanelSort() {
    return toolashaRoot()?.Actions?.actionPanelSort || null;
}

/**
 * The buy-versus-craft planner (namespace with `computeBestCraftingPlan`).
 * @returns {Object|null} The module, or null when the actions bundle is absent
 */
export function craftingPlanCalculator() {
    return toolashaRoot()?.Actions?.craftingPlanCalculator || null;
}

/**
 * The action panel's missing-materials marketplace opener.
 * @returns {Object|null} The module, or null when the feature is off or absent
 */
export function missingMaterialsButton() {
    return toolashaRoot()?.Actions?.missingMaterialsButton || null;
}

/**
 * The goal planner panel.
 * @returns {Object|null} The panel, or null when the actions bundle is absent
 */
export function goalPlanner() {
    return toolashaRoot()?.Actions?.goalPlanner || null;
}

// ---------------------------------------------------------------------------
// Combat bundle singletons
// ---------------------------------------------------------------------------

/**
 * The initialized loadout snapshot store. Every other bundle's copy never
 * reads storage and answers "no loadout" to everything.
 * @returns {Object|null} The store, or null when the combat bundle is absent
 */
export function loadoutSnapshot() {
    return toolashaRoot()?.Combat?.loadoutSnapshot || null;
}

/**
 * The combat recorder the websocket actually feeds.
 * @returns {Object|null} The recorder, or null when the combat bundle is absent
 */
export function combatRecorder() {
    return toolashaRoot()?.Combat?.combatRecorder || null;
}

/**
 * The scroll simulator (per-loadout scroll/buff sets), loaded from storage by
 * the combat bundle's initialize(); other bundles' copies stay empty.
 * @returns {Object|null} The simulator, or null when the combat bundle is absent
 */
export function scrollSimulator() {
    return toolashaRoot()?.Combat?.scrollSimulator || null;
}

/**
 * The party drop-luck panel.
 * @returns {Object|null} The panel, or null when the combat bundle is absent
 */
export function partyLuckPanel() {
    return toolashaRoot()?.Combat?.partyLuckPanel || null;
}

/**
 * The stateful combat-stats collector the websocket feeds.
 * @returns {Object|null} The collector, or null when the combat bundle is absent
 */
export function combatStatsDataCollector() {
    return toolashaRoot()?.Combat?.combatStatsDataCollector || null;
}

/**
 * The combat-stats calculator that reads the collector's data — shared with it
 * because the two are read together.
 * @returns {Object|null} The calculator module, or null when the combat bundle is absent
 */
export function combatStatsCalculator() {
    return toolashaRoot()?.Combat?.combatStatsCalculator || null;
}

// ---------------------------------------------------------------------------
// Sim bundle singletons
// ---------------------------------------------------------------------------

/**
 * The combat simulator's panel instance.
 * @returns {Object|null} The panel, or null when the sim bundle is absent
 */
export function combatSimUI() {
    return toolashaRoot()?.Sim?.combatSimUI || null;
}

/**
 * The labyrinth simulator's panel instance, when one has been published.
 * @returns {Object|null} The panel, or null when there is none
 */
export function labSimUI() {
    return toolashaRoot()?.Sim?.labSimUI || null;
}

// ---------------------------------------------------------------------------
// UI bundle singletons (the ui bundle loads last, so everything below is
// reached at call time — usually a panel behind an overlay tile)
// ---------------------------------------------------------------------------

/**
 * The DPS panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function dpsPanel() {
    return toolashaRoot()?.UI?.dpsPanel || null;
}

/**
 * The settings UI (namespace with `onSettingsPanelAppear`).
 * @returns {Object|null} The module, or null when the ui bundle is absent
 */
export function settingsUI() {
    return toolashaRoot()?.UI?.settingsUI || null;
}

/**
 * The profit panel's view function — maps raw stats to the reading the panel
 * itself would show, so tiles agree with the panel behind them.
 * @returns {Function|null} The view function, or null when the ui bundle is absent
 */
export function combatProfitView() {
    return toolashaRoot()?.UI?.combatProfitView || null;
}

/**
 * The combat profit panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function profitPanel() {
    return toolashaRoot()?.UI?.profitPanel || null;
}

/**
 * The combat level / experience panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function combatLevelPanel() {
    return toolashaRoot()?.UI?.combatLevelPanel || null;
}

/**
 * The deaths panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function deathsPanel() {
    return toolashaRoot()?.UI?.deathsPanel || null;
}

/**
 * The party loot panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function partyLootPanel() {
    return toolashaRoot()?.UI?.partyLootPanel || null;
}

/**
 * The consumables panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function consumablesPanel() {
    return toolashaRoot()?.UI?.consumablesPanel || null;
}

/**
 * The overlay panel that owns the tile rows' shared display options.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function overlayPanel() {
    return toolashaRoot()?.UI?.overlayPanel || null;
}

/**
 * The Iron Bell farming panel.
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function ironCowFarmPanel() {
    return toolashaRoot()?.UI?.ironCowFarmPanel || null;
}

/**
 * The PFormance panel (the script's own timings).
 * @returns {Object|null} The panel, or null when the ui bundle is absent
 */
export function pformancePanel() {
    return toolashaRoot()?.UI?.pformancePanel || null;
}

// ---------------------------------------------------------------------------
// Root-level singletons
// ---------------------------------------------------------------------------

/**
 * The guild trial damage scoreboard, published at the namespace root.
 * @returns {Object|null} The scoreboard, or null when the combat bundle is absent
 */
export function guildTrialScoreboard() {
    return toolashaRoot()?.guildTrialScoreboard || null;
}
