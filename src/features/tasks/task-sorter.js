/**
 * Task Sorter
 * Sorts tasks in the task board by skill type
 */

import { GAME, TOOLASHA } from '../../utils/selectors.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import taskIcons from './task-icons.js';
import taskIconFilters from './task-icon-filters.js';
import taskRerollProtection from './task-reroll-protection.js';
import domObserver from '../../core/dom-observer.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

class TaskSorter {
    constructor() {
        this.initialized = false;
        this.sortButton = null;
        this.unregisterObserver = null;
        this.timerRegistry = createTimerRegistry();
        this.readClickHandler = null;
        this.settleObserver = null;

        // Task type ordering (combat tasks go to bottom)
        this.TASK_ORDER = {
            Milking: 1,
            Foraging: 2,
            Woodcutting: 3,
            Cheesesmithing: 4,
            Crafting: 5,
            Tailoring: 6,
            Cooking: 7,
            Brewing: 8,
            Alchemy: 9,
            Enhancing: 10,
            Defeat: 99, // Combat tasks at bottom
        };
    }

    /**
     * Initialize the task sorter
     */
    initialize() {
        if (this.initialized) return;

        // Use DOM observer to watch for task panel appearing
        this.watchTaskPanel();
        this.watchReadButton();

        this.initialized = true;
    }

    /**
     * Sort again once tasks have been read.
     *
     * Reading is the one moment the board is guaranteed to be out of order:
     * new tasks arrive at the end, however the rest was arranged. Auto-sort on
     * open does not cover it, because the panel is already open — so somebody
     * with a sorted board watches it come apart every few hours and has to
     * press the button again.
     *
     * Delegated from the document rather than bound to the button, because the
     * card holding it is drawn and thrown away by the game each time the unread
     * count changes, and a listener bound to one instance of it lasts until the
     * next render.
     */
    watchReadButton() {
        this.readClickHandler = (event) => {
            if (!config.getSetting('taskSorter_sortAfterRead')) return;

            const button = event.target?.closest?.('button');
            if (!button || button.textContent.trim() !== 'Read') return;
            // Matched by its words rather than by a class, which the game
            // renames on any build
            if (!button.closest('[class*="TasksPanel_"]')) return;

            this.sortAfterTasksArrive();
        };
        // Capture, so it is seen before React tears the card down
        document.addEventListener('click', this.readClickHandler, true);
    }

    /**
     * Sort once the new tasks have finished arriving.
     *
     * A fixed delay is a guess about how long the game takes to draw several
     * cards, and the guess is wrong on a slow machine — which shows as a board
     * that sorted everything except the tasks that were just read. So it waits
     * for the list to stop changing instead, and gives up rather than watching
     * forever.
     */
    sortAfterTasksArrive() {
        this.stopSettleWatch();

        // Sorts what is on the board straight away, so the common case — the
        // cards are already there — is not held up waiting for a change that
        // has already happened
        const now = setTimeout(() => this.sortTasks(), 150);
        this.timerRegistry.registerTimeout(now);

        const taskList = document.querySelector(GAME.TASK_LIST);
        if (!taskList) return;

        // Then again as the new tasks land. A single delay is a guess about how
        // long the game takes to draw several cards, and on a slow machine the
        // guess fires first — which shows as a board that sorted everything
        // except the tasks that were just read. Sorting twice costs nothing; the
        // second pass on an already-sorted board changes nothing.
        let settleTimeout = null;
        this.settleObserver = new MutationObserver(() => {
            clearTimeout(settleTimeout);
            settleTimeout = setTimeout(() => this.sortTasks(), 250);
            this.timerRegistry.registerTimeout(settleTimeout);
        });
        this.settleObserver.observe(taskList, { childList: true, subtree: true });

        // It stops watching rather than watching forever — every later sort is
        // the button's job again
        const giveUp = setTimeout(() => this.stopSettleWatch(), 3000);
        this.timerRegistry.registerTimeout(giveUp);
    }

    /** Stop watching the task list for new cards */
    stopSettleWatch() {
        if (this.settleObserver) {
            this.settleObserver.disconnect();
            this.settleObserver = null;
        }
    }

    /**
     * Watch for task panel to appear
     */
    watchTaskPanel() {
        // Register observer for task panel header (watch for the class name, not the selector)
        this.unregisterObserver = domObserver.onClass(
            'TaskSorter',
            'TasksPanel_taskSlotCount', // Just the class name, not [class*="..."]
            (headerElement) => {
                this.addSortButton(headerElement);
            }
        );
    }

    /**
     * Add sort button to task panel header
     */
    addSortButton(headerElement) {
        // Check if button already exists
        if (this.sortButton && document.contains(this.sortButton)) {
            return;
        }

        // Create and insert sort button (skipped if user has chosen to hide it)
        if (!config.getSetting('taskSorter_hideButton')) {
            this.sortButton = document.createElement('button');
            this.sortButton.className = 'Button_button__1Fe9z Button_small__3fqC7';
            this.sortButton.textContent = 'Sort Tasks';
            this.sortButton.style.marginLeft = '8px';
            this.sortButton.setAttribute('data-mwi-task-sort', 'true');
            this.sortButton.addEventListener('click', () => this.sortTasks());
            headerElement.appendChild(this.sortButton);
        }

        // Add task icon filters if enabled
        if (config.isFeatureEnabled('taskIcons')) {
            taskIconFilters.addFilterBar(headerElement);
        }

        // Auto-sort if setting is enabled
        if (config.getSetting('taskSorter_autoSort')) {
            // Delay slightly to ensure all task cards are rendered
            const autoSortTimeout = setTimeout(() => {
                this.sortTasks();
            }, 100);
            this.timerRegistry.registerTimeout(autoSortTimeout);
        }
    }

    /**
     * Parse task card to extract skill type and task name
     */
    parseTaskCard(taskCard) {
        const nameElement = taskCard.querySelector('[class*="RandomTask_name"]');
        if (!nameElement) return null;

        const fullText = nameElement.textContent.trim();

        // Format is "SkillType - TaskName"
        const match = fullText.match(/^(.+?)\s*-\s*(.+)$/);
        if (!match) return null;

        const [, skillType, taskName] = match;

        return {
            skillType: skillType.trim(),
            taskName: taskName.trim(),
            fullText,
        };
    }

    /**
     * Check if task is completed (has Claim Reward button)
     */
    isTaskCompleted(taskCard) {
        const claimButton = taskCard.querySelector('button.Button_button__1Fe9z.Button_buy__3s24l');
        return claimButton && claimButton.textContent.includes('Claim Reward');
    }

    /**
     * Get sort order for a task
     */
    getTaskOrder(taskCard) {
        const parsed = this.parseTaskCard(taskCard);
        if (!parsed) {
            return { skillOrder: 999, taskName: '', isCombat: false, monsterSortIndex: 999, isCompleted: false };
        }

        const skillOrder = this.TASK_ORDER[parsed.skillType] || 999;
        const isCombat = parsed.skillType === 'Defeat';
        const isCompleted = this.isTaskCompleted(taskCard);

        // For combat tasks, get monster sort index from game data
        let monsterSortIndex = 999;
        if (isCombat) {
            // Extract monster name from task name (e.g., "Granite GolemZ9" -> "Granite Golem")
            const monsterName = this.extractMonsterName(parsed.taskName);
            if (monsterName) {
                const monsterHrid = dataManager.getMonsterHridFromName(monsterName);
                if (monsterHrid) {
                    monsterSortIndex = dataManager.getMonsterSortIndex(monsterHrid);
                }
            }
        }

        return {
            skillOrder,
            taskName: parsed.taskName,
            skillType: parsed.skillType,
            isCombat,
            monsterSortIndex,
            isCompleted,
        };
    }

    /**
     * Extract monster name from combat task name
     * @param {string} taskName - Task name (e.g., "Granite Golem Z9")
     * @returns {string|null} Monster name or null if not found
     */
    extractMonsterName(taskName) {
        // Combat task format from parseTaskCard: "[Monster Name]Z[number]" (may or may not have space)
        // Strip the zone suffix "Z\d+" from the end
        const match = taskName.match(/^(.+?)\s*Z\d+$/);
        if (match) {
            return match[1].trim();
        }

        // Fallback: return as-is if no zone suffix found
        return taskName.trim();
    }

    /**
     * Compare two task cards by time to completion (ascending).
     * Combat tasks and tasks with no profit data sort to the bottom,
     * followed by completed tasks at the very bottom.
     * Combat tasks among themselves are sorted by zone (same as skill sort).
     */
    compareTaskCardsByTime(cardA, cardB) {
        const orderA = this.getTaskOrder(cardA);
        const orderB = this.getTaskOrder(cardB);

        // Completed tasks always first
        if (orderA.isCompleted !== orderB.isCompleted) {
            return orderA.isCompleted ? -1 : 1;
        }
        const profitA = cardA.querySelector(TOOLASHA.TASK_PROFIT);
        const profitB = cardB.querySelector(TOOLASHA.TASK_PROFIT);
        const secondsA = profitA?.dataset.completionSeconds ? parseFloat(profitA.dataset.completionSeconds) : null;
        const secondsB = profitB?.dataset.completionSeconds ? parseFloat(profitB.dataset.completionSeconds) : null;

        const noTimeA = secondsA === null || orderA.isCombat;
        const noTimeB = secondsB === null || orderB.isCombat;

        // No-time tasks (combat, unknown) after timed tasks
        if (noTimeA !== noTimeB) {
            return noTimeA ? 1 : -1;
        }

        // Both have no time — fall back to skill/zone sort among themselves
        if (noTimeA && noTimeB) {
            return this.compareTaskCards(cardA, cardB);
        }

        // Both have time — sort ascending
        return secondsA - secondsB;
    }

    /**
     * Compare two task cards for sorting
     */
    compareTaskCards(cardA, cardB) {
        const orderA = this.getTaskOrder(cardA);
        const orderB = this.getTaskOrder(cardB);

        // First: Sort by completion status (completed tasks first, incomplete tasks last)
        if (orderA.isCompleted !== orderB.isCompleted) {
            return orderA.isCompleted ? -1 : 1;
        }

        // Second: Sort by skill type (combat vs non-combat)
        if (orderA.skillOrder !== orderB.skillOrder) {
            return orderA.skillOrder - orderB.skillOrder;
        }

        // Third: Within combat tasks, sort by zone progression (sortIndex)
        if (orderA.isCombat && orderB.isCombat) {
            if (orderA.monsterSortIndex !== orderB.monsterSortIndex) {
                return orderA.monsterSortIndex - orderB.monsterSortIndex;
            }
        }

        // Fourth: Within same skill type (or same zone for combat), sort alphabetically by task name
        return orderA.taskName.localeCompare(orderB.taskName);
    }

    /**
     * Compare two task cards by protection status (unprotected first), then Skill/Zone.
     */
    compareTaskCardsByProtection(cardA, cardB) {
        const protectedA = taskRerollProtection.isTaskProtected(cardA);
        const protectedB = taskRerollProtection.isTaskProtected(cardB);

        if (protectedA !== protectedB) {
            return protectedA ? 1 : -1;
        }

        return this.compareTaskCards(cardA, cardB);
    }

    /**
     * Sort all tasks in the task board
     */
    sortTasks() {
        const taskList = document.querySelector(GAME.TASK_LIST);
        if (!taskList) {
            return;
        }

        // Get all task cards
        const taskCards = Array.from(taskList.querySelectorAll(GAME.TASK_CARD));
        if (taskCards.length === 0) {
            return;
        }

        // Sort the cards
        const sortMode = config.getSettingValue('taskSorter_sortMode', 'skill');
        if (sortMode === 'time') {
            taskCards.sort((a, b) => this.compareTaskCardsByTime(a, b));
        } else if (sortMode === 'protection') {
            taskCards.sort((a, b) => this.compareTaskCardsByProtection(a, b));
        } else {
            taskCards.sort((a, b) => this.compareTaskCards(a, b));
        }

        // Re-append in sorted order
        taskCards.forEach((card) => taskList.appendChild(card));

        // After sorting, React may re-render task cards and remove our icons
        // Clear the processed markers and force icon re-processing
        if (config.isFeatureEnabled('taskIcons')) {
            // Use taskIcons module's method to clear markers
            taskIcons.clearAllProcessedMarkers();

            // Trigger icon re-processing
            // Use setTimeout to ensure React has finished any re-rendering
            const iconTimeout = setTimeout(() => {
                taskIcons.processAllTaskCards();
            }, 100);
            this.timerRegistry.registerTimeout(iconTimeout);
        }
    }

    /**
     * Cleanup
     */
    cleanup() {
        if (this.unregisterObserver) {
            this.unregisterObserver();
            this.unregisterObserver = null;
        }

        if (this.sortButton && document.contains(this.sortButton)) {
            this.sortButton.remove();
        }
        this.sortButton = null;

        if (this.readClickHandler) {
            document.removeEventListener('click', this.readClickHandler, true);
            this.readClickHandler = null;
        }
        this.stopSettleWatch();

        this.timerRegistry.clearAll();
        this.initialized = false;
    }

    disable() {
        this.cleanup();
    }
}

const taskSorter = new TaskSorter();

export default taskSorter;
