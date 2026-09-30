/**
 * Labyrinth room distribution
 *
 * How the floor's rooms are spread across clear chance: a histogram of the
 * clear chances already calculated for the rooms on the floor in view, so a
 * floor reads as "mostly safe with a tail of hard rooms" or the reverse at a
 * glance instead of tile by tile.
 *
 * The idea, and the bin-width control, are from the Labyrinth Win Rate
 * Calculator by dakonglong (MIT) — see `third-party/labyrinth-clear-rate/` and
 * `docs/THIRD-PARTY-LICENSES.md`. That script simulates every room type at
 * every level of the floor; this one reads the results the tile badges already
 * hold, so it costs no simulation and cannot disagree with the badges. The code
 * is Toolasha's own.
 *
 * A room with no result is reported as unjudged. It is never counted as 0%,
 * which would drag the whole distribution toward "unwinnable" on a floor whose
 * calculation has simply not run yet.
 */

import config from '../../core/config.js';
import { createPanel, panelCard, panelLine, panelNote } from '../../utils/simple-panel.js';

const PANEL_ID = 'labyrinth-room-distribution';
const ACCENT = '#8fb4ff';
const SVG_NS = 'http://www.w3.org/2000/svg';

/** Bin widths offered in the panel, in percentage points */
export const BIN_WIDTH_OPTIONS = [5, 10, 20, 25, 50];
export const DEFAULT_BIN_WIDTH = 10;
const MIN_BIN_WIDTH = 5;
const MAX_BIN_WIDTH = 100;

/**
 * Coerce a bin width to a whole number of percentage points the histogram can use.
 * @param {*} value - Setting value or control value, a number or numeric string
 * @returns {number} 5 to 100, or the default when the value is not a number
 */
export function normalizeBinWidth(value) {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return DEFAULT_BIN_WIDTH;
    return Math.min(MAX_BIN_WIDTH, Math.max(MIN_BIN_WIDTH, n));
}

/**
 * Bucket clear chances into equal-width bins over 0-100%.
 *
 * A chance of exactly 100% lands in the last bin rather than opening a bin of
 * its own, and a last bin narrower than the rest (a width that does not divide
 * 100) is clamped to 100.
 *
 * @param {number[]} chances - Clear chances as fractions, 0 to 1
 * @param {number} binWidth - Bin width in percentage points
 * @returns {Array<{min: number, max: number, count: number, ratio: number}>} One entry per bin, lowest first
 */
export function summarizeRoomDistribution(chances, binWidth) {
    const width = normalizeBinWidth(binWidth);
    const source = Array.isArray(chances) ? chances.filter((c) => Number.isFinite(c)) : [];
    const binCount = Math.max(1, Math.ceil(100 / width));
    const bins = Array.from({ length: binCount }, (_unused, index) => ({
        min: index * width,
        max: Math.min(100, (index + 1) * width),
        count: 0,
        ratio: 0,
    }));
    for (const chance of source) {
        // Rounded to the badge's whole percent so a room shown as "50%" sits in
        // the bin that percent belongs to, not the one 49.6% would
        const percent = Math.round(Math.min(1, Math.max(0, chance)) * 100);
        const index = Math.min(binCount - 1, Math.floor(percent / width));
        bins[index].count += 1;
    }
    if (source.length > 0) {
        for (const bin of bins) bin.ratio = bin.count / source.length;
    }
    return bins;
}

/**
 * Sort the rooms of a floor into judged and not, and gather the judged chances.
 *
 * Mirrors the eligibility rules of the tile calculation: cleared rooms and
 * treasure rooms carry no badge, a room whose contents are not revealed has no
 * monster or skill to judge, and a revealed room without a result yet is
 * pending rather than lost.
 *
 * @param {Object} input - The floor as the clear-rate module holds it
 * @param {Array} input.rooms - `roomData`, a grid of rows or an already flat list
 * @param {Map<string, Object>|null} input.results - Tile results keyed `"col,row"`
 * @param {number} [input.floor] - Floor number, echoed back for the title
 * @returns {Object} `{ floor, chances, judged, pending, unrevealed, cleared, treasure, minLevel, maxLevel, mean, median }`
 */
export function collectFloorChances({ rooms, results, floor = 0 }) {
    const grid = Array.isArray(rooms) ? rooms : [];
    const flat = grid.flat();
    const cols = Array.isArray(grid[0]) ? grid[0].length : 0;
    const summary = {
        floor,
        chances: [],
        judged: 0,
        pending: 0,
        unrevealed: 0,
        cleared: 0,
        treasure: 0,
        minLevel: null,
        maxLevel: null,
        mean: null,
        median: null,
    };

    for (let i = 0; i < flat.length; i++) {
        const room = flat[i];
        if (!room) continue;
        if (room.isCleared) {
            summary.cleared++;
            continue;
        }
        if (String(room.roomType || '').endsWith('/treasure')) {
            summary.treasure++;
            continue;
        }
        const level = Math.max(0, Math.floor(Number(room.recommendedLevel) || 0));
        if ((!room.skillHrid && !room.monsterHrid) || level <= 0) {
            summary.unrevealed++;
            continue;
        }
        const tileKey = cols ? `${i % cols},${Math.floor(i / cols)}` : '';
        const chance = results?.get(tileKey)?.clearChance;
        if (!Number.isFinite(chance)) {
            summary.pending++;
            continue;
        }
        summary.chances.push(Math.min(1, Math.max(0, chance)));
        summary.judged++;
        summary.minLevel = summary.minLevel === null ? level : Math.min(summary.minLevel, level);
        summary.maxLevel = summary.maxLevel === null ? level : Math.max(summary.maxLevel, level);
    }

    if (summary.chances.length) {
        const sorted = [...summary.chances].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        summary.mean = sorted.reduce((sum, c) => sum + c, 0) / sorted.length;
        summary.median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return summary;
}

/**
 * Bar color by where the bin sits: red under 50%, amber under 80%, green above.
 * @param {number} min - Bin lower edge, percent
 * @param {number} max - Bin upper edge, percent
 * @returns {string} CSS color
 */
function binColor(min, max) {
    const mid = (min + max) / 2;
    if (mid < 50) return '#ef6b6b';
    if (mid < 80) return '#e8b04a';
    return '#5fcf8a';
}

/**
 * Draw the histogram as an SVG that scales to the panel's width.
 * @param {Array} bins - From `summarizeRoomDistribution`
 * @returns {SVGElement}
 */
function buildHistogramSvg(bins) {
    const width = 300;
    const height = 130;
    const top = 16;
    const bottom = 20;
    const plotHeight = height - top - bottom;
    const slot = width / bins.length;
    const barWidth = Math.max(2, slot - 2);
    const peak = Math.max(1, ...bins.map((bin) => bin.count));
    // Labels every bin would overprint each other past ten bins
    const labelEvery = bins.length > 10 ? Math.ceil(bins.length / 10) : 1;

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Rooms by clear chance');
    svg.style.maxWidth = '100%';
    svg.style.flex = '0 0 auto';

    const text = (x, y, content, anchor, fill) => {
        const el = document.createElementNS(SVG_NS, 'text');
        el.setAttribute('x', String(x));
        el.setAttribute('y', String(y));
        el.setAttribute('text-anchor', anchor);
        el.setAttribute('font-size', '9');
        el.setAttribute('fill', fill);
        el.textContent = content;
        return el;
    };

    bins.forEach((bin, index) => {
        const barHeight = (bin.count / peak) * plotHeight;
        const x = index * slot + (slot - barWidth) / 2;
        const rect = document.createElementNS(SVG_NS, 'rect');
        rect.setAttribute('x', x.toFixed(1));
        rect.setAttribute('y', (top + plotHeight - barHeight).toFixed(1));
        rect.setAttribute('width', barWidth.toFixed(1));
        rect.setAttribute('height', barHeight.toFixed(1));
        rect.setAttribute('fill', binColor(bin.min, bin.max));
        rect.setAttribute('rx', '1');
        const title = document.createElementNS(SVG_NS, 'title');
        title.textContent = `${bin.min}-${bin.max}%: ${bin.count} room${bin.count === 1 ? '' : 's'}`;
        rect.appendChild(title);
        svg.appendChild(rect);

        const cx = index * slot + slot / 2;
        if (bin.count > 0)
            svg.appendChild(text(cx, top + plotHeight - barHeight - 3, String(bin.count), 'middle', '#e8ecf5'));
        if (index % labelEvery === 0) svg.appendChild(text(cx, height - 6, String(bin.min), 'middle', '#9ab0d8'));
    });
    svg.appendChild(text(width, height - 6, '100%', 'end', '#9ab0d8'));
    return svg;
}

/** Where the panel reads the floor from; set by whoever opens it */
let source = null;
let panel = null;

/**
 * Draw the panel body from the floor the source reports.
 * @param {HTMLElement} body - The panel's scrolling body
 */
function draw(body) {
    const floor = source ? source() : null;
    const summary = floor ? collectFloorChances(floor) : null;
    const roomCount = summary
        ? summary.judged + summary.pending + summary.unrevealed + summary.cleared + summary.treasure
        : 0;
    if (!roomCount) {
        body.appendChild(panelNote('Open a labyrinth floor to see how its rooms are spread across clear chance.'));
        return;
    }

    const binWidth = normalizeBinWidth(config.getSettingValue('labyrinthDistributionBinWidth', DEFAULT_BIN_WIDTH));

    const controls = document.createElement('div');
    Object.assign(controls.style, { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' });
    const label = document.createElement('span');
    label.textContent = 'Bin width';
    label.style.color = '#9ab0d8';
    const select = document.createElement('select');
    select.classList.add('toolasha-select');
    select.title = 'Width of each clear-chance bin, in percentage points';
    for (const option of new Set([...BIN_WIDTH_OPTIONS, binWidth])) {
        const el = document.createElement('option');
        el.value = String(option);
        el.textContent = `${option}%`;
        select.appendChild(el);
    }
    select.value = String(binWidth);
    select.addEventListener('change', () => {
        config.setSettingValue('labyrinthDistributionBinWidth', normalizeBinWidth(select.value));
        panel?.render();
    });
    controls.append(label, select);
    body.appendChild(controls);

    const card = panelCard(body, `Floor ${summary.floor} clear chance`, ACCENT);
    if (summary.judged === 0) {
        card.appendChild(
            panelNote(
                summary.pending
                    ? 'No room has been calculated yet. Run Calculate on the floor map.'
                    : 'No room on this floor has a clear chance to judge.'
            )
        );
    } else {
        card.appendChild(buildHistogramSvg(summarizeRoomDistribution(summary.chances, binWidth)));
        card.appendChild(panelLine('Mean', `${(summary.mean * 100).toFixed(1)}%`));
        card.appendChild(panelLine('Median', `${(summary.median * 100).toFixed(1)}%`));
        card.appendChild(panelLine('Room levels', `Lv.${summary.minLevel}-${summary.maxLevel}`));
    }

    const counts = panelCard(body, 'Rooms', ACCENT);
    counts.appendChild(panelLine('Judged', String(summary.judged)));
    if (summary.pending) {
        counts.appendChild(
            panelLine(
                'Not calculated yet',
                String(summary.pending),
                '#e8b04a',
                'Revealed rooms with no clear chance yet'
            )
        );
    }
    if (summary.unrevealed) {
        counts.appendChild(
            panelLine('Unrevealed', String(summary.unrevealed), '#9ab0d8', 'Rooms whose contents are not revealed')
        );
    }
    if (summary.cleared || summary.treasure) {
        counts.appendChild(panelNote(`Left out: ${summary.cleared} cleared, ${summary.treasure} treasure.`));
    }
}

/**
 * Open or close the distribution panel, pointing it at a floor.
 * The panel shell is built on first use: creating one subscribes to
 * character switches, which a script whose user never opens it should not pay for.
 * @param {Function} getFloor - Returns `{ rooms, results, floor }` for the floor in view
 */
export function toggleRoomDistribution(getFloor) {
    source = getFloor;
    if (!panel) {
        panel = createPanel({
            id: PANEL_ID,
            title: 'Labyrinth win-rate distribution',
            size: { width: 340, height: 380 },
            accent: ACCENT,
            draw,
        });
    }
    panel.toggle();
}

/** Redraw the panel if it is open, after the floor's badges have changed */
export function refreshRoomDistribution() {
    if (panel?.isOpen()) panel.render();
}

/** Release the panel and its floor source, for the feature's teardown */
export function destroyRoomDistribution() {
    panel?.destroy();
    panel = null;
    source = null;
}
