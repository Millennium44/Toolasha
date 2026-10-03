/**
 * Wider Enhancing Panel
 *
 * The game's center action panel is narrow, and the Enhancement Calculator is
 * injected inside it. While the Enhancing skill panel is shown (Enhance and
 * Current Action tabs), this adds a marker class to the center column that a
 * scoped stylesheet turns into a wider layout. Every other skill's panel keeps
 * the game's own width because the class is removed as soon as the Enhancing
 * panel is gone.
 *
 * Selectors relied on (all partial `[class*=...]` matches, never hashed names):
 * - `SkillActionDetail_enhancingComponent`: the Enhancing panel itself, the same
 *   class `panel-observer.js` watches.
 * - `GamePage_middlePanel` (fallback: the child of `GamePage_mainPanel` holding the
 *   panel): the center column that gets widened.
 * - `button[role="tab"]` labelled "Enhance" and "Current Action": keeps the width
 *   on the Current Action tab, where the Enhancing component may be unmounted.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

const SETTING_ID = 'enhancingPanel_wide';
const STYLE_ID = 'mwi-wide-enhancing-style';
export const WIDE_CLASS = 'mwi-wide-enhancing';

const PANEL_SELECTOR = '[class*="SkillActionDetail_enhancingComponent"]';
const COLUMN_SELECTORS = ['[class*="GamePage_middlePanel"]'];
const MAIN_PANEL_SELECTOR = '[class*="GamePage_mainPanel"]';
const WIDTH = 'min(1400px, 92vw)';

const CSS = `
    .${WIDE_CLASS} {
        width: ${WIDTH} !important;
        max-width: ${WIDTH} !important;
        flex: 1 1 ${WIDTH} !important;
    }
    .${WIDE_CLASS} ${PANEL_SELECTOR},
    .${WIDE_CLASS} #mwi-enhancement-stats {
        width: 100% !important;
        max-width: none !important;
        box-sizing: border-box;
    }
`;

/**
 * Center column that holds an element.
 * @param {Element} el - Any element inside the column
 * @returns {Element|null} The column, or null when it cannot be identified
 */
function findColumn(el) {
    for (const selector of COLUMN_SELECTORS) {
        const column = el.closest(selector);
        if (column) return column;
    }
    const main = el.closest(MAIN_PANEL_SELECTOR);
    if (!main) return null;
    let node = el;
    while (node && node.parentElement !== main) node = node.parentElement;
    return node || null;
}

/**
 * Whether the column shows the Enhance / Current Action tab pair.
 * @param {Element} column - Center column
 * @returns {boolean} True when both tabs are present
 */
function hasEnhancingTabs(column) {
    const labels = Array.from(column.querySelectorAll('button[role="tab"]')).map((b) => b.textContent.trim());
    return labels.includes('Enhance') && labels.includes('Current Action');
}

class WideEnhancingPanel {
    constructor() {
        this.isInitialized = false;
        this.styleEl = null;
        this.unregister = null;
        this.watcher = null;
        this.watchedColumn = null;
        this.timers = createTimerRegistry();
        this.pending = null;
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

        this.unregister = domObserver.onClass('WideEnhancingPanel', 'SkillActionDetail_enhancingComponent', () =>
            this.sync()
        );
        this.sync();
    }

    /**
     * Put the class on the column while the Enhancing panel is shown, take it
     * off everywhere else.
     */
    sync() {
        if (!this.isInitialized) return;

        const panel = document.querySelector(PANEL_SELECTOR);
        let column = panel ? findColumn(panel) : null;

        if (!column) {
            // Current Action tab: the component may be gone while the tabs remain
            const current = document.querySelector(`.${WIDE_CLASS}`);
            if (current && hasEnhancingTabs(current)) column = current;
        }

        document.querySelectorAll(`.${WIDE_CLASS}`).forEach((el) => {
            if (el !== column) el.classList.remove(WIDE_CLASS);
        });
        if (column) column.classList.add(WIDE_CLASS);

        this.watch(column);
    }

    /**
     * Watch the column so leaving the Enhancing panel removes the class.
     * @param {Element|null} column - Column currently widened
     */
    watch(column) {
        if (this.watchedColumn === column) return;
        this.watcher?.disconnect();
        this.watcher = null;
        this.watchedColumn = column;
        if (!column || typeof MutationObserver === 'undefined') return;
        this.watcher = new MutationObserver(() => {
            if (this.pending) return;
            this.pending = this.timers.scheduleTimeout(() => {
                this.pending = null;
                this.sync();
            }, 100);
        });
        this.watcher.observe(column, { childList: true, subtree: true });
    }

    disable() {
        this.unregister?.();
        this.unregister = null;
        this.watcher?.disconnect();
        this.watcher = null;
        this.watchedColumn = null;
        this.timers.clearAll();
        this.pending = null;
        document.querySelectorAll(`.${WIDE_CLASS}`).forEach((el) => el.classList.remove(WIDE_CLASS));
        this.styleEl?.remove();
        this.styleEl = null;
        this.isInitialized = false;
    }
}

const wideEnhancingPanel = new WideEnhancingPanel();
wideEnhancingPanel.setupSettingListener();

export default wideEnhancingPanel;
