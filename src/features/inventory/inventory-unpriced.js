/**
 * Unpriced-item tracking for inventory totals.
 *
 * The badge manager writes 0 into a tile's value dataset when an item has no price at all, and every
 * total skips values <= 0, so a total that left something out read low with nothing to say so. A tile
 * that is expected to carry a price (not a currency, not untradeable trainee gear) stores its name in
 * `dataset.expectPrice`; a tile whose value on the summed side is still <= 0 is unpriced.
 */

/** Leading mark on a total that left something unpriced (the "at least" convention used across Toolasha). */
export const UNPRICED_MARK = '≥';

/** How many unpriced names a hover lists before "and N more". */
const MAX_LISTED_NAMES = 10;

/**
 * Sum the positive values of tiles on one side and collect the names of tiles that should have a price
 * on that side but do not.
 * @param {Iterable<HTMLElement>} tiles - Item tiles carrying the value datasets
 * @param {string} valueKey - Dataset key to sum, e.g. 'askValue'
 * @returns {{total: number, unpriced: string[]}} Total and distinct unpriced names, in tile order
 */
export function summarizeTileValues(tiles, valueKey) {
    let total = 0;
    const unpriced = new Set();
    for (const tile of tiles) {
        const value = parseFloat(tile.dataset[valueKey]);
        if (value > 0) {
            total += value;
        } else if (tile.dataset.expectPrice) {
            unpriced.add(tile.dataset.expectPrice);
        }
    }
    return { total, unpriced: [...unpriced] };
}

/**
 * Hover text naming the items a total left out.
 * @param {string[]} names
 * @returns {string} Empty when nothing was left out
 */
export function unpricedTitle(names) {
    if (!names || names.length === 0) return '';
    const shown = names.slice(0, MAX_LISTED_NAMES).join(', ');
    const more = names.length > MAX_LISTED_NAMES ? ` and ${names.length - MAX_LISTED_NAMES} more` : '';
    return `Not included, no market price: ${shown}${more}`;
}
