/**
 * Floating Panel Z-Index Manager
 * Manages bring-to-front ordering for persistent floating panels.
 * All panels are capped below PANEL_Z_CAP (config.Z_FLOATING_PANEL + 99, i.e. 1199)
 * so they never cross the game's MUI modal layer (~1300).
 */

import config from '../core/config.js';
import { clampPanelToViewport } from './panel-geometry.js';

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
 * Register a floating panel element for z-index management.
 *
 * Every floating panel in the script comes through here, which makes it the one
 * place a viewport clamp reaches all of them — including the panels that open
 * at a hardcoded corner and never ask `restoreGeometry` for anything. The clamp
 * waits a frame because a panel is commonly registered in the same tick it is
 * appended, and an element the browser has not laid out yet measures as nothing.
 *
 * @param {HTMLElement} el - The panel element
 */
export function registerFloatingPanel(el) {
    panels.add(el);
    afterLayout(() => {
        try {
            if (panels.has(el)) clampPanelToViewport(el);
        } catch (error) {
            console.error('[PanelZIndex] Holding a panel inside the window failed:', error);
        }
    });
}

/**
 * Run something once the browser has had a chance to lay the page out.
 * @param {Function} run - What to run
 */
function afterLayout(run) {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => run());
    else setTimeout(run, 0);
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
 * stranded off-screen the moment the window got smaller. A phone rotating is
 * the same event, and the reason the size is re-checked here too and not only
 * the position. Only panels that are actually out of bounds are touched, and
 * the result is never persisted — the saved geometry is still what a larger
 * window restores to.
 */
function reclampRegisteredPanels() {
    for (const panel of panels) {
        try {
            clampPanelToViewport(panel);
        } catch (error) {
            console.error('[PanelZIndex] Re-clamping a panel after a resize failed:', error);
        }
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
