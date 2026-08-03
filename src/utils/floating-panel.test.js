/** @vitest-environment happy-dom
 *
 * Dragging a panel by its header.
 *
 * The interesting case is the one that is not a drag. `onDrop` is how a panel
 * records where it was put, and for the Treasure popup it is also how the popup
 * is told to stop following the chest dialog — so firing it on a press that
 * never moved silently pinned the popup and made auto-placement look broken.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('./panel-z-index.js', () => ({ bringPanelToFront: () => {} }));

const { makeDraggable } = await import('./floating-panel.js');

let panel;
let handle;
let dropped;

beforeEach(() => {
    document.body.innerHTML = '<div id="panel"><div id="handle"></div></div>';
    panel = document.getElementById('panel');
    handle = document.getElementById('handle');
    panel.style.left = '100px';
    panel.style.top = '100px';
    dropped = vi.fn();
    makeDraggable(panel, handle, dropped);
});

const press = (x, y) => handle.dispatchEvent(new MouseEvent('mousedown', { button: 0, clientX: x, clientY: y }));
const move = (x, y) => document.dispatchEvent(new MouseEvent('mousemove', { clientX: x, clientY: y }));
const release = () => document.dispatchEvent(new MouseEvent('mouseup'));

describe('what counts as having been moved', () => {
    test('a drag reports where it ended', () => {
        press(120, 120);
        move(200, 180);
        release();

        expect(dropped).toHaveBeenCalledTimes(1);
        expect(panel.style.left).not.toBe('100px');
        expect(dropped.mock.calls[0][0]).toEqual({ left: panel.style.left, top: panel.style.top });
    });

    test('a click on the header is not a drag', () => {
        // It used to be. The Treasure popup reads `onDrop` as "stay here", so
        // one click on its header stopped it following the chest dialog.
        press(120, 120);
        release();

        expect(dropped).not.toHaveBeenCalled();
    });

    test('and a second press after a drag starts from not-moved again', () => {
        press(120, 120);
        move(200, 180);
        release();
        dropped.mockClear();

        press(220, 200);
        release();

        expect(dropped).not.toHaveBeenCalled();
    });

    test('a press on a control in the header does not drag at all', () => {
        handle.innerHTML = '<button id="close"></button>';
        document
            .getElementById('close')
            .dispatchEvent(new MouseEvent('mousedown', { button: 0, bubbles: true, clientX: 1, clientY: 1 }));
        move(300, 300);
        release();

        expect(dropped).not.toHaveBeenCalled();
        expect(panel.style.left).toBe('100px');
    });
});
