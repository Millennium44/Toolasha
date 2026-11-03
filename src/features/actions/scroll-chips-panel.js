/**
 * Scroll chips panel
 *
 * Puts the scroll chips (`scroll-chips.js`) on every gathering and production action panel, once.
 * The chips used to be drawn inside the profit section, which is absent whenever profit cannot
 * be drawn (an untradable output such as a refined cape, the profit detail switched off, a failed
 * calculation), so the player could not choose the simulated scrolls on exactly the panels whose
 * Action Speed & Time and Level Progress figures they change.
 *
 * ## Placement
 *
 * One row, directly under the quick-input, Action Speed & Time and Level Progress block that
 * `quick-input-buttons.js` puts after the game's quantity field: the figures the chips change sit
 * right above them, and the row is the same wherever the profit section is. The block is found by
 * its markers (`.mwi-collapsible-section`, `.mwi-quick-input-btn`), never by text, so a translated
 * client places it the same way.
 *
 * ## Staying right
 *
 * The game reuses a panel for another action (the title changes, the contents are swapped), and
 * Toolasha's own sections come and go below the quantity field, so each panel is watched and the
 * row is re-checked after a quiet moment: built for the current action type, rebuilt when the type
 * changes, removed when none applies, moved when the sections around it moved. A check that finds
 * everything in place writes nothing, so the watch does not feed itself.
 */

import config from '../../core/config.js';
import { onDetailPanel, resolveDetailPanel } from '../../utils/action-panel-helper.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { buildScrollChips, SCROLL_CHIPS_CLASS, SIMULATED_ACTION_TYPES } from './scroll-chips.js';

/** How long a panel must be quiet before it is re-checked */
const RECHECK_DELAY_MS = 100;

/**
 * Markers of the blocks `quick-input-buttons.js` inserts after the quantity field: its sections, its
 * buttons, and the container that holds the "Do ... times" rows (which can be empty, so it is
 * recognized by its own class as well as by what is in it).
 */
const TOOLASHA_BLOCK_SELECTOR = '.mwi-collapsible-section, .mwi-quick-input-btn, .mwi-quick-input-rows';

/**
 * The profit section is also a `.mwi-collapsible-section`, but it belongs below the chips: the row
 * sits above it, directly under Level Progress, so it never lands under an expanded breakdown.
 */
const PROFIT_SELECTOR = '[data-mwi-profit-display]';

const timers = createTimerRegistry();

/**
 * @typedef {Object} PanelState
 * @property {MutationObserver} observer
 * @property {number|null} timer - Pending re-check
 * @property {{element: HTMLElement, dispose: () => void}|null} chips - The row drawn now
 * @property {string|null} type - Action type the row was built for
 */

/** @type {Map<HTMLElement, PanelState>} */
const panels = new Map();
let unsubscribePanels = null;

/**
 * The element the game's quantity field sits in; Toolasha's sections go right after it. Only the
 * game's own Repeat box counts: the Current Action tab has none (see the "no Repeat box" branch in
 * `profit-display.js`), and any other number field on the panel (the crafting plan's gold per hour)
 * would anchor the row to the wrong place.
 * @param {HTMLElement} panel
 * @returns {HTMLElement|null}
 */
function findInputContainer(panel) {
    const input = panel.querySelector('[class*="maxActionCountInput"] input');
    return input?.parentNode?.parentNode?.parentNode || null;
}

function isToolashaBlock(element) {
    if (element.matches?.(PROFIT_SELECTOR)) return false;
    return element.matches?.(TOOLASHA_BLOCK_SELECTOR) || Boolean(element.querySelector?.('.mwi-quick-input-btn'));
}

/**
 * Where the row goes, as the element it follows or precedes, or null when the panel has no place
 * for it yet:
 * 1. right after the block of Toolasha sections that follows the quantity field;
 * 2. with no quantity field (the Current Action tab), right before the profit section;
 * 3. failing both, right before the game's Start / Stop buttons.
 * @param {HTMLElement} panel
 * @param {HTMLElement} row
 * @returns {{target: HTMLElement, position: 'afterend'|'beforebegin'}|null}
 */
function findSlot(panel, row) {
    const inputContainer = findInputContainer(panel);
    if (inputContainer) {
        let anchor = inputContainer;
        for (let next = inputContainer.nextElementSibling; next && next !== row; next = next.nextElementSibling) {
            if (!isToolashaBlock(next)) break;
            anchor = next;
        }
        return { target: anchor, position: 'afterend' };
    }
    const profit = panel.querySelector(PROFIT_SELECTOR);
    if (profit) return { target: profit, position: 'beforebegin' };
    const buttons = panel.querySelector('[class*="SkillActionDetail_buttonsContainer"]');
    return buttons ? { target: buttons, position: 'beforebegin' } : null;
}

/**
 * Put the row in its slot. A row already there stays, so a check that finds it in place writes
 * nothing.
 * @param {{target: HTMLElement, position: 'afterend'|'beforebegin'}} slot
 * @param {HTMLElement} row
 */
function placeRow(slot, row) {
    const { target, position } = slot;
    const inPlace = position === 'afterend' ? row.previousElementSibling === target : row.nextElementSibling === target;
    if (!inPlace) target.insertAdjacentElement(position, row);
}

/**
 * The action type a panel's row should be built for, or null when it should have none.
 * @param {HTMLElement} panel
 * @returns {string|null}
 */
function wantedType(panel) {
    if (!config.getSetting('simulateScrollEffects')) return null;
    const type = resolveDetailPanel(panel).actionDetails?.type;
    if (!type || !SIMULATED_ACTION_TYPES.includes(type)) return null;
    return type;
}

function removeRow(state) {
    state.chips?.dispose();
    state.chips?.element.remove();
    state.chips = null;
    state.type = null;
}

/**
 * Bring a panel's row in line with the panel: the right row for the action, in the right place.
 * @param {HTMLElement} panel
 * @param {Object} [options]
 * @param {boolean} [options.rebuild] - Draw the row again even when it is for the right type
 */
function sync(panel, { rebuild = false } = {}) {
    const state = panels.get(panel);
    if (!state) return;
    if (!panel.isConnected) {
        detach(panel);
        return;
    }
    const type = wantedType(panel);
    const slot = type ? findSlot(panel, state.chips?.element ?? null) : null;
    if (!type || !slot) {
        if (state.chips) removeRow(state);
        return;
    }
    if (state.chips && (rebuild || state.type !== type || !state.chips.element.isConnected)) {
        removeRow(state);
    }
    if (!state.chips) {
        const chips = buildScrollChips({
            actionTypeHrid: type,
            // A saved toggle, or a selection changed elsewhere: draw the row again from the new state
            onChange: () => sync(panel, { rebuild: true }),
        });
        if (!chips) return;
        state.chips = chips;
        state.type = type;
    }
    placeRow(findSlot(panel, state.chips.element) ?? slot, state.chips.element);
}

function schedule(panel) {
    const state = panels.get(panel);
    if (!state || state.timer !== null) return;
    state.timer = timers.scheduleTimeout(
        () => {
            state.timer = null;
            sync(panel);
        },
        RECHECK_DELAY_MS,
        'scroll-chips-panel'
    );
}

/**
 * Whether a mutation came from Toolasha's own drawing (a section or the chip row itself), which
 * cannot change what the row should be.
 * @param {MutationRecord} record
 * @returns {boolean}
 */
function isOwnMutation(record) {
    const target = record.target.nodeType === 1 ? record.target : record.target.parentElement;
    return Boolean(target?.closest?.(`.${SCROLL_CHIPS_CLASS}, .mwi-collapsible-section`));
}

function attach(panel) {
    if (!panel || panels.has(panel)) {
        if (panel && panels.has(panel)) schedule(panel);
        return;
    }
    // A row left over from an earlier life of this feature is not ours to keep
    panel.querySelectorAll(`.${SCROLL_CHIPS_CLASS}`).forEach((stray) => stray.remove());
    for (const known of [...panels.keys()]) {
        if (!known.isConnected) detach(known);
    }
    const observer = new MutationObserver((records) => {
        if (records.some((record) => !isOwnMutation(record))) schedule(panel);
    });
    observer.observe(panel, { childList: true, subtree: true, characterData: true });
    panels.set(panel, { observer, timer: null, chips: null, type: null });
    sync(panel);
}

function detach(panel) {
    const state = panels.get(panel);
    if (!state) return;
    panels.delete(panel);
    state.observer.disconnect();
    if (state.timer !== null) timers.cancelTimeout(state.timer);
    removeRow(state);
}

function isRunning() {
    return unsubscribePanels !== null;
}

export default {
    name: 'Scroll Chips',

    initialize() {
        if (isRunning() || !config.getSetting('simulateScrollEffects')) return;
        unsubscribePanels = onDetailPanel((context) => attach(context.panel));
        document
            .querySelectorAll('[class*="SkillActionDetail_skillActionDetail"]')
            .forEach((existing) => attach(existing));
    },

    isRunning,

    cleanup() {
        if (unsubscribePanels) {
            unsubscribePanels();
            unsubscribePanels = null;
        }
        for (const panel of [...panels.keys()]) detach(panel);
        timers.clearAll();
    },
};
