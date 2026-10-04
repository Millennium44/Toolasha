/**
 * Wider Enhancing Panel
 *
 * The game caps the Enhancing action box (`EnhancingPanel_enhancingAction`) at
 * 43.75rem, which leaves the Enhancement Calculator injected inside it narrow.
 * With the setting on, one stylesheet raises that cap. `EnhancingPanel_*` only
 * exists while the Enhancing skill page is shown (Enhance and Current Action
 * tabs), so other skills are unaffected and nothing needs tracking.
 *
 * Selector relied on: `[class*="EnhancingPanel_enhancingAction"]`, a partial match
 * on the game's CSS-module class (never the hashed full name).
 */

import config from '../../core/config.js';

const SETTING_ID = 'enhancingPanel_wide';
export const STYLE_ID = 'mwi-wide-enhancing-style';
const WIDTH = 'min(1400px, 92vw)';

export const CSS = `
    [class*="EnhancingPanel_enhancingAction"] {
        max-width: ${WIDTH} !important;
    }
    [class*="EnhancingPanel_enhancingAction"] #mwi-enhancement-stats {
        flex-grow: 1;
        min-width: 0;
        max-width: none;
        box-sizing: border-box;
    }
`;

class WideEnhancingPanel {
    constructor() {
        this.isInitialized = false;
        this.styleEl = null;
    }

    setupSettingListener() {
        config.onSettingChange(SETTING_ID, (value) => {
            if (value) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING_ID)) return;
        this.isInitialized = true;

        this.styleEl = document.createElement('style');
        this.styleEl.id = STYLE_ID;
        this.styleEl.textContent = CSS;
        document.head.appendChild(this.styleEl);
    }

    disable() {
        this.styleEl?.remove();
        this.styleEl = null;
        this.isInitialized = false;
    }
}

const wideEnhancingPanel = new WideEnhancingPanel();
wideEnhancingPanel.setupSettingListener();

export default wideEnhancingPanel;
