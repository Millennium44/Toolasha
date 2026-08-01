/**
 * Overlay row formatting
 *
 * How a tile reads, in one place.
 *
 * Tiles are small and fixed. Anything that wraps does not get taller — it gets
 * cut off, or pushes the rest of the tile out of sight — so **nothing in a row
 * may wrap**, and a value too long for its tile has to be shortened rather than
 * folded. Every row was doing that for itself, differently, which is how the
 * overlay ended up with "Drop luck" broken across two lines beside a figure that
 * had run off the edge.
 *
 * The other half is what a row says. A tile is read at a glance from three feet
 * away, so the unit belongs on the value — `260,572 exp/hr` rather than
 * `Experience` on the left and `260,572/hr` on the right. Half the label was
 * saying what the number's own unit already said, in the space the number needed.
 *
 * The style is OPanel's, from MWI Combat Suite by Frotty (MIT) — see
 * `third-party/mwi-combat-suite/` and `docs/THIRD-PARTY-LICENSES.md`. The code is
 * Toolasha's own.
 */

/** The palette every row draws from, so two rows never disagree about what green means */
export const ROW_COLORS = {
    good: '#4ade80',
    bad: '#f87171',
    neutral: '#e8ecf5',
    dim: 'rgba(232, 236, 245, 0.55)',
    accent: '#9ec4ff',
    gold: '#ffcf5c',
    violet: '#c9a0ff',
};

/**
 * A piece of a line.
 * @typedef {Object} Segment
 * @property {string} text - What it says
 * @property {string} [color] - From `ROW_COLORS`, or any CSS colour
 * @property {boolean} [bold] - Emphasis
 * @property {boolean} [ellipsis] - This is the piece that gives way when the tile is too narrow
 * @property {boolean} [push] - Push this and everything after it to the right
 */

/**
 * Draw one line of segments into an element.
 *
 * Exactly one piece should be marked `ellipsis` — a name, usually. Everything
 * else keeps its full width, because a truncated number is not a smaller number,
 * it is a wrong one.
 *
 * @param {HTMLElement} host - Where to draw
 * @param {Segment[]} segments - The line
 */
export function drawLine(host, segments) {
    Object.assign(host.style, {
        display: 'flex',
        alignItems: 'baseline',
        gap: '5px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
    });

    for (const segment of segments) {
        if (!segment) continue;

        const span = document.createElement('span');
        span.textContent = segment.text;
        if (segment.color) span.style.color = segment.color;
        if (segment.bold) span.style.fontWeight = 'bold';
        if (segment.push) span.style.marginLeft = 'auto';

        if (segment.ellipsis) {
            Object.assign(span.style, { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: '0' });
        } else {
            // Never allowed to shrink: a number squeezed to "1.2…" reads as a
            // number rather than as a truncation
            span.style.flex = '0 0 auto';
        }

        host.appendChild(span);
    }
}

/**
 * Draw a tile as one line.
 * @param {HTMLElement} container - The row's container
 * @param {Segment[]} segments - The line
 */
export function row(container, segments) {
    container.replaceChildren();
    container.style.flexDirection = '';
    drawLine(container, segments);
}

/**
 * Draw a tile as several lines.
 *
 * Each line is laid out independently, so a two-line tile does not need its
 * columns to agree — they are different facts, not a table.
 *
 * @param {HTMLElement} container - The row's container
 * @param {Segment[][]} lines - One array of segments per line
 */
export function rows(container, lines) {
    container.replaceChildren();
    Object.assign(container.style, {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        lineHeight: '1.3',
        overflow: 'hidden',
    });

    for (const segments of lines) {
        if (!segments?.length) continue;
        const line = document.createElement('div');
        drawLine(line, segments);
        container.appendChild(line);
    }
}

/** Draw nothing, for a row with nothing to say yet */
export function blank(container) {
    container.replaceChildren();
}

/**
 * A signed percentage, and what colour it should be.
 *
 * The band matters as much as the sign: everything sits a percent or two off
 * whatever it is being compared with, and colouring that makes a row into a
 * light that is always on.
 *
 * @param {number} percent - Signed percentage
 * @param {number} [band] - How far from zero counts as news
 * @returns {{text: string, color: string}}
 */
export function signedPercent(percent, band = 5) {
    const text = `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
    if (percent > band) return { text, color: ROW_COLORS.good };
    if (percent < -band) return { text, color: ROW_COLORS.bad };
    return { text, color: ROW_COLORS.dim };
}
