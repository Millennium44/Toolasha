/**
 * Dungeon Tracker UI State Management
 * Handles loading, saving, and managing UI state
 */

import storage from '../../core/storage.js';
import config from '../../core/config.js';

class DungeonTrackerUIState {
    constructor() {
        // Collapse/expand states
        this.isCollapsed = false;
        this.isKeysExpanded = false;
        this.isRunHistoryExpanded = false;
        this.isChartExpanded = true; // Default: expanded

        // Position state
        this.position = null; // { x, y } or null for default

        // Grouping and filtering state
        this.groupBy = 'team'; // 'team' or 'dungeon'
        this.filterDungeon = 'all'; // 'all' or specific dungeon name
        this.filterTeam = 'all'; // 'all' or specific team key

        // Track expanded groups to preserve state across refreshes
        this.expandedGroups = new Set();
    }

    /**
     * Load saved state from storage
     */
    async load() {
        const savedState = await storage.getJSON('dungeonTracker_uiState', 'settings', null);
        if (savedState) {
            this.isCollapsed = savedState.isCollapsed || false;
            this.isKeysExpanded = savedState.isKeysExpanded || false;
            this.isRunHistoryExpanded = savedState.isRunHistoryExpanded || false;
            this.position = savedState.position || null;

            // Load grouping/filtering state
            this.groupBy = savedState.groupBy || 'team';
            this.filterDungeon = savedState.filterDungeon || 'all';
            this.filterTeam = savedState.filterTeam || 'all';
        }
    }

    /**
     * Save current state to storage
     */
    async save() {
        await storage.setJSON(
            'dungeonTracker_uiState',
            {
                isCollapsed: this.isCollapsed,
                isKeysExpanded: this.isKeysExpanded,
                isRunHistoryExpanded: this.isRunHistoryExpanded,
                position: this.position,
                groupBy: this.groupBy,
                filterDungeon: this.filterDungeon,
                filterTeam: this.filterTeam,
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
