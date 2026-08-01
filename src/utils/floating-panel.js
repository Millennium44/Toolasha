/**
 * Floating Panel helpers
 *
 * The drag behaviour every floating panel needs, in one place.
 *
 * Written for the overlay shell, which has to remember where it was left. The
 * PFormance and Treasure panels each carry their own copy of this and could
 * adopt it; they are left alone here because moving working code is a separate
 * change from adding new code.
 */

import { bringPanelToFront } from './panel-z-index.js';

/**
 * Let a panel be dragged by one of its parts.
 *
 * Listeners live on the document rather than the handle, because a fast drag
 * outruns the element under the cursor and the panel would be left stuck to the
 * pointer. They are attached on mousedown and removed on mouseup, so nothing
 * stays bound while the panel sits still.
 *
 * @param {HTMLElement} panel - The thing that moves
 * @param {HTMLElement} handle - The part you grab
 * @param {Function} [onDrop] - Called with `{left, top}` once the drag ends
 * @returns {Function} Detaches the handle's listener
 */
export function makeDraggable(panel, handle, onDrop) {
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;

    const onMouseMove = (event) => {
        if (!dragging) return;
        // Anchored left/top from here on: a panel positioned from the right edge
        // would jump the moment the window is resized
        panel.style.left = `${event.clientX - offsetX}px`;
        panel.style.top = `${event.clientY - offsetY}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    };

    const onMouseUp = () => {
        if (!dragging) return;
        dragging = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        onDrop?.({ left: panel.style.left, top: panel.style.top });
    };

    const onMouseDown = (event) => {
        // Only the primary button, and never a click that was meant for a
        // control sitting in the handle
        if (event.button !== 0 || event.target.closest('button, input, select')) return;

        bringPanelToFront(panel);
        dragging = true;
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        event.preventDefault();
    };

    handle.addEventListener('mousedown', onMouseDown);

    return () => {
        handle.removeEventListener('mousedown', onMouseDown);
        onMouseUp();
    };
}

/**
 * Nudge a panel back into view.
 *
 * A panel remembers where it was left, and the window it was left in may have
 * been wider. Without this a panel saved off the right edge is unreachable and
 * looks like a feature that stopped working.
 *
 * @param {{left: string, top: string}} position - A saved position
 * @param {{width: number, height: number}} size - The panel's own size
 * @param {{width: number, height: number}} viewport - The window
 * @returns {{left: number, top: number}} A position at least partly on screen
 */
export function clampToViewport(position, size, viewport) {
    const left = parseFloat(position?.left);
    const top = parseFloat(position?.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;

    // A strip of the panel is enough to grab it by and drag it back
    const margin = 40;
    return {
        left: Math.min(Math.max(left, margin - size.width), viewport.width - margin),
        top: Math.min(Math.max(top, 0), viewport.height - margin),
    };
}
