/**
 * Enhancement Feature Wrapper
 * Manages initialization and cleanup of all enhancement-related components
 * Fixes handler accumulation by coordinating tracker, UI, and handlers
 */

import config from '../../core/config.js';
import enhancementTracker from './enhancement-tracker.js';
import enhancementUI from './enhancement-ui.js';
import { setupEnhancementHandlers, cleanupEnhancementHandlers } from './enhancement-handlers.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

class EnhancementFeature {
    constructor() {
        this.isInitialized = false;
    }

    /**
     * Initialize all enhancement components
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;
        const owner = captureOwner(this);

        // Initialize tracker (async)
        await enhancementTracker.initialize();
        if (!stillOurs(owner)) return;
        if (!config.getSetting('enhancementTracker')) {
            this.isInitialized = false;
            return;
        }

        // Setup WebSocket handlers
        setupEnhancementHandlers();

        // Initialize UI
        enhancementUI.initialize();
    }

    /**
     * Cleanup all enhancement components
     */
    disable() {
        noteTeardown(this);
        try {
            // Cleanup WebSocket handlers
            cleanupEnhancementHandlers();

            // Cleanup UI
            enhancementUI.cleanup();

            // Cleanup tracker (has its own disable method)
            if (enhancementTracker.disable) {
                enhancementTracker.disable();
            }

            this.isInitialized = false;
        } catch (error) {
            console.error('[Enhancement Tracker] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const enhancementFeature = new EnhancementFeature();

export default enhancementFeature;
