/**
 * Bulk Sell Assistant
 *
 * Sells the whole inventory through the market one item at a time with one
 * game action per click. A Bulk Sell button in the marketplace tab bar (next
 * to Market History) shows/hides the floating control panel.
 * Start builds a queue of tradable inventory items —
 * optionally limited to one Toolasha custom inventory tab (children included);
 * for each item it navigates to its order book, decides between insta-selling
 * (ask supply exceeds bid demand, or the front of the ask queue is older than
 * the configured threshold — the queue isn't moving) and posting a sell
 * listing, then opens the matching modal with the quantity prefilled.
 * Confirming (or closing) the modal advances to the next item automatically,
 * so after Start every sale is exactly one click on the game's confirm button
 * — always in the same place. The assistant never confirms a sale itself.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import storage from '../../core/storage.js';
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

const BUTTON_ID = 'mwi-bulk-sell-btn';
const CHIP_ID = 'mwi-bulk-sell-chip';
const PANEL_POSITION_KEY = 'bulkSellPanelPosition';
const MS_PER_DAY = 86400000;

const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;

class BulkSellAssistant {
    constructor() {
        this.isInitialized = false;
        this.watcher = null;
        this.chip = null;
        this.state = 'idle'; // idle | preparing | awaiting_confirm | done
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
         * keys. Kept deliberately ignorant of why anything is held — a flip
         * waiting to be relisted, a crafting reserve, a gift — so nothing about
         * the reason has to live in here.
         */
        this.holdProviders = new Map();
        this.heldCount = 0;
        this._hasTabs = false;
        this._tabPrefLoaded = false;
        this.toggleBtn = null;
        this.panelVisible = false;
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
     *         'flip-finder',
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
        chip.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return;
            if (e.target.closest('button, select, input')) return;
            e.preventDefault();

            const rect = chip.getBoundingClientRect();
            const grabX = e.clientX - rect.left;
            const grabY = e.clientY - rect.top;

            const onMove = (move) => applyPosition(move.clientX - grabX, move.clientY - grabY);
            const onUp = () => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const final = chip.getBoundingClientRect();
                this.panelPosition = { left: final.left, top: final.top };
                storage.set(PANEL_POSITION_KEY, this.panelPosition, 'settings');
            };

            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
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
            'Only sell items assigned to this Toolasha inventory tab (a parent tab includes its child tabs). ' +
            'Items also assigned to a tab above the selected one are kept, not sold.';
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

        chip.appendChild(status);
        chip.appendChild(tabSel);
        chip.appendChild(mainBtn);
        chip.appendChild(stopBtn);
        chip.appendChild(closeBtn);

        this._makeDraggable(chip);
        document.body.appendChild(chip);
        this.chip = chip;
        this._render();
        this._populateTabSelect();
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

        const options = [{ value: 'all', label: 'All items' }];
        const walk = (nodes, depth) => {
            for (const node of nodes) {
                options.push({ value: node.id, label: `${'\u00A0\u00A0'.repeat(depth)}${node.name}` });
                if (node.children?.length) walk(node.children, depth + 1);
            }
        };
        walk(tabs, 0);

        this._hasTabs = tabs.length > 0;
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
            status.textContent = `${progress} · ${verb} ${this.current.count}× ${this.current.name} @ ${formatKMB(d?.price || 0)} (${d?.reason}) — ${confirmHint}`;
            mainBtn.textContent = '⏭ Skip';
            mainBtn.title = 'Close the modal and skip this item';
        }
    }

    _onMainClick() {
        if (this.state === 'idle' || this.state === 'done') {
            this._start();
        } else {
            this._skip('skipped');
        }
    }

    async _start() {
        // Resolve the tab filter first: a Toolasha inventory tab stores plain
        // hrids for +0 items and "hrid+level" for enhanced ones
        let tabItems = null;
        let aboveItems = null;
        let tabName = '';
        if (this.selectedTabId && this.selectedTabId !== 'all') {
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
        const heldKeys = collectHeldKeys(this.holdProviders, (name, error) =>
            console.error(`[BulkSellAssistant] Hold provider "${name}" failed; its items are not held:`, error)
        );
        let held = 0;
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
            return true;
        });
        this.heldCount = held;
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
            this.statusNote = tabItems
                ? `No tradable items in "${tabName}"${held > 0 ? ` (${held} held back)` : ''}`
                : `No tradable items in inventory${held > 0 ? ` (${held} held back)` : ''}`;
            this.state = 'idle';
            this._render();
            return;
        }
        this.index = 0;
        // Say so rather than letting the count quietly differ from what is in
        // the inventory
        this.statusNote = held > 0 ? `${held} item${held === 1 ? '' : 's'} held back` : '';
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
     * cached market price net of the 2% tax (e.g. ask 49 → 48 net = 48
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
        const marketNet = Math.floor(referencePrice * 0.98);
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
     * Three configurable insta-sell rules (any one triggers, 0 disables it):
     * ask supply exceeds bid demand × the supply ratio, the front ask listing
     * has waited longer than the queue-age limit (queue isn't moving), or the
     * stack is worth less than the minimum listing value (not worth a slot).
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

        let frontAskDays = 0;
        const created = asks[0]?.createdTimestamp;
        if (created) {
            frontAskDays = Math.max(0, (Date.now() - new Date(created).getTime()) / MS_PER_DAY);
        }

        // Value the stack at the ask (what a listing would target)
        const stackValue = this.current.count * (asks[0]?.price ?? bids[0]?.price ?? 0);
        const supplyTriggered = supplyRatio > 0 && askQty > bidQty * supplyRatio;
        const ageTriggered = queueDaysLimit > 0 && frontAskDays > queueDaysLimit;
        const valueTriggered = minListingValue > 0 && stackValue < minListingValue;
        const insta = (supplyTriggered || ageTriggered || valueTriggered) && bids.length > 0;
        const price = insta ? bids[0].price : (asks[0]?.price ?? bids[0]?.price ?? 0);

        const ratioLabel = supplyRatio === 1 ? '' : ` ×${supplyRatio}`;
        const reason = insta
            ? supplyTriggered
                ? `supply ${formatKMB(askQty)} > demand ${formatKMB(bidQty)}${ratioLabel}`
                : ageTriggered
                  ? `ask queue ~${frontAskDays.toFixed(1)}d`
                  : `stack ${formatKMB(stackValue)} < ${formatKMB(minListingValue)} min`
            : 'queue ok';
        this.decision = { insta, price, reason };

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
     * @param {number} marketNet - Per-item market price net of the 2% tax
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
                this.index++;
                this.advanceTimeout = setTimeout(() => this._prepareCurrent(), 400);
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
