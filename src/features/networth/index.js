/**
 * Networth Feature - Main Coordinator
 * Manages networth calculation and display updates
 */

import config from '../../core/config.js';
import performanceMonitor from '../../utils/performance-monitor.js';
import { runInBackground } from '../../utils/background-work.js';
import connectionState from '../../core/connection-state.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import { calculateNetworth } from './networth-calculator.js';
import { networthHeaderDisplay, networthInventoryDisplay } from './networth-display.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { createPauseRegistry } from '../../utils/pause-registry.js';
import networthCache from './networth-cache.js';
import { registerRow } from '../../utils/overlay-rows.js';
import { row, blank, ROW_COLORS } from '../../utils/overlay-format.js';
import { formatLargeNumber } from '../../utils/formatters.js';
import networthHistory from './networth-history.js';
import networthHistoryChart from './networth-history-chart.js';
import productionIncomeRecorder from './production-income-recorder.js';
import goldSourcesPanel from './gold-sources-panel.js';
import { initExclusions } from './networth-exclusions.js';
import networthExclusionPopup from './networth-exclusion-popup.js';
import { terminateItemValueWorkerPool } from '../../utils/networth-worker-manager.js';

class NetworthFeature {
    constructor() {
        this.isActive = false;
        this.currentData = null;
        this.timerRegistry = createTimerRegistry();
        this.pauseRegistry = null;
        this.priceUpdateHandler = null;
        this.pricingModeHandler = null;
        this.itemsUpdateHandler = null;
        this.priceUpdateDebounceTimer = null;
        this.itemsUpdateDebounceTimer = null;
    }

    /**
     * Initialize the networth feature
     */
    async initialize() {
        if (this.isActive) return;

        // Set reference in display components so they can trigger recalculation
        networthHeaderDisplay.setNetworthFeature(this);
        networthInventoryDisplay.setNetworthFeature(this);

        // Initialize exclusions from storage
        await performanceMonitor.span('init:networth', 'exclusions', () => initExclusions());

        // Initialize header display (always enabled with networth feature)
        if (config.isFeatureEnabled('networth')) {
            networthHeaderDisplay.initialize();
        }

        // Initialize inventory panel display (separate toggle)
        if (config.isFeatureEnabled('inventorySummary')) {
            networthInventoryDisplay.initialize();
        }

        if (!this.pauseRegistry) {
            this.pauseRegistry = createPauseRegistry();
            this.pauseRegistry.register(
                'networth-event-listeners',
                () => this.pauseListeners(),
                () => this.resumeListeners()
            );
        }

        // Set up event-driven updates instead of polling
        this.setupEventListeners();

        this.isActive = true;

        // The first calculation prices every item in the inventory and every
        // saved snapshot in the history — seconds of work, and every feature
        // after this one in the registry was waiting behind it for a number
        // nobody has looked at yet. It runs once the page has drawn instead.
        this.ready = runInBackground('networth', async () => {
            if (connectionState.isConnected()) {
                await performanceMonitor.span('bg:networth', 'first calculation', () => this.recalculate());
            }
            if (config.getSetting('networth_historyChart')) {
                networthHistoryChart.setNetworthFeature(this);
                await performanceMonitor.span('bg:networth', 'history', () => networthHistory.initialize(this));
            }
            if (config.getSetting('networth_goldSources')) {
                await performanceMonitor.span('bg:networth', 'gold sources', () =>
                    productionIncomeRecorder.initialize()
                );
            }
        });
    }

    /**
     * Set up event listeners for automatic updates
     */
    setupEventListeners() {
        // Listen for market price updates
        this.priceUpdateHandler = () => {
            // Debounce price updates to avoid excessive recalculation
            clearTimeout(this.priceUpdateDebounceTimer);
            this.priceUpdateDebounceTimer = setTimeout(() => {
                if (this.isActive && connectionState.isConnected()) {
                    this.recalculate();
                }
            }, 1000); // 1 second debounce for price updates
        };

        marketAPI.on(this.priceUpdateHandler);

        // Listen for pricing mode changes
        this.pricingModeHandler = () => {
            if (this.isActive && connectionState.isConnected()) {
                networthCache.clear();
                this.recalculate();
            }
        };
        config.onSettingChange('networth_pricingMode', this.pricingModeHandler);

        // Listen for inventory changes
        this.itemsUpdateHandler = () => {
            // Debounce item updates with a maxWait so continuous actions still trigger a refresh
            clearTimeout(this.itemsUpdateDebounceTimer);
            this.itemsUpdateDebounceTimer = setTimeout(() => {
                if (this.isActive && connectionState.isConnected()) {
                    clearTimeout(this.itemsUpdateMaxWaitTimer);
                    this.itemsUpdateMaxWaitTimer = null;
                    this.recalculate();
                }
            }, 500); // 500ms debounce for inventory changes

            // maxWait: force a recalculation at least every 30s under continuous load
            if (!this.itemsUpdateMaxWaitTimer) {
                this.itemsUpdateMaxWaitTimer = setTimeout(() => {
                    this.itemsUpdateMaxWaitTimer = null;
                    clearTimeout(this.itemsUpdateDebounceTimer);
                    this.itemsUpdateDebounceTimer = null;
                    if (this.isActive && connectionState.isConnected()) {
                        this.recalculate();
                    }
                }, 5000);
            }
        };

        dataManager.on('items_updated', this.itemsUpdateHandler);
    }

    /**
     * Pause event listeners (called when tab is hidden)
     */
    pauseListeners() {
        // Clear any pending debounce timers
        clearTimeout(this.priceUpdateDebounceTimer);
        clearTimeout(this.itemsUpdateDebounceTimer);
        clearTimeout(this.itemsUpdateMaxWaitTimer);
        this.itemsUpdateMaxWaitTimer = null;
    }

    /**
     * Resume event listeners (called when tab is visible)
     */
    resumeListeners() {
        // Recalculate immediately when resuming
        if (this.isActive && connectionState.isConnected()) {
            this.recalculate();
        }
    }

    /**
     * Recalculate networth and update displays
     */
    async recalculate() {
        if (!connectionState.isConnected()) {
            return;
        }

        try {
            // Calculate networth
            const networthData = await calculateNetworth();
            this.currentData = networthData;

            // Update displays
            if (config.isFeatureEnabled('networth')) {
                networthHeaderDisplay.update(networthData);
            }

            if (config.isFeatureEnabled('inventorySummary')) {
                networthInventoryDisplay.update(networthData);
            }

            // Refresh exclusion popup if open (updates amounts after recalculation)
            networthExclusionPopup.refresh(networthData);
        } catch (error) {
            console.error('[Networth] Error calculating networth:', error);
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        try {
            // Clear debounce timers
            clearTimeout(this.priceUpdateDebounceTimer);
            clearTimeout(this.itemsUpdateDebounceTimer);
            clearTimeout(this.itemsUpdateMaxWaitTimer);
            this.itemsUpdateMaxWaitTimer = null;

            // Unregister event listeners
            if (this.priceUpdateHandler) {
                marketAPI.off(this.priceUpdateHandler);
                this.priceUpdateHandler = null;
            }

            if (this.pricingModeHandler) {
                config.offSettingChange('networth_pricingMode', this.pricingModeHandler);
                this.pricingModeHandler = null;
            }

            if (this.itemsUpdateHandler) {
                dataManager.off('items_updated', this.itemsUpdateHandler);
                this.itemsUpdateHandler = null;
            }

            if (this.pauseRegistry) {
                this.pauseRegistry.unregister('networth-event-listeners');
                this.pauseRegistry.cleanup();
                this.pauseRegistry = null;
            }

            this.timerRegistry.clearAll();

            networthHeaderDisplay.disable();
            networthInventoryDisplay.disable();
            networthHistory.disable();
            networthHistoryChart.closeModal();
            networthExclusionPopup.close();
            productionIncomeRecorder.cleanup();
            goldSourcesPanel.closeModal();

            // Clear the enhancement cost cache (character-specific)
            networthCache.clear();

            // The pool recreates itself on the next batch; idle workers should not
            // outlive the feature that spawned them
            terminateItemValueWorkerPool();

            this.currentData = null;
            this.isActive = false;
        } catch (error) {
            console.error('[Net Worth] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
        }
    }
}

const networthFeature = new NetworthFeature();

/**
 * Open the net worth history chart, or close it if it is already up.
 *
 * The tile is one number; the chart is where that number came from and where it
 * has been. Wrapped rather than handed over directly because opening it loads
 * saved preferences first, and the overlay calls `onOpen` inside a synchronous
 * try/catch — a rejection would escape it as an unhandled promise.
 *
 * @returns {Promise<void>}
 */
async function openHistoryChart() {
    try {
        await networthHistoryChart.toggleModal();
    } catch (error) {
        console.error('[Networth] Opening the history chart failed:', error);
    }
}

// Registered at module scope so the overlay has the row regardless of start-up
// order. Reads the value the feature last calculated rather than calculating:
// a full networth pass prices every item you own and runs a worker pool, which
// is not something a row redrawn every second may do. The figure refreshes when
// the feature itself recalculates, on item and price changes.
registerRow({
    key: 'netWorth',
    empty: 'No net worth yet',
    name: 'Net Worth',
    defaultSize: { width: 180, height: 30 },
    render: (container) => {
        const total = networthFeature.currentData?.totalNetworth;
        if (!(total > 0)) return blank(container);

        row(container, [
            { text: 'Net Worth', color: ROW_COLORS.dim },
            { text: formatLargeNumber(Math.round(total)), color: ROW_COLORS.good, bold: true, push: true },
        ]);
        container.title = 'Everything you own, priced.\nDouble-click for the net worth history chart.';
    },
    onOpen: openHistoryChart,
});

export default networthFeature;
