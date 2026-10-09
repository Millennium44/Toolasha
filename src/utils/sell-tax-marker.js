/**
 * Marker for profit figures computed with the sell-tax exclusion
 * (`profitCalc_excludeSellTax`, "producing for personal use").
 *
 * Those figures assume the output is kept rather than sold, so they read higher than a sale
 * would earn. Anywhere a number is drawn compactly (tile Profit/hr), this marker is appended so
 * it is not mistaken for a sale profit.
 */

import { SELL_TAX_EXCLUDED_TOOLTIP } from './profit-constants.js';

/** Setting key for the personal-use sell-tax exclusion. */
export const SELL_TAX_SETTING = 'profitCalc_excludeSellTax';

/**
 * Plain-text marker appended to a compact figure. Plain text, not a nested element: the tile
 * stat spans are rewritten through `textContent` when a best-action badge is added or removed,
 * which flattens any child element.
 * @param {boolean} excludeSellTax - `excludeSellTax` from the profit calculator's result
 * @returns {string}
 */
export function sellTaxMarker(excludeSellTax) {
    return excludeSellTax ? ' ⚠' : '';
}

/**
 * Tooltip attribute for the span that carries the marker, so hovering the ⚠ explains it.
 * @param {boolean} excludeSellTax
 * @returns {string} A ` title="..."` attribute, or an empty string
 */
export function sellTaxTitleAttr(excludeSellTax) {
    return excludeSellTax ? ` title="${SELL_TAX_EXCLUDED_TOOLTIP}"` : '';
}

/**
 * Warning-colored HTML marker for surfaces built with innerHTML (action bar, queue rows).
 * @param {boolean} excludeSellTax
 * @param {string} color - Warning color
 * @returns {string}
 */
export function sellTaxMarkerHtml(excludeSellTax, color) {
    return excludeSellTax
        ? ` <span class="mwi-sell-tax-marker" style="color: ${color};" title="${SELL_TAX_EXCLUDED_TOOLTIP}">⚠</span>`
        : '';
}
