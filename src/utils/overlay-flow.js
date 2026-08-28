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
export const MAX_SPAN = 4;

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

    const tiles = [];
    for (const [key, spot] of Object.entries(positions)) {
        const size = sizes[key];
        if (!Number.isFinite(spot?.x) || !Number.isFinite(spot?.y)) continue;
        if (!(size?.width > 0) || !(size?.height > 0)) continue;
        tiles.push({ key, x: spot.x, y: spot.y, w: size.width, h: size.height });
    }
    return tiles;
}

/**
 * The column width the old layout was built on.
 *
 * Derived rather than assumed, because a v1 layout could have been built against
 * any panel width — the packer used `floor(canvas / columns)` snapped to ten, so
 * the unit is 220 on one character and 240 on another.
 *
 * Every edge of every tile is a boundary that layout used, and the smallest gap
 * between two consecutive boundaries is one column. **Both** edges, left and
 * right: a layout whose only narrow tile sits in the left column above a
 * full-width one has no tile *starting* at the column boundary, so taking left
 * edges alone finds no interior boundary at all and reads the whole panel as one
 * column — which then flattens every span to 1. A layout genuinely one tile wide
 * has no interior boundary either way, and its own width is the unit.
 *
 * @param {Array<Object>} tiles - Rectangles
 * @returns {{unit: number, width: number}} The column unit and the layout's full width
 */
export function columnUnit(tiles) {
    const width = tiles.reduce((widest, tile) => Math.max(widest, tile.x + tile.w), 0);
    if (!(width > 0)) return { unit: 0, width: 0 };

    const edges = [...new Set(tiles.flatMap((tile) => [tile.x, tile.x + tile.w]))].sort((a, b) => a - b);

    let unit = width;
    for (let index = 1; index < edges.length; index += 1) {
        const step = edges[index] - edges[index - 1];
        if (step > 0) unit = Math.min(unit, step);
    }
    return { unit: unit > 0 ? unit : width, width };
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
    if (!tiles.length) return { version: 2, order: [...(v1?.order || [])], span: {} };

    const { unit, width } = columnUnit(tiles);
    const columns = Math.min(MAX_SPAN, Math.max(1, Math.round(width / unit)));

    const span = {};
    for (const tile of tiles) {
        const wanted = Math.max(1, Math.round(tile.w / unit));
        span[tile.key] = Math.min(columns, wanted);
    }

    const order = sweepLines(tiles).flatMap((line) => line.map((tile) => tile.key));

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

    return { version: 2, order, span };
}
