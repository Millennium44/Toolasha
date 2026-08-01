/**
 * Marketplace Badge Filter
 *
 * Quietens the Marketplace badge in the left sidebar so it only appears when a
 * listing has actually finished.
 *
 * The game badges the sidebar the moment anything is collectable, which
 * includes a buy order that has taken 30 of 200 units and is still working.
 * That order is not waiting on you — collecting the 30 does nothing except stop
 * the badge, and it will be back within the hour. A notification that fires on
 * something you cannot act on teaches you to ignore the notification.
 *
 * "Finished" means nothing more will fill: the order filled completely, or it
 * was cancelled and is holding a refund. Both are things you can close out. An
 * order still working is not, and is what this hides.
 *
 * The badge inside the Marketplace panel — on the My Listings tab — is left
 * alone deliberately. Once you are in the marketplace, knowing there is
 * something to collect is useful; it is only the sidebar nag that isn't.
 *
 * Implemented as a stylesheet toggled by listing data rather than by clearing
 * the badge's text. React owns that node and rewrites it on every update, so
 * anything written into it would be overwritten within the second; a rule the
 * game does not know about survives every re-render.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'mwi-marketplace-badge-filter';

/**
 * Hides only the sidebar's Marketplace badge. Scoped through the nav item's own
 * icon label rather than a position, so a reordered sidebar still matches, and
 * excluding the ocean variant the way the other badge features do.
 */
const CSS = `
    [class*="NavigationBar_nav__"]:has(svg[aria-label="navigationBar.marketplace"]) [class*="NavigationBar_badge"]:not([class*="NavigationBar_ocean"]) {
        display: none !important;
    }
`;

/**
 * Whether a listing is done and holding something for you.
 *
 * Exported for tests: the DOM half of this feature cannot be tested here, but
 * the rule deciding when the badge is legitimate is the part worth pinning
 * down.
 *
 * @param {Object} listing - A market listing from the server
 * @returns {boolean} True when it has finished and has something unclaimed
 */
export function isFinishedWithSpoils(listing) {
    if (!listing) return false;

    const unclaimed =
        Math.max(0, Number(listing.unclaimedItemCount) || 0) + Math.max(0, Number(listing.unclaimedCoinCount) || 0);
    if (unclaimed <= 0) return false;

    // A cancelled order is holding a refund and will never fill again, so it is
    // as finished as a filled one
    if (listing.status === '/market_listing_status/cancelled') return true;

    const filled = Math.max(0, Number(listing.filledQuantity) || 0);
    const ordered = Math.max(0, Number(listing.orderQuantity) || 0);
    return ordered > 0 && filled >= ordered;
}

/**
 * Whether any listing in the book warrants badging the sidebar.
 * @param {Object} listings - Keyed by listing id
 * @returns {boolean}
 */
export function anyFinished(listings) {
    return Object.values(listings || {}).some(isFinishedWithSpoils);
}

class MarketplaceBadgeFilter {
    constructor() {
        this.listings = {};
        this.hidden = false;
        this.unregister = null;
    }

    initialize() {
        if (!config.getSetting('market_badgeOnlyWhenFinished')) return;

        const initHandler = (data) => this.ingest(data?.myMarketListings);
        const updateHandler = (data) => this.ingest(data?.endMarketListings);

        dataManager.on('character_initialized', initHandler);
        dataManager.on('market_listings_updated', updateHandler);
        this.unregister = () => {
            dataManager.off('character_initialized', initHandler);
            dataManager.off('market_listings_updated', updateHandler);
        };

        // Nothing is known until the first payload arrives. Hiding straight away
        // rather than waiting means a stale badge from before the script loaded
        // does not sit there unexplained; the first update corrects it either way.
        this.apply(false);
    }

    /**
     * @param {Array<Object>} listings - Listings from the server
     */
    ingest(listings) {
        if (!Array.isArray(listings)) return;
        for (const listing of listings) {
            if (!listing || listing.id == null) continue;
            this.listings[listing.id] = listing;
        }
        this.apply(anyFinished(this.listings));
    }

    /**
     * @param {boolean} show - Whether the badge is warranted
     */
    apply(show) {
        if (show === !this.hidden) return;
        this.hidden = !show;
        if (this.hidden) addStyles(CSS, STYLE_ID);
        else removeStyles(STYLE_ID);
    }

    disable() {
        this.unregister?.();
        this.unregister = null;
        removeStyles(STYLE_ID);
        this.hidden = false;
        this.listings = {};
    }
}

const marketplaceBadgeFilter = new MarketplaceBadgeFilter();
export default marketplaceBadgeFilter;
