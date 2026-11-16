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
import { markPanelInteracted } from './panel-geometry.js';
import { hasCoarsePointer } from './mobile.js';

/**
 * Capture a pointer on the element that started tracking it.
 *
 * Without this, a drag or resize ended by releasing the mouse button outside
 * the browser window's content area never reaches any DOM listener — the OS
 * keeps the event, no `pointerup` fires anywhere, and whatever flag was
 * tracking "is this still happening" never clears. Capture is what makes the
 * browser keep delivering that pointer's events to this element regardless of
 * what is or is not under the cursor when it happens. Guarded because a
 * synthetic event in a test, or a pointer type that does not support capture,
 * should not be able to throw out of a pointerdown handler.
 *
 * @param {HTMLElement} el - The handle or grip that owns this pointer stream
 * @param {PointerEvent} event - The pointerdown that started it
 */
function captureFrom(el, event) {
    try {
        el.setPointerCapture?.(event.pointerId);
    } catch {
        // A pointer id the browser already dropped, or a target that cannot
        // capture — either way the drag still works via the document
        // listeners, just without the outside-the-window guarantee.
    }
}

/**
 * Let go of a capture taken by {@link captureFrom}.
 *
 * The browser releases capture on its own once the pointer lifts, but not on
 * `pointercancel`, and calling it here regardless costs nothing and leaves no
 * doubt that a cancelled touch does not leave the handle still capturing.
 *
 * @param {HTMLElement} el - The handle or grip
 * @param {PointerEvent} event - The pointerup or pointercancel ending it
 */
function releaseCapture(el, event) {
    try {
        el.releasePointerCapture?.(event.pointerId);
    } catch {
        // Already released, or never captured — nothing to undo
    }
}

/**
 * Whether a press inside a drag handle was aimed at a control rather than the
 * handle itself.
 *
 * Starting a drag is not free: it captures the pointer on the handle and calls
 * `preventDefault()`, and a captured pointer makes the browser dispatch the
 * resulting `click` at the capturing element instead of the thing under the
 * cursor. So a control inside a handle stops receiving clicks at all. That is
 * how the profile card's "breakdown" link came to do nothing — it is a `<span>`
 * in the card's header, the header is the drag handle, and the old test here
 * named only `button, input, select`.
 *
 * Tag names alone cannot answer this: the panels in this script are built from
 * spans as often as buttons, across 28 handles, and each new one is another
 * chance to forget. What every control does say is `cursor: pointer`, against
 * the handle's own `cursor: move` — that is the convention throughout, and it
 * is what the user sees before they press. The handle itself is excluded from
 * the walk so a handle that styles itself as a pointer stays draggable.
 *
 * @param {EventTarget} target - What the press landed on
 * @param {HTMLElement} handle - The drag handle
 * @returns {boolean}
 */
function isHandleControl(target, handle) {
    if (!(target instanceof Element)) return false;
    if (target.closest('button, input, select, textarea, a, [data-drag-ignore]')) return true;

    for (let el = target; el && el !== handle; el = el.parentElement) {
        if (getComputedStyle(el).cursor === 'pointer') return true;
    }
    return false;
}

/**
 * The opening height for a floating panel, capped against the *visible* viewport.
 *
 * `80vh`, `80dvh` and `window.innerHeight` all measure the **layout** viewport,
 * which does not shrink when the mobile on-screen keyboard covers the bottom of
 * the screen. A panel sized off any of them while the keyboard is up therefore
 * renders as if it were not there, and its footer — the close button on most of
 * these panels, a submit control on the rest — ends up underneath it. Only
 * `visualViewport` tracks the keyboard, and `src/utils/visual-viewport.js`
 * publishes its height as `--toolasha-visual-viewport-height`; the `100vh`
 * fallback inside the `var()` covers browsers with no `visualViewport` and any
 * environment where the tracking never started.
 *
 * Nine panels each carried this expression as their own `vh` literal and were
 * missed when the overlay shell was fixed, which is why it is a function now
 * rather than a string to copy. Adapted from MWITools
 * src/features/mobile-viewport-fix.js, CC-BY-NC-SA-4.0, see third-party/mwitools/.
 *
 * @param {number} px - The panel's preferred height, in pixels
 * @param {number} [fraction] - How much of the visible viewport it may take
 * @returns {string} A CSS `height` value
 */
export function panelHeightCap(px, fraction = 0.8) {
    return `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`;
}

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
    // The one pointer that owns this drag. A second finger's events also bubble
    // to the document and must neither steer nor end the first finger's drag.
    let activePointerId = null;

    // Pointer events rather than mouse events, so a finger works the same as a
    // cursor — mousedown never fires on a touchscreen and every panel was
    // simply immovable there. touch-action:none is the half that is easy to
    // forget: without it the browser claims the gesture for scrolling and the
    // pointermove stream ends after a few pixels.
    handle.style.touchAction = 'none';

    const onPointerMove = (event) => {
        if (!dragging || event.pointerId !== activePointerId) return;
        moved = true;
        // Anchored left/top from here on: a panel positioned from the right edge
        // would jump the moment the window is resized
        panel.style.left = `${event.clientX - offsetX}px`;
        panel.style.top = `${event.clientY - offsetY}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
    };

    const onPointerUp = (event) => {
        if (!dragging) return;
        // Teardown calls this with no event and ends whatever is active
        if (event && event.pointerId !== activePointerId) return;
        const ownerId = activePointerId;
        dragging = false;
        activePointerId = null;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);
        releaseCapture(handle, { pointerId: ownerId });

        // A press that never moved is a click, not a drag. Saving one is
        // harmless for a panel that only remembers where it is, and wrong for
        // the Treasure popup, where being moved is how you tell it to stop
        // following the chest dialog — clicking its header once silently
        // pinned it somewhere and auto-placement appeared to stop working.
        if (!moved) return;
        onDrop?.({ left: panel.style.left, top: panel.style.top });
    };

    const onPointerDown = (event) => {
        // Only the primary button, and never a click that was meant for a
        // control sitting in the handle
        if (event.button !== 0 || isHandleControl(event.target, handle)) return;
        // A second finger while one already holds the handle is not a new drag
        if (dragging) return;

        bringPanelToFront(panel);
        // Before the panel has moved, so a `restoreGeometry` still waiting on
        // storage knows its answer is stale and does not snap the panel back
        markPanelInteracted(panel);
        dragging = true;
        activePointerId = event.pointerId;
        moved = false;
        const rect = panel.getBoundingClientRect();
        offsetX = event.clientX - rect.left;
        offsetY = event.clientY - rect.top;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        // A touch interrupted by the system (notification, palm rejection)
        // cancels rather than lifts; without this the panel stays glued
        document.addEventListener('pointercancel', onPointerUp);
        // Captured on the handle so the browser still delivers the matching
        // pointerup here even if the button is released outside the browser
        // window entirely — without capture that release reaches no DOM
        // listener at all, `dragging` never clears, and the panel keeps
        // following every later pointermove until the next click-drag cycle.
        captureFrom(handle, event);
        event.preventDefault();
    };

    handle.addEventListener('pointerdown', onPointerDown);

    return () => {
        handle.removeEventListener('pointerdown', onPointerDown);
        onPointerUp();
    };
}

/**
 * Pin a fixed panel by its left and top edges, where it already is.
 *
 * The grip sits bottom-right and grows the panel by the pointer's delta, which
 * only follows the pointer when the top-left corner stays put. A panel placed
 * from the right or bottom edge (the trial scoreboard at `right: 24px`, the XPH
 * calculator) would instead grow leftward, away from the finger. A panel centered
 * with a transform is left to its own `onStart`, since its left is not its rect's.
 *
 * @param {HTMLElement} panel - The panel about to be resized
 * @returns {{original: Object, pinned: Object}|null} The inline placement it had before and the left/top it was
 *   pinned to (as the style reads them back), or null when the panel was left alone
 */
function anchorTopLeft(panel) {
    const style = getComputedStyle(panel);
    if (style.position !== 'fixed') return null;
    if (style.transform && style.transform !== 'none') return null;
    const rect = panel.getBoundingClientRect();
    if (!Number.isFinite(rect.left) || !Number.isFinite(rect.top)) return null;
    const original = {
        left: panel.style.left,
        top: panel.style.top,
        right: panel.style.right,
        bottom: panel.style.bottom,
    };
    panel.style.left = `${rect.left}px`;
    panel.style.top = `${rect.top}px`;
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    return { original, pinned: { left: panel.style.left, top: panel.style.top } };
}

/**
 * Put a panel back under the placement it had before `anchorTopLeft` pinned it, so a reset at the default size
 * sits where the panel was placed rather than overhanging the window from its pinned left edge. Only when the
 * panel still carries exactly what the anchor wrote: a panel dragged by its header since, or moved by anything
 * else, is left where it is.
 *
 * @param {HTMLElement} panel - The panel
 * @param {{original: Object, pinned: Object}|null} anchor - What `anchorTopLeft` returned
 * @returns {boolean} Whether the original placement was restored
 */
function restoreAnchor(panel, anchor) {
    if (!anchor) return false;
    const { style } = panel;
    if (style.left !== anchor.pinned.left || style.top !== anchor.pinned.top) return false;
    if (style.right !== 'auto' || style.bottom !== 'auto') return false;
    style.left = anchor.original.left;
    style.top = anchor.original.top;
    style.right = anchor.original.right;
    style.bottom = anchor.original.bottom;
    return true;
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
 * @param {Function} [options.onResize] - Called with `{width, height}` once a drag that moved ends
 * @param {Function} [options.onStart] - Called with the panel once a press on the grip has moved far enough to be a
 *   resize, just before the new size is applied, so a panel can lift the opening caps (max-height, min-width) that
 *   would otherwise limit the first drag. The start size is measured on pointerdown, with the caps still in place;
 *   a tap never calls it
 * @param {Function} [options.onReset] - Called on a double-click of the grip; the panel's one way back to its default size
 * @returns {Function} Removes the grip
 */
export function makeResizable(panel, { minWidth = 200, minHeight = 80, onResize, onStart, onReset } = {}) {
    const grip = document.createElement('div');
    grip.className = 'toolasha-resize-grip';
    grip.title = onReset ? 'Drag to resize · double-click to reset size' : 'Drag to resize';
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
            'linear-gradient(135deg, transparent 0 45%, rgba(231, 231, 231, 0.5) 45% 55%, transparent 55% 72%, ' +
            'rgba(231, 231, 231, 0.5) 72% 82%, transparent 82%)',
        zIndex: '2',
    });

    let startX = 0;
    let startY = 0;
    let startWidth = 0;
    let startHeight = 0;
    let startLeft = 0;
    let startTop = 0;
    let resizing = false;
    let moved = false;
    let activePointerId = null;
    // What the first drag pinned and from where; kept across drags so a reset can go back to the placement
    let anchor = null;

    // Same pointer-events story as the drag handle; and a 14px grip is a
    // mouse-sized target, so a coarse pointer gets a bigger one
    grip.style.touchAction = 'none';
    if (hasCoarsePointer()) {
        grip.style.width = '26px';
        grip.style.height = '26px';
    }

    const onPointerMove = (event) => {
        if (!resizing || event.pointerId !== activePointerId) return;
        if (!moved) {
            if (Math.abs(event.clientX - startX) < 4 && Math.abs(event.clientY - startY) < 4) return;
            moved = true;
            // Caps are lifted only once this is really a resize, and after the
            // start size was measured with them in place: lifting a max-height on
            // pointerdown would let an auto-height panel jump to its full content
            // height before the finger moved, and a tap would leave it there
            // A later drag finds the panel still pinned by the earlier one and keeps its record, so the
            // originals stay the placement before the first drag; a panel moved since is pinned afresh
            const stillPinned =
                anchor && panel.style.left === anchor.pinned.left && panel.style.top === anchor.pinned.top;
            if (!stillPinned) anchor = anchorTopLeft(panel);
            onStart?.(panel);
        }
        // A floor taller or wider than the panel already is would make a drag
        // meant to shrink it jump bigger instead (the XPH calculator opens 182px
        // tall against a 240px floor), so the floor never exceeds where it started
        const floorWidth = Math.min(minWidth, startWidth);
        const floorHeight = Math.min(minHeight, startHeight);
        // Nor past the window's right or bottom edge, where the grip (and the
        // panel's last rows) could no longer be reached; a panel that already
        // overhangs is not shrunk by this, only kept from growing further
        const ceilingWidth = Math.max(startWidth, window.innerWidth - startLeft);
        const ceilingHeight = Math.max(startHeight, window.innerHeight - startTop);
        const width = Math.max(floorWidth, startWidth + event.clientX - startX);
        const height = Math.max(floorHeight, startHeight + event.clientY - startY);
        panel.style.width = `${Math.min(ceilingWidth, width)}px`;
        panel.style.height = `${Math.min(ceilingHeight, height)}px`;
    };

    const onPointerUp = (event) => {
        if (!resizing) return;
        if (event && event.pointerId !== activePointerId) return;
        const ownerId = activePointerId;
        resizing = false;
        activePointerId = null;
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        document.removeEventListener('pointercancel', onPointerUp);
        releaseCapture(grip, { pointerId: ownerId });
        // A tap on the grip is not a resize: saving it would store the current size
        if (!moved) return;
        const rect = panel.getBoundingClientRect();
        onResize?.({ width: Math.round(rect.width), height: Math.round(rect.height) });
    };

    const onPointerDown = (event) => {
        if (event.button !== 0) return;
        if (resizing) {
            // Another finger on the grip is not ours to act on, but still not a click-through
            event.preventDefault();
            event.stopPropagation();
            return;
        }
        markPanelInteracted(panel);
        resizing = true;
        moved = false;
        activePointerId = event.pointerId;
        const rect = panel.getBoundingClientRect();
        startX = event.clientX;
        startY = event.clientY;
        startWidth = rect.width;
        startHeight = rect.height;
        startLeft = rect.left;
        startTop = rect.top;
        document.addEventListener('pointermove', onPointerMove);
        document.addEventListener('pointerup', onPointerUp);
        document.addEventListener('pointercancel', onPointerUp);
        // Same reasoning as the drag handle: without this, releasing the
        // mouse outside the window mid-resize leaves `resizing` stuck true
        captureFrom(grip, event);
        event.preventDefault();
        event.stopPropagation();
    };

    const onDoubleClick = (event) => {
        event.preventDefault();
        event.stopPropagation();
        // First, so an onReset that sets its own placement has the last word
        if (restoreAnchor(panel, anchor)) anchor = null;
        onReset?.();
    };

    grip.addEventListener('pointerdown', onPointerDown);
    if (onReset) grip.addEventListener('dblclick', onDoubleClick);
    panel.appendChild(grip);

    return () => {
        grip.removeEventListener('pointerdown', onPointerDown);
        grip.removeEventListener('dblclick', onDoubleClick);
        onPointerUp();
        anchor = null;
        grip.remove();
    };
}

// A `clampToViewport` lived here and had no callers. Panels are clamped by
// `panel-geometry.js` on restore and by the overlay's own `_clampToViewport`,
// both of which keep the whole panel on screen; this one kept a 40px strip of
// it, on the reasoning that a strip is enough to grab and drag back. Nothing
// agreed, so it was two rules and one of them was never applied.
