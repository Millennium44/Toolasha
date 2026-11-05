/**
 * @vitest-environment happy-dom
 *
 * A tile whose text is cut off shrinks it until it shows in full.
 *
 * happy-dom lays nothing out, so the width a line needs is stubbed: the span
 * reports a natural width scaled by the font size the fit has given the
 * tile's content, against a box of fixed width.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        Z_HUD: 50,
        Z_FLOATING_PANEL: 1100,
        Z_POPUP: 9000,
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async () => null,
        setJSON: async () => {},
        getMany: async (keys) => new Map(keys.map((key) => [key, null])),
    },
}));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: async () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/floating-panel.js', () => ({
    panelHeightCap: (px, fraction = 0.8) =>
        `min(${px}px, calc(var(--toolasha-visual-viewport-height, 100vh) * ${fraction}))`,
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));
const rowDef = vi.hoisted(() => ({ current: null }));

// The registry is mocked down to one row, but the empty-tile policy it also
// exports is real — mocking that would leave the thing under test to the mock
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => [rowDef.current],
    resolveRows: (available) => available.map((row) => ({ ...row, visible: true })),
    moveRow: (order) => order,
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;

const renders = vi.hoisted(() => ({ count: 0, natural: 100, box: 100, version: 'a' }));
let offsetWidthSpy;

/**
 * A row drawing one span that needs `renders.natural` pixels at full size.
 * @returns {Object} Row definition
 */
function longRow() {
    return {
        key: 'luck',
        name: 'Drop Luck',
        version: () => renders.version,
        render: (el) => {
            renders.count += 1;
            const span = document.createElement('span');
            span.textContent = 'A very long name';
            const factor = () => (parseFloat(el.style.fontSize) || 100) / 100;
            Object.defineProperty(span, 'scrollWidth', { get: () => renders.natural * factor() });
            Object.defineProperty(span, 'clientWidth', { get: () => renders.box });
            el.replaceChildren(span);
        },
    };
}

const tile = () => overlayPanel.tiles.get('luck');
const fontSize = () => tile()._content.style.fontSize;

/** Mark the tile changed and fit, as the observers would */
function fit() {
    overlayPanel.fitDirty.add(tile());
    overlayPanel._fitTiles();
}

beforeEach(() => {
    renders.count = 0;
    renders.natural = 100;
    renders.box = 100;
    renders.version = 'a';
    offsetWidthSpy = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(200);
    rowDef.current = longRow();
    overlayPanel.settings.locked = true;
    overlayPanel.settings.textScale = 100;
    overlayPanel.settings.zoom = {};
    overlayPanel.show();
});

afterEach(() => {
    overlayPanel.hide();
    offsetWidthSpy.mockRestore();
});

describe('fitting the text of a tile', () => {
    test('text that fits is left at full size', () => {
        fit();
        expect(fontSize()).toBe('');
    });

    test('text a little too wide steps down once', () => {
        renders.natural = 105;
        fit();
        expect(fontSize()).toBe('90%');
    });

    test('text that fits only at the floor (10 px at the default size) stops there', () => {
        renders.natural = 128;
        fit();
        expect(fontSize()).toBe('77%');
    });

    test('text that never fits keeps the floor and its ellipsis', () => {
        renders.natural = 400;
        fit();
        expect(fontSize()).toBe('77%');
        expect(tile()._content.querySelector('span').textContent).toBe('A very long name');
    });

    test('shorter content grows back to full size', () => {
        renders.natural = 128;
        fit();
        expect(fontSize()).toBe('77%');
        renders.natural = 90;
        fit();
        expect(fontSize()).toBe('');
    });

    test('a wider tile grows back', () => {
        renders.natural = 128;
        fit();
        expect(fontSize()).toBe('77%');
        renders.box = 200;
        fit();
        expect(fontSize()).toBe('');
    });

    test('the text scale lifts the floor so nothing goes below 10 px', () => {
        // 13 px x 80% = 10.4 px: only a step to about 96% keeps it at 10 px
        overlayPanel.settings.textScale = 80;
        renders.natural = 400;
        fit();
        expect(fontSize()).toBe('96%');
    });

    test('text scale and tile zoom combine: at 8 px already, nothing shrinks', () => {
        overlayPanel.settings.textScale = 80;
        overlayPanel.settings.zoom = { luck: 80 };
        overlayPanel.hide();
        overlayPanel.show();
        renders.natural = 400;
        fit();
        expect(fontSize()).toBe('');
    });

    test('a tile with a larger zoom has more room to shrink, down to the 75% floor', () => {
        overlayPanel.settings.zoom = { luck: 150 };
        overlayPanel.hide();
        overlayPanel.show();
        renders.natural = 400;
        fit();
        expect(fontSize()).toBe('75%');
    });

    test('fitting does not draw again or change the version', () => {
        renders.natural = 128;
        const drawn = renders.count;
        const version = tile()._version;
        fit();
        fit();
        expect(renders.count).toBe(drawn);
        expect(tile()._version).toBe(version);
        expect(overlayPanel.fitDirty.size).toBe(0);
        // a redraw with the same version keeps what was fitted
        overlayPanel._renderBody();
        expect(renders.count).toBe(drawn);
        expect(fontSize()).toBe('77%');
    });

    test('a tile that is not on screen is not measured', () => {
        renders.natural = 128;
        offsetWidthSpy.mockReturnValue(0);
        fit();
        expect(fontSize()).toBe('');
        expect(overlayPanel.fitDirty.size).toBe(0);
        expect(tile()._fitWidth).toBe(-1);
    });
});
