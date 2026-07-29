/**
 * Bulk Sell Assistant
 *
 * Sells the whole inventory through the market one item at a time with one
 * game action per click. Start builds a queue of tradable inventory items;
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
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { formatKMB } from '../../utils/formatters.js';
import marketplaceShortcuts from './marketplace-shortcuts.js';

const PANEL_SEL = '[class*="MarketplacePanel_marketplacePanel"]';
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

        const ensureChip = () => {
            const panel = document.querySelector(PANEL_SEL);
            if (!panel) {
                if (this.chip && document.body.contains(this.chip)) {
                    this.chip.remove();
                    this.chip = null;
                }
                return;
            }
            if (this.chip && !document.body.contains(this.chip)) this.chip = null;
            if (this.chip) return;
            this._buildChip();
        };
        this.watcher = createMutationWatcher(document.body, ensureChip, { childList: true, subtree: true });
        ensureChip();
    }

    /**
     * Fixed-position control so the click target never moves between
     * marketplace subviews or items.
     */
    _buildChip() {
        const chip = document.createElement('div');
        chip.id = CHIP_ID;
        chip.style.cssText =
            'position:fixed; top:70px; right:24px; z-index:9000; display:flex; align-items:center; gap:6px; ' +
            'padding:5px 9px; border-radius:7px; background:rgba(12,16,30,0.94); border:1px solid rgba(74,158,255,0.45); ' +
            'color:#e0e0e0; font-size:12px; font-family:inherit; box-shadow:0 3px 10px rgba(0,0,0,0.45); user-select:none;';

        const status = document.createElement('span');
        status.className = `${CHIP_ID}-status`;
        status.style.cssText = 'max-width:340px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

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
        chip.appendChild(mainBtn);
        chip.appendChild(stopBtn);
        document.body.appendChild(chip);
        this.chip = chip;
        this._render();
    }

    _render() {
        if (!this.chip) return;
        const status = this.chip.querySelector(`.${CHIP_ID}-status`);
        const mainBtn = this.chip.querySelector(`.${CHIP_ID}-main`);
        const stopBtn = this.chip.querySelector(`.${CHIP_ID}-stop`);
        const progress = this.queue.length ? `${Math.min(this.index + 1, this.queue.length)}/${this.queue.length}` : '';

        if (this.state === 'idle' || this.state === 'done') {
            status.textContent = this.statusNote || 'Sell every tradable inventory item, one confirm per item';
            status.style.display = this.statusNote || this.state === 'done' ? '' : 'none';
            mainBtn.textContent = '▶ Bulk Sell';
            mainBtn.title =
                'Queue every tradable inventory item. Each item opens a prefilled sell modal — oversupplied or slow-queue items insta-sell to the best bid, others list at the ask. Confirming the modal advances to the next item.';
            stopBtn.style.display = 'none';
            return;
        }

        status.style.display = '';
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

    _start() {
        const clientData = dataManager.getInitClientData();
        const items = (dataManager.characterItems || []).filter(
            (item) =>
                item.itemLocationHrid === '/item_locations/inventory' &&
                (item.count || 0) > 0 &&
                item.itemHrid !== '/items/coin' &&
                clientData?.itemDetailMap?.[item.itemHrid]?.isTradable
        );
        this.queue = items
            .map((item) => ({
                itemHrid: item.itemHrid,
                enhancementLevel: item.enhancementLevel || 0,
                count: item.count,
                name: clientData.itemDetailMap[item.itemHrid]?.name || item.itemHrid.split('/').pop(),
            }))
            .sort((a, b) => a.name.localeCompare(b.name) || a.enhancementLevel - b.enhancementLevel);

        if (!this.queue.length) {
            this.statusNote = 'No tradable items in inventory';
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
     * Insta-sell when ask supply exceeds bid demand, or the front ask listing
     * has been waiting longer than the threshold (the queue isn't moving).
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

        const queueDaysLimit = Math.max(0, Number(config.getSettingValue('market_bulkSellQueueDays', 2)) || 2);
        let frontAskDays = 0;
        const created = asks[0]?.createdTimestamp;
        if (created) {
            frontAskDays = Math.max(0, (Date.now() - new Date(created).getTime()) / MS_PER_DAY);
        }

        const instaWanted = askQty > bidQty || frontAskDays > queueDaysLimit;
        const insta = instaWanted && bids.length > 0;
        const price = insta ? bids[0].price : (asks[0]?.price ?? bids[0]?.price ?? 0);
        const reason = insta
            ? askQty > bidQty
                ? `supply ${formatKMB(askQty)} > demand ${formatKMB(bidQty)}`
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
        if (this.chip) {
            this.chip.remove();
            this.chip = null;
        }
        this.isInitialized = false;
    }

    disable() {
        this.cleanup();
    }
}

const bulkSellAssistant = new BulkSellAssistant();
export default bulkSellAssistant;
