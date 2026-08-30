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
import estimatedListingAge from './estimated-listing-age.js';
import marketPriceStore from './mooket/market-price-store.js';
import { aggregateLedger } from '../../utils/trade-ledger.js';
import { analyzeFillTimes, MIN_BUCKET_N } from '../../utils/fill-time-analysis.js';
import { formatKMB, formatDateTime, formatRelativeTime } from '../../utils/formatters.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { visibleTabsContainer, navigateToMarketplace } from '../../utils/marketplace-tabs.js';
import { toCsv, csvFilename, downloadCsv } from '../../utils/csv-export.js';
import { attachMinimize } from '../../utils/panel-minimize.js';
import { registerCommand, unregisterCommand } from '../../utils/command-registry.js';

/** How many weekly summary lines the modal shows. */
const WEEKS_SHOWN = 8;

/**
 * Item rows whose display name contains the query, or all of them when the
 * query is blank. Pure, so the filter box's logic is testable without a modal.
 *
 * @param {Array<Object>} items - Aggregated item rows, each carrying itemHrid
 * @param {string} query - What the user typed into the filter box
 * @param {Function} getName - `(itemHrid) => string`
 * @returns {Array<Object>}
 */
export function filterItemsByName(items, query, getName) {
    const needle = (query || '').trim().toLowerCase();
    if (!needle) return items;
    return items.filter((item) => getName(item.itemHrid).toLowerCase().includes(needle));
}

/**
 * Totals across a set of filtered item rows — bought/sold quantity and coins,
 * and realized profit when at least one row has a known one.
 *
 * Shown only above a filtered table: the weekly lines already answer "how did
 * everything do", so this exists to answer "how did the item(s) I just
 * searched for do" without adding up rows by hand.
 *
 * @param {Array<Object>} items - Aggregated item rows (shape of aggregateLedger's `items`)
 * @returns {{boughtQty: number, boughtCoins: number, soldQty: number, soldCoinsNet: number,
 *   realizedProfit: number|null, unmatchedRevenue: number}|null} Totals, or null for an empty set
 */
export function summarizeItems(items) {
    if (!items || items.length === 0) return null;

    let boughtQty = 0;
    let boughtCoins = 0;
    let soldQty = 0;
    let soldCoinsNet = 0;
    let unmatchedRevenue = 0;
    let realizedProfit = 0;
    let anyRealized = false;

    for (const item of items) {
        boughtQty += item.boughtQty || 0;
        boughtCoins += item.boughtCoins || 0;
        soldQty += item.soldQty || 0;
        soldCoinsNet += item.soldCoinsNet || 0;
        unmatchedRevenue += item.unmatchedRevenue || 0;
        if (item.realizedProfit !== null && item.realizedProfit !== undefined) {
            realizedProfit += item.realizedProfit;
            anyRealized = true;
        }
    }

    return {
        boughtQty,
        boughtCoins,
        soldQty,
        soldCoinsNet,
        realizedProfit: anyRealized ? realizedProfit : null,
        unmatchedRevenue,
    };
}

/** Stable key for persisting the modal's minimized state; there is no geometry to key off. */
const PANEL_KEY = 'tradeLedgerModal';

const FILL_TIME_TOOLTIP =
    'Time from a listing being created to the fill that completed it — how long the capital stayed tied up, ' +
    'not how long until the first unit went. Undercut depth is measured against the top of your own side of ' +
    'the book as it stands NOW (the cached order book, else the nearest price sample); no historical book is ' +
    'kept, so the depths are approximate. Listings cancelled or expired before filling are counted separately, ' +
    'never folded into a median.';

const BASIS_TOOLTIP =
    'Average-cost basis: each sell is matched against the average price of buys recorded in this ledger ' +
    'for the same item + enhancement level. Sell proceeds are always net of the market tax. ' +
    'Sells of items never bought through the ledger are shown as revenue with cost "—", not as profit.';

class TradeLedgerView {
    constructor() {
        this.isInitialized = false;
        this.modal = null;
        this.marketplaceTab = null;
        this.tabCleanupObserver = null;
        this.aggregates = null;
        this.itemNameCache = new Map();
        /** What the filter box currently reads; reset each time the modal is opened fresh. */
        this.filterText = '';
        /** `{sell, buy}` from `analyzeFillTimes`, or null while the listing log is still loading. */
        this.fillTimes = null;
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

        registerCommand({
            name: 'Trade Ledger',
            hint: 'What your marketplace trades earned, by week and by item',
            run: () => this.openModal(),
        });
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

        // A fresh open shows everything; a filter left over from last time would
        // read as items having silently vanished from the ledger.
        this.filterText = '';
        const filterInput = this.modal.querySelector('.mwi-trade-ledger-filter');
        if (filterInput) filterInput.value = '';

        this.modal.style.display = 'flex';
        // The last open's tables are that open's answer, not this one's — the
        // log and the books both moved while the modal was closed, and drawing
        // the old figures until the read lands showed real-looking stale
        // numbers with nothing saying so
        this.fillTimes = null;
        this.renderContent();

        // The listing log lives in IndexedDB and the rest of the modal does
        // not need it, so the fill-time section fills itself in when it
        // arrives rather than holding the whole modal open on a read
        this.loadFillTimes();
    }

    /**
     * Read the personal listing log, join it to the ledger's fills, and redraw
     * the fill-time section.
     *
     * Recomputed on every open rather than cached: both the listing log and the
     * order books it is measured against move while the modal is closed, and
     * showing a stale table would be worse than showing it a moment late.
     * @returns {Promise<void>}
     */
    async loadFillTimes() {
        // Two rapid opens race their reads; only the newest may draw — the
        // same token discipline guild-trial-ledger-view keeps
        const generation = (this._fillTimesGeneration = (this._fillTimesGeneration || 0) + 1);
        try {
            const listings = await estimatedListingAge.personalListings();
            if (generation !== this._fillTimesGeneration) return;
            const fills = tradeLedgerStore.getRecords();
            const sources = {
                book: (itemHrid, level, isSell) => estimatedListingAge.cachedTopOfBook(itemHrid, level, isSell),
                sample: (itemHrid, level, isSell) => {
                    // The mooket store spells "no price" as -1, not null
                    const entry = marketPriceStore.get(itemHrid, level);
                    const price = isSell ? entry?.ask : entry?.bid;
                    return typeof price === 'number' && price > 0 ? price : null;
                },
            };

            this.fillTimes = {
                sell: analyzeFillTimes({ listings, fills, isSell: true, sources }),
                buy: analyzeFillTimes({ listings, fills, isSell: false, sources }),
            };
        } catch (error) {
            if (generation !== this._fillTimesGeneration) return;
            console.error('[Trade Ledger View] Fill-time analysis failed:', error);
            this.fillTimes = { error: true };
        }

        // The modal may have been closed, or reopened, while the read was out
        if (this.modal && generation === this._fillTimesGeneration) this.renderFillTimes();
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

        const fillTimeContainer = document.createElement('div');
        fillTimeContainer.className = 'mwi-trade-ledger-fill-times';
        fillTimeContainer.style.cssText = 'margin-bottom: 15px;';

        const filterRow = document.createElement('div');
        filterRow.style.cssText = 'margin-bottom: 10px;';

        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.placeholder = 'Filter by item name…';
        filterInput.className = 'mwi-trade-ledger-filter';
        filterInput.style.cssText = `
            width: 100%;
            box-sizing: border-box;
            padding: 6px 10px;
            background: #1a1a1a;
            border: 1px solid #4a4a4a;
            border-radius: 4px;
            color: #e8ecf5;
            font-size: 13px;
        `;
        filterInput.addEventListener('input', () => {
            this.filterText = filterInput.value;
            this.renderItemTable();
        });
        filterRow.appendChild(filterInput);

        const tableContainer = document.createElement('div');
        tableContainer.className = 'mwi-trade-ledger-table-container';

        content.appendChild(header);
        content.appendChild(weeksContainer);
        content.appendChild(fillTimeContainer);
        content.appendChild(filterRow);
        content.appendChild(tableContainer);
        this.modal.appendChild(content);
        document.body.appendChild(this.modal);

        this.minimizeCtl = attachMinimize({
            panel: content,
            header,
            body: [weeksContainer, fillTimeContainer, filterRow, tableContainer],
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
        this.renderFillTimes();
        this.renderItemTable();
    }

    /**
     * One small table per side: undercut depth against the median time a
     * listing at that depth took to fill completely, and how many listings
     * each row rests on.
     *
     * The buy side is drawn only when there is something in it. Buy orders are
     * priced against the top bid, and a trader who only sells would otherwise
     * get a second empty table asking to be interpreted.
     */
    renderFillTimes() {
        const container = this.modal?.querySelector('.mwi-trade-ledger-fill-times');
        if (!container) return;
        while (container.firstChild) {
            container.removeChild(container.firstChild);
        }

        const heading = document.createElement('div');
        heading.textContent = 'Time to fill vs undercut depth';
        heading.title = FILL_TIME_TOOLTIP;
        heading.style.cssText = 'font-size: 13px; color: #8fb4ff; margin-bottom: 6px;';
        container.appendChild(heading);

        if (!this.fillTimes) {
            container.appendChild(this.buildFillTimeNote('Reading your listing log…'));
            return;
        }
        if (this.fillTimes.error) {
            container.appendChild(this.buildFillTimeNote('This section could not be drawn; see the console.'));
            return;
        }

        const { sell, buy } = this.fillTimes;
        if (sell.filled === 0 && sell.censored === 0 && buy.filled === 0 && buy.censored === 0) {
            container.appendChild(
                this.buildFillTimeNote(
                    'No completed listings in the log yet. A listing counts once every unit on it has filled.'
                )
            );
            return;
        }

        container.appendChild(this.buildFillTimeTable('Sells', sell));
        if (buy.filled > 0 || buy.censored > 0) {
            container.appendChild(this.buildFillTimeTable('Buys', buy));
        } else {
            container.appendChild(
                this.buildFillTimeNote('Sell side only — no completed buy orders in the log to measure.')
            );
        }

        container.appendChild(
            this.buildFillTimeNote(
                'Depths are measured against today’s book, not the book at the time — treat them as approximate.'
            )
        );
    }

    /**
     * A muted one-liner under the fill-time tables.
     * @param {string} text - What to say
     * @returns {HTMLElement} The line
     */
    buildFillTimeNote(text) {
        const note = document.createElement('div');
        note.textContent = text;
        note.title = FILL_TIME_TOOLTIP;
        note.style.cssText = 'font-size: 11px; color: #9ca3af; margin: 4px 0;';
        return note;
    }

    /**
     * One side's depth table, with its censored count underneath.
     * @param {string} sideLabel - "Sells" or "Buys"
     * @param {Object} analysis - One `analyzeFillTimes` result
     * @returns {HTMLElement} A block holding the table and its notes
     */
    buildFillTimeTable(sideLabel, analysis) {
        const block = document.createElement('div');
        block.style.cssText = 'margin-bottom: 8px;';

        const table = document.createElement('table');
        table.style.cssText = 'width: 100%; border-collapse: collapse; color: #e8ecf5; font-size: 12px;';

        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.cssText = 'background: #1a1a1a;';
        for (const label of [sideLabel, 'Median time to full fill', 'Listings']) {
            const th = document.createElement('th');
            th.textContent = label;
            th.title = FILL_TIME_TOOLTIP;
            th.style.cssText = 'padding: 4px 10px; text-align: left; border-bottom: 1px solid #555;';
            headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement('tbody');
        analysis.rows.forEach((row, index) => {
            const tr = document.createElement('tr');
            tr.style.cssText = `background: ${index % 2 === 0 ? '#2a2a2a' : '#252525'};`;

            const depthCell = document.createElement('td');
            depthCell.textContent = row.label;
            depthCell.style.cssText = 'padding: 3px 10px;';
            tr.appendChild(depthCell);

            const timeCell = document.createElement('td');
            if (row.medianMs !== null) {
                timeCell.textContent = formatRelativeTime(row.medianMs);
                timeCell.style.cssText = 'padding: 3px 10px; color: #4ade80;';
            } else {
                timeCell.textContent = row.count === 0 ? '—' : `too few (< ${MIN_BUCKET_N})`;
                timeCell.title = `A median needs at least ${MIN_BUCKET_N} completed listings at this depth.`;
                timeCell.style.cssText = 'padding: 3px 10px; color: #9ca3af;';
            }
            tr.appendChild(timeCell);

            const countCell = document.createElement('td');
            countCell.textContent = String(row.count);
            countCell.style.cssText = 'padding: 3px 10px; color: #aaa;';
            tr.appendChild(countCell);

            tbody.appendChild(tr);
        });
        table.appendChild(tbody);
        block.appendChild(table);

        const notes = [];
        if (analysis.censored > 0) {
            notes.push(`${analysis.censored} cancelled before filling (not in any median)`);
        }
        if (analysis.unpriced > 0) {
            notes.push(`${analysis.unpriced} with no price to compare against`);
        }
        if (analysis.sources.sample > 0) {
            notes.push(
                `${analysis.sources.sample} depth${analysis.sources.sample === 1 ? '' : 's'} from a price sample`
            );
        }
        if (notes.length > 0) {
            block.appendChild(this.buildFillTimeNote(notes.join(' · ')));
        }

        return block;
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
     * A one-line total for whatever the filter box currently narrows the
     * table to, so a search for one item does not require adding its rows
     * up by hand.
     * @param {Array<Object>} items - The filtered item rows
     * @returns {HTMLElement} The summary line
     */
    buildFilterSummary(items) {
        const totals = summarizeItems(items);
        const line = document.createElement('div');
        line.style.cssText = `
            padding: 6px 10px;
            margin-bottom: 8px;
            background: rgba(74, 158, 255, 0.08);
            border: 1px solid rgba(74, 158, 255, 0.3);
            border-radius: 4px;
            font-size: 12px;
            color: #cbd5e1;
        `;

        const parts = [
            `${items.length} item${items.length === 1 ? '' : 's'} matched:`,
            `bought ${totals.boughtQty} (${this.formatCoins(totals.boughtCoins)})`,
            `sold ${totals.soldQty} (${this.formatCoins(totals.soldCoinsNet)} net)`,
        ];
        line.textContent = parts.join('  ·  ');

        const realizedSpan = document.createElement('span');
        if (totals.realizedProfit !== null) {
            realizedSpan.textContent = `  ·  realized ${this.formatSigned(totals.realizedProfit)}`;
            realizedSpan.style.color = totals.realizedProfit >= 0 ? '#4ade80' : '#f87171';
            realizedSpan.title = BASIS_TOOLTIP;
        } else if (totals.soldCoinsNet > 0) {
            realizedSpan.textContent = `  ·  realized — (revenue only, no ledger-known cost)`;
            realizedSpan.style.color = '#9ca3af';
            realizedSpan.title = BASIS_TOOLTIP;
        }
        line.appendChild(realizedSpan);

        return line;
    }

    /**
     * Per-item rows sorted by most recent activity
     */
    renderItemTable() {
        const tableContainer = this.modal.querySelector('.mwi-trade-ledger-table-container');
        while (tableContainer.firstChild) {
            tableContainer.removeChild(tableContainer.firstChild);
        }

        const allItems = this.aggregates.items;
        const items = filterItemsByName(allItems, this.filterText, (itemHrid) => this.getItemName(itemHrid));

        if (this.filterText.trim() && items.length > 0) {
            tableContainer.appendChild(this.buildFilterSummary(items));
        }

        if (items.length === 0) {
            const empty = document.createElement('div');
            empty.textContent =
                allItems.length === 0
                    ? 'No fills recorded yet. The ledger records fills on your own listings as they happen — ' +
                      'place or watch some orders and come back.'
                    : `No item names match "${this.filterText.trim()}".`;
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
            { label: 'Sold (net)', title: 'Quantity @ average proceeds per unit, after the market tax' },
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
            itemCell.style.cssText = 'padding: 4px 10px; cursor: pointer;';
            itemCell.title = 'Open this item in the marketplace at its enhancement level.';
            itemCell.addEventListener('mouseenter', () => (itemCell.style.textDecoration = 'underline'));
            itemCell.addEventListener('mouseleave', () => (itemCell.style.textDecoration = ''));
            itemCell.addEventListener('click', () => {
                navigateToMarketplace(item.itemHrid, item.enhancementLevel || 0);
                this.closeModal();
            });
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
     * Export the per-item aggregates as CSV (raw numbers, not display strings).
     * Honors the item-name filter box, so the export always matches the table
     * on screen rather than silently exporting more than was visible.
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
        const filtered = filterItemsByName(this.aggregates.items, this.filterText, (itemHrid) =>
            this.getItemName(itemHrid)
        );
        const rows = filtered.map((item) => ({
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
        try {
            unregisterCommand('Trade Ledger');
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
        } catch (error) {
            console.error('[Trade Ledger View] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
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
