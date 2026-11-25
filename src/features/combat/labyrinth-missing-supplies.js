/**
 * Labyrinth Missing Supplies Button
 *
 * Replaces the Labyrinth entry screen's "Supplies" label with a "Buy supplies" button that opens the
 * Consumables panel on its Labyrinth tab. That tab lists what the next runs need (Torch/Shroud/Beacon
 * and selected crates) against what the bag holds, sized to the panel's run target, and its Buy-all
 * walk opens the recommended buy forms one at a time. The panel is reached through the bundle bridge
 * (it lives in the UI bundle); nothing is bought until the player confirms in the game's own form.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { consumablesPanel } from '../../utils/bundle-bridge.js';
import { showToast } from '../../utils/toast.js';

const BUTTON_CLASS = 'mwi-labyrinth-missing-supplies-button';
const SETTING_KEY = 'labyrinthMissingSuppliesButton';

/** Open the Consumables panel on its Labyrinth tab (opens it, or switches tab; never closes it). */
export function handleClick() {
    const panel = consumablesPanel();
    if (!panel) {
        // The UI bundle publishes the panel a moment after load; say so rather than ignore the press
        showToast('The Consumables panel is still loading. Try again in a moment.');
        return;
    }
    panel.openTab('labyrinth');
}

const HIDDEN_LABEL_ATTR = 'data-mwi-lab-supplies-label-hidden';

/**
 * True when the element carries a class of exactly this game prefix (`Prefix__hash`), not merely a class
 * that contains the text somewhere.
 * @param {Element} el
 * @param {string} prefix - e.g. 'LabyrinthPanel_supplies'
 * @returns {boolean}
 */
function hasGameClass(el, prefix) {
    const classes = typeof el?.className === 'string' ? el.className.split(/\s+/) : [];
    return classes.some((c) => c.startsWith(`${prefix}__`));
}

function createButton() {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = 'Buy supplies';
    button.title =
        'Open the Consumables panel on its Labyrinth tab: what the next runs need against what you hold, ' +
        'with a Buy all walk for the shortfall';
    // Sits where the game's "Supplies" heading was and keeps its line: the font and line height come from the
    // heading's own class on the wrapper, and an inset shadow instead of a border adds no height
    button.style.cssText =
        'margin: 0; padding: 0 10px; font: inherit; line-height: inherit; color: #ffffff; ' +
        'background: rgba(91, 141, 239, 0.15); border: none; box-shadow: inset 0 0 0 1px rgba(91, 141, 239, 0.5); ' +
        'border-radius: 6px; cursor: pointer;';
    button.addEventListener('click', () => {
        try {
            handleClick();
        } catch (error) {
            console.error('[LabyrinthMissingSupplies] Opening the Consumables panel failed:', error);
        }
    });
    return button;
}

/**
 * Replace the "Supplies" heading with the button, once per rendered panel instance. Beside the heading it made the
 * row taller (on its own line) or ran into the floor column (on a phone's narrow supplies column); in the heading's
 * place it keeps the row's height and is centered at any width. The game's heading is hidden, not removed, so
 * React still owns it, and `disable()` shows it again.
 * @param {Element} grid - The LabyrinthPanel_suppliesGrid element
 */
export function injectButton(grid) {
    // Only the real supplies grid, in its own LabyrinthPanel_supplies block, and only that block's own
    // heading: a looser lookup can land on the entry screen's description or another section's label
    if (!hasGameClass(grid, 'LabyrinthPanel_suppliesGrid')) return;
    const wrapper = grid.parentElement;
    if (!wrapper || !hasGameClass(wrapper, 'LabyrinthPanel_supplies')) return;
    if (wrapper.querySelector(`.${BUTTON_CLASS}`)) return;
    const label = [...wrapper.children].find((child) => hasGameClass(child, 'LabyrinthPanel_label'));
    if (!label) return;
    const holder = document.createElement('div');
    // The heading's own class: same font, margins and centering as the line it replaces
    holder.className = label.className;
    holder.appendChild(createButton());
    label.setAttribute(HIDDEN_LABEL_ATTR, '');
    label.style.display = 'none';
    label.insertAdjacentElement('afterend', holder);
}

/**
 * True when a button's holder still sits where it was put: in a LabyrinthPanel_supplies block that has its grid,
 * right after the heading this module hid.
 * @param {Element} holder
 * @returns {boolean}
 */
function holderInPlace(holder) {
    const wrapper = holder?.parentElement;
    if (!wrapper || !hasGameClass(wrapper, 'LabyrinthPanel_supplies')) return false;
    const label = holder.previousElementSibling;
    if (!label || !label.hasAttribute(HIDDEN_LABEL_ATTR) || !hasGameClass(label, 'LabyrinthPanel_label')) return false;
    return [...wrapper.children].some((child) => hasGameClass(child, 'LabyrinthPanel_suppliesGrid'));
}

/**
 * Put the page right after the game has redrawn the labyrinth: take out a button the redraw stranded, show any
 * heading left hidden without its button, then add the button to each supplies block that lacks one.
 *
 * The button's holder is not React's. When the game redraws, React keeps the page elements it can reuse, drops
 * its own children and adds new ones, and the holder stays behind in whatever its parent has become. Seen on the
 * test server (2026-11-24): in a run the supplies block held the holder, then a new unhidden "Supplies" heading,
 * then the grid, so both showed. On leaving a run the button turned up above the description text.
 */
export function reconcile() {
    for (const button of document.querySelectorAll(`.${BUTTON_CLASS}`)) {
        const holder = button.parentElement;
        if (!holderInPlace(holder)) (holder || button).remove();
    }
    for (const label of document.querySelectorAll(`[${HIDDEN_LABEL_ATTR}]`)) {
        const next = label.nextElementSibling;
        if (next?.firstElementChild?.classList.contains(BUTTON_CLASS) && holderInPlace(next)) continue;
        label.style.display = '';
        label.removeAttribute(HIDDEN_LABEL_ATTR);
    }
    document.querySelectorAll('[class*="LabyrinthPanel_suppliesGrid"]').forEach((grid) => injectButton(grid));
}

let unregister = null;
let reconcileTimer = null;

/** One reconcile for a whole redraw, however many labyrinth elements it added */
function scheduleReconcile() {
    if (reconcileTimer) return;
    reconcileTimer = setTimeout(() => {
        reconcileTimer = null;
        if (unregister) reconcile();
    }, 0);
}

export function initialize() {
    if (unregister) return;
    if (!config.getSetting(SETTING_KEY)) return;
    // Any labyrinth element the game adds is a redraw: the supplies grid arriving, a heading replaced, the
    // description panel drawn where a run's panel was
    unregister = domObserver.onClass('LabyrinthMissingSupplies', 'LabyrinthPanel_', () => scheduleReconcile());
    reconcile();
}

export function disable() {
    unregister?.();
    unregister = null;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    reconcileTimer = null;
    document.querySelectorAll(`.${BUTTON_CLASS}`).forEach((el) => el.parentElement?.remove());
    document.querySelectorAll(`[${HIDDEN_LABEL_ATTR}]`).forEach((label) => {
        label.style.display = '';
        label.removeAttribute(HIDDEN_LABEL_ATTR);
    });
}

export default { name: 'Labyrinth Missing Supplies Button', initialize, disable, reconcile };
