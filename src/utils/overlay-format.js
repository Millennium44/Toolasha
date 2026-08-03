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

/**
 * The game's own item sprite sheet, found once.
 *
 * Read off an existing icon rather than hardcoded: the URL carries a build hash
 * that changes with every game update, so a constant would be right until the
 * next Tuesday and silently wrong after it.
 */
let spriteSheet = null;

/**
 * The sprite sheet URL, or an empty string before the game has drawn anything.
 * @returns {string}
 */
export function itemSpriteUrl() {
    if (spriteSheet !== null) return spriteSheet;
    const use = document.querySelector('svg use[href*="items_sprite"]');
    spriteSheet = use?.getAttribute('href')?.split('#')[0] || '';
    // Not cached when it came back empty — the game may simply not have drawn an
    // icon yet, and one empty answer should not be the answer forever
    if (!spriteSheet) spriteSheet = null;
    return spriteSheet || '';
}

/**
 * An item's icon.
 * @param {string} itemHrid - Item to draw
 * @param {number} [size] - Pixels
 * @returns {SVGElement|HTMLElement} An icon, or a spacer while the sheet is unknown
 */
export function itemIcon(itemHrid, size = 18) {
    const sprite = itemSpriteUrl();
    if (!sprite) {
        const spacer = document.createElement('span');
        Object.assign(spacer.style, { width: `${size}px`, flex: '0 0 auto', display: 'inline-block' });
        return spacer;
    }

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.style.flex = '0 0 auto';

    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', `${sprite}#${String(itemHrid).split('/').pop()}`);
    svg.appendChild(use);
    return svg;
}

/**
 * Make an element open an item's marketplace listing when clicked.
 *
 * Applied to icons and names rather than to a separate button, because the icon
 * and the name are what you point at when you think "what does that cost" — and
 * a row about consumables is read while deciding whether to go and buy some.
 *
 * @param {HTMLElement} element - Icon or name
 * @param {string} itemHrid - Item to open
 * @param {Function} navigate - `(itemHrid) => void`, injected so this file stays DOM-only
 */
export function linkToMarketplace(element, itemHrid, navigate) {
    if (!element || !itemHrid) return;

    element.style.cursor = 'pointer';
    element.title = 'Open in the marketplace';
    element.addEventListener('click', (event) => {
        // Stopped, or the click reaches the tile behind and counts towards a
        // double-click that would toggle the panel shut under you
        event.stopPropagation();
        try {
            navigate(itemHrid);
        } catch (error) {
            console.error('[OverlayFormat] Opening the marketplace failed:', error);
        }
    });
}

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
 * The overlay's glyphs, in one place, following OPanel's vocabulary.
 *
 * A tile has room for a symbol or a word, not both, so the symbol has to carry
 * the label — which only works if it means the same thing everywhere. These were
 * chosen per file before, so a coin was 🪙 in one row and 💰 in another and the
 * overlay read as several tools stacked up rather than one.
 *
 * Matched to OPanel where OPanel has an opinion, because the two sit side by
 * side on the same screen and a reader should not have to learn two alphabets.
 * Where it does not — it draws some of these as game sprites rather than text —
 * the nearest emoji is used.
 */
export const GLYPHS = {
    /** Coins in hand */
    coin: '🪙',
    /** Market value, listings, anything priced */
    market: '📈',
    /** Bid orders waiting to fill */
    bid: '📦',
    /** The inventory as a whole */
    inventory: '🎒',
    /** Chests and other openables */
    chest: '🎁',
    /** Ability books */
    books: '📖',
    /** Mana */
    mana: '💧',
    /** Food and drink */
    consumable: '🍴',
    /** Damage dealt */
    dealt: '⚔',
    /** Damage taken */
    taken: '🛡',
    /** Watched items */
    watch: '👁',
    /** Locked and unlocked, as the overlay's own header uses them */
    locked: '🔒',
    unlocked: '🔓',
    /** Settings */
    settings: '⚙',
    /** Close */
    close: '✖',
    /** Something is wrong with the figure rather than with the run */
    warning: '⚠',
};

/**
 * A piece of a line.
 * @typedef {Object} Segment
 * @property {string} [text] - What it says
 * @property {string} [icon] - An item hrid to draw instead of text
 * @property {number} [size] - Icon size in pixels
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
    // Text on a line together is aligned on its baseline, which is what makes a
    // row of figures read as a row. An icon has no baseline: it is a box, and
    // against baselined text it sits low and drags the line's height with it.
    // So a line carrying one is centred instead — the box and the numbers are
    // then aligned on the only thing they share, their middles.
    const hasIcon = segments.some((segment) => segment?.icon);

    Object.assign(host.style, {
        display: 'flex',
        alignItems: hasIcon ? 'center' : 'baseline',
        gap: '5px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
    });

    for (const segment of segments) {
        if (!segment) continue;

        // An item's own icon says which item without spending the width a name
        // costs, which is the only reason a forty-pixel tile can name one at all
        if (segment.icon) {
            const icon = itemIcon(segment.icon, segment.size || 16);
            if (segment.push) icon.style.marginLeft = 'auto';
            host.appendChild(icon);
            continue;
        }

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
 *
 * @param {HTMLElement} container - The row's container
 * @param {Segment[]} segments - The line
 * @param {Object} [options] - Layout
 * @param {boolean} [options.center] - Centre the line rather than filling the
 *   tile. Right for a tile whose pieces belong together — an icon, a count and
 *   a price read as one phrase, and pushing the price to the far edge of a
 *   resized tile puts a gap in the middle of it.
 */
export function row(container, segments, { center = false } = {}) {
    container.replaceChildren();
    container.style.flexDirection = '';
    drawLine(container, segments);
    container.style.justifyContent = center ? 'center' : '';
}

/**
 * Draw a tile as several lines.
 *
 * By default each line is laid out independently, which is right when the lines
 * are different facts — an income line above a cost line has no columns to
 * agree about.
 *
 * `align` is for when they *are* a table: a row per player and then a total is
 * the same measurement three times, and a figure that sits a few pixels off the
 * one above it makes a reader check whether it is the same kind of number. The
 * lines share columns then, the first stretching and the rest sized to their
 * contents against the right edge.
 *
 * @param {HTMLElement} container - The row's container
 * @param {Segment[][]} lines - One array of segments per line
 * @param {Object} [options] - Layout
 * @param {boolean} [options.align] - Share columns between the lines
 */
export function rows(container, lines, { align = false } = {}) {
    container.replaceChildren();

    const drawn = lines.filter((segments) => segments?.length);
    // An icon has no width until it loads, so it cannot size a column; those
    // tiles keep the independent layout, where nothing depends on its width
    const alignable = align && !drawn.some((segments) => segments.some((segment) => segment?.icon));

    if (alignable) return alignedRows(container, drawn);

    Object.assign(container.style, {
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        lineHeight: '1.3',
        overflow: 'hidden',
    });

    for (const segments of drawn) {
        const line = document.createElement('div');
        drawLine(line, segments);
        container.appendChild(line);
    }
}

/**
 * The lines as a grid, so every column lines up.
 *
 * The first column takes the slack and the rest are as wide as their widest
 * cell, which puts the figures in a column against the right edge whether or
 * not every line has the same number of them. `push` is ignored here — the
 * stretching first column already does what it was for.
 *
 * @param {HTMLElement} container - The row's container
 * @param {Segment[][]} lines - One array of segments per line
 */
function alignedRows(container, lines) {
    const columns = Math.max(...lines.map((segments) => segments.length), 1);

    Object.assign(container.style, {
        display: 'grid',
        gridTemplateColumns: `minmax(0, 1fr)${' auto'.repeat(Math.max(columns - 1, 0))}`,
        // From the top, not centred. These tiles sit in a row beside each other
        // and carry different numbers of lines — DPS has a player and a total,
        // Luck has one line — and centring puts the single line of one tile
        // halfway down the two lines of the next. Aligned to the top, the first
        // line of every one of them is at the same height.
        alignContent: 'start',
        columnGap: '5px',
        lineHeight: '1.3',
        overflow: 'hidden',
        // Digits of one width, so a column of figures is a column rather than a
        // ragged edge that shifts as the numbers change
        fontVariantNumeric: 'tabular-nums',
    });

    for (const segments of lines) {
        for (let index = 0; index < columns; index += 1) {
            const segment = segments[index];
            const span = document.createElement('span');

            if (segment) {
                span.textContent = segment.text;
                if (segment.color) span.style.color = segment.color;
                if (segment.bold) span.style.fontWeight = 'bold';
            }

            Object.assign(span.style, {
                // The first column holds a name and is the one that may be cut;
                // a figure squeezed to "1.2…" reads as a number rather than as
                // a truncation
                textAlign: index === 0 ? 'left' : 'right',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: index === 0 ? 'ellipsis' : 'clip',
                minWidth: '0',
            });

            container.appendChild(span);
        }
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

/**
 * A duration short enough to sit in a tile.
 *
 * `timeReadable` writes "71 days 9h 55m", which is right in a tooltip and wrong
 * in a tile forty pixels wide — it pushed the label it sat beside down to a
 * single letter. Two units at most, and the small one drops off once the large
 * one is big enough to make it noise.
 *
 * @param {number} seconds - Duration
 * @returns {string} e.g. `45s`, `12m`, `3h 20m`, `4d 16h`, `71d`
 */
export function shortDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '—';

    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;

    if (seconds < 86400) {
        const hours = Math.floor(seconds / 3600);
        const minutes = Math.floor((seconds % 3600) / 60);
        return minutes ? `${hours}h ${minutes}m` : `${hours}h`;
    }

    const days = Math.floor(seconds / 86400);
    // Past a month the hours are noise beside the days, and the space they take
    // is the space the label beside them needs
    if (days >= 30) return `${days}d`;

    const hours = Math.floor((seconds % 86400) / 3600);
    return hours ? `${days}d ${hours}h` : `${days}d`;
}
