/**
 * Tile badge text
 *
 * Toolasha text drawn on a game item tile (the stack-value badge and the per-item ask/bid badges) is
 * not inside a Toolasha surface, so the text-appearance zoom and font rules never reach it. It reads the
 * two custom properties text-appearance publishes on `:root` instead, so a settings change restyles every
 * badge already on the page with no re-render.
 */

/** The current Toolasha text zoom, published on `:root` while it is not 1 (read it with a fallback of 1) */
export const ZOOM_VARIABLE = '--toolasha-text-zoom';

/** The chosen Toolasha font stack, published on `:root` while a font other than the default is chosen */
export const FONT_VARIABLE = '--toolasha-font-stack';

/**
 * Largest zoom the stack-value badge follows. Game item tiles are 60px wide (measured on the test server,
 * 16px root) and do not grow with the text setting; a four-character badge ("384M") at 0.7rem bold is
 * about 27px, so even the largest setting (150%, about 40px) stays inside the tile, which this badge
 * has to itself across its top.
 */
export const TILE_BADGE_ZOOM_CAP = 1.5;

/**
 * The per-item ask and bid badges share one row, one at each edge: two four-character values already
 * take about 54px of a 60px tile at zoom 1, so they may shrink with the setting but never grow.
 */
export const PAIRED_BADGE_ZOOM_CAP = 1;

/**
 * Font declarations for a badge on an item tile.
 *
 * At zoom 1 and the default font these compute to exactly `font-size: <rem>rem` and an inherited family.
 *
 * @param {number} rem - The badge's size at zoom 1, in rem
 * @param {number} [cap] - Largest zoom the badge follows
 * @returns {string} CSS declarations, ending in a semicolon
 */
export function tileBadgeFontCSS(rem, cap = TILE_BADGE_ZOOM_CAP) {
    return (
        `font-size: calc(${rem}rem * min(var(${ZOOM_VARIABLE}, 1), ${cap})); ` +
        `font-family: var(${FONT_VARIABLE}, inherit);`
    );
}
