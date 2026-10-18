/** @vitest-environment happy-dom
 *
 * Tab Reorder does not use mouse or pointer events for its drag loop — it
 * wires the native HTML5 drag-and-drop API (`draggable="true"` plus
 * dragstart/dragover/dragleave/drop/dragend). That is a different event
 * model from the mouse-tracking pattern fixed in `floating-panel.js` and
 * `draggable-modals.js`: `dragend` is fired by the browser itself once the
 * drag operation ends — by a drop, by Escape, or by the mouse button being
 * released anywhere, including outside the browser window's content area —
 * regardless of what DOM element (if any) is under the cursor at that
 * moment. There is no `pointerId` to capture and no separate "did the
 * release event reach a listener" question, because the browser (not a
 * document-level mousemove/mouseup pair) owns the drag session.
 *
 * These tests exist to pin that down rather than assume it: they drive a
 * drag that ends via `dragend` without ever firing `drop` — the closest
 * native-DnD analogue of "the button came up somewhere the page never saw" —
 * and confirm the module's per-drag state (the dimmed source tab, the
 * dragged label, the hover drop-indicator borders on other tabs) is already
 * cleaned up unconditionally. No `setPointerCapture`-equivalent exists for
 * this API and none is needed here.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import storage from '../../core/storage.js';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1' },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: vi.fn(async () => null),
        setJSON: vi.fn(async () => {}),
    },
}));

// Captured so the test can trigger the ready-catch-up pass directly.
let onReadyCallback;
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        onReady: (name, callback) => {
            onReadyCallback = callback;
            return () => {};
        },
    },
}));

let tabReorder;
let tabInventory;
let tabToolasha;

beforeEach(async () => {
    vi.resetModules();
    storage.setJSON.mockClear();
    onReadyCallback = undefined;
    document.body.innerHTML = `
        <div role="tablist">
            <button role="tab">Inventory</button>
            <button role="tab">Toolasha</button>
        </div>
    `;

    ({ default: tabReorder } = await import('./tab-reorder.js'));
    await tabReorder.initialize();
    onReadyCallback();

    [tabInventory, tabToolasha] = document.querySelectorAll('[role="tab"]');
});

const dataTransfer = () => new DataTransfer();

// happy-dom aliases `DragEvent` straight to `Event` and drops any
// `dataTransfer` passed via the constructor's init dict, so it has to be
// attached by hand to match what a real browser hands the listener.
const dragEvent = (type, dt, init = {}) => {
    const event = new Event(type, { bubbles: true, cancelable: true, ...init });
    event.dataTransfer = dt;
    if (init.clientX !== undefined) event.clientX = init.clientX;
    return event;
};

describe('tab reorder wiring', () => {
    test('wires native drag-and-drop on every tab', () => {
        expect(tabInventory.getAttribute('draggable')).toBe('true');
        expect(tabToolasha.getAttribute('draggable')).toBe('true');
    });
});

describe('a drag that ends without a drop', () => {
    // The closest native-DnD analogue of a mouse released outside the
    // browser window: the operation ends via `dragend`, and `drop` never
    // fires on any tab.
    test('dragend alone (no drop) still clears the dimmed source tab', () => {
        const dt = dataTransfer();
        tabInventory.dispatchEvent(dragEvent('dragstart', dt));

        expect(tabInventory.style.opacity).toBe('0.4');

        tabInventory.dispatchEvent(dragEvent('dragend', dt));

        expect(tabInventory.style.opacity).toBe('');
    });

    test('dragend alone (no drop) still clears drop-indicator borders left by dragover', () => {
        const dt = dataTransfer();
        tabInventory.dispatchEvent(dragEvent('dragstart', dt));
        tabToolasha.dispatchEvent(dragEvent('dragover', dt, { clientX: tabToolasha.getBoundingClientRect().left }));

        // The hover indicator was drawn on the tab being dragged over
        expect(tabToolasha.style.borderLeft || tabToolasha.style.borderRight).not.toBe('');

        tabInventory.dispatchEvent(dragEvent('dragend', dt));

        expect(tabToolasha.style.borderLeft).toBe('');
        expect(tabToolasha.style.borderRight).toBe('');
    });

    test('a later drag starts clean after a dropless drag ended it', () => {
        const dt1 = dataTransfer();
        tabInventory.dispatchEvent(dragEvent('dragstart', dt1));
        tabInventory.dispatchEvent(dragEvent('dragend', dt1));

        // A fresh drag on the other tab should behave normally — nothing
        // left dangling from the aborted one.
        const dt2 = dataTransfer();
        tabToolasha.dispatchEvent(dragEvent('dragstart', dt2));

        expect(tabToolasha.style.opacity).toBe('0.4');
        expect(tabInventory.style.opacity).toBe('');
    });
});

describe('finger-driven reordering (no native drag events)', () => {
    const ptr = (target, type, id, x = 0, y = 0, pointerType = 'touch') => {
        const e = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y });
        Object.defineProperty(e, 'pointerId', { value: id });
        Object.defineProperty(e, 'pointerType', { value: pointerType });
        target.dispatchEvent(e);
    };

    beforeEach(() => {
        vi.useFakeTimers();
        document.elementFromPoint = vi.fn();
        tabToolasha.getBoundingClientRect = () => ({ left: 100, width: 100, top: 0, height: 20 });
    });
    afterEach(() => vi.useRealTimers());

    test('holding a tab and releasing over another saves the new order', () => {
        ptr(tabInventory, 'pointerdown', 3, 10, 10);
        vi.advanceTimersByTime(400);
        expect(tabInventory.style.opacity).toBe('0.4');
        document.elementFromPoint.mockReturnValue(tabToolasha);
        ptr(tabInventory, 'pointermove', 3, 190, 10);
        expect(tabToolasha.style.borderRight).not.toBe('');
        ptr(tabInventory, 'pointerup', 3, 190, 10);

        expect(storage.setJSON).toHaveBeenCalledWith('tabOrder_char1', ['Toolasha', 'Inventory'], 'settings', true);
        expect(tabInventory.style.opacity).toBe('');
        expect(tabToolasha.style.borderRight).toBe('');
    });

    test('a tap or an early swipe never picks the tab up', () => {
        ptr(tabInventory, 'pointerdown', 3, 10, 10);
        ptr(tabInventory, 'pointermove', 3, 60, 10);
        vi.advanceTimersByTime(400);
        expect(tabInventory.style.opacity).toBe('');
        ptr(tabInventory, 'pointerup', 3, 60, 10);
        expect(storage.setJSON).not.toHaveBeenCalled();
    });

    test('another finger and a cancel do not drop', () => {
        ptr(tabInventory, 'pointerdown', 3, 10, 10);
        vi.advanceTimersByTime(400);
        document.elementFromPoint.mockReturnValue(tabToolasha);
        ptr(tabInventory, 'pointerup', 4, 190, 10);
        expect(tabInventory.style.opacity).toBe('0.4');
        ptr(tabInventory, 'pointercancel', 3);
        expect(tabInventory.style.opacity).toBe('');
        expect(storage.setJSON).not.toHaveBeenCalled();
    });

    test('a mouse leaves the native path alone and disable removes the listeners', () => {
        ptr(tabInventory, 'pointerdown', 1, 10, 10, 'mouse');
        vi.advanceTimersByTime(400);
        expect(tabInventory.style.opacity).toBe('');

        tabReorder.disable();
        ptr(tabInventory, 'pointerdown', 3, 10, 10);
        vi.advanceTimersByTime(400);
        expect(tabInventory.style.opacity).toBe('');
    });
});
