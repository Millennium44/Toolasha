/**
 * Trade Ledger View Module
 *
 * A "Ledger" tab beside the Market History tab in the marketplace, showing
 * realized flip profit from your own fills: per-item rows (bought, sold,
 * realized profit, last activity), per-week summary lines, and a CSV export.
 *
 * All arithmetic lives in `src/utils/trade-ledger.js`; the records come from
 * `trade-ledger-store.js`. This module only draws, following the same tab and
 * modal conventions as `market-history-viewer.js`.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import tradeLedgerStore from './trade-ledger-store.js';
import { aggregateLedger } from '../../utils/trade-ledger.js';
import { formatKMB, formatDateTime } from '../../utils/formatters.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { visibleTabsContainer } from '../../utils/marketplace-tabs.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { attachMinimize } from '../../utils/panel-minimize.js';

/** How many weekly summary lines the modal shows. */
const WEEKS_SHOWN = 8;

/** Stable key for persisting the modal's minimized state; there is no geometry to key off. */
const PANEL_KEY = 'tradeLedgerModal';

const BASIS_TOOLTIP =
    'Average-cost basis: each sell is matched against the average price of buys recorded in this ledger ' +
    'for the same item + enhancement level. Sell proceeds are always net of the 2% market tax. ' +
    'Sells of items never bought through the ledger are shown as revenue with cost "—", not as profit.';

class TradeLedgerView {
    constructor() {
        this.isInitialized = false;
        this.modal = null;
        this.marketplaceTab = null;
        this.tabCleanupObserver = null;
        this.aggregates = null;
        this.itemNameCache = new Map();
    }

    /**
     * Initialize the feature
     */
    async initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_tradeLedger')) {
            return;
        }

        this.isInitialized = true;
        this.addMarketplaceTab();
    }

    /**
     * Add a "Ledger" tab to the marketplace tab strip, following the same
     * clone-a-real-tab convention as the Market History tab.
     */
    addMarketplaceTab() {
        const ensureTabExists = () => {
            const tabsContainer = visibleTabsContainer();
            if (!tabsContainer) return;

            const hasMarketListingsTab = Array.from(tabsContainer.children).some((btn) =>
                btn.textContent.includes('Market Listings')
            );
            if (!hasMarketListingsTab) return;

            if (tabsContainer.querySelector('[data-mwi-trade-ledger-tab="true"]')) {
                return;
            }

            const referenceTab = Array.from(tabsContainer.children).find((btn) =>
                btn.textContent.includes('My Listings')
            );
            if (!referenceTab) return;

            const tab = referenceTab.cloneNode(true);
            tab.setAttribute('data-mwi-trade-ledger-tab', 'true');

            const badgeSpan = tab.querySelector('[class*="TabsComponent_badge"]');
            if (badgeSpan) {
                badgeSpan.innerHTML = `
                    <div style="text-align: center;">
                        <div>Ledger</div>
                    </div>
                `;
            }

            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openModal();
            });

            // Sit right after the Market History tab when it exists, otherwise
            // before any pinned material tabs, otherwise at the end
            const historyTab = tabsContainer.querySelector('[data-mwi-market-history-tab="true"]');
            const firstCustomTab = Array.from(tabsContainer.children).find(
                (btn) => btn.getAttribute('data-mwi-custom-tab') === 'true'
            );
            if (historyTab) {
                historyTab.after(tab);
            } else if (firstCustomTab) {
                firstCustomTab.before(tab);
            } else {
                tabsContainer.appendChild(tab);
            }

            this.marketplaceTab = tab;
        };

        if (!this.tabCleanupObserver) {
            this.tabCleanupObserver = createMutationWatcher(
                document.body,
                () => {
                    const tabsContainer = visibleTabsContainer();
                    if (!tabsContainer) {
                        if (this.marketplaceTab && !document.body.contains(this.marketplaceTab)) {
                            this.marketplaceTab = null;
                        }
                        return;
                    }

                    const hasMarketListingsTab = Array.from(tabsContainer.children).some((btn) =>
                        btn.textContent.includes('Market Listings')
                    );
                    if (!hasMarketListingsTab) {
                        if (this.marketplaceTab && document.body.contains(this.marketplaceTab)) {
                            this.marketplaceTab.remove();
                            this.marketplaceTab = null;
                        }
                        return;
                    }

                    ensureTabExists();
                },
                { childList: true, subtree: true }
            );
        }

        ensureTabExists();
    }

    /**
     * Item display name from HRID, cached
     * @param {string} itemHrid - Item HRID
     * @returns {string} Item name
     */
    getItemName(itemHrid) {
        if (this.itemNameCache.has(itemHrid)) {
            return this.itemNameCache.get(itemHrid);
        }
        const itemDetails = dataManager.getItemDetails(itemHrid);
        const name = itemDetails?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
        this.itemNameCache.set(itemHrid, name);
        return name;
    }

    /**
     * Coins for display
     * @param {number} value - Coin amount
     * @returns {string} K/M/B formatted
     */
    formatCoins(value) {
        return formatKMB(Math.round(value), 1);
    }

    /**
     * Signed coins for display (profit/loss)
     * @param {number} value - Coin amount, either sign
     * @returns {string} e.g. "+1.2M" / "-340.0K"
     */
    formatSigned(value) {
        const rounded = Math.round(value);
        return rounded >= 0 ? `+${formatKMB(rounded, 1)}` : formatKMB(rounded, 1);
    }

    /**
     * Open the ledger modal with fresh aggregates
     */
    openModal() {
        this.aggregates = aggregateLedger(tradeLedgerStore.getRecords());

        if (!this.modal) {
            this.createModal();
        }

        this.modal.style.display = 'flex';
        this.renderContent();
    }

    /**
     * Close the modal
     */
    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
    }

    /**
     * Create the modal shell (same chrome as the Market History modal)
     */
    createModal() {
        this.modal = document.createElement('div');
        this.modal.className = 'mwi-trade-ledger-modal';
        this.modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: ${config.Z_MODAL};
        `;

        const content = document.createElement('div');
        content.className = 'mwi-trade-ledger-content';
        content.style.cssText = `
            background: rgba(10, 10, 20, 0.97);
            border: 1px solid rgba(74, 158, 255, 0.5);
            border-radius: 8px;
            padding: 20px;
            max-width: 95%;
            max-height: 90%;
            min-width: 640px;
            overflow: auto;
            color: #e8ecf5;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
        `;

        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 15px;
            padding-bottom: 12px;
            border-bottom: 1px solid rgba(74, 158, 255, 0.3);
        `;

        const title = document.createElement('h2');
        title.textContent = 'Trade Ledger';
        title.title = BASIS_TOOLTIP;
        title.style.cssText = `
            margin: 0;
            color: #8fb4ff;
        `;

        const headerRight = document.createElement('div');
        headerRight.style.cssText = `
            display: flex;
            gap: 10px;
            align-items: center;
        `;

        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export CSV';
        exportBtn.style.cssText = `
            padding: 6px 12px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        `;
        exportBtn.addEventListener('click', () => this.exportCSV());

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: #e8ecf5;
            font-size: 24px;
            cursor: pointer;
            padding: 0;
            width: 30px;
            height: 30px;
        `;
        closeBtn.addEventListener('click', () => this.closeModal());

        headerRight.appendChild(exportBtn);
        headerRight.appendChild(closeBtn);
        header.appendChild(title);
        header.appendChild(headerRight);

        const weeksContainer = document.createElement('div');
        weeksContainer.className = 'mwi-trade-ledger-weeks';
        weeksContainer.style.cssText = `
            margin-bottom: 15px;
            font-size: 13px;
            color: #aaa;
            line-height: 1.6;
        `;

        const tableContainer = document.createElement('div');
        tableContainer.className = 'mwi-trade-ledger-table-container';

        content.appendChild(header);
        content.appendChild(weeksContainer);
        content.appendChild(tableContainer);
        this.modal.appendChild(content);
        document.body.appendChild(this.modal);

        this.minimizeCtl = attachMinimize({
            panel: content,
            header,
            body: [weeksContainer, tableContainer],
            panelKey: PANEL_KEY,
            beforeEl: closeBtn,
            accent: '#e8ecf5',
        });

        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });
    }

    /**
     * Render weekly summary lines and the per-item table
     */
    renderContent() {
        this.renderWeeks();
        this.renderItemTable();
    }

    /**
     * One line per recent week: bought, sold (net), realized — or revenue when
     * no sell that week had a ledger-known cost.
     */
    renderWeeks() {
        const container = this.modal.querySelector('.mwi-trade-ledger-weeks');
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        const weeks = this.aggregates.weeks.slice(0, WEEKS_SHOWN);
        if (weeks.length === 0) {
            return;
        }

        for (const week of weeks) {
            const line = document.createElement('div');
            const weekLabel = formatDateTime(new Date(week.weekStart), { includeTime: false });
            const parts = [
                `Week of ${weekLabel}:`,
                `bought ${this.formatCoins(week.boughtCoins)}`,
                `· sold ${this.formatCoins(week.soldCoinsNet)} net`,
            ];
            line.textContent = parts.join(' ');

            const realizedSpan = document.createElement('span');
            if (week.realizedProfit !== null) {
                realizedSpan.textContent = ` · realized ${this.formatSigned(week.realizedProfit)}`;
                realizedSpan.style.color = week.realizedProfit >= 0 ? '#4ade80' : '#f87171';
                realizedSpan.title = BASIS_TOOLTIP;
            } else if (week.soldCoinsNet > 0) {
                realizedSpan.textContent = ` · realized — (revenue only, no ledger-known cost)`;
                realizedSpan.style.color = '#9ca3af';
                realizedSpan.title = BASIS_TOOLTIP;
            }
            line.appendChild(realizedSpan);

            if (week.realizedProfit !== null && week.unmatchedRevenue > 0) {
                const unmatchedSpan = document.createElement('span');
                unmatchedSpan.textContent = ` (+ ${this.formatCoins(week.unmatchedRevenue)} revenue with unknown cost)`;
                unmatchedSpan.style.color = '#9ca3af';
                unmatchedSpan.title = BASIS_TOOLTIP;
                line.appendChild(unmatchedSpan);
            }

            container.appendChild(line);
        }
    }

    /**
     * Per-item rows sorted by most recent activity
     */
    renderItemTable() {
        const tableContainer = this.modal.querySelector('.mwi-trade-ledger-table-container');
        while (tableContainer.firstChild) {
            tableContainer.removeChild(tableContainer.firstChild);
        }

        const items = this.aggregates.items;

        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.textContent =
                'No fills recorded yet. The ledger records fills on your own listings as they happen — ' +
                'place or watch some orders and come back.';
            empty.style.cssText = `
                padding: 20px;
                text-align: center;
                color: #888;
            `;
            tableContainer.appendChild(empty);
            return;
        }

        const table = document.createElement('table');
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            color: #fff;
        `;

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.cssText = 'background: #1a1a1a;';

        const headers = [
            { label: 'Item' },
            { label: 'Enh' },
            { label: 'Bought' },
            { label: 'Sold (net)', title: 'Quantity @ average proceeds per unit, after the 2% market tax' },
            { label: 'Realized', title: BASIS_TOOLTIP },
            { label: 'Last Activity' },
        ];
        for (const header of headers) {
            const th = document.createElement('th');
            th.textContent = header.label;
            if (header.title) th.title = header.title;
            th.style.cssText = `
                padding: 8px 10px;
                text-align: left;
                border-bottom: 2px solid #555;
                user-select: none;
            `;
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        items.forEach((item, index) => {
            const row = document.createElement('tr');
            row.style.cssText = `
                border-bottom: 1px solid #333;
                background: ${index % 2 === 0 ? '#2a2a2a' : '#252525'};
            `;

            const itemCell = document.createElement('td');
            itemCell.textContent = this.getItemName(item.itemHrid);
            itemCell.style.padding = '4px 10px';
            row.appendChild(itemCell);

            const enhCell = document.createElement('td');
            enhCell.textContent = item.enhancementLevel > 0 ? `+${item.enhancementLevel}` : '-';
            enhCell.style.padding = '4px 10px';
            row.appendChild(enhCell);

            const boughtCell = document.createElement('td');
            boughtCell.textContent =
                item.boughtQty > 0 ? `${item.boughtQty} @ ${this.formatCoins(item.avgBuyPrice)}` : '—';
            boughtCell.title = item.boughtQty > 0 ? `Total spent: ${this.formatCoins(item.boughtCoins)}` : '';
            boughtCell.style.cssText = 'padding: 4px 10px; color: #60a5fa;';
            row.appendChild(boughtCell);

            const soldCell = document.createElement('td');
            soldCell.textContent = item.soldQty > 0 ? `${item.soldQty} @ ${this.formatCoins(item.avgSellNet)}` : '—';
            soldCell.title = item.soldQty > 0 ? `Total received after tax: ${this.formatCoins(item.soldCoinsNet)}` : '';
            soldCell.style.cssText = 'padding: 4px 10px; color: #4ade80;';
            row.appendChild(soldCell);

            const realizedCell = document.createElement('td');
            realizedCell.title = BASIS_TOOLTIP;
            if (item.realizedProfit !== null) {
                realizedCell.textContent = this.formatSigned(item.realizedProfit);
                realizedCell.style.cssText = `
                    padding: 4px 10px;
                    font-weight: 500;
                    color: ${item.realizedProfit >= 0 ? '#4ade80' : '#f87171'};
                `;
                if (item.unmatchedRevenue > 0) {
                    realizedCell.textContent += ` (+${this.formatCoins(item.unmatchedRevenue)} rev, cost —)`;
                }
            } else if (item.soldQty > 0) {
                realizedCell.textContent = `${this.formatCoins(item.soldCoinsNet)} rev (cost —)`;
                realizedCell.style.cssText = 'padding: 4px 10px; color: #9ca3af;';
            } else {
                realizedCell.textContent = '—';
                realizedCell.style.cssText = 'padding: 4px 10px; color: #9ca3af;';
            }
            row.appendChild(realizedCell);

            const activityCell = document.createElement('td');
            activityCell.textContent = formatDateTime(new Date(item.lastActivity));
            activityCell.style.cssText = 'padding: 4px 10px; color: #aaa;';
            row.appendChild(activityCell);

            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        tableContainer.appendChild(table);
    }

    /**
     * Export the per-item aggregates as CSV (raw numbers, not display strings)
     */
    exportCSV() {
        const columns = [
            { key: 'item', label: 'Item' },
            { key: 'enhancementLevel', label: 'Enhancement' },
            { key: 'boughtQty', label: 'Bought Qty' },
            { key: 'avgBuyPrice', label: 'Avg Buy Price' },
            { key: 'boughtCoins', label: 'Bought Coins' },
            { key: 'soldQty', label: 'Sold Qty' },
            { key: 'avgSellNet', label: 'Avg Sell Net' },
            { key: 'soldCoinsNet', label: 'Sold Coins Net' },
            { key: 'matchedQty', label: 'Matched Qty' },
            { key: 'realizedProfit', label: 'Realized Profit (avg-cost)' },
            { key: 'unmatchedRevenue', label: 'Revenue With Unknown Cost' },
            { key: 'lastActivity', label: 'Last Activity' },
        ];
        const rows = this.aggregates.items.map((item) => ({
            ...item,
            item: this.getItemName(item.itemHrid),
            lastActivity: new Date(item.lastActivity).toISOString(),
        }));
        downloadCsv(csvFilename('trade-ledger'), toCsv(rows, columns));
    }

    /**
     * Disable the feature and remove its DOM
     */
    disable() {
        if (this.tabCleanupObserver) {
            this.tabCleanupObserver();
            this.tabCleanupObserver = null;
        }
        if (this.marketplaceTab) {
            this.marketplaceTab.remove();
            this.marketplaceTab = null;
        }
        this.minimizeCtl?.destroy();
        this.minimizeCtl = null;
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        this.isInitialized = false;
    }
}

const tradeLedgerView = new TradeLedgerView();

config.onSettingChange('market_tradeLedger', (value) => {
    if (value) {
        tradeLedgerView.initialize();
    } else {
        tradeLedgerView.disable();
    }
});

export default tradeLedgerView;
