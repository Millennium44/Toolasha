/**
 * Overlay Flow
 *
 * What a tile is, now that it is not a rectangle.
 *
 * The overlay used to store where every tile sat and how big it was, in pixels,
 * and then spend a render reconciling those pixels against a panel that had
 * since been resized, a scrollbar that had since appeared, and a row that had
 * since decided to draw two lines instead of one. Six rounds of bug reports were
 * all the same shape: a coordinate is a *derived* quantity, and storing a
 * derived quantity as the source of truth means recomputing it forever against
 * conditions nobody knew when it was written.
 *
 * So the overlay stores what the player actually decided — *this tile before
 * that one, this tile twice as wide* — and the browser derives the pixels every
 * frame, at the width that exists right now, for free. This module is the whole
 * of the arithmetic that survives: how many columns fit, how wide a tile wants
 * to be in columns, and how to read an old pixel layout as an order and a set of
 * spans.
 *
 * Kept pure and apart from the panel for the reason the old layout module was:
 * the awkward cases are all here, and none of them needs a DOM to be wrong in.
 */

/**
 * The narrowest a column may be before the panel uses fewer of them.
 *
 * Between the old `MIN_DESIGNED_COLUMN` (170, too narrow to read a label and a
 * figure) and the old `MIN_FLOW_COLUMN` (240, wide enough that the default panel
 * managed only one). The number that matters is what the default 480-pixel panel
 * yields, because every preset is written for it: two columns.
 */
export const COLUMN_MIN = 220;

/** The gap between tiles, horizontally and vertically */
export const GAP = 4;

/**
 * The widest any tile may be, in columns.
 *
 * A ceiling rather than a preference. A stored span is only meaningful if it can
 * be trusted to mean something at any width, and an unbounded one read off a
 * corrupt record could ask for four hundred columns.
 */
export const MAX_SPAN = 5;

/**
 * Percent of the panel's base font size; a tile can be made to read larger or
 * smaller than its neighbours.
 *
 * The last thing left of the old layout module, and the only one that was never
 * about pixels: a per-tile text size is a preference, not a measurement.
 */
export const DEFAULT_ZOOM = 100;
export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;

/**
 * Hold a zoom level inside what stays legible.
 * @param {number} zoom - Percent
 * @returns {number} Percent within range
 */
export function clampZoom(zoom) {
    if (!Number.isFinite(zoom)) return DEFAULT_ZOOM;
    return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
}

/**
 * How many columns fit a canvas this wide.
 *
 * **The only measured quantity in the whole system.** It is an integer, so a
 * fifteen-pixel change in width cannot change it except exactly at a boundary —
 * which is what makes the scrollbar oscillation of earlier rounds not merely
 * fixed but unrepresentable. There is no longer any quantity that depends on
 * tile height and feeds back into tile width.
 *
 * @param {number} width - Canvas width in pixels
 * @returns {number} Between 1 and {@link MAX_SPAN}
 */
export function columnsFor(width) {
    if (!(width > 0)) return 1;
    const fits = Math.floor((width + GAP) / (COLUMN_MIN + GAP));
    return Math.min(MAX_SPAN, Math.max(1, fits));
}

/**
 * How many columns the grid should have for a layout.
 *
 * A span only means anything relative to the grid it was written in: two of four
 * is half the panel, two of two is all of it. So the layout carries its own
 * column count and this is what reconciles it with the panel there is.
 *
 * The wider of the two, because a layout authored for four columns drawn on a
 * two-column grid has every span clamped and every proportion in it flattened —
 * which is the whole of what went wrong importing a real hand-made layout. The
 * exception is a panel narrow enough to hold one column at all: a phone gets one
 * column whatever the layout wanted, which is what it always got.
 *
 * @param {number} width - Canvas width in pixels
 * @param {number} [authored] - The columns the layout was written for
 * @returns {number} Between 1 and {@link MAX_SPAN}
 */
export function columnsForLayout(width, authored = 2) {
    const affords = columnsFor(width);
    if (affords <= 1) return 1;

    const wanted = Number.isFinite(authored) ? Math.round(authored) : 2;
    return Math.min(MAX_SPAN, Math.max(1, affords, wanted));
}

/**
 * How many columns a tile takes, given what it asked for and what there is.
 *
 * Clamped to the columns available rather than stored per width, which is what
 * makes one saved arrangement correct on a desktop and on a phone with no second
 * code path: a span of 2 is simply a span of 1 when there is only one column.
 *
 * @param {number} span - The stored span, or anything unusable
 * @param {number} columns - Columns available
 * @returns {number} Between 1 and `columns`
 */
export function spanFor(span, columns) {
    const wanted = Number.isFinite(span) ? Math.round(span) : 1;
    return Math.min(Math.max(1, columns), Math.max(1, wanted));
}

/**
 * The span a row gets before anybody has chosen one.
 *
 * From `defaultSize.width`, which is the only pixel-shaped field a row provider
 * declares and which has always meant "about this much across". A row saying it
 * needs 200 is a row asking for one column of 220; one saying 460 is asking for
 * two. Today's widths run 130 to 280, so everything seeds to 1 — the presets,
 * not the row defaults, are what give a tile two columns.
 *
 * @param {Object} [row] - A row definition
 * @returns {number} Between 1 and {@link MAX_SPAN}
 */
export function seedSpan(row) {
    const width = row?.defaultSize?.width;
    if (!(width > 0)) return 1;
    return Math.min(MAX_SPAN, Math.max(1, Math.round(width / COLUMN_MIN)));
}

// ─── Reading an old layout ──────────────────────────────────────────────────

/**
 * The tiles of a v1 record, as rectangles.
 *
 * Only the keys that have both a position and a size: a key with one and not the
 * other says nothing about where it sat, and guessing would put a tile in the
 * order on the strength of half a record.
 *
 * @param {Object} v1 - A version-1 settings record
 * @returns {Array<{key: string, x: number, y: number, w: number, h: number}>} Rectangles
 */
function rectangles(v1) {
    const positions = v1?.positions || {};
    const sizes = v1?.sizes || {};
    const visible = v1?.visible || {};

    const tiles = [];
    for (const [key, spot] of Object.entries(positions)) {
        const size = sizes[key];
        if (!Number.isFinite(spot?.x) || !Number.isFinite(spot?.y)) continue;
        if (!(size?.width > 0) || !(size?.height > 0)) continue;
        // A row explicitly switched off is not part of the arrangement, and a
        // real export is full of them: the maintainer's own had six leftovers
        // parked on top of each other at the bottom of the panel, most of them
        // off. Swept in, they read as a line and scramble everything after it.
        // An *unmentioned* row is not the same thing — it falls back to its own
        // default, which is on for nearly every row in the script.
        if (visible[key] === false) continue;
        tiles.push({ key, x: spot.x, y: spot.y, w: size.width, h: size.height });
    }
    return tiles;
}

/**
 * Share `columns` out between tiles, in proportion to how wide they were.
 *
 * The replacement for deriving one global column unit from the tile edges, which
 * looked reasonable and fell over on the first real layout it met. That layout
 * had a build-score tile 110 wide beside a net-worth tile 180 wide, so the edge
 * set contained both 110 and 120 — a ten-pixel difference — and the smallest gap
 * between consecutive edges *is* the unit by that reckoning. Ten pixels. Which
 * made the layout forty-seven columns wide, clamped to four, and every tile in
 * it four columns wide: one tile per line, the whole arrangement gone. A single
 * unit only exists if the original was built on a grid, and a hand-arranged one
 * was not.
 *
 * Proportions within a line need no unit at all. Each tile gets its share of the
 * line's total width, rounded by largest remainder so the spans still sum to
 * exactly `columns`, and never less than one — a tile that rounds to nothing is
 * a tile that has been deleted.
 *
 * @param {number[]} widths - The tiles' widths, in order along the line
 * @param {number} columns - How many columns the line is to be shared into
 * @returns {number[]} A span per tile, summing to `columns`
 */
export function allocateSpans(widths, columns) {
    const total = widths.reduce((sum, width) => sum + Math.max(0, width), 0);
    const wanted = Math.max(1, Math.min(columns, MAX_SPAN));
    if (!widths.length) return [];
    if (!(total > 0)) return widths.map(() => Math.max(1, Math.floor(wanted / widths.length)));

    const raw = widths.map((width) => (Math.max(0, width) / total) * wanted);
    const spans = raw.map((value) => Math.max(1, Math.floor(value)));

    // Largest remainder, measured against what each tile actually got rather
    // than against its own floor: a tile held up to one column by the minimum
    // has already had more than its share and must not be first in the queue
    // for another
    let leftover = wanted - spans.reduce((sum, span) => sum + span, 0);
    while (leftover > 0) {
        let best = 0;
        for (let index = 1; index < spans.length; index += 1) {
            if (raw[index] - spans[index] > raw[best] - spans[best]) best = index;
        }
        spans[best] += 1;
        leftover -= 1;
    }
    // And the other way, when the minimum of one has overdrawn the line
    while (leftover < 0) {
        let best = -1;
        for (let index = 0; index < spans.length; index += 1) {
            if (spans[index] <= 1) continue;
            if (best < 0 || raw[index] - spans[index] < raw[best] - spans[best]) best = index;
        }
        if (best < 0) break;
        spans[best] -= 1;
        leftover += 1;
    }
    return spans;
}

/**
 * Group tiles into the lines they were drawn on.
 *
 * A sweep rather than a plain sort by `y` then `x`, because two columns of a
 * hand-nudged layout can differ by a pixel of `y` and a plain sort would then
 * interleave them — column, column, column instead of left, right, left, right.
 * A tile joins the line being built if it starts before that line's **opening**
 * tile ends.
 *
 * Against the opening tile rather than against the running extent of everything
 * on the line, which is the difference between grouping and swallowing: extend
 * the line by each tile that joins it and a column of thirty-pixel tiles each
 * overlapping the last by one pixel is a single line of the whole panel. Held to
 * the tile that opened it, a line is as tall as the thing that started it, which
 * is what a reader means by a line.
 *
 * This is the same "is this layout made of lines" judgement the old `settleLines`
 * had to make, and like it, it is pure and answers honestly for layouts that are
 * not: a scatter simply yields a lot of one-tile lines, in top-to-bottom order,
 * which is a perfectly good reading order for it.
 *
 * @param {Array<Object>} tiles - Rectangles
 * @returns {Array<Array<Object>>} Lines, each sorted left to right
 */
export function sweepLines(tiles) {
    const byTop = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

    const lines = [];
    let current = null;
    let bottom = 0;

    for (const tile of byTop) {
        if (!current || tile.y >= bottom) {
            current = [];
            lines.push(current);
            bottom = tile.y + tile.h;
        }
        current.push(tile);
    }

    for (const line of lines) line.sort((a, b) => a.x - b.x);
    return lines;
}

/**
 * Read a version-1 settings record as a version-2 one.
 *
 * One way, at load, and only for a record with no `version`. What comes across
 * is what the player decided: which tiles are on, what order they read in, how
 * wide each one is relative to the others, and every setting that was never
 * about geometry. What is lost is what the panel had been guessing at on their
 * behalf — exact pixels, exact heights, deliberate gaps, and `snapToGrid`, which
 * has nothing left to snap.
 *
 * Everything not named here is carried across by the caller merging this over
 * the record it loaded, which is the rule that keeps the four `*Only*` row
 * options alive: they live in this record but are read from another bundle, and
 * a rewrite that rebuilt the object from a narrow schema would switch four row
 * options off without ever mentioning them.
 *
 * @param {Object} v1 - A version-1 settings record
 * @returns {{version: number, order: string[], span: Object}} The layout, in v2 terms
 */
export function migrate(v1) {
    const tiles = rectangles(v1);
    if (!tiles.length) return { version: 2, columns: 2, order: [...(v1?.order || [])], span: {} };

    // A line with more tiles than there are columns cannot be drawn as one, so
    // it wraps — in order, deterministically, into runs of at most `MAX_SPAN`.
    // The layout's own column count is then the longest run there is: enough to
    // hold its densest line and no more, so a two-column layout stays two.
    const runs = [];
    for (const line of sweepLines(tiles)) {
        for (let at = 0; at < line.length; at += MAX_SPAN) runs.push(line.slice(at, at + MAX_SPAN));
    }
    // Enough columns to say what the layout said. Two things set the floor: the
    // densest line needs a column per tile, and the narrowest tile needs the
    // grid fine enough to distinguish it from a wider one — without the second,
    // a line of one 300-wide tile beside one 150-wide tile has only two columns
    // to share and comes out as an even pair.
    const width = tiles.reduce((widest, tile) => Math.max(widest, tile.x + tile.w), 0);
    const narrowest = tiles.reduce((thinnest, tile) => Math.min(thinnest, tile.w), Infinity);
    const fine = narrowest > 0 && Number.isFinite(narrowest) ? Math.round(width / narrowest) : 1;
    const columns = Math.min(MAX_SPAN, Math.max(1, fine, ...runs.map((run) => run.length)));

    const span = {};
    for (const run of runs) {
        const shares = allocateSpans(
            run.map((tile) => tile.w),
            columns
        );
        run.forEach((tile, index) => {
            span[tile.key] = shares[index];
        });
    }

    const order = runs.flatMap((run) => run.map((tile) => tile.key));

    // Keys the old record ordered but never placed — a row switched off, or one
    // that arrived after the last arrangement — keep their relative order at the
    // end rather than being dropped, which is what `resolveRows` would do for
    // them anyway and is less surprising if they are switched back on
    const placed = new Set(order);
    for (const key of v1?.order || []) {
        if (typeof key === 'string' && !placed.has(key)) {
            order.push(key);
            placed.add(key);
        }
    }

    return { version: 2, columns, order, span };
}
// ─── Arranging ──────────────────────────────────────────────────────────────

/**
 * Move a key to a slot in the order.
 *
 * The whole of what a drag does. A drop is a position in a list, so there is no
 * invalid one — which deletes the entire class of bug where a tile landed
 * somewhere no arrangement could express: off the canvas, on top of a neighbour,
 * in a gap that stopped existing when the panel was resized.
 *
 * `index` is where the key should end up *after* it has been taken out, which is
 * how a list insertion is usually meant and is what {@link dropIndex} returns.
 *
 * @param {string[]} order - The current order
 * @param {string} key - What is being moved
 * @param {number} index - Where it goes, clamped into the list
 * @returns {string[]} A new order, or the same array when nothing would change
 */
export function moveTo(order, key, index) {
    const from = order.indexOf(key);
    if (from < 0) return order;

    const rest = order.filter((entry) => entry !== key);
    const to = Math.min(Math.max(0, Math.round(index)), rest.length);
    if (to === from) return order;

    return [...rest.slice(0, to), key, ...rest.slice(to)];
}

/**
 * Which slot a pointer is asking for.
 *
 * Pure, given the boxes, which is the only reason a drag is testable at all: the
 * pointer arithmetic is separable from the pointer events. Boxes arrive in
 * document order and are whatever `getBoundingClientRect` gave.
 *
 * The nearest tile by the distance to its centre, and then a side: before it if
 * the pointer is above or left of that centre, after it otherwise. Reading order
 * is a single sequence, so "above" has to outrank "left of" — a pointer on the
 * line below is after everything on the line above it, however far left it sits.
 *
 * @param {Array<{key: string, left: number, top: number, right: number, bottom: number}>} boxes -
 *   The tiles, in document order
 * @param {{x: number, y: number}} point - Where the pointer is
 * @returns {number} An insertion index in `[0, boxes.length]`
 */
export function dropIndex(boxes, point) {
    if (!boxes?.length) return 0;

    let nearest = 0;
    let best = Infinity;
    for (let index = 0; index < boxes.length; index += 1) {
        const box = boxes[index];
        const cx = (box.left + box.right) / 2;
        const cy = (box.top + box.bottom) / 2;
        const distance = (point.x - cx) ** 2 + (point.y - cy) ** 2;
        if (distance < best) {
            best = distance;
            nearest = index;
        }
    }

    const box = boxes[nearest];
    const cy = (box.top + box.bottom) / 2;
    const cx = (box.left + box.right) / 2;
    // Vertically first: a pointer below a tile's middle is after it whatever its
    // horizontal position, because the tiles below it come later in the reading
    const after = point.y > cy || (point.y >= box.top && point.y <= box.bottom && point.x > cx);
    return after ? nearest + 1 : nearest;
}
