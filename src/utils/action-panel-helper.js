/**
 * Action Panel Display Helper
 * Utilities for working with action detail panels (gathering, production, enhancement)
 */

import dataManager from '../core/data-manager.js';

/** The action detail panels currently mounted */
const PANEL_SELECTOR = '[class*="SkillActionDetail_skillActionDetail"]';

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
