/**
 * Toolasha Surface Marker
 *
 * Stamps a window, modal or popup as a Toolasha surface. text-appearance.js
 * applies the chosen text size and font to marked elements and to nothing else,
 * so a window that is never marked is never resized, however it was built.
 *
 * Kept in a module of its own, with no imports, because it is called from
 * dozens of features and a feature's tests commonly mock the heavier utility
 * modules (panel-z-index, floating-panel) wholesale.
 */

/** The attribute text-appearance.js selects on */
export const SURFACE_ATTRIBUTE = 'data-toolasha-surface';

/**
 * What a marked element is, which decides where the text zoom lands.
 *
 * - `panel`: a persistent window that is its own box. Its children carry the zoom.
 * - `popover`: a transient popup, menu or tooltip that is its own box. Same treatment as a panel.
 * - `modal`: a full-viewport backdrop whose single child is the window. The window's size is in
 *   `vh`/`vw`, which `zoom` multiplies, so the zoom goes on the window's children instead.
 * - `dialog`: the choice dialog's backdrop; the window itself is zoomed and fitted to the backdrop.
 */
export const SURFACE_KINDS = ['panel', 'popover', 'modal', 'dialog'];

/**
 * Mark an element as a Toolasha surface.
 * @param {HTMLElement|null|undefined} el - The surface root: the element appended to the page
 * @param {string} [kind='panel'] - One of {@link SURFACE_KINDS}
 * @returns {HTMLElement|null|undefined} The same element, so a call can wrap a construction
 */
export function markToolashaSurface(el, kind = 'panel') {
    el?.setAttribute?.(SURFACE_ATTRIBUTE, kind);
    return el;
}
