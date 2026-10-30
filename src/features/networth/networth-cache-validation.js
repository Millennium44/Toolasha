/**
 * Keeping the net-worth enhancement cost cache honest.
 *
 * The cache holds enhancement costs priced from the order book, the net-worth pricing mode, the
 * player's custom prices and the base-item crafting setting. The market hash it validates against
 * sees only the first of those, so every reader validates through here with the shared pricing stamp
 * as the salt: the net-worth calculation and the inventory badges. Against the market's change log
 * (marketAPI.changesSince) every call checks; against a stub without one the whole book is hashed,
 * which the badge path does at most every couple of seconds.
 */

import marketAPI from '../../api/marketplace.js';
import { pricingStamp } from '../../utils/enhancement-input-pricing.js';
import networthCache from './networth-cache.js';

/** How long a badge-path validation is trusted before the book is hashed again */
const BADGE_VALIDATION_MS = 2000;

let lastValidatedAt = 0;
let lastStamp = null;

/**
 * Empty the cache if anything it was priced from has changed.
 * @param {Object} [options] - Options
 * @param {boolean} [options.force=true] - Hash the book now; false trusts a check made moments ago
 *   unless the pricing stamp itself has moved
 */
export function validateNetworthCache({ force = true } = {}) {
    const stamp = pricingStamp();
    // With the market's change log the check costs what changed, not the size of the book, so every
    // reader runs it every time and a patch drops only the costs that read that item
    if (typeof networthCache.syncWithMarket === 'function' && networthCache.syncWithMarket(marketAPI, stamp)) {
        lastStamp = stamp;
        return;
    }
    const now = Date.now();
    if (!force && stamp === lastStamp && now - lastValidatedAt < BADGE_VALIDATION_MS) return;
    lastValidatedAt = now;
    lastStamp = stamp;
    networthCache.checkAndInvalidate({ marketData: marketAPI.marketData, pricePatchs: marketAPI.pricePatchs }, stamp);
}
