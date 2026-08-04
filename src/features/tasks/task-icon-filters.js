/**
 * Task Icon Filters
 *
 * Adds clickable filter icons to the task panel header for controlling
 * which task icons are displayed. Based on MWI Task Manager implementation.
 *
 * Features:
 * - Battle icon toggle (shows/hides all combat task icons)
 * - Individual dungeon toggles (4 dungeons)
 * - Visual state indication (opacity 1.0 = active, 0.3 = inactive)
 * - Task count badges on each icon
 * - Persistent filter state across sessions
 * - Event-driven updates when filters change
 */

import config from '../../core/config.js';
import storage from '../../core/storage.js';
import { GAME } from '../../utils/selectors.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import assetManifest from '../../utils/asset-manifest.js';
import { characterKey, readScoped, writeScoped } from '../../utils/character-key.js';

const STORAGE_KEYS = {
    migration: 'taskIconsFiltersMigratedV1',
    /** One per-character record: `{battle: boolean, dungeons: {[id]: boolean}}` */
    filters: 'taskIconFilters',
    // Legacy, read once and deleted: a key for the battle toggle and one more
    // for every dungeon, all of them shared by every character on the account
    battle: 'taskIconsFilterBattle',
    dungeonPrefix: 'taskIconsFilterDungeon:',
};

class TaskIconFilters {
    constructor() {
        this.filterIcons = new Map(); // Map of filter ID -> DOM element
        this.currentCounts = new Map(); // Map of filter ID -> task count
        this.taskListObserver = null;
        this.filterBar = null; // Reference to filter bar DOM element
        this.settingChangeHandler = null; // Handler for setting changes
        this.stateLoadPromise = null;
        /** Which character's key `stateLoadPromise` was loaded for */
        this.stateLoadKey = null;
        this.isStateLoaded = false;
        this.manifestUrls = {}; // Sprite URLs from asset manifest
        this.state = {
            battle: true,
            dungeons: {},
        };

        // Dungeon configuration matching game data
        this.dungeonConfig = {
            '/actions/combat/chimerical_den': {
                id: 'chimerical_den',
                name: 'Chimerical Den',
                spriteId: 'chimerical_den',
            },
            '/actions/combat/sinister_circus': {
                id: 'sinister_circus',
                name: 'Sinister Circus',
                spriteId: 'sinister_circus',
            },
            '/actions/combat/enchanted_fortress': {
                id: 'enchanted_fortress',
                name: 'Enchanted Fortress',
                spriteId: 'enchanted_fortress',
            },
            '/actions/combat/pirate_cove': {
                id: 'pirate_cove',
                name: 'Pirate Cove',
                spriteId: 'pirate_cove',
            },
        };
    }

    /**
     * Initialize the task icon filters feature
     */
    initialize() {
        // Note: Filter bar is added by task-sorter.js when task panel appears

        this.loadState();

        // Pre-fetch asset manifest so sprite URLs are ready when icons render
        assetManifest.fetchManifest().then((urls) => {
            this.manifestUrls = urls;
        });

        // Listen for taskIconsDungeons setting changes
        this.settingChangeHandler = (enabled) => {
            if (this.filterBar) {
                this.filterBar.style.display = enabled ? 'flex' : 'none';
            }
        };
        config.onSettingChange('taskIconsDungeons', this.settingChangeHandler);
    }

    /**
     * Load this character's filters, once per character.
     *
     * Memoised against the character's own key rather than a bare flag: nothing
     * calls `cleanup()` on a character switch — the icons are drawn on demand by
     * `task-sorter` — so a plain `if (loaded) return` would keep showing the
     * previous character's filters for the rest of the session.
     * @returns {Promise<void>}
     */
    async loadState() {
        const key = characterKey(STORAGE_KEYS.filters);
        if (this.stateLoadPromise && this.stateLoadKey === key) {
            return this.stateLoadPromise;
        }

        this.stateLoadKey = key;
        this.stateLoadPromise = this.loadStateInternal();
        return this.stateLoadPromise;
    }

    async loadStateInternal() {
        try {
            await this.collapseLegacyState();

            const saved = await readScoped(STORAGE_KEYS.filters, 'settings', null, { migrate: 'adopt' });
            this.state = {
                battle: saved ? saved.battle !== false : true,
                dungeons: { ...(saved?.dungeons || {}) },
            };
        } catch (error) {
            console.error('[TaskIconFilters] Failed to load filter state:', error);
        } finally {
            this.isStateLoaded = true;
            this.updateAllIconStates();
            this.dispatchFilterChange('init');
        }
    }

    /**
     * Fold the old keys into one record, once for the whole account.
     *
     * There were six of them — a battle toggle and one per dungeon — all shared
     * by every character, and each one an IndexedDB key of its own. They are
     * gathered into the bare `taskIconFilters` key here and left there;
     * {@link readScoped} then hands that to whichever character is entitled to
     * adopt it, and everyone else starts on the defaults.
     * @returns {Promise<void>}
     */
    async collapseLegacyState() {
        const alreadyCollapsed = await storage.get(STORAGE_KEYS.filters, 'settings', null);
        if (alreadyCollapsed !== null) return;

        const migrated = await storage.get(STORAGE_KEYS.migration, 'settings', false);
        const legacy = migrated ? await this.readLegacyFromStorage() : this.readLegacyFromLocalStorage();
        if (!legacy) return;

        await storage.set(STORAGE_KEYS.filters, legacy, 'settings', true);

        if (migrated) {
            await this.deleteLegacyStorageKeys();
        } else {
            await storage.set(STORAGE_KEYS.migration, true, 'settings', true);
            this.clearLocalStorageState();
        }
    }

    /**
     * The pre-IndexedDB filters, if this browser still has them.
     * @returns {Object|null} `{battle, dungeons}` or null when nothing was stored
     */
    readLegacyFromLocalStorage() {
        const storedBattle = localStorage.getItem('mwi-taskIconsFilterBattle');
        const dungeons = {};
        let found = storedBattle !== null;

        Object.values(this.dungeonConfig).forEach((dungeon) => {
            const stored = localStorage.getItem(`mwi-taskIconsFilter-${dungeon.id}`);
            if (stored !== null) found = true;
            dungeons[dungeon.id] = stored === 'true';
        });

        if (!found) return null;
        return { battle: storedBattle === null || storedBattle === 'true', dungeons };
    }

    /**
     * The one-key-per-dungeon filters, if they are still in IndexedDB.
     * @returns {Promise<Object|null>} `{battle, dungeons}` or null when nothing was stored
     */
    async readLegacyFromStorage() {
        const storedBattle = await storage.get(STORAGE_KEYS.battle, 'settings', null);
        let found = storedBattle !== null;

        const dungeonEntries = await Promise.all(
            Object.values(this.dungeonConfig).map(async (dungeon) => {
                const enabled = await storage.get(`${STORAGE_KEYS.dungeonPrefix}${dungeon.id}`, 'settings', null);
                return { id: dungeon.id, enabled };
            })
        );

        const dungeons = {};
        dungeonEntries.forEach(({ id, enabled }) => {
            if (enabled !== null) found = true;
            dungeons[id] = enabled === true;
        });

        if (!found) return null;
        return { battle: storedBattle !== false, dungeons };
    }

    /**
     * Drop the old keys now their contents live in one record.
     * @returns {Promise<void>}
     */
    async deleteLegacyStorageKeys() {
        await storage.delete(STORAGE_KEYS.battle, 'settings');
        await Promise.all(
            Object.values(this.dungeonConfig).map((dungeon) =>
                storage.delete(`${STORAGE_KEYS.dungeonPrefix}${dungeon.id}`, 'settings')
            )
        );
    }

    /**
     * Write this character's filters.
     * @returns {Promise<boolean>} Success status
     */
    async persistStateToStorage() {
        return writeScoped(
            STORAGE_KEYS.filters,
            { battle: this.state.battle, dungeons: this.state.dungeons },
            'settings',
            true
        );
    }

    clearLocalStorageState() {
        localStorage.removeItem('mwi-taskIconsFilterBattle');
        Object.values(this.dungeonConfig).forEach((dungeon) => {
            localStorage.removeItem(`mwi-taskIconsFilter-${dungeon.id}`);
        });
    }

    /**
     * Cleanup when feature is disabled
     */
    cleanup() {
        // Remove setting change listener
        if (this.settingChangeHandler) {
            config.offSettingChange('taskIconsDungeons', this.settingChangeHandler);
            this.settingChangeHandler = null;
        }

        // Disconnect task list observer
        if (this.taskListObserver) {
            this.taskListObserver();
            this.taskListObserver = null;
        }

        // Remove filter bar from DOM
        if (this.filterBar) {
            this.filterBar.remove();
            this.filterBar = null;
        }

        // Clear maps
        this.filterIcons.clear();
        this.currentCounts.clear();
    }

    /**
     * Add filter icon bar to task panel header
     * Called by task-sorter.js when task panel appears
     * @param {HTMLElement} headerElement - Task panel header element
     */
    async addFilterBar(headerElement) {
        // Check if we already added filters to this header
        if (headerElement.querySelector('[data-mwi-task-filters]')) {
            return;
        }

        // Ensure state is loaded before creating icons so persisted state is reflected
        await this.loadState();

        // Ensure manifest URLs are loaded before creating icons
        this.manifestUrls = await assetManifest.fetchManifest();

        // Find the task panel container to observe task list
        // DOM structure: Grandparent > TaskBoardInfo (parent) > TaskSlotCount (header)
        //                Grandparent > TaskList (sibling to TaskBoardInfo)
        // So we need to go up two levels to find the common container
        const panel = headerElement.parentElement?.parentElement;
        if (!panel) {
            console.warn('[TaskIconFilters] Could not find task panel grandparent');
            return;
        }

        // Create container for filter icons
        this.filterBar = document.createElement('div');
        this.filterBar.setAttribute('data-mwi-task-filters', 'true');
        this.filterBar.style.gap = '8px';
        this.filterBar.style.alignItems = 'center';
        this.filterBar.style.marginLeft = '8px';

        // Check if taskIconsDungeons setting is enabled
        const isEnabled = config.getSetting('taskIconsDungeons');
        this.filterBar.style.display = isEnabled ? 'flex' : 'none';

        // Create battle icon (combat icon is in misc_sprite)
        const battleIcon = this.createFilterIcon(
            'battle',
            'Battle',
            'combat',
            () => this.getBattleFilterEnabled(),
            'misc'
        );
        this.filterBar.appendChild(battleIcon);
        this.filterIcons.set('battle', battleIcon);

        // Create dungeon icons (dungeon icons are in actions_sprite)
        Object.entries(this.dungeonConfig).forEach(([hrid, dungeon]) => {
            const dungeonIcon = this.createFilterIcon(
                dungeon.id,
                dungeon.name,
                dungeon.spriteId,
                () => this.getDungeonFilterEnabled(hrid),
                'actions'
            );
            this.filterBar.appendChild(dungeonIcon);
            this.filterIcons.set(dungeon.id, dungeonIcon);
        });

        // Insert filter bar after the task sort button (if it exists)
        const sortButton = headerElement.querySelector('[data-mwi-task-sort]');
        if (sortButton) {
            sortButton.parentNode.insertBefore(this.filterBar, sortButton.nextSibling);
        } else {
            headerElement.appendChild(this.filterBar);
        }

        // Initial count update
        this.updateCounts(panel);

        // Start observing task list for count updates
        this.observeTaskList(panel);
    }

    /**
     * Create a clickable filter icon with count badge
     * @param {string} id - Unique identifier for this filter
     * @param {string} title - Tooltip text
     * @param {string} symbolId - Symbol ID in sprite
     * @param {Function} getEnabled - Function to check if filter is enabled
     * @param {string} spriteType - Sprite type: 'misc', 'actions', 'items' (default: 'actions')
     * @returns {HTMLElement} Filter icon container
     */
    createFilterIcon(id, title, symbolId, getEnabled, spriteType = 'actions') {
        const container = document.createElement('div');
        container.setAttribute('data-filter-id', id);
        container.style.position = 'relative';
        container.style.cursor = 'pointer';
        container.style.userSelect = 'none';
        container.title = title;

        // Get sprite URL from manifest
        const spriteUrl = this.manifestUrls[spriteType] || null;

        // Create SVG icon
        if (spriteUrl) {
            const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            svg.setAttribute('width', '24');
            svg.setAttribute('height', '24');
            svg.setAttribute('viewBox', '0 0 1024 1024');
            svg.style.display = 'block';
            svg.style.transition = 'opacity 0.2s';

            // Create use element with external sprite reference
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `${spriteUrl}#${symbolId}`);
            svg.appendChild(use);
            container.appendChild(svg);
        }

        // Create count badge
        const countBadge = document.createElement('span');
        countBadge.setAttribute('data-count-badge', 'true');
        countBadge.style.position = 'absolute';
        countBadge.style.top = '-4px';
        countBadge.style.right = '-8px';
        countBadge.style.fontSize = '11px';
        countBadge.style.fontWeight = 'bold';
        countBadge.style.color = '#fff';
        countBadge.style.textShadow = '0 0 2px #000, 0 0 2px #000';
        countBadge.style.pointerEvents = 'none';
        countBadge.style.transition = 'opacity 0.2s';
        countBadge.textContent = '*0';
        container.appendChild(countBadge);

        // Click handler
        container.addEventListener('click', () => {
            this.handleFilterClick(id);
        });

        // Set initial state
        this.updateIconState(container, getEnabled());

        return container;
    }

    /**
     * Handle filter icon click
     * @param {string} filterId - ID of the filter that was clicked
     */
    handleFilterClick(filterId) {
        if (filterId === 'battle') {
            // Toggle battle filter
            const currentState = this.getBattleFilterEnabled();
            this.state.battle = !currentState;
            this.persistStateToStorage();
        } else {
            // Toggle dungeon filter
            const dungeonHrid = Object.keys(this.dungeonConfig).find(
                (hrid) => this.dungeonConfig[hrid].id === filterId
            );
            if (dungeonHrid) {
                const currentState = this.getDungeonFilterEnabled(dungeonHrid);
                this.state.dungeons[filterId] = !currentState;
                this.persistStateToStorage();
            }
        }

        // Update all icon states
        this.updateAllIconStates();

        // Dispatch custom event to notify other components
        this.dispatchFilterChange(filterId);
    }

    dispatchFilterChange(filterId) {
        document.dispatchEvent(
            new CustomEvent('mwi-task-icon-filter-changed', {
                detail: {
                    filterId,
                    battleEnabled: this.getBattleFilterEnabled(),
                },
            })
        );
    }

    /**
     * Update visual state of a filter icon
     * @param {HTMLElement} container - Filter icon container
     * @param {boolean} enabled - Whether filter is enabled
     */
    updateIconState(container, enabled) {
        const svg = container.querySelector('svg');
        const countBadge = container.querySelector('[data-count-badge]');

        // If SVG doesn't exist (sprite not loaded yet), skip update
        if (!svg || !countBadge) {
            return;
        }

        if (enabled) {
            svg.style.opacity = '1.0';
            countBadge.style.display = 'inline';
        } else {
            svg.style.opacity = '0.3';
            countBadge.style.display = 'none';
        }
    }

    /**
     * Update all icon states based on current config
     */
    updateAllIconStates() {
        // Update battle icon
        const battleIcon = this.filterIcons.get('battle');
        if (battleIcon) {
            this.updateIconState(battleIcon, this.getBattleFilterEnabled());
        }

        // Update dungeon icons
        Object.entries(this.dungeonConfig).forEach(([hrid, dungeon]) => {
            const dungeonIcon = this.filterIcons.get(dungeon.id);
            if (dungeonIcon) {
                this.updateIconState(dungeonIcon, this.getDungeonFilterEnabled(hrid));
            }
        });
    }

    /**
     * Update task counts on all filter icons
     * @param {HTMLElement} panel - Task panel container
     */
    updateCounts(panel) {
        // Find all task items in the panel
        const taskItems = panel.querySelectorAll(GAME.TASK_CARD);

        // Count tasks for each filter
        const counts = {
            battle: 0,
            chimerical_den: 0,
            sinister_circus: 0,
            enchanted_fortress: 0,
            pirate_cove: 0,
        };

        taskItems.forEach((taskItem) => {
            // Check if this is a combat task
            const isCombatTask = this.isTaskCombat(taskItem);

            if (isCombatTask) {
                counts.battle++;

                // Check which dungeon this task is for
                const dungeonType = this.getTaskDungeonType(taskItem);
                if (dungeonType && counts.hasOwnProperty(dungeonType)) {
                    counts[dungeonType]++;
                }
            }
        });

        // Update count badges
        this.filterIcons.forEach((icon, filterId) => {
            const count = counts[filterId] || 0;
            const countBadge = icon.querySelector('[data-count-badge]');
            if (countBadge) {
                countBadge.textContent = `*${count}`;
            }
            this.currentCounts.set(filterId, count);
        });
    }

    /**
     * Check if a task item is a combat task
     * @param {HTMLElement} taskItem - Task item element
     * @returns {boolean} True if this is a combat task
     */
    isTaskCombat(taskItem) {
        // Check for monster icon class added by task-icons.js to all combat tasks
        const monsterIcon = taskItem.querySelector('.mwi-task-icon-monster');
        return monsterIcon !== null;
    }

    /**
     * Get the dungeon type for a combat task
     * @param {HTMLElement} taskItem - Task item element
     * @returns {string|null} Dungeon ID or null if not a dungeon task
     */
    getTaskDungeonType(taskItem) {
        // Look for dungeon badge icons (using class, not ID)
        const badges = taskItem.querySelectorAll('.mwi-task-icon-dungeon svg use');

        if (!badges || badges.length === 0) {
            return null;
        }

        // Check each badge to identify the dungeon
        for (const badge of badges) {
            const href = badge.getAttribute('href') || badge.getAttributeNS('http://www.w3.org/1999/xlink', 'href');

            if (!href) continue;

            // Match href to dungeon config
            for (const [_hrid, dungeon] of Object.entries(this.dungeonConfig)) {
                if (href.includes(dungeon.spriteId)) {
                    return dungeon.id;
                }
            }
        }

        return null;
    }

    /**
     * Set up observer to watch for task list changes
     * @param {HTMLElement} panel - Task panel container
     */
    observeTaskList(panel) {
        // Find the task list container
        const taskList = panel.querySelector(GAME.TASK_LIST);
        if (!taskList) {
            console.warn('[TaskIconFilters] Could not find task list');
            return;
        }

        // Disconnect existing observer if any
        if (this.taskListObserver) {
            this.taskListObserver();
        }

        // Create new observer
        this.taskListObserver = createMutationWatcher(
            taskList,
            () => {
                this.updateCounts(panel);
            },
            {
                childList: true,
                subtree: true,
            }
        );
    }

    /**
     * Check if battle filter is enabled
     * @returns {boolean} True if battle icons should be shown
     */
    getBattleFilterEnabled() {
        return this.state.battle !== false;
    }

    /**
     * Check if a specific dungeon filter is enabled
     * @param {string} dungeonHrid - Dungeon action HRID
     * @returns {boolean} True if this dungeon's badges should be shown
     */
    getDungeonFilterEnabled(dungeonHrid) {
        const dungeon = this.dungeonConfig[dungeonHrid];
        if (!dungeon) return false;

        return this.state.dungeons[dungeon.id] === true;
    }

    /**
     * Check if a specific dungeon badge should be shown
     * @param {string} dungeonHrid - Dungeon action HRID
     * @returns {boolean} True if badge should be shown
     */
    shouldShowDungeonBadge(dungeonHrid) {
        // Must have both battle toggle enabled AND specific dungeon toggle enabled
        return this.getBattleFilterEnabled() && this.getDungeonFilterEnabled(dungeonHrid);
    }
}

// Export singleton instance
const taskIconFilters = new TaskIconFilters();
export default taskIconFilters;
