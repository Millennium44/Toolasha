/** @vitest-environment happy-dom */

/** The XPH calculator panel's resize grip: one grip, saved size, restored size, teardown. */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({ saved: null }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (key, fallback) => fallback,
        isFeatureEnabled: () => false,
        Z_FLOATING_PANEL: 1,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getInitClientData: () => ({ itemDetailMap: {} }) } }));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: vi.fn(),
    unregisterFloatingPanel: vi.fn(),
    bringPanelToFront: vi.fn(),
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    markPanelInteracted: vi.fn(),
    saveGeometry: vi.fn(async () => {}),
    clearGeometry: vi.fn(async () => {}),
    clearSize: vi.fn(async () => {}),
    saveCollapsed: vi.fn(async () => {}),
    wasCollapsed: vi.fn(async () => false),
    savedSize: vi.fn(async () => null),
    restoreGeometry: vi.fn(async (panel) => {
        if (!geometry.saved) return;
        panel.style.width = `${geometry.saved.width}px`;
        panel.style.height = `${geometry.saved.height}px`;
    }),
}));

const { default: calc } = await import('./xph-calculator.js');
const { saveGeometry, clearSize, clearGeometry } = await import('../../utils/panel-geometry.js');

const panel = () => document.getElementById('mwi-xph-calc-panel');
const grips = () => document.querySelectorAll('.toolasha-resize-grip');

function dragGrip(dx = 30) {
    const ev = (type) => {
        const e = new MouseEvent(type, {
            bubbles: true,
            clientX: type === 'pointermove' ? 10 + dx : 10,
            clientY: 10,
            button: 0,
        });
        Object.defineProperty(e, 'pointerId', { value: 1 });
        return e;
    };
    document.querySelector('.toolasha-resize-grip').dispatchEvent(ev('pointerdown'));
    if (dx) document.dispatchEvent(ev('pointermove'));
    document.dispatchEvent(ev('pointerup'));
}

beforeEach(() => {
    document.body.innerHTML = '';
    geometry.saved = null;
    vi.clearAllMocks();
});
afterEach(() => calc.disable());

describe('xph calculator resize', () => {
    test('one grip, none left after disable, and reopen does not duplicate', () => {
        calc.initialize();
        expect(grips().length).toBe(1);
        calc.disable();
        expect(grips().length).toBe(0);
        calc.initialize();
        expect(grips().length).toBe(1);
    });

    test('a drag saves the size under the panel key and lifts the 580px cap', () => {
        calc.initialize();
        panel().getBoundingClientRect = () => ({ width: 700, height: 640, left: 0, top: 0 });
        dragGrip();
        expect(saveGeometry).toHaveBeenCalledWith('mwi-xph-calc-panel', { width: 700, height: 640 });
        expect(panel().style.maxHeight).toBe('none');
    });

    test('a saved size is applied and the cap lifted', async () => {
        geometry.saved = { width: 720, height: 650 };
        calc.initialize();
        await Promise.resolve();
        await Promise.resolve();
        expect(panel().style.width).toBe('720px');
        expect(panel().style.height).toBe('650px');
        expect(panel().style.maxHeight).toBe('none');
    });

    test('the 580px ceiling is lifted when the drag moves, not on press, and a tap saves nothing', () => {
        calc.initialize();
        expect(panel().style.maxHeight).toBe('580px');
        const ev = (type, x) => {
            const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10, button: 0 });
            Object.defineProperty(e, 'pointerId', { value: 1 });
            return e;
        };
        document.querySelector('.toolasha-resize-grip').dispatchEvent(ev('pointerdown', 10));
        expect(panel().style.maxHeight).toBe('580px');
        document.dispatchEvent(ev('pointermove', 40));
        expect(panel().style.maxHeight).toBe('none');
        document.dispatchEvent(ev('pointerup', 40));
        panel().style.maxHeight = '580px';
        saveGeometry.mockClear();
        dragGrip(0);
        expect(panel().style.maxHeight).toBe('580px');
        expect(saveGeometry).not.toHaveBeenCalled();
    });

    test('double-clicking the grip restores the opening size through clearSize', () => {
        geometry.saved = { width: 720, height: 650 };
        calc.initialize();
        document.querySelector('.toolasha-resize-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(panel().style.width).toBe('560px');
        expect(panel().style.height).toBe('');
        expect(panel().style.maxHeight).toBe('580px');
        expect(clearSize).toHaveBeenCalledWith('mwi-xph-calc-panel');
        expect(clearGeometry).not.toHaveBeenCalled();
    });
});
