/**
 * @vitest-environment happy-dom
 *
 * The overlay on a screen it was not arranged for.
 *
 * A layout is saved as pixels — this tile at x=250, that one 240 wide — and the
 * same account logs in on a desktop and on a phone. Restored straight onto a
 * 370-pixel canvas that arrangement is not narrower, it is *stacked*: every tile
 * is held inside the canvas, which drags the right-hand column onto the left-hand
 * one until the two are drawn on top of each other. That is what "jumbled" was —
 * tiles over tiles, text over text, and the panel itself hanging off the screen
 * at a width remembered from a monitor.
 *
 * Two rules, and the third test in each group is the one that matters: the panel
 * is held inside the window, the tiles are flowed into columns that fit, and
 * neither of those is allowed to write anything down. The desktop arrangement has
 * to be exactly as it was when the desktop opens it next.
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

/** What the account left behind on its desktop, and anything written since */
const geometry = vi.hoisted(() => ({ saved: null, writes: [] }));

// Deliberately not the real clamping: this restores the desktop's geometry
// verbatim, so what the test sees is the panel's own answer to it rather than
// the shared layer's
vi.mock('../../utils/panel-geometry.js', () => ({
    restoreGeometry: async (panel) => {
        if (!geometry.saved) return;
        panel.style.width = `${geometry.saved.width}px`;
        panel.style.height = `${geometry.saved.height}px`;
        panel.style.left = `${geometry.saved.left}px`;
        panel.style.top = `${geometry.saved.top}px`;
    },
    saveGeometry: async (key, value) => geometry.writes.push({ key, value }),
    clearGeometry: async () => {},
    allGeometry: async () => ({}),
}));
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => () => {}, makeResizable: () => () => {} }));

/** What the panel wrote to its own per-character settings, if anything */
const stored = vi.hoisted(() => ({ writes: [] }));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async () => null,
    writeScoped: async (key, value) => {
        stored.writes.push(JSON.parse(JSON.stringify(value)));
    },
}));

const game = vi.hoisted(() => ({ rows: [] }));
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => game.rows,
    resolveRows: (available) => available.map((row) => ({ ...row, visible: true })),
    moveRow: (order) => order,
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;

/**
 * A row that always has something to say, so no tile ever stands down.
 * @param {string} key - Row key
 * @returns {Object} A row definition
 */
function row(key) {
    return { key, name: key, render: (el) => (el.textContent = `${key} 27.3%`) };
}

/**
 * Two columns of tiles, as a desktop would have left them.
 * @returns {Object} Positions and sizes for four rows
 */
function twoColumnDesktop() {
    return {
        positions: {
            dps: { x: 0, y: 0 },
            luck: { x: 250, y: 0 },
            worth: { x: 0, y: 50 },
            loot: { x: 250, y: 50 },
        },
        sizes: {
            dps: { width: 240, height: 40 },
            luck: { width: 240, height: 40 },
            worth: { width: 240, height: 40 },
            loot: { width: 240, height: 40 },
        },
    };
}

/**
 * Tell the panel how much room it actually has.
 *
 * happy-dom measures nothing, so the width the layout is decided from has to be
 * stated rather than laid out. It is the one figure the whole of this behaviour
 * turns on.
 *
 * @param {number} width - The scroller's width, in pixels
 */
function widthIs(width) {
    Object.defineProperty(overlayPanel.scrollEl, 'clientWidth', { value: width, configurable: true });
    overlayPanel.lastCanvasWidth = overlayPanel._canvasWidth();
    overlayPanel._renderBody();
}

/**
 * Every drawn tile, as a box.
 * @returns {Array<Object>} `{key, x, y, width, height}` for each visible tile
 */
function boxes() {
    return [...overlayPanel.tiles.entries()]
        .filter(([, tile]) => tile.style.display !== 'none')
        .map(([key, tile]) => ({
            key,
            x: Number.parseFloat(tile.style.left),
            y: Number.parseFloat(tile.style.top),
            width: Number.parseFloat(tile.style.width),
            height: Number.parseFloat(tile.style.height),
        }));
}

/**
 * Which pairs of tiles are drawn over each other.
 * @returns {string[]} `"a/b"` for every overlapping pair
 */
function collisions() {
    const drawn = boxes();
    const found = [];
    for (let i = 0; i < drawn.length; i += 1) {
        for (let j = i + 1; j < drawn.length; j += 1) {
            const [a, b] = [drawn[i], drawn[j]];
            const over = a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
            if (over) found.push(`${a.key}/${b.key}`);
        }
    }
    return found;
}

/** The panel's box as it is written on the element. @returns {Object} */
function panelBox() {
    const px = (value) => Number.parseFloat(value);
    return {
        left: px(overlayPanel.panel.style.left),
        top: px(overlayPanel.panel.style.top),
        width: px(overlayPanel.panel.style.width),
        height: px(overlayPanel.panel.style.height),
    };
}

beforeEach(() => {
    geometry.saved = null;
    geometry.writes = [];
    stored.writes = [];
    game.rows = [row('dps'), row('luck'), row('worth'), row('loot')];

    window.innerWidth = 400;
    window.innerHeight = 800;

    overlayPanel.settings = {
        visible: {},
        order: [],
        positions: {},
        sizes: {},
        zoom: {},
        locked: true,
        snapToGrid: true,
        separators: true,
        textScale: 100,
        open: false,
        docked: false,
        dockHeightPx: null,
        emptyTiles: 'auto',
        curatedDefaults: false,
    };
});

afterEach(() => {
    overlayPanel.hide();
    document.body.replaceChildren();
});

describe('a desktop layout opened on a phone', () => {
    beforeEach(() => {
        Object.assign(overlayPanel.settings, twoColumnDesktop());
        overlayPanel.show();
    });

    test('no two tiles are drawn on top of each other', () => {
        // The bug in one assertion. Restored as saved, `clampTile` drags the
        // x=250 column onto the x=0 one, and every pair in it collides
        widthIs(380);

        expect(collisions()).toEqual([]);
    });

    test('under 500px across it is a single column', () => {
        widthIs(380);

        expect(overlayPanel._flowColumns(380 - 12)).toBe(1);
        expect(new Set(boxes().map((tile) => tile.x))).toEqual(new Set([0]));
    });

    test('the tiles are widened to the column rather than shrunk to fit', () => {
        // Making everything smaller until a desktop arrangement fits gives a
        // phone two columns of six-point text, which is a screenshot and not a
        // readout
        widthIs(380);

        for (const tile of boxes()) expect(tile.width).toBe(368);
    });

    test('nothing is drawn past the right-hand edge', () => {
        widthIs(380);

        for (const tile of boxes()) expect(tile.x + tile.width).toBeLessThanOrEqual(368);
    });

    test('the column runs in the order the eye ran across the desktop', () => {
        // Top to bottom, then left to right: the phone's column should read the
        // way the arrangement read, not in whatever order the rows registered
        widthIs(380);

        const order = [...boxes()].sort((a, b) => a.y - b.y).map((tile) => tile.key);
        expect(order).toEqual(['dps', 'luck', 'worth', 'loot']);
    });

    test('a wide panel is left with exactly the arrangement it was given', () => {
        // The other half of it: a desktop must not notice any of this
        widthIs(900);

        const placed = Object.fromEntries(boxes().map((tile) => [tile.key, { x: tile.x, y: tile.y }]));
        expect(placed).toEqual(twoColumnDesktop().positions);
    });

    test('the arrangement comes back when there is room for it again', () => {
        widthIs(380);
        expect(new Set(boxes().map((tile) => tile.x))).toEqual(new Set([0]));

        widthIs(900);

        expect(boxes().find((tile) => tile.key === 'luck').x).toBe(250);
        expect(boxes().find((tile) => tile.key === 'luck').width).toBe(240);
    });

    test('two columns are kept where two columns fit', () => {
        // Degrading further than the width requires is its own kind of wrong
        expect(overlayPanel._flowColumns(520)).toBe(2);
        expect(overlayPanel._flowColumns(1000)).toBe(4);
    });
});

describe('what a narrow screen is not allowed to do', () => {
    beforeEach(() => {
        Object.assign(overlayPanel.settings, twoColumnDesktop());
        overlayPanel.show();
    });

    test('the saved arrangement is not rewritten to the phone’s', () => {
        // The same account is logged in on both, so a write here is a desktop
        // layout destroyed from a screen that never had it
        widthIs(380);

        expect(overlayPanel.settings.positions).toEqual(twoColumnDesktop().positions);
        expect(overlayPanel.settings.sizes).toEqual(twoColumnDesktop().sizes);
    });

    test('drawing narrow saves nothing at all', () => {
        stored.writes = [];
        geometry.writes = [];

        widthIs(380);

        expect(stored.writes).toEqual([]);
        expect(geometry.writes).toEqual([]);
    });

    test('tiles cannot be dragged while they are flowed', () => {
        // A drag would be arranging a layout that is not on screen, and dropping
        // it would write the phone's column over the desktop's arrangement
        overlayPanel.settings.locked = false;
        widthIs(380);

        expect(overlayPanel.flowing).toBe(true);
        expect(overlayPanel.isEditable).toBe(false);
        expect([...overlayPanel.tiles.values()][0]._grip.style.display).toBe('none');
    });

    test('a wide panel is still arrangeable', () => {
        overlayPanel.settings.locked = false;
        widthIs(900);

        expect(overlayPanel.flowing).toBe(false);
        expect(overlayPanel.isEditable).toBe(true);
    });

    test('the gear popover says why the tiles moved', () => {
        widthIs(380);
        overlayPanel._renderPicker();

        expect(overlayPanel.pickerEl.textContent).toContain('flowed into columns');
        expect(overlayPanel.pickerEl.textContent).toContain('untouched');
    });
});

describe('the panel inside the window', () => {
    test('a size remembered from a desktop is cut down to the screen there is', async () => {
        geometry.saved = { left: 700, top: 400, width: 900, height: 600 };
        overlayPanel.show();
        // The geometry lands a microtask later, and the clamp with it
        await Promise.resolve();
        await Promise.resolve();

        const box = panelBox();
        expect(box.width).toBeLessThanOrEqual(window.innerWidth);
        expect(box.height).toBeLessThanOrEqual(window.innerHeight);
    });

    test('a position remembered from a desktop is brought back on screen', async () => {
        geometry.saved = { left: 700, top: 400, width: 900, height: 600 };
        overlayPanel.show();
        await Promise.resolve();
        await Promise.resolve();

        const box = panelBox();
        expect(box.left).toBeGreaterThanOrEqual(0);
        expect(box.top).toBeGreaterThanOrEqual(0);
        expect(box.left + box.width).toBeLessThanOrEqual(window.innerWidth);
        expect(box.top + box.height).toBeLessThanOrEqual(window.innerHeight);
    });

    test('the window being made smaller pulls the panel in after it', () => {
        overlayPanel.show();
        Object.assign(overlayPanel.panel.style, {
            width: '900px',
            height: '600px',
            left: '700px',
            top: '400px',
        });

        window.innerWidth = 360;
        window.innerHeight = 640;
        window.dispatchEvent(new Event('resize'));

        const box = panelBox();
        expect(box.left + box.width).toBeLessThanOrEqual(360);
        expect(box.top + box.height).toBeLessThanOrEqual(640);
    });

    test('a width that is not pixels is left exactly as it was', () => {
        // The first open is sized in `min(…px, 92vw)`, which is viewport-safe
        // already. `parseFloat` reads any of that as a number — `92%` comes back
        // as 92 — and a panel "corrected" to ninety-two pixels wide on a monitor
        // is a worse bug than the one being fixed
        overlayPanel.show();
        overlayPanel.panel.style.width = '50%';
        overlayPanel._clampToViewport();

        expect(overlayPanel.panel.style.width).toBe('50%');
    });

    test('clamping writes nothing to storage', () => {
        // Display-time, deliberately: the desktop's geometry is still the
        // desktop's when it is next opened there
        geometry.saved = { left: 700, top: 400, width: 900, height: 600 };
        overlayPanel.show();
        geometry.writes = [];

        window.innerWidth = 360;
        window.dispatchEvent(new Event('resize'));

        expect(geometry.writes).toEqual([]);
    });

    test('a resize lays the tiles out again for the width that is left', () => {
        Object.assign(overlayPanel.settings, twoColumnDesktop());
        overlayPanel.show();
        widthIs(900);
        expect(boxes().find((tile) => tile.key === 'luck').x).toBe(250);

        Object.defineProperty(overlayPanel.scrollEl, 'clientWidth', { value: 380, configurable: true });
        window.dispatchEvent(new Event('resize'));

        expect(collisions()).toEqual([]);
        expect(new Set(boxes().map((tile) => tile.x))).toEqual(new Set([0]));
    });

    test('the resize listener goes away with the panel', () => {
        overlayPanel.show();
        overlayPanel.hide();

        expect(overlayPanel.onWindowResize).toBeNull();
        expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
    });

    test('the gear popover is never wider than the screen either', () => {
        overlayPanel.show();
        overlayPanel.pickerEl.style.display = '';
        overlayPanel._placePicker();

        expect(Number.parseFloat(overlayPanel.pickerEl.style.width)).toBeLessThanOrEqual(window.innerWidth);
    });
});
