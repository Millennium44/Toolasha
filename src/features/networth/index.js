/**
 * Networth Feature - Main Coordinator
 * Manages networth calculation and display updates
 */

import dataManager from '../../core/data-manager.js';
import { calculateNetworth } from './networth-calculator.js';
import { networthHeaderDisplay, networthInventoryDisplay } from './networth-display.js';

class NetworthFeature {
    constructor() {
        this.isActive = false;
        this.updateInterval = null;
        this.currentData = null;
    }

    /**
     * Initialize the networth feature
     */
    async initialize() {
        if (this.isActive) return;

        // Initialize header display (always enabled with networth feature)
        if (dataManager.getSetting('networth')) {
            networthHeaderDisplay.initialize();
        }

        // Initialize inventory panel display (separate toggle)
        if (dataManager.getSetting('inventorySummary')) {
            networthInventoryDisplay.initialize();
        }

        // Start update interval (every 30 seconds)
        this.updateInterval = setInterval(() => this.recalculate(), 30000);

        // Initial calculation
        await this.recalculate();

        this.isActive = true;
    }

    /**
     * Recalculate networth and update displays
     */
    async recalculate() {
        try {
            // Calculate networth
            const networthData = await calculateNetworth();
            this.currentData = networthData;

            // Update displays
            if (dataManager.getSetting('networth')) {
                networthHeaderDisplay.update(networthData);
            }

            if (dataManager.getSetting('inventorySummary')) {
                networthInventoryDisplay.update(networthData);
            }
        } catch (error) {
            console.error('[Networth] Error calculating networth:', error);
        }
    }

    /**
     * Disable the feature
     */
    disable() {
        if (this.updateInterval) {
            clearInterval(this.updateInterval);
            this.updateInterval = null;
        }

        networthHeaderDisplay.disable();
        networthInventoryDisplay.disable();

        this.currentData = null;
        this.isActive = false;
    }
}

// Create and export singleton instance
const networthFeature = new NetworthFeature();

export default networthFeature;
