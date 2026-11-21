/**
 * The Per-player panel's hit tape: your last minute of hits, one bar each.
 *
 * The DPS graph above it is a 16-second average, which is the right shape for "is the pace holding" and the
 * wrong one for "what just happened": a run of misses, a crit, a wave gap and a stall all smooth into the same
 * gentle dip. A bar per hit shows them as they were. Height is the hit's damage against the largest hit on
 * the tape, a gold cap is a crit, a hollow stub is a miss, purple is damage over time and orange is reflect.
 *
 * Built from `damage-tracker.js`' bounded ring of single-owner hits (`recentHits`): no recorder of its own,
 * nothing persisted. Drawn as an SVG string, like the graph, so it rides the panel's own redraw and has no
 * canvas, observer or timer to dispose.
 *
 * The idea is upstream Toolasha's Combat Live hit tape; the code is this fork's.
 */

import config from '../../core/config.js';
import { HIT_TAPE_MS, recentHits } from './damage-tracker.js';
import { BOARD_COLORS } from '../../utils/damage-board.js';

export const TAPE_WIDTH = 300;
export const TAPE_HEIGHT = 36;
/** A bar's width in px; a crit cap overhangs it by one px on each side */
const BAR_WIDTH = 3;
/** The smallest landed hit still gets a visible bar, as a share of the height */
const MIN_BAR = 0.08;
const MISS_BAR = 0.12;

export const TAPE_COLORS = {
    hit: BOARD_COLORS.accent,
    dot: '#b86bff',
    reflect: '#ff9a3c',
    crit: '#ffd24a',
    miss: '#8b93a1',
};

/**
 * Bars for the tape, newest at the right edge.
 * @param {Array<{at: number, amount: number, kind: string}>} hits - Oldest first
 * @param {number} now - The tape's right edge, ms
 * @param {number} [width] - Px
 * @param {number} [windowMs] - Time the tape covers
 * @returns {{bars: Array<{x: number, height: number, kind: string}>, max: number}} Heights 0 to 1
 */
export function hitTapeModel(hits, now, width = TAPE_WIDTH, windowMs = HIT_TAPE_MS) {
    const start = now - windowMs;
    const visible = hits.filter((hit) => hit.at > start && hit.at <= now);
    const max = visible.reduce((largest, hit) => (hit.kind === 'miss' ? largest : Math.max(largest, hit.amount)), 0);
    const bars = visible.map((hit) => {
        const x = Math.min(width - 1, Math.max(0, Math.floor(((hit.at - start) / windowMs) * width)));
        if (hit.kind === 'miss') return { x, height: MISS_BAR, kind: 'miss' };
        const height = max > 0 ? Math.min(1, Math.max(MIN_BAR, hit.amount / max)) : MIN_BAR;
        return { x, height, kind: hit.kind };
    });
    return { bars, max };
}

/**
 * The tape as SVG.
 * @param {{bars: Array<Object>}} model - From {@link hitTapeModel}
 * @param {number} [width]
 * @param {number} [height]
 * @returns {string} SVG markup
 */
export function hitTapeSVG(model, width = TAPE_WIDTH, height = TAPE_HEIGHT) {
    const usable = height - 3;
    const parts = [
        `<rect x="0" y="0" width="${width}" height="${height}" fill="rgba(255,255,255,0.04)"/>`,
        `<rect x="0" y="${height - 1}" width="${width}" height="1" fill="rgba(255,255,255,0.12)"/>`,
    ];
    for (const bar of model.bars) {
        const barHeight = Math.max(2, Math.round(bar.height * usable));
        const top = height - 1 - barHeight;
        // Centered on its time, and kept inside the tape at either edge
        const left = Math.min(Math.max(0, bar.x - 1), width - BAR_WIDTH);
        if (bar.kind === 'miss') {
            parts.push(
                `<rect x="${left + 0.5}" y="${top + 0.5}" width="${BAR_WIDTH - 1}" height="${barHeight - 1}" ` +
                    `fill="none" stroke="${TAPE_COLORS.miss}" stroke-width="1"/>`
            );
            continue;
        }
        const fill = bar.kind === 'dot' ? TAPE_COLORS.dot : bar.kind === 'reflect' ? TAPE_COLORS.reflect : TAPE_COLORS.hit;
        parts.push(`<rect x="${left}" y="${top}" width="${BAR_WIDTH}" height="${barHeight}" fill="${fill}"/>`);
        if (bar.kind === 'crit') {
            parts.push(
                `<rect x="${left - 1}" y="${top - 1}" width="${BAR_WIDTH + 2}" height="3" fill="${TAPE_COLORS.crit}"/>`
            );
        }
    }
    return (
        `<svg data-hit-tape-svg width="100%" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" ` +
        `style="display:block; height:${height}px;">${parts.join('')}</svg>`
    );
}

/**
 * The tape section for the Per-player panel's Damage tab.
 * @param {Object} [options] - For tests
 * @param {number} [options.now] - Clock
 * @param {Function} [options.hits] - `recentHits`, injectable
 * @returns {string} HTML, or '' with the setting off
 */
export function hitTapeHTML({ now = Date.now(), hits = recentHits } = {}) {
    if (config.getSetting('combatDpsHitTape') !== true) return '';
    const { dim } = BOARD_COLORS;
    const heading =
        `<div style="color:${dim}; font-size:10px; margin-bottom:2px;" ` +
        `title="Your last minute of hits: height is damage, a gold cap is a crit, a hollow stub is a miss, purple ` +
        `is damage over time, orange is reflect. Gaps are between waves. Hits on a tick shared with another ` +
        `party member are left out.">Your hits, last minute</div>`;
    const model = hitTapeModel(hits(now), now);
    if (!model.bars.length) {
        return (
            `<div data-hit-tape style="margin:2px 0 6px;">${heading}` +
            `<div style="color:${dim}; font-size:9px;">No hits of yours in the last minute.</div></div>`
        );
    }
    return `<div data-hit-tape style="margin:2px 0 6px;">${heading}${hitTapeSVG(model)}</div>`;
}
