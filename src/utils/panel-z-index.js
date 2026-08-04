/**
 * Floating Panel Z-Index Manager
 * Manages bring-to-front ordering for persistent floating panels.
 * All panels are capped below PANEL_Z_CAP (config.Z_FLOATING_PANEL + 99, i.e. 1199)
 * so they never cross the game's MUI modal layer (~1300).
 */

import config from '../core/config.js';
import { clampGeometry } from './panel-geometry.js';

const panels = new Set();

/**
 * The highest z-index any registered floating panel may reach.
 *
 * Exported so anything that must sit above every panel — the choice dialog's
 * backdrop, for one — can derive its own z-index from this instead of
 * guessing a number that has to be kept in sync by hand.
 */
export const PANEL_Z_CAP = config.Z_FLOATING_PANEL + 99;

/** How long to wait after the last resize event before re-clamping panels */
const RESIZE_DEBOUNCE_MS = 200;

/**
 * Register a floating panel element for z-index management
 * @param {HTMLElement} el - The panel element
 */
export function registerFloatingPanel(el) {
    panels.add(el);
}

/**
 * Unregister a floating panel element
 * @param {HTMLElement} el - The panel element
 */
export function unregisterFloatingPanel(el) {
    panels.delete(el);
}

/**
 * Bring a panel to the front among all registered panels,
 * without exceeding PANEL_Z_CAP.
 * @param {HTMLElement} el - The panel to bring forward
 */
export function bringPanelToFront(el) {
    const base = config.Z_FLOATING_PANEL;
    const cap = PANEL_Z_CAP;

    let maxZ = base;
    for (const p of panels) {
        const z = parseInt(p.style.zIndex) || base;
        if (z > maxZ) maxZ = z;
    }

    const next = maxZ + 1;
    if (next > cap) {
        // Overflow — reassign all from base upward, put el last
        let i = base;
        for (const p of panels) {
            if (p !== el) p.style.zIndex = String(i++);
        }
        el.style.zIndex = String(i);
    } else {
        el.style.zIndex = String(next);
    }
}

/**
 * Nudge every registered panel that is now out of bounds back on screen.
 *
 * A panel remembers where it was left, and a resize does not go through
 * `restoreGeometry` — nothing was re-checking the saved position against a
 * window that has since shrunk, so a panel dragged toward the right edge was
 * stranded off-screen the moment the window got smaller. Only panels that
 * `clampGeometry` actually disagrees with are touched, and the result is
 * never persisted — the saved position is still what a larger window
 * restores to.
 */
function reclampRegisteredPanels() {
    if (typeof window === 'undefined') return;
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height)) return;
    if (viewport.width <= 0 || viewport.height <= 0) return;

    for (const panel of panels) {
        if (!panel?.isConnected) continue;

        const left = parseFloat(panel.style.left);
        const top = parseFloat(panel.style.top);
        if (!Number.isFinite(left) || !Number.isFinite(top)) continue;

        const rect = panel.getBoundingClientRect();
        const clamped = clampGeometry({ left, top, width: rect.width, height: rect.height }, viewport);
        if (!clamped) continue;

        const nextLeft = clamped.left !== undefined ? clamped.left : left;
        const nextTop = clamped.top !== undefined ? clamped.top : top;
        // Still fits — leave it alone rather than snapping it for no reason
        if (nextLeft === left && nextTop === top) continue;

        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
    }
}

let resizeTimer = null;

function onWindowResize() {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(reclampRegisteredPanels, RESIZE_DEBOUNCE_MS);
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onWindowResize);
}
