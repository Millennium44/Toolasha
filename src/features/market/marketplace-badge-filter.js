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
const BADGE =
    '[class*="NavigationBar_nav__"]:has(svg[aria-label="navigationBar.marketplace"]) ' +
    '[class*="NavigationBar_badge"]:not([class*="NavigationBar_ocean"])';

/**
 * Hide it, or make it say a different number.
 *
 * The count has to come through CSS like the hiding does, and for the same
 * reason: React owns that node and rewrites its text on every update, so
 * anything written into it is gone within the second. A generated rule that
 * blanks the real text and prints ours in a pseudo-element survives every
 * re-render, because the game does not know the rule exists.
 *
 * @param {number|null} count - What it should say, or null to hide it entirely
 * @returns {string} A stylesheet
 */
function badgeCss(count) {
    if (count === null) return `${BADGE} { display: none !important; }`;

    return `
        ${BADGE} { font-size: 0 !important; }
        ${BADGE}::after {
            content: "${count}";
            font-size: 12px;
            line-height: 1;
        }
    `;
}

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
 * @param {Array<Object>|Object} listings - The character's market listings
 * @returns {boolean}
 */
export function anyFinished(listings) {
    return Object.values(listings || {}).some(isFinishedWithSpoils);
}

class MarketplaceBadgeFilter {
    constructor() {
        this.hidden = false;
        /** How many finished listings the badge is currently claiming */
        this.showing = null;
        this.unregister = null;
        /** The last non-empty listing array seen on the wire */
        this.lastSeen = null;
    }

    initialize() {
        if (!config.getSetting('market_badgeOnlyWhenFinished')) return;

        // The payload is kept as well as read from the character's book, because
        // the two have disagreed: whichever of them has listings is the one to
        // believe. Trusting only the book meant that if it ever came back empty
        // the badge was hidden with no way to tell from the outside why.
        const updateHandler = (data) => {
            const listings = data?.endMarketListings || data?.myMarketListings;
            if (Array.isArray(listings) && listings.length) this.lastSeen = listings;
            this.refresh();
        };
        dataManager.on('character_initialized', updateHandler);
        dataManager.on('market_listings_updated', updateHandler);
        this.unregister = () => {
            dataManager.off('character_initialized', updateHandler);
            dataManager.off('market_listings_updated', updateHandler);
        };

        // Read what is already known rather than waiting to be told.
        //
        // This is the whole of the bug it used to have. Features are initialized
        // from *inside* the `character_initialized` handler, so by the time this
        // runs that event has already fired and this listener will never see it.
        // The old code hid the badge here and then waited for a payload that had
        // already gone past — so a filled order sitting there through a reload
        // stayed unbadged until some unrelated listing happened to change.
        this.refresh();
    }

    /**
     * Re-decide from the listings as they currently stand.
     *
     * Read from the data manager rather than accumulated here. It already merges
     * each `market_listings_updated` into the character's book, and a private
     * copy could only drift from it — a listing that leaves the book would linger
     * in the copy at whatever state it was last seen, badging the sidebar for an
     * order that no longer exists.
     */
    refresh() {
        // The count, not just the presence. The game badges every listing with
        // anything collectable, so a filled order beside a buy order that has
        // taken 130 of 719 reads "2" — and collecting the 130 does nothing but
        // silence it. One of those is finished, so the badge should say one.
        this.apply(this.book().filter(isFinishedWithSpoils).length);
    }

    /**
     * The listings to judge, from whichever source has any.
     *
     * @returns {Array<Object>} Possibly empty
     */
    book() {
        const held = dataManager.characterData?.myMarketListings;
        if (Array.isArray(held) && held.length) return held;
        return this.lastSeen || [];
    }

    /**
     * Why the badge is or is not showing.
     *
     * The feature's only output is the absence of something, which is
     * indistinguishable from it being switched off, from the game not badging,
     * and from every listing genuinely still working. This says which.
     *
     * Console: `Toolasha.Debug.marketBadge()`
     *
     * @returns {Object} What it can see
     */
    describe() {
        const listings = this.book();
        const finished = listings.filter(isFinishedWithSpoils);

        const report = {
            settingOn: !!config.getSetting('market_badgeOnlyWhenFinished'),
            listening: !!this.unregister,
            fromCharacterData: Array.isArray(dataManager.characterData?.myMarketListings)
                ? dataManager.characterData.myMarketListings.length
                : 'absent',
            fromLastMessage: this.lastSeen ? this.lastSeen.length : 'none seen',
            finished: finished.length,
            hidingBadge: this.hidden,
            styleInDocument: !!document.getElementById(STYLE_ID),
        };

        console.log('[Toolasha] Marketplace badge filter:', report);
        if (listings.length) {
            console.table(
                listings.map((listing) => ({
                    id: listing.id,
                    status: String(listing.status || '')
                        .split('/')
                        .pop(),
                    ordered: listing.orderQuantity,
                    filled: listing.filledQuantity,
                    unclaimedItems: listing.unclaimedItemCount,
                    unclaimedCoins: listing.unclaimedCoinCount,
                    countsAsFinished: isFinishedWithSpoils(listing),
                }))
            );
        }
        return report;
    }

    /**
     * @param {number} finished - How many listings have finished
     */
    apply(finished) {
        if (finished === this.showing) return;
        this.showing = finished;
        this.hidden = finished === 0;

        // Removed first: `addStyles` appends a new element every call, so
        // toggling without this leaves a stack of them and the oldest wins
        removeStyles(STYLE_ID);
        addStyles(badgeCss(finished > 0 ? finished : null), STYLE_ID);
    }

    disable() {
        this.unregister?.();
        this.unregister = null;
        removeStyles(STYLE_ID);
        this.hidden = false;
        this.showing = null;
    }
}

const marketplaceBadgeFilter = new MarketplaceBadgeFilter();
export default marketplaceBadgeFilter;
