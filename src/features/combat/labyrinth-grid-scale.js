/**
 * Labyrinth Grid Scale
 * Scales the Labyrinth room grid, and adds a - / + stepper to the header row to change it. The game
 * renders each tile at a fixed 2.875rem, which leaves most of the panel empty. The grid is scaled
 * with CSS `zoom` so tiles, icons, level text and the clear rate badges all grow together.
 *
 * Two settings: `labyrinthGridScale` is the size (a slider in the settings panel, shared with the
 * stepper) and `labyrinthGridScaleControl` only decides whether the stepper is drawn. The size
 * applies either way, so a player who set it and then hid the stepper keeps the larger grid.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const CONTROL_CLASS = 'mwi-labyrinth-grid-scale';
const STYLE_ID = 'mwi-labyrinth-grid-scale-style';
const SCALE_SETTING = 'labyrinthGridScale';
const CONTROL_SETTING = 'labyrinthGridScaleControl';

export const MIN_SCALE = 1;
export const MAX_SCALE = 2;
export const SCALE_STEP = 0.25;

const GRID_ATTR = 'data-mwi-grid-scale';

let domObserverUnregister = null;
let cellObserverUnregister = null;
/** chargeLeft node -> MutationObserver that puts the stepper back after a React re-render */
const headerWatchers = new Map();
let unregisterScaleListener = null;
let unregisterControlListener = null;

/**
 * Clamp a stored value to a supported scale step.
 * @param {*} value
 * @returns {number}
 */
export function normalizeScale(value) {
    const parsed = parseFloat(value);
    if (!Number.isFinite(parsed)) return MIN_SCALE;
    const stepped = Math.round(parsed / SCALE_STEP) * SCALE_STEP;
    return Math.min(MAX_SCALE, Math.max(MIN_SCALE, stepped));
}

function getScale() {
    return normalizeScale(config.getSettingValue(SCALE_SETTING, MIN_SCALE));
}

function applyScale(scale) {
    removeStyles(STYLE_ID);
    if (scale === MIN_SCALE) return;
    addStyles(`[class*="LabyrinthPanel_roomGrid"], [${GRID_ATTR}] { zoom: ${scale}; }`, STYLE_ID);
}

/**
 * Mark the element that holds the room tiles. `LabyrinthPanel_roomCell` is the class the other
 * labyrinth modules match live, and the grid is the parent holding those cells, so this does not
 * depend on the grid's own class name. Called again whenever tiles are inserted, which is what
 * catches a grid node React replaced.
 */
function markGrids() {
    document.querySelectorAll('div[class*="LabyrinthPanel_roomCell"]').forEach((cell) => {
        const parent = cell.parentElement;
        if (parent && !parent.hasAttribute(GRID_ATTR)) parent.setAttribute(GRID_ATTR, '');
    });
}

function setScale(scale) {
    config.setSettingValue(SCALE_SETTING, normalizeScale(scale));
}

function updateControls() {
    const scale = getScale();
    applyScale(scale);

    document.querySelectorAll(`.${CONTROL_CLASS}`).forEach((control) => {
        control.querySelector('[data-role="value"]').textContent = `${Math.round(scale * 100)}%`;
        control.querySelector('[data-role="smaller"]').disabled = scale <= MIN_SCALE;
        control.querySelector('[data-role="larger"]').disabled = scale >= MAX_SCALE;
    });
}

function createStepButton(role, text, title, nativeButtonClass) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.role = role;
    button.textContent = text;
    button.title = title;
    button.setAttribute('aria-label', title);
    if (nativeButtonClass) button.className = nativeButtonClass;
    button.style.cssText = 'min-width:1.6em; padding-left:6px; padding-right:6px;';
    return button;
}

/**
 * Inject the stepper into the header row, once per rendered panel instance.
 * @param {Element} chargeLeft - The LabyrinthPanel_chargeLeft element.
 */
export function injectControl(chargeLeft) {
    if (!chargeLeft || chargeLeft.querySelector(`.${CONTROL_CLASS}`)) return;

    // Reuse the native "Upgrade" button's classes so the stepper matches the game's buttons.
    const nativeButtonClass = chargeLeft.querySelector('button')?.className || '';

    const control = document.createElement('div');
    control.className = CONTROL_CLASS;
    control.style.cssText = 'display:flex; align-items:center; gap:4px;';

    const label = document.createElement('span');
    label.textContent = 'Size';

    const smaller = createStepButton('smaller', '\u2212', 'Smaller grid', nativeButtonClass);
    const value = document.createElement('span');
    value.dataset.role = 'value';
    value.style.cssText = 'min-width:3em; text-align:center;';
    const larger = createStepButton('larger', '+', 'Larger grid', nativeButtonClass);

    smaller.addEventListener('click', () => setScale(getScale() - SCALE_STEP));
    larger.addEventListener('click', () => setScale(getScale() + SCALE_STEP));

    control.append(label, smaller, value, larger);
    chargeLeft.appendChild(control);
    updateControls();
}

/**
 * Inject the stepper and keep it there: React owns the header's children and may rebuild them
 * without replacing the header node, which `onClass` would never report again.
 * @param {Element} chargeLeft - The header element
 */
function watchHeader(chargeLeft) {
    injectControl(chargeLeft);
    if (headerWatchers.has(chargeLeft)) return;
    const watcher = new MutationObserver(() => {
        if (!chargeLeft.isConnected) {
            watcher.disconnect();
            headerWatchers.delete(chargeLeft);
            return;
        }
        injectControl(chargeLeft);
    });
    watcher.observe(chargeLeft, { childList: true });
    headerWatchers.set(chargeLeft, watcher);
}

function stopWatchingHeaders() {
    headerWatchers.forEach((watcher) => watcher.disconnect());
    headerWatchers.clear();
}

/** Start or stop drawing the stepper to match the control setting. */
function syncControl() {
    const wanted = config.getSetting(CONTROL_SETTING);
    if (wanted && !domObserverUnregister) {
        domObserverUnregister = domObserver.onClass('LabyrinthGridScale', 'LabyrinthPanel_chargeLeft', (el) =>
            watchHeader(el)
        );
        document.querySelectorAll('[class*="LabyrinthPanel_chargeLeft"]').forEach((el) => watchHeader(el));
    } else if (!wanted) {
        if (domObserverUnregister) {
            domObserverUnregister();
            domObserverUnregister = null;
        }
        stopWatchingHeaders();
        document.querySelectorAll(`.${CONTROL_CLASS}`).forEach((el) => el.remove());
    }
}

export function initialize() {
    cleanup();
    applyScale(getScale());
    markGrids();
    cellObserverUnregister = domObserver.onClass('LabyrinthGridScaleCells', 'LabyrinthPanel_roomCell', markGrids, {
        debounce: true,
    });
    unregisterScaleListener = config.onSettingChange(SCALE_SETTING, updateControls);
    unregisterControlListener = config.onSettingChange(CONTROL_SETTING, syncControl);
    syncControl();
}

export function cleanup() {
    if (cellObserverUnregister) {
        cellObserverUnregister();
        cellObserverUnregister = null;
    }
    stopWatchingHeaders();
    document.querySelectorAll(`[${GRID_ATTR}]`).forEach((el) => el.removeAttribute(GRID_ATTR));
    if (domObserverUnregister) {
        domObserverUnregister();
        domObserverUnregister = null;
    }
    if (unregisterScaleListener) {
        unregisterScaleListener();
        unregisterScaleListener = null;
    }
    if (unregisterControlListener) {
        unregisterControlListener();
        unregisterControlListener = null;
    }

    removeStyles(STYLE_ID);
    document.querySelectorAll(`.${CONTROL_CLASS}`).forEach((el) => el.remove());
}

export default {
    name: 'Labyrinth Grid Scale',
    initialize,
    cleanup,
    disable: cleanup,
};
