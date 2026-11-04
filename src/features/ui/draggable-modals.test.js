/** @vitest-environment happy-dom
 *
 * Dragging a game modal by its injected drag bar.
 *
 * The drag bar was wired with pointer events but never captured the pointer,
 * so a mouse button released while the cursor was outside the browser
 * window's content area never delivered a `pointerup` anywhere — `dragging`
 * stayed `true` forever and the modal kept following every later
 * `pointermove` for the rest of the session. Mirrors the pattern (and the
 * `captureFrom`/`releaseCapture` idiom) already fixed in
 * `src/utils/floating-panel.js`.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
    },
}));

// Captured so the test can fire it directly, the way the real observer would
// once `Modal_modalContent` appears.
let onClassCallback;
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: (name, className, callback) => {
            onClassCallback = callback;
            return () => {};
        },
    },
}));

let draggableModals;
let modalBox;
let contentEl;

beforeEach(async () => {
    vi.resetModules();
    onClassCallback = undefined;
    document.body.innerHTML = '';

    ({ draggableModals } = await import('./draggable-modals.js'));
    await draggableModals.initialize();

    modalBox = document.createElement('div');
    contentEl = document.createElement('div');
    contentEl.innerHTML = '<h2>Buy Now</h2>';
    modalBox.appendChild(contentEl);
    document.body.appendChild(modalBox);

    // getBoundingClientRect is unimplemented in happy-dom; the module only
    // reads left/top/width off it.
    modalBox.getBoundingClientRect = () => ({ left: 100, top: 100, width: 300, right: 400, bottom: 300, height: 200 });

    onClassCallback(contentEl);
});

const bar = () => document.querySelector('.mwi-drag-bar');

const press = (x, y) => bar().dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: x, clientY: y }));
const move = (x, y) => document.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y }));
const release = () => document.dispatchEvent(new MouseEvent('pointerup'));

describe('draggable modals', () => {
    test('injects a drag bar the first time a modal appears', () => {
        expect(bar()).not.toBeNull();
    });

    test('dragging moves the modal via transform', () => {
        press(120, 120);
        move(200, 180);
        release();

        expect(modalBox.style.transform).toContain('translate(');
        expect(modalBox.style.transform).not.toBe('translate(0px, 0px)');
    });
});

describe('pointer capture, so a release outside the browser window still ends the drag', () => {
    test('taking hold of the drag bar captures the pointer', () => {
        const capture = vi.spyOn(bar(), 'setPointerCapture');

        press(120, 120);

        expect(capture).toHaveBeenCalled();
    });

    test('releasing ends the capture', () => {
        const release_ = vi.spyOn(bar(), 'releasePointerCapture');

        press(120, 120);
        move(200, 180);
        release();

        expect(release_).toHaveBeenCalled();
    });
});

describe('double-click on the drag bar resets that modal', () => {
    const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    const doubleClickBar = () => {
        press(120, 120);
        release();
        press(120, 120);
        release();
        dbl(bar());
    };
    const getStorage = async () => (await import('../../core/storage.js')).default;
    const lastSaved = async () => {
        const calls = (await getStorage()).set.mock.calls;
        return calls[calls.length - 1]?.[1];
    };

    test('removes this modal from the saved map, keeps the others, and clears the transform', async () => {
        draggableModals.offsets = { 'Buy Now': { dx: 40, dy: 30 }, Other: { dx: 5, dy: 6 } };
        press(120, 120);
        move(200, 180);
        release();
        expect(modalBox.style.transform).toContain('translate(');

        doubleClickBar();

        expect(modalBox.style.transform).toBe('');
        expect(draggableModals.offsets['Buy Now']).toBeUndefined();
        expect(await lastSaved()).toEqual({ Other: { dx: 5, dy: 6 } });
    });

    test('a press that was dragged does not reset', () => {
        press(120, 120);
        move(200, 180);
        release();
        dbl(bar());
        expect(draggableModals.offsets['Buy Now']).toBeDefined();
        expect(modalBox.style.transform).toContain('translate(');
    });

    test('a double-click on a button or text inside the modal does nothing', () => {
        const button = document.createElement('button');
        contentEl.appendChild(button);
        draggableModals.offsets = { 'Buy Now': { dx: 40, dy: 30 } };
        dbl(button);
        dbl(contentEl.querySelector('h2'));
        expect(draggableModals.offsets['Buy Now']).toBeDefined();
    });

    test('after disable() neither a reset nor a drag writes the emptied map', async () => {
        const storage = await getStorage();
        draggableModals.disable();
        storage.set.mockClear();
        press(120, 120);
        move(200, 180);
        release();
        dbl(bar());
        expect(storage.set).not.toHaveBeenCalled();
    });

    test('a failed write does not throw', async () => {
        const storage = await getStorage();
        storage.set.mockRejectedValueOnce(new Error('quota'));
        draggableModals.offsets = { 'Buy Now': { dx: 40, dy: 30 } };
        expect(() => doubleClickBar()).not.toThrow();
        await Promise.resolve();
        expect(draggableModals.offsets['Buy Now']).toBeUndefined();
    });
});
