/**
 * Overbid Panel
 *
 * A small floating, minimizable table of the listings of yours that are
 * currently beaten: a sell listing with a cheaper ask in front of it, or a buy
 * order with a higher bid in front of it. Each row names the item (a link to
 * its market page at the right enhancement level), the side, the price that
 * beats you and your own price. It is an extra view beside the toast alert,
 * which stays as it was.
 *
 * ## Where "beaten" comes from
 *
 * The same comparison the Market Undercut Alerts make, and the same data: your
 * active `myMarketListings` against the freshest best ask (sell) or best bid
 * (buy) the marketplace cache holds, judged by `listingBeaten`. A figure older
 * than the cache window, or no figure at all, is unknown and shows nothing.
 * The panel adds no fetching of its own; it recomputes on the events that move
 * either half (`market_listings_updated`, `character_initialized`, a
 * marketplace cache refresh) and, while open, on the panel shell's redraw
 * timer, which only reads memory.
 *
 * One refinement over the alert: if another active listing of yours sits at a
 * price that matches or beats the market's, you are only beating yourself and
 * the row is left out.
 *
 * ## Showing and hiding
 *
 * The panel opens by itself when a listing becomes beaten that it has not
 * already told you about, and closes when nothing is beaten. Closing it with
 * its X keeps it away until a different listing is beaten. Position and the
 * minimized fold are remembered by the shared panel shell.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import localMarketUndercutAlerts from '../notifications/market-undercut-alerts.js';
import { marketUndercutAlerts as liveMarketUndercutAlerts } from '../../utils/bundle-bridge.js';
import { listingBeaten } from '../notifications/notification-predicates.js';
import { createPanel, panelNote } from '../../utils/simple-panel.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { formatKMB3Digits } from '../../utils/formatters.js';

/** Master switch for the panel */
export const SETTING = 'market_overbidPanel';

const PANEL_ID = 'overbidPanel';
/** How often the memory-only comparison is redone, so expired figures drop off */
const RECHECK_MS = 5000;
/** Wait this long for a burst of listing messages to settle before asking for sightings */
const SIGHTING_DEBOUNCE_MS = 2000;
/** The price history setting is the opt-in that lets the pooled dataset be consulted */
const POOLED_SETTING = 'market_pooledHistory';
const ACTIVE_STATUS = '/market_listing_status/active';
const ACCENT = '#ff8f6b';
const MUTED = 'rgba(232, 236, 245, 0.55)';

/**
 * Which of the given listings are beaten right now.
 *
 * @param {Object[]} listings - Listings as the game sends them (`id`, `status`, `isSell`, `itemHrid`,
 *   `enhancementLevel`, `price`)
 * @param {(itemHrid: string, level: number, isSell: boolean) => ({price: number, timestamp: number}|null)} observe -
 *   The freshest figure for the side of the book that matters
 * @param {number} now - Current time in ms
 * @param {number} maxAgeMs - How old a figure may be and still count
 * @returns {Array<{id: *, itemHrid: string, enhancementLevel: number, isSell: boolean, price: number,
 *   bestPrice: number, ageMs: number}>} Beaten listings, in the order given
 */
export function findBeatenListings(listings, observe, now, maxAgeMs) {
    return classifyListings(listings, observe, now, maxAgeMs).beaten;
}

/**
 * Sort the active listings into beaten, settled and unknown.
 *
 * `settled` holds the ids that fresh evidence shows competitive (or only behind
 * your own order); a listing with no usable figure is in neither set, because an
 * unknown price proves nothing in either direction.
 *
 * @param {Object[]} listings - Listings as the game sends them
 * @param {Function} observe - See {@link findBeatenListings}
 * @param {number} now - Current time in ms
 * @param {number} maxAgeMs - How old a figure may be and still count
 * @returns {{beaten: ReturnType<typeof findBeatenListings>, settled: Set<*>, activeIds: Set<*>}}
 */
export function classifyListings(listings, observe, now, maxAgeMs) {
    const active = (listings || []).filter((listing) => listing?.status === ACTIVE_STATUS && listing.itemHrid);
    const beaten = [];
    const settled = new Set();
    const activeIds = new Set(active.map((listing) => listing.id));

    for (const listing of active) {
        const level = listing.enhancementLevel || 0;
        const isSell = listing.isSell === true;
        const observation = observe(listing.itemHrid, level, isSell);
        if (!observation) continue;

        const ageMs = now - observation.timestamp;
        const { fire } = listingBeaten({
            armed: true,
            isSell,
            listingPrice: listing.price,
            bestPrice: observation.price,
            priceAgeMs: ageMs,
            maxPriceAgeMs: maxAgeMs,
        });
        if (!fire) {
            const usable = Number.isFinite(ageMs) && ageMs <= maxAgeMs && Number.isFinite(observation.price);
            if (usable) settled.add(listing.id);
            continue;
        }

        // The price in front of you is another listing of yours: not a rival
        const beatenByYourself = active.some(
            (other) =>
                other !== listing &&
                other.itemHrid === listing.itemHrid &&
                (other.enhancementLevel || 0) === level &&
                (other.isSell === true) === isSell &&
                (isSell ? other.price <= observation.price : other.price >= observation.price)
        );
        if (beatenByYourself) {
            settled.add(listing.id);
            continue;
        }

        beaten.push({
            id: listing.id,
            itemHrid: listing.itemHrid,
            enhancementLevel: level,
            isSell,
            price: listing.price,
            bestPrice: observation.price,
            ageMs,
        });
    }

    return { beaten, settled, activeIds };
}

/**
 * The beaten listings from the live data.
 * @returns {ReturnType<typeof findBeatenListings>}
 */
export function currentBeatenListings() {
    return currentClassification().beaten;
}

/**
 * The initialized alerts singleton; this bundle's own import is only the dev-build fallback.
 * @returns {Object}
 */
function undercutAlerts() {
    return liveMarketUndercutAlerts() || localMarketUndercutAlerts;
}

/**
 * Classify the live listings against the current figures.
 * @returns {ReturnType<typeof classifyListings>}
 */
function currentClassification() {
    return classifyListings(
        dataManager.getMarketListings(),
        (itemHrid, level, isSell) => undercutAlerts().sideObservation(itemHrid, level, isSell),
        Date.now(),
        marketAPI.CACHE_DURATION
    );
}

/**
 * The item's display name with its enhancement level.
 * @param {{itemHrid: string, enhancementLevel: number}} row - A beaten listing
 * @returns {string}
 */
function rowLabel(row) {
    const name = dataManager.getItemDetails(row.itemHrid)?.name || row.itemHrid;
    return row.enhancementLevel > 0 ? `${name} +${row.enhancementLevel}` : name;
}

/**
 * Draw the table into a panel body.
 * @param {HTMLElement} body - Panel body
 * @param {Object[]} rows - Beaten listings
 */
export function drawOverbidTable(body, rows) {
    if (!rows.length) {
        body.appendChild(panelNote('Nothing of yours is overbid right now.'));
        return;
    }

    const table = document.createElement('table');
    table.dataset.overbidTable = 'true';
    Object.assign(table.style, { width: '100%', borderCollapse: 'collapse' });

    const head = table.createTHead().insertRow();
    for (const text of ['Item', 'Side', 'Overbid price', 'Your price']) {
        const cell = document.createElement('th');
        cell.textContent = text;
        Object.assign(cell.style, {
            textAlign: text === 'Item' || text === 'Side' ? 'left' : 'right',
            color: MUTED,
            fontWeight: 'normal',
            padding: '2px 6px',
        });
        head.appendChild(cell);
    }

    const tbody = table.createTBody();
    for (const row of rows) {
        const tr = tbody.insertRow();
        tr.dataset.listingId = String(row.id);

        const nameCell = tr.insertCell();
        const link = document.createElement('a');
        link.textContent = rowLabel(row);
        link.href = '#';
        link.dataset.itemHrid = row.itemHrid;
        link.dataset.enhancementLevel = String(row.enhancementLevel);
        link.title = 'Open this item on the marketplace';
        Object.assign(link.style, { color: ACCENT, textDecoration: 'underline', cursor: 'pointer' });
        link.addEventListener('click', (event) => {
            event.preventDefault();
            navigateToMarketplace(row.itemHrid, row.enhancementLevel);
        });
        nameCell.appendChild(link);

        tr.insertCell().textContent = row.isSell ? 'Sell' : 'Buy';
        const best = tr.insertCell();
        best.textContent = formatKMB3Digits(row.bestPrice);
        best.title = String(row.bestPrice);
        const yours = tr.insertCell();
        yours.textContent = formatKMB3Digits(row.price);
        yours.title = String(row.price);
        best.style.textAlign = 'right';
        yours.style.textAlign = 'right';

        for (const cell of tr.cells) cell.style.padding = '2px 6px';
    }

    body.appendChild(table);
}

class OverbidPanel {
    constructor() {
        this.cleanup = createCleanupRegistry();
        this.panel = null;
        /** The beaten listings from the last update; the panel draws from this */
        this.rows = [];
        /** Listing ids already announced (and not since resolved), so a dismissed panel stays dismissed */
        this.announced = new Set();
        this.isInitialized = false;
        this.generation = 0;
        this.sightingTimer = null;
        /** `itemHrid:level` keys already asked for, so an unknown item is not asked for again */
        this.requestedSightings = new Set();
    }

    /**
     * Start watching listings and prices.
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING)) return;
        this.isInitialized = true;

        this.panel = createPanel({
            id: PANEL_ID,
            title: 'Overbid table',
            size: { width: 400, height: 220 },
            accent: ACCENT,
            draw: (body) => {
                const note = document.createElement('div');
                note.textContent = 'Your items have been overbid';
                note.style.color = MUTED;
                body.appendChild(note);
                drawOverbidTable(body, this.rows);
            },
        });

        const handler = () => this.update();
        const listingsHandler = () => {
            this.update();
            this.requestMissingSightings();
        };
        dataManager.on('character_initialized', handler);
        dataManager.on('market_listings_updated', listingsHandler);
        marketAPI.on(handler);
        this.cleanup.registerCleanup(() => {
            dataManager.off('character_initialized', handler);
            dataManager.off('market_listings_updated', listingsHandler);
            marketAPI.off(handler);
        });

        // An observation ages out without any event announcing it; reading memory is cheap
        this.cleanup.registerInterval(setInterval(handler, RECHECK_MS), 'overbidPanel:recheck');

        const switching = () => this.disable();
        dataManager.on('character_switching', switching);
        this.cleanup.registerCleanup(() => dataManager.off('character_switching', switching));

        this.update();
    }

    /**
     * Ask for pooled sightings of items that have none yet, after a listing change.
     *
     * Debounced so a burst of listing messages makes one refresh, and each item is asked for at most once
     * per session (an item the pooled dataset does not know would otherwise be asked for on every message).
     * The refresh itself is the shared one: it skips itself unless pooled history is on, reuses the history
     * client's cache, and does not overlap itself.
     */
    requestMissingSightings() {
        if (!config.getSetting(POOLED_SETTING)) return;
        const alerts = undercutAlerts();
        const missing = alerts.distinctActiveItems().filter((item) => {
            const key = `${item.itemHrid}:${item.enhancementLevel}`;
            return !alerts.mooketObservations.has(key) && !this.requestedSightings.has(key);
        });
        if (!missing.length || this.sightingTimer !== null) return;
        this.scheduleSightingRefresh(this.generation);
    }

    /**
     * Schedule the debounced refresh. An item counts as requested only once a refresh that includes it has
     * actually started: a refresh already in flight captured its item list earlier and would skip a newer
     * item, so the call waits for it to settle and goes again.
     * @param {number} generation - The session this was scheduled in
     */
    scheduleSightingRefresh(generation) {
        this.sightingTimer = this.cleanup.scheduleTimeout(
            async () => {
                this.sightingTimer = null;
                if (generation !== this.generation) return;
                const alerts = undercutAlerts();
                if (alerts.mooketRefreshInFlight) {
                    this.scheduleSightingRefresh(generation);
                    return;
                }
                for (const item of alerts.distinctActiveItems()) {
                    this.requestedSightings.add(`${item.itemHrid}:${item.enhancementLevel}`);
                }
                try {
                    await alerts.refreshMooketObservations();
                } catch (error) {
                    console.error('[OverbidPanel] Refreshing pooled sightings failed:', error);
                }
                if (generation === this.generation) this.update();
            },
            SIGHTING_DEBOUNCE_MS,
            'overbidPanel:sightings'
        );
    }

    /**
     * Recompute who is beaten and show, refresh or hide the panel.
     */
    update() {
        if (!this.isInitialized || !this.panel) return;
        let classification;
        try {
            classification = currentClassification();
            this.rows = classification.beaten;
        } catch (error) {
            console.error('[OverbidPanel] Checking listings failed:', error);
            return;
        }

        const ids = new Set(this.rows.map((row) => row.id));
        // Forgotten only when the listing is gone or fresh evidence shows it competitive again, so being
        // beaten again is news. A figure gone stale or unknown proves nothing and must not reset a dismissal.
        for (const id of this.announced) {
            if (!classification.activeIds.has(id) || classification.settled.has(id)) this.announced.delete(id);
        }

        if (!this.rows.length) {
            this.panel.hide({ remember: false });
            return;
        }

        this.panel.setTitle(`Overbid table (${this.rows.length})`);
        const fresh = this.rows.some((row) => !this.announced.has(row.id));
        for (const id of ids) this.announced.add(id);

        if (this.panel.isOpen()) {
            this.panel.render();
        } else if (fresh) {
            this.panel.show({ remember: false });
        }
    }

    /**
     * Tear everything down.
     */
    disable() {
        this.cleanup.cleanupAll();
        this.panel?.destroy();
        this.panel = null;
        this.rows = [];
        this.announced.clear();
        this.requestedSightings.clear();
        this.sightingTimer = null;
        this.generation += 1;
        this.isInitialized = false;
    }
}

const overbidPanel = new OverbidPanel();

config.onSettingChange(SETTING, (value) => {
    if (value) {
        overbidPanel.initialize();
    } else {
        overbidPanel.disable();
    }
});

export default overbidPanel;
