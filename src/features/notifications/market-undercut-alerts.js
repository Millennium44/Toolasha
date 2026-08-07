/**
 * Market Undercut Alerts
 *
 * Says so when a sell listing of yours is no longer the best ask — someone has
 * posted cheaper, and your listing sits behind theirs until you reprice — and
 * symmetrically when a buy order of yours is no longer the best bid.
 *
 * ## Where the comparison comes from
 *
 * Your side is the game's own `myMarketListings`, kept current by the data
 * manager on every `market_listings_updated`; only listings the server calls
 * active are compared, because a filled or cancelled listing has no price to
 * defend. The market's side is the marketplace API cache — the API snapshot
 * patched by any order book you have opened since — which is honest about one
 * thing this feature must be honest about too: it can be up to fifteen minutes
 * old. So every message carries the age of the figure it used, a figure older
 * than the cache's own validity window proves nothing and fires nothing, and an
 * item with no cached price at all is unknown rather than undercut.
 *
 * ## Repeats
 *
 * One armed bit per listing (the `listingBeaten` predicate) makes each undercut
 * one event: the bit disarms on the first announcement and re-arms only when
 * the situation resolves — you reprice, or the undercutter's stock sells out
 * and your price is best again — or when you edit the listing, which resets its
 * state entirely. The event key carries the listing id, so the service's
 * cooldown throttles each listing separately and a noisy market cannot spend
 * one listing's silence on another's news.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import notificationService from './notification-service.js';
import { listingBeaten } from './notification-predicates.js';
import { formatKMB3Digits, formatRelativeTime } from '../../utils/formatters.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';

/** Master switch; nothing below it is consulted while this is off */
export const MASTER_SETTING = 'notifications_marketListingUndercut';

/** The status HRID the server puts on a listing that is still on the board */
const ACTIVE_STATUS = '/market_listing_status/active';

class MarketUndercutAlerts {
    constructor() {
        /** listingId → {armed, price}; price so an edit is seen as a fresh start */
        this.listingStates = new Map();
        this.unregisterHandlers = [];
        this.characterSwitchingHandler = null;
        /** Holds the active-refresh interval so cleanup can clear it */
        this.timers = createTimerRegistry();
        /** True while a forced refresh is in flight, so an overlapping tick is skipped */
        this.refreshInFlight = false;
    }

    /**
     * Start watching listings and prices.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (!config.getSetting(MASTER_SETTING)) {
            return;
        }

        const handler = () => {
            try {
                this.check();
            } catch (error) {
                console.error('[MarketUndercutAlerts] Checking listings failed:', error);
            }
        };

        // Both halves of the comparison can move: the listings on a market
        // message, the prices on an API refresh or an opened order book
        dataManager.on('character_initialized', handler);
        dataManager.on('market_listings_updated', handler);
        this.unregisterHandlers.push(() => {
            dataManager.off('character_initialized', handler);
            dataManager.off('market_listings_updated', handler);
        });

        marketAPI.on(handler);
        this.unregisterHandlers.push(() => marketAPI.off(handler));

        this.characterSwitchingHandler = () => {
            this.disable();
        };
        dataManager.on('character_switching', this.characterSwitchingHandler);

        this.startActiveRefresh();
    }

    /**
     * Keep the market snapshot from going stale on a timer while alerts are on.
     *
     * Without this, nothing calls `marketAPI.fetch()` after startup, so the bulk
     * snapshot goes stale and the only fresh per-item price is the order-book
     * patch that lands when the player opens an item's view. An undercut that
     * happened hours ago against an item never opened would then read as "still
     * best" against the stale snapshot.
     *
     * The cadence is the market cache's own 15-minute window, and the tick calls
     * the *cache-respecting* `marketAPI.fetch()` — not the forcing `fetch(true)`.
     * That is the crucial politeness: `marketplace.json` is rate-limited by the
     * game (a burst of requests, often several userscripts at once, trips a
     * temporary CloudFront 403), so this must never pull faster than the cache
     * would on its own. A tick whose cache is still valid returns the cached copy
     * with no network hit and simply re-notifies listeners; only a tick that
     * finds the cache expired makes a real request — at most one per 15 minutes.
     * There is deliberately no shorter, configurable interval.
     */
    startActiveRefresh() {
        const intervalId = setInterval(() => {
            this.refreshSnapshot();
        }, marketAPI.CACHE_DURATION);
        this.timers.registerInterval(intervalId);
    }

    /**
     * Refresh the snapshot through the cache, skipping the tick if one is in flight.
     *
     * Uses the cache-respecting `fetch()`: it only touches the network when the
     * 15-minute cache has expired, so it can never contribute to rate-limiting
     * beyond what the cache already permits.
     */
    async refreshSnapshot() {
        if (this.refreshInFlight) {
            // A previous fetch has not settled; do not stack a second one
            return;
        }

        this.refreshInFlight = true;
        try {
            await marketAPI.fetch();
        } catch (error) {
            console.error('[MarketUndercutAlerts] Market snapshot refresh failed:', error);
        } finally {
            this.refreshInFlight = false;
        }
    }

    /**
     * The cached market figure for an item, dated.
     *
     * `getPrice` prefers an order-book patch over the API snapshot when the
     * patch is fresher, but returns only the prices — so the same choice is
     * mirrored here to recover the timestamp of whichever source it used. An
     * observation that cannot be dated is returned as no observation at all:
     * a figure of unknown age cannot honestly be called evidence.
     *
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @returns {{ask: number|null, bid: number|null, timestamp: number}|null} Prices and when they were true
     */
    priceObservation(itemHrid, enhancementLevel) {
        const price = marketAPI.getPrice(itemHrid, enhancementLevel);
        if (!price) {
            return null;
        }

        const patch = marketAPI.pricePatchs?.[`${itemHrid}:${enhancementLevel}`];
        const usedPatch =
            !!patch && typeof patch.timestamp === 'number' && patch.timestamp > marketAPI.lastFetchTimestamp;
        const timestamp = usedPatch ? patch.timestamp : marketAPI.lastFetchTimestamp;
        if (!Number.isFinite(timestamp)) {
            return null;
        }

        return { ask: price.ask, bid: price.bid, timestamp };
    }

    /**
     * Compare every active listing against the market, and say what changed.
     */
    check() {
        if (!config.getSetting(MASTER_SETTING)) return;

        const listings = dataManager.getMarketListings().filter((listing) => listing?.status === ACTIVE_STATUS);
        const seen = new Set();

        for (const listing of listings) {
            if (listing.id === undefined || listing.id === null) continue;
            seen.add(listing.id);
            this.evaluateListing(listing);
        }

        // A listing that left the board — filled, cancelled, expired — takes
        // its state with it; the id will never be seen again
        for (const id of this.listingStates.keys()) {
            if (!seen.has(id)) this.listingStates.delete(id);
        }
    }

    /**
     * Run one listing through the predicate and announce a firing.
     * @param {Object} listing - An active listing from `myMarketListings`
     */
    evaluateListing(listing) {
        let state = this.listingStates.get(listing.id);
        if (!state || state.price !== listing.price) {
            // New to us, or repriced — either way the player has acted since
            // anything was last said, so a fresh undercut is fresh news
            state = { armed: true, price: listing.price };
            this.listingStates.set(listing.id, state);
        }

        const observation = this.priceObservation(listing.itemHrid, listing.enhancementLevel || 0);
        const bestPrice = observation ? (listing.isSell ? observation.ask : observation.bid) : null;
        const priceAgeMs = observation ? Date.now() - observation.timestamp : null;

        const { fire, armed } = listingBeaten({
            armed: state.armed,
            isSell: listing.isSell === true,
            listingPrice: listing.price,
            bestPrice,
            priceAgeMs,
            maxPriceAgeMs: marketAPI.CACHE_DURATION,
        });
        state.armed = armed;
        if (!fire) return;

        notificationService.notify(`market-undercut-${listing.id}`, this.buildMessage(listing, bestPrice, priceAgeMs), {
            title: listing.isSell ? 'Listing undercut' : 'Buy order outbid',
        });
    }

    /**
     * The message, carrying both prices and the age of the market figure.
     *
     * The age is the honesty clause: the figure can be up to fifteen minutes
     * old, and "ask now 274K" without saying *when* would claim a precision the
     * cache does not have.
     *
     * @param {Object} listing - The beaten listing
     * @param {number} bestPrice - The price that beat it
     * @param {number} priceAgeMs - How old that figure is
     * @returns {string} What to tell the player
     */
    buildMessage(listing, bestPrice, priceAgeMs) {
        const baseName = dataManager.getItemDetails(listing.itemHrid)?.name || listing.itemHrid;
        const level = listing.enhancementLevel || 0;
        const itemName = level > 0 ? `${baseName} +${level}` : baseName;
        const age = priceAgeMs < 60000 ? 'as of just now' : `as of ~${formatRelativeTime(priceAgeMs)} ago`;
        const best = formatKMB3Digits(bestPrice);
        const yours = formatKMB3Digits(listing.price);

        if (listing.isSell) {
            return `${itemName} sell listing undercut: ask now ${best} (${age}), your listing ${yours}.`;
        }
        return `${itemName} buy order outbid: bid now ${best} (${age}), your order ${yours}.`;
    }

    /**
     * Cleanup
     */
    disable() {
        if (this.characterSwitchingHandler) {
            dataManager.off('character_switching', this.characterSwitchingHandler);
            this.characterSwitchingHandler = null;
        }

        this.unregisterHandlers.forEach((unregister) => unregister());
        this.unregisterHandlers = [];
        this.listingStates.clear();
        this.timers.clearAll();
        this.refreshInFlight = false;
    }
}

const marketUndercutAlerts = new MarketUndercutAlerts();

export default marketUndercutAlerts;
