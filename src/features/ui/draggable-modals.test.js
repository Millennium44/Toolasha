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

    ({ default: draggableModals } = await import('./draggable-modals.js'));
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
