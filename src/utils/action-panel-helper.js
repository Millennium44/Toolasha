/**
 * Action Panel Display Helper
 * Utilities for working with action detail panels (gathering, production, enhancement)
 */

import dataManager from '../core/data-manager.js';
import domObserver from '../core/dom-observer.js';
import { getActionHridFromName } from './game-lookups.js';

/** The action detail panels currently mounted */
const PANEL_SELECTOR = '[class*="SkillActionDetail_skillActionDetail"]';

/** The class substring every action detail panel carries */
const DETAIL_PANEL_CLASS = 'SkillActionDetail_skillActionDetail';

/** The class substring every skill-screen action tile carries */
const ACTION_TILE_CLASS = 'SkillAction_skillAction';

/** How long after the last `actions_updated` the shared refresh runs */
const REFRESH_DEBOUNCE_MS = 200;

/**
 * Find the action count input field within a panel
 * @param {HTMLElement} panel - The action detail panel
 * @returns {HTMLInputElement|null} The input element or null if not found
 */
export function findActionInput(panel) {
    const inputContainer = panel.querySelector('[class*="maxActionCountInput"]');
    if (!inputContainer) {
        return null;
    }

    const inputField = inputContainer.querySelector('input');
    return inputField || null;
}

/**
 * Attach input listeners to an action panel for tracking value changes
 * Sets up three listeners:
 * - keyup: For manual typing
 * - input: For quick input button clicks (React dispatches input events)
 * - panel click: For any panel interactions with 50ms delay
 *
 * @param {HTMLElement} panel - The action detail panel
 * @param {HTMLInputElement} input - The input element
 * @param {Function} updateCallback - Callback function(value) called on input changes
 * @param {Object} options - Optional configuration
 * @param {number} options.clickDelay - Delay in ms for panel click handler (default: 50)
 * @returns {Function} Cleanup function to remove all listeners
 */
export function attachInputListeners(panel, input, updateCallback, options = {}) {
    const { clickDelay = 50 } = options;

    // Handler for keyup and input events
    const updateHandler = () => {
        updateCallback(input.value);
    };

    // Handler for panel clicks (with delay to allow React updates)
    const panelClickHandler = (event) => {
        // Skip if click is on the input box itself
        if (event.target === input) {
            return;
        }
        setTimeout(() => {
            updateCallback(input.value);
        }, clickDelay);
    };

    // Attach all listeners
    input.addEventListener('keyup', updateHandler);
    input.addEventListener('input', updateHandler);
    panel.addEventListener('click', panelClickHandler);

    // Return cleanup function
    return () => {
        input.removeEventListener('keyup', updateHandler);
        input.removeEventListener('input', updateHandler);
        panel.removeEventListener('click', panelClickHandler);
    };
}

/**
 * Perform initial update if input already has a valid value
 * @param {HTMLInputElement} input - The input element
 * @param {Function} updateCallback - Callback function(value) called if valid
 * @returns {boolean} True if initial update was performed
 */
export function performInitialUpdate(input, updateCallback) {
    if (input.value) {
        updateCallback(input.value);
        return true;
    }
    return false;
}

/**
 * Re-run updateCallback for every mounted action panel with its current input
 * value. For data events (dataManager's 'actions_updated') that invalidate a
 * panel's queue-aware figures without the input changing, so the display does
 * not wait for an incidental click, edit or remount to catch up.
 * @param {Function} updateCallback - (panel, value) => void, the shape attachInputListeners takes
 */
export function refreshActionPanels(updateCallback) {
    const panels = document.querySelectorAll(PANEL_SELECTOR);
    panels.forEach((panel) => {
        const inputField = findActionInput(panel);
        if (!inputField) return;
        updateCallback(panel, inputField.value);
    });
}

/** Callbacks for the shared `actions_updated` refresh, in registration order */
const refreshCallbacks = new Set();
let refreshTimer = null;
let actionsUpdatedHandler = null;

/**
 * One scan of the mounted panels, fanned out to every registered callback.
 * @private
 */
function runSharedRefresh() {
    refreshTimer = null;
    if (refreshCallbacks.size === 0) return;
    const panels = document.querySelectorAll(PANEL_SELECTOR);
    panels.forEach((panel) => {
        const inputField = findActionInput(panel);
        if (!inputField) return;
        const value = inputField.value;
        for (const callback of refreshCallbacks) {
            try {
                callback(panel, value);
            } catch (error) {
                console.error('[ActionPanelHelper] Refresh callback failed:', error);
            }
        }
    });
}

/**
 * Re-run `callback` for every mounted action panel whenever the action queue
 * changes — through one debounced `actions_updated` subscription and one
 * document scan shared by every feature that asks, rather than a subscription
 * and a scan apiece. The queue changes arrive in bursts (an action finishing
 * sends several), and each subscriber used to rescan the document for each.
 *
 * @param {Function} callback - (panel, value) => void, the shape `refreshActionPanels` takes
 * @returns {Function} Unsubscribe
 */
export function onActionPanelsRefresh(callback) {
    refreshCallbacks.add(callback);
    if (!actionsUpdatedHandler) {
        actionsUpdatedHandler = () => {
            if (refreshTimer) clearTimeout(refreshTimer);
            refreshTimer = setTimeout(runSharedRefresh, REFRESH_DEBOUNCE_MS);
        };
        dataManager.on('actions_updated', actionsUpdatedHandler);
    }
    return () => {
        refreshCallbacks.delete(callback);
        if (refreshCallbacks.size > 0) return;
        if (actionsUpdatedHandler) {
            dataManager.off('actions_updated', actionsUpdatedHandler);
            actionsUpdatedHandler = null;
        }
        if (refreshTimer) {
            clearTimeout(refreshTimer);
            refreshTimer = null;
        }
    };
}

/**
 * @typedef {Object} ActionPanelContext
 * @property {HTMLElement} panel - The detail panel or action tile
 * @property {HTMLElement|null} nameElement - The element carrying the action title
 * @property {string} actionName - The title's own text (direct text nodes only, so
 *   a span injected into the title by a feature does not poison the lookup)
 * @property {string|null} actionHrid - The action the title names, or null
 * @property {Object|null} actionDetails - dataManager's details for that action, or null
 */

/**
 * One shared `domObserver.onClass` per panel class, resolving the action
 * behind a panel once and fanning out to every subscriber.
 *
 * Eleven features used to watch the two panel classes separately, and each
 * re-ran the same title query and name → hrid lookup on every panel that
 * appeared — a skill screen of forty tiles cost forty-odd such derivations
 * per feature. Now the title is read once per panel per appearance and the
 * hrid is remembered per element (a WeakMap, re-resolved only when the title
 * text changes, as it does when React reuses a panel for another action).
 *
 * Subscribers run in subscription order, which is what the features'
 * registration order used to decide; several inject elements relative to
 * one another and rely on it. The class handler is registered on the first
 * subscription and removed with the last, so an unsubscribe-resubscribe
 * cycle lands where a fresh registration would have.
 * @private
 */
class ActionPanelDispatcher {
    /**
     * @param {string} name - Handler name for the observer's diagnostics
     * @param {string} className - Class substring of the panels to watch
     * @param {string} nameSelector - Selector of the title element inside a panel
     */
    constructor(name, className, nameSelector) {
        this.name = name;
        this.className = className;
        this.nameSelector = nameSelector;
        this.subscribers = [];
        this.unregister = null;
        /** @type {WeakMap<HTMLElement, {actionName: string, actionHrid: string}>} */
        this.cache = new WeakMap();
    }

    /**
     * Resolve the action behind a panel, from the per-element cache when the
     * title has not changed since last time.
     * @param {HTMLElement} panel
     * @returns {ActionPanelContext}
     */
    resolve(panel) {
        const nameElement = panel.querySelector(this.nameSelector);
        const actionName = nameElement ? directText(nameElement) : '';
        let actionHrid = null;
        if (actionName) {
            const cached = this.cache.get(panel);
            if (cached && cached.actionName === actionName) {
                actionHrid = cached.actionHrid;
            } else {
                actionHrid = getActionHridFromName(actionName);
                // A miss is not remembered: the game data it needs may simply
                // not have arrived yet, and the lookup itself is a Map.get
                if (actionHrid) this.cache.set(panel, { actionName, actionHrid });
            }
        }
        const actionDetails = actionHrid ? dataManager.getActionDetails(actionHrid) : null;
        return { panel, nameElement, actionName, actionHrid, actionDetails };
    }

    /**
     * Hand one appeared panel to every subscriber, in order. A subscriber that
     * throws is reported and skipped, as it would be were it its own handler.
     * @param {HTMLElement} panel
     */
    dispatch(panel) {
        const context = this.resolve(panel);
        // A snapshot, so a subscriber unsubscribing mid-dispatch does not
        // shift the ones after it
        for (const callback of [...this.subscribers]) {
            try {
                callback(context);
            } catch (error) {
                console.error(`[ActionPanelHelper] ${this.name} subscriber failed:`, error);
            }
        }
    }

    /**
     * @param {Function} callback - (context: ActionPanelContext) => void
     * @returns {Function} Unsubscribe
     */
    subscribe(callback) {
        this.subscribers.push(callback);
        if (!this.unregister) {
            this.unregister = domObserver.onClass(this.name, this.className, (panel) => this.dispatch(panel));
        }
        let active = true;
        return () => {
            if (!active) return;
            active = false;
            const index = this.subscribers.indexOf(callback);
            if (index > -1) this.subscribers.splice(index, 1);
            if (this.subscribers.length === 0 && this.unregister) {
                this.unregister();
                this.unregister = null;
            }
        };
    }
}

/**
 * The element's own text — direct text nodes only, trimmed
 * @param {HTMLElement} element
 * @returns {string}
 */
function directText(element) {
    let text = '';
    for (const node of element.childNodes) {
        if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return text.trim();
}

const detailPanels = new ActionPanelDispatcher(
    'ActionPanelHelper-DetailPanel',
    DETAIL_PANEL_CLASS,
    '[class*="SkillActionDetail_name"]'
);
const actionTiles = new ActionPanelDispatcher(
    'ActionPanelHelper-ActionTile',
    ACTION_TILE_CLASS,
    '[class*="SkillAction_name"]'
);

/**
 * Run `callback` for every action detail panel (the modal opened from a skill
 * tile) as it appears, with the action behind it already resolved.
 * @param {Function} callback - (context: ActionPanelContext) => void
 * @returns {Function} Unsubscribe
 */
export function onDetailPanel(callback) {
    return detailPanels.subscribe(callback);
}

/**
 * Run `callback` for every skill-screen action tile as it appears, with the
 * action behind it already resolved.
 * @param {Function} callback - (context: ActionPanelContext) => void
 * @returns {Function} Unsubscribe
 */
export function onActionTile(callback) {
    return actionTiles.subscribe(callback);
}

/**
 * Resolve the action behind a detail panel already on the page — for initial
 * scans and for input handlers that run after the title may have changed.
 * Shares the subscribers' cache.
 * @param {HTMLElement} panel
 * @returns {ActionPanelContext}
 */
export function resolveDetailPanel(panel) {
    return detailPanels.resolve(panel);
}

/**
 * Resolve the action behind an action tile already on the page.
 * Shares the subscribers' cache.
 * @param {HTMLElement} tile
 * @returns {ActionPanelContext}
 */
export function resolveActionTile(tile) {
    return actionTiles.resolve(tile);
}
