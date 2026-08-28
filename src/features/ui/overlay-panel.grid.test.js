/**
 * @vitest-environment happy-dom
 *
 * The layout, now that it is a grid.
 *
 * This replaces `overlay-panel.narrow.test.js` and most of
 * `overlay-panel.stability.test.js`, both of which described behaviours that
 * have stopped being possible rather than merely stopped being wrong. Two tiles
 * cannot overlap, nothing can be drawn past the right edge, nothing can arrive
 * unplaced, and no arrangement can fail to fit a width — none of that is a
 * property to test any more, because none of it is representable.
 *
 * What is left worth asserting is small and is all here: the column count is an
 * integer the panel measures once, a saved layout is the same layout at every
 * width, reading order is document order, and a tile going quiet leaves the flow
 * without taking anything else with it.
 *
 * The tiles are read off the canvas rather than off `settings.order` filtered by
 * `settings.visible`, deliberately. That pair was telling the truth while the
 * panel drew something else once before, and it matters more now, not less: with
 * order and visibility being the whole of the layout it would be very easy to
 * write a suite that only ever checks its own inputs.
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
const { COLUMN_MIN, GAP, MAX_SPAN } = await import('../../utils/overlay-flow.js');

/**
 * A row that always has something to say.
 * @param {string} key - Row key
 * @param {Object} [size] - Its declared default size
 * @returns {Object} A row definition
 */
function speaking(key, size = { width: 200, height: 30 }) {
    return {
        key,
        name: key,
        defaultVisible: true,
        defaultSize: size,
        render: (element) => (element.textContent = key),
    };
}

/**
 * A row that says nothing until it is told to.
 * @param {string} key - Row key
 * @returns {Object} A row definition with a `quiet` flag on it
 */
function sometimes(key) {
    const row = {
        ...speaking(key),
        tileClass: 'measurement',
        render: (element) => (row.quiet ? element.replaceChildren() : (element.textContent = key)),
    };
    row.quiet = true;
    return row;
}

/**
 * Tell the panel how wide its scroller is. The one measurement in the system.
 * @param {number} outer - The scroller's border box, in pixels
 */
function scrollerIs(outer) {
    for (const property of ['offsetWidth', 'clientWidth']) {
        Object.defineProperty(overlayPanel.scrollEl, property, { value: outer, configurable: true });
    }
    overlayPanel._applyColumns();
    overlayPanel._renderBody();
}

/** The tiles on screen, in the order the document holds them. @returns {string[]} */
function drawn() {
    return [...overlayPanel.canvasEl.querySelectorAll('[data-overlay-row]')]
        .filter((tile) => tile.style.display !== 'none')
        .map((tile) => tile.dataset.overlayRow);
}

/**
 * What the grid says about one tile.
 * @param {string} key - Row key
 * @returns {string} Its `grid-column`
 */
function column(key) {
    return overlayPanel.tiles.get(key).style.gridColumn;
}

beforeEach(() => {
    registry.rows = [];
    overlayPanel.settings = {
        ...overlayPanel.settings,
        version: 2,
        visible: {},
        order: [],
        span: {},
        zoom: {},
        locked: true,
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

describe('the canvas', () => {
    test('is a grid whose column count is a custom property', () => {
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.display).toBe('grid');
        expect(overlayPanel.canvasEl.style.gridTemplateColumns).toContain('minmax(0, 1fr)');
        expect(overlayPanel.canvasEl.style.getPropertyValue('--overlay-columns')).toBe('2');
    });

    test('keeps `minmax(0, 1fr)` rather than a bare `1fr`', () => {
        // Load-bearing: `1fr` is `minmax(auto, 1fr)`, and `auto` lets one long
        // unbreakable item name force its track wider than its share
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.gridTemplateColumns).not.toMatch(/repeat\([^,]+, 1fr\)/);
    });

    test('draws every tile in a row to the height of the tallest', () => {
        // Which used to be computed and written into both of them
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.alignItems).toBe('stretch');
    });

    test('is never given a width or a height of its own', () => {
        // The draw used to write both, which the resize observer then saw — the
        // loop that observer had to be guarded against no longer exists
        registry.rows = [speaking('a')];
        overlayPanel.settings.visible = { a: true };
        overlayPanel.settings.order = ['a'];
        overlayPanel.show();

        expect(overlayPanel.canvasEl.style.width).toBe('');
        expect(overlayPanel.canvasEl.style.height).toBe('');
    });
});

describe('how many columns there are', () => {
    beforeEach(() => {
        registry.rows = [speaking('a'), speaking('b')];
        overlayPanel.settings.visible = { a: true, b: true };
        overlayPanel.settings.order = ['a', 'b'];
        overlayPanel.show();
    });

    test('two on the panel every preset is written for', () => {
        // The first thing to check: if the default panel ever reads as one
        // column, every preset is wrong
        scrollerIs(464);
        expect(overlayPanel.columns).toBe(2);
    });

    test('one on a phone, more on a wide panel, never past the ceiling', () => {
        scrollerIs(382);
        expect(overlayPanel.columns).toBe(1);

        scrollerIs(712);
        expect(overlayPanel.columns).toBe(3);

        scrollerIs(2000);
        expect(overlayPanel.columns).toBe(MAX_SPAN);
    });

    test('a scrollbar appearing cannot change it', () => {
        // The oscillation of two rounds ago, now unrepresentable: the count is
        // an integer taken from the border box, which a scrollbar does not move
        scrollerIs(2 * COLUMN_MIN + GAP + 40);
        const before = overlayPanel.columns;

        Object.defineProperty(overlayPanel.scrollEl, 'clientWidth', {
            value: overlayPanel.scrollEl.offsetWidth - 15,
            configurable: true,
        });
        overlayPanel._applyColumns();

        expect(overlayPanel.columns).toBe(before);
    });
});

describe('a saved layout', () => {
    beforeEach(() => {
        registry.rows = [speaking('first'), speaking('wide'), speaking('last')];
        overlayPanel.settings.visible = { first: true, wide: true, last: true };
        overlayPanel.settings.order = ['first', 'wide', 'last'];
        overlayPanel.settings.span = { wide: 2 };
        overlayPanel.show();
    });

    test('is drawn in reading order, which is document order', () => {
        expect(drawn()).toEqual(['first', 'wide', 'last']);
    });

    test('gives each tile the columns it asked for', () => {
        scrollerIs(464);
        expect(column('first')).toBe('span 1');
        expect(column('wide')).toBe('span 2');
    });

    test('is the same layout at every width, with no second code path', () => {
        // A span clamps to the columns there are. That is the whole of the
        // narrow-screen story now — no flow, no squeeze, no arrangement that
        // has to be abandoned and re-dealt.
        for (const outer of [382, 464, 712, 2000]) {
            scrollerIs(outer);
            expect(drawn()).toEqual(['first', 'wide', 'last']);
            expect(column('wide')).toBe(`span ${Math.min(2, overlayPanel.columns)}`);
        }
    });

    test('survives a resize without anything being written back to it', () => {
        const before = JSON.stringify({ order: overlayPanel.settings.order, span: overlayPanel.settings.span });

        scrollerIs(382);
        scrollerIs(2000);
        scrollerIs(464);

        expect(JSON.stringify({ order: overlayPanel.settings.order, span: overlayPanel.settings.span })).toBe(before);
    });

    test('carries a height floor from the row rather than a height', () => {
        // Heights are content. The floor is what stops a tile whose figures
        // change every second from resizing the grid under the reader.
        registry.rows = [speaking('roomy', { width: 200, height: 70 })];
        overlayPanel.settings.visible = { roomy: true };
        overlayPanel.settings.order = ['roomy'];
        overlayPanel._renderBody();

        const tile = overlayPanel.tiles.get('roomy');
        expect(tile.style.minHeight).toBe('70px');
        expect(tile.style.height).toBe('');
    });
});

describe('a tile with nothing to say', () => {
    /** @returns {Object} The middle row, with a `quiet` flag on it */
    function threeTiles() {
        const middle = sometimes('middle');
        registry.rows = [speaking('above'), middle, speaking('below')];
        overlayPanel.settings.visible = { above: true, middle: true, below: true };
        overlayPanel.settings.order = ['above', 'middle', 'below'];
        overlayPanel.show();
        return middle;
    }

    test('keeps its place in the order and names itself', () => {
        const middle = threeTiles();
        middle.quiet = true;
        overlayPanel._renderBody();

        expect(drawn()).toEqual(['above', 'middle', 'below']);
        expect(overlayPanel.tiles.get('middle')._content.textContent).toBe('middle');
    });

    test('leaves the flow entirely when told to hide, and nothing is left behind', () => {
        // Which used to be a trap: a vanished tile left its coordinates behind
        // as a hole. On a grid, `display: none` closes the flow perfectly.
        const middle = threeTiles();
        middle.quiet = true;
        overlayPanel.settings.emptyTiles = 'hide';
        overlayPanel._renderBody();

        expect(drawn()).toEqual(['above', 'below']);
        expect(overlayPanel.tiles.get('middle').style.display).toBe('none');
    });

    test('comes back into the flow the moment it has something to say', () => {
        const middle = threeTiles();
        middle.quiet = true;
        overlayPanel.settings.emptyTiles = 'hide';
        overlayPanel._renderBody();
        expect(drawn()).toEqual(['above', 'below']);

        middle.quiet = false;
        overlayPanel._renderBody();

        expect(drawn()).toEqual(['above', 'middle', 'below']);
    });

    test('filling in and emptying moves nothing around it', () => {
        const middle = threeTiles();

        for (let tick = 0; tick < 8; tick += 1) {
            middle.quiet = tick % 2 === 0;
            overlayPanel._renderBody();

            expect(drawn()).toEqual(['above', 'middle', 'below']);
            expect(column('below')).toBe('span 1');
        }
    });
});

describe('a row the saved order has never heard of', () => {
    test('is drawn after the ones it has, without disturbing them', () => {
        registry.rows = [speaking('known'), speaking('newcomer')];
        overlayPanel.settings.visible = { known: true, newcomer: true };
        overlayPanel.settings.order = ['known'];
        overlayPanel.show();

        expect(drawn()).toEqual(['known', 'newcomer']);
    });

    test('and takes the columns its own row declared', () => {
        registry.rows = [speaking('known'), speaking('broad', { width: 460, height: 30 })];
        overlayPanel.settings.visible = { known: true, broad: true };
        overlayPanel.settings.order = ['known'];
        overlayPanel.show();
        scrollerIs(464);

        expect(column('broad')).toBe('span 2');
    });
});
