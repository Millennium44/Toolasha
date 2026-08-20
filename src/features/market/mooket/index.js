/**
 * Market History Panel
 *
 * A floating price-history chart and a row of pinned items, over the
 * marketplace.
 *
 * Adapted from mooket II by Q7 (MIT). See docs/THIRD-PARTY-LICENSES.md.
 *
 * The game shows you what an item costs now and nothing about what it cost
 * before, which makes every price impossible to judge: 840,000 is cheap or dear
 * only against what it has been. This draws the ask, the bid, the average
 * transacted price and the volume over a range you pick, from the pooled dataset
 * the mooket project maintains.
 *
 * Reading that dataset means telling a third-party server which items you look
 * up, so the whole feature is off until turned on.
 *
 * What was left behind from the original, deliberately: the second WebSocket
 * hook (Toolasha already has one, and two scripts patching `MessageEvent.data`
 * is how a page ends up silently dropping messages), the bundled item-name
 * dictionaries (Toolasha has the game's own), the `localStorage` cache with its
 * defensive pruning (this uses IndexedDB), and the crosshair plugin (Chart.js's
 * index-mode tooltip covers it without another dependency).
 */

import config from '../../../core/config.js';
import storage from '../../../core/storage.js';
import dataManager from '../../../core/data-manager.js';
import marketAPI from '../../../api/marketplace.js';
import { createCleanupRegistry } from '../../../utils/cleanup-registry.js';
import { createMutationWatcher } from '../../../utils/dom-observer-helpers.js';
import { formatKMB, formatWithSeparator } from '../../../utils/formatters.js';
import { navigateToMarketplace } from '../../../utils/marketplace-tabs.js';
import { hasCoarsePointer } from '../../../utils/mobile.js';
import marketPriceStore from './market-price-store.js';
import marketHistoryAPI from './market-history-api.js';
import { buildHistorySeries, historyLabels, HISTORY_RANGES } from './market-history-data.js';
import { priceKey } from './market-prices.js';
import {
    addWatched,
    removeWatched,
    moveWatched,
    nextDisplayMode,
    watchedChange,
    normaliseWatchlist,
} from './market-watchlist.js';
import { createCuratedRecord, mergeById } from '../../../utils/persisted-record.js';
import { attachMinimize } from '../../../utils/panel-minimize.js';

const PANEL_ID = 'mwi-market-history-panel';
const TAB_ID = 'mwi-market-history-tab';
/** Where the panel is and how it draws — one panel, so one global answer */
const PREFS_KEY = 'mooketPanelPrefs';
/**
 * What this character is watching.
 *
 * Split out of the prefs object, because it is the one field in it that is not
 * about the panel: an iron cow watching its own handful of items had the market
 * character's list of forty pushed onto it every time either of them saved.
 */
const WATCHLIST_BASE = 'mooketWatchlist';
const POLL_MS = 500;

/**
 * The watched items, per character, through a curated persisted record
 * (`utils/persisted-record.js`): once read back, the list in hand is the list
 * and a removal sticks; before that a save folds the stored list under it by
 * item so nothing is lost. A read that cannot be made keeps the list in hand
 * rather than blanking it, and no write goes out over an unreadable store.
 */
const watchlistRecord = createCuratedRecord({
    base: WATCHLIST_BASE,
    store: 'settings',
    empty: () => [],
    merge: mergeById((entry) => entry?.key),
    label: 'MarketHistory',
});

/**
 * Lift a pre-split watchlist out of the shared prefs object into its own key.
 *
 * Seeding the bare key and letting `readScoped` take it from there hands the
 * adoption rules — the main character claims it, an iron cow starts clean —
 * to one implementation instead of a second copy of them here.
 * @param {Object|null} savedPrefs - The prefs object as read from storage
 * @returns {Promise<void>}
 */
export async function splitLegacyWatchlist(savedPrefs) {
    if (!savedPrefs || savedPrefs.watchlist === undefined) return;

    try {
        const alreadySplit = await storage.get(WATCHLIST_BASE, 'settings', null);
        if (alreadySplit === null) {
            await storage.setJSON(WATCHLIST_BASE, normaliseWatchlist(savedPrefs.watchlist), 'settings', true);
        }
        const remaining = { ...savedPrefs };
        delete remaining.watchlist;
        await storage.setJSON(PREFS_KEY, remaining, 'settings', true);
    } catch (error) {
        console.error('[MarketHistory] Splitting the panel watchlist out failed:', error);
    }
}

/** Series colours, in the order the datasets are built */
const SERIES = [
    { key: 'ask', label: 'Ask', color: '#f56c6c', dash: [] },
    { key: 'bid', label: 'Bid', color: '#67c23a', dash: [5, 5] },
    { key: 'avg', label: 'Avg', color: '#e6a23c', dash: [2, 3] },
];

class MarketHistoryPanel {
    constructor() {
        this.isInitialized = false;
        this.cleanupRegistry = createCleanupRegistry();
        this.panel = null;
        this.chart = null;
        this.canvas = null;
        this.chipRow = null;
        this.overlay = null;
        this.pinButton = null;
        // Starts hidden. A panel that appears over the marketplace the moment
        // you open it is in the way of the thing you opened.
        this.prefs = {
            x: 20,
            y: 120,
            w: 520,
            h: 300,
            days: 7,
            open: false,
            locked: false,
            mode: 'iconPrice',
            /** What the chart last drew, restored on the next open */
            lastItem: null,
        };
        this.tabButton = null;
        this.tabWatcher = null;
        this.watchlist = [];
        /** Whose list `watchlist` holds, so a switch never shows another's */
        this.watchlistOwner = null;
        this.current = null; // { itemHrid, enhancementLevel }
        this.shown = null; // what the chart is currently drawing
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('market_pooledHistory')) return;
        this.isInitialized = true;

        await this.loadPrefs();

        await marketPriceStore.initialize();
        marketHistoryAPI.connect();

        // The snapshot has no sizes but covers every item, so it fills in
        // everything never opened
        const priceListener = () => marketPriceStore.ingestSnapshot(marketAPI.marketData, Date.now());
        marketAPI.on(priceListener);
        this.cleanupRegistry.registerCleanup(() => marketAPI.off(priceListener));
        priceListener();

        // Contributing is what keeps the pooled dataset alive, and is separately
        // opted into because it sends more than it asks for
        const bookListener = (data) => marketHistoryAPI.report(data);
        dataManager.on('market_item_order_books_updated', bookListener);
        this.cleanupRegistry.registerCleanup(() => dataManager.off('market_item_order_books_updated', bookListener));

        this.cleanupRegistry.registerCleanup(marketPriceStore.onChange(() => this.renderChips()));

        this.buildPanel();
        this.buildOverlay();

        // The tab bar is rebuilt whenever the marketplace re-renders, so the
        // button has to be put back rather than added once
        this.tabWatcher = createMutationWatcher(document.body, () => this.ensureTabButton(), {
            childList: true,
            subtree: true,
        });
        this.cleanupRegistry.registerCleanup(() => this.tabWatcher?.());
        this.ensureTabButton();

        const poll = setInterval(() => this.followMarketplace(), POLL_MS);
        this.cleanupRegistry.registerInterval(poll);
    }

    disable() {
        // Whatever fails in here, the feature must end up disabled: a throw
        // part-way once left `isInitialized` true with the panel already
        // removed, so the next initialize() returned early and every History
        // click after that read `.style` off a null panel until a refresh
        try {
            this.chart?.destroy();
            this.chart = null;
            this.minimizeCtl?.destroy();
            this.minimizeCtl = null;
            this.panel?.remove();
            this.panel = null;
            this.overlay?.remove();
            this.overlay = null;
            this.tabButton?.remove();
            this.tabButton = null;
            marketHistoryAPI.disconnect();
            marketPriceStore.cleanup();
            this.cleanupRegistry.cleanupAll();
        } catch (error) {
            console.error('[MarketHistory] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Read the panel's own settings and this character's watched items.
     *
     * Separate from `initialize` because it is the whole of what a character
     * switch has to redo, and because it is the only part of start-up that can
     * be tested without a canvas.
     * @returns {Promise<void>}
     */
    async loadPrefs() {
        try {
            const saved = await storage.getJSON(PREFS_KEY, 'settings', null);
            if (saved) {
                this.prefs = { ...this.prefs, ...saved };
                delete this.prefs.watchlist;
            }
            // Open on what was last shown instead of a blank chart; a click on
            // any item replaces it as before
            if (!this.current && this.prefs.lastItem?.itemHrid) {
                this.current = { ...this.prefs.lastItem };
            }
            await splitLegacyWatchlist(saved);
            // Another character's list must not survive a switch, whether or
            // not this one's can be read; this one's, when it cannot be read,
            // is left as it is rather than blanked
            const who = dataManager.getCurrentCharacterId?.() || null;
            watchlistRecord.reset();
            if (who !== this.watchlistOwner) {
                this.watchlist = [];
                this.watchlistOwner = who;
            }
            const readable = await watchlistRecord.load();
            if (readable) this.watchlist = normaliseWatchlist(watchlistRecord.get());
        } catch (error) {
            console.error('[MarketHistory] Loading panel preferences failed:', error);
        }
    }

    async savePrefs() {
        try {
            const prefs = { ...this.prefs };
            delete prefs.watchlist;
            await storage.setJSON(PREFS_KEY, prefs, 'settings');
            watchlistRecord.set(this.watchlist);
            await watchlistRecord.save();
        } catch (error) {
            console.error('[MarketHistory] Saving panel preferences failed:', error);
        }
    }

    /**
     * The item name the game itself uses, so nothing here carries its own
     * dictionary of them.
     * @param {string} itemHrid - Item
     * @returns {string}
     */
    itemName(itemHrid) {
        return dataManager.getItemDetails(itemHrid)?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
    }

    // ---------------------------------------------------------------- panel

    buildPanel() {
        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.cssText = `
            position: fixed; left: ${this.prefs.x}px; top: ${this.prefs.y}px;
            width: ${this.prefs.w}px; z-index: 9000; display: none;
            flex-direction: column; background: #282844; border: 1px solid #90a6eb;
            border-radius: 4px; box-shadow: 0 4px 14px rgba(0,0,0,0.5);
            font-size: 12px; color: #e7e7e7; user-select: none; resize: both; overflow: hidden;
            min-width: 260px; min-height: 60px;
        `;

        // The toolbar is the one region a finger can drag from: the chip row
        // has to keep touch scrolling, and the canvas keeps its own gestures
        const toolbar = this.buildToolbar();
        toolbar.style.touchAction = 'none';
        panel.appendChild(toolbar);

        this.chipRow = document.createElement('div');
        this.chipRow.style.cssText =
            'display:flex; flex-wrap:wrap; gap:2px; padding:2px 4px; max-height:96px; overflow:auto;';
        panel.appendChild(this.chipRow);

        this.canvas = document.createElement('canvas');
        this.canvas.style.cssText = 'flex:1; min-height:0; display:block; padding:2px;';
        panel.appendChild(this.canvas);

        this.makeDraggable(panel);
        document.body.appendChild(panel);
        this.panel = panel;

        this.minimizeCtl = attachMinimize({
            panel,
            header: toolbar,
            body: [this.chipRow, this.canvas],
            panelKey: PANEL_ID,
            beforeEl: this.closeButton,
            accent: '#e7e7e7',
        });

        this.applyOpenState();
        this.renderChips();
    }

    /**
     * A tab beside Market Listings that shows and hides the panel.
     *
     * Cloned from one of the game's own tabs so it looks like part of the bar
     * rather than something bolted on, the same way Bulk Sell does it. The
     * marketplace rebuilds the bar on every re-render, so this runs again and
     * puts the tab back rather than assuming it survived.
     */
    ensureTabButton() {
        const tabBar = this.findMarketTabBar();
        if (!tabBar) {
            this.tabButton = null;
            return;
        }
        if (this.tabButton && tabBar.contains(this.tabButton)) {
            // Kept at the end. Every other script inserts its tab relative to an
            // anchor, so one added after this one lands in front of it; moving
            // back only when it is not already last leaves nothing to fight over.
            if (tabBar.lastElementChild !== this.tabButton) tabBar.appendChild(this.tabButton);
            return;
        }

        const reference = [...tabBar.children].find((tab) => tab.textContent.includes('Market Listings'));
        if (!reference) return;

        const tab = reference.cloneNode(true);
        tab.id = TAB_ID;
        tab.title =
            'Show or hide the price history panel. This opens a panel over the page rather than switching to a view.';
        const badge = tab.querySelector('[class*="TabsComponent_badge"]');
        // The ⧉ marks it as opening a panel rather than switching the view.
        // Without it a toggle that borrows the game's tab styling reads as a
        // fifth place to navigate to, and clicking it twice looks broken.
        if (badge) badge.innerHTML = '<div style="text-align:center;"><div>\u29c9 History</div></div>';
        else tab.textContent = '\u29c9 History';

        tab.classList.remove('Mui-selected');
        tab.setAttribute('aria-selected', 'false');
        tab.setAttribute('tabindex', '-1');
        tab.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this.prefs.open = !this.prefs.open;
            this.applyOpenState();
            this.savePrefs();
        });

        tabBar.appendChild(tab);
        this.tabButton = tab;
        this.syncTabButton();
    }

    /** @returns {HTMLElement|null} The marketplace's own tab bar */
    findMarketTabBar() {
        // The visible one, when there is more than one marketplace in the DOM
        // (see followMarketplace) — a tab put into a hidden bar is a tab nobody
        // can click
        let hidden = null;
        for (const tabBar of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
            if (![...tabBar.children].some((tab) => tab.textContent.includes('Market Listings'))) continue;
            if (tabBar.getClientRects().length) return tabBar;
            hidden = hidden || tabBar;
        }
        return hidden;
    }

    /**
     * Show whether the panel is up.
     *
     * A dimmed tab when closed and a lit one when open, rather than only an
     * underline: the tab borrows the game's own styling, and a state shown by
     * two pixels at the bottom edge is not a state most people will notice.
     */
    syncTabButton() {
        if (!this.tabButton) return;
        this.tabButton.style.boxShadow = this.prefs.open ? 'inset 0 -2px 0 0 #90a6eb' : '';
        this.tabButton.style.opacity = this.prefs.open ? '1' : '0.6';
    }

    buildToolbar() {
        const bar = document.createElement('div');
        bar.style.cssText = 'display:flex; align-items:center; gap:4px; padding:3px 4px; background:rgba(0,0,0,0.25);';

        const button = (text, title, onClick) => {
            const element = document.createElement('button');
            element.textContent = text;
            element.title = title;
            element.style.cssText =
                'background:rgba(255,255,255,0.08); border:1px solid #4a5a8a; color:#e7e7e7; ' +
                'border-radius:3px; cursor:pointer; font-size:12px; line-height:1; padding:3px 6px;';
            element.addEventListener('click', onClick);
            bar.appendChild(element);
            return element;
        };

        this.closeButton = button('\u2715', 'Close the panel. Reopen it from the History tab.', () => {
            this.prefs.open = false;
            this.applyOpenState();
            this.savePrefs();
        });

        button('👁', 'How much to show for each pinned item', () => {
            this.prefs.mode = nextDisplayMode(this.prefs.mode);
            this.renderChips();
            this.savePrefs();
        });

        this.lockButton = button(this.prefs.locked ? '🔒' : '🔓', 'Lock the panel where it is', () => {
            this.prefs.locked = !this.prefs.locked;
            this.lockButton.textContent = this.prefs.locked ? '🔒' : '🔓';
            this.savePrefs();
        });

        const range = document.createElement('select');
        range.title = 'How far back to chart';
        range.style.cssText =
            'background:#1a1a2e; color:#e7e7e7; border:1px solid #4a5a8a; border-radius:3px; ' +
            'font-size:12px; padding:2px 4px; cursor:pointer;';
        for (const days of HISTORY_RANGES) {
            const option = document.createElement('option');
            option.value = String(days);
            option.textContent = `${days}d`;
            option.selected = days === this.prefs.days;
            range.appendChild(option);
        }
        range.addEventListener('change', () => {
            this.prefs.days = Number(range.value);
            this.savePrefs();
            // Force a redraw of the same item at the new range
            this.shown = null;
            if (this.current) this.showItem(this.current.itemHrid, this.current.enhancementLevel);
        });
        bar.appendChild(range);

        this.title = document.createElement('span');
        this.title.style.cssText = 'flex:1; text-align:right; padding-right:4px; font-weight:600; opacity:0.9;';
        bar.appendChild(this.title);

        return bar;
    }

    applyOpenState() {
        // A click that arrives while the feature is down (between a disable
        // and its re-initialise) has no panel to show; doing nothing beats
        // throwing out of the tab's click handler
        if (!this.panel) return;
        const open = this.prefs.open;
        this.panel.style.display = open ? 'flex' : 'none';
        this.panel.style.height = `${this.prefs.h}px`;
        this.syncTabButton();
        if (open && this.current) this.showItem(this.current.itemHrid, this.current.enhancementLevel);
    }

    /**
     * Drag by the panel's own background, clamped on screen.
     *
     * A panel dragged off the edge cannot be dragged back, and the only way out
     * would be clearing its stored position by hand.
     *
     * @param {HTMLElement} panel - The panel
     */
    makeDraggable(panel) {
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen
        panel.addEventListener('pointerdown', (e) => {
            if (this.prefs.locked) return;
            if (e.button !== 0 || e.target.closest('button, select, canvas, input')) return;
            // The browser's own resize handle lives in the bottom-right corner
            const rect = panel.getBoundingClientRect();
            if (e.clientX > rect.right - 16 && e.clientY > rect.bottom - 16) return;
            e.preventDefault();

            const grabX = e.clientX - rect.left;
            const grabY = e.clientY - rect.top;

            const onMove = (move) => {
                const maxLeft = Math.max(0, window.innerWidth - panel.offsetWidth);
                const maxTop = Math.max(0, window.innerHeight - panel.offsetHeight);
                panel.style.left = `${Math.min(Math.max(0, move.clientX - grabX), maxLeft)}px`;
                panel.style.top = `${Math.min(Math.max(0, move.clientY - grabY), maxTop)}px`;
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                const final = panel.getBoundingClientRect();
                this.prefs.x = final.left;
                this.prefs.y = final.top;
                this.prefs.w = panel.offsetWidth;
                this.prefs.h = this.prefs.open ? panel.offsetHeight : this.prefs.h;
                this.savePrefs();
            };

            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    // ----------------------------------------------------------------- chips

    renderChips() {
        if (!this.chipRow) return;
        this.chipRow.innerHTML = '';
        if (this.prefs.mode === 'hidden') return;

        for (const entry of this.watchlist) {
            const [itemHrid, level] = entry.key.split(':');
            const price = marketPriceStore.get(itemHrid, Number(level));
            const change = watchedChange(entry, price);

            const chip = document.createElement('div');
            chip.style.cssText =
                'display:inline-flex; align-items:center; gap:3px; padding:1px 3px; cursor:pointer; ' +
                'border:1px solid #4a5a8a; border-radius:3px; background:rgba(0,0,0,0.2); white-space:nowrap;';
            chip.title =
                `${this.itemName(itemHrid)}${Number(level) > 0 ? ` +${level}` : ''}\n` +
                `Ask ${change.ask === null ? '—' : formatWithSeparator(change.ask)} · ` +
                `Bid ${change.bid === null ? '—' : formatWithSeparator(change.bid)}\n` +
                'Click to chart it, right-click to unpin';

            const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            icon.setAttribute('width', '15');
            icon.setAttribute('height', '15');
            const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
            use.setAttribute('href', `${this.spriteUrl()}#${itemHrid.split('/').pop()}`);
            icon.appendChild(use);
            chip.appendChild(icon);

            const mode = this.prefs.mode;
            if (mode === 'namePrice' || mode === 'full') {
                const name = document.createElement('span');
                name.textContent = this.itemName(itemHrid) + (Number(level) > 0 ? ` +${level}` : '');
                chip.appendChild(name);
            }
            if (mode !== 'icon' && mode !== 'iconChange') {
                const value = document.createElement('span');
                value.textContent = change.ask === null ? '—' : formatKMB(change.ask);
                value.style.color = this.changeColour(change.askChange);
                chip.appendChild(value);
            }
            if (mode === 'iconChange' || mode === 'iconBoth' || mode === 'full') {
                const delta = document.createElement('span');
                delta.textContent =
                    change.askChange === null
                        ? ''
                        : `${change.askChange >= 0 ? '+' : ''}${change.askChange.toFixed(1)}%`;
                delta.style.color = this.changeColour(change.askChange);
                chip.appendChild(delta);
            }

            chip.addEventListener('click', () => {
                navigateToMarketplace(itemHrid, Number(level));
                this.showItem(itemHrid, Number(level));
            });
            chip.addEventListener('contextmenu', (e) => {
                e.preventDefault();
                this.watchlist = removeWatched(this.watchlist, entry.key);
                this.renderChips();
                this.savePrefs();
            });

            // Touch gets sized-up controls: 8px arrows are unhittable with a
            // finger, and right-click-to-remove does not exist there — an
            // explicit × stands in, since a long-press that silently deletes a
            // watch would be worse than one extra glyph of clutter
            const coarse = hasCoarsePointer();

            const arrows = document.createElement('span');
            arrows.style.cssText = coarse
                ? 'display:flex; flex-direction:column; line-height:0.9; font-size:13px; color:#8fa0c8; gap:2px;'
                : 'display:flex; flex-direction:column; line-height:0.7; font-size:8px; color:#8fa0c8;';
            for (const [glyph, direction] of [
                ['▲', -1],
                ['▼', 1],
            ]) {
                const step = document.createElement('span');
                step.textContent = glyph;
                step.style.cursor = 'pointer';
                if (coarse) step.style.padding = '2px 4px';
                step.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.watchlist = moveWatched(this.watchlist, entry.key, direction);
                    this.renderChips();
                    this.savePrefs();
                });
                arrows.appendChild(step);
            }
            chip.appendChild(arrows);

            if (coarse) {
                const remove = document.createElement('span');
                remove.textContent = '×';
                remove.title = 'Remove from watchlist';
                remove.style.cssText = 'cursor:pointer; padding:2px 6px; font-size:14px; line-height:1; color:#c88f8f;';
                remove.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.watchlist = removeWatched(this.watchlist, entry.key);
                    this.renderChips();
                    this.savePrefs();
                });
                chip.appendChild(remove);
            }

            this.chipRow.appendChild(chip);
        }
    }

    /** @param {number|null} change - Percentage move */
    changeColour(change) {
        if (change === null || change === 0) return '#e7e7e7';
        return change > 0 ? '#f56c6c' : '#67c23a';
    }

    /** The game's item sprite sheet, whichever build hash it is on today */
    spriteUrl() {
        if (this.sprite) return this.sprite;
        const use = document.querySelector('svg use[href*="items_sprite"]');
        this.sprite = use?.getAttribute('href')?.split('#')[0] || '';
        return this.sprite;
    }

    // ---------------------------------------------------------------- chart

    async showItem(itemHrid, enhancementLevel) {
        this.current = { itemHrid, enhancementLevel };
        // Remembered so the panel reopens on what it was last showing rather
        // than blank; a lazy write, since showItem fires on every item click
        if (this.prefs.lastItem?.itemHrid !== itemHrid || this.prefs.lastItem?.enhancementLevel !== enhancementLevel) {
            this.prefs.lastItem = { itemHrid, enhancementLevel };
            this.savePrefs();
        }
        const key = `${priceKey(itemHrid, enhancementLevel)}:${this.prefs.days}`;
        if (!this.prefs.open || this.shown === key) return;
        this.shown = key;

        const level = Number(enhancementLevel) || 0;
        this.title.textContent = `${this.itemName(itemHrid)}${level > 0 ? ` +${level}` : ''}`;

        const rows = await marketHistoryAPI.fetchHistory(itemHrid, level, this.prefs.days);
        // The item may have changed while the request was in flight
        if (this.shown !== key) return;
        this.drawChart(buildHistorySeries(rows, this.prefs.days));
    }

    /** @param {Array<Object>} series - Result of buildHistorySeries */
    drawChart(series) {
        if (!this.canvas || typeof Chart === 'undefined') return;

        // The source decides two things about how its data is drawn: what the
        // third line is called (a real transacted average, or a computed midpoint
        // of the quotes), and whether there is any volume to draw at all.
        const source = marketHistoryAPI.currentSource();

        const labels = historyLabels(series, this.prefs.days);
        const datasets = SERIES.map((spec) => ({
            label: spec.key === 'avg' ? source.avgLabel : spec.label,
            data: series.map((point) => point[spec.key] || null),
            borderColor: spec.color,
            borderDash: spec.dash,
            borderWidth: 1.5,
            pointRadius: 0,
            pointHitRadius: 6,
            spanGaps: true,
            tension: 0,
        }));
        if (source.hasVolume) {
            datasets.push({
                label: 'Volume',
                data: series.map((point) => point.volume),
                borderColor: '#409eff',
                backgroundColor: 'rgba(64, 158, 255, 0.18)',
                borderWidth: 1,
                fill: true,
                yAxisID: 'volume',
                pointRadius: 0,
                pointHitRadius: 6,
                tension: 0,
            });
        }

        if (this.chart) {
            this.chart.data.labels = labels;
            this.chart.data.datasets = datasets;
            this.chart.$series = series;
            // A source switch can turn the volume axis on or off between draws
            this.chart.options.scales.volume.display = source.hasVolume;
            this.chart.update('none');
            return;
        }

        const axis = { color: '#9aa4c0', font: { size: 10 } };
        this.chart = new Chart(this.canvas, {
            type: 'line',
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: 'index', intersect: false },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { ...axis, maxTicksLimit: 8 } },
                    y: {
                        position: 'left',
                        grid: { color: 'rgba(255,255,255,0.06)' },
                        ticks: { ...axis, callback: (value) => formatKMB(value) },
                    },
                    volume: {
                        position: 'right',
                        display: source.hasVolume,
                        grid: { drawOnChartArea: false },
                        ticks: { ...axis, color: '#409eff', callback: (value) => formatKMB(value) },
                    },
                },
                plugins: {
                    legend: { labels: { color: '#c8cee0', boxWidth: 10, font: { size: 10 } } },
                    tooltip: {
                        callbacks: {
                            label: (item) => `${item.dataset.label}: ${formatWithSeparator(Math.round(item.parsed.y))}`,
                            // The split is an estimate from where the traded
                            // price sat in the spread, and says so. A source with
                            // no volume has nothing to split, so it says nothing.
                            footer: (items) => {
                                if (!marketHistoryAPI.currentSource().hasVolume) return '';
                                const point = this.chart?.$series?.[items[0].dataIndex];
                                if (!point) return '';
                                return (
                                    `Est. bought at the ask: ${formatWithSeparator(point.atAsk)}\n` +
                                    `Est. sold into the bid: ${formatWithSeparator(point.atBid)}`
                                );
                            },
                        },
                    },
                },
            },
        });
        this.chart.$series = series;
    }

    // -------------------------------------------------------------- overlay

    buildOverlay() {
        // Parked on the body rather than inside the game's own tree: React owns
        // that tree and discards anything it did not put there
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:absolute; top:0; left:0; pointer-events:none; z-index:820;';

        this.pinButton = document.createElement('button');
        this.pinButton.textContent = '📌';
        this.pinButton.title = 'Pin this item to the price panel';
        this.pinButton.style.cssText =
            'position:absolute; display:none; pointer-events:auto; background:none; border:none; ' +
            'font-size:16px; line-height:1; padding:0; cursor:pointer;';
        this.pinButton.addEventListener('click', () => {
            if (!this.current) return;
            const key = priceKey(this.current.itemHrid, this.current.enhancementLevel);
            const price = marketPriceStore.get(this.current.itemHrid, this.current.enhancementLevel);
            this.watchlist = addWatched(this.watchlist, key, price);
            this.renderChips();
            this.savePrefs();
        });
        overlay.appendChild(this.pinButton);

        document.body.appendChild(overlay);
        this.overlay = overlay;
    }

    /**
     * Follow whichever item the marketplace is showing.
     *
     * Polled rather than observed: the panel only has to keep up with a person
     * clicking, and a MutationObserver over the marketplace fires on every price
     * tick for the sake of the handful that change the item.
     */
    followMarketplace() {
        if (document.hidden || !this.panel) return;

        // Any marketplace that is actually on screen. The game can leave a
        // second, hidden marketplace panel in the DOM after some navigations;
        // reading only the first match then saw "not visible" and this poll
        // hid the panel half a second after every click on the History tab —
        // the tab "stopped working" until a refresh cleared the stray panel.
        const marketplace = [...document.querySelectorAll('[class*="MarketplacePanel_marketplacePanel"]')].find(
            (el) => el.getClientRects().length
        );
        const visible = !!marketplace;

        // Off the marketplace there is no item to chart and nowhere to put the
        // pin, so the panel goes with it — but coming back does not reopen a
        // panel that was closed on purpose
        this.panel.style.display = visible && this.prefs.open ? 'flex' : 'none';
        if (!visible) {
            this.pinButton.style.display = 'none';
            return;
        }

        const currentItem = marketplace.querySelector('[class*="MarketplacePanel_currentItem"]');
        const use = currentItem?.querySelector('svg use');
        const iconName = use?.href?.baseVal?.split('#')[1];
        if (!currentItem || !iconName) {
            this.pinButton.style.display = 'none';
            return;
        }

        const badge = currentItem.querySelector('[class*="Item_enhancementLevel"]');
        const level = Number(badge?.textContent?.replace('+', '')) || 0;
        const itemHrid = `/items/${iconName}`;

        const iconRect = currentItem.querySelector('svg').getBoundingClientRect();
        this.pinButton.style.left = `${iconRect.right + window.scrollX + 6}px`;
        this.pinButton.style.top = `${iconRect.top + window.scrollY - 2}px`;
        this.pinButton.style.display = 'block';

        if (this.current?.itemHrid !== itemHrid || this.current?.enhancementLevel !== level) {
            this.showItem(itemHrid, level);
        }
    }
}

const marketHistoryPanel = new MarketHistoryPanel();
export default marketHistoryPanel;
