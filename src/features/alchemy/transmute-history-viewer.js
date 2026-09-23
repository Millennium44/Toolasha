/**
 * Transmute History Viewer
 * Modal UI for browsing transmute session history.
 * Injected as a tab in the alchemy panel tab bar.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { transmuteHistoryTracker } from './transmute-history-tracker.js';
import { getItemPrice } from '../../utils/market-data.js';
import { formatKMB, formatDateTime } from '../../utils/formatters.js';
import { formatInputCostLine, priceInputWithRefinementFallback } from '../../utils/refined-item-cost.js';
import { createMutationWatcher } from '../../utils/dom-observer-helpers.js';
import { createTimerRegistry } from '../../utils/timer-registry.js';
import { getAlchemyCoinCost } from '../../utils/alchemy-fees.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
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
    poolEquivalentGroups,
    renderTotalsSection,
    totalsRowStyle,
} from './history-totals-table.js';
import { renderCatalystColumnHeader, renderCatalystCountCell } from './alchemy-catalyst-columns.js';
import { computeExpectedSuccesses, formatExpectedSuccesses } from './alchemy-expected-successes.js';
import {
    appendPreFixMarker,
    createPreFixToggle,
    loadIncludePreFix,
    preFixLegend,
    saveIncludePreFix,
    totalsSessions,
} from './alchemy-pre-fix-sessions.js';
import { getAlchemyOutputShopValue, describeShopValue } from './alchemy-shop-value.js';

const CATALYST_OF_TRANSMUTATION_HRID = '/items/catalyst_of_transmutation';
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
 * Columns of the "Totals by Input Item" table, with the tooltips that keep
 * each figure honest about what it is and is not counting.
 * @type {Array<{label: string, title?: string}>}
 */
const TRANSMUTE_TOTALS_COLUMNS = [
    { label: 'Input Item' },
    { label: 'Sessions' },
    { label: 'Attempts' },
    { label: 'Consumed' },
    { label: 'Successes' },
    { label: 'Revenue' },
    { label: 'Input Cost' },
    {
        label: 'Catalyst Cost',
        title:
            'Catalysts actually seen being consumed, at current buy price — a mid-session swap is costed ' +
            'against both. Sessions recorded before that tracking existed are estimated as the catalyst in ' +
            'the slot at session start × successes, and are marked ◇.',
    },
    { label: 'Coin Cost' },
    { label: 'Net' },
    {
        label: 'Inputs/Jackpot',
        title:
            'Inputs consumed per non-self-return output. Self-returns are excluded from this count — a ' +
            'self-return hands back the same item you put in, so it costs nothing and counts as neither ' +
            'an input nor an output here. This is the real price of the outputs that were actually worth ' +
            'something, not the inflated figure you get from dividing by every "success" including the ' +
            'free round-trips.',
    },
    {
        label: 'Break-even Input',
        title:
            'Input value at which revenue exactly covers catalyst + coin cost for what was consumed. ' +
            'Above this, the recorded catalyst paid for itself; below it, it did not.',
    },
];

/** Footnote markers under the totals table. @type {Array<string>} */
const TRANSMUTE_TOTALS_LEGEND = [
    '* input unpriced — total is incomplete',
    '† catalyst on some sessions could not be priced — excluded, not zero',
    '‡ catalyst not recorded on some sessions (predates tracking) — excluded, not zero',
    '◇ catalyst estimated on some sessions, not measured',
    '¶ output unpriced — total is incomplete, not zero-earning; Net and Break-even Input carry the same mark',
    '‖ output valued at its best Labyrinth Shop conversion, not a market price',
    'A "Pooled" row adds up inputs the game data says are the same bet — hover it for the members',
    '§ self-return counts on some sessions were derived from the recorded successes, not observed — ' +
        'and that success count is itself approximate on these sessions (recorded through the same batching ' +
        'bug), so input cost on them is likely understated, not just approximate',
];

class TransmuteHistoryViewer {
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
            resultsSearch: '', // Text search for result item names
        };

        this.activeFilterPopup = null;
        this.activeFilterButton = null;
        this.popupCloseHandler = null;

        // Computed profit per session id — kept out of the session objects so
        // it is never persisted back to storage
        this.profitCache = new Map();

        // Whether the totals table sums sessions recorded before the 2026-09-23
        // tracker fix; remembered per window, read on open
        this.includePreFix = true;

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

        if (!config.getSetting('alchemy_transmuteHistory')) {
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
     * Inject "Transmute History" tab into the alchemy tab bar.
     * The alchemy tab bar contains Coinify, Decompose, Transmute, Unrefine, Current Action.
     * We identify it by the presence of a "Transmute" tab text.
     */
    addAlchemyTab() {
        const ensureTabExists = () => {
            const tablist = document.querySelector('[role="tablist"]');
            if (!tablist) return;

            // Verify this is the alchemy tablist by checking for "Transmute" tab
            const hasTransmute = Array.from(tablist.children).some(
                (btn) => btn.textContent.includes('Transmute') && !btn.dataset.mwiTransmuteHistoryTab
            );
            if (!hasTransmute) return;

            // Already injected?
            if (tablist.querySelector('[data-mwi-transmute-history-tab="true"]')) return;

            // Clone an existing tab for structure
            const referenceTab = Array.from(tablist.children).find(
                (btn) => btn.textContent.includes('Transmute') && !btn.dataset.mwiTransmuteHistoryTab
            );
            if (!referenceTab) return;

            const tab = referenceTab.cloneNode(true);
            tab.setAttribute('data-mwi-transmute-history-tab', 'true');
            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            // Set label
            const badge = tab.querySelector('.TabsComponent_badge__1Du26');
            if (badge) {
                // Replace first text node (the label) while keeping badge span
                const badgeSpan = badge.querySelector('.MuiBadge-badge');
                badge.textContent = '';
                badge.appendChild(document.createTextNode('Transmute History'));
                if (badgeSpan) badge.appendChild(badgeSpan);
            } else {
                tab.textContent = 'Transmute History';
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
        this.sessions = await transmuteHistoryTracker.loadSessions();
        this.includePreFix = await loadIncludePreFix('transmute');
        this.cachedDateRange = null;
        this.profitCache.clear();
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
        this.modal.className = 'mwi-transmute-history-modal';
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
        content.className = 'mwi-transmute-history-content';
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
        title.textContent = 'Transmute History';
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
        controls.className = 'mwi-transmute-history-controls';
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
        badges.className = 'mwi-transmute-history-badges';
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
        tableContainer.className = 'mwi-transmute-history-table-container';
        tableContainer.style.cssText = 'overflow-x: auto;';

        // Totals-by-input-item container
        const totalsContainer = document.createElement('div');
        totalsContainer.className = 'mwi-transmute-history-totals-container';
        totalsContainer.style.cssText = 'overflow-x: auto;';

        // Pagination
        const pagination = document.createElement('div');
        pagination.className = 'mwi-transmute-history-pagination';
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

        for (const session of this.sessions) {
            if (!this.profitCache.has(session.id)) {
                this.profitCache.set(session.id, this.computeSessionProfit(session));
            }
        }

        const hasDateFilter = !!(this.filters.dateFrom || this.filters.dateTo);
        let dateToEndOfDay = null;
        if (hasDateFilter && this.filters.dateTo) {
            dateToEndOfDay = new Date(this.filters.dateTo);
            dateToEndOfDay.setHours(23, 59, 59, 999);
        }

        const hasItemFilter = this.filters.selectedInputItems.length > 0;
        const itemFilterSet = hasItemFilter ? new Set(this.filters.selectedInputItems) : null;

        const hasResultsFilter = !!this.filters.resultsSearch.trim();
        const resultsSearch = hasResultsFilter ? this.filters.resultsSearch.trim().toLowerCase() : '';

        const filtered = this.sessions.filter((session) => {
            // Date filter
            if (hasDateFilter) {
                const d = new Date(session.startTime);
                if (this.filters.dateFrom && d < this.filters.dateFrom) return false;
                if (dateToEndOfDay && d > dateToEndOfDay) return false;
            }

            // Input item filter
            if (hasItemFilter && !itemFilterSet.has(session.inputItemHrid)) return false;

            // Results text search
            if (hasResultsFilter) {
                const resultNames = Object.keys(session.results || {}).map((hrid) =>
                    this.getItemName(hrid).toLowerCase()
                );
                if (!resultNames.some((name) => name.includes(resultsSearch))) return false;
            }

            return true;
        });

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
            case 'results':
                return !!this.filters.resultsSearch.trim();
            default:
                return false;
        }
    }

    /**
     * Returns true if any filter is active
     */
    hasAnyFilter() {
        return (
            this.hasActiveFilter('startTime') ||
            this.hasActiveFilter('inputItemHrid') ||
            this.hasActiveFilter('results')
        );
    }

    /**
     * Clear all filters
     */
    clearAllFilters() {
        this.filters.dateFrom = null;
        this.filters.dateTo = null;
        this.filters.selectedInputItems = [];
        this.filters.resultsSearch = '';
        this.applyFilters();
        this.renderTable();
    }

    // ─── Rendering ───────────────────────────────────────────────────────────

    /**
     * Full render: controls + badges + table + pagination
     */
    renderTable() {
        this.renderControls();
        this.renderBadges();

        const tableContainer = this.modal.querySelector('.mwi-transmute-history-table-container');
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
            { key: 'totalAttempts', label: 'Attempts', filterable: false },
            { key: 'totalSuccesses', label: 'Successes', filterable: false },
            {
                key: '_expected',
                label: 'Expected',
                filterable: false,
                title: 'Attempts × the success rate predicted when the session started, and how far actual successes landed from it.',
            },
            { key: 'results', label: 'Results', filterable: true },
            { key: '_catalystOfTransmutation', label: 'Catalyst of Transmutation', filterable: false },
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

            const isCatalystCol = col.key === '_catalystOfTransmutation' || col.key === '_primeCatalyst';
            // 'results' holds an object with no meaningful sort order; the new icon-headed
            // catalyst columns and the Expected column have no field of their own to sort by
            const isSortable = col.key !== 'results' && !isCatalystCol && col.key !== '_expected';

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
                const hrid =
                    col.key === '_catalystOfTransmutation' ? CATALYST_OF_TRANSMUTATION_HRID : PRIME_CATALYST_HRID;
                renderCatalystColumnHeader(th, labelSpan, col.label, hrid, (el, h, size) =>
                    this.appendItemIcon(el, h, size)
                );
            } else {
                labelSpan.textContent = col.label;
                labelSpan.style.cursor = 'default';
                if (col.title) {
                    labelSpan.title = col.title;
                    th.title = col.title;
                }
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
                    ? 'No transmute history recorded yet.'
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
                appendPreFixMarker(dateCell, session, 'transmute');
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

                // Expected — attempts × the rate predicted when the session started
                const expectedCell = document.createElement('td');
                const expected = computeExpectedSuccesses(session);
                expectedCell.textContent = formatExpectedSuccesses(expected);
                expectedCell.style.cssText = 'padding: 6px 10px;';
                if (!expected) {
                    expectedCell.title = 'This session predates the predicted-rate stamp — nothing to compare against.';
                    expectedCell.style.color = '#888';
                }
                row.appendChild(expectedCell);

                // Results
                const resultsCell = document.createElement('td');
                resultsCell.style.cssText = 'padding: 6px 10px;';
                this.renderResultsCell(resultsCell, session);
                row.appendChild(resultsCell);

                // Catalyst of Transmutation / Prime Catalyst
                const profitDetailForCatalysts = this.profitCache.get(session.id) || this.computeSessionProfit(session);
                const catCell = document.createElement('td');
                catCell.style.cssText = 'padding: 6px 10px; text-align: center;';
                this.renderTransmuteCatalystCell(catCell, profitDetailForCatalysts, CATALYST_OF_TRANSMUTATION_HRID);
                row.appendChild(catCell);

                const pcCell = document.createElement('td');
                pcCell.style.cssText = 'padding: 6px 10px; text-align: center;';
                this.renderTransmuteCatalystCell(pcCell, profitDetailForCatalysts, PRIME_CATALYST_HRID);
                row.appendChild(pcCell);

                // Profit
                const profitCell = document.createElement('td');
                const profitDetail = this.profitCache.get(session.id) || this.computeSessionProfit(session);
                // An unpriced input makes the figure incomplete, not zero-cost,
                // and an unpriced output is the same gap on the other side —
                // each has its own mark so the two are never confused with a
                // real loss or a real zero
                profitCell.textContent =
                    formatKMB(profitDetail.profit, 1) +
                    (profitDetail.inputUnpriced ? '*' : '') +
                    (profitDetail.revenueUnpriced ? '¶' : '') +
                    (profitDetail.revenueShopValued ? '‖' : '');
                profitCell.style.cssText = `
                    padding: 6px 10px;
                    font-weight: bold;
                    color: ${profitDetail.profit >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS};
                `;
                profitCell.title =
                    `Output value: ${formatKMB(profitDetail.revenue, 1)}` +
                    `${profitDetail.revenueUnpriced ? ' (¶ unpriced — incomplete, not zero)' : ''}` +
                    `${profitDetail.revenueShopValued ? ' (‖ includes a shop-derived value — see the result line below)' : ''}\n` +
                    `${formatInputCostLine(profitDetail)}\n` +
                    `Transmute coins: −${formatKMB(profitDetail.coinCost, 1)}\n` +
                    `${this.formatCatalystLine(profitDetail)} (see totals row below)\n` +
                    `${this.formatRepairLine(session)}` +
                    `Excludes teas`;
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
     * Consumed/cost figures use the same per-session `computeSessionProfit`
     * result already cached by `applyFilters`, so the totals row and the
     * per-row Profit column can never disagree about a single session's math.
     *
     * A group whose recorded counts are internally impossible (more result
     * entries than successes, or a consumed count that clamped to zero despite
     * real attempts — the signature of the self-return batching bug) is
     * flagged rather than totaled: averaging corrupt sessions in with good
     * ones would present a confident number that is simply wrong. The
     * recorded success count itself is not exempt — it comes from the same
     * per-message delta counting that inflated the self-returns, so a flagged
     * group's `successes`/`successRate` are exactly as unreliable as its
     * `netConsumed` and must be hidden alongside it, not shown as if sound.
     * The overall "All items" row inherits the flag from any flagged group it
     * contains, for the same reason: excluding a corrupt group's consumed
     * count while still summing its revenue and cost into a displayed Net is
     * the same mistake in a different column.
     *
     * @returns {Array<Object>} One entry per distinct inputItemHrid
     */
    computeInputItemTotals() {
        return groupSessionsByInputItem(totalsSessions(this.filteredSessions, this.includePreFix), {
            getDetail: (session) => this.profitCache.get(session.id) || this.computeSessionProfit(session),
            getSortName: (hrid) => this.getItemName(hrid),
            createGroup: (hrid) => ({
                inputItemHrid: hrid,
                sessionCount: 0,
                attempts: 0,
                successes: 0,
                netConsumed: 0,
                nonSelfReturnOutputs: 0,
                revenue: 0,
                revenueUnpriced: false,
                revenueShopValued: false,
                inputCost: 0,
                inputUnpriced: false,
                coinCost: 0,
                catalystCost: 0,
                catalystRecordedSessions: 0,
                catalystUnrecordedSessions: 0,
                catalystUnpricedSessions: 0,
                catalystEstimatedSessions: 0,
                catalystHrids: new Set(),
                repairedSessions: 0,
                unreliableSessions: 0,
                impossible: false,
            }),
            accumulate: (group, session, detail) => {
                group.sessionCount++;
                group.attempts += session.totalAttempts || 0;
                group.successes += session.totalSuccesses || 0;
                group.netConsumed += detail.netConsumed;
                group.nonSelfReturnOutputs += detail.nonSelfReturnOutputs;
                group.revenue += detail.revenue;
                if (detail.revenueUnpriced) group.revenueUnpriced = true;
                if (detail.revenueShopValued) group.revenueShopValued = true;
                group.inputCost += detail.inputCost;
                if (detail.inputUnpriced) group.inputUnpriced = true;
                group.coinCost += detail.coinCost;

                if (detail.catalystEntries.length > 0) {
                    group.catalystRecordedSessions++;
                    for (const entry of detail.catalystEntries) group.catalystHrids.add(entry.hrid);
                    if (detail.catalystUnpriced) group.catalystUnpricedSessions++;
                    if (detail.catalystEstimated) group.catalystEstimatedSessions++;
                    group.catalystCost += detail.catalystCost;
                } else if (detail.catalystUnrecorded) {
                    group.catalystUnrecordedSessions++;
                }

                if (session.repair?.outcome === 'repaired') group.repairedSessions++;
                if (session.repair?.outcome === 'unreliable') group.unreliableSessions++;

                const resultCount = Object.values(session.results || {}).reduce((sum, r) => sum + (r.count || 0), 0);
                const successes = session.totalSuccesses || 0;
                const attempts = session.totalAttempts || 0;
                if (
                    session.repair?.outcome === 'unreliable' ||
                    resultCount > successes ||
                    (detail.netConsumed === 0 && attempts > 0)
                ) {
                    group.impossible = true;
                }
            },
            finalize: (group) => {
                const net = group.revenue - group.inputCost - group.catalystCost - group.coinCost;
                const successRate = group.attempts > 0 ? group.successes / group.attempts : null;
                // Most "successes" are self-returns — the same item handed straight
                // back, costing nothing and gaining nothing. Dividing by successes
                // reads as though those free round-trips were purchases, so the
                // denominator here is only the non-self-return ("jackpot") outputs.
                // A group that produced nothing but self-returns has no meaningful
                // ratio at all; null (rendered as a dash) beats a division by zero.
                const inputsPerOutput =
                    group.nonSelfReturnOutputs > 0 ? group.netConsumed / group.nonSelfReturnOutputs : null;
                // The input value at which recorded revenue exactly covers catalyst
                // and coin cost for what was consumed — answers "was the recorded
                // catalyst worth it" without needing to know what the input is
                // worth. Above this value, it paid for itself; below it, it did not.
                const breakEvenInputValue =
                    group.netConsumed > 0
                        ? (group.revenue - group.catalystCost - group.coinCost) / group.netConsumed
                        : null;

                return { ...group, net, successRate, inputsPerOutput, breakEvenInputValue };
            },
        });
    }

    /**
     * A signature two transmute inputs share only when transmuting one is
     * genuinely the same gamble as transmuting the other.
     *
     * Four refined capes are each a handful of attempts against a ~6.5% jackpot,
     * which is far too small a sample to read anything off: one stone either way
     * moves a per-cape row by hundreds of millions. Pooled, they are one sample
     * worth looking at — but only if they really are the same bet, so membership
     * is derived from the game data rather than written down as a list of names.
     * A hardcoded list would silently miss a fifth refined cape that already
     * exists in the item map, and would keep averaging a cape in after the game
     * changed its rates.
     *
     * Equivalent means: the same `transmuteSuccessRate`, the same
     * `bulkMultiplier`, and the same drop table — same number of entries, same
     * drop rates and counts, and the same non-self-return outputs. The
     * self-return entry is keyed as `self` rather than by hrid, since every
     * input returns *itself*; that is the one difference between these items
     * that is not a difference in the bet. Requiring the non-self-return hrids
     * to match as well is stricter than comparing rates alone, and deliberately
     * so: two items that drop *different* jackpots at the same rate are not
     * interchangeable, and summing their revenue would be nonsense.
     *
     * @param {string} itemHrid
     * @returns {string|null} The signature, or null when the item has no usable
     *   transmute data (it then pools with nothing, which is the safe default)
     */
    getTransmuteEquivalenceKey(itemHrid) {
        const alchemy = dataManager.getItemDetails(itemHrid)?.alchemyDetail;
        const dropTable = alchemy?.transmuteDropTable;
        if (!Array.isArray(dropTable) || dropTable.length === 0) return null;
        if (!(alchemy.transmuteSuccessRate > 0)) return null;

        const entries = dropTable
            .map((drop) => {
                const target = drop.itemHrid === itemHrid ? 'self' : drop.itemHrid;
                return `${target}:${drop.dropRate ?? 0}:${drop.minCount ?? 1}:${drop.maxCount ?? 1}`;
            })
            .sort();

        return JSON.stringify({
            rate: alchemy.transmuteSuccessRate,
            bulk: alchemy.bulkMultiplier ?? 1,
            entries,
        });
    }

    /**
     * Sum a set of equivalent per-item groups into one pooled group.
     *
     * Everything the per-item row does has to keep holding here: `impossible`
     * poisons the pooled row if any member is flagged (the same reason the
     * "All items" row inherits it — excluding a corrupt member's consumed count
     * while still summing its revenue is the same mistake one column over), the
     * `§` repaired and `◇` estimated-catalyst markers carry through, and
     * Inputs/Jackpot counts only non-self-return outputs.
     *
     * @param {Array<Object>} members - Groups from `computeInputItemTotals`
     * @returns {Object} A group shaped like a per-item one, plus `pooled`/`memberHrids`
     */
    buildPooledGroup(members) {
        const pooled = {
            pooled: true,
            memberHrids: members.map((group) => group.inputItemHrid),
            inputItemHrid: null,
            sessionCount: 0,
            attempts: 0,
            successes: 0,
            netConsumed: 0,
            nonSelfReturnOutputs: 0,
            revenue: 0,
            revenueUnpriced: false,
            revenueShopValued: false,
            inputCost: 0,
            inputUnpriced: false,
            coinCost: 0,
            catalystCost: 0,
            catalystRecordedSessions: 0,
            catalystUnrecordedSessions: 0,
            catalystUnpricedSessions: 0,
            catalystEstimatedSessions: 0,
            catalystHrids: new Set(),
            repairedSessions: 0,
            unreliableSessions: 0,
            impossible: false,
        };

        for (const group of members) {
            pooled.sessionCount += group.sessionCount;
            pooled.attempts += group.attempts;
            pooled.successes += group.successes;
            pooled.netConsumed += group.netConsumed;
            pooled.nonSelfReturnOutputs += group.nonSelfReturnOutputs;
            pooled.revenue += group.revenue;
            pooled.inputCost += group.inputCost;
            pooled.coinCost += group.coinCost;
            pooled.catalystCost += group.catalystCost;
            pooled.catalystRecordedSessions += group.catalystRecordedSessions;
            pooled.catalystUnrecordedSessions += group.catalystUnrecordedSessions;
            pooled.catalystUnpricedSessions += group.catalystUnpricedSessions;
            pooled.catalystEstimatedSessions += group.catalystEstimatedSessions;
            pooled.repairedSessions += group.repairedSessions;
            pooled.unreliableSessions += group.unreliableSessions;
            pooled.inputUnpriced = pooled.inputUnpriced || group.inputUnpriced;
            pooled.revenueUnpriced = pooled.revenueUnpriced || group.revenueUnpriced;
            pooled.revenueShopValued = pooled.revenueShopValued || group.revenueShopValued;
            pooled.impossible = pooled.impossible || group.impossible;
            for (const hrid of group.catalystHrids || []) pooled.catalystHrids.add(hrid);
        }

        pooled.memberHrids.sort((a, b) => this.getItemName(a).localeCompare(this.getItemName(b)));
        pooled.net = pooled.revenue - pooled.inputCost - pooled.catalystCost - pooled.coinCost;
        pooled.successRate = pooled.attempts > 0 ? pooled.successes / pooled.attempts : null;
        pooled.inputsPerOutput =
            pooled.nonSelfReturnOutputs > 0 ? pooled.netConsumed / pooled.nonSelfReturnOutputs : null;
        pooled.breakEvenInputValue =
            pooled.netConsumed > 0
                ? (pooled.revenue - pooled.catalystCost - pooled.coinCost) / pooled.netConsumed
                : null;
        return pooled;
    }

    /**
     * Pooled rows for sets of equivalent transmute inputs, in addition to (never
     * instead of) the per-item rows.
     *
     * A set of one produces nothing: that is just the per-item row again wearing
     * a different label.
     *
     * @param {Array<Object>} totals - Per-item groups from `computeInputItemTotals`
     * @returns {Array<Object>} Zero or more pooled groups
     */
    computePooledTotals(totals) {
        return poolEquivalentGroups(totals, {
            getKey: (hrid) => this.getTransmuteEquivalenceKey(hrid),
            buildPooled: (members) => this.buildPooledGroup(members),
            getSortName: (hrid) => this.getItemName(hrid),
        });
    }

    /**
     * Render the "Totals by Input Item" table below the session list.
     */
    renderTotals() {
        const container = this.modal.querySelector('.mwi-transmute-history-totals-container');
        const totals = this.computeInputItemTotals();

        const rows = totals.map((group, index) => this.buildTotalsRow(group, index));
        // Pooled rows sit below the per-item rows they summarize and above the
        // overall row. They are additional, never a replacement — and they are
        // deliberately NOT fed into `buildOverallTotalsRow`, which reduces over
        // the per-item groups; adding them there would count every session twice.
        this.computePooledTotals(totals).forEach((group, index) =>
            rows.push(this.buildTotalsRow(group, totals.length + index))
        );
        if (totals.length > 0) rows.push(this.buildOverallTotalsRow(totals));

        renderTotalsSection(container, {
            heading: 'Totals by Input Item',
            columns: TRANSMUTE_TOTALS_COLUMNS,
            rows,
            legendParts: [...TRANSMUTE_TOTALS_LEGEND, preFixLegend('transmute')],
            controls: createPreFixToggle({
                sessions: this.filteredSessions,
                includePreFix: this.includePreFix,
                onChange: (include) => {
                    this.includePreFix = include;
                    saveIncludePreFix('transmute', include);
                    this.renderTotals();
                },
            }),
            emptyText:
                this.filteredSessions.length > 0 && !this.includePreFix
                    ? 'Every session in view was recorded before the fix — tick the box above to include them.'
                    : null,
        });
    }

    /**
     * Create a plain totals-table `<td>` with shared styling.
     * @param {string} text
     * @param {{color?: string, bold?: boolean, title?: string}} [opts]
     * @returns {HTMLTableCellElement}
     */
    createTotalsCell(text, opts = {}) {
        return createTotalsCell(text, opts);
    }

    /**
     * Build one totals row for a single input-item group.
     * @param {Object} group
     * @param {number} index
     * @returns {HTMLTableRowElement}
     */
    buildTotalsRow(group, index) {
        const row = document.createElement('tr');
        const impossibleTitle =
            "This group's recorded counts are internally impossible (more results than successes, or a " +
            'consumed count that clamped to zero despite real attempts) — the signature of the self-return ' +
            'batching bug. The recorded success count comes from the same batched-delta counting that ' +
            'inflated the self-returns, so it cannot be trusted either. Every figure derived from consumed ' +
            'or success count is hidden here to avoid presenting corrupt data as fact.';
        row.style.cssText = totalsRowStyle(index, { pooled: group.pooled, flagged: group.impossible });

        const itemCell = document.createElement('td');
        itemCell.style.cssText = 'padding: 6px 10px; display: flex; align-items: center; gap: 8px;';
        if (group.pooled) {
            for (const hrid of group.memberHrids) this.appendItemIcon(itemCell, hrid, 18);
        } else {
            this.appendItemIcon(itemCell, group.inputItemHrid, 18);
        }
        const nameSpan = document.createElement('span');
        // A repaired group is sound arithmetic over a derived number, not an
        // observed one, and the row has to keep saying which it is
        const repairedMark = group.repairedSessions > 0 ? '§' : '';
        const baseLabel = group.pooled
            ? `Pooled: ${group.memberHrids.length} equivalent inputs`
            : this.getItemName(group.inputItemHrid);
        nameSpan.textContent = (group.impossible ? '⚠ ' : '') + baseLabel + repairedMark;
        if (group.pooled) nameSpan.style.fontStyle = 'italic';
        if (group.impossible) itemCell.title = impossibleTitle;
        else if (group.pooled) {
            itemCell.title = this.pooledMembershipTitle(group);
        } else if (repairedMark) {
            itemCell.title =
                `${group.repairedSessions} session(s) in this group had their self-return count derived from ` +
                'the recorded successes, not observed — they were recorded through the batched-message counting ' +
                'bug. That success count is itself approximate on these sessions, for the same reason, so input ' +
                'cost on them is likely understated.';
        }
        itemCell.appendChild(nameSpan);
        row.appendChild(itemCell);

        row.appendChild(this.createTotalsCell(String(group.sessionCount)));
        row.appendChild(this.createTotalsCell(String(group.attempts)));
        row.appendChild(
            this.createTotalsCell(group.impossible ? '—' : String(group.netConsumed), {
                title: group.impossible ? impossibleTitle : undefined,
            })
        );

        const successPct = group.successRate !== null ? `${(group.successRate * 100).toFixed(1)}%` : '—';
        row.appendChild(
            this.createTotalsCell(group.impossible ? '—' : `${group.successes} (${successPct})`, {
                title: group.impossible ? impossibleTitle : undefined,
            })
        );

        row.appendChild(
            this.createTotalsCell(
                formatKMB(group.revenue, 1) + (group.revenueUnpriced ? '¶' : '') + (group.revenueShopValued ? '‖' : ''),
                {
                    title:
                        [
                            group.revenueUnpriced
                                ? 'At least one session in this group had an output the market could not price — this total is incomplete, not zero-earning.'
                                : null,
                            group.revenueShopValued
                                ? 'Includes an output valued at its best Labyrinth Shop conversion, not a market price.'
                                : null,
                        ]
                            .filter(Boolean)
                            .join(' ') || undefined,
                }
            )
        );
        row.appendChild(
            this.createTotalsCell(
                group.impossible ? '—' : formatKMB(group.inputCost, 1) + (group.inputUnpriced ? '*' : ''),
                {
                    title: group.impossible
                        ? impossibleTitle
                        : group.inputUnpriced
                          ? 'At least one session in this group has an unpriced input — this total is incomplete, not fully costed.'
                          : undefined,
                }
            )
        );

        const [groupCatalystText, groupCatalystTitle] = this.formatCatalystTotal(group);
        row.appendChild(this.createTotalsCell(groupCatalystText, { title: groupCatalystTitle }));

        row.appendChild(this.createTotalsCell(formatKMB(group.coinCost, 1)));
        // Net and Break-even both derive from revenue, so an unpriced output
        // poisons them the same way it poisons revenue itself — carrying the
        // ¶ mark through here is what keeps a genuinely bad Net (a real loss)
        // apart from a Net that only looks bad because part of what was earned
        // could not be counted.
        row.appendChild(
            this.createTotalsCell(
                (group.impossible ? '—' : formatKMB(group.net, 1)) +
                    (group.revenueUnpriced ? '¶' : '') +
                    (group.revenueShopValued ? '‖' : ''),
                {
                    color: group.impossible ? '#fbbf24' : group.net >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS,
                    bold: true,
                    title: group.impossible
                        ? impossibleTitle
                        : group.revenueUnpriced
                          ? 'Includes an unpriced output — this total is incomplete, not a confirmed figure.'
                          : group.revenueShopValued
                            ? 'Includes an output valued at its best Labyrinth Shop conversion, not a market price.'
                            : undefined,
                }
            )
        );

        row.appendChild(
            this.createTotalsCell(
                !group.impossible && group.inputsPerOutput !== null ? group.inputsPerOutput.toFixed(2) : '—'
            )
        );
        row.appendChild(
            this.createTotalsCell(
                (!group.impossible && group.breakEvenInputValue !== null
                    ? formatKMB(group.breakEvenInputValue, 1)
                    : '—') + (group.revenueUnpriced ? '¶' : ''),
                {
                    title: group.revenueUnpriced
                        ? 'Includes an unpriced output — this total is incomplete, not a confirmed figure.'
                        : undefined,
                }
            )
        );

        return row;
    }

    /**
     * The tooltip that makes a pooled row's membership discoverable — which
     * items went in, and on what grounds. A row the reader cannot audit is a
     * row they have to take on faith.
     *
     * @param {Object} group - A pooled group from `buildPooledGroup`
     * @returns {string}
     */
    pooledMembershipTitle(group) {
        const names = group.memberHrids.map((hrid) => this.getItemName(hrid)).join(', ');
        let title =
            `Pooled across ${group.memberHrids.length} inputs: ${names}. ` +
            'These share the same transmute success rate, the same drop table (same outputs, rates and counts) ' +
            'and the same bulk size, so transmuting any of them is the same bet and the samples can be added. ' +
            'Membership is read from the game data, not a fixed list — an item whose rates differ drops out by ' +
            'itself. The per-item rows above are unchanged.';
        if (group.repairedSessions > 0) {
            title +=
                ` ${group.repairedSessions} session(s) pooled here had their self-return count derived from the ` +
                'recorded successes, not observed — input cost on them is likely understated.';
        }
        return title;
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
                acc.revenue += group.revenue;
                acc.revenueUnpriced = acc.revenueUnpriced || group.revenueUnpriced;
                acc.revenueShopValued = acc.revenueShopValued || group.revenueShopValued;
                acc.inputCost += group.inputCost;
                acc.coinCost += group.coinCost;
                acc.catalystCost += group.catalystCost;
                acc.inputUnpriced = acc.inputUnpriced || group.inputUnpriced;
                acc.catalystUnrecordedSessions += group.catalystUnrecordedSessions;
                acc.catalystUnpricedSessions += group.catalystUnpricedSessions;
                acc.catalystEstimatedSessions += group.catalystEstimatedSessions;
                acc.repairedSessions += group.repairedSessions;
                if (group.impossible) {
                    acc.hasImpossibleGroup = true;
                } else {
                    acc.netConsumed += group.netConsumed;
                }
                return acc;
            },
            {
                sessionCount: 0,
                attempts: 0,
                successes: 0,
                revenue: 0,
                revenueUnpriced: false,
                revenueShopValued: false,
                inputCost: 0,
                coinCost: 0,
                catalystCost: 0,
                netConsumed: 0,
                inputUnpriced: false,
                catalystUnrecordedSessions: 0,
                catalystUnpricedSessions: 0,
                catalystEstimatedSessions: 0,
                repairedSessions: 0,
                hasImpossibleGroup: false,
            }
        );

        const row = document.createElement('tr');
        row.style.cssText = 'border-top: 2px solid #555; background: #1f1f1f;';

        // A group flagged above poisons this row the same way it poisons its
        // own: averaging its corrupt consumed/success counts in with the
        // clean groups' would present a confident wrong number, and excluding
        // it while still summing its revenue/cost into "Net" is the same
        // mistake one column over. Every figure that depends on consumed or
        // success count is hidden here, together, whenever any group is flagged.
        const overallImpossibleTitle =
            'At least one input-item group above is flagged as internally impossible (recorded counts corrupted ' +
            'by the self-return batching bug). Every figure derived from consumed or success count is hidden ' +
            'here too, since it would otherwise average or add in corrupt data as if it were good.';

        const itemCell = document.createElement('td');
        itemCell.textContent = (overall.hasImpossibleGroup ? '⚠ ' : '') + 'All items';
        itemCell.style.cssText = 'padding: 6px 10px; font-weight: bold;';
        if (overall.hasImpossibleGroup) itemCell.title = overallImpossibleTitle;
        row.appendChild(itemCell);

        row.appendChild(this.createTotalsCell(String(overall.sessionCount), { bold: true }));
        row.appendChild(this.createTotalsCell(String(overall.attempts), { bold: true }));
        row.appendChild(
            this.createTotalsCell(overall.hasImpossibleGroup ? '—' : String(overall.netConsumed), {
                bold: true,
                title: overall.hasImpossibleGroup ? overallImpossibleTitle : undefined,
            })
        );

        const successPct = overall.attempts > 0 ? `${((overall.successes / overall.attempts) * 100).toFixed(1)}%` : '—';
        row.appendChild(
            this.createTotalsCell(overall.hasImpossibleGroup ? '—' : `${overall.successes} (${successPct})`, {
                bold: true,
                title: overall.hasImpossibleGroup ? overallImpossibleTitle : undefined,
            })
        );
        row.appendChild(
            this.createTotalsCell(
                formatKMB(overall.revenue, 1) +
                    (overall.revenueUnpriced ? '¶' : '') +
                    (overall.revenueShopValued ? '‖' : ''),
                {
                    bold: true,
                    title:
                        [
                            overall.revenueUnpriced
                                ? 'At least one session had an output the market could not price — this total is incomplete, not zero-earning.'
                                : null,
                            overall.revenueShopValued
                                ? 'Includes an output valued at its best Labyrinth Shop conversion, not a market price.'
                                : null,
                        ]
                            .filter(Boolean)
                            .join(' ') || undefined,
                }
            )
        );
        row.appendChild(
            this.createTotalsCell(
                overall.hasImpossibleGroup ? '—' : formatKMB(overall.inputCost, 1) + (overall.inputUnpriced ? '*' : ''),
                { bold: true, title: overall.hasImpossibleGroup ? overallImpossibleTitle : undefined }
            )
        );

        const [catalystText, catalystTitle] = this.formatCatalystTotal(overall);
        row.appendChild(this.createTotalsCell(catalystText, { bold: true, title: catalystTitle }));

        row.appendChild(this.createTotalsCell(formatKMB(overall.coinCost, 1), { bold: true }));

        const net = overall.revenue - overall.inputCost - overall.catalystCost - overall.coinCost;
        row.appendChild(
            this.createTotalsCell(
                (overall.hasImpossibleGroup ? '—' : formatKMB(net, 1)) +
                    (overall.revenueUnpriced ? '¶' : '') +
                    (overall.revenueShopValued ? '‖' : ''),
                {
                    bold: true,
                    color: overall.hasImpossibleGroup ? '#fbbf24' : net >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS,
                    title: overall.hasImpossibleGroup
                        ? overallImpossibleTitle
                        : overall.revenueUnpriced
                          ? 'Includes an unpriced output — this total is incomplete, not a confirmed figure.'
                          : overall.revenueShopValued
                            ? 'Includes an output valued at its best Labyrinth Shop conversion, not a market price.'
                            : undefined,
                }
            )
        );

        // Mixed input items — neither figure is meaningful across items
        row.appendChild(this.createTotalsCell('—'));
        row.appendChild(this.createTotalsCell('—'));

        return row;
    }

    /**
     * The catalyst line of a session's profit tooltip.
     *
     * An estimate says so in as many words. Presenting `predictedCatalystHrid ×
     * successes` in the same voice as a measured count is exactly the mistake
     * the input-pricing fallback exists to avoid making twice.
     *
     * @param {Object} detail - A `computeSessionProfit` result
     * @returns {string} The line
     */
    formatCatalystLine(detail) {
        if (detail.catalystEntries.length === 0) {
            return detail.catalystUnrecorded
                ? 'Catalyst: not recorded (predates tracking) — not counted'
                : 'Catalyst: none';
        }

        const parts = detail.catalystEntries.map(
            (entry) =>
                `${this.getItemName(entry.hrid)} x${entry.count}` +
                (entry.unpriced ? ' (unpriced, not counted)' : ` −${formatKMB(entry.cost, 1)}`)
        );
        const basis = detail.catalystEstimated
            ? ' (estimated — the catalyst in the slot at session start × successes)'
            : ' (recorded)';
        return `Catalyst: ${parts.join(', ')}${basis}`;
    }

    /**
     * The repair line of a session's profit tooltip, or nothing for a session
     * that was never touched.
     *
     * A repaired count is derived from the successes, not observed on the wire,
     * and the record has to keep saying so — see `transmute-session-repair.js`.
     *
     * @param {Object} session
     * @returns {string} The line, newline-terminated, or ''
     */
    formatRepairLine(session) {
        const repair = session?.repair;
        if (!repair) return '';
        if (repair.outcome === 'unreliable') {
            return `⚠ Recorded counts are internally impossible (${repair.reason}) — not repaired, treat as unreliable\n`;
        }
        return (
            `⚠ Self-return count repaired: recorded ${repair.from}, derived ${repair.to} from the recorded ` +
            'successes (the batched-message counting bug). That success count is itself approximate on this ' +
            'session, for the same reason — input cost here is likely understated, not just approximate\n'
        );
    }

    /**
     * Format a group's catalyst-cost cell text + tooltip.
     * @param {{catalystRecordedSessions: number, catalystUnrecordedSessions: number,
     *   catalystUnpricedSessions: number, catalystCost: number}} group
     * @returns {[string, string|undefined]}
     */
    formatCatalystTotal(group) {
        if (group.catalystRecordedSessions === 0 && group.catalystUnpricedSessions === 0) {
            if (group.catalystUnrecordedSessions > 0) {
                return [
                    'unrecorded',
                    `${group.catalystUnrecordedSessions} session(s) predate catalyst tracking — cost is unknown, not zero.`,
                ];
            }
            return ['—', undefined];
        }

        let text = formatKMB(group.catalystCost, 1);
        if (group.catalystUnpricedSessions > 0) text += '†';
        if (group.catalystUnrecordedSessions > 0) text += '‡';
        if (group.catalystEstimatedSessions > 0) text += '◇';

        const notes = [];
        if (group.catalystEstimatedSessions > 0) {
            notes.push(
                `${group.catalystEstimatedSessions} session(s) predate recorded catalyst consumption — ` +
                    'estimated from the catalyst in the slot at session start × successes, not measured.'
            );
        }
        if (group.catalystUnpricedSessions > 0) {
            notes.push(
                `${group.catalystUnpricedSessions} session(s) used a catalyst the market can't price — excluded.`
            );
        }
        if (group.catalystUnrecordedSessions > 0) {
            notes.push(
                `${group.catalystUnrecordedSessions} session(s) have no recorded catalyst — excluded, not zero.`
            );
        }
        if (group.catalystHrids && group.catalystHrids.size > 1) {
            notes.push('Multiple catalyst types were recorded across these sessions.');
        }
        return [text, notes.join(' ') || undefined];
    }

    /**
     * Compute session profit: recorded output value minus the cost of consumed
     * inputs (at current buy price — historical input prices were not recorded)
     * and the transmute coin fee. Teas are not tracked, so they stay excluded
     * from `profit`. Catalysts ARE now costed — as `catalystCost`, reported
     * separately rather than folded into `profit` — because a session recorded
     * before catalyst tracking existed has no way to say whether one was used,
     * and folding an unknown into the headline profit figure would read as
     * "free", which is exactly the mistake the input-pricing fallback below
     * exists to avoid making a second time.
     *
     * The recorded output values are RAW sell prices — a record of what the
     * market said, which is what a record should be — while the forecast in
     * `alchemy-profit-calculator.js` quotes everything after the marketplace
     * cut. Comparing the two put history ahead of forecast by the tax on every
     * session. The tax is applied here, at read, so the stored figures stay a
     * record and every session ever saved is restated the same way.
     *
     * An input the market cannot price falls back to its refinement craft cost
     * when it is a refined (★) item, and is reported as unpriced when even that
     * fails — an unknown cost is not a zero one.
     *
     * Catalysts are consumed only on success (see `alchemy-profit-calculator.js`:
     * `catalystCostPerAttempt = catalystPrice * successRate`).
     *
     * `session.catalystsUsed` is what the tracker actually watched being spent,
     * hrid → count, recorded per message — so a mid-session catalyst swap is
     * costed against both catalysts, each for the part of the run it was in the
     * slot for. Sessions recorded before that existed have only
     * `session.predictedCatalystHrid`, the catalyst in the slot when the run
     * BEGAN, times `totalSuccesses`: an estimate, reported as one through
     * `catalystEstimated` so nothing presents it as measured. `null` there
     * still means "not recorded", never "none used"; `catalystUnrecorded` keeps
     * those apart so callers do not read the gap as zero-cost.
     *
     * An output the market cannot price is excluded from `revenue` the same
     * way an unpriced input is excluded from `inputCost` — there is no number
     * to add, and adding zero would report "this earned nothing" for "we do
     * not know what this earned". `revenueUnpriced` carries that gap forward
     * the way `inputUnpriced` already does, so `Net` and `Break-even Input`
     * — both derived from `revenue` — can say they are incomplete too rather
     * than reading as a real loss. A self-return is never priced in the first
     * place (it is the same item handed back, not a sale), so it cannot make
     * revenue unpriced.
     *
     * @param {Object} session
     * @returns {{profit: number, revenue: number, revenueUnpriced: boolean, inputCost: number, coinCost: number,
     *   netConsumed: number, nonSelfReturnOutputs: number, inputBasis: string|null, inputUnpriced: boolean,
     *   catalystHrid: string|null, catalystCost: number,
     *   catalystUnrecorded: boolean, catalystUnpriced: boolean, catalystEstimated: boolean,
     *   catalystEntries: Array<{hrid: string, count: number, cost: number, unpriced: boolean}>}}
     */
    computeSessionProfit(session) {
        const itemDetails = dataManager.getItemDetails(session.inputItemHrid);
        // The session's own bulk size, when it has one. Sessions recorded before
        // it was persisted have none, and the item's current value is the only
        // answer available for those.
        const bulkMultiplier = session.bulkMultiplier ?? itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;

        let revenue = 0;
        let revenueUnpriced = false;
        let selfReturned = 0;
        let nonSelfReturnOutputs = 0;
        // A result the market cannot price still may have a value — see
        // alchemy-shop-value.js. Currently only covers Labyrinth Token, which
        // transmute's own drop tables do not produce, but the check is cheap
        // and keeps this in step with decompose should that ever change.
        // Taxed like any other output: the shop value is a market sell price.
        let revenueShopValued = false;
        for (const [resultItemHrid, result] of Object.entries(session.results || {})) {
            if (result.isSelfReturn) {
                selfReturned += result.count || 0;
                continue;
            }
            nonSelfReturnOutputs += result.count || 0;
            // A session recorded before results carried the unpriced flag stores an untradeable
            // output as priced at 0; the market can never price it, so no real value means shop value.
            const shopValue =
                result.unpriced || !(result.totalValue > 0) ? getAlchemyOutputShopValue(resultItemHrid) : null;
            if (shopValue) {
                revenue += calculatePriceAfterTax(shopValue.valuePerUnit * (result.count || 0));
                revenueShopValued = true;
                continue;
            }
            if (result.unpriced) {
                revenueUnpriced = true;
                continue;
            }
            revenue += calculatePriceAfterTax(result.totalValue || 0);
        }

        const attempts = session.totalAttempts || 0;
        const netConsumed = Math.max(0, attempts * bulkMultiplier - selfReturned);
        // A refined (★) cape is untradable, so the market prices it at nothing;
        // charging the transmute 0 for it left the coin fee as the whole loss.
        // See utils/refined-item-cost.js.
        const marketPrice = getItemPrice(session.inputItemHrid, { context: 'profit', side: 'buy' });
        const { price: inputPrice, basis: inputBasis } = priceInputWithRefinementFallback(
            session.inputItemHrid,
            marketPrice
        );
        const inputCost = netConsumed * inputPrice;
        const inputUnpriced = inputBasis === null && netConsumed > 0;

        // Transmute coin fee — see utils/alchemy-fees.js. The session's recorded bulkMultiplier
        // is the one that was actually billed, so it overrides the item's current one.
        const coinCost = getAlchemyCoinCost(itemDetails, 'transmute', bulkMultiplier) * attempts;

        const catalyst = this.computeCatalystCost(session);

        return {
            profit: revenue - inputCost - coinCost,
            revenue,
            revenueUnpriced,
            revenueShopValued,
            inputCost,
            coinCost,
            netConsumed,
            nonSelfReturnOutputs,
            inputBasis,
            inputUnpriced,
            ...catalyst,
        };
    }

    /**
     * What this session's catalysts cost, measured where the wire recorded them
     * and estimated where it did not.
     *
     * See the `computeSessionProfit` docstring. `catalystHrid` stays the single
     * hrid whenever there is exactly one, so every existing caller keeps
     * working; `catalystEntries` is the whole picture for a run that swapped.
     *
     * @param {Object} session
     * @returns {{catalystHrid: string|null, catalystCost: number, catalystUnrecorded: boolean,
     *   catalystUnpriced: boolean, catalystEstimated: boolean,
     *   catalystEntries: Array<{hrid: string, count: number, cost: number, unpriced: boolean}>}}
     */
    computeCatalystCost(session) {
        const recorded = session.catalystsUsed;
        const hasRecorded = !!recorded && typeof recorded === 'object';

        // Recorded counts are preferred; the prediction is what a session saved
        // before catalyst consumption was tracked has instead, and is labelled
        // so rather than quietly standing in for a measurement
        const used = hasRecorded
            ? Object.entries(recorded).map(([hrid, count]) => ({ hrid, count: Number(count) || 0 }))
            : session.predictedCatalystHrid
              ? [{ hrid: session.predictedCatalystHrid, count: session.totalSuccesses || 0 }]
              : [];

        const catalystEntries = [];
        let catalystCost = 0;
        let catalystUnpriced = false;
        for (const { hrid, count } of used) {
            if (count <= 0) continue;
            const price = getItemPrice(hrid, { context: 'profit', side: 'buy' });
            const unpriced = !(price > 0);
            const cost = unpriced ? 0 : count * price;
            if (unpriced) catalystUnpriced = true;
            else catalystCost += cost;
            catalystEntries.push({ hrid, count, cost, unpriced });
        }

        // "Nothing recorded" is a gap in the data, not a free run — but only
        // for a session that predates the tracking. One that recorded its
        // catalysts and spent none genuinely used none.
        const catalystUnrecorded = !hasRecorded && !session.predictedCatalystHrid && session.totalSuccesses > 0;

        return {
            catalystHrid: catalystEntries.length === 1 ? catalystEntries[0].hrid : null,
            catalystCost,
            catalystUnrecorded,
            catalystUnpriced,
            catalystEstimated: !hasRecorded && catalystEntries.length > 0,
            catalystEntries,
        };
    }

    /**
     * Render one session's per-catalyst cell (Catalyst of Transmutation or
     * Prime Catalyst) from its `computeSessionProfit` detail.
     *
     * Unlike decompose and coinify, transmute records catalyst use as a map —
     * a session can swap catalysts mid-run — so the count for a specific
     * catalyst hrid is read out of `catalystEntries` rather than a dedicated
     * field. A session with no entries at all and `catalystUnrecorded` set
     * predates catalyst tracking; that is "unknown", not "zero used", and gets
     * the same dash-with-tooltip treatment `renderCatalystCountCell` gives a
     * decompose or coinify session in the same state.
     *
     * @param {HTMLElement} cell
     * @param {Object} detail - A `computeSessionProfit` result
     * @param {string} catalystHrid
     */
    renderTransmuteCatalystCell(cell, detail, catalystHrid) {
        const entry = detail.catalystEntries?.find((e) => e.hrid === catalystHrid);
        const count = entry?.count || 0;
        renderCatalystCountCell(cell, catalystHrid, count, (el, hrid, size) => this.appendItemIcon(el, hrid, size), {
            unrecorded: detail.catalystUnrecorded,
            estimated: detail.catalystEstimated && !!entry,
        });
    }

    /**
     * Render the results cell for a session
     * Results sorted by totalValue desc, self-returns last
     * @param {HTMLElement} cell
     * @param {Object} session
     */
    renderResultsCell(cell, session) {
        const results = session.results || {};
        const entries = Object.entries(results);

        if (entries.length === 0) {
            const span = document.createElement('span');
            span.textContent = '—';
            span.style.color = '#888';
            cell.appendChild(span);
            return;
        }

        // Sort: non-self-returns by totalValue desc, self-returns last
        // Exclude incidental drops (essences, artisan's crates) recorded in older sessions
        const filteredEntries = entries.sort(([, a], [, b]) => {
            if (a.isSelfReturn && !b.isSelfReturn) return 1;
            if (!a.isSelfReturn && b.isSelfReturn) return -1;
            return (b.totalValue || 0) - (a.totalValue || 0);
        });

        filteredEntries.forEach(([itemHrid, result]) => {
            const line = document.createElement('div');
            line.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 2px;';

            this.appendItemIcon(line, itemHrid, 16);

            const text = document.createElement('span');
            const name = this.getItemName(itemHrid);

            if (result.isSelfReturn) {
                // A derived count is not an observed one, and the row says so
                // wherever it is read — see `transmute-session-repair.js`
                if (result.countBasis === 'derived') {
                    text.textContent = `${name} x${result.count} (self-return, derived)`;
                    text.title =
                        `Recorded as ${result.recordedCount} by the batched-message counting bug; ` +
                        'derived from the recorded successes, not observed. That success count is itself ' +
                        'approximate on this session, for the same reason — input cost here is likely ' +
                        'understated, not just approximate.';
                } else {
                    text.textContent = `${name} x${result.count} (self-return)`;
                }
                text.style.color = '#888';
            } else {
                const shopValue =
                    result.unpriced || !(result.totalValue > 0) ? getAlchemyOutputShopValue(itemHrid) : null;
                if (shopValue) {
                    const perUnit = shopValue.valuePerUnit;
                    const total = formatKMB(perUnit * (result.count || 0), 1);
                    const each = formatKMB(perUnit, 1);
                    text.textContent = `${name} x${result.count} = ${total}‖ (${each} each)`;
                    text.title = describeShopValue(shopValue, (n) => formatKMB(n, 1));
                } else {
                    const total = formatKMB(result.totalValue || 0, 1);
                    const each = formatKMB(result.priceEach || 0, 1);
                    text.textContent = `${name} x${result.count} = ${total}${result.unpriced ? '¶' : ''} (${each} each)`;
                    if (result.unpriced) {
                        text.title = 'The market could not price this output — this value is incomplete, not zero.';
                    }
                }
            }

            line.appendChild(text);
            cell.appendChild(line);
        });
    }

    /**
     * Render controls bar (stats + clear history button)
     */
    renderControls() {
        const controls = this.modal.querySelector('.mwi-transmute-history-controls');
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
        const container = this.modal.querySelector('.mwi-transmute-history-badges');
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

        if (this.filters.resultsSearch.trim()) {
            badges.push({
                label: `Results: "${this.filters.resultsSearch.trim()}"`,
                onRemove: () => {
                    this.filters.resultsSearch = '';
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
        const pagination = this.modal.querySelector('.mwi-transmute-history-pagination');
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
            case 'results':
                popup = this.createResultsFilterPopup();
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

    /**
     * Create results text search popup
     * @returns {HTMLElement}
     */
    createResultsFilterPopup() {
        const popup = this.createPopupBase('Filter by Result Item');
        popup.style.minWidth = '220px';

        const searchInput = document.createElement('input');
        searchInput.type = 'text';
        searchInput.placeholder = 'Item name...';
        searchInput.value = this.filters.resultsSearch;
        searchInput.style.cssText = `
            width: 100%; padding: 6px; margin-bottom: 10px;
            background: #1a1a1a; border: 1px solid #555;
            border-radius: 3px; color: #fff; box-sizing: border-box;
        `;

        popup.appendChild(searchInput);

        const btnRow = this.createPopupButtonRow(
            () => {
                this.filters.resultsSearch = searchInput.value;
                this.applyFilters();
                this.renderTable();
                this.closeActiveFilterPopup();
            },
            () => {
                this.filters.resultsSearch = '';
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
            const fresh = await transmuteHistoryTracker.loadSessions();
            this.sessions = fresh.filter((s) => s.id !== sessionId);
            await transmuteHistoryTracker.deleteSessions(this.sessions);
        } catch (error) {
            console.error('[TransmuteHistoryViewer] Failed to delete session:', error);
        }

        this.applyFilters();
        this.renderTable();
    }

    /**
     * The Data Note cell for a session's CSV/text export row: every qualification
     * the on-screen table marks with a symbol (*†‡◇§), spelled out in readable
     * text — a spreadsheet reader has no legend for the symbols, so a qualified
     * row exported as plain numbers reads more confident than the same row on
     * screen. Empty when nothing qualifies the row.
     * @param {Object} session
     * @param {Object} detail - A `computeSessionProfit` result
     * @returns {string} Semicolon-joined notes, or ''
     */
    buildDataNote(session, detail) {
        const notes = [];
        if (detail.inputUnpriced) notes.push('input unpriced — total is incomplete');
        if (detail.catalystUnpriced) notes.push('catalyst could not be priced — excluded, not zero');
        if (detail.catalystUnrecorded) notes.push('catalyst not recorded (predates tracking) — excluded, not zero');
        if (detail.catalystEstimated) notes.push('catalyst estimated, not measured');
        const repair = this.formatRepairLine(session).trim().replace(/^⚠\s*/, '');
        if (repair) notes.push(repair);
        return notes.join('; ');
    }

    /**
     * Export all sessions to a CSV file download
     */
    exportHistory() {
        const escape = (val) => `"${String(val === null || val === undefined ? '' : val).replace(/"/g, '""')}"`;

        const headers = [
            'Session Start',
            'Input Item',
            'Attempts',
            'Successes',
            'Failures',
            'Results',
            'Profit',
            'Data Note',
        ];

        const rows = this.sessions.map((session) => {
            const start = formatDateTime(new Date(session.startTime));
            const inputName = this.getItemName(session.inputItemHrid);
            const failures = session.totalAttempts - session.totalSuccesses;

            const resultParts = Object.entries(session.results || {})
                .sort(([, a], [, b]) => {
                    if (a.isSelfReturn && !b.isSelfReturn) return 1;
                    if (!a.isSelfReturn && b.isSelfReturn) return -1;
                    return (b.totalValue || 0) - (a.totalValue || 0);
                })
                .map(([hrid, result]) => {
                    const name = this.getItemName(hrid);
                    if (result.isSelfReturn) {
                        return result.countBasis === 'derived'
                            ? `${name} x${result.count} (self-return, derived from ${result.recordedCount})`
                            : `${name} x${result.count} (self-return)`;
                    }
                    const total = formatKMB(result.totalValue || 0, 1);
                    const each = formatKMB(result.priceEach || 0, 1);
                    return `${name} x${result.count} = ${total} (${each} each)`;
                });

            const detail = this.profitCache.get(session.id) || this.computeSessionProfit(session);

            // A repaired, unpriced or estimated session must not leave the
            // export looking like a clean observation of the wire
            const dataNote = this.buildDataNote(session, detail);

            return [
                start,
                inputName,
                session.totalAttempts,
                session.totalSuccesses,
                failures,
                resultParts.join('; '),
                Math.round(detail.profit),
                dataNote,
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
        a.download = `transmute-history-${date}.csv`;
        a.click();

        URL.revokeObjectURL(url);
    }

    /**
     * Download a lossless JSON backup of the current character's stored
     * transmute sessions — the exact unmerged records the tracker persists,
     * wrapped in an envelope `import`/`exportBackup` on the other three
     * windows also use. See `alchemy-session-import.js` for the envelope
     * shape and which fields are safe to hand-edit.
     * @returns {Promise<void>}
     */
    async exportBackup() {
        const characterId = dataManager.getCurrentCharacterId();
        const stored = await transmuteHistoryTracker.loadStoredSessions();
        const envelope = buildAlchemyBackupEnvelope({ kind: 'transmute', characterId, sessions: stored });
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(
            `transmute-history-backup-${date}.json`,
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
     * before the first `await` and re-checked after every one that follows
     * (the file read already happened by the time this runs; the stored-
     * sessions load and the confirm dialog are the two awaits/pauses left).
     * A change anywhere in that window cancels the import rather than
     * writing a payload built for one character into another's history.
     *
     * **Live session guard**: import is refused outright while a session for
     * this kind is actively recording (`transmuteHistoryTracker.
     * activeSession`), rather than attempting to merge around it. The active
     * session's own `saveActiveSession()` can land between this function's
     * load and its write, and merging blind against that in-flight state
     * risks the write silently discarding whatever the live session just
     * saved. Refusing is simple, obviously correct, and costs the user only
     * as long as it takes to stop the action or let it finish.
     *
     * @param {string} text - The file's raw contents
     * @returns {Promise<void>}
     */
    async importBackupText(text) {
        // Captured before any further await — see the race note above
        const charIdBefore = dataManager.getCurrentCharacterId();
        const scopeBefore = transmuteHistoryTracker.getCharacterScope();

        const parsed = parseAlchemyBackupJson(text);
        if (!parsed.ok) {
            alert(`Import refused: ${parsed.error}`);
            return;
        }

        const envelope = parsed.envelope;
        const envelopeCheck = validateAlchemyBackupEnvelope(envelope, { kind: 'transmute' });
        if (!envelopeCheck.ok) {
            alert(`Import refused: ${envelopeCheck.error}`);
            return;
        }

        const sessionsCheck = validateAlchemySessions('transmute', envelope.sessions);
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

        if (transmuteHistoryTracker.activeSession) {
            alert('A transmute session is actively recording — stop it, then try the import again.');
            return;
        }

        const stored = await transmuteHistoryTracker.loadStoredSessions();

        if (
            dataManager.getCurrentCharacterId() !== charIdBefore ||
            transmuteHistoryTracker.getCharacterScope() !== scopeBefore
        ) {
            alert('The active character changed during import — cancelled to avoid writing to the wrong character.');
            return;
        }
        if (transmuteHistoryTracker.activeSession) {
            alert('A transmute session started recording during import — cancelled. Try again once it ends.');
            return;
        }

        const plan = planAlchemyImportMerge(stored, envelope.sessions);

        const confirmed = confirm(
            `Import ${envelope.sessions.length} session(s) into Transmute History:\n` +
                `${plan.replaced} replaced, ${plan.added} added, ${plan.unchanged} unchanged.\n\nContinue?`
        );
        if (!confirmed) return;

        if (
            dataManager.getCurrentCharacterId() !== charIdBefore ||
            transmuteHistoryTracker.getCharacterScope() !== scopeBefore ||
            transmuteHistoryTracker.activeSession
        ) {
            alert('The active character changed — import cancelled to avoid writing to the wrong character.');
            return;
        }

        const written = await transmuteHistoryTracker.importSessions(plan.merged);
        if (!written) {
            alert('Import failed: the sessions could not be written to storage. Nothing changed.');
            return;
        }

        this.sessions = await transmuteHistoryTracker.loadSessions();
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
            `⚠️ This will permanently delete ALL transmute history (${this.sessions.length} sessions).\nThis cannot be undone.\n\nAre you sure?`
        );
        if (!confirmed) return;

        try {
            // A clear that could not list the store deleted nothing, and the
            // sessions are still on disk — emptying the table and saying
            // "cleared" would be a lie the next reload exposes.
            if (!(await transmuteHistoryTracker.clearHistory())) {
                alert('Transmute history could NOT be cleared — storage could not be read. Nothing was deleted.');
                return;
            }
            this.sessions = [];
            this.filteredSessions = [];
            alert('Transmute history cleared.');
            this.applyFilters();
            this.renderTable();
        } catch (error) {
            console.error('[TransmuteHistoryViewer] Failed to clear history:', error);
            alert(`Failed to clear history: ${error.message}`);
        }
    }
}

const transmuteHistoryViewer = new TransmuteHistoryViewer();

export { transmuteHistoryViewer };

export default {
    name: 'Transmute History Viewer',
    initialize: () => transmuteHistoryViewer.initialize(),
    cleanup: () => {
        try {
            return transmuteHistoryViewer.disable();
        } catch (error) {
            console.error('[Transmute History Viewer] Disable failed part-way:', error);
        } finally {
            transmuteHistoryViewer.isInitialized = false;
        }
    },
};
