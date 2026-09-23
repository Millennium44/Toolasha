/**
 * Coinify History Viewer
 * Modal UI for browsing coinify session history.
 * Injected as a tab in the alchemy panel tab bar.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { coinifyHistoryTracker } from './coinify-history-tracker.js';
import { getItemPrice, getItemPriceInfo } from '../../utils/market-data.js';
import { formatKMB, formatDateTime } from '../../utils/formatters.js';
import { formatInputCostLine, priceInputWithRefinementFallback } from '../../utils/refined-item-cost.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { downloadFile } from '../../utils/csv-export.js';
import {
    buildAlchemyBackupEnvelope,
    parseAlchemyBackupJson,
    validateAlchemyBackupEnvelope,
    validateAlchemySessions,
    planAlchemyImportMerge,
} from './alchemy-session-import.js';
import {
    HISTORY_TYPE_SCALE,
    createTotalsCell,
    groupSessionsByInputItem,
    renderTotalsSection,
    totalsRowStyle,
} from './history-totals-table.js';

const CATALYST_OF_COINIFICATION_HRID = '/items/catalyst_of_coinification';
const PRIME_CATALYST_HRID = '/items/prime_catalyst';

/**
 * Check whether any mutation added nodes that are, contain, or sit under a tablist.
 * Keeps the body-wide watcher from re-scanning every tablist on unrelated DOM churn.
 * @param {MutationRecord[]} mutations
 * @returns {boolean}
 */
function mutationsTouchTablist(mutations) {
    for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
            if (node.nodeType !== Node.ELEMENT_NODE) continue;
            if (node.closest?.('[role="tablist"]') || node.querySelector?.('[role="tablist"]')) {
                return true;
            }
        }
    }
    return false;
}

/**
 * Columns of the coinify "Totals by Input Item" table.
 *
 * The narrowest of the three. Coinify has no drop table, so there is no
 * jackpot and no inputs-per-jackpot figure; and it is charged no alchemy coin
 * fee at all (see `computeSessionProfit`), so a Coin Cost column here would be
 * a column of permanent zeros.
 *
 * @type {Array<{label: string, title?: string}>}
 */
const COINIFY_TOTALS_COLUMNS = [
    { label: 'Input Item' },
    { label: 'Sessions' },
    { label: 'Attempts' },
    {
        label: 'Consumed',
        title: 'Items destroyed: attempts × the bulk size that was actually billed. A failed attempt consumes the input too.',
    },
    { label: 'Successes' },
    { label: 'Coins Earned', title: 'Coins paid out by the game. No marketplace cut applies — the output is coins.' },
    { label: 'Input Cost' },
    {
        label: 'Catalyst Cost',
        title: 'Catalysts recorded as consumed, at current buy price. A catalyst the market cannot price is excluded and marked †, never counted as free.',
    },
    { label: 'Net' },
    {
        label: 'Break-even Input',
        title:
            'Input value at which the coins earned exactly cover catalyst cost for what was consumed. ' +
            'Below this, coinifying paid; above it, the item was worth more than the game paid for it.',
    },
];

/** Footnote markers under the coinify totals table. @type {Array<string>} */
const COINIFY_TOTALS_LEGEND = [
    '* input unpriced — total is incomplete',
    '† catalyst on some sessions could not be priced — excluded, not zero',
    '‡ catalyst not recorded on some sessions (predates tracking) — excluded, not zero',
];

/**
 * Derive a coinify group's ratios once every session has been folded in.
 *
 * @param {Object} group
 * @returns {Object} The group, plus `net`, `successRate` and `breakEvenInputValue`
 */
function finalizeCoinifyGroup(group) {
    const net = group.revenue - group.inputCost - group.catalystCost;
    const successRate = group.attempts > 0 ? group.successes / group.attempts : null;
    // The input value at which the coins earned exactly cover catalyst cost for
    // what was consumed. Coinify's whole question is "is this item worth more
    // than the game pays for it", and this is that number, measured rather than
    // forecast.
    const breakEvenInputValue = group.netConsumed > 0 ? (group.revenue - group.catalystCost) / group.netConsumed : null;
    return { ...group, net, successRate, breakEvenInputValue };
}

/**
 * Format a group's catalyst-cost cell text + tooltip.
 *
 * A catalyst that could not be priced, or was never recorded, is excluded from
 * the sum and marked — it is not counted as free.
 *
 * @param {{catalystCost: number, catalystUnpricedSessions: number, catalystUnrecordedSessions: number}} group
 * @returns {[string, string|undefined]}
 */
function formatCoinifyCatalystTotal(group) {
    let text = formatKMB(group.catalystCost, 1);
    const notes = [];
    if (group.catalystUnpricedSessions > 0) {
        text += '†';
        notes.push(
            `${group.catalystUnpricedSessions} session(s) used a catalyst the market could not price — ` +
                'excluded from this total, not counted as zero.'
        );
    }
    if (group.catalystUnrecordedSessions > 0) {
        text += '‡';
        notes.push(
            `${group.catalystUnrecordedSessions} session(s) predate catalyst tracking — their catalyst use is ` +
                'unknown, not zero.'
        );
    }
    return [text, notes.length > 0 ? notes.join(' ') : undefined];
}

class CoinifyHistoryViewer {
    constructor() {
        this.isInitialized = false;
        this.modal = null;
        this.sessions = [];
        this.filteredSessions = [];
        this.currentPage = 1;
        this.rowsPerPage = 50;
        this.showAll = false;
        this.sortColumn = 'startTime';
        this.sortDirection = 'desc';

        // Column filters
        this.filters = {
            dateFrom: null,
            dateTo: null,
            selectedInputItems: [], // Array of itemHrids
        };

        this.activeFilterPopup = null;
        this.activeFilterButton = null;
        this.popupCloseHandler = null;

        // Computed profit per session id — kept out of the session objects so
        // it is never persisted back to storage
        this.profitCache = new Map();

        // Tab injection
        this.alchemyTab = null;
        this.tabWatcher = null;

        // Caches
        this.itemNameCache = new Map();
        this.itemsSpriteUrl = null;
        this.cachedDateRange = null;

        this.timerRegistry = createTimerRegistry();
    }

    /**
     * Initialize the viewer
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('alchemy_coinifyHistory')) {
            return;
        }

        this.isInitialized = true;
        this.addAlchemyTab();
    }

    /**
     * Disable the viewer
     */
    disable() {
        if (this.tabWatcher) {
            this.tabWatcher();
            this.tabWatcher = null;
        }
        if (this.alchemyTab && this.alchemyTab.parentNode) {
            this.alchemyTab.remove();
            this.alchemyTab = null;
        }
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        if (this.importInput) {
            this.importInput.remove();
            this.importInput = null;
        }
        this.timerRegistry.clearAll();
        this.isInitialized = false;
    }

    // ─── Tab Injection ───────────────────────────────────────────────────────

    /**
     * Inject "Coinify History" tab into the alchemy tab bar.
     * The alchemy tab bar contains Coinify, Decompose, Transmute, Unrefine, Current Action.
     * We identify it by the presence of a "Coinify" tab text.
     */
    addAlchemyTab() {
        const ensureTabExists = () => {
            const tablist = document.querySelector('[role="tablist"]');
            if (!tablist) return;

            // Verify this is the alchemy tablist by checking for "Coinify" tab
            const hasCoinify = Array.from(tablist.children).some(
                (btn) => btn.textContent.includes('Coinify') && !btn.dataset.mwiCoinifyHistoryTab
            );
            if (!hasCoinify) return;

            // Already injected?
            if (tablist.querySelector('[data-mwi-coinify-history-tab="true"]')) return;

            // Clone an existing tab for structure
            const referenceTab = Array.from(tablist.children).find(
                (btn) => btn.textContent.includes('Coinify') && !btn.dataset.mwiCoinifyHistoryTab
            );
            if (!referenceTab) return;

            const tab = referenceTab.cloneNode(true);
            tab.setAttribute('data-mwi-coinify-history-tab', 'true');
            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            // Set label
            const badge = tab.querySelector('.TabsComponent_badge__1Du26');
            if (badge) {
                // Replace first text node (the label) while keeping badge span
                const badgeSpan = badge.querySelector('.MuiBadge-badge');
                badge.textContent = '';
                badge.appendChild(document.createTextNode('Coinify History'));
                if (badgeSpan) badge.appendChild(badgeSpan);
            } else {
                tab.textContent = 'Coinify History';
            }

            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openModal();
            });

            tablist.appendChild(tab);
            this.alchemyTab = tab;
        };

        // Watch for DOM changes that recreate the tablist
        if (!this.tabWatcher) {
            this.tabWatcher = createMutationWatcher(
                document.body,
                (mutations) => {
                    if (!mutationsTouchTablist(mutations)) return;
                    // If our tab was removed from DOM, clear reference
                    if (this.alchemyTab && !document.body.contains(this.alchemyTab)) {
                        this.alchemyTab = null;
                    }
                    ensureTabExists();
                },
                { childList: true, subtree: true }
            );
        }

        ensureTabExists();
    }

    // ─── Modal ───────────────────────────────────────────────────────────────

    /**
     * Open the modal — load sessions and render
     */
    async openModal() {
        this.sessions = await coinifyHistoryTracker.loadSessions();
        this.profitCache.clear();
        this.cachedDateRange = null;
        this.applyFilters();

        if (!this.modal) {
            this.createModal();
        }

        this.modal.style.display = 'flex';
        this.renderTable();
    }

    /**
     * Close the modal
     */
    closeModal() {
        if (this.modal) {
            this.modal.style.display = 'none';
        }
        this.closeActiveFilterPopup();
    }

    /**
     * Create modal DOM structure
     */
    createModal() {
        this.modal = document.createElement('div');
        this.modal.className = 'mwi-coinify-history-modal';
        this.modal.style.cssText = `
            position: fixed;
            top: 0; left: 0;
            width: 100%; height: 100%;
            background: rgba(0,0,0,0.8);
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 10000;
        `;

        const content = document.createElement('div');
        content.className = 'mwi-coinify-history-content';
        content.style.cssText = `
            background: #2a2a2a;
            border-radius: 8px;
            padding: 20px;
            width: fit-content;
            min-width: 500px;
            max-width: 95vw;
            max-height: 90%;
            overflow: auto;
            box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 20px;
        `;

        const title = document.createElement('h2');
        title.textContent = 'Coinify History';
        title.style.cssText = 'margin: 0; color: #fff;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        closeBtn.style.cssText = `
            background: none; border: none; color: #fff;
            font-size: 24px; cursor: pointer; padding: 0;
            width: 30px; height: 30px;
        `;
        closeBtn.addEventListener('click', () => this.closeModal());

        header.appendChild(title);
        header.appendChild(closeBtn);

        // Controls
        const controls = document.createElement('div');
        controls.className = 'mwi-coinify-history-controls';
        controls.style.cssText = `
            display: flex;
            gap: 10px;
            margin-bottom: 8px;
            flex-wrap: wrap;
            align-items: center;
            justify-content: space-between;
        `;

        // Active filter badges row
        const badges = document.createElement('div');
        badges.className = 'mwi-coinify-history-badges';
        badges.style.cssText = `
            display: flex;
            gap: 8px;
            flex-wrap: wrap;
            align-items: center;
            min-height: 28px;
            margin-bottom: 10px;
        `;

        // Table container
        const tableContainer = document.createElement('div');
        tableContainer.className = 'mwi-coinify-history-table-container';
        tableContainer.style.cssText = 'overflow-x: auto;';

        // Totals-by-input-item container
        const totalsContainer = document.createElement('div');
        totalsContainer.className = 'mwi-coinify-history-totals-container';
        totalsContainer.style.cssText = 'overflow-x: auto;';

        // Pagination
        const pagination = document.createElement('div');
        pagination.className = 'mwi-coinify-history-pagination';
        pagination.style.cssText = `
            margin-top: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        `;

        content.appendChild(header);
        content.appendChild(controls);
        content.appendChild(badges);
        content.appendChild(tableContainer);
        content.appendChild(totalsContainer);
        content.appendChild(pagination);
        this.modal.appendChild(content);
        document.body.appendChild(this.modal);

        // Close on backdrop click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) this.closeModal();
        });
    }

    // ─── Filtering ───────────────────────────────────────────────────────────

    /**
     * Apply all active filters to this.sessions → this.filteredSessions
     */
    applyFilters() {
        this.cachedDateRange = null;

        const hasDateFilter = !!(this.filters.dateFrom || this.filters.dateTo);
        let dateToEndOfDay = null;
        if (hasDateFilter && this.filters.dateTo) {
            dateToEndOfDay = new Date(this.filters.dateTo);
            dateToEndOfDay.setHours(23, 59, 59, 999);
        }

        const hasItemFilter = this.filters.selectedInputItems.length > 0;
        const itemFilterSet = hasItemFilter ? new Set(this.filters.selectedInputItems) : null;

        const filtered = this.sessions.filter((session) => {
            // Date filter
            if (hasDateFilter) {
                const d = new Date(session.startTime);
                if (this.filters.dateFrom && d < this.filters.dateFrom) return false;
                if (dateToEndOfDay && d > dateToEndOfDay) return false;
            }

            // Input item filter
            if (hasItemFilter && !itemFilterSet.has(session.inputItemHrid)) return false;

            return true;
        });

        for (const session of this.sessions) {
            if (!this.profitCache.has(session.id)) {
                this.profitCache.set(session.id, this.computeSessionProfit(session));
            }
        }

        // Sort
        filtered.sort((a, b) => {
            let aVal = a[this.sortColumn] ?? 0;
            let bVal = b[this.sortColumn] ?? 0;
            // Sort item columns by the displayed name, not the hrid
            if (this.sortColumn === 'inputItemHrid') {
                aVal = this.getItemName(String(aVal));
                bVal = this.getItemName(String(bVal));
            } else if (this.sortColumn === '_profit') {
                aVal = this.profitCache.get(a.id)?.profit ?? 0;
                bVal = this.profitCache.get(b.id)?.profit ?? 0;
            }
            const cmp = typeof aVal === 'string' ? aVal.localeCompare(String(bVal)) : aVal - bVal;
            return this.sortDirection === 'asc' ? cmp : -cmp;
        });

        this.filteredSessions = filtered;
        this.currentPage = 1;
    }

    /**
     * Check if a column has an active filter
     * @param {string} col
     * @returns {boolean}
     */
    hasActiveFilter(col) {
        switch (col) {
            case 'startTime':
                return !!(this.filters.dateFrom || this.filters.dateTo);
            case 'inputItemHrid':
                return this.filters.selectedInputItems.length > 0;
            default:
                return false;
        }
    }

    /**
     * Returns true if any filter is active
     */
    hasAnyFilter() {
        return this.hasActiveFilter('startTime') || this.hasActiveFilter('inputItemHrid');
    }

    /**
     * Clear all filters
     */
    clearAllFilters() {
        this.filters.dateFrom = null;
        this.filters.dateTo = null;
        this.filters.selectedInputItems = [];
        this.applyFilters();
        this.renderTable();
    }

    /**
     * Compute session profit: coins earned minus consumed inputs (at current
     * buy price for the session's enhancement level — historical input prices
     * were not recorded), catalysts consumed, and the alchemy coin fee.
     * @param {Object} session
     *
     * An input the market cannot price falls back to its refinement craft cost
     * when it is a refined (★) item, and is reported as unpriced when even that
     * fails — an unknown cost is not a zero one.
     *
     * @returns {{profit: number, revenue: number, inputCost: number, catalystCost: number, netConsumed: number,
     *   inputBasis: string|null, inputUnpriced: boolean}}
     */
    computeSessionProfit(session) {
        const itemDetails = dataManager.getItemDetails(session.inputItemHrid);
        const bulkMultiplier = session.bulkMultiplier ?? itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;
        const attempts = session.totalAttempts || 0;

        const revenue = session.totalCoinsEarned || 0;

        const netConsumed = attempts * bulkMultiplier;
        // Honours profitCalc_pricingMode the same way transmute does, rather than
        // a hardcoded ask-then-bid that ignored the setting.
        const inputPriceInfo = getItemPriceInfo(session.inputItemHrid, {
            enhancementLevel: session.enhancementLevel || 0,
            context: 'profit',
            side: 'buy',
        });
        const marketPrice = inputPriceInfo.price > 0 ? inputPriceInfo.price : 0;
        // A refined (★) cape is untradable, so the market prices it at nothing;
        // charging the session 0 for it made a destroyed cape free. See
        // utils/refined-item-cost.js.
        const { price: inputPrice, basis: inputBasis } = priceInputWithRefinementFallback(
            session.inputItemHrid,
            marketPrice,
            { enhancementLevel: session.enhancementLevel || 0, marketSource: inputPriceInfo.source }
        );
        const inputCost = netConsumed * inputPrice;
        const inputUnpriced = inputBasis === null && netConsumed > 0;

        // A catalyst the market cannot price used to be silently costed at zero, which
        // reads as "this catalyst was free" rather than "we do not know what it cost".
        // The cost still excludes it — there is no number to add — but the session now
        // says so, and the totals table marks the row †.
        const catalystUse = [
            { hrid: CATALYST_OF_COINIFICATION_HRID, count: session.catalystOfCoinificationUsed || 0 },
            { hrid: PRIME_CATALYST_HRID, count: session.primeCatalystUsed || 0 },
        ].filter((entry) => entry.count > 0);
        let catalystCost = 0;
        let catalystUnpriced = false;
        const catalystHrids = [];
        for (const entry of catalystUse) {
            const price = getItemPrice(entry.hrid, { context: 'profit', side: 'buy' });
            catalystHrids.push(entry.hrid);
            if (price > 0) catalystCost += price * entry.count;
            else catalystUnpriced = true;
        }
        // Sessions saved before catalyst counts were persisted carry neither field.
        // That is "unknown", not "none", and the totals table marks it ‡.
        const catalystUnrecorded =
            session.catalystOfCoinificationUsed === undefined && session.primeCatalystUsed === undefined;

        // Coinify has no coin fee at all — the item is the input and coins are the output
        // (see utils/alchemy-fees.js). The line outlived the fee, so every tooltip carried a
        // permanent "Alchemy coins: -0" for a charge that does not exist.
        return {
            profit: revenue - inputCost - catalystCost,
            revenue,
            inputCost,
            catalystCost,
            catalystUnpriced,
            catalystUnrecorded,
            catalystHrids,
            netConsumed,
            inputBasis,
            inputUnpriced,
        };
    }

    // ─── Rendering ───────────────────────────────────────────────────────────

    /**
     * Full render: controls + badges + table + pagination
     */
    renderTable() {
        this.renderControls();
        this.renderBadges();

        const tableContainer = this.modal.querySelector('.mwi-coinify-history-table-container');
        while (tableContainer.firstChild) tableContainer.removeChild(tableContainer.firstChild);

        const table = document.createElement('table');
        table.style.cssText = `width: 100%; min-width: max-content; border-collapse: collapse; color: #fff; white-space: nowrap; font-size: ${HISTORY_TYPE_SCALE.body};`;

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        headerRow.style.background = '#1a1a1a';

        const columns = [
            { key: 'startTime', label: 'Session Start', filterable: true },
            { key: 'inputItemHrid', label: 'Input Item', filterable: true },
            { key: 'enhancementLevel', label: 'Enh. Level', filterable: false },
            { key: 'totalAttempts', label: 'Attempts', filterable: false },
            { key: 'totalSuccesses', label: 'Successes', filterable: false },
            { key: '_successRate', label: 'Success Rate', filterable: false },
            { key: 'totalCoinsEarned', label: 'Coins Earned', filterable: false },
            { key: '_catalystOfCoinification', label: 'Catalyst of Coinification', filterable: false },
            { key: '_primeCatalyst', label: 'Prime Catalyst', filterable: false },
            { key: '_profit', label: 'Profit', filterable: false },
            { key: '_delete', label: '', filterable: false },
        ];

        columns.forEach((col) => {
            const th = document.createElement('th');
            th.style.cssText = `
                padding: 10px;
                text-align: left;
                border-bottom: 2px solid #555;
                user-select: none;
                white-space: nowrap;
            `;

            const headerContent = document.createElement('div');
            headerContent.style.cssText = 'display: flex; align-items: center; gap: 8px;';

            const labelSpan = document.createElement('span');
            labelSpan.style.cursor = 'pointer';

            // Columns starting with _ are computed, not directly sortable by field
            const isSortable = !col.key.startsWith('_');
            const isCatalystCol = col.key === '_catalystOfCoinification' || col.key === '_primeCatalyst';

            if (isSortable) {
                if (this.sortColumn === col.key) {
                    labelSpan.textContent = col.label + (this.sortDirection === 'asc' ? ' ▲' : ' ▼');
                } else {
                    labelSpan.textContent = col.label;
                }
                labelSpan.addEventListener('click', () => {
                    if (this.sortColumn === col.key) {
                        this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
                    } else {
                        this.sortColumn = col.key;
                        this.sortDirection = 'desc';
                    }
                    this.applyFilters();
                    this.renderTable();
                });
            } else if (isCatalystCol) {
                // Render icon as header with item name as tooltip and accessible name;
                // the icon carries no text, so the label lives on title/aria-label instead
                const hrid =
                    col.key === '_catalystOfCoinification' ? CATALYST_OF_COINIFICATION_HRID : PRIME_CATALYST_HRID;
                labelSpan.title = col.label;
                labelSpan.style.cursor = 'default';
                th.title = col.label;
                th.setAttribute('aria-label', col.label);
                this.appendItemIcon(labelSpan, hrid, 20);
            } else {
                labelSpan.textContent = col.label;
                labelSpan.style.cursor = 'default';
            }

            headerContent.appendChild(labelSpan);

            if (col.filterable) {
                const filterBtn = document.createElement('button');
                filterBtn.textContent = '⋮';
                filterBtn.style.cssText = `
                    background: none; border: none;
                    color: ${this.hasActiveFilter(col.key) ? '#4a90e2' : '#aaa'};
                    cursor: pointer; font-size: ${HISTORY_TYPE_SCALE.glyph};
                    padding: 2px 4px; font-weight: bold;
                `;
                filterBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.showFilterPopup(col.key, filterBtn);
                });
                headerContent.appendChild(filterBtn);
            }

            th.appendChild(headerContent);
            headerRow.appendChild(th);
        });

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');
        const paginated = this.getPaginatedSessions();

        if (paginated.length === 0) {
            const row = document.createElement('tr');
            const cell = document.createElement('td');
            cell.colSpan = columns.length;
            cell.textContent =
                this.sessions.length === 0
                    ? 'No coinify history recorded yet.'
                    : 'No sessions match the current filters.';
            cell.style.cssText = 'padding: 20px; text-align: center; color: #888;';
            row.appendChild(cell);
            tbody.appendChild(row);
        } else {
            paginated.forEach((session, index) => {
                const row = document.createElement('tr');
                row.style.cssText = `
                    border-bottom: 1px solid #333;
                    background: ${index % 2 === 0 ? '#2a2a2a' : '#252525'};
                `;

                // Session Start
                const dateCell = document.createElement('td');
                dateCell.textContent = formatDateTime(new Date(session.startTime));
                dateCell.style.padding = '6px 10px';
                row.appendChild(dateCell);

                // Input Item
                const inputCell = document.createElement('td');
                inputCell.style.cssText = 'padding: 6px 10px; display: flex; align-items: center; gap: 8px;';
                this.appendItemIcon(inputCell, session.inputItemHrid, 20);
                const inputName = document.createElement('span');
                inputName.textContent = this.getItemName(session.inputItemHrid);
                inputCell.appendChild(inputName);
                row.appendChild(inputCell);

                // Enhancement Level
                const enhCell = document.createElement('td');
                enhCell.textContent = session.enhancementLevel > 0 ? `+${session.enhancementLevel}` : '0';
                enhCell.style.cssText = 'padding: 6px 10px; text-align: center;';
                row.appendChild(enhCell);

                // Attempts
                const attemptsCell = document.createElement('td');
                attemptsCell.textContent = session.totalAttempts;
                attemptsCell.style.padding = '6px 10px';
                row.appendChild(attemptsCell);

                // Successes
                const successCell = document.createElement('td');
                const failures = session.totalAttempts - session.totalSuccesses;
                successCell.textContent = `${session.totalSuccesses} (${failures} failed)`;
                successCell.style.cssText = `
                    padding: 6px 10px;
                    color: ${failures > 0 ? '#fbbf24' : '#4ade80'};
                `;
                row.appendChild(successCell);

                // Success Rate
                const rateCell = document.createElement('td');
                const rate =
                    session.totalAttempts > 0
                        ? ((session.totalSuccesses / session.totalAttempts) * 100).toFixed(1)
                        : '—';
                rateCell.textContent = session.totalAttempts > 0 ? `${rate}%` : '—';
                rateCell.style.padding = '6px 10px';
                row.appendChild(rateCell);

                // Coins Earned
                const earnedCell = document.createElement('td');
                earnedCell.textContent = formatKMB(session.totalCoinsEarned || 0, 1);
                earnedCell.style.cssText = 'padding: 6px 10px; color: #fbbf24;';
                row.appendChild(earnedCell);

                // Catalyst of Coinification
                const cocCell = document.createElement('td');
                cocCell.style.cssText = 'padding: 6px 10px;';
                this.renderCatalystCell(
                    cocCell,
                    CATALYST_OF_COINIFICATION_HRID,
                    session.catalystOfCoinificationUsed || 0
                );
                row.appendChild(cocCell);

                // Prime Catalyst
                const pcCell = document.createElement('td');
                pcCell.style.cssText = 'padding: 6px 10px;';
                this.renderCatalystCell(pcCell, PRIME_CATALYST_HRID, session.primeCatalystUsed || 0);
                row.appendChild(pcCell);

                // Profit
                const profitCell = document.createElement('td');
                const profitDetail = this.profitCache.get(session.id) || this.computeSessionProfit(session);
                // An unpriced input makes the figure incomplete, not zero-cost —
                // the asterisk is what tells the two apart at a glance
                profitCell.textContent = formatKMB(profitDetail.profit, 1) + (profitDetail.inputUnpriced ? '*' : '');
                profitCell.style.cssText = `
                    padding: 6px 10px;
                    font-weight: bold;
                    color: ${profitDetail.profit >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS};
                `;
                profitCell.title =
                    `Coins earned: ${formatKMB(profitDetail.revenue, 1)}\n` +
                    `${formatInputCostLine(profitDetail)}\n` +
                    `Catalysts: −${formatKMB(profitDetail.catalystCost, 1)}`;
                row.appendChild(profitCell);

                // Delete
                const deleteCell = document.createElement('td');
                deleteCell.style.cssText = 'padding: 6px 4px; text-align: center;';
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '✕';
                deleteBtn.title = 'Delete this session';
                deleteBtn.setAttribute('aria-label', 'Delete this session');
                deleteBtn.style.cssText = `
                    background: none; border: none; color: #dc2626;
                    cursor: pointer; font-size: ${HISTORY_TYPE_SCALE.body}; padding: 2px 6px;
                    border-radius: 3px; line-height: 1;
                `;
                deleteBtn.addEventListener('mouseenter', () => {
                    deleteBtn.style.background = 'rgba(220,38,38,0.15)';
                });
                deleteBtn.addEventListener('mouseleave', () => {
                    deleteBtn.style.background = 'none';
                });
                deleteBtn.addEventListener('click', () => this.deleteSession(session.id));
                deleteCell.appendChild(deleteBtn);
                row.appendChild(deleteCell);

                tbody.appendChild(row);
            });
        }

        table.appendChild(tbody);
        tableContainer.appendChild(table);
        this.renderTotals();
        this.renderPagination();
    }

    // ─── Totals by Input Item ───────────────────────────────────────────────

    /**
     * Group the currently filtered sessions by input item and total them.
     *
     * Figures come from the same per-session `computeSessionProfit` result
     * already cached by `applyFilters`, so a totals row and the Profit column
     * of the rows it sums can never disagree about a single session.
     *
     * Coinify is the simplest of the three actions — a fixed coin payout per
     * success, no drop table and no coin fee — so this table is correspondingly
     * narrower than transmute's. The marker discipline is the part that carries
     * over unchanged: an input the market cannot price, or a catalyst that
     * could not be priced or was never recorded, is excluded and said so,
     * never quietly counted as zero.
     *
     * @returns {Array<Object>} One entry per distinct inputItemHrid
     */
    computeInputItemTotals() {
        return groupSessionsByInputItem(this.filteredSessions, {
            getDetail: (session) => this.profitCache.get(session.id) || this.computeSessionProfit(session),
            getSortName: (hrid) => this.getItemName(hrid),
            createGroup: (hrid) => ({
                inputItemHrid: hrid,
                sessionCount: 0,
                attempts: 0,
                successes: 0,
                netConsumed: 0,
                revenue: 0,
                inputCost: 0,
                inputUnpriced: false,
                catalystCost: 0,
                catalystUnpricedSessions: 0,
                catalystUnrecordedSessions: 0,
                catalystHrids: new Set(),
            }),
            accumulate: (group, session, detail) => {
                group.sessionCount++;
                group.attempts += session.totalAttempts || 0;
                group.successes += session.totalSuccesses || 0;
                group.netConsumed += detail.netConsumed;
                group.revenue += detail.revenue;
                group.inputCost += detail.inputCost;
                if (detail.inputUnpriced) group.inputUnpriced = true;
                group.catalystCost += detail.catalystCost;
                if (detail.catalystUnpriced) group.catalystUnpricedSessions++;
                if (detail.catalystUnrecorded) group.catalystUnrecordedSessions++;
                for (const hrid of detail.catalystHrids || []) group.catalystHrids.add(hrid);
            },
            finalize: (group) => finalizeCoinifyGroup(group),
        });
    }

    /**
     * Render the "Totals by Input Item" table below the session list.
     */
    renderTotals() {
        const container = this.modal.querySelector('.mwi-coinify-history-totals-container');
        const totals = this.computeInputItemTotals();

        const rows = totals.map((group, index) => this.buildTotalsRow(group, index));
        if (totals.length > 0) rows.push(this.buildOverallTotalsRow(totals));

        renderTotalsSection(container, {
            heading: 'Totals by Input Item',
            columns: COINIFY_TOTALS_COLUMNS,
            rows,
            legendParts: COINIFY_TOTALS_LEGEND,
        });
    }

    /**
     * Build one totals row for a single input-item group.
     * @param {Object} group
     * @param {number} index
     * @returns {HTMLTableRowElement}
     */
    buildTotalsRow(group, index) {
        const row = document.createElement('tr');
        row.style.cssText = totalsRowStyle(index);

        const itemCell = document.createElement('td');
        itemCell.style.cssText = 'padding: 6px 10px; display: flex; align-items: center; gap: 8px;';
        this.appendItemIcon(itemCell, group.inputItemHrid, 18);
        const nameSpan = document.createElement('span');
        nameSpan.textContent = this.getItemName(group.inputItemHrid);
        itemCell.appendChild(nameSpan);
        row.appendChild(itemCell);

        row.appendChild(createTotalsCell(String(group.sessionCount)));
        row.appendChild(createTotalsCell(String(group.attempts)));
        row.appendChild(createTotalsCell(String(group.netConsumed)));

        const successPct = group.successRate !== null ? `${(group.successRate * 100).toFixed(1)}%` : '—';
        row.appendChild(createTotalsCell(`${group.successes} (${successPct})`));

        row.appendChild(createTotalsCell(formatKMB(group.revenue, 1)));
        row.appendChild(
            createTotalsCell(formatKMB(group.inputCost, 1) + (group.inputUnpriced ? '*' : ''), {
                title: group.inputUnpriced
                    ? 'At least one session in this group has an unpriced input — this total is incomplete, not fully costed.'
                    : undefined,
            })
        );

        const [catalystText, catalystTitle] = formatCoinifyCatalystTotal(group);
        row.appendChild(createTotalsCell(catalystText, { title: catalystTitle }));

        row.appendChild(
            createTotalsCell(formatKMB(group.net, 1), {
                color: group.net >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS,
                bold: true,
            })
        );
        row.appendChild(
            createTotalsCell(group.breakEvenInputValue !== null ? formatKMB(group.breakEvenInputValue, 1) : '—')
        );

        return row;
    }

    /**
     * Build the "All items" summary row across every group.
     * @param {Array<Object>} totals
     * @returns {HTMLTableRowElement}
     */
    buildOverallTotalsRow(totals) {
        const overall = totals.reduce(
            (acc, group) => {
                acc.sessionCount += group.sessionCount;
                acc.attempts += group.attempts;
                acc.successes += group.successes;
                acc.netConsumed += group.netConsumed;
                acc.revenue += group.revenue;
                acc.inputCost += group.inputCost;
                acc.catalystCost += group.catalystCost;
                acc.inputUnpriced = acc.inputUnpriced || group.inputUnpriced;
                acc.catalystUnpricedSessions += group.catalystUnpricedSessions;
                acc.catalystUnrecordedSessions += group.catalystUnrecordedSessions;
                return acc;
            },
            {
                sessionCount: 0,
                attempts: 0,
                successes: 0,
                netConsumed: 0,
                revenue: 0,
                inputCost: 0,
                catalystCost: 0,
                inputUnpriced: false,
                catalystUnpricedSessions: 0,
                catalystUnrecordedSessions: 0,
            }
        );

        const row = document.createElement('tr');
        row.style.cssText = 'border-top: 2px solid #555; background: #1f1f1f;';

        const itemCell = document.createElement('td');
        itemCell.textContent = 'All items';
        itemCell.style.cssText = 'padding: 6px 10px; font-weight: bold;';
        row.appendChild(itemCell);

        row.appendChild(createTotalsCell(String(overall.sessionCount), { bold: true }));
        row.appendChild(createTotalsCell(String(overall.attempts), { bold: true }));
        row.appendChild(createTotalsCell(String(overall.netConsumed), { bold: true }));

        const successPct = overall.attempts > 0 ? `${((overall.successes / overall.attempts) * 100).toFixed(1)}%` : '—';
        row.appendChild(createTotalsCell(`${overall.successes} (${successPct})`, { bold: true }));
        row.appendChild(createTotalsCell(formatKMB(overall.revenue, 1), { bold: true }));
        row.appendChild(
            createTotalsCell(formatKMB(overall.inputCost, 1) + (overall.inputUnpriced ? '*' : ''), { bold: true })
        );

        const [catalystText, catalystTitle] = formatCoinifyCatalystTotal(overall);
        row.appendChild(createTotalsCell(catalystText, { bold: true, title: catalystTitle }));

        const net = overall.revenue - overall.inputCost - overall.catalystCost;
        row.appendChild(
            createTotalsCell(formatKMB(net, 1), {
                bold: true,
                color: net >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS,
            })
        );

        // Mixed input items — a single break-even input value across different
        // items is not a number that means anything
        row.appendChild(createTotalsCell('—'));

        return row;
    }

    /**
     * Render a catalyst cell: icon + count, or — if zero
     * @param {HTMLElement} cell
     * @param {string} catalystHrid
     * @param {number} count
     */
    renderCatalystCell(cell, catalystHrid, count) {
        if (count === 0) {
            const dash = document.createElement('span');
            dash.textContent = '—';
            dash.style.color = '#888';
            cell.appendChild(dash);
            return;
        }

        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'display: flex; align-items: center; gap: 4px;';

        this.appendItemIcon(wrapper, catalystHrid, 18);

        const countSpan = document.createElement('span');
        countSpan.textContent = count.toLocaleString();
        wrapper.appendChild(countSpan);

        cell.appendChild(wrapper);
    }

    /**
     * Render controls bar (stats + action buttons)
     */
    renderControls() {
        const controls = this.modal.querySelector('.mwi-coinify-history-controls');
        while (controls.firstChild) controls.removeChild(controls.firstChild);

        // Stats
        const stats = document.createElement('span');
        stats.style.cssText = `color: #aaa; font-size: ${HISTORY_TYPE_SCALE.body};`;
        stats.textContent = `${this.filteredSessions.length} session${this.filteredSessions.length !== 1 ? 's' : ''}`;
        controls.appendChild(stats);

        const rightGroup = document.createElement('div');
        rightGroup.style.cssText = 'display: flex; gap: 8px; align-items: center;';

        // Clear All Filters button (only when filters active)
        if (this.hasAnyFilter()) {
            const clearFiltersBtn = document.createElement('button');
            clearFiltersBtn.textContent = 'Clear All Filters';
            clearFiltersBtn.style.cssText = `
                padding: 6px 12px; background: #e67e22; color: white;
                border: none; border-radius: 4px; cursor: pointer;
            `;
            clearFiltersBtn.addEventListener('click', () => this.clearAllFilters());
            rightGroup.appendChild(clearFiltersBtn);
        }

        // Export button
        const exportBtn = document.createElement('button');
        exportBtn.textContent = 'Export';
        exportBtn.style.cssText = `
            padding: 6px 12px; background: #2563eb; color: white;
            border: none; border-radius: 4px; cursor: pointer;
        `;
        exportBtn.addEventListener('click', () => this.exportHistory());
        rightGroup.appendChild(exportBtn);

        // Backup (JSON) button — lossless, for hand-editing and re-importing
        const backupBtn = document.createElement('button');
        backupBtn.textContent = 'Backup';
        backupBtn.title = 'Download a lossless JSON backup of this history, for hand-editing and re-importing';
        backupBtn.style.cssText = `
            padding: 6px 12px; background: #2563eb; color: white;
            border: none; border-radius: 4px; cursor: pointer;
        `;
        backupBtn.addEventListener('click', () => this.exportBackup());
        rightGroup.appendChild(backupBtn);

        // Import button — restores or merges a JSON backup
        const importBtn = document.createElement('button');
        importBtn.textContent = 'Import';
        importBtn.title =
            'Restore sessions from a JSON backup — a session id already in your history is replaced, others are added';
        importBtn.style.cssText = `
            padding: 6px 12px; background: #16a34a; color: white;
            border: none; border-radius: 4px; cursor: pointer;
        `;
        importBtn.addEventListener('click', () => this.triggerImportBackup());
        rightGroup.appendChild(importBtn);

        // Clear History button
        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear History';
        clearBtn.style.cssText = `
            padding: 6px 12px; background: #dc2626; color: white;
            border: none; border-radius: 4px; cursor: pointer;
        `;
        clearBtn.addEventListener('click', () => this.clearHistory());
        rightGroup.appendChild(clearBtn);

        controls.appendChild(rightGroup);
    }

    /**
     * Render active filter badges
     */
    renderBadges() {
        const container = this.modal.querySelector('.mwi-coinify-history-badges');
        while (container.firstChild) container.removeChild(container.firstChild);

        const badges = [];

        if (this.filters.dateFrom || this.filters.dateTo) {
            const parts = [];
            if (this.filters.dateFrom) parts.push(formatDateTime(this.filters.dateFrom, { includeTime: false }));
            if (this.filters.dateTo) parts.push(formatDateTime(this.filters.dateTo, { includeTime: false }));
            badges.push({
                label: `Date: ${parts.join(' - ')}`,
                onRemove: () => {
                    this.filters.dateFrom = null;
                    this.filters.dateTo = null;
                    this.applyFilters();
                    this.renderTable();
                },
            });
        }

        if (this.filters.selectedInputItems.length > 0) {
            const label =
                this.filters.selectedInputItems.length === 1
                    ? this.getItemName(this.filters.selectedInputItems[0])
                    : `${this.filters.selectedInputItems.length} input items`;
            badges.push({
                label: `Input: ${label}`,
                icon: this.filters.selectedInputItems[0],
                onRemove: () => {
                    this.filters.selectedInputItems = [];
                    this.applyFilters();
                    this.renderTable();
                },
            });
        }

        badges.forEach((badge) => {
            const el = document.createElement('div');
            el.style.cssText = `
                display: flex; align-items: center; gap: 6px;
                padding: 4px 8px; background: #3a3a3a;
                border: 1px solid #555; border-radius: 4px;
                color: #aaa; font-size: ${HISTORY_TYPE_SCALE.body};
            `;

            if (badge.icon) {
                this.appendItemIcon(el, badge.icon, 14);
            }

            const labelSpan = document.createElement('span');
            labelSpan.textContent = badge.label;
            el.appendChild(labelSpan);

            const removeBtn = document.createElement('button');
            removeBtn.textContent = '✕';
            removeBtn.style.cssText = `
                background: none; border: none; color: #aaa;
                cursor: pointer; padding: 0; font-size: ${HISTORY_TYPE_SCALE.body}; line-height: 1;
            `;
            removeBtn.addEventListener('click', badge.onRemove);
            el.appendChild(removeBtn);

            container.appendChild(el);
        });
    }

    /**
     * Render pagination controls
     */
    renderPagination() {
        const pagination = this.modal.querySelector('.mwi-coinify-history-pagination');
        while (pagination.firstChild) pagination.removeChild(pagination.firstChild);

        const leftSide = document.createElement('div');
        leftSide.style.cssText = 'display: flex; gap: 8px; align-items: center; color: #aaa;';

        const label = document.createElement('span');
        label.textContent = 'Rows per page:';

        const rowsInput = document.createElement('input');
        rowsInput.type = 'number';
        rowsInput.value = this.rowsPerPage;
        rowsInput.min = '1';
        rowsInput.disabled = this.showAll;
        rowsInput.style.cssText = `
            width: 60px; padding: 4px 8px;
            border: 1px solid #555; border-radius: 4px;
            background: ${this.showAll ? '#333' : '#1a1a1a'};
            color: ${this.showAll ? '#666' : '#fff'};
        `;
        rowsInput.addEventListener('change', (e) => {
            this.rowsPerPage = Math.max(1, parseInt(e.target.value) || 50);
            this.currentPage = 1;
            this.renderTable();
        });

        const showAllLabel = document.createElement('label');
        showAllLabel.style.cssText = 'cursor: pointer; color: #aaa; display: flex; align-items: center; gap: 4px;';

        const showAllCheckbox = document.createElement('input');
        showAllCheckbox.type = 'checkbox';
        showAllCheckbox.checked = this.showAll;
        showAllCheckbox.style.cursor = 'pointer';
        showAllCheckbox.addEventListener('change', (e) => {
            this.showAll = e.target.checked;
            rowsInput.disabled = this.showAll;
            rowsInput.style.background = this.showAll ? '#333' : '#1a1a1a';
            rowsInput.style.color = this.showAll ? '#666' : '#fff';
            this.currentPage = 1;
            this.renderTable();
        });

        showAllLabel.appendChild(showAllCheckbox);
        showAllLabel.appendChild(document.createTextNode('Show All'));

        leftSide.appendChild(label);
        leftSide.appendChild(rowsInput);
        leftSide.appendChild(showAllLabel);

        const rightSide = document.createElement('div');
        rightSide.style.cssText = 'display: flex; gap: 8px; align-items: center; color: #aaa;';

        if (!this.showAll) {
            const totalPages = this.getTotalPages();

            const prevBtn = document.createElement('button');
            prevBtn.textContent = '◀';
            prevBtn.disabled = this.currentPage === 1;
            prevBtn.style.cssText = `
                padding: 4px 12px;
                background: ${this.currentPage === 1 ? '#333' : '#4a90e2'};
                color: ${this.currentPage === 1 ? '#666' : 'white'};
                border: none; border-radius: 4px;
                cursor: ${this.currentPage === 1 ? 'default' : 'pointer'};
            `;
            prevBtn.addEventListener('click', () => {
                if (this.currentPage > 1) {
                    this.currentPage--;
                    this.renderTable();
                }
            });

            const pageInfo = document.createElement('span');
            pageInfo.textContent = `Page ${this.currentPage} of ${totalPages || 1}`;

            const nextBtn = document.createElement('button');
            nextBtn.textContent = '▶';
            nextBtn.disabled = this.currentPage >= totalPages;
            nextBtn.style.cssText = `
                padding: 4px 12px;
                background: ${this.currentPage >= totalPages ? '#333' : '#4a90e2'};
                color: ${this.currentPage >= totalPages ? '#666' : 'white'};
                border: none; border-radius: 4px;
                cursor: ${this.currentPage >= totalPages ? 'default' : 'pointer'};
            `;
            nextBtn.addEventListener('click', () => {
                if (this.currentPage < totalPages) {
                    this.currentPage++;
                    this.renderTable();
                }
            });

            rightSide.appendChild(prevBtn);
            rightSide.appendChild(pageInfo);
            rightSide.appendChild(nextBtn);
        } else {
            const info = document.createElement('span');
            info.textContent = `Showing all ${this.filteredSessions.length} sessions`;
            rightSide.appendChild(info);
        }

        pagination.appendChild(leftSide);
        pagination.appendChild(rightSide);
    }

    // ─── Filter Popups ───────────────────────────────────────────────────────

    /**
     * Show the appropriate filter popup for a column
     * @param {string} columnKey
     * @param {HTMLElement} buttonElement
     */
    showFilterPopup(columnKey, buttonElement) {
        // Toggle behavior
        if (this.activeFilterPopup && this.activeFilterButton === buttonElement) {
            this.closeActiveFilterPopup();
            return;
        }

        this.closeActiveFilterPopup();

        let popup;
        switch (columnKey) {
            case 'startTime':
                popup = this.createDateFilterPopup();
                break;
            case 'inputItemHrid':
                popup = this.createInputItemFilterPopup();
                break;
            default:
                return;
        }

        const rect = buttonElement.getBoundingClientRect();
        popup.style.position = 'fixed';
        popup.style.top = `${rect.bottom + 5}px`;
        popup.style.left = `${rect.left}px`;
        popup.style.zIndex = '10002';

        document.body.appendChild(popup);
        this.activeFilterPopup = popup;
        this.activeFilterButton = buttonElement;

        this.popupCloseHandler = (e) => {
            if (e.target.type === 'date' || e.target.closest?.('input[type="date"]')) return;
            if (!popup.contains(e.target) && e.target !== buttonElement) {
                this.closeActiveFilterPopup();
            }
        };
        const t = setTimeout(() => document.addEventListener('click', this.popupCloseHandler), 10);
        this.timerRegistry.registerTimeout(t);
    }

    /**
     * Close and clean up the active filter popup
     */
    closeActiveFilterPopup() {
        if (this.activeFilterPopup) {
            this.activeFilterPopup.remove();
            this.activeFilterPopup = null;
        }
        if (this.popupCloseHandler) {
            document.removeEventListener('click', this.popupCloseHandler);
            this.popupCloseHandler = null;
        }
        this.activeFilterButton = null;
    }

    /**
     * Create date range filter popup
     * @returns {HTMLElement}
     */
    createDateFilterPopup() {
        const popup = this.createPopupBase('Filter by Date');

        // Compute available range
        if (!this.cachedDateRange) {
            const timestamps = this.sessions.map((s) => s.startTime).filter(Boolean);
            if (timestamps.length > 0) {
                this.cachedDateRange = {
                    minDate: new Date(Math.min(...timestamps)),
                    maxDate: new Date(Math.max(...timestamps)),
                };
            } else {
                this.cachedDateRange = { minDate: null, maxDate: null };
            }
        }

        const { minDate, maxDate } = this.cachedDateRange;

        if (minDate && maxDate) {
            const rangeInfo = document.createElement('div');
            rangeInfo.style.cssText = `
                color: #aaa; font-size: ${HISTORY_TYPE_SCALE.note}; margin-bottom: 10px;
                padding: 6px; background: #1a1a1a; border-radius: 3px;
            `;
            rangeInfo.textContent = `Available: ${formatDateTime(minDate, { includeTime: false })} - ${formatDateTime(maxDate, { includeTime: false })}`;
            popup.appendChild(rangeInfo);
        }

        const fromInput = this.createDateInput(
            'From:',
            this.formatLocalDateValue(this.filters.dateFrom),
            minDate,
            maxDate
        );
        const toInput = this.createDateInput('To:', this.formatLocalDateValue(this.filters.dateTo), minDate, maxDate);

        popup.appendChild(fromInput.label);
        popup.appendChild(fromInput.input);
        popup.appendChild(toInput.label);
        popup.appendChild(toInput.input);

        const btnRow = this.createPopupButtonRow(
            () => {
                this.filters.dateFrom = this.parseLocalDate(fromInput.input.value);
                this.filters.dateTo = this.parseLocalDate(toInput.input.value);
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            },
            () => {
                this.filters.dateFrom = null;
                this.filters.dateTo = null;
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            }
        );
        popup.appendChild(btnRow);

        return popup;
    }

    /**
     * Create input item filter popup (checkbox list with search)
     * @returns {HTMLElement}
     */
    createInputItemFilterPopup() {
        const popup = this.createPopupBase('Filter by Input Item');
        popup.style.minWidth = '220px';

        // Gather unique input items from all sessions
        const itemSet = new Map();
        this.sessions.forEach((s) => {
            if (!itemSet.has(s.inputItemHrid)) {
                itemSet.set(s.inputItemHrid, this.getItemName(s.inputItemHrid));
            }
        });
        const allItems = Array.from(itemSet.entries()).sort((a, b) => a[1].localeCompare(b[1]));

        // Track pending selection (local to this popup)
        const pending = new Set(this.filters.selectedInputItems);

        // Search box
        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Search items...';
        searchInput.style.cssText = `
            width: 100%; padding: 6px; margin-bottom: 8px;
            background: #1a1a1a; border: 1px solid #555;
            border-radius: 3px; color: #fff; box-sizing: border-box;
        `;

        const listContainer = document.createElement('div');
        listContainer.style.cssText = 'max-height: 200px; overflow-y: auto;';

        const renderList = (filterText) => {
            while (listContainer.firstChild) listContainer.removeChild(listContainer.firstChild);
            const term = filterText.toLowerCase();
            const visible = term ? allItems.filter(([, name]) => name.toLowerCase().includes(term)) : allItems;

            visible.forEach(([hrid, name]) => {
                const row = document.createElement('label');
                row.style.cssText = `
                    display: flex; align-items: center; gap: 8px;
                    padding: 4px 2px; cursor: pointer; color: #ddd;
                `;

                const cb = document.createElement('input');
                cb.type = 'checkbox';
                cb.checked = pending.has(hrid);
                cb.style.cursor = 'pointer';
                cb.addEventListener('change', () => {
                    if (cb.checked) pending.add(hrid);
                    else pending.delete(hrid);
                });

                this.appendItemIcon(row, hrid, 16);

                const nameSpan = document.createElement('span');
                nameSpan.textContent = name;

                row.appendChild(cb);
                row.appendChild(nameSpan);
                listContainer.appendChild(row);
            });
        };

        searchInput.addEventListener('input', () => renderList(searchInput.value));
        renderList('');

        popup.appendChild(searchInput);
        popup.appendChild(listContainer);

        const btnRow = this.createPopupButtonRow(
            () => {
                this.filters.selectedInputItems = Array.from(pending);
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            },
            () => {
                this.filters.selectedInputItems = [];
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            }
        );
        popup.appendChild(btnRow);

        return popup;
    }

    // ─── Popup Helpers ───────────────────────────────────────────────────────

    /**
     * Create a styled popup base div with a title
     * @param {string} titleText
     * @returns {HTMLElement}
     */
    createPopupBase(titleText) {
        const popup = document.createElement('div');
        popup.style.cssText = `
            background: #2a2a2a; border: 1px solid #555;
            border-radius: 4px; padding: 12px; min-width: 200px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.5);
        `;

        const title = document.createElement('div');
        title.textContent = titleText;
        title.style.cssText = 'color: #fff; font-weight: bold; margin-bottom: 10px;';
        popup.appendChild(title);

        return popup;
    }

    /**
     * Create a date input with label
     * @param {string} labelText
     * @param {string} value
     * @param {Date|null} minDate
     * @param {Date|null} maxDate
     * @returns {{ label: HTMLElement, input: HTMLInputElement }}
     */
    createDateInput(labelText, value, minDate, maxDate) {
        const label = document.createElement('label');
        label.textContent = labelText;
        label.style.cssText = `display: block; color: #aaa; margin-bottom: 4px; font-size: ${HISTORY_TYPE_SCALE.note};`;

        const input = document.createElement('input');
        input.type = 'date';
        input.value = value;
        if (minDate) input.min = minDate.toISOString().split('T')[0];
        if (maxDate) input.max = maxDate.toISOString().split('T')[0];
        input.style.cssText = `
            width: 100%; padding: 6px; background: #1a1a1a;
            border: 1px solid #555; border-radius: 3px; color: #fff; margin-bottom: 10px;
        `;

        return { label, input };
    }

    /**
     * Parse a YYYY-MM-DD date input value as local midnight.
     * new Date('YYYY-MM-DD') parses as UTC midnight, shifting the day boundary by the timezone offset.
     * @param {string} value
     * @returns {Date|null}
     */
    parseLocalDate(value) {
        if (!value) return null;
        const [y, m, d] = value.split('-').map(Number);
        return new Date(y, m - 1, d);
    }

    /**
     * Format a Date as a YYYY-MM-DD input value using local calendar fields
     * @param {Date|null} date
     * @returns {string}
     */
    formatLocalDateValue(date) {
        if (!date) return '';
        const pad = (n) => String(n).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    }

    /**
     * Create Apply + Clear button row for filter popups
     * @param {Function} onApply
     * @param {Function} onClear
     * @returns {HTMLElement}
     */
    createPopupButtonRow(onApply, onClear) {
        const row = document.createElement('div');
        row.style.cssText = 'display: flex; gap: 8px; margin-top: 10px;';

        const applyBtn = document.createElement('button');
        applyBtn.textContent = 'Apply';
        applyBtn.style.cssText = `
            flex: 1; padding: 6px; background: #4a90e2; color: white;
            border: none; border-radius: 3px; cursor: pointer;
        `;
        applyBtn.addEventListener('click', onApply);

        const clearBtn = document.createElement('button');
        clearBtn.textContent = 'Clear';
        clearBtn.style.cssText = `
            flex: 1; padding: 6px; background: #666; color: white;
            border: none; border-radius: 3px; cursor: pointer;
        `;
        clearBtn.addEventListener('click', onClear);

        row.appendChild(applyBtn);
        row.appendChild(clearBtn);
        return row;
    }

    // ─── Utilities ───────────────────────────────────────────────────────────

    /**
     * Append a 16×16 or 20×20 SVG item icon to an element
     * @param {HTMLElement} parent
     * @param {string} itemHrid
     * @param {number} size
     */
    appendItemIcon(parent, itemHrid, size = 20) {
        const spriteUrl = this.getItemsSpriteUrl();
        if (!spriteUrl) return;

        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('width', String(size));
        svg.setAttribute('height', String(size));
        svg.style.flexShrink = '0';

        const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
        use.setAttribute('href', `${spriteUrl}#${itemHrid.split('/').pop()}`);
        svg.appendChild(use);
        parent.appendChild(svg);
    }

    /**
     * Get items sprite URL from DOM (cached)
     * @returns {string|null}
     */
    getItemsSpriteUrl() {
        if (!this.itemsSpriteUrl) {
            const el = document.querySelector('use[href*="items_sprite"]');
            if (el) {
                const href = el.getAttribute('href');
                this.itemsSpriteUrl = href ? href.split('#')[0] : null;
            }
        }
        return this.itemsSpriteUrl;
    }

    /**
     * Get item display name from HRID (cached)
     * @param {string} itemHrid
     * @returns {string}
     */
    getItemName(itemHrid) {
        if (this.itemNameCache.has(itemHrid)) {
            return this.itemNameCache.get(itemHrid);
        }
        const details = dataManager.getItemDetails(itemHrid);
        const name = details?.name || itemHrid.split('/').pop().replace(/_/g, ' ');
        this.itemNameCache.set(itemHrid, name);
        return name;
    }

    /**
     * Get paginated sessions for current page
     * @returns {Array}
     */
    getPaginatedSessions() {
        if (this.showAll) return this.filteredSessions;
        const start = (this.currentPage - 1) * this.rowsPerPage;
        return this.filteredSessions.slice(start, start + this.rowsPerPage);
    }

    /**
     * Get total number of pages
     * @returns {number}
     */
    getTotalPages() {
        if (this.showAll) return 1;
        return Math.ceil(this.filteredSessions.length / this.rowsPerPage);
    }

    /**
     * Delete a single session by ID
     * @param {string} sessionId
     */
    async deleteSession(sessionId) {
        try {
            // Reload before filtering — persisting the modal-open snapshot would erase
            // sessions the tracker saved while the modal was open
            const fresh = await coinifyHistoryTracker.loadSessions();
            this.sessions = fresh.filter((s) => s.id !== sessionId);
            await coinifyHistoryTracker.deleteSessions(this.sessions);
        } catch (error) {
            console.error('[CoinifyHistoryViewer] Failed to delete session:', error);
        }

        this.applyFilters();
        this.renderTable();
    }

    /**
     * The Data Note cell for a session's CSV export row: the same qualification
     * the on-screen Profit column marks with `*`, spelled out in readable text —
     * a spreadsheet reader has no legend for the symbol, so a qualified row
     * exported as a plain number reads more confident than the same row on
     * screen. Empty when nothing qualifies the row.
     * @param {Object} detail - A `computeSessionProfit` result
     * @returns {string} The note, or ''
     */
    buildDataNote(detail) {
        return detail.inputUnpriced ? 'input unpriced — total is incomplete' : '';
    }

    /**
     * Export all sessions to a CSV file download
     */
    exportHistory() {
        const escape = (val) => `"${String(val === null || val === undefined ? '' : val).replace(/"/g, '""')}"`;

        const headers = [
            'Session Start',
            'Input Item',
            'Enhancement Level',
            'Attempts',
            'Successes',
            'Failures',
            'Success Rate',
            'Coins Earned',
            'Catalyst of Coinification Used',
            'Prime Catalyst Used',
            'Profit',
            'Data Note',
        ];

        const rows = this.sessions.map((session) => {
            const start = formatDateTime(new Date(session.startTime));
            const inputName = this.getItemName(session.inputItemHrid);
            const failures = session.totalAttempts - session.totalSuccesses;
            const rate =
                session.totalAttempts > 0
                    ? `${((session.totalSuccesses / session.totalAttempts) * 100).toFixed(1)}%`
                    : '—';
            const detail = this.profitCache.get(session.id) || this.computeSessionProfit(session);

            return [
                start,
                inputName,
                session.enhancementLevel,
                session.totalAttempts,
                session.totalSuccesses,
                failures,
                rate,
                session.totalCoinsEarned || 0,
                session.catalystOfCoinificationUsed || 0,
                session.primeCatalystUsed || 0,
                Math.round(detail.profit),
                this.buildDataNote(detail),
            ]
                .map(escape)
                .join(',');
        });

        const csv = [headers.map(escape).join(','), ...rows].join('\n');
        const date = new Date().toISOString().slice(0, 10);
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `coinify-history-${date}.csv`;
        a.click();

        URL.revokeObjectURL(url);
    }

    /**
     * Download a lossless JSON backup of the current character's stored
     * coinify sessions — the exact unmerged records the tracker persists,
     * wrapped in the same envelope the other two windows use. See
     * `alchemy-session-import.js` for the envelope shape and which fields
     * are safe to hand-edit.
     * @returns {Promise<void>}
     */
    async exportBackup() {
        const characterId = dataManager.getCurrentCharacterId();
        const stored = await coinifyHistoryTracker.loadStoredSessions();
        const envelope = buildAlchemyBackupEnvelope({ kind: 'coinify', characterId, sessions: stored });
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(
            `coinify-history-backup-${date}.json`,
            JSON.stringify(envelope, null, 2),
            'application/json;charset=utf-8;'
        );
    }

    /**
     * Open a file picker for a JSON backup and import whatever is chosen.
     *
     * A single hidden `<input type="file">` is reused across openings rather
     * than recreated each time, and its value is cleared after every change
     * so picking the same file twice in a row still fires `change`.
     */
    triggerImportBackup() {
        if (!this.importInput) {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.style.display = 'none';
            input.addEventListener('change', async (event) => {
                const file = event.target.files?.[0];
                input.value = '';
                if (!file) return;
                await this.importBackupFile(file);
            });
            document.body.appendChild(input);
            this.importInput = input;
        }
        this.importInput.click();
    }

    /**
     * @param {File} file - The chosen file
     * @returns {Promise<void>}
     */
    async importBackupFile(file) {
        let text;
        try {
            text = await file.text();
        } catch (error) {
            alert(`Could not read the file: ${error.message}`);
            return;
        }
        await this.importBackupText(text);
    }

    /**
     * Validate and merge a JSON backup's sessions into the stored history,
     * after a confirmation summary. Nothing is written until the user
     * confirms, and any refusal below leaves storage untouched.
     *
     * **The character-swap race class**: the active character is captured
     * before the first `await` and re-checked after every one that follows.
     * A change anywhere in that window cancels the import rather than
     * writing a payload built for one character into another's history.
     *
     * **Live session guard**: import is refused outright while a session for
     * this kind is actively recording, rather than attempting to merge
     * around it — see the note in `transmute-history-viewer.js#importBackupText`
     * for why refusing beats trying to merge past a save in flight.
     *
     * @param {string} text - The file's raw contents
     * @returns {Promise<void>}
     */
    async importBackupText(text) {
        // Captured before any further await — see the race note above
        const charIdBefore = dataManager.getCurrentCharacterId();
        const scopeBefore = coinifyHistoryTracker.getCharacterScope();

        const parsed = parseAlchemyBackupJson(text);
        if (!parsed.ok) {
            alert(`Import refused: ${parsed.error}`);
            return;
        }

        const envelope = parsed.envelope;
        const envelopeCheck = validateAlchemyBackupEnvelope(envelope, { kind: 'coinify' });
        if (!envelopeCheck.ok) {
            alert(`Import refused: ${envelopeCheck.error}`);
            return;
        }

        const sessionsCheck = validateAlchemySessions('coinify', envelope.sessions);
        if (!sessionsCheck.ok) {
            alert(`Import refused: ${sessionsCheck.error}\n\nNothing was written.`);
            return;
        }

        if (envelope.characterId && envelope.characterId !== charIdBefore) {
            const proceed = confirm(
                `This backup was exported from a different character (${envelope.characterId}), ` +
                    `not the current one (${charIdBefore}).\n\nImport it into the CURRENT character anyway?`
            );
            if (!proceed) return;
        }

        if (coinifyHistoryTracker.activeSession) {
            alert('A coinify session is actively recording — stop it, then try the import again.');
            return;
        }

        const stored = await coinifyHistoryTracker.loadStoredSessions();

        if (
            dataManager.getCurrentCharacterId() !== charIdBefore ||
            coinifyHistoryTracker.getCharacterScope() !== scopeBefore
        ) {
            alert('The active character changed during import — cancelled to avoid writing to the wrong character.');
            return;
        }
        if (coinifyHistoryTracker.activeSession) {
            alert('A coinify session started recording during import — cancelled. Try again once it ends.');
            return;
        }

        const plan = planAlchemyImportMerge(stored, envelope.sessions);

        const confirmed = confirm(
            `Import ${envelope.sessions.length} session(s) into Coinify History:\n` +
                `${plan.replaced} replaced, ${plan.added} added, ${plan.unchanged} unchanged.\n\nContinue?`
        );
        if (!confirmed) return;

        if (
            dataManager.getCurrentCharacterId() !== charIdBefore ||
            coinifyHistoryTracker.getCharacterScope() !== scopeBefore ||
            coinifyHistoryTracker.activeSession
        ) {
            alert('The active character changed — import cancelled to avoid writing to the wrong character.');
            return;
        }

        const written = await coinifyHistoryTracker.importSessions(plan.merged);
        if (!written) {
            alert('Import failed: the sessions could not be written to storage. Nothing changed.');
            return;
        }

        this.sessions = await coinifyHistoryTracker.loadSessions();
        this.cachedDateRange = null;
        this.profitCache.clear();
        this.applyFilters();
        if (this.modal) this.renderTable();

        alert(`Import complete: ${plan.replaced} replaced, ${plan.added} added, ${plan.unchanged} unchanged.`);
    }

    /**
     * Clear all history after confirmation
     */
    async clearHistory() {
        const confirmed = confirm(
            `This will permanently delete ALL coinify history (${this.sessions.length} sessions).\nThis cannot be undone.\n\nAre you sure?`
        );
        if (!confirmed) return;

        try {
            // A clear that could not list the store deleted nothing, and the
            // sessions are still on disk — emptying the table and saying
            // "cleared" would be a lie the next reload exposes.
            if (!(await coinifyHistoryTracker.clearHistory())) {
                alert('Coinify history could NOT be cleared — storage could not be read. Nothing was deleted.');
                return;
            }
            this.sessions = [];
            this.filteredSessions = [];
            alert('Coinify history cleared.');
            this.applyFilters();
            this.renderTable();
        } catch (error) {
            console.error('[CoinifyHistoryViewer] Failed to clear history:', error);
            alert(`Failed to clear history: ${error.message}`);
        }
    }
}

const coinifyHistoryViewer = new CoinifyHistoryViewer();

export { coinifyHistoryViewer };

export default {
    name: 'Coinify History Viewer',
    initialize: () => coinifyHistoryViewer.initialize(),
    cleanup: () => {
        try {
            return coinifyHistoryViewer.disable();
        } catch (error) {
            console.error('[Coinify History Viewer] Disable failed part-way:', error);
        } finally {
            coinifyHistoryViewer.isInitialized = false;
        }
    },
};
