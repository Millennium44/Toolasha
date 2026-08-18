/**
 * Bulk Sell Assistant
 *
 * Sells the whole inventory through the market one item at a time with one
 * game action per click. A Bulk Sell button in the marketplace tab bar (next
 * to Market History) shows/hides the floating control panel.
 * Start builds a queue of tradable inventory items —
 * optionally limited to one Toolasha custom inventory tab (children included);
 * for each item it navigates to its order book, decides between insta-selling
 * (ask supply exceeds bid demand, the front of the ask queue is older than
 * the configured threshold — the queue isn't moving —, the stack is under the
 * minimum listing value, or the ask−bid spread is under the configured
 * percentage) and posting a sell listing, then opens the matching modal with
 * the quantity prefilled.
 * Confirming (or closing) the modal advances to the next item automatically,
 * so after Start every sale is exactly one click on the game's confirm button
 * — always in the same place. The assistant never confirms a sale itself.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';
import { clampToBand } from '../../utils/market-values.js';
import marketAPI from '../../api/marketplace.js';
import {
    loadConfig as loadTabConfig,
    findTab,
    collectTabItems,
    collectItemsAboveTab,
} from '../inventory/custom-tabs/custom-tabs-data.js';
import marketplaceShortcuts from './marketplace-shortcuts.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { formatKMB } from '../../utils/formatters.js';
import { holdKey, collectHeldKeys } from './bulk-sell-holds.js';
import { watchlistEntries } from '../inventory/watchlist.js';
import bundledLoadoutSnapshot from '../combat/loadout-snapshot.js';
import { loadoutSnapshot } from '../../utils/bundle-bridge.js';

const BUTTON_ID = 'mwi-bulk-sell-btn';
const CHIP_ID = 'mwi-bulk-sell-chip';
const PANEL_POSITION_KEY = 'bulkSellPanelPosition';
/** The source that is not a tab: whatever the Watchlist is currently tracking */
const WATCHLIST_SOURCE = 'watchlist';

/**
 * The rules the assistant decides by, editable from its own panel.
 *
 * They live in the settings the decision already reads rather than in a copy,
 * so the panel and the settings page can never disagree. Here because the
 * moment you want to change one of these is the moment you are watching it make
 * the wrong call — not the moment you are reading the settings page.
 */
const TUNABLES = [
    {
        key: 'market_bulkSellMinListingValue',
        fallback: 1500000,
        label: 'Insta-sell stacks under',
        suffix: 'coins',
        title: 'Stacks worth less than this (count × ask) are insta-sold rather than using up a listing slot. 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellSupplyRatio',
        fallback: 1,
        label: 'Insta-sell when supply beats demand by',
        suffix: '×',
        title: 'Insta-sell when sell-order supply exceeds buy-order demand times this. 1 = whenever sellers outnumber buyers; 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellQueueDays',
        fallback: 2,
        label: 'Insta-sell when the front ask is older than',
        suffix: 'days',
        title: 'A sell queue whose front listing has waited this long is not moving, so joining it would not sell either. 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellMaxSpreadPct',
        fallback: 0,
        label: 'Insta-sell when the spread is under',
        suffix: '%',
        title: 'When the best ask and best bid are within this percentage of each other, a listing earns only a sliver over selling instantly — not worth the slot and the wait. 0 turns the rule off.',
    },
    {
        key: 'market_bulkSellMinPatientPremium',
        fallback: 0,
        label: 'Insta-sell when a listing earns under',
        suffix: 'coins',
        title: 'The same idea in coins: what the whole stack would earn by waiting in the queue instead of selling instantly — (ask − bid) × count, after the 5% tax. Under this amount, insta-sell. 0 turns the rule off.',
    },
];
const MS_PER_DAY = 86400000;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

/**
 * Every piece of gear saved into a loadout, as hold keys.
 *
 * A loadout is a claim on an item: you are still using it, just not right now.
 * Selling one is not merely a mistake, it is a mistake you find out about the
 * next time you switch to that loadout and it is not there.
 *
 * Keyed by item and enhancement level, so a +10 in a loadout does not protect
 * the +0 you keep for melting.
 *
 * @returns {Array<string>} Hold keys
 */
export function loadoutHoldKeys() {
    const keys = [];
    for (const snapshot of (loadoutSnapshot() || bundledLoadoutSnapshot).getAllSnapshots?.() || []) {
        for (const piece of snapshot.equipment || []) {
            if (piece?.itemHrid) keys.push(holdKey(piece.itemHrid, piece.enhancementLevel));
        }
    }
    return keys;
}

class BulkSellAssistant {
    constructor() {
        this.isInitialized = false;
        this.watcher = null;
        this.chip = null;
        this.state = 'idle'; // idle | preparing | awaiting_confirm | awaiting_next | done
        this.queue = [];
        this.index = 0;
        this.current = null;
        this.decision = null;
        this.statusNote = '';
        this.bookHandler = null;
        this.modalUnregister = null;
        this.bookTimeout = null;
        this.advanceTimeout = null;
        this.modalPoll = null;
        this.selectedTabId = 'all';
        this.panelPosition = null;
        /**
         * Other scripts' claims on inventory: name -> () => iterable of hold
         * keys. Kept deliberately ignorant of why anything is held — stock
         * waiting to be relisted, a crafting reserve, a gift — so nothing about
         * the reason has to live in here.
         */
        this.holdProviders = new Map();
        this.heldCount = 0;
        /** Enhanced gear the watchlist source declined to sweep up */
        this.enhancedSkipped = 0;
        this._hasTabs = false;
        this._tabPrefLoaded = false;
        this.toggleBtn = null;
        this.panelVisible = false;
        this.rulesOpen = false;
    }

    /**
     * What was left out of the queue and why.
     *
     * Counted and said rather than silently dropped: an item missing from a sell
     * run with no explanation is indistinguishable from a bug, and one of these
     * reasons — gear that is in a loadout — is the difference between a tidy
     * inventory and a loadout that stops working.
     *
     * @param {Object} [options] - `bare: true` for a sentence of its own
     * @returns {string}
     */
    _skipNote({ bare = false } = {}) {
        const parts = [];
        if (this.heldCount > 0) parts.push(`${this.heldCount} held back (in a loadout, or claimed elsewhere)`);
        if (this.enhancedSkipped > 0) {
            parts.push(`${this.enhancedSkipped} enhanced item${this.enhancedSkipped === 1 ? '' : 's'} skipped`);
        }
        if (!parts.length) return '';
        return bare ? parts.join(' · ') : ` (${parts.join(', ')})`;
    }

    /**
     * What the Watchlist is tracking, as the same key set a tab produces.
     *
     * Plain hrids: the watchlist tracks an item rather than an item at an
     * enhancement level, so every level of a tracked item is in scope — which
     * is what "sell what I am watching" means.
     *
     * @returns {Set<string>} Hrids
     */
    _watchlistItems() {
        try {
            // `hrid`, which is what a watchlist entry calls it. Reading
            // `itemHrid` — what an inventory item calls it — produced a set of
            // undefined, an empty source, and "no tradable items" against a
            // list of seventy.
            return new Set(watchlistEntries().map((entry) => entry.hrid));
        } catch (error) {
            console.error('[BulkSellAssistant] Reading the watchlist failed:', error);
            return new Set();
        }
    }

    /** Character-scoped storage key for the remembered tab selection */
    _tabPrefKey() {
        const charId = dataManager.getCurrentCharacterId();
        return charId ? `${charId}_bulkSell_lastTab` : null;
    }

    /**
     * Register a claim on inventory, so those items are skipped by the sell
     * queue. The assistant never learns why — a caller supplies keys and takes
     * them away again when the claim ends.
     *
     *     const release = Toolasha.Market.bulkSellAssistant.addHoldProvider(
     *         'my-script',
     *         () => ['/items/cheese', '/items/cheese_sword+3']
     *     );
     *
     * @param {string} name - Identifies the caller, and reports its errors
     * @param {Function} provide - Returns an iterable of hold keys, called
     *   afresh each time a queue is built so it can change between runs
     * @returns {Function} Removes the provider
     */
    addHoldProvider(name, provide) {
        if (typeof provide !== 'function') {
            throw new TypeError('addHoldProvider needs a function returning the keys to hold');
        }
        const id = String(name || 'anonymous');
        this.holdProviders.set(id, provide);
        return () => this.holdProviders.delete(id);
    }

    /**
     * @param {string} name - The name it was registered under
     * @returns {boolean} Whether anything was removed
     */
    removeHoldProvider(name) {
        return this.holdProviders.delete(String(name));
    }

    /** The keys currently claimed, for a caller checking its own work */
    heldKeys() {
        return [...collectHeldKeys(this.holdProviders)];
    }

    async initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('market_bulkSellAssistant')) return;
        this.isInitialized = true;

        try {
            this.panelPosition = await storage.get(PANEL_POSITION_KEY, 'settings', null);
        } catch (error) {
            console.error('[BulkSellAssistant] Loading panel position failed:', error);
        }

        this.bookHandler = (data) => this._onOrderBook(data);
        dataManager.on('market_item_order_books_updated', this.bookHandler);

        this.modalUnregister = domObserver.onClass('BulkSellAssistant', 'Modal_modalContainer', (modal) =>
            this._onModal(modal)
        );

        const ensureUI = () => {
            const tabBar = this._findMarketTabBar();
            if (!tabBar) {
                this._removeButton();
                this._removePanel();
                return;
            }
            this._ensureButton(tabBar);
            if (this.panelVisible) {
                if (this.chip && !document.body.contains(this.chip)) this.chip = null;
                if (!this.chip) this._buildPanel();
            } else {
                this._removePanel();
            }
        };
        this.watcher = createMutationWatcher(document.body, ensureUI, { childList: true, subtree: true });
        ensureUI();
    }

    /**
     * The marketplace top tab bar (Market Listings / My Listings / …), which
     * stays put across every subview — so the button never moves during a run.
     */
    _findMarketTabBar() {
        for (const tabBar of document.querySelectorAll('.MuiTabs-flexContainer[role="tablist"]')) {
            const hasMarketTabs = Array.from(tabBar.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (hasMarketTabs) return tabBar;
        }
        return null;
    }

    /**
     * Tab-bar toggle that shows/hides the floating panel. Cloned from a
     * native tab (same approach as the Market History tab) so it looks like
     * part of the game's tab bar.
     */
    _ensureButton(tabBar) {
        if (this.toggleBtn && tabBar.contains(this.toggleBtn)) {
            // The Market History tab is injected by its own feature and can
            // land after us — keep our button on its right
            const historyTab = tabBar.querySelector('[data-mwi-market-history-tab="true"]');
            if (
                historyTab &&
                historyTab.nextElementSibling !== this.toggleBtn &&
                historyTab.compareDocumentPosition(this.toggleBtn) & Node.DOCUMENT_POSITION_PRECEDING
            ) {
                historyTab.after(this.toggleBtn);
            }
            return;
        }
        if (this.toggleBtn) this.toggleBtn.remove();

        const referenceTab = Array.from(tabBar.children).find((btn) => btn.textContent.includes('My Listings'));
        if (!referenceTab) return;

        const button = referenceTab.cloneNode(true);
        button.id = BUTTON_ID;
        button.title =
            'Bulk Sell \u2014 clears the inventory through the market one item at a time.\n\n' +
            'Start builds a queue of everything tradable, then for each item opens its order book, ' +
            'decides between insta-selling and posting a listing, and opens the matching modal with the ' +
            'quantity already filled in. After that every sale is one click on the game\u2019s own confirm ' +
            'button, always in the same place. It never confirms a sale for you.\n\n' +
            'Works best pointed at a Toolasha inventory tab rather than the whole inventory: put the things ' +
            'you actually want gone in one tab and pick it in the panel, and nothing outside it can be sold ' +
            'by a mis-click. Items you also filed in a tab above the selected one are kept, not sold.\n\n' +
            'Click to show or hide the panel. Hiding it never stops a run.';
        const badge = button.querySelector('[class*="TabsComponent_badge"]');
        // The ⧉ marks it as opening a panel rather than switching the view.
        // Borrowing the game's tab styling made it read as a fifth place to
        // navigate to, and clicking it twice looked broken.
        if (badge) {
            badge.innerHTML = '<div style="text-align: center;"><div>\u29c9 Bulk Sell</div></div>';
        } else {
            button.textContent = '\u29c9 Bulk Sell';
        }
        button.classList.remove('Mui-selected');
        button.setAttribute('aria-selected', 'false');
        button.setAttribute('tabindex', '-1');
        button.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            this._togglePanel();
        });

        const historyTab = tabBar.querySelector('[data-mwi-market-history-tab="true"]');
        const firstCustomTab = Array.from(tabBar.children).find(
            (btn) => btn.getAttribute('data-mwi-custom-tab') === 'true'
        );
        if (historyTab) {
            historyTab.after(button);
        } else if (firstCustomTab) {
            firstCustomTab.before(button);
        } else {
            tabBar.appendChild(button);
        }
        this.toggleBtn = button;
        this._syncButton();
    }

    /** Hiding the panel never stops a run — reopening shows live progress */
    _togglePanel() {
        this.panelVisible = !this.panelVisible;
        if (this.panelVisible) {
            if (!this.chip || !document.body.contains(this.chip)) this._buildPanel();
        } else {
            this._removePanel();
        }
        this._syncButton();
    }

    /**
     * Show whether the panel is up: dimmed when closed, lit when open. An
     * underline alone is two pixels at the bottom edge of a tab that looks like
     * every other tab, which is not a state most people will notice.
     */
    _syncButton() {
        if (!this.toggleBtn) return;
        this.toggleBtn.style.boxShadow = this.panelVisible ? 'inset 0 -2px 0 0 #4a9eff' : '';
        this.toggleBtn.style.opacity = this.panelVisible ? '1' : '0.6';
    }

    _removeButton() {
        if (this.toggleBtn) {
            this.toggleBtn.remove();
            this.toggleBtn = null;
        }
    }

    _removePanel() {
        if (this.chip) {
            this.chip.remove();
            this.chip = null;
        }
    }

    /**
     * Let the panel be dragged anywhere, and remember where it was left.
     *
     * It is fixed over the game and defaults to the top-right, which is where
     * the game puts its own gold counter and Bulk Sell controls — on a narrow
     * window it lands on top of them. Rather than guess a position that suits
     * every layout, it moves.
     *
     * Dragging starts only on the panel's own background, so the select and the
     * buttons keep working: a drag beginning on a control would swallow the
     * click that was meant for it.
     *
     * @param {HTMLElement} chip - The panel
     */
    _makeDraggable(chip) {
        const applyPosition = (left, top) => {
            // Kept on screen. A panel dragged off the edge cannot be dragged
            // back, and the only way out would be reinstalling the script.
            const maxLeft = Math.max(0, window.innerWidth - chip.offsetWidth);
            const maxTop = Math.max(0, window.innerHeight - chip.offsetHeight);
            chip.style.left = `${Math.min(Math.max(0, left), maxLeft)}px`;
            chip.style.top = `${Math.min(Math.max(0, top), maxTop)}px`;
            chip.style.right = 'auto';
        };

        if (this.panelPosition) {
            // Applied after layout so offsetWidth is real, or the clamp above
            // would measure a panel that has not been sized yet
            setTimeout(() => applyPosition(this.panelPosition.left, this.panelPosition.top), 0);
        }

        chip.style.cursor = 'move';
        // Pointer events so a finger works too; mousedown never fires on a
        // touchscreen, and touch-action:none stops the browser claiming the
        // gesture for scrolling
        chip.style.touchAction = 'none';
        chip.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('button, select, input')) return;
            e.preventDefault();

            const rect = chip.getBoundingClientRect();
            const grabX = e.clientX - rect.left;
            const grabY = e.clientY - rect.top;

            const onMove = (move) => applyPosition(move.clientX - grabX, move.clientY - grabY);
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                document.removeEventListener('pointercancel', onUp);
                const final = chip.getBoundingClientRect();
                this.panelPosition = { left: final.left, top: final.top };
                storage.set(PANEL_POSITION_KEY, this.panelPosition, 'settings');
            };

            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
            document.addEventListener('pointercancel', onUp);
        });
    }

    /**
     * Floating control panel, fixed near the top-right so the click targets
     * never move between marketplace subviews or items.
     */
    _buildPanel() {
        const chip = document.createElement('div');
        chip.id = CHIP_ID;
        chip.style.cssText =
            'position:fixed; top:70px; right:24px; z-index:9000; display:flex; align-items:center; gap:6px; ' +
            'padding:5px 9px; border-radius:7px; background:rgba(12,16,30,0.94); border:1px solid rgba(74,158,255,0.45); ' +
            'color:#e0e0e0; font-size:12px; font-family:inherit; box-shadow:0 3px 10px rgba(0,0,0,0.45); user-select:none;';

        const status = document.createElement('span');
        status.className = `${CHIP_ID}-status`;
        status.style.cssText = 'max-width:340px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

        const tabSel = document.createElement('select');
        tabSel.className = `${CHIP_ID}-tab`;
        tabSel.title =
            'What to sell. "Watchlist" is whatever the Watchlist is tracking, at every enhancement level. ' +
            'A Toolasha inventory tab sells only the items assigned to it (a parent tab includes its child tabs), ' +
            'and items also assigned to a tab above the selected one are kept rather than sold.';
        tabSel.style.cssText =
            'display:none; border:1px solid rgba(74,158,255,0.35); border-radius:5px; background:rgba(20,26,44,0.95); ' +
            'color:#cfd8ea; font-size:12px; padding:2px 4px; max-width:150px; cursor:pointer; font-family:inherit;';
        tabSel.addEventListener('change', () => {
            this.selectedTabId = tabSel.value;
            const prefKey = this._tabPrefKey();
            if (prefKey) storage.set(prefKey, tabSel.value, 'settings');
        });
        tabSel.addEventListener('focus', () => this._populateTabSelect());

        const mainBtn = document.createElement('button');
        mainBtn.className = `${CHIP_ID}-main`;
        mainBtn.style.cssText =
            'border:0; border-radius:5px; background:rgba(74,158,255,0.25); color:#9ec4ff; font-weight:700; ' +
            'font-size:12px; padding:3px 10px; cursor:pointer; font-family:inherit; white-space:nowrap;';
        mainBtn.addEventListener('click', () => this._onMainClick());

        const stopBtn = document.createElement('button');
        stopBtn.className = `${CHIP_ID}-stop`;
        // Spelled out rather than an ✕, now that there is a close button beside
        // it. Two identical glyphs a few pixels apart, one abandoning a run and
        // one only hiding the panel, is a mis-click waiting to happen.
        stopBtn.textContent = 'Stop';
        stopBtn.title = 'Stop bulk selling';
        stopBtn.style.cssText =
            'display:none; border:0; border-radius:5px; background:rgba(244,67,54,0.25); color:#ff8a80; ' +
            'font-weight:700; font-size:12px; padding:3px 7px; cursor:pointer; font-family:inherit;';
        stopBtn.addEventListener('click', () => this._stop('Stopped'));

        // Closing ends the run. The panel is the only thing showing what is
        // being sold and how far through it is, so leaving a run going behind a
        // closed panel would mean the next confirm click lands on a sale you
        // can no longer see coming. Hiding it from the tab still leaves it
        // running, because that is a different gesture with the panel's
        // progress one click away.
        const closeBtn = document.createElement('button');
        closeBtn.className = `${CHIP_ID}-close`;
        closeBtn.textContent = '\u2715';
        closeBtn.title = 'Close the panel. This also stops a run in progress.';
        closeBtn.style.cssText =
            'border:0; border-radius:5px; background:transparent; color:#7d879c; font-size:12px; ' +
            'line-height:1; padding:3px 5px; cursor:pointer; font-family:inherit;';
        closeBtn.addEventListener('click', () => {
            if (this.state !== 'idle' && this.state !== 'done') this._stop('Stopped');
            this._togglePanel();
        });
        closeBtn.addEventListener('mouseenter', () => (closeBtn.style.color = '#e0e0e0'));
        closeBtn.addEventListener('mouseleave', () => (closeBtn.style.color = '#7d879c'));

        // The rules it decides by, one click away rather than on the settings
        // page. The moment you want to change one of these is the moment you
        // are watching it make the wrong call.
        const gear = document.createElement('button');
        gear.className = `${CHIP_ID}-gear`;
        gear.textContent = '\u2699';
        gear.title = 'Show the rules this decides by';
        gear.style.cssText =
            'border:0; border-radius:5px; background:rgba(255,255,255,0.08); color:#cfd8ea; font-size:12px; ' +
            'line-height:1; padding:3px 6px; cursor:pointer; font-family:inherit;';
        gear.addEventListener('click', () => {
            this.rulesOpen = !this.rulesOpen;
            this._renderRules();
        });

        const row = document.createElement('div');
        row.style.cssText = 'display:flex; align-items:center; gap:6px;';
        row.append(status, tabSel, mainBtn, stopBtn, gear, closeBtn);

        const rules = document.createElement('div');
        rules.className = `${CHIP_ID}-rules`;
        rules.style.cssText = 'display:none; flex-direction:column; gap:4px; padding-top:6px; margin-top:2px;';

        // The chip is a row; with the rules under it, it is a column of two
        chip.style.flexDirection = 'column';
        chip.style.alignItems = 'stretch';
        chip.appendChild(row);
        chip.appendChild(rules);

        this._makeDraggable(chip);
        document.body.appendChild(chip);
        this.chip = chip;
        this._render();
        this._renderRules();
        this._populateTabSelect();
    }

    /**
     * The decision rules, as editable fields.
     *
     * Written straight into the settings the decision already reads, so this is
     * the same switch as the settings page rather than a copy of it — there is
     * no third place for the two to disagree in.
     */
    _renderRules() {
        const rules = this.chip?.querySelector(`.${CHIP_ID}-rules`);
        if (!rules) return;

        rules.style.display = this.rulesOpen ? 'flex' : 'none';
        if (!this.rulesOpen) return;

        rules.textContent = '';
        const border = document.createElement('div');
        border.style.cssText = 'border-top:1px solid rgba(74,158,255,0.25); margin-bottom:2px;';
        rules.appendChild(border);

        const note = document.createElement('div');
        note.textContent = 'Any one of these makes it insta-sell instead of listing. 0 turns a rule off.';
        note.style.cssText = 'color:#7d879c; font-size:11px; max-width:340px; white-space:normal;';
        rules.appendChild(note);

        for (const tunable of TUNABLES) {
            const line = document.createElement('label');
            line.style.cssText =
                'display:flex; align-items:center; gap:6px; font-size:11px; color:#cfd8ea; white-space:nowrap;';
            line.title = tunable.title;

            const text = document.createElement('span');
            text.textContent = tunable.label;
            text.style.cssText = 'flex:1;';

            const input = document.createElement('input');
            input.type = 'number';
            input.min = '0';
            input.value = String(config.getSettingValue(tunable.key, tunable.fallback));
            input.style.cssText =
                'width:90px; border:1px solid rgba(74,158,255,0.35); border-radius:4px; ' +
                'background:rgba(20,26,44,0.95); color:#cfd8ea; font-size:11px; padding:2px 4px; font-family:inherit;';
            // On change rather than on every keystroke: half a typed number is
            // a rule, and one that would be applied the moment it was typed
            input.addEventListener('change', () => {
                const value = Number(input.value);
                if (!Number.isFinite(value) || value < 0) {
                    input.value = String(config.getSettingValue(tunable.key, tunable.fallback));
                    return;
                }
                config.setSetting(tunable.key, value);
            });
            // The chip is dragged by its background; a field you cannot click
            // into is not a field
            input.addEventListener('mousedown', (event) => event.stopPropagation());

            const suffix = document.createElement('span');
            suffix.textContent = tunable.suffix;
            suffix.style.cssText = 'color:#7d879c; width:38px;';

            line.append(text, input, suffix);
            rules.appendChild(line);
        }

        const vendor = document.createElement('label');
        vendor.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:11px; color:#cfd8ea;';
        vendor.title =
            'When the vendor pays at least what the market would net after tax, open the vendor sale instead. ' +
            'Unenhanced items only.';
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = Boolean(config.getSetting('market_bulkSellVendorCheck'));
        box.addEventListener('mousedown', (event) => event.stopPropagation());
        box.addEventListener('change', () => config.setSetting('market_bulkSellVendorCheck', box.checked));
        const vendorText = document.createElement('span');
        vendorText.textContent = 'Vendor when the market is no better';
        vendor.append(box, vendorText);
        rules.appendChild(vendor);
    }

    /**
     * Fill the tab filter with the character's Toolasha inventory tabs.
     * Hidden entirely when no custom tabs exist. Options refresh on focus so
     * tab edits made mid-session show up; the rebuild is skipped when nothing
     * changed to avoid closing an open dropdown.
     */
    async _populateTabSelect() {
        const sel = this.chip?.querySelector(`.${CHIP_ID}-tab`);
        if (!sel) return;
        let tabs = [];
        try {
            if (!this._tabPrefLoaded) {
                this._tabPrefLoaded = true;
                const prefKey = this._tabPrefKey();
                const saved = prefKey ? await storage.get(prefKey, 'settings', null) : null;
                if (saved) this.selectedTabId = saved;
            }
            const tabConfig = await loadTabConfig(dataManager.getCurrentCharacterId());
            tabs = tabConfig.tabs || [];
        } catch (error) {
            console.error('[BulkSellAssistant] Failed to load inventory tab config:', error);
        }

        // The Watchlist is a list of items like a tab is, so it belongs in the
        // same picker rather than as a second control beside it. Offered only
        // when it has something in it — an empty source would build an empty
        // queue and look like a broken button.
        const options = [{ value: 'all', label: 'All items' }];
        if (this._watchlistItems().size) options.push({ value: WATCHLIST_SOURCE, label: 'Watchlist' });
        const walk = (nodes, depth) => {
            for (const node of nodes) {
                options.push({ value: node.id, label: `${'\u00A0\u00A0'.repeat(depth)}${node.name}` });
                if (node.children?.length) walk(node.children, depth + 1);
            }
        };
        walk(tabs, 0);

        this._hasTabs = options.length > 1;
        const signature = JSON.stringify(options);
        if (sel.dataset.signature !== signature) {
            sel.dataset.signature = signature;
            sel.textContent = '';
            for (const opt of options) {
                const o = document.createElement('option');
                o.value = opt.value;
                o.textContent = opt.label;
                sel.appendChild(o);
            }
        }
        sel.value = options.some((o) => o.value === this.selectedTabId) ? this.selectedTabId : 'all';
        this.selectedTabId = sel.value;
        this._render();
    }

    _render() {
        if (!this.chip) return;
        const status = this.chip.querySelector(`.${CHIP_ID}-status`);
        const tabSel = this.chip.querySelector(`.${CHIP_ID}-tab`);
        const mainBtn = this.chip.querySelector(`.${CHIP_ID}-main`);
        const stopBtn = this.chip.querySelector(`.${CHIP_ID}-stop`);
        const progress = this.queue.length ? `${Math.min(this.index + 1, this.queue.length)}/${this.queue.length}` : '';

        if (this.state === 'idle' || this.state === 'done') {
            status.textContent = this.statusNote || 'Sell every tradable inventory item, one confirm per item';
            status.style.display = this.statusNote || this.state === 'done' ? '' : 'none';
            tabSel.style.display = this._hasTabs ? '' : 'none';
            mainBtn.textContent = '▶ Bulk Sell';
            mainBtn.title =
                'Queue every tradable inventory item (or only the selected Toolasha tab), most valuable stack first. Each item opens a prefilled sell modal — oversupplied or slow-queue items insta-sell to the best bid, others list at the ask. Confirming the modal advances to the next item.';
            stopBtn.style.display = 'none';
            return;
        }

        status.style.display = '';
        tabSel.style.display = 'none';
        stopBtn.style.display = '';
        if (this.state === 'preparing') {
            status.textContent = `${progress} · checking ${this.current?.name || ''}${this.statusNote ? ` (${this.statusNote})` : ''}…`;
            mainBtn.textContent = '⏭ Skip';
            mainBtn.title = 'Skip this item';
        } else if (this.state === 'awaiting_confirm') {
            const d = this.decision;
            const verb = d?.vendor ? 'Vendor-sell' : d?.insta ? 'Insta-sell' : 'List';
            const confirmHint = d?.vendor ? 'click Sell For in the item menu' : 'confirm in modal';
            const shown = d?.insta && d.avgPrice ? d.avgPrice : d?.price || 0;
            status.textContent = `${progress} · ${verb} ${this.current.count}× ${this.current.name} @ ${d?.insta ? '~' : ''}${formatKMB(shown)} (${d?.reason}) — ${confirmHint}`;
            mainBtn.textContent = '⏭ Skip';
            mainBtn.title = 'Close the modal and skip this item';
        } else if (this.state === 'awaiting_next') {
            status.textContent = `${progress} · ${this.current?.name || ''} dealt with — press Next for the next item`;
            mainBtn.textContent = '▶ Next';
            mainBtn.title = 'Open the next item. Its own click, so one click never does two game actions.';
        }
    }

    _onMainClick() {
        if (this.state === 'idle' || this.state === 'done') {
            this._start();
        } else if (this.state === 'awaiting_next') {
            this.index++;
            this.state = 'preparing';
            this._render();
            this._prepareCurrent();
        } else {
            this._skip('skipped');
        }
    }

    async _start() {
        // Resolve the tab filter first: a Toolasha inventory tab stores plain
        // hrids for +0 items and "hrid+level" for enhanced ones
        let tabItems = null;
        let aboveItems = null;
        let watchedHrids = null;
        let tabName = '';
        if (this.selectedTabId === WATCHLIST_SOURCE) {
            watchedHrids = this._watchlistItems();
            tabName = 'Watchlist';
            if (!watchedHrids.size) {
                this.statusNote = 'Nothing on the watchlist';
                this.state = 'idle';
                this._render();
                return;
            }
        } else if (this.selectedTabId && this.selectedTabId !== 'all') {
            try {
                const tabConfig = await loadTabConfig(dataManager.getCurrentCharacterId());
                const found = findTab(tabConfig, this.selectedTabId);
                if (!found) {
                    this.statusNote = 'Selected tab no longer exists';
                    this.state = 'idle';
                    this._render();
                    this._populateTabSelect();
                    return;
                }
                tabItems = collectTabItems(found.tab);
                // Tabs above the selected one act as keep-lists: an item also
                // assigned to any of them is never sold
                aboveItems = collectItemsAboveTab(tabConfig, this.selectedTabId);
                tabName = found.tab.name;
            } catch (error) {
                console.error('[BulkSellAssistant] Failed to load inventory tab config:', error);
                this.statusNote = 'Could not load tab config';
                this.state = 'idle';
                this._render();
                return;
            }
        }

        const clientData = dataManager.getInitClientData();
        // Gear saved into a loadout is gear you are still using — just not right
        // now. Through the hold mechanism rather than a filter of its own, so it
        // is counted and reported like every other claim on the inventory.
        const providers = new Map(this.holdProviders);
        providers.set('loadouts', () => loadoutHoldKeys());
        const heldKeys = collectHeldKeys(providers, (name, error) =>
            console.error(`[BulkSellAssistant] Hold provider "${name}" failed; its items are not held:`, error)
        );
        let held = 0;
        let enhanced = 0;
        const items = (dataManager.characterItems || []).filter((item) => {
            if (item.itemLocationHrid !== '/item_locations/inventory') return false;
            if ((item.count || 0) <= 0) return false;
            if (item.itemHrid === '/items/coin') return false;
            if (!clientData?.itemDetailMap?.[item.itemHrid]?.isTradable) return false;
            const key = holdKey(item.itemHrid, item.enhancementLevel);
            // Held items are counted, not silently dropped: an item vanishing
            // from the sell queue with no explanation is indistinguishable from
            // a bug
            if (heldKeys.has(key)) {
                held++;
                return false;
            }
            if (tabItems) {
                if (!tabItems.has(key)) return false;
                if (aboveItems.has(key)) return false;
            }
            // Matched on the hrid rather than the key: the watchlist tracks an
            // item, not an item at a level, so every level of a tracked item is
            // in scope. A tab is the other way round and keeps its own keys.
            if (watchedHrids) {
                if (!watchedHrids.has(item.itemHrid)) return false;
                // …which is exactly why enhanced gear is left out of it. The
                // list tracks "Gobo Defender"; matching every level of that
                // swept a +10 into the queue at six million coins. A tab names
                // the level it means, so it is trusted to mean it.
                if ((item.enhancementLevel || 0) > 0) {
                    enhanced++;
                    return false;
                }
            }
            return true;
        });
        this.heldCount = held;
        this.enhancedSkipped = enhanced;
        // Most expensive stack first: cached market unit price (ask, else bid) × count
        this.queue = items
            .map((item) => {
                const enhancementLevel = item.enhancementLevel || 0;
                const price = marketAPI.getPrice(item.itemHrid, enhancementLevel);
                return {
                    itemHrid: item.itemHrid,
                    enhancementLevel,
                    count: item.count,
                    name: clientData.itemDetailMap[item.itemHrid]?.name || item.itemHrid.split('/').pop(),
                    stackValue: (price?.ask ?? price?.bid ?? 0) * item.count,
                };
            })
            .sort(
                (a, b) =>
                    b.stackValue - a.stackValue ||
                    a.name.localeCompare(b.name) ||
                    a.enhancementLevel - b.enhancementLevel
            );

        if (!this.queue.length) {
            const why = this._skipNote();
            this.statusNote = tabName
                ? `No tradable items in "${tabName}"${why}`
                : `No tradable items in inventory${why}`;
            this.state = 'idle';
            this._render();
            return;
        }
        this.index = 0;
        // Say so rather than letting the count quietly differ from what is in
        // the inventory
        this.statusNote = this._skipNote({ bare: true });
        this._prepareCurrent();
    }

    _prepareCurrent() {
        this._clearTransient();
        if (this.index >= this.queue.length) {
            this.state = 'done';
            this.statusNote = `Done — ${this.queue.length} items processed`;
            this._render();
            return;
        }
        this.current = this.queue[this.index];
        this.decision = null;
        this.state = 'preparing';
        this._render();

        // Vendor check runs BEFORE any marketplace navigation: the item action
        // menu must be the only thing touching the UI, or the navigation's
        // trailing clicks/re-renders dismiss it right after it opens
        if (this._tryVendorSell()) return;

        navigateToMarketplace(this.current.itemHrid, this.current.enhancementLevel);
        // No order book within the timeout → item isn't marketable right now
        this.bookTimeout = setTimeout(() => this._skip('no market data'), 3000);
    }

    /**
     * Vendor beats the market when its flat price matches or exceeds the
     * cached market price net of the 5% tax (e.g. ask 100 → 95 net = 95
     * vendor). Cached prices are plenty accurate for this comparison and let
     * the decision happen without navigating the marketplace.
     * @returns {boolean} True when the vendor flow was opened
     */
    _tryVendorSell() {
        if (!config.getSetting('market_bulkSellVendorCheck')) return false;
        if (this.current.enhancementLevel !== 0) return false;
        const vendorPrice = dataManager.getInitClientData()?.itemDetailMap?.[this.current.itemHrid]?.sellPrice || 0;
        if (vendorPrice <= 0) return false;
        const cached = marketAPI.getPrice(this.current.itemHrid, 0);
        const ask = cached?.ask ?? null;
        const bid = cached?.bid ?? null;
        if (ask === null && bid === null) return false;

        // Vendor must beat the market path the decision rules would actually
        // take: below the minimum listing value the insta path is forced, so
        // vendor competes with the bid; otherwise with the ask a listing
        // would target
        const rawMin = Number(config.getSettingValue('market_bulkSellMinListingValue', 1500000));
        const minListingValue = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : 1500000;
        const stackValue = this.current.count * (ask ?? bid);
        const wouldInsta = minListingValue > 0 && stackValue < minListingValue;
        const referencePrice = (wouldInsta ? (bid ?? ask) : (ask ?? bid)) || 0;
        if (referencePrice <= 0) return false;
        const marketNet = Math.floor(referencePrice * (1 - MARKET_TAX));
        if (vendorPrice < marketNet) return false;
        return this._openVendorSell(vendorPrice, marketNet);
    }

    _onOrderBook(data) {
        if (this.state !== 'preparing' || !this.current) return;
        if (data.marketItemOrderBooks?.itemHrid !== this.current.itemHrid) return;
        clearTimeout(this.bookTimeout);
        this.bookTimeout = null;

        const orderBooks = data.marketItemOrderBooks.orderBooks;
        const book = Array.isArray(orderBooks)
            ? orderBooks[this.current.enhancementLevel]
            : orderBooks?.[String(this.current.enhancementLevel)];
        this._decideAndOpen(book || null);
    }

    /**
     * Decide insta-sell vs listing per the order book, then open the matching
     * game modal (the quantity is prefilled when it appears).
     * Four configurable insta-sell rules (any one triggers, 0 disables it):
     * ask supply exceeds bid demand × the supply ratio, the front ask listing
     * has waited longer than the queue-age limit (queue isn't moving), the
     * stack is worth less than the minimum listing value (not worth a slot),
     * or the ask−bid spread is at most the configured percentage of the ask
     * (a listing's whole edge over insta-selling is the spread, and a sliver
     * of an edge is not worth the slot and the wait).
     */
    _decideAndOpen(book) {
        const asks = book?.asks || [];
        const bids = book?.bids || [];
        if (!asks.length && !bids.length) {
            this._skip('no orders');
            return;
        }

        const remaining = (rows) =>
            rows.reduce(
                (sum, row) => sum + Math.max(0, (row.orderQuantity ?? row.quantity ?? 0) - (row.filledQuantity ?? 0)),
                0
            );
        const askQty = remaining(asks);
        const bidQty = remaining(bids);

        const readNumberSetting = (key, fallback) => {
            const raw = Number(config.getSettingValue(key, fallback));
            return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
        };
        const queueDaysLimit = readNumberSetting('market_bulkSellQueueDays', 2);
        const supplyRatio = readNumberSetting('market_bulkSellSupplyRatio', 1);
        const minListingValue = readNumberSetting('market_bulkSellMinListingValue', 1500000);
        const maxSpreadPct = readNumberSetting('market_bulkSellMaxSpreadPct', 0);
        const minPatientPremium = readNumberSetting('market_bulkSellMinPatientPremium', 0);

        let frontAskDays = 0;
        const created = asks[0]?.createdTimestamp;
        if (created) {
            frontAskDays = Math.max(0, (Date.now() - new Date(created).getTime()) / MS_PER_DAY);
        }

        // The patient side is priced at what a listing could actually reach: a
        // listing outside the game's tradable range is rejected by the server,
        // so an unclamped ask overstates what waiting earns and can wrongly
        // choose listing. The bid stays raw on purpose — insta fills against
        // the real resting bid, wherever it happens to sit.
        const askRaw = asks[0]?.price ?? null;
        const askPrice = clampToBand(askRaw, this.current.itemHrid, this.current.enhancementLevel) ?? 0;
        const bidPrice = bids[0]?.price ?? 0;

        // Value the stack at the (banded) ask — what a listing would target
        const stackValue = this.current.count * (askPrice || bidPrice || 0);
        // The listing's whole edge over insta-selling is the ask−bid spread.
        // With the game's finer price increments that edge is often a sliver,
        // and a sliver is not worth a listing slot plus the queue wait. Stated
        // both ways: as a share of the ask, and as the after-tax coins the
        // whole stack would earn by waiting.
        const spreadPct = askPrice > 0 && bidPrice > 0 ? ((askPrice - bidPrice) / askPrice) * 100 : null;
        const patientPremium =
            askPrice > 0 && bidPrice > 0
                ? Math.max(0, (askPrice - bidPrice) * this.current.count * (1 - MARKET_TAX))
                : null;
        const supplyTriggered = supplyRatio > 0 && askQty > bidQty * supplyRatio;
        const ageTriggered = queueDaysLimit > 0 && frontAskDays > queueDaysLimit;
        const valueTriggered = minListingValue > 0 && stackValue < minListingValue;
        const spreadTriggered = maxSpreadPct > 0 && spreadPct !== null && spreadPct <= maxSpreadPct;
        const premiumTriggered = minPatientPremium > 0 && patientPremium !== null && patientPremium < minPatientPremium;
        const insta =
            (supplyTriggered || ageTriggered || valueTriggered || spreadTriggered || premiumTriggered) &&
            bids.length > 0;

        // The top bid's price only holds for the top bid's quantity. An insta
        // sell of the whole stack fills every bid at or above the price the
        // form names, so the price is walked down the book until the depth
        // covers the count — otherwise the modal claims a price the trade
        // cannot get and sells only part of the stack. The fill itself is
        // best-first: each unit sells at the best remaining bid, and only the
        // remainder the better levels could not absorb takes the walked price
        // — so what the run actually earns is the cumulative sum, and that
        // (as a per-unit average) is what the chip reports.
        let instaPrice = bids[0]?.price ?? 0;
        let instaAvg = instaPrice;
        let depthShort = false;
        if (insta) {
            let covered = 0;
            let proceeds = 0;
            for (const row of bids) {
                const available = Math.max(0, (row.orderQuantity ?? row.quantity ?? 0) - (row.filledQuantity ?? 0));
                const taken = Math.min(available, this.current.count - covered);
                covered += taken;
                proceeds += taken * row.price;
                instaPrice = row.price;
                if (covered >= this.current.count) break;
            }
            depthShort = covered < this.current.count;
            instaAvg = covered > 0 ? proceeds / covered : instaPrice;
        }
        const price = insta ? instaPrice : askPrice || bidPrice || 0;

        const ratioLabel = supplyRatio === 1 ? '' : ` ×${supplyRatio}`;
        const reason = insta
            ? supplyTriggered
                ? `supply ${formatKMB(askQty)} > demand ${formatKMB(bidQty)}${ratioLabel}`
                : ageTriggered
                  ? `ask queue ~${frontAskDays.toFixed(1)}d`
                  : valueTriggered
                    ? `stack ${formatKMB(stackValue)} < ${formatKMB(minListingValue)} min`
                    : spreadTriggered
                      ? `spread ${spreadPct.toFixed(1)}% ≤ ${maxSpreadPct}%`
                      : `listing earns ~${formatKMB(Math.round(patientPremium))} < ${formatKMB(minPatientPremium)} premium`
            : 'queue ok';
        const depthNote =
            insta && instaPrice < (bids[0]?.price ?? 0)
                ? `; fills best-first to ${formatKMB(instaPrice)} so the depth covers the stack` +
                  `${depthShort ? ' (book still short)' : ''}`
                : '';
        this.decision = { insta, price, avgPrice: insta ? instaAvg : null, reason: reason + depthNote };

        const open = insta
            ? marketplaceShortcuts.clickInstantActionButton('Sell')
            : marketplaceShortcuts.clickListingButton('+ New Sell Listing', 'Button_sell');
        open.then(() => {
            if (this.state !== 'preparing') return;
            this.state = 'awaiting_confirm';
            this._render();
            this._watchClose();
        }).catch(() => this._skip('sell button not found'));
    }

    /**
     * Vendor path: open the item's inventory action menu, click "All" so the
     * whole stack is entered, and wait for the user's click on the game's
     * "Sell For … Coins" button (the one server action). Falls back to the
     * normal market flow when the inventory tile or menu can't be found.
     * @param {number} vendorPrice - Per-item vendor price
     * @param {number} marketNet - Per-item market price net of the 5% tax
     * @returns {boolean} Whether the vendor flow was opened
     */
    _openVendorSell(vendorPrice, marketNet) {
        const iconName = this.current.itemHrid.split('/').pop();
        const tiles = document.querySelectorAll('[class*="Inventory_items"] [class*="Item_itemContainer"]');
        let tile = null;
        for (const container of tiles) {
            const href = container.querySelector('svg use')?.getAttribute('href') || '';
            if (!href.endsWith(`#${iconName}`)) continue;
            // Vendor path only runs for +0 items — skip enhanced variants
            if (container.querySelector('[class*="Item_enhancementLevel"]')) continue;
            tile = container;
            break;
        }
        // Tile not visible (inventory panel closed / filtered) — let the
        // caller fall back to the normal market flow
        if (!tile) return false;

        (tile.querySelector('[class*="Item_item"]') || tile).dispatchEvent(
            new MouseEvent('click', { bubbles: true, cancelable: true })
        );

        // Wait for the menu, retrying once — clicking the tile again reopens
        // it if something dismissed the first attempt
        const awaitMenu = (attempt) => {
            if (this.state !== 'preparing') return;
            const menu = document.querySelector('[class*="Item_actionMenu"]');
            if (!menu) {
                if (attempt < 2) {
                    (tile.querySelector('[class*="Item_item"]') || tile).dispatchEvent(
                        new MouseEvent('click', { bubbles: true, cancelable: true })
                    );
                    setTimeout(() => awaitMenu(attempt + 1), 400);
                } else {
                    this._skip('item menu did not open');
                }
                return;
            }
            const allBtn = Array.from(menu.querySelectorAll('button')).find((b) => b.textContent.trim() === 'All');
            allBtn?.click();
            this.decision = {
                insta: false,
                vendor: true,
                price: vendorPrice,
                reason: `vendor ${formatKMB(vendorPrice)} ≥ market net ${formatKMB(marketNet)}`,
            };
            this.state = 'awaiting_confirm';
            this._render();
            this._watchClose('[class*="Item_actionMenu"]');
        };
        setTimeout(() => awaitMenu(1), 350);
        return true;
    }

    /** Prefill the quantity when the sell modal opens during a run */
    _onModal(modal) {
        if (this.state !== 'preparing' && this.state !== 'awaiting_confirm') return;
        if (!this.current) return;
        const header = modal.querySelector('div[class*="MarketplacePanel_header"]');
        const text = header?.textContent || '';
        if (!text.includes('Sell Now') && !text.includes('Sell Listing')) return;

        const count = this.current.count;
        setTimeout(() => {
            const input = marketplaceShortcuts.findQuantityInput(modal);
            if (!input) return;
            nativeInputValueSetter.call(input, String(count));
            input.dispatchEvent(new Event('input', { bubbles: true }));
        }, 120);

        // An insta sell's price must be the depth-walked one, not the game's
        // best-bid default: Sell Now fills every bid at or above the price the
        // form names, and the default only clears the top level's quantity.
        // The rebuilt price control sleeps as a display div until clicked, so
        // wake it first and write on the next beat.
        if (text.includes('Sell Now') && this.decision?.insta && this.decision.price > 0) {
            const price = this.decision.price;
            setTimeout(() => {
                const priceRow = modal.querySelector('div[class*="MarketplacePanel_priceInputs"]');
                if (!priceRow) return;
                if (!priceRow.querySelector('input')) {
                    priceRow.querySelector('div[class*="MarketplacePanel_priceDisplay"]')?.click();
                }
                setTimeout(() => {
                    const priceInput = priceRow.querySelector('input');
                    if (!priceInput) return;
                    nativeInputValueSetter.call(priceInput, String(price));
                    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
                }, 150);
            }, 200);
        }
    }

    /**
     * Advance to the next item when the given element closes — confirmed or
     * dismissed, either way this item is dealt with.
     * @param {string} [selector] - Element whose disappearance means done
     */
    _watchClose(selector = '[class*="Modal_modalContainer"]') {
        let seen = false;
        this.modalPoll = setInterval(() => {
            if (this.state !== 'awaiting_confirm') {
                clearInterval(this.modalPoll);
                this.modalPoll = null;
                return;
            }
            const open = !!document.querySelector(selector);
            if (open) {
                seen = true;
            } else if (seen) {
                clearInterval(this.modalPoll);
                this.modalPoll = null;
                // Not straight to the next item: the click that closed this
                // modal has already done its one game action (the sale), and
                // opening the next item's book is another. The run waits for
                // its own Next press, so every server action has a click of
                // its own.
                this.state = 'awaiting_next';
                this._render();
            }
        }, 200);
    }

    _skip(note) {
        this._clearTransient();
        // Close any modal the run opened so it can't linger over the next item
        document.querySelector('[class*="Modal_modalContainer"] [class*="Modal_closeButton"]')?.click();
        // Dismiss an open item action menu (vendor path) the same way the
        // game does — via Escape
        if (document.querySelector('[class*="Item_actionMenu"]')) {
            document.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    code: 'Escape',
                    keyCode: 27,
                    which: 27,
                    bubbles: true,
                    cancelable: true,
                })
            );
        }
        this.statusNote = note || '';
        this.index++;
        this.state = 'preparing';
        this._render();
        this.advanceTimeout = setTimeout(() => this._prepareCurrent(), 600);
    }

    _stop(note) {
        this._clearTransient();
        this.state = 'idle';
        this.queue = [];
        this.index = 0;
        this.current = null;
        this.decision = null;
        this.statusNote = note || '';
        this._render();
    }

    _clearTransient() {
        if (this.bookTimeout) {
            clearTimeout(this.bookTimeout);
            this.bookTimeout = null;
        }
        if (this.advanceTimeout) {
            clearTimeout(this.advanceTimeout);
            this.advanceTimeout = null;
        }
        if (this.modalPoll) {
            clearInterval(this.modalPoll);
            this.modalPoll = null;
        }
        this.statusNote = '';
    }

    cleanup() {
        this._stop('');
        if (this.watcher) {
            this.watcher();
            this.watcher = null;
        }
        if (this.bookHandler) {
            dataManager.off('market_item_order_books_updated', this.bookHandler);
            this.bookHandler = null;
        }
        if (this.modalUnregister) {
            this.modalUnregister();
            this.modalUnregister = null;
        }
        this._removeButton();
        this._removePanel();
        this.panelVisible = false;
        this.isInitialized = false;
    }

    disable() {
        this.cleanup();
    }
}

const bulkSellAssistant = new BulkSellAssistant();
export default bulkSellAssistant;
