/**
 * Decimal Combat Level Display
 * Shows the unfloored Combat Level formula value, computed from current whole skill levels,
 * next to the persistent Combat entry in the left sidebar (e.g. ".2" appended to the native
 * 133, reading as 133.2).
 *
 * Display-only: it never overwrites the native integer node and never feeds the level-gap
 * debuff, which uses the same floored Combat Level the game displays (see
 * utils/dungeon-level-gap.js). It is deliberately not XP-interpolated — that continuous figure
 * belongs to the Combat Level panel (combat-level-panel.js), which has the room to explain it;
 * the sidebar shows only what the game's own formula says before the floor.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import { COMBAT_SKILLS, combatLevel } from '../../utils/combat-level.js';

const CSS_CLASS = 'mwi-combat-level-precise';

/**
 * The unfloored Combat Level from a live skills list, rounded to one decimal.
 *
 * The rounding only clears IEEE-754 noise from the 0.1/0.5 coefficients (0.1 * 3 is
 * 0.30000000000000004 in JS) — whole-level inputs cannot carry more than one meaningful
 * decimal digit, so nothing real is discarded.
 *
 * @param {Array<{skillHrid: string, level: number}>|null} skills - dataManager.getSkills() shape
 * @returns {number|null} null when any combat skill is missing
 */
export function decimalCombatLevel(skills) {
    if (!Array.isArray(skills)) return null;

    const levels = {};
    for (const name of COMBAT_SKILLS) {
        const skill = skills.find((entry) => entry?.skillHrid === `/skills/${name}`);
        if (!skill || typeof skill.level !== 'number') return null;
        levels[name] = skill.level;
    }

    return Math.round(combatLevel(levels).exact * 10) / 10;
}

class CombatLevelProgress {
    constructor() {
        this.isInitialized = false;
        this.unregisterHandlers = [];
        this.boundUpdate = null;
        // The sidebar row and its level span, re-resolved only when the
        // sidebar has been rebuilt — this runs on every action completed
        this.navRow = null;
        this.levelSpan = null;
    }

    /**
     * Setup settings listener (always active, even when the feature is disabled)
     */
    setupSettingListener() {
        config.onSettingChange('combatLevelProgress', (enabled) => {
            if (enabled) {
                this.initialize();
            } else {
                this.disable();
            }
        });
    }

    /**
     * Initialize the display
     */
    initialize() {
        if (!config.isFeatureEnabled('combatLevelProgress')) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        this.isInitialized = true;

        this.boundUpdate = () => this.update();
        dataManager.on('character_initialized', this.boundUpdate);
        dataManager.on('action_completed', this.boundUpdate);
        dataManager.on('skills_updated', this.boundUpdate);

        const unregister = domObserver.onClass('CombatLevelProgress', 'NavigationBar_navigationBar__', () =>
            this.update()
        );
        this.unregisterHandlers.push(unregister);

        this.update();
    }

    /**
     * Find the persistent Combat nav row via its icon's stable aria-label - never by
     * position/index, which would break if the sidebar's item order ever changes.
     * @returns {Element|null}
     */
    findCombatNavRow() {
        const icon = document.querySelector('svg[aria-label="navigationBar.combat"]');
        return icon?.closest('[class*="NavigationBar_nav__"]') || null;
    }

    /**
     * Recompute and render (or clear) the decimal Combat Level companion span
     */
    update() {
        if (!this.navRow?.isConnected || !this.levelSpan?.isConnected) {
            this.navRow = null;
            this.levelSpan = null;
            const navRow = this.findCombatNavRow();
            if (!navRow) {
                return;
            }
            const textContainer = navRow.querySelector('[class*="NavigationBar_textContainer"]');
            if (!textContainer) {
                return;
            }
            this.navRow = navRow;
            this.levelSpan = textContainer.querySelector('[class*="NavigationBar_level"]') || null;
        }

        const rawCombatLevel = decimalCombatLevel(dataManager.getSkills());

        if (rawCombatLevel === null) {
            this.navRow.querySelector(`.${CSS_CLASS}`)?.remove();
            return;
        }

        const levelSpan = this.levelSpan;
        if (!levelSpan) {
            return;
        }

        // Appended as a child of the native level span (never overwriting its own "150" text
        // node) rather than a flex sibling, so it reads flush as one number ("150.2") instead
        // of picking up the textContainer's flex gap between label/level as visible whitespace.
        let span = levelSpan.querySelector(`.${CSS_CLASS}`);
        if (!span) {
            span = document.createElement('span');
            span.className = CSS_CLASS;
            levelSpan.appendChild(span);
        }

        const decimalText = rawCombatLevel.toFixed(1).split('.')[1];
        const text = `.${decimalText}`;
        if (span.textContent === text) return;
        span.textContent = text;
        span.title = `Combat Level from current whole skill levels · native display: ${Math.floor(rawCombatLevel)}`;
    }

    /**
     * Disable the feature
     */
    disable() {
        this.unregisterHandlers.forEach((fn) => fn());
        this.unregisterHandlers = [];

        if (this.boundUpdate) {
            dataManager.off('character_initialized', this.boundUpdate);
            dataManager.off('action_completed', this.boundUpdate);
            dataManager.off('skills_updated', this.boundUpdate);
            this.boundUpdate = null;
        }

        document.querySelectorAll(`.${CSS_CLASS}`).forEach((el) => el.remove());
        this.navRow = null;
        this.levelSpan = null;
        this.isInitialized = false;
    }
}

const combatLevelProgress = new CombatLevelProgress();

combatLevelProgress.setupSettingListener();

export default combatLevelProgress;
export { CombatLevelProgress };
