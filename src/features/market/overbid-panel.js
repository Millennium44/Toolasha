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
 * As in the alert: if another active listing of yours sits at a price that
 * matches or beats the market's, or the market's figure is your own listing
 * read back at the band's edge, you are only beating yourself and the row is
 * left out.
 *
 * ## Showing and hiding
 *
 * The panel opens by itself when a listing becomes beaten that it has not
 * already told you about, and closes when nothing is beaten. Closing it with
 * its X keeps it away until a different listing is beaten. Position and the
 * minimized fold are remembered by the shared panel shell.
 *
 * ## Hiding an item
 *
 * Each row has a small control that hides it. What is hidden is the item at its enhancement level on one
 * side (sell or buy), not a listing id, so cancelling and relisting while flipping stays hidden. Hidden
 * rows are not counted, never open the panel and are not part of a dismissal; "Show hidden" draws them
 * dimmed with a control to bring each back. The set is remembered per character, and a key is forgotten
 * only when the full listings snapshot at login shows no active listing of that item, level and side.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import storage from '../../core/storage.js';
import marketAPI from '../../api/marketplace.js';
import localMarketUndercutAlerts from '../notifications/market-undercut-alerts.js';
import { marketUndercutAlerts as liveMarketUndercutAlerts } from '../../utils/bundle-bridge.js';
import { beatenByOwnListing, listingBeaten } from '../notifications/notification-predicates.js';
import { createPanel, panelNote } from '../../utils/simple-panel.js';
import { navigateToMarketplace, visibleTabsContainer, insertTabInOrder } from '../../utils/marketplace-tabs.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { formatKMB3Digits } from '../../utils/formatters.js';
import { clampToBand } from '../../utils/market-values.js';

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
/** Most hidden keys remembered per character; the oldest go first */
const MAX_HIDDEN = 200;
const HIDDEN_STORE = 'settings';

/**
 * What hiding is keyed on: the item at its level on one side, so a relisting stays hidden.
 * @param {{itemHrid: string, enhancementLevel?: number, isSell?: boolean}} row - A beaten listing
 * @returns {string}
 */
export function hiddenKey(row) {
    return `${row.itemHrid}:${row.enhancementLevel || 0}:${row.isSell === true ? 'sell' : 'buy'}`;
}

/**
 * Where a character's hidden keys are kept.
 * @param {string} owner - Character id
 * @returns {string}
 */
function hiddenStorageKey(owner) {
    return `overbidPanel_hidden_${owner}`;
}

/**
 * Who the hidden set belongs to.
 * @returns {string} Character id, or `'default'` before login
 */
function currentOwner() {
    return dataManager.getCurrentCharacterId?.() || 'default';
}

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
 * @param {(price: number, itemHrid: string, level: number) => number|null} [clamp] - The band clamp the
 *   figures went through, so a listing's raw price can be matched against them; identity when omitted
 * @returns {{beaten: ReturnType<typeof findBeatenListings>, settled: Set<*>, activeIds: Set<*>,
 *   unknown: number}} `unknown` counts active listings with no usable figure
 */
export function classifyListings(listings, observe, now, maxAgeMs, clamp = (price) => price) {
    const active = (listings || []).filter((listing) => listing?.status === ACTIVE_STATUS && listing.itemHrid);
    const beaten = [];
    const settled = new Set();
    const activeIds = new Set(active.map((listing) => listing.id));
    let unknown = 0;

    for (const listing of active) {
        const level = listing.enhancementLevel || 0;
        const isSell = listing.isSell === true;
        const observation = observe(listing.itemHrid, level, isSell);
        if (!observation) {
            unknown += 1;
            continue;
        }

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
            else unknown += 1;
            continue;
        }

        // The price in front of you is another listing of yours, or this one read back at the band's edge:
        // not a rival
        if (beatenByOwnListing(listing, active, observation.price, clamp)) {
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

    return { beaten, settled, activeIds, unknown };
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
        marketAPI.CACHE_DURATION,
        (price, itemHrid, level) => clampToBand(price, itemHrid, level, { foreign: marketAPI.liveSourced })
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
 * @param {Object[]} rows - Beaten listings to show (the ones not hidden)
 * @param {number} [unknown] - Active listings that could not be checked for lack of fresh data
 * @param {Object} [options] - Hiding support; omitted, the table is drawn as before with no controls
 * @param {Object[]} [options.hiddenRows] - Beaten listings the player hid
 * @param {boolean} [options.showHidden] - Draw the hidden rows (dimmed) too
 * @param {(row: Object) => void} [options.onHide] - Called with a row whose hide control was pressed
 * @param {(row: Object) => void} [options.onUnhide] - Called with a hidden row whose unhide control was pressed
 * @param {() => void} [options.onToggleHidden] - Called when the show/hide-hidden line is pressed
 */
export function drawOverbidTable(body, rows, unknown = 0, options = {}) {
    const hiddenRows = options.hiddenRows || [];
    const showHidden = options.showHidden === true && hiddenRows.length > 0;

    if (hiddenRows.length > 0) {
        const toggle = document.createElement('a');
        toggle.href = '#';
        toggle.dataset.overbidToggleHidden = 'true';
        toggle.textContent = showHidden ? 'Hide hidden' : `Show hidden (${hiddenRows.length})`;
        Object.assign(toggle.style, { color: ACCENT, textDecoration: 'underline', cursor: 'pointer' });
        toggle.addEventListener('click', (event) => {
            event.preventDefault();
            options.onToggleHidden?.();
        });
        const line = document.createElement('div');
        line.appendChild(toggle);
        body.appendChild(line);
    }
    if (unknown > 0) {
        body.appendChild(
            panelNote(
                `Price data is old or missing for ${unknown} of your listings, so ${unknown === 1 ? 'it' : 'they'} could not be checked.`
            )
        );
    }
    const drawn = showHidden ? [...rows, ...hiddenRows] : rows;
    if (!drawn.length) {
        body.appendChild(
            panelNote(hiddenRows.length ? 'All overbid items are hidden.' : 'Nothing is undercut or outbid right now.')
        );
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
    for (const row of drawn) {
        const isHidden = showHidden && hiddenRows.includes(row);
        const tr = tbody.insertRow();
        tr.dataset.listingId = String(row.id);
        if (isHidden) {
            tr.dataset.overbidHidden = 'true';
            tr.style.opacity = '0.5';
        }

        const nameCell = tr.insertCell();
        const onPress = isHidden ? options.onUnhide : options.onHide;
        if (onPress) {
            const control = document.createElement('span');
            control.setAttribute('role', 'button');
            control.dataset[isHidden ? 'overbidUnhide' : 'overbidHide'] = 'true';
            control.textContent = isHidden ? '↺' : '✕';
            control.title = isHidden ? 'Show this item in the table again' : 'Hide this item from the table';
            Object.assign(control.style, { color: MUTED, cursor: 'pointer', marginRight: '6px' });
            control.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                onPress(row);
            });
            nameCell.appendChild(control);
        }
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
        /** Beaten listings the player hid, as of the last update; not counted, not announced, not dismissed */
        this.hiddenRows = [];
        /** Hidden keys (see {@link hiddenKey}) of the character in {@link hiddenOwner}, oldest first */
        this.hidden = new Set();
        /** Whose hidden set is in memory; null until it has been loaded */
        this.hiddenOwner = null;
        /** Keys set or cleared by the player since the last storage read began; a prune never judges them */
        this.touchedKeys = new Set();
        /** Draw the hidden rows too. In memory only */
        this.showHidden = false;
        /** Listing ids the player closed the panel on, so they are not announced again until resolved */
        this.dismissed = new Set();
        /** Whether the panel is open because this module (or the button) opened it and has not seen it close */
        this.wasOpen = false;
        /** Opened on demand: stays open when nothing is beaten */
        this.manual = false;
        /** Active listings with no usable figure, as of the last update */
        this.unknown = 0;
        /** Every Overbid tab injected, one per tab strip: the popout and the full page can each mount one */
        this.openButtons = new Set();
        this.isInitialized = false;
        this.generation = 0;
        this.sightingTimer = null;
        /** `itemHrid:level` keys already asked for, so an unknown item is not asked for again */
        this.requestedSightings = new Set();
        /**
         * The character whose hidden keys were last pruned against a login snapshot. Kept through
         * `disable()`, so turning the setting off and on again mid-session does not prune a temporarily
         * canceled listing's hide, while the first start after switching to another character still does.
         */
        this.prunedOwner = null;
        /** Whether the login watch below is attached; it outlives `disable()` on purpose */
        this.loginWatch = false;
    }

    /**
     * Forget the prune marker on every login, including those that happen while the panel is turned
     * off, so the next start for a character that logged in again prunes against its fresh listings.
     * Attached once and never removed.
     */
    watchLogins() {
        if (this.loginWatch) return;
        this.loginWatch = true;
        dataManager.on('character_initialized', () => {
            this.prunedOwner = null;
        });
    }

    /**
     * Start watching listings and prices.
     * @returns {Promise<void>}
     */
    async initialize() {
        this.watchLogins();
        if (this.isInitialized) return;
        if (!config.getSetting(SETTING)) return;
        this.isInitialized = true;

        this.panel = createPanel({
            id: PANEL_ID,
            title: 'Overbid table',
            size: { width: 400, height: 220 },
            accent: ACCENT,
            draw: (body) => {
                drawOverbidTable(body, this.rows, this.unknown, {
                    hiddenRows: this.hiddenRows,
                    showHidden: this.showHidden,
                    onHide: (row) => this.setHidden(row, true),
                    onUnhide: (row) => this.setHidden(row, false),
                    onToggleHidden: () => {
                        this.showHidden = !this.showHidden;
                        this.panel?.render();
                    },
                });
            },
        });

        const handler = () => this.update();
        const loginHandler = async () => {
            const generation = this.generation;
            // Judged against the listings as they stand now, not as they stand once the read returns
            const live = this.liveHiddenKeys();
            const loaded = await this.loadHidden();
            if (generation !== this.generation) return;
            this.pruneHidden(live, loaded, this.liveHiddenKeys());
            this.prunedOwner = this.hiddenOwner;
            this.update();
        };
        const listingsHandler = () => {
            this.update();
            this.requestMissingSightings();
        };
        dataManager.on('character_initialized', loginHandler);
        dataManager.on('market_listings_updated', listingsHandler);
        marketAPI.on(handler);
        this.cleanup.registerCleanup(() => {
            dataManager.off('character_initialized', loginHandler);
            dataManager.off('market_listings_updated', listingsHandler);
            marketAPI.off(handler);
        });

        // An observation ages out without any event announcing it; reading memory is cheap
        // Turning pooled history on mid-session should fetch the missing sightings without waiting for a listing event
        // Marks made under an earlier setting say nothing about the observations now held, so a change forgets them
        const offPooled = config.onSettingChange(POOLED_SETTING, () => {
            this.requestedSightings.clear();
            this.requestMissingSightings();
        });
        this.cleanup.registerCleanup(() => offPooled?.());

        this.cleanup.registerInterval(setInterval(handler, RECHECK_MS), 'overbidPanel:recheck');

        this.addOpenButton();

        const switching = () => this.disable();
        dataManager.on('character_switching', switching);
        this.cleanup.registerCleanup(() => dataManager.off('character_switching', switching));
        this.update();
        const live = this.liveHiddenKeys();
        const loaded = await this.loadHidden();
        if (!this.isInitialized) return;
        // A start that follows a login (the registry may start this after `character_initialized` fired)
        // prunes once; a later start for the same character is a settings toggle and leaves the hides alone
        if (this.prunedOwner !== this.hiddenOwner) {
            this.pruneHidden(live, loaded, this.liveHiddenKeys());
            this.prunedOwner = this.hiddenOwner;
        }
        this.update();
    }

    /**
     * Read this character's hidden keys from storage. The character is captured before the read and checked
     * after it, so a read that resolves after a switch never lands on the new character.
     * @returns {Promise<string[]>} The keys read from storage (empty when the read failed or went stale),
     *   so a prune can judge only those and leave a hide made while the read was in flight alone
     */
    async loadHidden() {
        const owner = currentOwner();
        const generation = this.generation;
        this.touchedKeys.clear();
        try {
            const saved = await storage.get(hiddenStorageKey(owner), HIDDEN_STORE, []);
            if (generation !== this.generation || owner !== currentOwner()) return [];
            const keys = Array.isArray(saved) ? saved.filter((key) => typeof key === 'string') : [];
            // Anything hidden while the read was in flight is kept
            const merged = new Set([...keys, ...(this.hiddenOwner === owner ? this.hidden : [])]);
            this.hidden = new Set([...merged].slice(-MAX_HIDDEN));
            this.hiddenOwner = owner;
            return keys.filter((key) => !this.touchedKeys.has(key));
        } catch (error) {
            console.error('[OverbidPanel] Loading hidden items failed:', error);
            // Without a stored set the table still works; nothing is hidden
            if (generation === this.generation && owner === currentOwner() && this.hiddenOwner !== owner) {
                this.hidden = new Set();
                this.hiddenOwner = owner;
            }
            return [];
        }
    }

    /**
     * Write the hidden keys for the character they belong to.
     */
    saveHidden() {
        if (this.hiddenOwner === null) return;
        storage.set(hiddenStorageKey(this.hiddenOwner), [...this.hidden], HIDDEN_STORE, true);
    }

    /**
     * The hidden keys of every active listing right now, or null while the character's data has not loaded
     * (before that `getMarketListings()` is an empty list too, and proves nothing).
     * @returns {Set<string>|null}
     */
    liveHiddenKeys() {
        if (!dataManager.characterData) return null;
        const listings = dataManager.getMarketListings();
        if (!Array.isArray(listings)) return null;
        return new Set(listings.filter((l) => l?.status === ACTIVE_STATUS && l.itemHrid).map((l) => hiddenKey(l)));
    }

    /**
     * Forget stored hidden keys with no active listing left. `live` is the snapshot taken before the storage
     * read began and `loaded` the keys that read returned: only loaded keys are judged, so a hide made while the
     * read was in flight (no listing was ever checked for it) and a listing canceled during it are both safe.
     * A key is forgotten only when it is absent from the listings both before and after the read: a listing
     * relisted during the read would otherwise lose its restored hide. A null snapshot (data not loaded) on
     * either side prunes nothing; a loaded empty one prunes every loaded key.
     * @param {Set<string>|null} live - Active-listing keys at snapshot time
     * @param {string[]} loaded - Keys read from storage
     * @param {Set<string>|null} liveAfter - Active-listing keys once the read returned
     */
    pruneHidden(live, loaded, liveAfter) {
        if (!live || !liveAfter || !loaded?.length || this.hiddenOwner !== currentOwner()) return;
        let changed = false;
        for (const key of loaded) {
            if (this.hidden.has(key) && !live.has(key) && !liveAfter.has(key)) {
                this.hidden.delete(key);
                changed = true;
            }
        }
        if (changed) this.saveHidden();
    }

    /**
     * Hide or unhide an item and redraw. Not a dismissal.
     * @param {Object} row - A beaten listing
     * @param {boolean} hide - True to hide, false to bring back
     */
    setHidden(row, hide) {
        if (this.hiddenOwner === null) this.hiddenOwner = currentOwner();
        const key = hiddenKey(row);
        this.touchedKeys.add(key);
        if (hide) {
            this.hidden.delete(key);
            this.hidden.add(key);
            while (this.hidden.size > MAX_HIDDEN) this.hidden.delete(this.hidden.values().next().value);
        } else {
            this.hidden.delete(key);
        }
        this.saveHidden();
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
        const items = alerts.distinctActiveItems();
        // A listing that left takes its mark with it, so a relisting starts a fresh life
        const activeKeys = new Set(items.map((item) => `${item.itemHrid}:${item.enhancementLevel}`));
        for (const key of this.requestedSightings) if (!activeKeys.has(key)) this.requestedSightings.delete(key);
        const now = Date.now();
        const missing = items.filter((item) => {
            const key = `${item.itemHrid}:${item.enhancementLevel}`;
            const seen = alerts.mooketObservations.get(key);
            // An old sighting proves nothing, so it counts as missing
            const usable = seen && Number.isFinite(seen.timestamp) && now - seen.timestamp <= marketAPI.CACHE_DURATION;
            return !usable && !this.requestedSightings.has(key);
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
        // Until this character's hidden set is loaded nothing can be told apart from what the player hid
        if (!this.isInitialized || !this.panel || this.hiddenOwner !== currentOwner()) return;
        const shownRows = this.rows;
        let classification;
        try {
            classification = currentClassification();
            this.rows = classification.beaten.filter((row) => !this.hidden.has(hiddenKey(row)));
            this.hiddenRows = classification.beaten.filter((row) => this.hidden.has(hiddenKey(row)));
        } catch (error) {
            console.error('[OverbidPanel] Checking listings failed:', error);
            return;
        }

        this.unknown = classification.unknown;

        // Open before and closed now, and not by us: the player closed it, which is a dismissal of what it showed
        if (this.wasOpen && !this.panel.isOpen()) {
            this.wasOpen = false;
            this.manual = false;
            for (const row of shownRows) this.dismissed.add(row.id);
        }

        // Forgotten only when the listing is gone or fresh evidence shows it competitive again, so being
        // beaten again is news. A figure gone stale or unknown proves nothing and must not reset a dismissal,
        // and a panel that hid itself for want of fresh evidence was never dismissed.
        for (const id of this.dismissed) {
            if (!classification.activeIds.has(id) || classification.settled.has(id)) this.dismissed.delete(id);
        }

        if (!this.hiddenRows.length) this.showHidden = false;
        const hiddenNote = this.hiddenRows.length ? `, ${this.hiddenRows.length} hidden` : '';

        if (!this.rows.length) {
            this.panel.setTitle(this.hiddenRows.length ? `Overbid table (0${hiddenNote})` : 'Overbid table');
            // Open with only hidden rows left: stay open and offer them back rather than closing under the player
            if ((this.manual || this.hiddenRows.length) && this.panel.isOpen()) {
                this.panel.render();
            } else {
                this.wasOpen = false;
                this.panel.hide({ remember: false });
            }
            return;
        }

        this.panel.setTitle(`Overbid table (${this.rows.length}${hiddenNote})`);
        const fresh = this.rows.some((row) => !this.dismissed.has(row.id));

        if (this.panel.isOpen()) {
            this.panel.render();
        } else if (fresh) {
            this.panel.show({ remember: false });
            this.wasOpen = true;
        }
    }

    /**
     * Open the table on demand, whether or not anything is beaten. Not a dismissal, and the automatic
     * pop-up keeps working afterwards.
     */
    openNow() {
        if (!this.isInitialized || !this.panel) return;
        this.manual = true;
        this.update();
        if (!this.panel.isOpen()) this.panel.show({ remember: false });
        this.panel.expand();
        this.wasOpen = true;
        this.panel.render();
    }

    /**
     * What the tab does: close the table when it is open and showing, otherwise open or expand it. Closing
     * from the tab is the same as pressing X, so it dismisses the rows currently shown.
     */
    toggleFromTab() {
        if (!this.isInitialized || !this.panel) return;
        if (this.panel.isOpen() && !this.panel.isMinimized()) {
            for (const row of this.rows) this.dismissed.add(row.id);
            this.wasOpen = false;
            this.manual = false;
            this.panel.hide({ remember: false });
            return;
        }
        this.openNow();
    }

    /**
     * Keep a small "Overbid" tab in the marketplace tab strip that opens the table.
     *
     * Cloned from one of the game's own tabs, chosen by role and by not carrying one of our markers rather
     * than by its label; the strip itself is found by the shared `visibleTabsContainer`.
     */
    addOpenButton() {
        const ensure = () => {
            const container = visibleTabsContainer();
            if (!container) return;
            if (container.querySelector('[data-mwi-overbid-tab="true"]')) return;
            const reference = Array.from(container.querySelectorAll('[role="tab"]')).find(
                (tab) => !tab.matches('[data-mwi-custom-tab], [data-mwi-tab-key], [data-mwi-shrine-tab]')
            );
            if (!reference) return;

            const tab = reference.cloneNode(true);
            tab.setAttribute('data-mwi-overbid-tab', 'true');
            tab.setAttribute('data-mwi-custom-tab', 'true');
            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');
            const badge = tab.querySelector('[class*="TabsComponent_badge"]');
            if (badge) badge.textContent = 'Overbid';
            else tab.textContent = 'Overbid';
            tab.title = 'Show the listings of yours that are undercut or outbid';
            tab.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                this.toggleFromTab();
            });
            insertTabInOrder(container, tab);
            this.openButtons.add(tab);
        };

        const unwatch = createMutationWatcher(document.body, ensure, { childList: true, subtree: true });
        this.cleanup.registerCleanup(() => {
            unwatch();
            for (const injected of this.openButtons) injected.remove();
            this.openButtons.clear();
        });
        ensure();
    }

    /**
     * Tear everything down.
     */
    disable() {
        this.cleanup.cleanupAll();
        this.panel?.destroy();
        this.panel = null;
        this.rows = [];
        this.hiddenRows = [];
        this.hidden = new Set();
        this.hiddenOwner = null;
        this.touchedKeys = new Set();
        this.showHidden = false;
        this.dismissed.clear();
        this.wasOpen = false;
        this.manual = false;
        this.unknown = 0;
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
