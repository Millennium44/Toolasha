import { describe, test, expect } from 'vitest';
import {
    snap,
    overlaps,
    findFreeSpot,
    clampTile,
    clampZoom,
    resolveLayout,
    autoGrid,
    contentBounds,
    GRID,
    DEFAULT_TILE,
    DEFAULT_ZOOM,
} from './overlay-layout.js';

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
});

describe('autoGrid', () => {
    const tiles = [
        { key: 'a', width: 160, height: 30 },
        { key: 'b', width: 160, height: 30 },
        { key: 'c', width: 160, height: 30 },
    ];

    test('lays tiles left to right and wraps at the edge', () => {
        expect(autoGrid(tiles, 340)).toEqual([
            { key: 'a', x: 0, y: 0 },
            { key: 'b', x: 160, y: 0 },
            { key: 'c', x: 0, y: 30 },
        ]);
    });

    test('a wrapped line clears the tallest tile above it', () => {
        const mixed = [
            { key: 'tall', width: 160, height: 100 },
            { key: 'short', width: 160, height: 30 },
            { key: 'next', width: 160, height: 30 },
        ];
        // Using the last tile's height would interleave the second line with the
        // tall tile still occupying the first
        expect(autoGrid(mixed, 340)[2]).toEqual({ key: 'next', x: 0, y: 100 });
    });

    test('a tile wider than the canvas does not wrap onto an empty line', () => {
        const oversized = [{ key: 'huge', width: 900, height: 30 }];
        expect(autoGrid(oversized, 400)[0]).toEqual({ key: 'huge', x: 0, y: 0 });
    });

    test('positions land on the grid', () => {
        const odd = [
            { key: 'a', width: 73, height: 30 },
            { key: 'b', width: 73, height: 30 },
        ];
        expect(autoGrid(odd, 400)[1].x % GRID).toBe(0);
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
