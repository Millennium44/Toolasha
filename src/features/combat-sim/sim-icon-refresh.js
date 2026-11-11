/** Fill simulator icon spacers without rebuilding controls or disturbing an edited scenario. */
import domObserver from '../../core/dom-observer.js';
import { spriteUrl, onSpriteSheetsLoaded } from '../../utils/overlay-format.js';
import { simEntityIconHtml } from './sim-entity-label.js';

const PENDING = 'span[data-sim-icon-pending]';
const POPUP = '[data-sim-icon-popup]';
// Removed popups and their editors are not retained by this registry.
const popupOwners = new WeakMap();
const panels = new Set();
let pendingSelector = '';
let unregister = null;
let stopSheets = null;
let queued = false;

function isActive(panel) {
    return panel.isConnected && panel.style.display !== 'none';
}

function isOwnedPopup(popup) {
    const owner = popupOwners.get(popup);
    return owner && [...panels].some((panel) => isActive(panel) && panel.contains(owner));
}

function refresh() {
    const pendingSheets = new Set();
    const available = new Map();
    const roots = [...panels].filter(isActive);
    // Pickers and trigger editors are portals under body, not children of the
    // simulator. Only explicitly owned popups of an active panel may refresh.
    if (roots.length) {
        roots.push(...[...document.querySelectorAll(POPUP)].filter(isOwnedPopup));
    }
    for (const root of roots) {
        for (const spacer of root.querySelectorAll(PENDING)) {
            const sheet = spacer.getAttribute('data-sim-icon-pending');
            if (!available.has(sheet)) available.set(sheet, Boolean(spriteUrl(sheet)));
            if (!available.get(sheet)) {
                pendingSheets.add(sheet);
                continue;
            }
            const hrid = spacer.getAttribute('data-sim-item-icon') || spacer.getAttribute('data-sim-entity-icon');
            const template = document.createElement('template');
            template.innerHTML = simEntityIconHtml(hrid);
            const icon = template.content.firstElementChild;
            if (icon?.querySelector('use')) spacer.replaceWith(icon);
        }
    }
    pendingSelector = [...pendingSheets]
        .flatMap((sheet) => [`use[href*="${sheet}_sprite"]`, `use[xlink\\:href*="${sheet}_sprite"]`])
        .join(',');
}

function scheduleRefresh() {
    if (queued) return;
    queued = true;
    // One refresh for an insertion burst. Teardown removes its panel from the set
    // before this runs, so queued work cannot redraw a closed/destroyed panel.
    queueMicrotask(() => {
        queued = false;
        refresh();
    });
}

function containsMatch(node, selector) {
    return node.matches(selector) || (node.childElementCount > 0 && Boolean(node.querySelector(selector)));
}

function onAdded(node) {
    // Newly rendered editor/results/picker rows may introduce another missing sheet.
    // Once artwork is complete, unrelated game updates need only these cheap containment checks.
    for (const panel of panels) {
        if ((panel.contains(node) || node.contains(panel)) && containsMatch(node, PENDING)) {
            scheduleRefresh();
            return;
        }
    }
    const popup = node.closest(POPUP);
    if (popup && isOwnedPopup(popup) && containsMatch(node, PENDING)) {
        scheduleRefresh();
        return;
    }
    if (pendingSelector && containsMatch(node, pendingSelector)) scheduleRefresh();
}

/**
 * Keep a visible simulator's pending icons current using the existing shared DOM observer.
 * Both simulators share one subscription; there is no new observer, timer, or asset request.
 * Call the returned disposer on hide/destroy. Reopening catches assets loaded while hidden.
 * @param {HTMLElement} panel - Mounted simulator panel
 * @returns {Function} Idempotent cleanup
 */
export function watchSimIconRefresh(panel) {
    panels.add(panel);
    if (!unregister) unregister = domObserver.register('sim-icon-refresh', onAdded);
    // A sheet the game never fetched is read from its script after a moment; redraw then
    if (!stopSheets) stopSheets = onSpriteSheetsLoaded(scheduleRefresh);
    refresh();
    let stopped = false;
    return () => {
        if (stopped) return;
        stopped = true;
        panels.delete(panel);
        if (!panels.size) {
            unregister?.();
            unregister = null;
            stopSheets?.();
            stopSheets = null;
            pendingSelector = '';
        }
    };
}

/**
 * Associate a body-mounted editor popup with its actual owner, not a reusable panel ID.
 * Popup removal needs no subscription cleanup: weak ownership does not retain it, and
 * refresh scans mounted popups only. The owner's hide/destroy disposer gates all its popups.
 * @param {HTMLElement} popup - Editor picker or trigger popup
 * @param {HTMLElement} owner - The editor's container inside its simulator panel
 */
export function registerSimIconPopup(popup, owner) {
    popupOwners.set(popup, owner);
    popup.setAttribute('data-sim-icon-popup', '');
    if (panels.size) scheduleRefresh();
}
