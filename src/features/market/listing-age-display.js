/**
 * Where listing age is shown, and how it is written.
 *
 * One question — "where do you want to see how old a listing is?" — used to be
 * three switches (`market_showListingAge`, `market_showTopOrderAge`,
 * `market_showEstimatedListingAge`) that nothing stopped you from setting
 * incoherently, plus a format dropdown only one of the three surfaces read. The
 * two surfaces now answer to one setting and share one format, so choosing
 * Date/Time means Date/Time everywhere it appears.
 *
 * Both My Listings columns live in the table `market_showListingPrices` builds,
 * so that setting remains their real prerequisite — this module only says
 * whether the age columns are wanted, not whether there is a table to put them
 * in.
 */

import config from '../../core/config.js';
import { formatRelativeTime, formatDateTime } from '../../utils/formatters.js';

/** The one setting behind every listing-age display */
export const LISTING_AGE_SETTING = 'market_listingAge';

/**
 * Where listing age is wanted: 'off', 'myListings', 'orderBook' or 'both'.
 * @returns {string}
 */
export function listingAgeMode() {
    return config.getSettingValue(LISTING_AGE_SETTING, 'orderBook');
}

/**
 * Whether the order book's estimated-age column is wanted.
 * @returns {boolean}
 */
export function showsOrderBookAge() {
    const mode = listingAgeMode();
    return mode === 'orderBook' || mode === 'both';
}

/**
 * Whether the My Listings age columns ("Listed" and "Top Order Age") are wanted.
 * @returns {boolean}
 */
export function showsMyListingsAge() {
    const mode = listingAgeMode();
    return mode === 'myListings' || mode === 'both';
}

/**
 * A listing's creation time, written the way the format setting asks — elapsed
 * ("3h 45m") or absolute ("01-13 14:30").
 * @param {number} timestamp - Creation time in milliseconds
 * @returns {string} Formatted time
 */
export function formatListingTimestamp(timestamp) {
    const ageFormat = config.getSettingValue('market_listingAgeFormat', 'datetime');
    if (ageFormat === 'elapsed') {
        return formatRelativeTime(Date.now() - timestamp);
    }
    return formatDateTime(new Date(timestamp));
}
