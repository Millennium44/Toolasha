/**
 * Shared annotation line for Labyrinth Automation skip-threshold cells.
 *
 * Several features inject badges into the same cell (clear-rate text,
 * recommendation, best level). Placed inline they crowd the native
 * value/buttons and make rows wrap at different widths, so every badge goes
 * into one shared full-width container that always renders on its own line
 * below the native controls (order:98 keeps it visually last even when React
 * re-inserts its own children after it).
 */

export const ANNOTATION_CONTAINER_CLASS = 'mwi-labyrinth-annotations';

/**
 * Get (or create) the cell's shared annotation container.
 * @param {Element} cell - LabyrinthPanel_skipThreshold cell
 * @returns {Element} Container element
 */
export function getAnnotationContainer(cell) {
    let container = cell.querySelector(`.${ANNOTATION_CONTAINER_CLASS}`);
    if (!container) {
        container = document.createElement('span');
        container.className = ANNOTATION_CONTAINER_CLASS;
        container.style.cssText =
            'flex-basis:100%; order:98; display:flex; align-items:center; gap:8px; min-width:0; margin-top:1px;';
        cell.appendChild(container);
    }
    return container;
}

/**
 * Remove annotation containers that no longer hold any badges.
 */
export function pruneEmptyAnnotationContainers() {
    document.querySelectorAll(`.${ANNOTATION_CONTAINER_CLASS}`).forEach((el) => {
        if (!el.childElementCount) el.remove();
    });
}
