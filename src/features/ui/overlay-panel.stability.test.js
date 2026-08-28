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

describe('a preset with rows switched on that it does not name', () => {
    /**
     * Every tile as it is actually drawn, which is the only geometry that can
     * be seen to collide.
     * @returns {Array<Object>} `{key, x, y, width, height}`
     */
    function drawnBoxes() {
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
     * Give the panel a canvas the fixture below actually fits on, so what is
     * being measured is where tiles were put rather than the squeeze.
     * @param {number} canvas - Usable width, in pixels
     */
    function canvasIs(canvas) {
        const outer = canvas + 12 + 16;
        for (const property of ['offsetWidth', 'clientWidth']) {
            Object.defineProperty(overlayPanel.scrollEl, property, { value: outer, configurable: true });
        }
        overlayPanel.lastCanvasWidth = overlayPanel._canvasWidth();
        overlayPanel._renderBody();
    }

    /** A Skilling-preset-shaped arrangement, with three of its tiles empty */
    function skillingWithStrays() {
        const empty = (key, size) => ({ ...sometimes(key, size), quiet: true });
        registry.rows = [
            // Two rows the preset does not name, ahead of it in the order —
            // which is where a row the saved order has never heard of ends up
            empty('watchlist', { width: 230, height: 30 }),
            empty('charmValue', { width: 230, height: 30 }),
            speaking('skillLevel', { width: 230, height: 30 }),
            speaking('timeToLevel', { width: 230, height: 30 }),
            speaking('experiencePerHour', { width: 230, height: 30 }),
            speaking('queueTimeLeft', { width: 230, height: 30 }),
            empty('consumables', { width: 460, height: 80 }),
            empty('houses', { width: 460, height: 50 }),
        ];
        overlayPanel.settings.visible = Object.fromEntries(registry.rows.map((row) => [row.key, true]));
        overlayPanel.settings.order = registry.rows.map((row) => row.key);
        // The preset's own tiles are placed; the two strays are not
        overlayPanel.settings.positions = {
            skillLevel: { x: 0, y: 0 },
            timeToLevel: { x: 230, y: 0 },
            experiencePerHour: { x: 0, y: 30 },
            queueTimeLeft: { x: 230, y: 30 },
            consumables: { x: 0, y: 60 },
            houses: { x: 0, y: 140 },
        };
        overlayPanel.settings.sizes = {
            skillLevel: { width: 230, height: 30 },
            timeToLevel: { width: 230, height: 30 },
            experiencePerHour: { width: 230, height: 30 },
            queueTimeLeft: { width: 230, height: 30 },
            consumables: { width: 460, height: 80 },
            houses: { width: 460, height: 50 },
        };
    }

    test('draws nothing on top of anything else, locked or unlocked', () => {
        // Reported live: the watch list and the houses tile drew over each
        // other, their placeholder lines colliding, in both states
        skillingWithStrays();
        overlayPanel.settings.locked = true;
        overlayPanel.show();
        canvasIs(460);

        expect(drawnBoxes().length).toBe(registry.rows.length);
        expect(anyOverlap(drawnBoxes())).toBe(false);

        // Arranging shows every tile at full size, which is the state the
        // collision was plainest in
        overlayPanel.settings.locked = false;
        overlayPanel._renderBody();
        expect(anyOverlap(drawnBoxes())).toBe(false);

        overlayPanel.settings.locked = true;
        overlayPanel._renderBody();
        expect(anyOverlap(drawnBoxes())).toBe(false);
    });

    test('and the preset keeps its own tiles exactly where it put them', () => {
        skillingWithStrays();
        overlayPanel.show();
        canvasIs(460);

        const at = Object.fromEntries(drawnBoxes().map((tile) => [tile.key, tile]));
        expect(at.skillLevel.x).toBe(0);
        expect(at.timeToLevel.x).toBe(230);
        // The strays went below the arrangement rather than into it
        expect(at.watchlist.y).toBeGreaterThanOrEqual(at.houses.y);
        expect(at.charmValue.y).toBeGreaterThanOrEqual(at.houses.y);
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

    test('a tile flickering between drawn and empty never moves its neighbour', () => {
        // What a player watched happen: the experience-per-hour tile filling in
        // and emptying as the tracker ticked. Its own height may change — that
        // is the line reporting honestly — but the tile beside it shares the
        // line, so nothing on that line may move sideways or up and down.
        const flicker = sometimes('flicker', { width: 220, height: 30 });
        registry.rows = [flicker, speaking('steady', { width: 220, height: 30 })];
        overlayPanel.settings.visible = { flicker: true, steady: true };
        overlayPanel.settings.order = ['flicker', 'steady'];
        overlayPanel.settings.positions = { flicker: { x: 0, y: 0 }, steady: { x: 220, y: 0 } };
        overlayPanel.settings.sizes = {
            flicker: { width: 220, height: 30 },
            steady: { width: 220, height: 30 },
        };
        overlayPanel.show();

        const seen = new Set();
        for (let tick = 0; tick < 6; tick += 1) {
            flicker.quiet = tick % 2 === 0;
            overlayPanel._renderBody();

            const steady = overlayPanel.tiles.get('steady');
            seen.add([steady.style.left, steady.style.top, steady.style.width, steady.style.height].join(','));

            // And the two are level with each other on every one of them
            const strip = overlayPanel.tiles.get('flicker');
            expect(strip.style.top).toBe(steady.style.top);
            expect(strip.style.height).toBe(steady.style.height);
        }

        expect(seen.size).toBe(1);
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
