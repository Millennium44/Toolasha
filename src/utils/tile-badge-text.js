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
 * Largest zoom a tile badge follows. Item tiles are a fixed size that does not grow with the text setting,
 * and a four-character badge ("384M") at 0.7rem bold is already about two thirds of a 40px tile. 1.25
 * keeps it inside the tile and clear of the game's own count at the bottom and the enhancement level.
 */
export const TILE_BADGE_ZOOM_CAP = 1.25;

/**
 * Font declarations for a badge on an item tile.
 *
 * At zoom 1 and the default font these compute to exactly `font-size: <rem>rem` and an inherited family.
 *
 * @param {number} rem - The badge's size at zoom 1, in rem
 * @returns {string} CSS declarations, ending in a semicolon
 */
export function tileBadgeFontCSS(rem) {
    return (
        `font-size: calc(${rem}rem * min(var(${ZOOM_VARIABLE}, 1), ${TILE_BADGE_ZOOM_CAP})); ` +
        `font-family: var(${FONT_VARIABLE}, inherit);`
    );
}
