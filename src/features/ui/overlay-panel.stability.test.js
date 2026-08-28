/**
 * @vitest-environment happy-dom
 *
 * Where a tile is, and whether it stays there.
 *
 * The reported bug was "the layouts get jumbled", and the mechanism behind it
 * was not a drawing fault: a tile with no *saved* position was placed against
 * whatever happened to be on screen at that instant and the result was thrown
 * away, so every measurement tile that started or stopped reporting moved every
 * unplaced tile somewhere else — and a tile placed in the gap left by a quiet
 * one was sitting on top of it the moment it spoke again.
 *
 * So the assertions here are about persistence and about collisions rather than
 * about pixels: a placement is written down, a written-down placement does not
 * move because a neighbour came or went, and no two tiles ever share ground.
 * The arithmetic those rest on is tested in `utils/overlay-layout.test.js`.
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
vi.mock('../../utils/floating-panel.js', () => ({ makeDraggable: () => () => {}, makeResizable: () => () => {} }));

const registry = vi.hoisted(() => ({ rows: [] }));

// Only the registry is stood in for — the empty-tile policy the same module
// exports is the real one, because what a quiet tile does is half of this
vi.mock('../../utils/overlay-rows.js', async (importActual) => ({
    ...(await importActual()),
    registeredRows: () => registry.rows,
    moveRow: (order) => order,
}));
vi.mock('../../utils/opanel-config.js', () => ({ fromOPanelConfig: () => null, toOPanelConfig: () => ({}) }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));

const overlayPanel = (await import('./overlay-panel.js')).default;

/**
 * A row that always has something to say.
 * @param {string} key - Row key
 * @param {{width: number, height: number}} size - Its natural tile
 * @returns {Object} A row definition
 */
function speaking(key, size) {
    return {
        key,
        name: key,
        defaultVisible: true,
        defaultSize: size,
        render: (element) => (element.textContent = key),
    };
}

/**
 * A row that says nothing until it is told to, and hides while it is quiet.
 * @param {string} key - Row key
 * @param {{width: number, height: number}} size - Its natural tile
 * @returns {Object} A row definition with a `quiet` flag on it
 */
function sometimes(key, size) {
    const row = {
        ...speaking(key, size),
        tileClass: 'measurement',
        render: (element) => (element.textContent = row.quiet ? '' : key),
    };
    row.quiet = true;
    return row;
}

/** Where every tile currently sits, as the settings hold it. @returns {Object} */
function placed() {
    const out = {};
    for (const row of registry.rows) {
        const spot = overlayPanel.settings.positions[row.key];
        const size = overlayPanel.settings.sizes[row.key] || row.defaultSize;
        if (spot) out[row.key] = { key: row.key, ...spot, ...size };
    }
    return out;
}

/**
 * Whether any two of the tiles handed in cover the same ground.
 * @param {Array<Object>} tiles - Placed tiles
 * @returns {boolean}
 */
function anyOverlap(tiles) {
    for (let i = 0; i < tiles.length; i += 1) {
        for (let j = i + 1; j < tiles.length; j += 1) {
            const [a, b] = [tiles[i], tiles[j]];
            const apart =
                a.x >= b.x + b.width || b.x >= a.x + a.width || a.y >= b.y + b.height || b.y >= a.y + a.height;
            if (!apart) return true;
        }
    }
    return false;
}

beforeEach(() => {
    registry.rows = [];
    overlayPanel.settings = {
        ...overlayPanel.settings,
        visible: {},
        order: [],
        positions: {},
        sizes: {},
        zoom: {},
        locked: true,
        snapToGrid: true,
        separators: true,
        textScale: 100,
        curatedDefaults: false,
        emptyTiles: 'auto',
    };
});

afterEach(() => {
    overlayPanel.hide();
    vi.restoreAllMocks();
});

describe('the first arrangement', () => {
    test('is a grid rather than a pile, and is written down', () => {
        registry.rows = [
            speaking('a', { width: 180, height: 30 }),
            speaking('b', { width: 130, height: 30 }),
            speaking('c', { width: 200, height: 46 }),
            speaking('d', { width: 160, height: 30 }),
            speaking('e', { width: 280, height: 40 }),
            speaking('f', { width: 180, height: 30 }),
        ];
        overlayPanel.show();

        const tiles = Object.values(placed());
        expect(tiles).toHaveLength(6);
        expect(anyOverlap(tiles)).toBe(false);

        // Two columns, and every tile starts at one of them. The jumble was
        // tiles starting wherever the previous one happened to end
        const lefts = new Set(tiles.map((tile) => tile.x));
        expect(lefts.size).toBe(2);
        // Which means the ones sharing a column share a width
        for (const left of lefts) {
            const column = tiles.filter((tile) => tile.x === left);
            expect(new Set(column.map((tile) => tile.width)).size).toBeLessThanOrEqual(2);
        }
    });

    test('is not recomputed on every draw', () => {
        registry.rows = [speaking('a', { width: 180, height: 30 }), speaking('b', { width: 200, height: 46 })];
        overlayPanel.show();

        const first = JSON.stringify(placed());
        overlayPanel._renderBody();
        overlayPanel._renderBody();
        expect(JSON.stringify(placed())).toBe(first);
    });
});

describe('tiles coming and going', () => {
    test('a tile that goes quiet does not move the ones around it', () => {
        const quiet = sometimes('quiet', { width: 200, height: 46 });
        registry.rows = [
            speaking('a', { width: 180, height: 30 }),
            quiet,
            speaking('b', { width: 180, height: 30 }),
            speaking('c', { width: 180, height: 30 }),
        ];
        quiet.quiet = false;
        overlayPanel.show();

        const before = placed();
        // Every one of them has a position at all, which is the fix: before it,
        // they were placed afresh on every draw and never written down
        expect(Object.keys(before)).toHaveLength(4);

        quiet.quiet = true;
        overlayPanel._renderBody();

        for (const key of ['a', 'b', 'c']) expect(placed()[key]).toEqual(before[key]);
    });

    test('a tile that comes back is not underneath the one that took its place', () => {
        // The collision the old placement produced: a new tile dropped into the
        // gap a quiet one had left, and the quiet one then had something to say
        const quiet = sometimes('quiet', { width: 200, height: 46 });
        registry.rows = [speaking('a', { width: 180, height: 30 }), quiet, speaking('b', { width: 180, height: 30 })];
        overlayPanel.show();

        // A row arrives while the measurement tile is hidden — a feature
        // switched on, an update adding a tile
        registry.rows = [...registry.rows, speaking('late', { width: 180, height: 30 })];
        overlayPanel._renderBody();

        quiet.quiet = false;
        overlayPanel._renderBody();

        expect(anyOverlap(Object.values(placed()))).toBe(false);
    });

    test('a new row lands at a corner of the arrangement rather than in a sliver of it', () => {
        registry.rows = [speaking('a', { width: 180, height: 30 }), speaking('b', { width: 180, height: 30 })];
        overlayPanel.show();

        const lefts = new Set(Object.values(placed()).map((tile) => tile.x));
        registry.rows = [...registry.rows, speaking('late', { width: 130, height: 30 })];
        overlayPanel._renderBody();

        // It joins a column that is already there rather than starting one of
        // its own halfway across
        expect(lefts.has(placed().late.x)).toBe(true);
        expect(anyOverlap(Object.values(placed()))).toBe(false);
    });
});

describe('lines settling to what they drew', () => {
    /**
     * Where each tile is actually drawn, as the panel styled it.
     * @returns {Object} `{ [key]: {top, height} }`
     */
    function drawn() {
        const out = {};
        for (const [key, tile] of overlayPanel.tiles) {
            out[key] = { top: Number.parseFloat(tile.style.top), height: Number.parseFloat(tile.style.height) };
        }
        return out;
    }

    /**
     * Open on three lines of one tile each, the middle one able to go quiet.
     * @returns {Object} The middle row, with a `quiet` flag on it
     */
    function threeLines() {
        const middle = sometimes('middle', { width: 220, height: 80 });
        registry.rows = [
            speaking('top', { width: 220, height: 30 }),
            middle,
            speaking('bottom', { width: 220, height: 30 }),
        ];
        overlayPanel.settings.visible = { top: true, middle: true, bottom: true };
        overlayPanel.settings.order = ['top', 'middle', 'bottom'];
        overlayPanel.settings.positions = {
            top: { x: 0, y: 0 },
            middle: { x: 0, y: 30 },
            bottom: { x: 0, y: 110 },
        };
        overlayPanel.settings.sizes = {
            top: { width: 220, height: 30 },
            middle: { width: 220, height: 80 },
            bottom: { width: 220, height: 30 },
        };
        return middle;
    }

    test('a tile standing down pulls the line below it up', () => {
        const middle = threeLines();
        middle.quiet = false;
        overlayPanel.show();
        expect(drawn().bottom.top).toBe(110);

        middle.quiet = true;
        overlayPanel._renderBody();

        // Eighty pixels of tile became a twenty-pixel strip, and the tile below
        // came up to meet it rather than leaving a blank band
        expect(drawn().middle.height).toBe(20);
        expect(drawn().bottom.top).toBe(50);
        // Sideways, nothing moved at all
        expect(overlayPanel.tiles.get('bottom').style.left).toBe('0px');
    });

    test('and the arrangement comes straight back when it fills in again', () => {
        const middle = threeLines();
        overlayPanel.show();
        expect(drawn().bottom.top).toBe(50);

        middle.quiet = false;
        overlayPanel._renderBody();

        expect(drawn().bottom.top).toBe(110);
        // Nothing of this was written down — the saved layout is still the one
        // that was designed
        expect(overlayPanel.settings.positions.bottom).toEqual({ x: 0, y: 110 });
        expect(overlayPanel.settings.sizes.middle).toEqual({ width: 220, height: 80 });
    });

    test('nothing settles while the tiles are being arranged', () => {
        // Unlocked, a drag writes back where a tile was dropped — so a settled
        // position must never be the one under the pointer
        const middle = threeLines();
        middle.quiet = true;
        overlayPanel.settings.locked = false;
        overlayPanel.show();

        expect(drawn().bottom.top).toBe(110);
        expect(drawn().middle.height).toBe(80);
    });
});

describe('Reset layout', () => {
    test('arranges rather than merely forgetting', () => {
        registry.rows = [
            speaking('a', { width: 180, height: 30 }),
            speaking('b', { width: 180, height: 30 }),
            speaking('c', { width: 180, height: 30 }),
        ];
        overlayPanel.show();

        // A layout somebody has made a mess of
        overlayPanel.settings.positions = { a: { x: 37, y: 91 }, b: { x: 41, y: 95 }, c: { x: 12, y: 3 } };
        overlayPanel._resetLayout();

        const tiles = Object.values(placed());
        expect(anyOverlap(tiles)).toBe(false);
        for (const tile of tiles) {
            expect(tile.x % 10).toBe(0);
            expect(tile.y % 10).toBe(0);
        }
        expect(new Set(tiles.map((tile) => tile.x)).size).toBeLessThanOrEqual(2);
    });
});
