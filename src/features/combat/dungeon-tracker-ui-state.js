/**
 * Dungeon Tracker UI State Management
 * Handles loading, saving, and managing UI state
 */

import config from '../../core/config.js';
import { readScoped, writeScoped } from '../../utils/character-key.js';

/**
 * Where the panel's own preferences live.
 *
 * Scoped per character — where the panel sits and what it is filtered to is a
 * per-character preference — and resolved at each read and write, since the
 * user switches characters without reloading. The pre-scoping global state is
 * adopted by the main character once.
 */
const UI_STATE_KEY = 'dungeonTracker_uiState';

/** Show only runs this character recorded (the default), or every character's */
export const CHARACTER_FILTER_MINE = 'mine';
export const CHARACTER_FILTER_ALL = 'all';

class DungeonTrackerUIState {
    constructor() {
        // Collapse/expand states
        this.isCollapsed = false;
        this.isKeysExpanded = false;
        this.isRunHistoryExpanded = false;
        this.isChartExpanded = true; // Default: expanded
        this.isRoiExpanded = false; // The ROI board is a table of everything; opened on purpose

        // Position state
        this.position = null; // { x, y } or null for default

        // Grouping and filtering state
        this.groupBy = 'team'; // 'team' or 'dungeon'
        this.filterDungeon = 'all'; // 'all' or specific dungeon name
        this.filterTeam = 'all'; // 'all' or specific team key

        // Whose runs to show. The run store is deliberately shared across
        // characters — a team run recorded by two of your own characters is one
        // run, and deduping it is the point — so the panel filters rather than
        // the store partitioning. Defaults to this character, which is what
        // "how am I doing" means when it is asked.
        this.filterCharacter = CHARACTER_FILTER_MINE;

        // Track expanded groups to preserve state across refreshes
        this.expandedGroups = new Set();
    }

    /**
     * Load saved state from storage
     */
    async load() {
        const savedState = await readScoped(UI_STATE_KEY, 'settings', null, { migrate: 'adopt' });
        if (savedState) {
            this.isCollapsed = savedState.isCollapsed || false;
            this.isKeysExpanded = savedState.isKeysExpanded || false;
            this.isRunHistoryExpanded = savedState.isRunHistoryExpanded || false;
            this.isRoiExpanded = savedState.isRoiExpanded || false;
            this.position = savedState.position || null;

            // Load grouping/filtering state
            this.groupBy = savedState.groupBy || 'team';
            this.filterDungeon = savedState.filterDungeon || 'all';
            this.filterTeam = savedState.filterTeam || 'all';
            this.filterCharacter =
                savedState.filterCharacter === CHARACTER_FILTER_ALL ? CHARACTER_FILTER_ALL : CHARACTER_FILTER_MINE;
        } else {
            // A character with no saved state is a character the panel has not
            // been opened on; it should not inherit the last one's selections
            this.filterCharacter = CHARACTER_FILTER_MINE;
        }
    }

    /**
     * Save current state to storage
     */
    async save() {
        await writeScoped(
            UI_STATE_KEY,
            {
                isCollapsed: this.isCollapsed,
                isKeysExpanded: this.isKeysExpanded,
                isRunHistoryExpanded: this.isRunHistoryExpanded,
                isRoiExpanded: this.isRoiExpanded,
                position: this.position,
                groupBy: this.groupBy,
                filterDungeon: this.filterDungeon,
                filterTeam: this.filterTeam,
                filterCharacter: this.filterCharacter,
            },
            'settings',
            true
        );
    }

    /**
     * Whether either run-history filter is currently narrowing the run list.
     * The filter controls live in a collapsed section, so a session that starts
     * with a filter still set from last time would otherwise show "No runs match
     * filters" with nothing on screen explaining why.
     * @returns {boolean} True if the dungeon or team filter is not 'all'
     */
    hasActiveFilters() {
        return this.filterDungeon !== 'all' || this.filterTeam !== 'all';
    }

    /**
     * Clear both run-history filters back to 'all'. Caller is responsible for
     * persisting (save()) and refreshing any dependent UI.
     */
    clearFilters() {
        this.filterDungeon = 'all';
        this.filterTeam = 'all';
    }

    /**
     * Update container position and styling
     * @param {HTMLElement} container - Container element
     */
    updatePosition(container) {
        const zIndex = this.isCollapsed ? config.Z_HUD : config.Z_FLOATING_PANEL;
        const baseStyle = `
            position: fixed;
            z-index: ${zIndex};
            background: rgba(0, 0, 0, 0.85);
            border: 2px solid #4a9eff;
            border-radius: 8px;
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            color: #fff;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
        `;

        // Never wider than the screen: 480px of min-width on a 390px phone
        // pushed half the tracker permanently off the right edge
        const minWidth = this.isCollapsed ? 'min(250px, calc(100vw - 20px))' : 'min(480px, calc(100vw - 20px))';

        if (this.position) {
            // Custom position (user dragged it) — clamped back on screen, since
            // it may have been saved in a wider window than this one
            const x = Math.max(0, Math.min(this.position.x, window.innerWidth - 60));
            const y = Math.max(0, Math.min(this.position.y, window.innerHeight - 40));
            container.style.cssText = `
                ${baseStyle}
                top: ${y}px;
                left: ${x}px;
                min-width: ${minWidth};
            `;
        } else if (this.isCollapsed) {
            // Collapsed: top-left (near action time display)
            container.style.cssText = `
                ${baseStyle}
                top: 10px;
                left: 10px;
                min-width: ${minWidth};
            `;
        } else {
            // Expanded: top-center
            container.style.cssText = `
                ${baseStyle}
                top: 10px;
                left: 50%;
                transform: translateX(-50%);
                min-width: ${minWidth};
            `;
        }
    }
}

const dungeonTrackerUIState = new DungeonTrackerUIState();

export default dungeonTrackerUIState;
