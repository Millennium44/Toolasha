import { describe, test, expect } from 'vitest';
import {
    snap,
    overlaps,
    findFreeSpot,
    clampTile,
    clampZoom,
    resolveLayout,
    autoGrid,
    snapUp,
    compactColumns,
    settleLines,
    squeezeToWidth,
    contentBounds,
    columnWidth,
    gridColumns,
    gridOrder,
    materializeGrid,
    GRID,
    DEFAULT_TILE,
    DEFAULT_ZOOM,
    COMPACT_TILE,
    MIN_TILE,
} from './overlay-layout.js';

/**
 * Every pair of tiles, for the assertions that are about the set rather than a
 * member of it.
 * @param {Array<Object>} tiles - Placed tiles
 * @returns {Array<Array<Object>>} Pairs
 */
function pairs(tiles) {
    const out = [];
    for (let i = 0; i < tiles.length; i += 1) {
        for (let j = i + 1; j < tiles.length; j += 1) out.push([tiles[i], tiles[j]]);
    }
    return out;
}

describe('snap', () => {
    test('rounds to the nearest step', () => {
        expect(snap(14)).toBe(10);
        expect(snap(15)).toBe(20);
        expect(snap(37, 25)).toBe(25);
    });

    test('a step of one is snapping switched off', () => {
        expect(snap(14, 1)).toBe(14);
        expect(snap(14.6, 1)).toBe(15);
    });
});

describe('snapUp', () => {
    test('rounds up to the next step', () => {
        expect(snapUp(241)).toBe(250);
        expect(snapUp(240)).toBe(240);
        expect(snapUp(26, 25)).toBe(50);
    });

    test('a step of one is snapping switched off', () => {
        expect(snapUp(14, 1)).toBe(14);
        expect(snapUp(14.2, 1)).toBe(15);
    });
});

describe('overlaps', () => {
    const tile = { x: 0, y: 0, width: 100, height: 50 };

    test('sees a genuine overlap', () => {
        expect(overlaps(tile, { x: 50, y: 25, width: 100, height: 50 })).toBe(true);
    });

    test('touching edges is not overlapping', () => {
        // Otherwise two tiles laid side by side would be reported as colliding,
        // and the packer would leave a gap between everything
        expect(overlaps(tile, { x: 100, y: 0, width: 50, height: 50 })).toBe(false);
        expect(overlaps(tile, { x: 0, y: 50, width: 50, height: 50 })).toBe(false);
    });
});

describe('findFreeSpot', () => {
    test('an empty canvas puts the tile at the origin', () => {
        expect(findFreeSpot([], { width: 100, height: 30 }, 400)).toEqual({ x: 0, y: 0 });
    });

    test('goes beside what is already there rather than on top of it', () => {
        const placed = [{ x: 0, y: 0, width: 100, height: 30 }];
        expect(findFreeSpot(placed, { width: 100, height: 30 }, 400)).toEqual({ x: 100, y: 0 });
    });

    test('wraps when the line is full', () => {
        const placed = [{ x: 0, y: 0, width: 200, height: 30 }];
        expect(findFreeSpot(placed, { width: 100, height: 30 }, 200)).toEqual({ x: 0, y: 30 });
    });

    test('a full canvas goes below everything, not under something', () => {
        // Out of sight can be scrolled to; hidden under another tile cannot be
        // found at all
        const placed = [{ x: 0, y: 0, width: 400, height: 60 }];
        expect(findFreeSpot(placed, { width: 400, height: 30 }, 400)).toEqual({ x: 0, y: 60 });
    });

    test('a tile wider than the canvas still lands somewhere', () => {
        expect(findFreeSpot([], { width: 900, height: 30 }, 400)).toEqual({ x: 0, y: 0 });
    });
});

describe('clampTile', () => {
    test('pulls a tile back from past the right edge', () => {
        expect(clampTile({ x: 500, y: 10 }, { width: 100, height: 30 }, { width: 400 })).toEqual({ x: 300, y: 10 });
    });

    test('leaves the bottom alone, because the canvas scrolls', () => {
        expect(clampTile({ x: 0, y: 9000 }, { width: 100, height: 30 }, { width: 400 }).y).toBe(9000);
    });

    test('a tile wider than the canvas sits at zero, not at a negative offset', () => {
        expect(clampTile({ x: 50, y: 0 }, { width: 900, height: 30 }, { width: 400 }).x).toBe(0);
    });
});

describe('clampZoom', () => {
    test('holds a zoom inside what stays legible', () => {
        expect(clampZoom(10)).toBe(50);
        expect(clampZoom(900)).toBe(200);
        expect(clampZoom(115)).toBe(115);
    });

    test('nonsense falls back to the default rather than to zero', () => {
        expect(clampZoom(undefined)).toBe(DEFAULT_ZOOM);
        expect(clampZoom(NaN)).toBe(DEFAULT_ZOOM);
    });
});

describe('resolveLayout', () => {
    const rows = [{ key: 'a' }, { key: 'b' }];

    test('uses what was saved', () => {
        const layout = {
            positions: { a: { x: 20, y: 40 } },
            sizes: { a: { width: 90, height: 50 } },
            zoom: { a: 130 },
        };
        expect(resolveLayout(rows, layout, 400)[0]).toMatchObject({ x: 20, y: 40, width: 90, height: 50, zoom: 130 });
    });

    test('a row no saved layout knows about is placed, not stacked at the origin', () => {
        // A new row hidden under an old one reads as a row that failed to render
        const layout = { positions: { a: { x: 0, y: 0 } }, sizes: {} };
        const [first, second] = resolveLayout(rows, layout, 400);
        expect(second.x).toBe(first.width);
        expect(second.y).toBe(0);
    });

    test('a row can ask for its own default size', () => {
        const wide = [{ key: 'a', defaultSize: { width: 280, height: 70 } }];
        expect(resolveLayout(wide, {}, 400)[0]).toMatchObject({ width: 280, height: 70 });
    });

    test('falls back to the standard tile', () => {
        expect(resolveLayout([{ key: 'a' }], {}, 400)[0]).toMatchObject(DEFAULT_TILE);
    });

    test('a saved position off the edge is pulled back', () => {
        const layout = { positions: { a: { x: 5000, y: 0 } }, sizes: {} };
        expect(resolveLayout([{ key: 'a' }], layout, 400)[0].x).toBe(400 - DEFAULT_TILE.width);
    });

    test('survives no saved layout at all', () => {
        expect(resolveLayout(rows, null, 400)).toHaveLength(2);
    });

    test('a last word on sizes can shrink a tile without touching what was saved', () => {
        // How an empty tile stands down to a strip: the size it was given is
        // still the size it has, so the arrangement survives the tile filling
        // itself in again
        const layout = { positions: {}, sizes: { a: { width: 200, height: 60 }, b: { width: 200, height: 60 } } };
        const shrink = (row, size) => (row.key === 'a' ? { width: size.width, height: COMPACT_TILE.height } : size);

        const [first, second] = resolveLayout(rows, layout, 400, shrink);
        expect(first.height).toBe(COMPACT_TILE.height);
        expect(first.width).toBe(200);
        expect(second.height).toBe(60);
        expect(layout.sizes.a.height).toBe(60);
    });

    test('the tile below a shrunken one moves up to meet it', () => {
        // Otherwise the panel is a grid with a hole where a quiet feature is
        const narrow = 200;
        const layout = { positions: {}, sizes: {} };
        const shrink = (row, size) => (row.key === 'a' ? { ...size, height: COMPACT_TILE.height } : size);

        const [, second] = resolveLayout(rows, layout, narrow, shrink);
        expect(second.y).toBe(COMPACT_TILE.height);
    });
});

describe('gridColumns', () => {
    test('sizes the columns to the ordinary tile rather than to the widest', () => {
        // One three-line block among a dozen one-liners must not turn a 460
        // canvas into a single column of half-empty tiles
        const tiles = [
            { width: 180, height: 30 },
            { width: 180, height: 30 },
            { width: 200, height: 30 },
            { width: 280, height: 90 },
        ];
        expect(gridColumns(tiles, 460)).toBe(2);
    });

    test('never fewer than one, whatever it is handed', () => {
        expect(gridColumns([], 460)).toBe(1);
        expect(gridColumns([{ width: 900, height: 30 }], 200)).toBe(1);
    });
});

describe('columnWidth', () => {
    test('snaps down, so the last column still ends inside the canvas', () => {
        expect(columnWidth(456, 2)).toBe(220);
        expect(columnWidth(456, 2) * 2).toBeLessThanOrEqual(456);
    });
});

describe('autoGrid', () => {
    const tiles = [
        { key: 'a', width: 160, height: 30 },
        { key: 'b', width: 160, height: 30 },
        { key: 'c', width: 160, height: 30 },
    ];

    test('lays tiles left to right in columns of one width, and wraps', () => {
        const [a, b, c] = autoGrid(tiles, 340);

        expect(a.x).toBe(0);
        expect(b.x).toBe(a.width);
        expect(a.width).toBe(b.width);
        expect(c).toMatchObject({ key: 'c', x: 0 });
        expect(c.y).toBeGreaterThanOrEqual(a.height);
    });

    test('every column edge is the same on every line', () => {
        // The whole of the complaint: a shelf packer advances by each tile's own
        // width, so the second column starts somewhere different on every line
        const mixed = [
            { key: 'a', width: 180, height: 30 },
            { key: 'b', width: 130, height: 30 },
            { key: 'c', width: 200, height: 46 },
            { key: 'd', width: 160, height: 30 },
            { key: 'e', width: 220, height: 40 },
            { key: 'f', width: 180, height: 30 },
        ];
        const packed = autoGrid(mixed, 456);
        const lefts = new Set(packed.map((tile) => tile.x));

        expect(lefts.size).toBe(2);
        expect([...lefts].sort((first, second) => first - second)).toEqual([0, packed[0].width]);
    });

    test('tiles on a line are the same height, so none of them leaves a sliver', () => {
        const mixed = [
            { key: 'tall', width: 160, height: 100 },
            { key: 'short', width: 160, height: 30 },
            { key: 'next', width: 160, height: 30 },
        ];
        const [tall, short, next] = autoGrid(mixed, 340);

        expect(short.height).toBe(tall.height);
        expect(short.y).toBe(tall.y);
        // And the line below clears the tallest rather than the last
        expect(next.y).toBeGreaterThanOrEqual(100);
    });

    test('a wide tile does not leave a half-empty line above itself', () => {
        // Reading order with one concession: the tile that fits the gap is taken
        // ahead of the one that cannot, rather than closing the line early
        const mixed = [
            { key: 'narrow', width: 180, height: 30 },
            { key: 'wide', width: 440, height: 40 },
            { key: 'after', width: 180, height: 30 },
        ];
        const placed = Object.fromEntries(autoGrid(mixed, 456).map((tile) => [tile.key, tile]));

        expect(placed.after.y).toBe(placed.narrow.y);
        expect(placed.wide.y).toBeGreaterThan(placed.narrow.y);
    });

    test('a tile is widened to whole columns, never narrowed below what it asked for', () => {
        const mixed = [
            { key: 'ordinary', width: 180, height: 30 },
            { key: 'wide', width: 280, height: 90 },
        ];
        for (const tile of autoGrid(mixed, 456)) {
            const wanted = mixed.find((entry) => entry.key === tile.key).width;
            expect(tile.width).toBeGreaterThanOrEqual(wanted);
        }
    });

    test('nothing packed ever overlaps anything else', () => {
        const many = Array.from({ length: 13 }, (_, index) => ({
            key: `t${index}`,
            width: [130, 160, 180, 200, 220, 240, 280][index % 7],
            height: [30, 40, 46, 76, 90][index % 5],
        }));
        for (const [first, second] of pairs(autoGrid(many, 456))) {
            expect(overlaps(first, second)).toBe(false);
        }
    });

    test('a tile wider than the canvas does not wrap onto an empty line', () => {
        const oversized = [{ key: 'huge', width: 900, height: 30 }];
        expect(autoGrid(oversized, 400)[0]).toMatchObject({ key: 'huge', x: 0, y: 0 });
    });

    test('positions land on the grid', () => {
        const odd = [
            { key: 'a', width: 73, height: 30 },
            { key: 'b', width: 73, height: 30 },
        ];
        expect(autoGrid(odd, 400)[1].x % GRID).toBe(0);
    });

    test('a tile whose width is off the grid does not have the next one laid over it', () => {
        // 245 wide on a 10 grid: the advance used to snap to the *nearest* step,
        // which is 240 — five pixels back inside a tile that is already there.
        // Autogrid is the button that is supposed to tidy the canvas up
        const odd = [
            { key: 'a', width: 245, height: 30 },
            { key: 'b', width: 245, height: 30 },
        ];
        const [a, b] = autoGrid(odd, 600);
        expect(b.x).toBeGreaterThanOrEqual(a.x + 245);
        expect(b.x % GRID).toBe(0);
    });

    test('nor a wrapped line laid over the line above it', () => {
        // The same rounding, vertically: a 25-tall line advancing to 20
        const odd = [
            { key: 'a', width: 160, height: 25 },
            { key: 'b', width: 160, height: 25 },
        ];
        const [, b] = autoGrid(odd, 200);
        expect(b.y).toBeGreaterThanOrEqual(25);
        expect(b.y % GRID).toBe(0);
    });
});

describe('gridOrder', () => {
    test('reads a grid left to right and top to bottom, naming each tile once', () => {
        expect(gridOrder([['a', 'b'], ['c', 'c'], { cells: ['d', null], height: 70 }])).toEqual(['a', 'b', 'c', 'd']);
    });

    test('nothing at all is no order rather than a throw', () => {
        expect(gridOrder(null)).toEqual([]);
    });
});

describe('materializeGrid', () => {
    const spec = {
        columns: 2,
        grid: [
            ['a', 'b'],
            ['wide', 'wide'],
            ['c', 'd'],
        ],
    };
    const sizes = {
        a: { width: 180, height: 30 },
        b: { width: 130, height: 30 },
        wide: { width: 280, height: 40 },
        c: { width: 200, height: 46 },
        d: { width: 160, height: 30 },
    };

    test('two columns of one width, on the grid, inside the canvas', () => {
        const { positions, sizes: placed } = materializeGrid(spec, { width: 456, sizes });

        expect(positions.a).toEqual({ x: 0, y: 0 });
        expect(positions.b).toEqual({ x: 220, y: 0 });
        expect(placed.a).toEqual(placed.b);
        for (const key of Object.keys(placed)) {
            expect(positions[key].x % GRID).toBe(0);
            expect(positions[key].y % GRID).toBe(0);
            expect(positions[key].x + placed[key].width).toBeLessThanOrEqual(456);
        }
    });

    test('a key repeated across a line is one tile spanning it', () => {
        const { positions, sizes: placed } = materializeGrid(spec, { width: 456, sizes });

        expect(positions.wide).toEqual({ x: 0, y: 30 });
        expect(placed.wide.width).toBe(440);
    });

    test('a line is as tall as the tallest thing in it, and its tiles agree', () => {
        const { positions, sizes: placed } = materializeGrid(spec, { width: 456, sizes });

        expect(placed.c.height).toBe(50);
        expect(placed.d.height).toBe(placed.c.height);
        expect(positions.d.y).toBe(positions.c.y);
    });

    test('a line can ask for more room than its contents need', () => {
        const roomy = { columns: 2, grid: [{ cells: ['a', 'a'], height: 70 }] };
        expect(materializeGrid(roomy, { width: 456, sizes }).sizes.a.height).toBe(70);
    });

    test('a row that is not registered costs no hole, and empties its line', () => {
        const { positions } = materializeGrid(spec, {
            width: 456,
            sizes,
            available: new Set(['a', 'b', 'c', 'd']),
        });

        expect(positions.wide).toBeUndefined();
        // The line the missing tile had to itself is gone, rather than left as a
        // gap between the two that remain
        expect(positions.c.y).toBe(30);
    });

    test('nothing placed ever overlaps anything else', () => {
        const { positions, sizes: placed } = materializeGrid(spec, { width: 456, sizes });
        const tiles = Object.keys(placed).map((key) => ({ ...positions[key], ...placed[key] }));

        for (const [first, second] of pairs(tiles)) expect(overlaps(first, second)).toBe(false);
    });

    test('every tile stays large enough to be grabbed', () => {
        const { sizes: placed } = materializeGrid(spec, { width: 456, sizes });
        for (const size of Object.values(placed)) {
            expect(size.width).toBeGreaterThanOrEqual(MIN_TILE.width);
            expect(size.height).toBeGreaterThanOrEqual(MIN_TILE.height);
        }
    });

    test('too narrow for the design, it is packed rather than squeezed', () => {
        // Two columns of 150 is two columns of label and ellipsis
        const { positions, sizes: placed } = materializeGrid(spec, { width: 300, sizes });

        expect(new Set(Object.values(positions).map((spot) => spot.x))).toEqual(new Set([0]));
        for (const size of Object.values(placed)) expect(size.width).toBeLessThanOrEqual(300);
    });

    test('a row with no size of its own gets the standard tile', () => {
        const bare = { columns: 2, grid: [['a', 'b']] };
        expect(materializeGrid(bare, { width: 456 }).sizes.a.height).toBe(DEFAULT_TILE.height);
    });
});

describe('settleLines', () => {
    /**
     * A line of two tiles, each given `given` pixels and drawing `height`.
     * @param {string} name - Prefix for the keys
     * @param {number} y - Where the line sits
     * @param {number} given - What the layout allotted
     * @param {number} height - What was drawn
     * @returns {Array<Object>} Two tiles
     */
    const line = (name, y, given, height = given) => [
        { key: `${name}L`, x: 0, y, width: 220, given, height },
        { key: `${name}R`, x: 220, y, width: 220, given, height },
    ];

    test('a line that gave height back pulls the lines below it up', () => {
        // Consumables is four lines tall because it can be; on a character with
        // nothing slotted it is one, and the rest is a blank band
        const settled = settleLines([...line('a', 0, 30), ...line('b', 30, 80, 30), ...line('c', 110, 30)]);
        const at = Object.fromEntries(settled.map((tile) => [tile.key, tile.y]));

        expect(at.aL).toBe(0);
        expect(at.bL).toBe(30);
        expect(at.cL).toBe(60);
    });

    test('a line is as tall as the tallest thing drawn in it, not the shortest', () => {
        const settled = settleLines([
            { key: 'short', x: 0, y: 0, width: 220, given: 80, height: 20 },
            { key: 'tall', x: 220, y: 0, width: 220, given: 80, height: 50 },
            ...line('next', 80, 30),
        ]);

        expect(settled.find((tile) => tile.key === 'nextL').y).toBe(50);
    });

    test('space nobody gave back stays where it was', () => {
        // Ten pixels of air under a line is somebody's spacing, and closing it
        // would be rewriting the arrangement rather than tidying it
        const spaced = [...line('a', 0, 40), ...line('b', 50, 40)];
        expect(settleLines(spaced)).toEqual(spaced);
    });

    test('and is kept even by a line that did give some back', () => {
        const settled = settleLines([...line('a', 0, 40, 20), ...line('b', 50, 40)]);
        // The line shrank by 20, so the one below moves up by 20 — the ten
        // pixels of air between them survive
        expect(settled.find((tile) => tile.key === 'bL').y).toBe(30);
    });

    test('a line with nothing left in it takes no room', () => {
        // Every tile on it hid. The panel keeps them in the reckoning at no
        // height rather than dropping them, because a line that is simply
        // missing is indistinguishable from spacing somebody left
        const settled = settleLines([...line('a', 0, 30), ...line('b', 30, 30, 0), ...line('c', 60, 30)]);
        expect(settled.find((tile) => tile.key === 'cL').y).toBe(30);
    });

    test('tiles on a line all come out as tall as the line', () => {
        // A strip beside a taller tile, left at its own height, is a short box
        // at the top of a taller line with its label floating above the
        // neighbour's text. The line is that tall either way.
        const settled = settleLines([
            { key: 'strip', x: 0, y: 0, width: 220, given: 30, height: 20 },
            { key: 'drawn', x: 220, y: 0, width: 220, given: 30, height: 30 },
            ...line('next', 30, 30),
        ]);
        const at = Object.fromEntries(settled.map((tile) => [tile.key, tile]));

        expect(at.strip.height).toBe(30);
        expect(at.drawn.height).toBe(30);
        expect(at.strip.y).toBe(at.drawn.y);
        // And the line below still sits directly under it
        expect(at.nextL.y).toBe(30);
    });

    test('a line every tile of which stood down is short, not padded back out', () => {
        const settled = settleLines([...line('a', 0, 30, 20), ...line('b', 30, 30)]);
        const at = Object.fromEntries(settled.map((tile) => [tile.key, tile]));

        expect(at.aL.height).toBe(20);
        expect(at.bL.y).toBe(20);
    });

    test('a tile drawn at no height is left at none', () => {
        // It has taken itself off screen rather than being merely short, so the
        // line's height is not an offer it should take up
        const settled = settleLines([
            { key: 'gone', x: 0, y: 0, width: 220, given: 30, height: 0 },
            { key: 'here', x: 220, y: 0, width: 220, given: 30, height: 30 },
        ]);

        expect(settled.find((tile) => tile.key === 'gone').height).toBe(0);
    });

    test('a hand-arranged layout is handed straight back', () => {
        // Two tiles five pixels apart are not two lines, and stacking them would
        // be scrambling an arrangement rather than settling one
        const freeform = [
            { key: 'a', x: 0, y: 0, width: 200, given: 30, height: 30 },
            { key: 'b', x: 210, y: 5, width: 200, given: 30, height: 20 },
        ];
        expect(settleLines(freeform)).toBe(freeform);
    });

    test('nor does a tall tile beside a column of short ones move', () => {
        const straddling = [
            { key: 'tall', x: 0, y: 0, width: 200, given: 100, height: 60 },
            { key: 'topRight', x: 200, y: 0, width: 200, given: 50, height: 50 },
            { key: 'lowRight', x: 200, y: 50, width: 200, given: 50, height: 50 },
        ];
        expect(settleLines(straddling)).toBe(straddling);
    });

    test('a layout that does not start at the top is left alone', () => {
        const pushedDown = [...line('a', 40, 30), ...line('b', 70, 30)];
        expect(settleLines(pushedDown)).toBe(pushedDown);
    });

    test('the tiles come back in the order they went in', () => {
        const given = [...line('a', 0, 30), ...line('b', 30, 80, 30)];
        expect(settleLines(given).map((tile) => tile.key)).toEqual(given.map((tile) => tile.key));
    });

    test('one tile, or none, is nothing to settle', () => {
        const one = [{ key: 'a', x: 0, y: 20, width: 200, given: 30, height: 30 }];
        expect(settleLines(one)).toBe(one);
        expect(settleLines([])).toEqual([]);
    });

    test('a tile with no allotted height settles on what it drew', () => {
        const settled = settleLines([
            { key: 'a', x: 0, y: 0, width: 200, height: 30 },
            { key: 'b', x: 0, y: 30, width: 200, height: 30 },
        ]);
        expect(settled.find((tile) => tile.key === 'b').y).toBe(30);
    });
});

describe('squeezeToWidth', () => {
    /**
     * A two-column grid, as the packer builds them.
     * @param {number} column - Column width
     * @returns {Array<Object>} Four tiles
     */
    const grid = (column) => [
        { key: 'a', x: 0, y: 0, width: column, height: 30 },
        { key: 'b', x: column, y: 0, width: column, height: 30 },
        { key: 'c', x: 0, y: 30, width: column, height: 30 },
        { key: 'd', x: column, y: 30, width: column, height: 30 },
    ];

    test('a layout that already fits is handed straight back', () => {
        const fits = grid(220);
        expect(squeezeToWidth(fits, 460)).toBe(fits);
    });

    test('one that misses by a little is scaled to fit, keeping its columns', () => {
        // The live case: a layout saved when the canvas was 480 across, drawn
        // after the room kept for a scrollbar grew and left 473
        const squeezed = squeezeToWidth(grid(240), 473);
        const at = Object.fromEntries(squeezed.map((tile) => [tile.key, tile]));

        expect(at.a.x).toBe(0);
        expect(at.a.x + at.a.width).toBe(at.b.x);
        expect(at.b.x + at.b.width).toBe(473);
        // Still a grid: the two columns line up down the panel
        expect(at.c.x).toBe(at.a.x);
        expect(at.d.x).toBe(at.b.x);
        expect(at.c.width).toBe(at.a.width);
    });

    test('flush tiles stay flush, whatever the rounding does', () => {
        for (const width of [473, 461, 455, 442, 437]) {
            const at = Object.fromEntries(squeezeToWidth(grid(240), width).map((tile) => [tile.key, tile]));
            expect(at.a.x + at.a.width).toBe(at.b.x);
            expect(at.b.x + at.b.width).toBe(width);
        }
    });

    test('heights and positions down the page are left alone', () => {
        const squeezed = squeezeToWidth(grid(240), 473);
        for (const tile of squeezed) expect(tile.height).toBe(30);
        expect(squeezed.map((tile) => tile.y)).toEqual([0, 0, 30, 30]);
    });

    test('one built for a different screen is declined, so it can be flowed', () => {
        // A desktop arrangement on a phone is not a few pixels out, and shrinking
        // it would give the phone the desktop's layout in miniature
        const desktop = grid(240);
        expect(squeezeToWidth(desktop, 360)).toBe(desktop);
    });

    test('nothing is ever squeezed below what can be grabbed', () => {
        const tiny = [{ key: 'a', x: 0, y: 0, width: 45, height: 30 }];
        expect(squeezeToWidth(tiny, 20)[0].width).toBeGreaterThanOrEqual(MIN_TILE.width);
    });

    test('nothing at all is nothing to squeeze', () => {
        expect(squeezeToWidth([], 400)).toEqual([]);
        expect(squeezeToWidth(grid(220), 0)).toEqual(grid(220));
    });
});

describe('contentBounds', () => {
    test('measures to the far edge of the furthest tile', () => {
        const tiles = [
            { x: 0, y: 0, width: 100, height: 30 },
            { x: 200, y: 90, width: 50, height: 40 },
        ];
        expect(contentBounds(tiles)).toEqual({ width: 250, height: 130 });
    });

    test('nothing placed measures as nothing', () => {
        expect(contentBounds([])).toEqual({ width: 0, height: 0 });
    });
});

describe('compactColumns', () => {
    test('leaves a layout that is already snug alone', () => {
        const tiles = [
            { key: 'a', x: 0, y: 0, width: 100, height: 30 },
            { key: 'b', x: 100, y: 0, width: 100, height: 30 },
        ];
        expect(compactColumns(tiles, 400)).toEqual([
            { key: 'a', x: 0, y: 0 },
            { key: 'b', x: 100, y: 0 },
        ]);
    });

    test('a tile that grew past its neighbour pushes the neighbour down', () => {
        // Rows arrive from OPanel sized for OPanel's rendering; ours are taller
        const tiles = [
            { key: 'top', x: 0, y: 0, width: 200, height: 30 },
            { key: 'below', x: 0, y: 20, width: 200, height: 30 },
        ];
        const resolved = compactColumns(tiles, 400);
        expect(resolved.find((tile) => tile.key === 'top')).toEqual({ key: 'top', x: 0, y: 0 });
        expect(resolved.find((tile) => tile.key === 'below').y).toBe(30);
    });

    test('closes the gaps resizing left behind', () => {
        // Pushing collisions down without also pulling the rest up turns an
        // imported layout into a scatter with holes in it
        const tiles = [
            { key: 'a', x: 0, y: 0, width: 200, height: 30 },
            { key: 'b', x: 0, y: 400, width: 200, height: 30 },
        ];
        expect(compactColumns(tiles, 400)[1]).toEqual({ key: 'b', x: 0, y: 30 });
    });

    test('a tile never changes column', () => {
        // Sliding into the other column is not a nudge, it is a scramble
        const tiles = [
            { key: 'left', x: 0, y: 0, width: 100, height: 30 },
            { key: 'right', x: 200, y: 0, width: 100, height: 30 },
        ];
        expect(compactColumns(tiles, 400).find((tile) => tile.key === 'right').x).toBe(200);
    });

    test('columns settle independently', () => {
        const tiles = [
            { key: 'l1', x: 0, y: 0, width: 100, height: 60 },
            { key: 'l2', x: 0, y: 200, width: 100, height: 30 },
            { key: 'r1', x: 200, y: 300, width: 100, height: 30 },
        ];
        const resolved = compactColumns(tiles, 400);
        expect(resolved.find((tile) => tile.key === 'l2').y).toBe(60);
        // The right column owes nothing to the left one's height
        expect(resolved.find((tile) => tile.key === 'r1').y).toBe(0);
    });

    test('keeps everything on the canvas', () => {
        const tiles = [{ key: 'a', x: 900, y: 0, width: 200, height: 30 }];
        expect(compactColumns(tiles, 400)[0].x).toBe(200);
    });

    test('resolves a pile of identical tiles into a stack', () => {
        const tiles = Array.from({ length: 4 }, (_, index) => ({
            key: `t${index}`,
            x: 0,
            y: 0,
            width: 100,
            height: 30,
        }));
        expect(compactColumns(tiles, 100).map((tile) => tile.y)).toEqual([0, 30, 60, 90]);
    });

    test('survives nothing to settle', () => {
        expect(compactColumns([], 400)).toEqual([]);
    });
});
