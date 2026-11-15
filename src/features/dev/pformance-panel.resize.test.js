/** @vitest-environment happy-dom */

/** The performance panel's resize grip: one grip, saved size, restored size, collapse, teardown. */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({ saved: null }));
const settings = {};

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1100,
        getSettingValue: (key, fallback) => (key in settings ? settings[key] : fallback),
        setSettingValue: (key, value) => {
            settings[key] = value;
        },
    },
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/csv-export.js', () => ({ downloadFile: () => {} }));
vi.mock('../../utils/panel-geometry.js', () => ({
    markPanelInteracted: vi.fn(),
    saveGeometry: vi.fn(async () => {}),
    clearSize: vi.fn(async () => {}),
    restoreGeometry: vi.fn(async (panel) => {
        if (!geometry.saved) return;
        panel.style.width = `${geometry.saved.width}px`;
        panel.style.height = `${geometry.saved.height}px`;
    }),
}));

const { default: pformancePanel } = await import('./pformance-panel.js');
const { saveGeometry, clearSize } = await import('../../utils/panel-geometry.js');

const monitor = {
    enabled: false,
    getAllStats: () => new Map(),
    getSnapshots: () => new Map(),
    getSpans: () => [],
    getMarks: () => [],
};
const panel = () => document.getElementById('toolasha-pformance-panel');
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
    window.Toolasha = { Core: { performanceMonitor: monitor } };
    geometry.saved = null;
    vi.clearAllMocks();
});
afterEach(() => {
    pformancePanel.hide();
    document.body.replaceChildren();
    delete window.Toolasha;
});

describe('pformance panel resize', () => {
    test('one grip, gone on close, not doubled on reopen', () => {
        pformancePanel.show();
        expect(grips().length).toBe(1);
        pformancePanel.hide();
        expect(grips().length).toBe(0);
        pformancePanel.show();
        expect(grips().length).toBe(1);
    });

    test('a drag saves the size and lifts the 500px content cap', () => {
        pformancePanel.show();
        panel().getBoundingClientRect = () => ({ width: 500, height: 700, left: 0, top: 0 });
        dragGrip();
        expect(saveGeometry).toHaveBeenCalledWith('pformance-panel', { width: 500, height: 700 });
        expect(panel().style.height).toBe('700px');
        expect(pformancePanel.contentEl.style.maxHeight).toBe('none');
    });

    test('a saved size is applied, and collapsing does not hold the panel open', async () => {
        geometry.saved = { width: 500, height: 700 };
        pformancePanel.show();
        await Promise.resolve();
        await Promise.resolve();
        expect(panel().style.height).toBe('700px');
        const collapse = [...panel().querySelectorAll('button')].find((b) => b.textContent === '▼');
        collapse.click();
        expect(panel().style.height).toBe('auto');
        expect(grips()[0].style.display).toBe('none');
        collapse.click();
        expect(panel().style.height).toBe('700px');
    });

    test('the content cap is lifted when the drag moves, not on press, and a tap saves nothing', () => {
        pformancePanel.show();
        const ev = (type, x) => {
            const e = new MouseEvent(type, { bubbles: true, clientX: x, clientY: 10, button: 0 });
            Object.defineProperty(e, 'pointerId', { value: 1 });
            return e;
        };
        const capBefore = pformancePanel.contentEl.style.maxHeight;
        document.querySelector('.toolasha-resize-grip').dispatchEvent(ev('pointerdown', 10));
        expect(pformancePanel.contentEl.style.maxHeight).toBe(capBefore);
        expect(capBefore).not.toBe('none');
        document.dispatchEvent(ev('pointermove', 40));
        expect(pformancePanel.contentEl.style.maxHeight).toBe('none');
        document.dispatchEvent(ev('pointerup', 40));
        pformancePanel.contentEl.style.maxHeight = capBefore;
        saveGeometry.mockClear();
        dragGrip(0);
        expect(pformancePanel.contentEl.style.maxHeight).toBe(capBefore);
        expect(saveGeometry).not.toHaveBeenCalled();
    });

    test('double-clicking the grip restores the opening size through clearSize', async () => {
        geometry.saved = { width: 500, height: 700 };
        pformancePanel.show();
        await Promise.resolve();
        await Promise.resolve();
        grips()[0].dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(panel().style.height).toBe('');
        expect(pformancePanel.contentEl.style.maxHeight).toBe('500px');
        expect(clearSize).toHaveBeenCalledWith('pformance-panel');
    });

    test('closing a collapsed panel does not leave the reopened one marked collapsed', () => {
        pformancePanel.show();
        [...panel().querySelectorAll('button')].find((b) => b.textContent === '▼').click();
        expect(pformancePanel.isCollapsed).toBe(true);
        pformancePanel.hide();
        pformancePanel.show();
        expect(pformancePanel.isCollapsed).toBe(false);
        expect(pformancePanel.contentEl.style.display).toBe('');
        expect(grips()[0].style.display).not.toBe('none');
    });
});
