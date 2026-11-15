/** @vitest-environment happy-dom */

/** The labyrinth room logs panel's resize grip: one grip, saved size, restored size, teardown. */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const geometry = vi.hoisted(() => ({ saved: null }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, Z_FLOATING_PANEL: 1100 },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async () => null,
        set: async () => true,
        getJSON: async () => ({}),
        setJSON: async () => {},
        ready: Promise.resolve(),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getSkills: () => null,
        getCurrentCharacterId: () => 'char1',
        getCurrentCharacterGameMode: () => 'standard',
    },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
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

const { labyrinthRoomLogs } = await import('./labyrinth-room-logs.js');
const { saveGeometry, clearSize, clearGeometry } = await import('../../utils/panel-geometry.js');

const panel = () => document.getElementById('mwi-lab-logs-panel');
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
    labyrinthRoomLogs.panel = null;
    geometry.saved = null;
    vi.clearAllMocks();
});

describe('labyrinth room logs resize', () => {
    test('one grip, and ensurePanel on a live panel does not add another', () => {
        labyrinthRoomLogs.ensurePanel();
        labyrinthRoomLogs.ensurePanel();
        expect(grips().length).toBe(1);
    });

    test('a drag saves the size and lifts the 60vh caps on panel and list', () => {
        labyrinthRoomLogs.ensurePanel();
        panel().getBoundingClientRect = () => ({ width: 500, height: 800, left: 0, top: 0 });
        dragGrip();
        expect(saveGeometry).toHaveBeenCalledWith('mwi-lab-logs-panel', { width: 500, height: 800 });
        expect(panel().style.maxHeight).toBe('none');
        expect(panel().querySelector('.mwi-lab-logs-list').style.maxHeight).toBe('none');
    });

    test('a saved size is applied and the caps lifted', async () => {
        geometry.saved = { width: 520, height: 700 };
        labyrinthRoomLogs.ensurePanel();
        await Promise.resolve();
        await Promise.resolve();
        expect(panel().style.width).toBe('520px');
        expect(panel().style.height).toBe('700px');
        expect(panel().style.maxHeight).toBe('none');
    });

    test('disable removes the grip with the panel', async () => {
        labyrinthRoomLogs.ensurePanel();
        await labyrinthRoomLogs.disable();
        expect(grips().length).toBe(0);
    });

    test('the 60vh caps are lifted when the drag starts, and a tap saves nothing', () => {
        labyrinthRoomLogs.ensurePanel();
        dragGrip(0);
        expect(panel().style.maxHeight).toBe('none');
        expect(saveGeometry).not.toHaveBeenCalled();
    });

    test('double-clicking the grip restores the opening size through clearSize', () => {
        geometry.saved = { width: 520, height: 700 };
        labyrinthRoomLogs.ensurePanel();
        document.querySelector('.toolasha-resize-grip').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        expect(panel().style.width).toBe('340px');
        expect(panel().style.height).toBe('');
        expect(panel().style.maxHeight).toBe('60vh');
        expect(panel().querySelector('.mwi-lab-logs-list').style.maxHeight).toBe('calc(60vh - 44px)');
        expect(clearSize).toHaveBeenCalledWith('mwi-lab-logs-panel');
        expect(clearGeometry).not.toHaveBeenCalled();
    });

    test('restoreGeometry returning nothing (a bare mock) does not break the build', () => {
        labyrinthRoomLogs.ensurePanel();
        expect(grips().length).toBe(1);
    });
});
