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
 * Round up to the next grid step.
 *
 * For advancing past something rather than placing something: rounding the far
 * edge of a tile *down* to the grid puts the next tile back inside it, which is
 * an overlap of up to a step for every tile whose size is not a multiple of one.
 *
 * @param {number} value - Pixels
 * @param {number} [grid] - Step, or 1 to leave the value alone
 * @returns {number} Snapped pixels, never less than `value`
 */
export function snapUp(value, grid = GRID) {
    if (!(grid > 1)) return Math.ceil(value);
    return Math.ceil(value / grid) * grid;
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
 * Only ever at a **corner of what is already there**: the candidate left edges
 * are the left and right edges of the placed tiles, and the candidate tops are
 * their tops and bottoms. That is the whole difference between this and the
 * ten-pixel scan it replaces, and it is the difference between a layout and a
 * patchwork. A scan finds the first hole big enough anywhere on a ten-pixel
 * lattice, so a 130-wide tile drops into the 130-pixel sliver beside a 250-wide
 * one and every column below it is offset by a number nobody chose. Restricted
 * to corners, a new tile can only start where a column already starts or where a
 * row already ends, so the arrangement it joins keeps its lines.
 *
 * Among the corners that fit, the topmost then leftmost wins — a new row lands
 * where the eye looks for it rather than in whatever gap happens to be largest.
 * Falls back to below everything when nothing fits, because a tile off the
 * bottom can be scrolled to where a tile hidden under another cannot be found at
 * all.
 *
 * @param {Array<Object>} placed - Tiles already positioned
 * @param {{width: number, height: number}} size - The tile to place
 * @param {number} width - Canvas width to wrap at
 * @param {number} [grid] - Step to align the fallback to
 * @returns {{x: number, y: number}} Somewhere free
 */
export function findFreeSpot(placed, size, width, grid = GRID) {
    const step = grid > 1 ? grid : GRID;
    const bottom = placed.reduce((max, tile) => Math.max(max, tile.y + tile.height), 0);
    const limit = Math.max(width, size.width);

    const lefts = new Set([0]);
    const tops = new Set([0]);
    for (const tile of placed) {
        lefts.add(tile.x);
        lefts.add(tile.x + tile.width);
        tops.add(tile.y);
        tops.add(tile.y + tile.height);
    }

    const columns = [...lefts].filter((x) => x >= 0 && x + size.width <= limit).sort((a, b) => a - b);
    const rows = [...tops].filter((y) => y >= 0).sort((a, b) => a - b);

    // Rows outside, columns inside: reading order, so the first fit is the
    // highest one and among equals the leftmost
    for (const y of rows) {
        for (const x of columns) {
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
 * How wide one column of a packed canvas is.
 *
 * Snapped *down* to the grid so the columns land on it and the last one still
 * ends inside the canvas; the few pixels that leaves at the right edge are the
 * price of every column starting on a round number.
 *
 * @param {number} width - Canvas width
 * @param {number} columns - How many
 * @param {number} [grid] - Step to align to
 * @returns {number} Column width in pixels
 */
export function columnWidth(width, columns, grid = GRID) {
    const step = grid > 1 ? grid : 1;
    const raw = Math.floor(width / Math.max(1, columns));
    return Math.max(MIN_TILE.width, Math.floor(raw / step) * step);
}

/**
 * How many columns a set of tiles wants on a canvas this wide.
 *
 * From the tiles rather than from a constant, because the right column width is
 * the one most tiles already are. The median is used rather than the widest:
 * the widest tile in an overlay is a three-line consumables block at 280, and
 * sizing every column to it gives a 480-pixel panel one column and a wall of
 * half-empty tiles. Sized to the median, the ordinary tile fits a column exactly
 * and the two or three large ones take two — which is a layout with a grid in it
 * rather than a layout with a grid drawn around its largest member.
 *
 * @param {Array<Object>} tiles - Tiles with `width`
 * @param {number} width - Canvas width
 * @returns {number} At least one
 */
export function gridColumns(tiles, width) {
    const widths = tiles.map((tile) => tile.width).filter((value) => value > 0);
    if (!widths.length) return 1;

    widths.sort((a, b) => a - b);
    const median = widths[Math.floor(widths.length / 2)];
    return Math.max(1, Math.floor(width / Math.max(MIN_TILE.width, median)));
}

/**
 * Repack every tile into columns of one width, in order.
 *
 * The old version was a shelf packer: it advanced by each tile's own width, so
 * the second column started wherever the first tile happened to end and nothing
 * below it lined up with anything above it. Tiles in the overlay are 130 to 280
 * wide, which made every line's column edges different from the last line's —
 * the jumble the button was supposed to fix.
 *
 * So this one is a column packer, and it resizes as well as places. Every tile
 * is widened to a whole number of columns ({@link gridColumns} decides how many
 * there are), which is the only way column edges can agree; every tile in a line
 * takes the height of the tallest in it, so lines have a flat top and a flat
 * bottom and no tile leaves a sliver beside it. Widening only ever grows a tile
 * — the span is rounded up from what it already needs — so nothing is packed
 * into a size that clips it.
 *
 * Reading order is kept, with one concession: when the next tile needs two
 * columns and only one is left, the packer takes the next tile that *does* fit
 * rather than closing the line early. Without it, every wide tile leaves a
 * half-empty row above itself, which is the orphan sliver in its other form.
 *
 * @param {Array<Object>} tiles - Tiles in the order they should be laid out
 * @param {number} width - Canvas width
 * @param {number} [grid] - Step to align to
 * @returns {Array<{key: string, x: number, y: number, width: number, height: number}>}
 *   Where each tile goes and how big it is drawn
 */
export function autoGrid(tiles, width, grid = GRID) {
    const step = grid > 1 ? grid : 1;
    const columns = gridColumns(tiles, width);
    const column = columnWidth(width, columns, step);

    const queue = tiles.map((tile) => ({
        tile,
        span: Math.min(columns, Math.max(1, Math.ceil(tile.width / column))),
    }));

    const placed = [];
    let y = 0;

    while (queue.length) {
        let free = columns;
        let x = 0;
        let tallest = 0;
        const line = [];

        while (free > 0) {
            let next = -1;
            for (let index = 0; index < queue.length; index += 1) {
                if (queue[index].span <= free) {
                    next = index;
                    break;
                }
            }
            if (next < 0) break;

            const [entry] = queue.splice(next, 1);
            line.push({ entry, x });
            x += entry.span * column;
            free -= entry.span;
            tallest = Math.max(tallest, entry.tile.height || DEFAULT_TILE.height);
        }
        // Nothing fits an empty line: the queue holds only tiles that cannot be
        // placed at all, and looping again would never end
        if (!line.length) break;

        // Up, not to the nearest: a 25-tall line snapping to 20 would put the
        // next line five pixels inside this one
        const height = Math.max(MIN_TILE.height, snapUp(tallest, step));
        for (const { entry, x: left } of line) {
            placed.push({ key: entry.tile.key, x: left, y, width: entry.span * column, height });
        }
        y += height;
    }
    return placed;
}

/**
 * The narrowest a designed column may become before the design is abandoned.
 *
 * A two-column arrangement squeezed onto a 300-pixel canvas is two columns of
 * 150, and a tile that narrow shows a label and an ellipsis. Below this the grid
 * is packed by {@link autoGrid} instead, which will simply use fewer columns.
 */
export const MIN_DESIGNED_COLUMN = 170;

/**
 * One line of a designed grid, normalized.
 *
 * A line is written either as a bare array of cells or as `{ cells, height }`
 * when it wants a height other than the tallest thing in it — a watchlist is 30
 * pixels of content and worth 70 of tile.
 *
 * @param {Array|Object} line - As written in the layout data
 * @returns {{cells: Array<string|null>, height: number}} Normalized
 */
function normalizeLine(line) {
    const cells = Array.isArray(line) ? line : Array.isArray(line?.cells) ? line.cells : [];
    return { cells, height: Number.isFinite(line?.height) ? line.height : 0 };
}

/**
 * Every key a designed grid names, in reading order.
 *
 * The order is what the row picker and Autogrid work from, so it is derived from
 * the grid rather than written twice — a preset whose written order disagreed
 * with its own arrangement would reorder itself the first time either button was
 * pressed.
 *
 * @param {Array} lines - The grid's lines
 * @returns {string[]} Keys, each once
 */
export function gridOrder(lines) {
    const seen = [];
    for (const line of lines || []) {
        for (const cell of normalizeLine(line).cells) {
            if (typeof cell === 'string' && !seen.includes(cell)) seen.push(cell);
        }
    }
    return seen;
}

/**
 * Turn a designed grid into the coordinates a layout is actually made of.
 *
 * The grid is written as lines of cells — a key per column, `null` for a gap,
 * and the same key twice in a row for a tile that spans two — which is a form
 * somebody can read and change in one sitting. This is what turns it into
 * pixels, and it is done against the canvas the player actually has rather than
 * baked into the data: coordinates written for one panel width arrive clamped or
 * overlapping on any other, which is exactly how a hand-placed layout goes wrong
 * when it travels.
 *
 * Cells naming a row that is not registered — a feature switched off, a row
 * dropped by an update — are removed, and a line left with nothing in it is
 * removed with it, so a missing feature costs no hole. Below
 * {@link MIN_DESIGNED_COLUMN} the design is abandoned rather than squeezed, and
 * the same rows are packed by {@link autoGrid} into however many columns there
 * is room for.
 *
 * @param {Object} spec - `{ columns, grid }` as written in the layout data
 * @param {Object} options - The canvas to build against
 * @param {number} options.width - Canvas width
 * @param {Object} [options.sizes] - `{ [key]: {width, height} }`, each row's natural size
 * @param {Set<string>|null} [options.available] - Keys that exist; null for all of them
 * @param {number} [options.step] - Grid step to align to
 * @returns {{positions: Object, sizes: Object}} Keyed by row key
 */
export function materializeGrid(spec, { width, sizes = {}, available = null, step = GRID } = {}) {
    const lines = (spec?.grid || []).map(normalizeLine);
    const wanted = Math.max(1, spec?.columns || 1);
    const has = (key) => typeof key === 'string' && (!available || available.has(key));

    const natural = (key) => sizes[key] || DEFAULT_TILE;
    const fit = Math.max(1, Math.floor(width / MIN_DESIGNED_COLUMN));

    // Too narrow for the arrangement as designed: pack it instead of squeezing
    // it, which at least keeps whole tiles and whole columns
    if (fit < wanted) {
        const order = gridOrder(spec?.grid).filter(has);
        const packed = autoGrid(
            order.map((key) => ({ key, ...natural(key) })),
            width,
            step
        );
        return toMaps(packed);
    }

    const column = columnWidth(width, wanted, step);
    const placed = [];
    let y = 0;

    for (const line of lines) {
        // Spans are written as the same key in adjacent cells, so the cells are
        // walked into runs before anything is measured
        const runs = [];
        let index = 0;
        while (index < line.cells.length && index < wanted) {
            const key = line.cells[index];
            let span = 1;
            while (index + span < Math.min(line.cells.length, wanted) && line.cells[index + span] === key) span += 1;
            if (has(key)) runs.push({ key, span, column: index });
            index += span;
        }
        if (!runs.length) continue;

        const tallest = runs.reduce((max, run) => Math.max(max, natural(run.key).height), 0);
        const height = Math.max(MIN_TILE.height, snapUp(line.height || tallest, step));
        for (const run of runs) {
            placed.push({
                key: run.key,
                x: run.column * column,
                y,
                width: run.span * column,
                height,
            });
        }
        y += height;
    }
    return toMaps(placed);
}

/**
 * Placed tiles as the two maps the settings hold them in.
 * @param {Array<Object>} placed - Tiles with `key`, `x`, `y`, `width`, `height`
 * @returns {{positions: Object, sizes: Object}}
 */
function toMaps(placed) {
    const positions = {};
    const sizes = {};
    for (const tile of placed) {
        positions[tile.key] = { x: tile.x, y: tile.y };
        sizes[tile.key] = { width: tile.width, height: tile.height };
    }
    return { positions, sizes };
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
