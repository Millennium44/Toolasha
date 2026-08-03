/**
 * @vitest-environment happy-dom
 *
 * A tile's two overlapping controls.
 *
 * The resize grip and the text-size buttons both live in the bottom corners of
 * a tile that can be forty pixels wide, which is narrower than two buttons. The
 * failure is not cosmetic: the buttons cover the grip, and the grip is the only
 * thing that would make the tile bigger again, so the tile is stuck at the size
 * that caused the problem.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, Z_HUD: 50, Z_FLOATING_PANEL: 1100, Z_POPUP: 9000 },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../utils/timer-registry.js', () => ({
    createTimerRegistry: () => ({ registerTimeout: () => {}, registerInterval: () => {}, clearAll: () => {} }),
}));
vi.mock('../../utils/panel-z-index.js', () => ({
    registerFloatingPanel: () => {},
    unregisterFloatingPanel: () => {},
    bringPanelToFront: () => {},
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: async () => {},
    saveGeometry: async () => {},
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
    saveOpenState: async () => {},
    wasOpen: async () => false,
    reopenIfLeftOpen: async () => {},
}));
vi.mock('../../utils/floating-panel.js', () => ({
    makeDraggable: () => () => {},
    makeResizable: () => () => {},
}));
const rowDef = vi.hoisted(() => ({ current: null }));

vi.mock('../../utils/overlay-rows.js', () => ({
    registeredRows: () => [rowDef.current],
    resolveRows: (available) => available.map((row) => ({ ...row, visible: true })),
    moveRow: (order) => order,
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;

/**
 * The one tile the mocked row list produces, found by the parts under test.
 * @returns {HTMLElement}
 */
function findTile() {
    return [...overlayPanel.panel.querySelectorAll('div')].find((el) => el._grip);
}

beforeEach(() => {
    rowDef.current = { key: 'luck', name: 'Drop Luck', render: (el) => (el.textContent = '27.3%') };
    overlayPanel.settings.locked = false;
    overlayPanel.show();
});

afterEach(() => overlayPanel.hide());

describe('a tile too small for its own controls', () => {
    test('the resize grip is drawn above the text-size buttons', () => {
        // At forty pixels wide — the smallest a tile may be — the two buttons
        // reach the corner. Whichever is on top takes the mouse, and it has to
        // be the grip: it is the only way back to a bigger tile.
        const element = findTile();
        expect(element).toBeTruthy();

        const grip = Number(element._grip.style.zIndex);
        const zoom = Number(element._zoom.style.zIndex);

        expect(grip).toBeGreaterThan(zoom);
    });

    test('the buttons keep clear of the corner where there is room', () => {
        expect(findTile()._zoom.style.maxWidth).toContain('100%');
    });

    test('the grip carries its own backdrop, since it is drawn over a button', () => {
        // A bare triangle on top of a button reads as neither
        expect(findTile()._grip.style.background).toContain('rgba(8, 10, 20');
    });

    test('both are hidden while the layout is locked', () => {
        // A tile you are only reading should carry no controls at all
        overlayPanel.hide();
        overlayPanel.settings.locked = true;
        overlayPanel.show();

        const element = findTile();
        expect(element._grip.style.display).toBe('none');
        expect(element._zoom.style.display).toBe('none');
    });
});

describe('a tile with nothing to report', () => {
    /**
     * Draw the panel with a row that renders whatever is given.
     * @param {Object} definition - Row fields to use
     * @returns {string} The tile's text
     */
    function drawWith(definition) {
        overlayPanel.hide();
        rowDef.current = { key: 'luck', name: 'Drop Luck', render: () => {}, ...definition };
        overlayPanel.show();
        return findTile()._content.textContent;
    }

    test('it says what it is rather than going blank', () => {
        // A blank tile looks broken rather than idle, and on an overlay of a
        // dozen tiles the empty ones are the ones your eye keeps returning to
        expect(drawWith({ empty: 'No run measured yet' })).toBe('No run measured yet');
    });

    test('without a line of its own it names itself', () => {
        // Which at least says which tile is which while a layout is arranged
        expect(drawWith({})).toBe('No drop luck data');
    });

    test('a tile that drew something is left alone', () => {
        expect(drawWith({ render: (el) => (el.textContent = '27.3%') })).toBe('27.3%');
    });

    test('an icon counts as having drawn something', () => {
        // A tile showing only a coin has drawn exactly what it meant to
        const text = drawWith({
            render: (el) => el.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg')),
        });
        expect(text).toBe('');
    });

    test('a row that throws still says so, rather than saying nothing', () => {
        expect(
            drawWith({
                render: () => {
                    throw new Error('boom');
                },
            })
        ).toContain('unavailable');
    });
});
