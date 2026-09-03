/**
 * Combat Zone Indices
 * Shows index numbers on combat zone buttons and task cards
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';

// Compiled regex pattern (created once, reused for performance)
const REGEX_COMBAT_TASK = /(?:Kill|Defeat)\s*-\s*(.+)$/;

/**
 * The DOM this feature annotates, as classes the shared observer can filter on.
 *
 * `RandomTask_name` is the task-card name node `addTaskIndices` writes into.
 * The rest cover `addMapIndices`, whose targets are the combat panel's vertical
 * zone tabs: `CombatPanel_tabsComponentContainer` when the panel is (re)built,
 * `MuiTabs-vertical` when the tab strip alone is replaced, and `MuiTab-root`
 * when a single zone button is inserted into an existing strip. Both callbacks
 * re-scan the whole document, so any one of these firing is enough.
 */
const ZONE_INDEX_CLASSES = ['RandomTask_name', 'CombatPanel_tabsComponentContainer', 'MuiTabs-vertical', 'MuiTab-root'];

/**
 * ZoneIndices class manages zone index display on maps and tasks
 */
class ZoneIndices {
    constructor() {
        this.unregisterObserver = null; // Unregister function from centralized observer
        this.unregisterReady = null;
        this.isActive = false;
        this.monsterZoneCache = null; // Cache monster name -> zone index mapping
        this.taskMapIndexEnabled = false;
        this.mapIndexEnabled = false;
        this.isInitialized = false;
    }

    /**
     * Setup setting change listener (always active, even when feature is disabled)
     */
    setupSettingListener() {
        // Listen for feature toggle changes
        config.onSettingChange('taskMapIndex', () => {
            this.taskMapIndexEnabled = config.getSetting('taskMapIndex');
            if (this.taskMapIndexEnabled || this.mapIndexEnabled) {
                this.initialize();
            } else {
                this.disable();
            }
        });

        config.onSettingChange('mapIndex', () => {
            this.mapIndexEnabled = config.getSetting('mapIndex');
            if (this.taskMapIndexEnabled || this.mapIndexEnabled) {
                this.initialize();
            } else {
                this.disable();
            }
        });

        config.onSettingChange('color_accent', () => {
            if (this.isInitialized) {
                this.refresh();
            }
        });
    }

    /**
     * Initialize zone indices feature
     */
    initialize() {
        // Check if either feature is enabled
        this.taskMapIndexEnabled = config.getSetting('taskMapIndex');
        this.mapIndexEnabled = config.getSetting('mapIndex');

        if (!this.taskMapIndexEnabled && !this.mapIndexEnabled) {
            return;
        }

        if (this.isInitialized) {
            return;
        }

        // Build monster->zone cache once on initialization
        if (this.taskMapIndexEnabled) {
            this.buildMonsterZoneCache();
        }

        // Register with centralized observer, debounced and class-filtered.
        // Unfiltered this ran for every element inserted anywhere on the page.
        this.unregisterObserver = domObserver.onClass(
            'ZoneIndices',
            ZONE_INDEX_CLASSES,
            () => {
                if (this.taskMapIndexEnabled) {
                    this.addTaskIndices();
                }
                if (this.mapIndexEnabled) {
                    this.addMapIndices();
                }
            },
            { debounce: true, debounceDelay: 100 } // Use centralized debouncing
        );

        // Process existing elements. @run-at document-start: elements rendered before the shared
        // observer attaches to document.body are invisible to it, so the catch-up waits for the
        // observer's actual-ready signal (immediate if it is already attached).
        this.unregisterReady = domObserver.onReady('ZoneIndicesCatchUp', () => {
            if (this.taskMapIndexEnabled) {
                this.addTaskIndices();
            }
            if (this.mapIndexEnabled) {
                this.addMapIndices();
            }
        });

        this.isActive = true;
        this.isInitialized = true;
    }

    /**
     * Build a cache of monster names to zone indices
     * Run once on initialization to avoid repeated traversals
     */
    buildMonsterZoneCache() {
        const gameData = dataManager.getInitClientData();
        if (!gameData) {
            return;
        }

        this.monsterZoneCache = new Map();

        for (const action of Object.values(gameData.actionDetailMap)) {
            // Only check combat actions
            if (!action.hrid?.includes('/combat/')) {
                continue;
            }

            const categoryHrid = action.category;
            if (!categoryHrid) {
                continue;
            }

            const category = gameData.actionCategoryDetailMap[categoryHrid];
            const zoneIndex = category?.sortIndex;
            if (!zoneIndex) {
                continue;
            }

            // Cache action name -> zone index
            if (action.name) {
                this.monsterZoneCache.set(action.name.toLowerCase(), zoneIndex);
            }

            // Cache boss names -> zone index
            if (action.combatZoneInfo?.fightInfo?.bossSpawns) {
                for (const boss of action.combatZoneInfo.fightInfo.bossSpawns) {
                    const bossHrid = boss.combatMonsterHrid;
                    if (bossHrid) {
                        const bossName = bossHrid.replace('/monsters/', '').replace(/_/g, ' ');
                        this.monsterZoneCache.set(bossName.toLowerCase(), zoneIndex);
                    }
                }
            }
        }
    }

    /**
     * Add zone indices to task cards
     * Shows "Z5" next to monster kill tasks
     */
    addTaskIndices() {
        // Find all task name elements
        const taskNameElements = document.querySelectorAll('div[class*="RandomTask_name"]');

        for (const nameElement of taskNameElements) {
            const existingIndex = nameElement.querySelector('span.script_taskMapIndex');

            // Read the task text with our own span excluded, so a present
            // index never feeds back into the monster-name parse
            let taskText = '';
            for (const node of nameElement.childNodes) {
                if (node.nodeType === 1 && node.classList?.contains('script_taskMapIndex')) continue;
                taskText += node.textContent;
            }

            // Check if this is a combat task (contains "Kill" or "Defeat");
            // format: "Defeat - Jerry" or "Kill - Monster Name"
            const match =
                taskText.includes('Kill') || taskText.includes('Defeat') ? taskText.match(REGEX_COMBAT_TASK) : null;
            const zoneIndex = match ? this.getZoneIndexForMonster(match[1].trim()) : null;
            const desired = zoneIndex ? `Z${zoneIndex}` : null;

            // Touch the DOM only on an actual change. The always-remove-then-
            // reinsert version was its own mutation source: the observer fired
            // on the reinsert, which reinserted, forever — and each cycle
            // yanked a React-owned node mid-click.
            if (existingIndex && existingIndex.textContent === desired) {
                continue;
            }
            if (existingIndex) {
                existingIndex.remove();
            }
            if (desired) {
                nameElement.insertAdjacentHTML(
                    'beforeend',
                    `<span class="script_taskMapIndex" style="margin-left: 4px; color: ${config.SCRIPT_COLOR_MAIN};">${desired}</span>`
                );
            }
        }
    }

    /**
     * Add sequential indices to combat zone buttons on maps page
     * Shows "1. Zone Name", "2. Zone Name", etc.
     */
    addMapIndices() {
        // Find all combat zone tab buttons
        // Target the vertical tabs in the combat panel
        const buttons = document.querySelectorAll(
            'div.MainPanel_subPanelContainer__1i-H9 div.CombatPanel_tabsComponentContainer__GsQlg div.MuiTabs-root.MuiTabs-vertical button.MuiButtonBase-root.MuiTab-root span.MuiBadge-root'
        );

        if (buttons.length === 0) {
            return;
        }

        // The number is this button's position among all of them — not a
        // count of how many still need labelling. A re-render that keeps some
        // buttons' DOM nodes (spans intact) while inserting a new one further
        // down the row must not skip the counter for the ones it leaves
        // alone, or the new button repeats an earlier number instead of
        // taking its own.
        let index = 1;
        for (const button of buttons) {
            if (!button.querySelector('span.script_mapIndex')) {
                button.insertAdjacentHTML(
                    'afterbegin',
                    `<span class="script_mapIndex" style="color: ${config.SCRIPT_COLOR_MAIN};">${index}. </span>`
                );
            }
            index++;
        }
    }

    /**
     * Get zone index for a monster name
     * @param {string} monsterName - Monster display name
     * @returns {number|null} Zone index or null if not found
     */
    getZoneIndexForMonster(monsterName) {
        // Use cache if available
        if (this.monsterZoneCache) {
            return this.monsterZoneCache.get(monsterName.toLowerCase()) || null;
        }

        // Fallback to direct lookup if cache not built (shouldn't happen)
        const gameData = dataManager.getInitClientData();
        if (!gameData) {
            return null;
        }

        const normalizedName = monsterName.toLowerCase();

        for (const action of Object.values(gameData.actionDetailMap)) {
            if (!action.hrid?.includes('/combat/')) {
                continue;
            }

            if (action.name?.toLowerCase() === normalizedName) {
                const categoryHrid = action.category;
                if (categoryHrid) {
                    const category = gameData.actionCategoryDetailMap[categoryHrid];
                    if (category?.sortIndex) {
                        return category.sortIndex;
                    }
                }
            }

            if (action.combatZoneInfo?.fightInfo?.bossSpawns) {
                for (const boss of action.combatZoneInfo.fightInfo.bossSpawns) {
                    const bossHrid = boss.combatMonsterHrid;
                    if (bossHrid) {
                        const bossName = bossHrid.replace('/monsters/', '').replace(/_/g, ' ');
                        if (bossName === normalizedName) {
                            const categoryHrid = action.category;
                            if (categoryHrid) {
                                const category = gameData.actionCategoryDetailMap[categoryHrid];
                                if (category?.sortIndex) {
                                    return category.sortIndex;
                                }
                            }
                        }
                    }
                }
            }
        }

        return null;
    }

    /**
     * Refresh colors (called when settings change)
     */
    refresh() {
        // Update all existing zone index spans with new color
        const taskIndices = document.querySelectorAll('span.script_taskMapIndex');
        taskIndices.forEach((span) => {
            span.style.color = config.COLOR_ACCENT;
        });

        const mapIndices = document.querySelectorAll('span.script_mapIndex');
        mapIndices.forEach((span) => {
            span.style.color = config.COLOR_ACCENT;
        });
    }

    /**
     * Disable the feature
     */
    disable() {
        try {
            if (this.unregisterObserver) {
                this.unregisterObserver();
                this.unregisterObserver = null;
            }

            if (this.unregisterReady) {
                this.unregisterReady();
                this.unregisterReady = null;
            }

            // Remove all added indices
            const taskIndices = document.querySelectorAll('span.script_taskMapIndex');
            for (const span of taskIndices) {
                span.remove();
            }

            const mapIndices = document.querySelectorAll('span.script_mapIndex');
            for (const span of mapIndices) {
                span.remove();
            }

            // Clear cache
            this.monsterZoneCache = null;
            this.isActive = false;
            this.isInitialized = false;
        } catch (error) {
            console.error('[Zone Indices] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const zoneIndices = new ZoneIndices();

zoneIndices.setupSettingListener();

export { ZONE_INDEX_CLASSES };
export default zoneIndices;
