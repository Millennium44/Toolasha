/**
 * @vitest-environment happy-dom
 *
 * Panel z-index ordering, and the resize re-clamp that keeps a panel
 * reachable after the window it was left in gets smaller.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import config from '../core/config.js';
import { registerFloatingPanel, unregisterFloatingPanel, bringPanelToFront, PANEL_Z_CAP } from './panel-z-index.js';
import { askChoice } from './choice-dialog.js';

/** A minimal stand-in for a floating panel, positioned and sized like a real one */
function makePanel({ left = 100, top = 100, width = 300, height = 200 } = {}) {
    const panel = document.createElement('div');
    Object.assign(panel.style, {
        position: 'fixed',
        left: `${left}px`,
        top: `${top}px`,
        width: `${width}px`,
        height: `${height}px`,
        zIndex: String(config.Z_FLOATING_PANEL),
    });
    // happy-dom does not lay elements out, so getBoundingClientRect has to be
    // told the size a real browser would have computed from the style
    panel.getBoundingClientRect = () => ({
        left,
        top,
        width,
        height,
        right: left + width,
        bottom: top + height,
    });
    document.body.appendChild(panel);
    return panel;
}

describe('PANEL_Z_CAP', () => {
    test('matches the documented cap of Z_FLOATING_PANEL + 99', () => {
        expect(PANEL_Z_CAP).toBe(config.Z_FLOATING_PANEL + 99);
    });
});

describe('bringPanelToFront', () => {
    const registered = [];

    afterEach(() => {
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
    });

    test('never raises a panel above PANEL_Z_CAP', () => {
        const panel = makePanel();
        registerFloatingPanel(panel);
        registered.push(panel);

        // Repeated raises used to walk a panel past the cap that the choice
        // dialog assumed it could never reach
        for (let i = 0; i < 150; i++) {
            bringPanelToFront(panel);
        }

        expect(parseInt(panel.style.zIndex, 10)).toBeLessThanOrEqual(PANEL_Z_CAP);
    });
});

describe('choice dialog vs. a raised panel', () => {
    const registered = [];

    afterEach(() => {
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
        document.querySelectorAll('body > div').forEach((el) => el.remove());
    });

    test('the dialog backdrop always outranks the highest achievable panel z-index', async () => {
        const panel = makePanel();
        registerFloatingPanel(panel);
        registered.push(panel);

        // Raise it past the point (~10 raises) where it used to overtake the
        // dialog's old fixed z-index of Z_FLOATING_PANEL + 10
        for (let i = 0; i < 50; i++) {
            bringPanelToFront(panel);
        }
        const panelZ = parseInt(panel.style.zIndex, 10);

        const pending = askChoice({ title: 'Delete all history?', choices: [{ value: 'yes', label: 'Yes' }] });
        const backdrop = document.body.lastElementChild;
        const dialogZ = parseInt(backdrop.style.zIndex, 10);

        expect(dialogZ).toBeGreaterThan(panelZ);

        backdrop.querySelector('button').click();
        await pending;
    });
});

describe('window resize re-clamp', () => {
    const registered = [];
    const originalWidth = window.innerWidth;
    const originalHeight = window.innerHeight;

    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        registered.forEach((el) => {
            unregisterFloatingPanel(el);
            el.remove();
        });
        registered.length = 0;
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: originalWidth });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: originalHeight });
    });

    function resizeWindowTo(width, height) {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
        window.dispatchEvent(new Event('resize'));
    }

    /**
     * Register a panel and let the frame-deferred open-time clamp run.
     *
     * Registration clamps too now, a frame later — a panel that opens at a
     * hardcoded corner is off the side of a phone before any resize happens.
     * Under fake timers that frame has to be handed over deliberately, or it
     * lands in the middle of whatever the test does next.
     *
     * @param {HTMLElement} panel - The panel
     */
    function registerAndSettle(panel) {
        registerFloatingPanel(panel);
        registered.push(panel);
        vi.advanceTimersByTime(20);
    }

    test('nudges a panel stranded off-screen back into view after the debounce', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        // Near the right edge of a wide window, and comfortably inside it
        const panel = makePanel({ left: 1200, top: 100, width: 300, height: 200 });
        registerAndSettle(panel);
        expect(panel.style.left).toBe('1200px');

        // Shrink the window so the panel is now well past the right edge
        resizeWindowTo(800, 600);

        // Not yet — the listener is debounced
        expect(panel.style.left).toBe('1200px');

        vi.advanceTimersByTime(250);

        const left = parseFloat(panel.style.left);
        expect(left).toBeLessThan(1200);
        expect(left).toBeLessThanOrEqual(800 - 60);
    });

    test('a panel opening off the side of a narrow window is pulled in on registration', () => {
        // The phone case: nothing was saved and nothing was resized. The panel
        // opens where it was written to open, 80px in from the right of a
        // desktop, and on a 400px screen that is off the side with the close
        // button on it.
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 400 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });

        const panel = makePanel({ left: 340, top: 80, width: 380, height: 400 });
        registerAndSettle(panel);

        expect(parseFloat(panel.style.left)).toBe(400 - 380);
        expect(panel.style.right).toBe('auto');
    });

    test('leaves a panel alone when it still fits after the resize', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        const panel = makePanel({ left: 100, top: 100, width: 300, height: 200 });
        registerAndSettle(panel);

        resizeWindowTo(1400, 900);
        vi.advanceTimersByTime(250);

        expect(panel.style.left).toBe('100px');
        expect(panel.style.top).toBe('100px');
    });

    test('a panel wider than the window it is now in is narrowed to fit', () => {
        // A phone turned back to portrait, or a desktop-sized width restored on
        // one: a panel wider than the screen cannot be resized back, because
        // its resize grip is off the edge.
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1200 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        const panel = makePanel({ left: 0, top: 40, width: 700, height: 400 });
        registerAndSettle(panel);

        resizeWindowTo(400, 800);
        vi.advanceTimersByTime(250);

        expect(parseFloat(panel.style.width)).toBe(400);
        expect(parseFloat(panel.style.left)).toBe(0);
    });

    test('debounces rapid resize events into a single re-clamp', () => {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1600 });
        Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });

        const panel = makePanel({ left: 1200, top: 100, width: 300, height: 200 });
        registerAndSettle(panel);

        resizeWindowTo(1000, 900);
        vi.advanceTimersByTime(50);
        resizeWindowTo(800, 900);
        vi.advanceTimersByTime(50);
        resizeWindowTo(700, 900);

        // Only the last resize's debounce window has run out so far
        expect(panel.style.left).toBe('1200px');

        vi.advanceTimersByTime(250);

        const left = parseFloat(panel.style.left);
        expect(left).toBeLessThanOrEqual(700 - 60);
    });
});
