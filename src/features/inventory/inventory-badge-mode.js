/**
 * Which value badges the inventory tiles carry.
 *
 * Four settings used to answer this — `invSort_showBadges`,
 * `invSort_badgesOnNone` (a dropdown whose 'None' doubled as an off switch),
 * `invBadgePrices` (a second badge system drawing on the same tile) and
 * `invSort_netOfTax`. The first three are one choice: a tile shows the stack's
 * value, or per-item ask/bid prices, or nothing. `invSort_netOfTax` is a
 * separate question about that value and is unchanged.
 *
 * The side a stack is priced on follows the sort while there is one; the
 * 'alwaysAsk' / 'alwaysBid' values say which side to use when the sort is None,
 * which is what `invSort_badgesOnNone` used to say.
 */

import config from '../../core/config.js';

/** The one setting behind every inventory value badge */
export const BADGE_MODE_SETTING = 'inv_valueBadges';

/**
 * The chosen badge mode: 'off', 'sorting', 'alwaysAsk', 'alwaysBid' or 'prices'.
 * @returns {string}
 */
export function badgeMode() {
    return config.getSettingValue(BADGE_MODE_SETTING, 'off');
}

/**
 * Which dataset key a stack-value badge should read for the current sort, or
 * null when no stack badge belongs on the tile.
 * @param {string} sortMode - Inventory sort mode: 'ask', 'bid' or 'none'
 * @returns {string|null} 'askValue', 'bidValue', or null
 */
export function stackBadgeValueKey(sortMode) {
    const mode = badgeMode();
    if (mode === 'off' || mode === 'prices') return null;
    if (sortMode === 'ask' || sortMode === 'bid') {
        // Sorting by a side means that side is the one being looked at
        return mode === 'sorting' || mode === 'alwaysAsk' || mode === 'alwaysBid' ? `${sortMode}Value` : null;
    }
    if (mode === 'alwaysAsk') return 'askValue';
    if (mode === 'alwaysBid') return 'bidValue';
    return null; // 'sorting', with nothing being sorted
}

/**
 * Whether the per-item ask/bid price badges are the chosen display.
 * @returns {boolean}
 */
export function showsItemPriceBadges() {
    return badgeMode() === 'prices';
}
