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

const BUTTON_ID = 'mwi-bulk-sell-btn';
const CHIP_ID = 'mwi-bulk-sell-chip';
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
        this._hasTabs = false;
        this.toggleBtn = null;
        this.panelVisible = false;
    }

    initialize() {
        if (this.isInitialized) return;
        if (!config.getSetting('market_bulkSellAssistant')) return;
        this.isInitialized = true;

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
     * Tab-bar toggle button (Lab Sim style) that shows/hides the floating
     * panel, next to the Market History tab when present.
     */
    _ensureButton(tabBar) {
        if (this.toggleBtn && tabBar.contains(this.toggleBtn)) return;
        if (this.toggleBtn) this.toggleBtn.remove();

        const button = document.createElement('div');
        button.id = BUTTON_ID;
        button.className = 'MuiButtonBase-root MuiTab-root MuiTab-textColorPrimary css-1q2h7u5';
        button.textContent = 'Bulk Sell';
        button.title = 'Show / hide the Bulk Sell panel';
        button.style.cssText =
            'cursor:pointer; background:linear-gradient(135deg, #3a7bd5, #5f3dc4); color:#fff; border-radius:4px; ' +
            'padding:4px 10px; font-size:12px; white-space:nowrap; align-self:center; margin:0 4px;';
        button.addEventListener('click', () => this._togglePanel());

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

    _syncButton() {
        if (!this.toggleBtn) return;
        this.toggleBtn.style.outline = this.panelVisible ? '1px solid #9ec4ff' : '';
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
        stopBtn.textContent = '✕';
        stopBtn.title = 'Stop bulk selling';
        stopBtn.style.cssText =
            'display:none; border:0; border-radius:5px; background:rgba(244,67,54,0.25); color:#ff8a80; ' +
            'font-weight:700; font-size:12px; padding:3px 7px; cursor:pointer; font-family:inherit;';
        stopBtn.addEventListener('click', () => this._stop('Stopped'));

        chip.appendChild(status);
        chip.appendChild(tabSel);
        chip.appendChild(mainBtn);
        chip.appendChild(stopBtn);

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
            const verb = d?.insta ? 'Insta-sell' : 'List';
            status.textContent = `${progress} · ${verb} ${this.current.count}× ${this.current.name} @ ${formatKMB(d?.price || 0)} (${d?.reason}) — confirm in modal`;
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
        const items = (dataManager.characterItems || []).filter((item) => {
            if (item.itemLocationHrid !== '/item_locations/inventory') return false;
            if ((item.count || 0) <= 0) return false;
            if (item.itemHrid === '/items/coin') return false;
            if (!clientData?.itemDetailMap?.[item.itemHrid]?.isTradable) return false;
            if (tabItems) {
                const level = item.enhancementLevel || 0;
                const key = level > 0 ? `${item.itemHrid}+${level}` : item.itemHrid;
                if (!tabItems.has(key)) return false;
                if (aboveItems.has(key)) return false;
            }
            return true;
        });
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
            this.statusNote = tabItems ? `No tradable items in "${tabName}"` : 'No tradable items in inventory';
            this.state = 'idle';
            this._render();
            return;
        }
        this.index = 0;
        this.statusNote = '';
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

        navigateToMarketplace(this.current.itemHrid, this.current.enhancementLevel);
        // No order book within the timeout → item isn't marketable right now
        this.bookTimeout = setTimeout(() => this._skip('no market data'), 3000);
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
     * Two configurable insta-sell rules (either one triggers, 0 disables it):
     * ask supply exceeds bid demand × the supply ratio, or the front ask
     * listing has waited longer than the queue-age limit (queue isn't moving).
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

        let frontAskDays = 0;
        const created = asks[0]?.createdTimestamp;
        if (created) {
            frontAskDays = Math.max(0, (Date.now() - new Date(created).getTime()) / MS_PER_DAY);
        }

        const supplyTriggered = supplyRatio > 0 && askQty > bidQty * supplyRatio;
        const ageTriggered = queueDaysLimit > 0 && frontAskDays > queueDaysLimit;
        const insta = (supplyTriggered || ageTriggered) && bids.length > 0;
        const price = insta ? bids[0].price : (asks[0]?.price ?? bids[0]?.price ?? 0);
        const ratioLabel = supplyRatio === 1 ? '' : ` ×${supplyRatio}`;
        const reason = insta
            ? supplyTriggered
                ? `supply ${formatKMB(askQty)} > demand ${formatKMB(bidQty)}${ratioLabel}`
                : `ask queue ~${frontAskDays.toFixed(1)}d`
            : 'queue ok';
        this.decision = { insta, price, reason };

        const open = insta
            ? marketplaceShortcuts.clickInstantActionButton('Sell')
            : marketplaceShortcuts.clickListingButton('+ New Sell Listing', 'Button_sell');
        open.then(() => {
            if (this.state !== 'preparing') return;
            this.state = 'awaiting_confirm';
            this._render();
            this._watchModalClose();
        }).catch(() => this._skip('sell button not found'));
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
     * Advance to the next item when the modal closes — confirmed or dismissed,
     * either way this item is dealt with.
     */
    _watchModalClose() {
        let seen = false;
        this.modalPoll = setInterval(() => {
            if (this.state !== 'awaiting_confirm') {
                clearInterval(this.modalPoll);
                this.modalPoll = null;
                return;
            }
            const open = !!document.querySelector('[class*="Modal_modalContainer"]');
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
