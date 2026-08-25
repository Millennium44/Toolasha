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
 * Hiding is a stylesheet, because a rule the game does not know about survives
 * every re-render. Showing a *different number* is not: the badge is the game's
 * own element, and a count printed in a pseudo-element is a bare digit sitting
 * where a styled badge should be. So the digits are rewritten in place and put
 * back whenever React writes its own over them, which leaves the badge exactly
 * the badge — same shape, same colour, same position.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import notificationService from '../notifications/notification-service.js';
import { listingsNewlyFinished } from '../notifications/notification-predicates.js';
import { addStyles, removeStyles } from '../../utils/dom.js';

const STYLE_ID = 'mwi-marketplace-badge-filter';

/** The sidebar item, found by its own icon label rather than by position */
const NAV = '[class*="NavigationBar_nav__"]:has(svg[aria-label="navigationBar.marketplace"])';

/**
 * The badge itself.
 *
 * `NavigationBar_badge__` with the trailing double underscore, which is where
 * the CSS-module hash begins — so this is the whole class name rather than a
 * prefix of it. Without those two characters it also matched the sidebar's
 * other badge-ish elements, and the count was written into both: the
 * Marketplace badge read "2 2". The ocean variant is excluded the way the other
 * badge features do.
 */
const BADGE = `${NAV} [class*="NavigationBar_badge__"]:not([class*="NavigationBar_ocean"])`;

/**
 * The element the number actually lives in.
 *
 * Usually the badge itself, but a badge that wraps its text in a span would put
 * the digits one level down — and writing over the badge instead would throw
 * that span away along with whatever styling it carries. Descends only through
 * only-children, which is as far as "the same box, drawn deeper" goes.
 *
 * @param {HTMLElement} badge - The badge element
 * @returns {HTMLElement} Where to write the count
 */
export function countHolder(badge) {
    let node = badge;
    while (node.childNodes.length === 1 && node.children.length === 1) node = node.children[0];
    return node;
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
        /** Undoes the shared observer registration, when there is one */
        this.unwatchAdded = null;
        /** Watches the sidebar item's own text, since React rewrites it */
        this.textWatcher = null;
        this.watchedHolder = null;
        this.badge = null;
        /**
         * Finished count at the previous observation, for the notification.
         *
         * Separate from `showing`, which is what the badge is *displaying* and
         * stays null while the filter itself is switched off — the notification
         * has to work in that case too.
         */
        this.lastFinishedCount = null;
        /** Whether the listeners are already wired, so a retry does not double them */
        this.isInitialized = false;
    }

    initialize() {
        // The feature registry retries features that failed to start, and a
        // second run here would register a second handler pair and orphan the
        // first — `this.unregister` only ever remembers the newest
        if (this.isInitialized) return;

        // Two features now read the same listings: this filter, and the "a
        // listing finished" notification. Either being on is reason enough to
        // listen, and each decides for itself what to do with the count
        const wantsBadge = config.getSetting('market_badgeOnlyWhenFinished');
        const wantsNotification = config.getSetting('notifications_marketListingFilled');
        if (!wantsBadge && !wantsNotification) return;

        this.isInitialized = true;

        // The payload is kept as well as read from the character's book, because
        // the two have disagreed: whichever of them has listings is the one to
        // believe. Trusting only the book meant that if it ever came back empty
        // the badge was hidden with no way to tell from the outside why.
        //
        // `myMarketListings` and not `endMarketListings`: the data manager emits
        // both, and only the first is the merged book. `endMarketListings` is
        // the delta — the one or two listings that just changed — so preferring
        // it made `lastSeen` a partial snapshot, and `book()` falls back to
        // `lastSeen` whenever the character's own copy is empty. A single fill
        // would then shrink the badge to what that one message mentioned.
        const updateHandler = (data) => {
            const listings = data?.myMarketListings || data?.endMarketListings;
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
        const finished = this.book().filter(isFinishedWithSpoils).length;

        this.announce(finished);
        if (config.getSetting('market_badgeOnlyWhenFinished')) this.apply(finished);
    }

    /**
     * Say so when another listing has finished.
     *
     * Deliberately not "the badge is showing something": the badge also shows
     * something the entire time you leave one uncollected, and a notification
     * for a state rather than an event is a notification you learn to ignore.
     * Only a rise counts.
     *
     * @param {number} finished - How many listings have finished now
     */
    announce(finished) {
        if (!config.getSetting('notifications_marketListingFilled')) {
            // Still tracked while switched off, so turning it on mid-session
            // does not announce a backlog that was already sitting there
            this.lastFinishedCount = finished;
            return;
        }

        if (listingsNewlyFinished(this.lastFinishedCount, finished)) {
            const noun = finished === 1 ? 'listing has' : 'listings have';
            notificationService.notify('market-listing-filled', `${finished} market ${noun} finished.`);
        }
        this.lastFinishedCount = finished;
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
            badgeOnScreen: !!document.querySelector(BADGE),
            badgeSays: document.querySelector(BADGE)?.textContent ?? 'no badge',
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

        if (finished === 0) {
            this._stopWatching();
            addStyles(`${BADGE} { display: none !important; }`, STYLE_ID);
            return;
        }
        this._watch();
        this._paint();
    }

    /**
     * Write our count into the game's badge.
     *
     * Only when it differs, which is what keeps the observer that calls this
     * from feeding itself: our own write produces a mutation, that mutation
     * calls this again, and the text already says what it should.
     *
     * @returns {boolean} Whether there was a badge to write into
     */
    _paint() {
        const badge = this._badge();
        if (!badge || this.showing === null || this.showing === 0) return false;

        const holder = countHolder(badge);
        const text = String(this.showing);
        if (holder.textContent !== text) holder.textContent = text;
        return true;
    }

    /**
     * Keep it written.
     *
     * Two different things undo it, so it takes two watchers. React rewrites the
     * digits in place, which is a `characterData` change and invisible to the
     * shared observer — that needs one scoped to the sidebar item. And the item
     * itself is torn down and rebuilt, which the shared observer is exactly for.
     */
    _watch() {
        if (!this.unwatchAdded) {
            this.unwatchAdded = domObserver.register('MarketplaceBadge', () => this._attach(), { debounce: true });
        }
        this._attach();
    }

    /**
     * The badge element, looked up once and kept until the sidebar rebuilds it.
     * @returns {HTMLElement|null}
     */
    _badge() {
        if (!this.badge?.isConnected) {
            this.badge = document.querySelector(BADGE);
        }
        return this.badge;
    }

    /** Point the scoped observer at the badge currently on screen */
    _attach() {
        const badge = this._badge();
        if (!badge) return;

        // Scoped to the badge's own box rather than the whole sidebar: every
        // other sidebar item's text churn would otherwise call `_paint`
        const holder = countHolder(badge);
        if (this.watchedHolder !== holder) {
            this.textWatcher?.disconnect();
            this.textWatcher = new MutationObserver(() => this._paint());
            this.textWatcher.observe(holder, { childList: true, subtree: true, characterData: true });
            this.watchedHolder = holder;
        }
        this._paint();
    }

    _stopWatching() {
        this.unwatchAdded?.();
        this.unwatchAdded = null;
        this.textWatcher?.disconnect();
        this.textWatcher = null;
        this.watchedHolder = null;
        this.badge = null;
    }

    disable() {
        this.unregister?.();
        this.unregister = null;
        this._stopWatching();
        removeStyles(STYLE_ID);
        this.hidden = false;
        this.showing = null;
        this.lastFinishedCount = null;
        // The book is per-character. Left behind, the previous character's
        // listings are what `book()` falls back to while the new one's own copy
        // is still empty — badging a sidebar for orders that are not theirs
        this.lastSeen = null;
        this.isInitialized = false;
    }
}

const marketplaceBadgeFilter = new MarketplaceBadgeFilter();
export default marketplaceBadgeFilter;
