import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
    columnsFor,
    spanFor,
    seedSpan,
    allocateSpans,
    columnsForLayout,
    sweepLines,
    migrate,
    moveTo,
    dropIndex,
    clampZoom,
    DEFAULT_ZOOM,
    COLUMN_MIN,
    GAP,
    MAX_SPAN,
} from './overlay-flow.js';

describe('columnsFor', () => {
    test('the default panel gives exactly two columns', () => {
        // Every preset is written for this. If the default panel ever reads as
        // one column the whole preset set is wrong.
        expect(columnsFor(452)).toBe(2);
    });

    test('a wider panel gives more, a phone gives one', () => {
        expect(columnsFor(370)).toBe(1);
        expect(columnsFor(700)).toBe(3);
        expect(columnsFor(1200)).toBe(MAX_SPAN);
    });

    test('never fewer than one, whatever it is handed', () => {
        for (const width of [0, -50, NaN, undefined, 10]) expect(columnsFor(width)).toBe(1);
    });

    test('a scrollbar-sized change of width does not move it, away from a boundary', () => {
        // The whole of the oscillation from two rounds ago: fifteen pixels used
        // to be the difference between an arrangement and a different one. It is
        // now an integer that only moves at a boundary — and with a stable
        // scrollbar gutter the width does not move at all.
        for (const width of [500, 600, 700, 800]) {
            expect(columnsFor(width)).toBe(columnsFor(width - 15));
        }
    });

    test('the boundary is where the arithmetic says it is', () => {
        const twoFits = 2 * COLUMN_MIN + GAP;
        expect(columnsFor(twoFits)).toBe(2);
        expect(columnsFor(twoFits - 1)).toBe(1);
    });

    test('the default panel clears the two-column boundary, but not by much', () => {
        // Worth stating as a number rather than as a hope: the 480 panel's
        // canvas is about 452, and two columns need 444. Eight pixels of margin,
        // which a fatter scrollbar or a chunkier border could eat. This is the
        // first thing to measure live.
        const twoFits = 2 * COLUMN_MIN + GAP;
        expect(twoFits).toBe(444);
        expect(columnsFor(452)).toBe(2);
        expect(452 - twoFits).toBe(8);
    });
});

describe('spanFor', () => {
    test('a tile never asks for more columns than there are', () => {
        expect(spanFor(2, 1)).toBe(1);
        expect(spanFor(4, 2)).toBe(2);
        expect(spanFor(2, 3)).toBe(2);
    });

    test('nonsense reads as one column rather than as none', () => {
        for (const span of [undefined, null, NaN, 0, -3, 'wide']) expect(spanFor(span, 2)).toBe(1);
    });

    test('one saved layout is correct at every width', () => {
        // Which is the point of clamping rather than storing a span per width
        const saved = { luck: 2, coins: 1 };
        expect(spanFor(saved.luck, 1)).toBe(1);
        expect(spanFor(saved.luck, 2)).toBe(2);
        expect(spanFor(saved.luck, 4)).toBe(2);
    });
});

describe('seedSpan', () => {
    test("a row's declared width becomes the columns it asks for", () => {
        expect(seedSpan({ defaultSize: { width: 200, height: 30 } })).toBe(1);
        expect(seedSpan({ defaultSize: { width: 460, height: 30 } })).toBe(2);
    });

    test('every width a row actually declares today seeds to one column', () => {
        // 130 through 280 — the presets, not the row defaults, are what give a
        // tile two columns
        for (const width of [130, 160, 180, 200, 220, 230, 240, 250, 280]) {
            expect(seedSpan({ defaultSize: { width, height: 30 } })).toBe(1);
        }
    });

    test('a row that declares nothing gets one column', () => {
        expect(seedSpan({})).toBe(1);
        expect(seedSpan(null)).toBe(1);
        expect(seedSpan({ defaultSize: { height: 30 } })).toBe(1);
    });

    test('nothing may seed past the ceiling', () => {
        expect(seedSpan({ defaultSize: { width: 9000, height: 30 } })).toBe(MAX_SPAN);
    });
});

describe('allocateSpans', () => {
    test('shares a line out in proportion to the widths', () => {
        expect(allocateSpans([170, 120, 170], 4)).toEqual([2, 1, 1]);
        expect(allocateSpans([290, 170], 4)).toEqual([3, 1]);
        expect(allocateSpans([110, 180, 170], 4)).toEqual([1, 2, 1]);
    });

    test('always sums to the columns it was given', () => {
        for (const widths of [[120, 90, 80, 170], [290, 170, 170], [160, 50, 90, 170], [500], [10, 10]]) {
            for (const columns of [1, 2, 3, 4]) {
                const spans = allocateSpans(widths, columns);
                const total = spans.reduce((sum, span) => sum + span, 0);
                // Unless the minimum of one has overdrawn it, which it can only
                // do when there are more tiles than columns — `migrate` wraps a
                // line before it can ask for that
                expect(total).toBe(Math.max(columns, widths.length));
            }
        }
    });

    test('never gives a tile nothing, however narrow it was', () => {
        // A tile rounded down to no columns is a tile that has been deleted
        for (const spans of [allocateSpans([500, 5, 5, 5], 4), allocateSpans([1000, 1], 2)]) {
            for (const span of spans) expect(span).toBeGreaterThanOrEqual(1);
        }
    });

    test('the extra column goes to the tile most short-changed, not the narrowest', () => {
        // 110 rounds up to its minimum of one and has already had more than its
        // share; the extra belongs to the 180 beside it
        expect(allocateSpans([110, 180, 170], 4)).toEqual([1, 2, 1]);
    });

    test('a line of equal tiles is shared equally', () => {
        expect(allocateSpans([170, 170], 4)).toEqual([2, 2]);
        expect(allocateSpans([100, 100, 100, 100], 4)).toEqual([1, 1, 1, 1]);
    });

    test('nothing to share is no spans rather than a divide by zero', () => {
        expect(allocateSpans([], 4)).toEqual([]);
        expect(allocateSpans([0, 0], 2)).toEqual([1, 1]);
    });
});

describe('columnsForLayout', () => {
    test('a layout authored for more columns than the width affords keeps them', () => {
        // Which is the whole of importing a hand-made layout: clamped to what
        // the width affords, every proportion in it is flattened
        expect(columnsForLayout(458, 4)).toBe(4);
        expect(columnsForLayout(458, 2)).toBe(2);
    });

    test('a wider panel still gains columns for a layout that wants fewer', () => {
        expect(columnsForLayout(700, 2)).toBe(3);
    });

    test('a phone is one column whatever the layout wanted', () => {
        expect(columnsForLayout(370, 4)).toBe(1);
    });

    test('never past the ceiling, and never below one', () => {
        expect(columnsForLayout(2000, 9)).toBe(MAX_SPAN);
        expect(columnsForLayout(458, undefined)).toBe(2);
    });
});

describe('sweepLines', () => {
    test('reads a grid left to right, then top to bottom', () => {
        const tiles = [
            { key: 'b', x: 220, y: 0, w: 220, h: 30 },
            { key: 'c', x: 0, y: 30, w: 220, h: 30 },
            { key: 'a', x: 0, y: 0, w: 220, h: 30 },
            { key: 'd', x: 220, y: 30, w: 220, h: 30 },
        ];
        expect(sweepLines(tiles).map((line) => line.map((tile) => tile.key))).toEqual([
            ['a', 'b'],
            ['c', 'd'],
        ]);
    });

    test('a column nudged by a pixel still reads as one line', () => {
        // A plain sort by y then x would give column, column, column — the
        // reason this is a sweep and not a sort
        const tiles = [
            { key: 'a', x: 0, y: 0, w: 220, h: 30 },
            { key: 'b', x: 220, y: 1, w: 220, h: 30 },
            { key: 'c', x: 0, y: 30, w: 220, h: 30 },
            { key: 'd', x: 220, y: 31, w: 220, h: 30 },
        ];
        expect(sweepLines(tiles).map((line) => line.map((tile) => tile.key))).toEqual([
            ['a', 'b'],
            ['c', 'd'],
        ]);
    });

    test('a tall tile beside two short ones does not swallow the second', () => {
        const tiles = [
            { key: 'tall', x: 0, y: 0, w: 220, h: 100 },
            { key: 'top', x: 220, y: 0, w: 220, h: 50 },
            { key: 'below', x: 220, y: 50, w: 220, h: 50 },
        ];
        // The tall tile's own extent holds the line open, so all three read as
        // one line — which is what they look like
        expect(sweepLines(tiles).map((line) => line.map((tile) => tile.key))).toEqual([['tall', 'top', 'below']]);
    });

    test('a scatter becomes a lot of one-tile lines, top to bottom', () => {
        const tiles = [
            { key: 'c', x: 40, y: 200, w: 100, h: 20 },
            { key: 'a', x: 10, y: 0, w: 100, h: 20 },
            { key: 'b', x: 90, y: 100, w: 100, h: 20 },
        ];
        expect(sweepLines(tiles).map((line) => line.map((tile) => tile.key))).toEqual([['a'], ['b'], ['c']]);
    });

    test('nothing placed sweeps to nothing', () => {
        expect(sweepLines([])).toEqual([]);
    });
});

describe('migrate', () => {
    /**
     * The Combat preset as it was saved on a 440 canvas — the worked example the
     * design is written around.
     * @returns {Object} A version-1 settings record
     */
    function combatOn440() {
        return {
            order: ['combatStatus', 'battleTimer', 'dps', 'deathsPerHour', 'combatRevenue'],
            visible: { combatStatus: true, battleTimer: true, dps: true, deathsPerHour: true, combatRevenue: true },
            positions: {
                combatStatus: { x: 0, y: 0 },
                battleTimer: { x: 220, y: 0 },
                dps: { x: 0, y: 30 },
                deathsPerHour: { x: 220, y: 30 },
                combatRevenue: { x: 0, y: 80 },
            },
            sizes: {
                combatStatus: { width: 220, height: 30 },
                battleTimer: { width: 220, height: 30 },
                dps: { width: 220, height: 50 },
                deathsPerHour: { width: 220, height: 50 },
                combatRevenue: { width: 440, height: 40 },
            },
        };
    }

    test('reproduces the preset it was built from, exactly', () => {
        const v2 = migrate(combatOn440());

        expect(v2.version).toBe(2);
        expect(v2.order).toEqual(['combatStatus', 'battleTimer', 'dps', 'deathsPerHour', 'combatRevenue']);
        expect(v2.span).toEqual({
            combatStatus: 1,
            battleTimer: 1,
            dps: 1,
            deathsPerHour: 1,
            combatRevenue: 2,
        });
    });

    test('reads a layout built on a wider panel the same way', () => {
        // The spans are relative, so the panel it was built on does not matter
        const v1 = combatOn440();
        for (const key of Object.keys(v1.positions)) {
            v1.positions[key].x = (v1.positions[key].x / 220) * 240;
            v1.sizes[key].width = (v1.sizes[key].width / 220) * 240;
        }

        expect(migrate(v1).span.combatRevenue).toBe(2);
        expect(migrate(v1).span.combatStatus).toBe(1);
    });

    test('a span can never exceed the columns the layout had', () => {
        const v1 = {
            positions: { only: { x: 0, y: 0 } },
            sizes: { only: { width: 440, height: 30 } },
        };
        // One tile, one column: it is the whole layout, so it spans one
        expect(migrate(v1).span.only).toBe(1);
    });

    test('nor the ceiling, however many columns the old layout claimed', () => {
        const positions = {};
        const sizes = {};
        for (let index = 0; index < 8; index += 1) {
            positions[`t${index}`] = { x: index * 50, y: 0 };
            sizes[`t${index}`] = { width: 50, height: 30 };
        }
        positions.wide = { x: 0, y: 30 };
        sizes.wide = { width: 400, height: 30 };

        expect(migrate({ positions, sizes }).span.wide).toBeLessThanOrEqual(MAX_SPAN);
    });

    test('a record with nothing placed keeps the order it had', () => {
        const v2 = migrate({ order: ['coins', 'netWorth'], positions: {}, sizes: {} });
        expect(v2).toEqual({ version: 2, columns: 2, order: ['coins', 'netWorth'], span: {} });
    });

    test('and an empty record migrates to an empty layout rather than throwing', () => {
        expect(migrate({})).toEqual({ version: 2, columns: 2, order: [], span: {} });
        expect(migrate(null)).toEqual({ version: 2, columns: 2, order: [], span: {} });
    });

    test('a key with half a rectangle is not placed on the strength of it', () => {
        const v1 = {
            order: ['whole', 'half'],
            positions: { whole: { x: 0, y: 0 }, half: { x: 0, y: 30 } },
            sizes: { whole: { width: 220, height: 30 } },
        };
        const v2 = migrate(v1);

        expect(v2.span.half).toBeUndefined();
        // But it is still in the order, at the end, so switching it on later
        // does not surprise anybody
        expect(v2.order).toEqual(['whole', 'half']);
    });

    test('keys the old record ordered but never placed keep their order at the end', () => {
        const v1 = {
            order: ['offA', 'placed', 'offB'],
            positions: { placed: { x: 0, y: 0 } },
            sizes: { placed: { width: 220, height: 30 } },
        };
        expect(migrate(v1).order).toEqual(['placed', 'offA', 'offB']);
    });

    test('an overlapping layout still yields every key exactly once', () => {
        // Its spacing is not recoverable and the design says so; its order is
        const v1 = {
            positions: { a: { x: 0, y: 0 }, b: { x: 10, y: 5 }, c: { x: 5, y: 2 } },
            sizes: {
                a: { width: 200, height: 40 },
                b: { width: 200, height: 40 },
                c: { width: 200, height: 40 },
            },
        };
        const order = migrate(v1).order;

        expect([...order].sort()).toEqual(['a', 'b', 'c']);
        expect(new Set(order).size).toBe(3);
    });

    test('says nothing about anything that was never geometry', () => {
        // The caller merges this over the record it loaded, which is what keeps
        // the four *Only* row options alive
        const v2 = migrate(combatOn440());
        expect(Object.keys(v2).sort()).toEqual(['columns', 'order', 'span', 'version']);
    });
});

describe('moveTo', () => {
    const order = ['a', 'b', 'c', 'd'];

    test('moves a key forward and back', () => {
        expect(moveTo(order, 'a', 2)).toEqual(['b', 'c', 'a', 'd']);
        expect(moveTo(order, 'd', 0)).toEqual(['d', 'a', 'b', 'c']);
    });

    test('a drop that changes nothing hands the same array back', () => {
        expect(moveTo(order, 'b', 1)).toBe(order);
    });

    test('an index off either end lands at the end it is off', () => {
        expect(moveTo(order, 'b', -5)).toEqual(['b', 'a', 'c', 'd']);
        expect(moveTo(order, 'b', 99)).toEqual(['a', 'c', 'd', 'b']);
    });

    test('a key that is not in the order does not get added to it', () => {
        expect(moveTo(order, 'nope', 0)).toBe(order);
    });

    test('every key survives, exactly once', () => {
        for (const index of [0, 1, 2, 3, 4]) {
            const moved = moveTo(order, 'c', index);
            expect([...moved].sort()).toEqual([...order].sort());
            expect(new Set(moved).size).toBe(order.length);
        }
    });
});

describe('dropIndex', () => {
    // Two columns of two, as the grid draws them
    const boxes = [
        { key: 'a', left: 0, top: 0, right: 100, bottom: 40 },
        { key: 'b', left: 100, top: 0, right: 200, bottom: 40 },
        { key: 'c', left: 0, top: 40, right: 100, bottom: 80 },
        { key: 'd', left: 100, top: 40, right: 200, bottom: 80 },
    ];

    test('the left half of a tile means before it, the right half after', () => {
        expect(dropIndex(boxes, { x: 20, y: 20 })).toBe(0);
        expect(dropIndex(boxes, { x: 80, y: 20 })).toBe(1);
        expect(dropIndex(boxes, { x: 120, y: 20 })).toBe(1);
        expect(dropIndex(boxes, { x: 180, y: 20 })).toBe(2);
    });

    test('lower outranks further left, so a line below is not a line above', () => {
        // Reading order is one sequence. Without this, dragging to the start of
        // the second line would read as dragging to the start of the first,
        // because the pointer is further left than everything on it.
        expect(dropIndex(boxes, { x: 0, y: 60 })).toBe(2);
        // And below the line it is nearest to is after that line's first tile,
        // not before it
        expect(dropIndex(boxes, { x: 0, y: 100 })).toBe(3);
    });

    test('past the last tile is the end of the list', () => {
        expect(dropIndex(boxes, { x: 190, y: 79 })).toBe(4);
        expect(dropIndex(boxes, { x: 500, y: 500 })).toBe(4);
    });

    test('an empty canvas is the only slot there is', () => {
        expect(dropIndex([], { x: 10, y: 10 })).toBe(0);
        expect(dropIndex(null, { x: 10, y: 10 })).toBe(0);
    });

    test('never asks for a slot the list does not have', () => {
        for (const y of [-50, 0, 20, 60, 200]) {
            for (const x of [-50, 0, 50, 150, 400]) {
                const index = dropIndex(boxes, { x, y });
                expect(index).toBeGreaterThanOrEqual(0);
                expect(index).toBeLessThanOrEqual(boxes.length);
            }
        }
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

describe('a real layout, exported from the build before the rework', () => {
    // The maintainer's own, taken off a live character. One key is renamed: the
    // export names a companion script this repository is not allowed to mention,
    // and it appears only in `order` and `visible` — never placed — so nothing
    // about the arrangement changes.
    const file = JSON.parse(readFileSync('src/utils/__fixtures__/overlay-v1-export.json', 'utf8'));
    const v1 = file.toolasha.settings;

    /**
     * The migrated layout as lines, the way the grid will draw it.
     * @param {Object} v2 - A migrated layout
     * @returns {Array<Array<string>>} Keys per line, with their spans
     */
    function lines(v2) {
        const out = [];
        let line = [];
        let used = 0;
        for (const key of v2.order) {
            const span = v2.span[key];
            if (!span) continue;
            if (used + span > v2.columns) {
                out.push(line);
                line = [];
                used = 0;
            }
            line.push(`${key}:${span}`);
            used += span;
        }
        if (line.length) out.push(line);
        return out;
    }

    test('parses at all — the old export shape is still readable', () => {
        expect(file.toolasha.version).toBe(1);
        expect(v1.order.length).toBeGreaterThan(0);
        expect(Object.keys(v1.positions).length).toBeGreaterThan(0);
    });

    test('is read as four columns, which its densest line needs', () => {
        expect(migrate(v1).columns).toBe(4);
    });

    test('keeps every line as it was, with the relative widths on it', () => {
        // Checked against the original by hand: line one is four tiles of
        // roughly equal width, line two is a 170 beside a 120 and a 170, and
        // the two tall blocks are followed by their own right-hand columns
        expect(lines(migrate(v1))).toEqual([
            ['battleTimer:1', 'experiencePerHour:1', 'deathsPerHour:1', 'combatStatus:1'],
            ['combatRevenue:2', 'timeToLevel:1', 'houses:1'],
            ['totalProfit:3', 'consumables:1'],
            ['equipmentWatch:2', 'coins:1', 'marketListings:1'],
            ['dps:1', 'overExpected:1', 'luck:1', 'watchlist:1'],
            ['skillBooks:2', 'inventoryValue:2'],
            ['manaPerFight:3', 'treasure:1'],
            ['buildScore:1', 'netWorth:2', 'charmValue:1'],
            ['replayCheck:4'],
        ]);
    });

    test('does not let the pile of switched-off leftovers scramble the sweep', () => {
        // Six rows are parked on top of each other at the bottom of this panel,
        // most of them switched off. Swept in, they read as a line and every
        // line after them is wrong.
        const v2 = migrate(v1);
        for (const key of ['combatSession', 'combatText', 'combatLevel', 'predictionCalibration']) {
            expect(v2.span[key]).toBeUndefined();
            // Still in the order, at the end, so switching one back on is not a
            // surprise
            expect(v2.order).toContain(key);
        }
        // The one that is switched *on* is kept, even though it was in the pile
        expect(v2.span.replayCheck).toBe(4);
    });

    test('every visible tile is placed exactly once', () => {
        const v2 = migrate(v1);
        const placed = v2.order.filter((key) => v2.span[key]);

        expect(new Set(placed).size).toBe(placed.length);
        for (const key of placed) expect(v1.visible[key]).not.toBe(false);
    });

    test('no line asks for more columns than the grid has', () => {
        const v2 = migrate(v1);
        for (const line of lines(v2)) {
            const used = line.reduce((sum, entry) => sum + Number(entry.split(':')[1]), 0);
            expect(used).toBeLessThanOrEqual(v2.columns);
        }
    });
});
