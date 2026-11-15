/** @vitest-environment happy-dom */

/**
 * The Queue Monitor's resize grip: present once, saves the dragged size, applies
 * a saved one, leaves a collapsed panel at header height, has a way back to
 * automatic sizing, and is gone (and not doubled) across teardown and reopen.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({ saved: null }));

vi.mock('../../core/config.js', () => ({ default: { Z_FLOATING_PANEL: 1000 } }));
vi.mock('../../core/data-manager.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../../core/storage.js', () => ({ default: { get: vi.fn(async () => false), set: vi.fn() } }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
}));
vi.mock('./queue-snapshot.js', () => ({ default: { getOtherCharacterSnapshots: () => [] } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    markPanelInteracted: vi.fn(),
    saveGeometry: vi.fn(async () => {}),
    clearGeometry: vi.fn(async () => {}),
    clearSize: vi.fn(async () => {}),
    restoreGeometry: vi.fn(async (panel) => {
        if (!geometry.saved) return;
        panel.style.width = `${geometry.saved.width}px`;
        panel.style.height = `${geometry.saved.height}px`;
    }),
}));

const { default: ui } = await import('./queue-monitor-ui.js');
const { saveGeometry, clearGeometry, clearSize } = await import('../../utils/panel-geometry.js');
const storage = (await import('../../core/storage.js')).default;

const panel = () => document.getElementById('toolasha-queue-monitor');
const grips = () => document.querySelectorAll('.toolasha-resize-grip');

/** Drag the grip by (dx, dy) with a pointer */
function dragGrip(dx, dy) {
    const grip = grips()[0];
    // happy-dom MouseEvent has no pointerId; set it for the pointer handlers
    const ev = (type, x, y) => {
        const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
        Object.defineProperty(e, 'pointerId', { value: 1 });
        return e;
    };
    grip.dispatchEvent(ev('pointerdown', 10, 10));
    document.dispatchEvent(ev('pointermove', 10 + dx, 10 + dy));
    document.dispatchEvent(ev('pointerup', 10 + dx, 10 + dy));
}

beforeEach(() => {
    document.body.innerHTML = '';
    geometry.saved = null;
    vi.clearAllMocks();
    vi.useFakeTimers();
    storage.get.mockImplementation(async () => false);
});

afterEach(async () => {
    ui.disable();
    vi.useRealTimers();
});

describe('queue monitor resize', () => {
    test('has exactly one grip, also after a disable and reopen', async () => {
        await ui.initialize();
        expect(grips().length).toBe(1);
        ui.disable();
        expect(grips().length).toBe(0);
        await ui.initialize();
        expect(grips().length).toBe(1);
    });

    test('dragging the grip saves the new size and pins the panel', async () => {
        await ui.initialize();
        panel().getBoundingClientRect = () => ({ width: 260, height: 120, left: 0, top: 0 });
        dragGrip(20, 10);
        expect(saveGeometry).toHaveBeenCalledWith('toolasha-queue-monitor', { width: 260, height: 120 });
        expect(panel().style.maxWidth).toBe('none');
        expect(panel().style.height).toBe('120px');
        expect(document.getElementById('toolasha-qm-reset-size').style.display).toBe('');
    });

    test('a saved size is applied on open', async () => {
        geometry.saved = { width: 400, height: 200 };
        await ui.initialize();
        await vi.advanceTimersByTimeAsync(0);
        expect(panel().style.width).toBe('400px');
        expect(panel().style.height).toBe('200px');
    });

    test('collapsing does not hold the pinned height open, expanding restores it', async () => {
        geometry.saved = { width: 400, height: 200 };
        await ui.initialize();
        await vi.advanceTimersByTimeAsync(0);
        const toggle = document.getElementById('toolasha-qm-toggle');
        toggle.click();
        expect(panel().style.height).toBe('auto');
        expect(grips()[0].style.display).toBe('none');
        toggle.click();
        expect(panel().style.height).toBe('200px');
        expect(grips()[0].style.display).toBe('');
    });

    test('the reset button goes back to automatic size and clears the record', async () => {
        geometry.saved = { width: 400, height: 200 };
        await ui.initialize();
        await vi.advanceTimersByTimeAsync(0);
        document.getElementById('toolasha-qm-reset-size').click();
        expect(panel().style.width).toBe('');
        expect(panel().style.height).toBe('');
        // The opening width caps come back, and only the size is forgotten (never the whole record)
        expect(panel().style.maxWidth).toBe('320px');
        expect(panel().style.minWidth).toBe('220px');
        expect(clearSize).toHaveBeenCalledWith('toolasha-queue-monitor');
        expect(clearGeometry).not.toHaveBeenCalled();
        expect(document.getElementById('toolasha-qm-reset-size').style.display).toBe('none');
    });

    test('a panel that starts collapsed with no saved size has no grip to drag it tall', async () => {
        storage.get.mockImplementation(async () => true);
        await ui.initialize();
        await vi.advanceTimersByTimeAsync(0);
        expect(grips()[0].style.display).toBe('none');
    });

    test('the first real move lifts the width caps after the start size was measured, and anchors from the top left', async () => {
        await ui.initialize();
        const p = panel();
        p.getBoundingClientRect = () => ({ width: 260, height: 120, left: 40, top: 50 });
        const grip = grips()[0];
        const ev = (type, x, y) => {
            const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
            Object.defineProperty(e, 'pointerId', { value: 1 });
            return e;
        };
        expect(p.style.maxWidth).toBe('320px');
        grip.dispatchEvent(ev('pointerdown', 10, 10));
        // Pressing alone lifts and anchors nothing
        expect(p.style.maxWidth).toBe('320px');
        document.dispatchEvent(ev('pointermove', 40, 30));
        expect(p.style.maxWidth).toBe('none');
        expect(p.style.minWidth).toBe('0');
        expect(p.style.left).toBe('40px');
        expect(p.style.top).toBe('50px');
        expect(p.style.bottom).toBe('auto');
        // Start size measured on press (260x120) plus the delta
        expect(p.style.width).toBe('290px');
        expect(p.style.height).toBe('140px');
        document.dispatchEvent(ev('pointerup', 40, 30));
    });

    test('a tap on the grip lifts nothing and saves nothing', async () => {
        await ui.initialize();
        const p = panel();
        p.getBoundingClientRect = () => ({ width: 260, height: 120, left: 40, top: 50 });
        const ev = (type) => {
            const e = new MouseEvent(type, { bubbles: true, clientX: 10, clientY: 10, button: 0 });
            Object.defineProperty(e, 'pointerId', { value: 1 });
            return e;
        };
        grips()[0].dispatchEvent(ev('pointerdown'));
        document.dispatchEvent(ev('pointerup'));
        expect(p.style.maxWidth).toBe('320px');
        expect(saveGeometry).not.toHaveBeenCalled();
    });

    test('double-clicking the grip resets the size through clearSize', async () => {
        geometry.saved = { width: 400, height: 200 };
        await ui.initialize();
        await vi.advanceTimersByTimeAsync(0);
        grips()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(panel().style.width).toBe('');
        expect(clearSize).toHaveBeenCalledWith('toolasha-queue-monitor');
        expect(clearGeometry).not.toHaveBeenCalled();
    });
});
