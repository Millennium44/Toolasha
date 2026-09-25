/**
 * Market Volume Stats
 *
 * A small 1d/3d/5d trade-stats table pinned to the marketplace's current-item
 * card: average price, median price, volume, an estimated buy/sell split, and
 * the traded price range.
 *
 * Ported from the "交易量显示" (Trade Volume Display) userscript by baozhi &
 * SukiSukiDaiSuki (https://greasyfork.org/en/scripts/570243, CC-BY-NC-SA-4.0),
 * translated and adapted for Toolasha with permission of this fork's
 * maintainer. Its `showMarketDetail`/`renderMarketTable` supplied the panel
 * layout and column set; the arithmetic behind each column lives in
 * `../../utils/market-volume-stats-math.js` (see that module's doc comment for
 * where it deviates from the source). What was left behind, deliberately: the
 * source's own listing-time crowdsourcing (Toolasha already estimates listing
 * age), its `MessageEvent.prototype.data` hook and IndexedDB cache (this reads
 * through `market-history-api.js`, which already owns fetching, caching and
 * contributing to the pool), and free dragging (a fixed position is enough
 * here).
 *
 * Data comes from `market-history-api.js`, the same pooled-history client the
 * price-history chart panel (`mooket/index.js`) uses — same cache, same
 * back-off, same source selection — so this never opens a second connection to
 * the pool. It is gated the same way that panel is: nothing is fetched unless
 * the player has opted into `market_pooledHistory`.
 */

import config from '../../core/config.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import { createCleanupRegistry } from '../../utils/cleanup-registry.js';
import { formatKMB } from '../../utils/formatters.js';
import { GAME } from '../../utils/selectors.js';
import marketHistoryAPI from './mooket/market-history-api.js';
import { describeCooldown } from './mooket/market-history-data.js';
import { computeAllWindows, trimTrailingZeros } from '../../utils/market-volume-stats-math.js';
import { captureOwner, stillOurs, noteTeardown } from '../../utils/init-ownership.js';

/** How far back the one fetch that serves all three windows (1d/3d/5d) reaches */
const FETCH_DAYS = 5;

/** How long order-book DOM churn is gathered before recomputing the current item */
const UPDATE_DEBOUNCE_MS = 50;

/**
 * Follow-up delays (ms) for re-checking the current item after a fresh selection.
 *
 * Direct in-page navigation to an item (clicking it inside the marketplace's own
 * list, or `handleGoToMarketplace` landing on it) reuses the existing
 * `MarketplacePanel_currentItem` node and updates its enhancement-level badge text
 * in place rather than inserting new elements — `domObserver` only watches
 * `addedNodes`, so that settle never produces a mutation this module's observer
 * would see. A pop-out/tab view that paints the badge once on first mount has no
 * such gap, which is why only direct navigation showed the stall. These bounded
 * follow-up passes catch a badge that finishes settling after the first read.
 */
const SETTLE_CHECK_DELAYS_MS = [150, 400];

/** Where column visibility preferences are kept */
const COLUMN_PREFS_KEY = 'market_volumeStats_columns';

/** Row definitions: id, label, and how to read the two colors that key them into `computeAllWindows` output */
const COLUMNS = [
    { id: 'avgPrice', label: 'Average', color: '#FFD700', unit: 'price', read: (s) => s.avgPrice },
    { id: 'medianPrice', label: 'Median', color: '#FFA500', unit: 'price', read: (s) => s.medianPrice },
    { id: 'volume', label: 'Volume', color: '#87CEEB', unit: 'count', volumeDependent: true, read: (s) => s.volume },
    {
        id: 'buySell',
        label: 'Bought/Sold',
        color: '#90EE90',
        unit: 'count',
        volumeDependent: true,
        read: (s) => [s.buyVolume, s.sellVolume],
        pair: true,
    },
    {
        id: 'minMax',
        label: 'Min/Max',
        color: '#FFFF00',
        unit: 'price',
        read: (s) => [s.minPrice, s.maxPrice],
        pair: true,
    },
];
const DEFAULT_COLUMN_IDS = COLUMNS.map((c) => c.id);

/** Row label colors, one per window */
const ROW_COLORS = { 1: '#FF6B6B', 3: '#4ECDC4', 5: '#95E1D3' };

/**
 * `formatKMB` at 2 decimals, trimmed of trailing zeros the way the source's
 * `formatCompactNumber` trims theirs.
 * @param {number} value - A number to display compactly
 * @returns {string}
 */
function formatStat(value) {
    if (!Number.isFinite(value)) return '—';
    const formatted = formatKMB(value, 2);
    return formatted === null ? '—' : trimTrailingZeros(formatted);
}

class MarketVolumeStats {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        /** `${itemHrid}:${enhancementLevel}` the panel currently shows or is loading */
        this.currentKey = null;
        /** Bumped on every new selection and on disable(), so a stale fetch cannot render */
        this.generation = 0;
        /** Highest generation whose `fetchAndRender` has reached its `finally` — `< generation` means one is still in flight */
        this.settledGeneration = 0;
        /** Key whose fetch last reached a terminal render (table, status, or error) */
        this.loadedKey = null;
        this.updateTimer = null;
        /** Pending settle-check timers from `scheduleSettleChecks()` */
        this.settleTimers = new Set();
        this.visibleColumnIds = new Set(DEFAULT_COLUMN_IDS);
        this.columnPrefsLoaded = false;
    }

    /** @returns {boolean} Whether the panel may be shown at all */
    get enabled() {
        return config.getSetting('market_pooledHistory') === true && config.getSetting('market_volumeStats') === true;
    }

    /**
     * Whether the trade-stats overlay is showing (or would show, once an item is
     * selected) — the same two settings as `enabled`, exposed for
     * queue-length-estimator.js: its ask/bid counts collapse into one combined,
     * labeled group only while this overlay's icon-corner placement is the thing
     * they would otherwise flank.
     * @returns {boolean}
     */
    isPanelActive() {
        return this.enabled;
    }

    /**
     * React to either gating setting changing mid-session.
     *
     * The registry key this module is registered under (`marketVolumeStats`) has
     * no matching schema entry, so `config.isFeatureEnabled` always answers true
     * for it and the registry calls `initialize()` exactly once, at startup or on
     * a character switch. `initialize()` itself self-gates on `market_pooledHistory`
     * and `market_volumeStats` and returns early when either is off — which the
     * registry still counts as "started". Flipping Price History on afterward
     * never got a second call, so the table stayed off until a reload. This
     * listens for both settings directly instead of relying on the registry.
     */
    setupSettingListener() {
        const handleChange = () => {
            if (this.enabled) {
                this.initialize();
            } else if (this.isInitialized) {
                this.disable();
            }
        };
        config.onSettingChange('market_pooledHistory', handleChange);
        config.onSettingChange('market_volumeStats', handleChange);
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!this.enabled) return;

        // A character switch can tear this feature down while `loadColumnPrefs`
        // is still awaiting storage; the ticket makes sure a resumed tail does
        // not register into a cleanup registry the teardown already emptied.
        const ticket = captureOwner(this);
        await this.loadColumnPrefs();
        if (!stillOurs(ticket)) return;

        this.isInitialized = true;
        this.setupObserver();
        // The order book may already be open when the setting is turned on mid-session
        this.scheduleUpdate();
    }

    async loadColumnPrefs() {
        try {
            const saved = await storage.getJSON(COLUMN_PREFS_KEY, 'settings', null);
            if (Array.isArray(saved) && saved.length) {
                const known = new Set(DEFAULT_COLUMN_IDS);
                const sanitized = saved.filter((id) => known.has(id));
                if (sanitized.length) this.visibleColumnIds = new Set(sanitized);
            }
        } catch (error) {
            console.error('[MarketVolumeStats] Loading column preferences failed:', error);
        } finally {
            this.columnPrefsLoaded = true;
        }
    }

    async saveColumnPrefs() {
        try {
            await storage.setJSON(COLUMN_PREFS_KEY, [...this.visibleColumnIds]);
        } catch (error) {
            console.error('[MarketVolumeStats] Saving column preferences failed:', error);
        }
    }

    setupObserver() {
        const unregister = domObserver.onClass('MarketVolumeStats', 'MarketplacePanel_orderBooksContainer', () => {
            this.scheduleUpdate();
        });
        this.cleanupRegistry.registerCleanup(unregister);
    }

    scheduleUpdate() {
        if (this.updateTimer) return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = null;
            this.update();
        }, UPDATE_DEBOUNCE_MS);
        this.cleanupRegistry.registerCleanup(() => {
            clearTimeout(this.updateTimer);
            this.updateTimer = null;
        });
    }

    /** @returns {string|null} Item HRID currently open in the order book panel */
    getCurrentItemHrid() {
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const href = currentItemElement?.querySelector('use')?.href?.baseVal;
        return href ? '/items/' + href.split('#')[1] : null;
    }

    /** @returns {number} Enhancement level currently selected (0 for non-equipment) */
    getCurrentEnhancementLevel() {
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const match = currentItemElement
            ?.querySelector('[class*="Item_enhancementLevel"]')
            ?.textContent.match(/\+(\d+)/);
        return match ? parseInt(match[1], 10) : 0;
    }

    /** Re-derive the current item and (re)fetch/render if it changed */
    update() {
        if (!this.enabled) {
            this.removePanel();
            return;
        }

        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const itemHrid = this.getCurrentItemHrid();
        if (!currentItemElement || !itemHrid) {
            this.removePanel();
            this.currentKey = null;
            return;
        }

        const enhancementLevel = this.getCurrentEnhancementLevel();
        const key = `${itemHrid}:${enhancementLevel}`;
        if (key === this.currentKey) {
            this.attachPanel(currentItemElement);
            // A fetch for this key can have been discarded mid-flight (superseded by
            // another for the same key, e.g. a redundant retrigger racing a
            // "Refresh now") — nothing else would ever refetch it, and the panel
            // would sit on "Loading" forever. Refetch whenever the most recent fetch
            // has already settled without producing a render for this key.
            const fetchPending = this.settledGeneration < this.generation;
            if (!fetchPending && this.loadedKey !== key) {
                this.fetchAndRender(currentItemElement, itemHrid, enhancementLevel, key, false);
            }
            return;
        }

        this.currentKey = key;
        this.loadedKey = null;
        this.fetchAndRender(currentItemElement, itemHrid, enhancementLevel, key, false);
        this.scheduleSettleChecks();
    }

    /**
     * Re-run `update()` a couple more times shortly after a fresh selection, to
     * catch an enhancement-level badge that finishes rendering after the first
     * read (see `SETTLE_CHECK_DELAYS_MS`).
     */
    scheduleSettleChecks() {
        this.clearSettleChecks();
        for (const delay of SETTLE_CHECK_DELAYS_MS) {
            const timer = setTimeout(() => {
                this.settleTimers.delete(timer);
                this.update();
            }, delay);
            this.settleTimers.add(timer);
        }
    }

    /** Cancel any pending settle-check timers from `scheduleSettleChecks()` */
    clearSettleChecks() {
        for (const timer of this.settleTimers) clearTimeout(timer);
        this.settleTimers.clear();
    }

    /**
     * Force a refetch of the currently-shown item, bypassing the client cache.
     * Still respects the shared back-off — a cooling-down pool answers `null`
     * from `fetchHistory` exactly as an ordinary call would.
     */
    refresh() {
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        const itemHrid = this.getCurrentItemHrid();
        if (!currentItemElement || !itemHrid || !this.currentKey) return;
        const enhancementLevel = this.getCurrentEnhancementLevel();
        this.fetchAndRender(currentItemElement, itemHrid, enhancementLevel, this.currentKey, true);
    }

    async fetchAndRender(currentItemElement, itemHrid, enhancementLevel, key, force) {
        const generation = ++this.generation;
        const panel = this.attachPanel(currentItemElement);
        this.renderLoading(panel);

        try {
            const source = marketHistoryAPI.currentSource();
            const rows = await marketHistoryAPI.fetchHistory(itemHrid, enhancementLevel, FETCH_DAYS, { force });

            // A slower response for an item the player has since navigated away
            // from (or a teardown mid-flight) must not overwrite what is shown now.
            if (generation !== this.generation || this.currentKey !== key) return;

            const freshPanel = this.attachPanel(currentItemElement);
            if (rows === null) {
                const cooldownMs = marketHistoryAPI.cooldownRemainingMs(source.key);
                if (cooldownMs > 0) {
                    this.renderStatus(
                        freshPanel,
                        `the shared price-history server is busy; retrying in ${describeCooldown(cooldownMs)}`
                    );
                } else {
                    this.renderStatus(freshPanel, 'could not reach the shared price-history server');
                }
                this.loadedKey = key;
                return;
            }

            const windows = computeAllWindows(rows);
            // Cached so a column-visibility toggle can redraw without a refetch
            this.lastWindows = windows;
            this.lastSource = source;
            this.renderTable(freshPanel, windows, source);
            this.loadedKey = key;
        } finally {
            // Recorded even for a discarded fetch (the generation/key mismatch above
            // returned early) — that is what lets `update()` notice this generation
            // never produced a render and retry. Out-of-order settling (an older
            // request answering after a newer one already has) must not regress this
            // backward, hence the max rather than a plain assignment.
            this.settledGeneration = Math.max(this.settledGeneration, generation);
        }
    }

    /** Redraw the table from the last fetched data, e.g. after a column-visibility change */
    rerenderCurrentTable() {
        const currentItemElement = document.querySelector(GAME.MARKETPLACE_CURRENT_ITEM);
        if (!currentItemElement || !this.lastWindows) return;
        this.renderTable(this.attachPanel(currentItemElement), this.lastWindows, this.lastSource);
    }

    /**
     * Ensure the panel div exists as a child of the current-item card, creating
     * it on first use.
     *
     * An absolutely-positioned overlay anchored to the card's top-right corner,
     * not a sibling in normal flow: a sibling is taller than the icon and pushes
     * the whole info area down, adding height to the page for no gain. The
     * ask/bid "for sale" counts (queue-length-estimator.js) live in the button
     * row below, not on this card, so the overlay has nothing there to collide
     * with.
     * @param {HTMLElement} currentItemElement
     * @returns {HTMLElement} The panel's content container
     */
    attachPanel(currentItemElement) {
        let panel = currentItemElement.querySelector('.mwi-volume-stats');
        if (!panel) {
            panel = document.createElement('div');
            panel.className = 'mwi-volume-stats';
            panel.style.cssText =
                'position:absolute;left:100%;top:-20px;margin-left:85px;z-index:20;' +
                'white-space:nowrap;font-size:13px;line-height:1.5;text-align:left;' +
                'background:#101116;border-radius:4px;box-shadow:0 2px 10px rgba(0,0,0,0.3);' +
                'padding:4px 8px;pointer-events:auto;';
            if (getComputedStyle(currentItemElement).position === 'static') {
                currentItemElement.style.position = 'relative';
            }
            currentItemElement.appendChild(panel);
        } else if (panel.parentElement !== currentItemElement) {
            currentItemElement.appendChild(panel);
        }
        return panel;
    }

    removePanel() {
        document.querySelectorAll('.mwi-volume-stats').forEach((el) => el.remove());
    }

    renderLoading(panel) {
        this.closeColumnMenu();
        panel.innerHTML = '<span style="color:#AAAAAA;font-size:11px;">Loading trade stats…</span>';
    }

    renderStatus(panel, text) {
        this.closeColumnMenu();
        panel.innerHTML = `<span style="color:#FF6B6B;font-size:11px;">${escapeHtml(text)}</span>`;
    }

    renderTable(panel, windows, source) {
        this.closeColumnMenu();
        const hasAnyData = windows.some(({ stats }) => stats.volume > 0 || stats.avgPrice > 0 || stats.medianPrice > 0);
        if (!hasAnyData) {
            panel.innerHTML = '<span style="color:#AAAAAA;font-size:11px;">No trades in this window</span>';
            return;
        }

        const columns = COLUMNS.filter(
            (c) => this.visibleColumnIds.has(c.id) && (!c.volumeDependent || source.hasVolume)
        );

        const header = columns.map((c) => `<td style="padding:0 6px 3px;text-align:center;">${c.label}</td>`).join('');
        const rows = windows
            .map(({ days, stats }) => {
                const cells = columns
                    .map((c) => {
                        const value = c.read(stats);
                        const text = c.pair ? `${formatStat(value[0])}/${formatStat(value[1])}` : formatStat(value);
                        return `<td style="padding:1px 6px;text-align:center;color:${c.color};">${text}</td>`;
                    })
                    .join('');
                return `<tr><td style="padding:1px 6px 1px 0;color:${ROW_COLORS[days]};font-weight:bold;">${days}d</td>${cells}</tr>`;
            })
            .join('');

        const note = !source.hasVolume
            ? `<div style="color:#AAAAAA;font-size:10px;margin-top:2px;">` +
              `${source.label} has no volume data — Volume and Bought/Sold are not shown.</div>`
            : '';

        panel.innerHTML =
            `<div style="position:relative;">` +
            `<button type="button" class="mwi-volume-stats-gear" title="Choose columns" ` +
            `style="position:absolute;top:2px;left:2px;background:none;border:none;color:#AAAAAA;` +
            `cursor:pointer;font-size:13px;padding:0;line-height:1;z-index:1;">⚙</button>` +
            `<table style="border-collapse:collapse;font-size:13px;">` +
            `<tr style="color:#AAAAAA;font-size:11px;"><td style="width:16px;"></td>${header}</tr>${rows}</table>${note}` +
            `</div>`;

        panel.title =
            'Bought/Sold is estimated from where each hour’s trades sat between the ask and the bid; ' +
            'the pooled data does not record which side traded.';

        const gearButton = panel.querySelector('.mwi-volume-stats-gear');
        if (gearButton) {
            gearButton.addEventListener('click', (event) => {
                event.stopPropagation();
                this.toggleColumnMenu(panel);
            });
        }
    }

    /**
     * Open (or close, if already open) the ⚙ column-visibility menu: a
     * checkbox per column plus a "Refresh now" action that bypasses the cache.
     * @param {HTMLElement} panel
     */
    toggleColumnMenu(panel) {
        const existing = panel.querySelector('.mwi-volume-stats-menu');
        if (existing) {
            this.closeColumnMenu();
            return;
        }

        const menu = document.createElement('div');
        menu.className = 'mwi-volume-stats-menu';
        menu.style.cssText =
            'position:absolute;top:20px;left:2px;z-index:21;min-width:130px;padding:6px 8px;' +
            'background:#171822;border:1px solid #555;border-radius:4px;color:#EEEEEE;' +
            'font-size:12px;line-height:1.5;text-align:left;white-space:normal;';

        for (const column of COLUMNS) {
            const label = document.createElement('label');
            label.style.cssText = 'display:flex;align-items:center;gap:6px;cursor:pointer;';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.checked = this.visibleColumnIds.has(column.id);
            checkbox.addEventListener('change', () => {
                if (checkbox.checked) this.visibleColumnIds.add(column.id);
                else this.visibleColumnIds.delete(column.id);
                // At least one column stays visible, or there is nothing to show
                if (this.visibleColumnIds.size === 0) {
                    this.visibleColumnIds.add(column.id);
                    checkbox.checked = true;
                }
                this.saveColumnPrefs();
                this.rerenderCurrentTable();
                // The redraw replaced the menu along with the table; reopen it so several
                // columns can be toggled in a row.
                if (panel.isConnected) this.toggleColumnMenu(panel);
            });
            label.appendChild(checkbox);
            label.appendChild(document.createTextNode(column.label));
            menu.appendChild(label);
        }

        const separator = document.createElement('div');
        separator.style.cssText = 'border-top:1px solid #444;margin:4px 0;';
        menu.appendChild(separator);

        const refreshItem = document.createElement('button');
        refreshItem.type = 'button';
        refreshItem.textContent = 'Refresh now';
        refreshItem.style.cssText =
            'display:block;width:100%;text-align:left;background:none;border:none;color:#EEEEEE;' +
            'cursor:pointer;font-size:12px;padding:2px 0;';
        refreshItem.addEventListener('click', (event) => {
            event.stopPropagation();
            this.closeColumnMenu();
            this.refresh();
        });
        menu.appendChild(refreshItem);

        menu.addEventListener('click', (event) => event.stopPropagation());
        panel.querySelector('div').appendChild(menu);

        // The game's info container is its own stacking context at z-index 1, below the order
        // book's sticky header (z-index 10), which would otherwise paint over the open menu.
        const infoContainer = panel.closest('[class*="MarketplacePanel_infoContainer"]');
        const previousZIndex = infoContainer ? infoContainer.style.zIndex : '';
        if (infoContainer) infoContainer.style.zIndex = '11';

        const closeOnOutsideClick = (event) => {
            if (menu.contains(event.target)) return;
            this.closeColumnMenu();
        };
        this.closeColumnMenu = () => {
            menu.remove();
            if (infoContainer) infoContainer.style.zIndex = previousZIndex;
            document.removeEventListener('click', closeOnOutsideClick, true);
            this.closeColumnMenu = () => {};
        };
        // Deferred one tick so the click that opened the menu does not also close it.
        // Registered with the cleanup registry too, so a teardown while the menu
        // is still open does not leave this listener on `document` forever.
        setTimeout(() => this.cleanupRegistry.registerListener(document, 'click', closeOnOutsideClick, true), 0);
    }

    /**
     * Close the ⚙ menu and restore the stacking it raised. Replaced while a menu is open.
     */
    closeColumnMenu() {}

    disable() {
        noteTeardown(this);
        this.closeColumnMenu();
        this.removePanel();
        this.cleanupRegistry.cleanupAll();
        this.clearSettleChecks();
        this.isInitialized = false;
        this.currentKey = null;
        this.loadedKey = null;
        this.generation += 1;
        this.settledGeneration = this.generation;
    }

    cleanup() {
        this.disable();
    }
}

/**
 * Minimal HTML escaping for the one place free text (a cooldown/error message)
 * is interpolated into `innerHTML`.
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    return String(text).replace(
        /[&<>"']/g,
        (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]
    );
}

const marketVolumeStats = new MarketVolumeStats();
marketVolumeStats.setupSettingListener();
export default marketVolumeStats;

/**
 * Whether the trade-stats overlay is showing or would show once an item is
 * selected (`market_pooledHistory` and `market_volumeStats` both on).
 * A free function so queue-length-estimator.js can import it without pulling
 * in the whole singleton, or reading its two settings out of `config.js`
 * itself and risking the two checks drifting apart.
 * @returns {boolean}
 */
export function isVolumeStatsPanelActive() {
    return marketVolumeStats.isPanelActive();
}
