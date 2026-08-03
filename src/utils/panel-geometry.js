/**
 * Panel Geometry
 *
 * Where a floating panel was left, and how big it was left.
 *
 * Every panel in this script had its own answer to this, which is to say most of
 * them had none: they opened at a hardcoded corner at a hardcoded width, and a
 * panel you have to drag and resize on every page load is a panel you stop
 * opening. One store, keyed by panel, so a new panel gets the behaviour by
 * calling one function.
 *
 * The clamping is the part worth having apart from the DOM. A panel remembers
 * the window it was left in, and that window may since have been narrower — a
 * saved position restored blindly puts the panel somewhere you cannot reach it,
 * which looks exactly like a feature that stopped working.
 */

import storage from '../core/storage.js';

const STORAGE_KEY = 'panelGeometry';

/** Cache of every panel's geometry, so opening a panel does not wait on storage */
let cache = null;
let loading = null;

/**
 * Hold a saved geometry inside the current window.
 *
 * Size is capped at the viewport, since a panel restored wider than the screen
 * cannot be resized back — its resize grip is off the edge. Position keeps a
 * strip on screen, which is enough to grab the header and drag it back.
 *
 * @param {Object} geometry - `{left, top, width, height}` in pixels
 * @param {{width: number, height: number}} viewport - The window
 * @param {{width: number, height: number}} [min] - Smallest allowed size
 * @returns {Object|null} A usable geometry, or null when there is nothing to use
 */
export function clampGeometry(geometry, viewport, min = { width: 200, height: 80 }) {
    if (!geometry) return null;

    const result = {};

    const width = Number(geometry.width);
    const height = Number(geometry.height);
    if (Number.isFinite(width)) {
        result.width = Math.max(min.width, Math.min(width, viewport.width));
    }
    if (Number.isFinite(height)) {
        result.height = Math.max(min.height, Math.min(height, viewport.height));
    }

    const left = Number(geometry.left);
    const top = Number(geometry.top);
    if (Number.isFinite(left) && Number.isFinite(top)) {
        // A strip of the panel is enough to grab it by
        const margin = 60;
        result.left = Math.min(Math.max(left, margin - (result.width || min.width)), viewport.width - margin);
        result.top = Math.min(Math.max(top, 0), viewport.height - 30);
    }

    return Object.keys(result).length ? result : null;
}

/**
 * Every panel's saved geometry.
 * @returns {Promise<Object>} `{ [panelKey]: geometry }`
 */
export async function allGeometry() {
    // Module-scope callers run before the database is open, and an unguarded
    // read there comes back with the default — indistinguishable from nothing
    // having been stored
    await storage.ready;
    if (cache) return cache;
    if (!loading) {
        loading = storage
            .getJSON(STORAGE_KEY, 'settings', {})
            .then((saved) => {
                cache = saved || {};
                return cache;
            })
            .catch((error) => {
                console.error('[PanelGeometry] Loading saved geometry failed:', error);
                cache = {};
                return cache;
            });
    }
    return loading;
}

/**
 * Remember a panel's geometry.
 * @param {string} panelKey - Which panel
 * @param {Object} geometry - `{left, top, width, height}`
 */
export async function saveGeometry(panelKey, geometry) {
    const all = await allGeometry();
    all[panelKey] = { ...all[panelKey], ...geometry };
    try {
        await storage.setJSON(STORAGE_KEY, all, 'settings');
    } catch (error) {
        console.error('[PanelGeometry] Saving geometry failed:', error);
    }
}

/**
 * Forget a panel's geometry, so it opens where it was designed to.
 * @param {string} panelKey - Which panel
 */
export async function clearGeometry(panelKey) {
    const all = await allGeometry();
    delete all[panelKey];
    try {
        await storage.setJSON(STORAGE_KEY, all, 'settings');
    } catch (error) {
        console.error('[PanelGeometry] Clearing geometry failed:', error);
    }
}

/**
 * Put a panel back where it was left.
 *
 * Applied after the panel is on screen rather than before, because the geometry
 * comes from storage and the alternative is holding every panel closed until a
 * database answers. Opening at the default and settling a frame later is the
 * lesser of the two.
 *
 * @param {HTMLElement} panel - The panel
 * @param {string} panelKey - Which panel
 * @param {{width: number, height: number}} [min] - Smallest allowed size
 * @returns {Promise<void>}
 */
export async function restoreGeometry(panel, panelKey, min) {
    const all = await allGeometry();
    const clamped = clampGeometry(all[panelKey], { width: window.innerWidth, height: window.innerHeight }, min);
    if (!clamped || !panel?.isConnected) return;

    if (clamped.width) panel.style.width = `${clamped.width}px`;
    if (clamped.height) panel.style.height = `${clamped.height}px`;
    if (clamped.left !== undefined) {
        panel.style.left = `${clamped.left}px`;
        panel.style.top = `${clamped.top}px`;
        // Anchored from the left from here on; a panel positioned from the right
        // edge would jump the moment the window is resized
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    }
}

/**
 * Whether a panel was open when the page was last left.
 *
 * Stored beside the geometry rather than as its own thing, because it is the
 * same question — where a panel was, and whether it was anywhere at all. A panel
 * that has to be reopened after every refresh is a panel that gets opened once
 * and then not bothered with.
 *
 * @param {string} panelKey - The panel's key
 * @param {boolean} open - Whether it is open now
 * @returns {Promise<void>}
 */
export async function saveOpenState(panelKey, open) {
    try {
        const all = await allGeometry();
        all[panelKey] = { ...(all[panelKey] || {}), open: Boolean(open) };
        await storage.setJSON(STORAGE_KEY, all, 'settings');
    } catch (error) {
        console.error('[PanelGeometry] Remembering whether a panel was open failed:', error);
    }
}

/**
 * @param {string} panelKey - The panel's key
 * @returns {Promise<boolean>} Whether it should be reopened
 */
export async function wasOpen(panelKey) {
    try {
        const all = await allGeometry();
        return Boolean(all[panelKey]?.open);
    } catch (error) {
        console.error('[PanelGeometry] Reading whether a panel was open failed:', error);
        return false;
    }
}

/**
 * Resolves once there is a `<body>` to append a panel to.
 *
 * The script runs at `document-start`, so at the moment these modules are
 * imported there is no body — a panel reopening itself then would throw on the
 * append and take the rest of the module's start-up with it.
 *
 * @returns {Promise<void>}
 */
function bodyReady() {
    if (typeof document === 'undefined' || document.body) return Promise.resolve();
    return new Promise((resolve) => {
        document.addEventListener('DOMContentLoaded', () => resolve(), { once: true });
    });
}

/**
 * Reopen a panel that was open when the page was last left.
 *
 * The waiting is the whole of it, and is why this is one function rather than a
 * `wasOpen` call in each panel. Panels ask at module scope, which is before the
 * database is open *and* before there is a body to draw into; asking then gets
 * the default back, which is indistinguishable from having been closed. That is
 * why remembering appeared to work and reopening never did.
 *
 * @param {string} panelKey - The panel's key
 * @param {Function} reopen - Called only if it was open
 * @returns {Promise<void>}
 */
export async function reopenIfLeftOpen(panelKey, reopen) {
    try {
        if (!(await wasOpen(panelKey))) return;
        await bodyReady();
        reopen();
    } catch (error) {
        console.error('[PanelGeometry] Reopening a panel failed:', error);
    }
}
