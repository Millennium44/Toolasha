/**
 * Market nav row wrap
 *
 * Toolasha adds items to the game's own marketplace nav row
 * (`MarketplacePanel_marketNavButtonContainer`): the item-hop ◀/▶ buttons, the
 * listing Next button and the "Last: Buy | Sell" chip. Each holds its size
 * (`flex-shrink: 0`, `nowrap`) so another script's bar in the same row cannot
 * crush it — which on a phone-width marketplace left the whole deficit on the
 * game's own buttons (fixed height, `overflow: hidden`) until their labels were
 * cut off, and at 360px overran the row. Letting the row wrap moves the
 * overflow to a second line; a desktop row never needs one.
 *
 * The rule is scoped with `:has()` to a row that currently holds one of our
 * items, so it reverts by itself the moment the last of them is removed, by
 * whichever path removes it. Nothing is written onto the game's element, so a
 * feature's cleanup has nothing to undo. A browser without `:has()` drops the
 * rule and keeps the old single row.
 */

import { addStyles } from './dom.js';

/** Id of the stylesheet carrying the rule. */
export const NAV_ROW_WRAP_STYLE_ID = 'toolasha-market-nav-row-wrap';

/** Everything Toolasha puts in the nav row, as direct-child selectors. */
export const OUR_NAV_ROW_ITEMS = [
    '.mwi-trade-history',
    '#mwi-item-hop-prev',
    '#mwi-item-hop-next',
    '#mwi-listing-next-btn',
];

const NAV_ROW_WRAP_CSS = `
    [class*="MarketplacePanel_marketNavButtonContainer"]:has(${OUR_NAV_ROW_ITEMS.map((sel) => `> ${sel}`).join(', ')}) {
        flex-wrap: wrap;
    }
`;

/**
 * Install the nav row's wrap rule, once. Safe to call on every append.
 */
export function allowNavRowToWrap() {
    if (typeof document === 'undefined' || document.getElementById(NAV_ROW_WRAP_STYLE_ID)) return;
    addStyles(NAV_ROW_WRAP_CSS, NAV_ROW_WRAP_STYLE_ID);
}
