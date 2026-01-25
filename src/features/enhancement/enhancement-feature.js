/**
 * Enhancement Feature Wrapper
 * Manages initialization and cleanup of all enhancement-related components
 * Fixes handler accumulation by coordinating tracker, UI, and handlers
 */

import enhancementTracker from './enhancement-tracker.js';
import enhancementUI from './enhancement-ui.js';
import { setupEnhancementHandlers, cleanupEnhancementHandlers } from './enhancement-handlers.js';

class EnhancementFeature {
    constructor() {
        this.isInitialized = false;
    }

    /**
     * Initialize all enhancement components
     */
    async initialize() {
        // Guard against duplicate initialization
        if (this.isInitialized) {
            console.log('[Enhancement] ⚠️ BLOCKED duplicate initialization (fix working!)');
            return;
        }

        console.log('[Enhancement] ✓ Initializing (first time)');
        this.isInitialized = true;

        // Initialize tracker (async)
        await enhancementTracker.initialize();

        // Setup WebSocket handlers
        setupEnhancementHandlers();

        // Initialize UI
        enhancementUI.initialize();
    }

    /**
     * Cleanup all enhancement components
     */
    disable() {
        console.log('[Enhancement] 🧹 Cleaning up all components');

        // Cleanup WebSocket handlers
        cleanupEnhancementHandlers();

        // Cleanup UI
        enhancementUI.cleanup();

        // Cleanup tracker (has its own disable method)
        if (enhancementTracker.disable) {
            enhancementTracker.disable();
        }

        this.isInitialized = false;
    }
}

// Create and export singleton instance
const enhancementFeature = new EnhancementFeature();

export default enhancementFeature;
