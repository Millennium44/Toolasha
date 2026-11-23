/**
 * Custom Inventory Tabs — Feature Entry Point
 * Adds a "Toolasha" tab to the character panel for user-defined inventory organization.
 */

import config from '../../../core/config.js';
import CustomTabsUI from './custom-tabs-ui.js';

class CustomTabsFeature {
    constructor() {
        this.ui = null;
    }

    async initialize() {
        // A retry (`retryFailedFeatures`, or a start whose bounded wait ran out) can call this again without a
        // disable() in between. The UI it would replace is torn down first, half-built or not: two instances both
        // draw a tab bar and both write the config. Its cleanup also stops an initialize() still waiting on its load.
        if (this.ui) {
            this.ui.cleanup();
            this.ui = null;
        }
        if (!config.getSetting('inventoryTabs')) return;
        const ui = new CustomTabsUI();
        this.ui = ui;
        await ui.initialize();
    }

    disable() {
        this.ui?.cleanup();
        this.ui = null;
    }
}

const customTabsFeature = new CustomTabsFeature();

export default {
    name: 'Custom Inventory Tabs',
    initialize: () => customTabsFeature.initialize(),
    disable: () => customTabsFeature.disable(),
};
