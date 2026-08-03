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
 * @param {Function} [onDrop] - Called with `{left, top}` once the panel has
 *   actually been moved. A click that never moved is not a drag.
 * @returns {Function} Detaches the handle's listener
 */
export function makeDraggable(panel, handle, onDrop) {
    let offsetX = 0;
    let offsetY = 0;
    let dragging = false;
    let moved = false;

    const onMouseMove = (event) => {
        if (!dragging) return;
        moved = true;
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

        // A press that never moved is a click, not a drag. Saving one is
        // harmless for a panel that only remembers where it is, and wrong for
        // the Treasure popup, where being moved is how you tell it to stop
        // following the chest dialog — clicking its header once silently
        // pinned it somewhere and auto-placement appeared to stop working.
        if (!moved) return;
        onDrop?.({ left: panel.style.left, top: panel.style.top });
    };

    const onMouseDown = (event) => {
        // Only the primary button, and never a click that was meant for a
        // control sitting in the handle
        if (event.button !== 0 || event.target.closest('button, input, select')) return;

        bringPanelToFront(panel);
        dragging = true;
        moved = false;
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
 * Give a panel a corner you can drag to resize it.
 *
 * A grip rather than CSS `resize: both`, because the native handle needs the
 * element to scroll its own overflow — these panels hide theirs so the rounded
 * corners stay rounded — and it cannot be styled to be visible against a dark
 * panel. It also gives us the minimums, which the native handle does not
 * enforce below the content size.
 *
 * @param {HTMLElement} panel - The thing that resizes
 * @param {Object} [options] - Options
 * @param {number} [options.minWidth] - Smallest width
 * @param {number} [options.minHeight] - Smallest height
 * @param {Function} [options.onResize] - Called with `{width, height}` once the drag ends
 * @returns {Function} Removes the grip
 */
export function makeResizable(panel, { minWidth = 200, minHeight = 80, onResize } = {}) {
    const grip = document.createElement('div');
    grip.title = 'Drag to resize';
    Object.assign(grip.style, {
        position: 'absolute',
        right: '0',
        bottom: '0',
        width: '14px',
        height: '14px',
        cursor: 'nwse-resize',
        // Two hairlines reading as a corner, rather than an icon that would need
        // to be legible against whatever the panel's last row happens to be
        background:
            'linear-gradient(135deg, transparent 0 45%, rgba(158, 196, 255, 0.55) 45% 55%, transparent 55% 72%, ' +
            'rgba(158, 196, 255, 0.55) 72% 82%, transparent 82%)',
        zIndex: '2',
    });

    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let resizing = false;

    const onMouseMove = (event) => {
        if (!resizing) return;
        panel.style.width = `${Math.max(minWidth, startWidth + event.clientX - startX)}px`;
        panel.style.height = `${Math.max(minHeight, startHeight + event.clientY - startY)}px`;
    };

    const onMouseUp = () => {
        if (!resizing) return;
        resizing = false;
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('mouseup', onMouseUp);
        const rect = panel.getBoundingClientRect();
        onResize?.({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };

    const onMouseDown = (event) => {
        if (event.button !== 0) return;
        resizing = true;
        const rect = panel.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startWidth = rect.width;
        startHeight = rect.height;
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
        event.preventDefault();
        event.stopPropagation();
    };

    grip.addEventListener('mousedown', onMouseDown);
    panel.appendChild(grip);

    return () => {
        grip.removeEventListener('mousedown', onMouseDown);
        onMouseUp();
        grip.remove();
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
