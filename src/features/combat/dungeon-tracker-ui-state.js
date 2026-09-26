/**
 * Dungeon Tracker UI State Management
 * Handles loading, saving, and managing UI state
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
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

/**
 * Who the panel's preferences belong to.
 * @returns {string|null} Character id, or null before login
 */
function currentOwner() {
    return dataManager.getCurrentCharacterId?.() ?? null;
}

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
        this.filterTier = 'all'; // 'all' or a specific tier number (as a string)
        this.filterTeam = 'all'; // 'all' or specific team key

        // Whether filterDungeon/filterTier were chosen by hand from the dropdown
        // (true) or are still eligible to be pointed at the run in progress by
        // `autoScopeToRun` (false). A fresh 'all' default and an auto-scoped value
        // both read false here; only a dropdown `change` sets it true.
        this.isDungeonFilterManual = false;
        this.isTierFilterManual = false;

        // Whose runs to show. The run store is deliberately shared across
        // characters — a team run recorded by two of your own characters is one
        // run, and deduping it is the point — so the panel filters rather than
        // the store partitioning. Defaults to this character, which is what
        // "how am I doing" means when it is asked.
        this.filterCharacter = CHARACTER_FILTER_MINE;

        // Track expanded groups to preserve state across refreshes
        this.expandedGroups = new Set();

        /**
         * Whose preferences are in memory, or null when none have been loaded.
         * `save()` refuses to write anything else's: `writeScoped` resolves the
         * key when the write runs, so a panel still holding the departing
         * character's collapse, position and grouping would file them under the
         * arriving character on the first click.
         */
        this.owner = null;
    }

    /** Everything the constructor sets, for a load that has to start clean */
    _resetToDefaults() {
        this.isCollapsed = false;
        this.isKeysExpanded = false;
        this.isRunHistoryExpanded = false;
        this.isChartExpanded = true;
        this.isRoiExpanded = false;
        this.position = null;
        this.groupBy = 'team';
        this.filterDungeon = 'all';
        this.filterTier = 'all';
        this.filterTeam = 'all';
        this.isDungeonFilterManual = false;
        this.isTierFilterManual = false;
        this.filterCharacter = CHARACTER_FILTER_MINE;
        this.expandedGroups.clear();
    }

    /**
     * Load saved state from storage.
     *
     * Defaults first, always. The panel is a singleton and its `load()` is what
     * a character switch re-runs: reading a character who has never opened the
     * panel used to leave every field but `filterCharacter` holding the last
     * character's — their collapse, their window position, their grouping and
     * their run-history filters, on a panel that then wrote all of it back
     * under the new character's key on the first click.
     */
    async load() {
        // Fixed before the read: a switch landing inside it must not apply one
        // character's stored preferences to another's panel
        const owner = currentOwner();
        this.owner = null;
        // Before the read, not after it: a load a switch supersedes returns
        // without adopting, and what it leaves behind must not be the character
        // it was reading for
        this._resetToDefaults();
        const savedState = await readScoped(UI_STATE_KEY, 'settings', null, { migrate: 'adopt' });
        if (currentOwner() !== owner) return;

        this.owner = owner;
        if (savedState) {
            this.isCollapsed = savedState.isCollapsed || false;
            this.isKeysExpanded = savedState.isKeysExpanded || false;
            this.isRunHistoryExpanded = savedState.isRunHistoryExpanded || false;
            this.isRoiExpanded = savedState.isRoiExpanded || false;
            this.position = savedState.position || null;

            // Load grouping/filtering state
            this.groupBy = savedState.groupBy || 'team';
            this.filterDungeon = savedState.filterDungeon || 'all';
            this.filterTier = savedState.filterTier || 'all';
            this.filterTeam = savedState.filterTeam || 'all';
            this.isDungeonFilterManual = savedState.isDungeonFilterManual === true;
            this.isTierFilterManual = savedState.isTierFilterManual === true;
            this.filterCharacter =
                savedState.filterCharacter === CHARACTER_FILTER_ALL ? CHARACTER_FILTER_ALL : CHARACTER_FILTER_MINE;
        }
    }

    /**
     * Save current state to storage.
     *
     * Refused when the preferences in memory are not this character's — see
     * {@link DungeonTrackerUIState#owner}.
     */
    async save() {
        if (this.owner !== currentOwner()) {
            console.warn(
                `[Dungeon Tracker UI] Not saving panel preferences: they belong to ${this.owner ?? 'no character yet'}`
            );
            return;
        }
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
                filterTier: this.filterTier,
                filterTeam: this.filterTeam,
                isDungeonFilterManual: this.isDungeonFilterManual,
                isTierFilterManual: this.isTierFilterManual,
                filterCharacter: this.filterCharacter,
            },
            'settings',
            true
        );
    }

    /**
     * Whether a run-history filter is currently narrowing the run list in a way
     * the "Filtered" chip should call out. The filter controls live in a
     * collapsed section, so a session that starts with a filter still set from
     * last time would otherwise show "No runs match filters" with nothing on
     * screen explaining why.
     *
     * A dungeon/tier value that `autoScopeToRun` set is not "filtered" for this
     * purpose — scoping the header to the run in progress is the default now,
     * not a narrowing the player chose. Only a value picked from the dropdown
     * (isDungeonFilterManual / isTierFilterManual) lights the chip, same as the
     * team filter, which auto-scope never touches.
     * @returns {boolean} True if a manually-chosen filter is narrowing the list
     */
    hasActiveFilters() {
        return (
            (this.filterDungeon !== 'all' && this.isDungeonFilterManual) ||
            (this.filterTier !== 'all' && this.isTierFilterManual) ||
            this.filterTeam !== 'all'
        );
    }

    /**
     * Clear all run-history filters back to 'all', and hand Dungeon/Tier back to
     * auto-scope: the next run start (or the run already in progress, on the
     * caller's next redraw) re-points them at it. Caller is responsible for
     * persisting (save()) and refreshing any dependent UI.
     */
    clearFilters() {
        this.filterDungeon = 'all';
        this.filterTier = 'all';
        this.filterTeam = 'all';
        this.isDungeonFilterManual = false;
        this.isTierFilterManual = false;
    }

    /**
     * Point the Dungeon/Tier history filters at the run in progress, unless the
     * player chose one of them by hand from the dropdown. Team and Character are
     * never touched here — the decision is only that "how am I doing" defaults
     * to this dungeon and tier instead of every dungeon ever run.
     *
     * Idempotent: called on every 1 Hz tick of a live run, it only reports a
     * change (and only writes) the first time it sets a value.
     * @param {string|null|undefined} dungeonName - The run's dungeon name
     * @param {number|string|null|undefined} tier - The run's tier
     * @returns {boolean} True if a filter changed and the caller must re-sync the DOM
     */
    autoScopeToRun(dungeonName, tier) {
        if (!dungeonName || tier === null || tier === undefined) return false;
        const tierStr = String(tier);
        let changed = false;

        if (!this.isDungeonFilterManual && this.filterDungeon !== dungeonName) {
            this.filterDungeon = dungeonName;
            changed = true;
        }
        if (!this.isTierFilterManual && this.filterTier !== tierStr) {
            this.filterTier = tierStr;
            changed = true;
        }

        return changed;
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
