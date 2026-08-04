/**
 * Overlay Layout
 *
 * Where each overlay row sits, how big it is, and how large it draws.
 *
 * The overlay started as a vertical stack, which is the wrong shape for what it
 * holds. A stack forces one ordering decision — what comes above what — when the
 * real question is what sits beside what: revenue next to profit, luck next to
 * expectation. OPanel solves this by making the body a canvas of freely placed
 * tiles, and this module is the arithmetic behind that.
 *
 * Kept pure and apart from the panel because layout is where the awkward cases
 * live — a row added by an update that no saved layout has heard of, a tile left
 * off the edge by a since-resized panel, a repack that has to fit tiles of
 * different heights. None of that is testable through the DOM in this project,
 * and all of it is testable here.
 *
 * The model is OPanel's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/** Everything snaps to this when snapping is on; OPanel's saved layouts are all multiples of it */
export const GRID = 10;

/** What a row gets before anyone has moved or resized it */
export const DEFAULT_TILE = { width: 160, height: 30 };

/** Percent of the panel's base font size; a tile can be made to read larger or smaller */
export const DEFAULT_ZOOM = 100;
export const MIN_ZOOM = 50;
export const MAX_ZOOM = 200;

/** Below this a tile has no room for content, and becomes impossible to grab */
export const MIN_TILE = { width: 40, height: 20 };

/**
 * How tall a tile is while it is standing down to a dim name.
 *
 * Height only. A compact tile keeps the width it was given, because tiles are
 * arranged in columns and a placeholder that also narrows breaks the column it
 * is sitting in — the layout you arranged comes back different every time a
 * feature goes quiet, which is worse than the space it saves.
 */
export const COMPACT_TILE = { height: 20 };

/**
 * Round to the nearest grid step.
 * @param {number} value - Pixels
 * @param {number} [grid] - Step, or 1 to leave the value alone
 * @returns {number} Snapped pixels
 */
export function snap(value, grid = GRID) {
    if (!(grid > 1)) return Math.round(value);
    return Math.round(value / grid) * grid;
}

/**
 * Do two tiles cover any of the same ground?
 * @param {{x: number, y: number, width: number, height: number}} a - One tile
 * @param {{x: number, y: number, width: number, height: number}} b - The other
 * @returns {boolean} True when they overlap
 */
export function overlaps(a, b) {
    return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/**
 * Find somewhere to put a tile that nothing else is already using.
 *
 * Scans left to right then top to bottom, which puts a new row where the eye
 * looks for it rather than in whatever gap happens to be largest. Falls back to
 * below everything when the canvas is genuinely full — a tile off the bottom can
 * be scrolled to, where a tile hidden under another cannot be found at all.
 *
 * @param {Array<Object>} placed - Tiles already positioned
 * @param {{width: number, height: number}} size - The tile to place
 * @param {number} width - Canvas width to wrap at
 * @param {number} [grid] - Step to search on
 * @returns {{x: number, y: number}} Somewhere free
 */
export function findFreeSpot(placed, size, width, grid = GRID) {
    const step = grid > 1 ? grid : GRID;
    const bottom = placed.reduce((max, tile) => Math.max(max, tile.y + tile.height), 0);

    for (let y = 0; y <= bottom; y += step) {
        for (let x = 0; x + size.width <= Math.max(width, size.width); x += step) {
            const candidate = { x, y, width: size.width, height: size.height };
            if (!placed.some((tile) => overlaps(candidate, tile))) return { x, y };
        }
    }
    return { x: 0, y: snap(bottom, step) };
}

/**
 * Keep a tile on the canvas.
 *
 * Only the left edge is held: the canvas scrolls downward, so a tile below the
 * fold is merely out of sight, while a tile past the right edge is unreachable
 * once the panel is narrowed. A tile wider than the canvas sits at zero rather
 * than at a negative offset.
 *
 * @param {{x: number, y: number}} position - Where it wants to be
 * @param {{width: number, height: number}} size - How big it is
 * @param {{width: number}} bounds - The canvas
 * @returns {{x: number, y: number}} Somewhere reachable
 */
export function clampTile(position, size, bounds) {
    const maxX = Math.max(0, bounds.width - size.width);
    return {
        x: Math.min(Math.max(0, position.x), maxX),
        y: Math.max(0, position.y),
    };
}

/**
 * Put the rows to be drawn together with the layout saved for them.
 *
 * A row that no saved layout knows about is placed rather than left at the
 * origin on top of an existing tile, because a fresh row hidden under an old one
 * reads as a row that failed to render.
 *
 * @param {Array<Object>} rows - Resolved, visible rows
 * @param {Object} layout - `{ positions, sizes, zoom }` keyed by row key
 * @param {number} width - Canvas width, for placing anything new
 * @param {Function} [sizeFor] - `(row, size) => size`, a last word on how big a
 *   tile is drawn this time round. For a tile standing down to a dim name: the
 *   size it was *given* is still the size it has, so shrinking it in the saved
 *   layout would lose the arrangement the moment a feature went quiet.
 * @returns {Array<Object>} Each row with `x`, `y`, `width`, `height`, `zoom`
 */
export function resolveLayout(rows, layout, width, sizeFor = null) {
    const positions = layout?.positions || {};
    const sizes = layout?.sizes || {};
    const zooms = layout?.zoom || {};

    const tiles = [];
    for (const row of rows) {
        const given = sizes[row.key] || row.defaultSize || DEFAULT_TILE;
        const size = sizeFor ? sizeFor(row, given) : given;
        const saved = positions[row.key];
        const spot = saved ? clampTile(saved, size, { width }) : findFreeSpot(tiles, size, width);

        tiles.push({
            ...row,
            x: spot.x,
            y: spot.y,
            width: size.width,
            height: size.height,
            zoom: clampZoom(zooms[row.key] ?? row.defaultZoom ?? DEFAULT_ZOOM),
        });
    }
    return tiles;
}

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
 * Settle every tile upwards in its own column, closing gaps and collisions alike.
 *
 * For an imported layout rather than for one built here. A layout built here
 * cannot overlap — every drag is clamped as it happens — but a layout that came
 * from OPanel was measured against OPanel's rendering, and the same rows drawn
 * by this overlay are not the same size. Import it verbatim and tiles land on
 * top of one another; grow them to fit and push the collisions down, and the
 * layout stretches into a scatter with holes in it.
 *
 * So: gravity. Each tile falls to the highest position in its column that
 * nothing already occupies. Overlaps resolve because two tiles cannot settle in
 * the same place, and the gaps left by resizing close because a tile does not
 * stop at the gap it used to sit below.
 *
 * The column is held rather than searched. An OPanel layout is two columns, and
 * a tile that resolves a collision by sliding into the other one has not been
 * nudged, it has been scrambled — so a tile only ever moves vertically.
 *
 * @param {Array<Object>} tiles - Tiles with `key`, `x`, `y`, `width`, `height`
 * @param {number} width - Canvas width
 * @param {number} [grid] - Step to settle onto
 * @returns {Array<{key: string, x: number, y: number}>} Settled positions
 */
export function compactColumns(tiles, width, grid = GRID) {
    const step = grid > 1 ? grid : GRID;
    const placed = [];
    const positions = [];

    // Top to bottom, then left to right: a tile above another before should
    // still be above it after, since it gets to claim its place first
    const ordered = [...tiles].sort((a, b) => a.y - b.y || a.x - b.x);

    for (const tile of ordered) {
        const size = { width: tile.width, height: tile.height };
        const { x } = clampTile({ x: tile.x, y: tile.y }, size, { width });

        let y = 0;
        for (;;) {
            const candidate = { x, y, ...size };
            if (!placed.some((other) => overlaps(candidate, other))) break;
            y += step;
        }

        placed.push({ x, y, ...size });
        positions.push({ key: tile.key, x, y });
    }
    return positions;
}

/**
 * Repack every tile against the top-left, in order, wrapping at the canvas edge.
 *
 * Rows within a wrapped line share the height of the tallest, so a short tile
 * next to a tall one does not leave the next line interleaved with this one.
 * Sizes are left alone — this answers "where has everything gone", not "make
 * them all the same".
 *
 * @param {Array<Object>} tiles - Tiles in the order they should be laid out
 * @param {number} width - Canvas width
 * @param {number} [grid] - Step to align to
 * @returns {Array<{key: string, x: number, y: number}>} New positions
 */
export function autoGrid(tiles, width, grid = GRID) {
    const step = grid > 1 ? grid : 1;
    const positions = [];

    let x = 0;
    let y = 0;
    let lineHeight = 0;

    for (const tile of tiles) {
        // Wrapping on the first tile of a line would leave an empty line above it
        if (x > 0 && x + tile.width > width) {
            x = 0;
            y = snap(y + lineHeight, step);
            lineHeight = 0;
        }
        positions.push({ key: tile.key, x, y });
        x = snap(x + tile.width, step);
        lineHeight = Math.max(lineHeight, tile.height);
    }
    return positions;
}

/**
 * How much room the tiles actually need.
 *
 * The canvas is sized from this rather than from the panel, so dragging a tile
 * to the bottom extends the scroll instead of putting it out of reach.
 *
 * @param {Array<Object>} tiles - Placed tiles
 * @returns {{width: number, height: number}} Extent
 */
export function contentBounds(tiles) {
    let width = 0;
    let height = 0;
    for (const tile of tiles) {
        width = Math.max(width, tile.x + tile.width);
        height = Math.max(height, tile.y + tile.height);
    }
    return { width, height };
}
