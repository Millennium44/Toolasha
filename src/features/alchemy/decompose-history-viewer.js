/**
 * Decompose History Viewer
 * Modal UI for browsing decompose session history.
 * Injected as a tab in the alchemy panel tab bar.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { decomposeHistoryTracker } from './decompose-history-tracker.js';
import { getAlchemyCoinCost } from '../../utils/alchemy-fees.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
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
    preFixDataNote,
    preFixLegend,
    saveIncludePreFix,
    totalsSessions,
} from './alchemy-pre-fix-sessions.js';
import { getAlchemyOutputShopValue, describeShopValue } from './alchemy-shop-value.js';

const CATALYST_OF_DECOMPOSITION_HRID = '/items/catalyst_of_decomposition';
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
 * Columns of the decompose "Totals by Input Item" table.
 *
 * Deliberately narrower than transmute's. Decompose has no drop table, so
 * there is no jackpot and no inputs-per-jackpot figure to report; it does pay
 * the alchemy coin fee, unlike coinify, so Coin Cost stays.
 *
 * @type {Array<{label: string, title?: string}>}
 */
const DECOMPOSE_TOTALS_COLUMNS = [
    { label: 'Input Item' },
    { label: 'Sessions' },
    { label: 'Attempts' },
    {
        label: 'Consumed',
        title: 'Items destroyed: attempts × the bulk size that was actually billed. A failed attempt consumes the input too.',
    },
    { label: 'Successes' },
    {
        label: 'Revenue',
        title: 'Recorded output value, restated after the marketplace cut — the same basis the forecast quotes.',
    },
    { label: 'Input Cost' },
    {
        label: 'Catalyst Cost',
        title: 'Catalysts recorded as consumed, at current buy price. A catalyst the market cannot price is excluded and marked †, never counted as free.',
    },
    { label: 'Coin Cost', title: 'The alchemy coin fee charged per attempt.' },
    { label: 'Net' },
    {
        label: 'Break-even Input',
        title:
            'Input value at which revenue exactly covers catalyst + coin cost for what was consumed. ' +
            'Above this, decomposing paid for itself; below it, it did not.',
    },
];

/** Footnote markers under the decompose totals table. @type {Array<string>} */
const DECOMPOSE_TOTALS_LEGEND = [
    '* input unpriced — total is incomplete',
    '† catalyst on some sessions could not be priced — excluded, not zero',
    '‡ catalyst not recorded on some sessions (predates tracking) — excluded, not zero',
    '¶ output unpriced — total is incomplete, not zero-earning; Net and Break-even Input carry the same mark',
    '§ output valued at its best Labyrinth Shop conversion, not a market price',
    'A "Pooled" row adds up inputs the game data says are the same bet — hover it for the members',
];

/**
 * Derive a decompose group's ratios once every session has been folded in.
 * Shared by the per-item groups and the pooled ones so the two can never
 * disagree about how a figure is arrived at.
 *
 * @param {Object} group
 * @returns {Object} The group, plus `net`, `successRate` and `breakEvenInputValue`
 */
function finalizeDecomposeGroup(group) {
    const net = group.revenue - group.inputCost - group.catalystCost - group.coinCost;
    const successRate = group.attempts > 0 ? group.successes / group.attempts : null;
    // The input value at which recorded revenue exactly covers catalyst and coin
    // cost for what was consumed — answers "was this worth decomposing" without
    // needing to agree on what the input is worth.
    const breakEvenInputValue =
        group.netConsumed > 0 ? (group.revenue - group.catalystCost - group.coinCost) / group.netConsumed : null;
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
function formatDecomposeCatalystTotal(group) {
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

class DecomposeHistoryViewer {
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

        if (!config.getSetting('alchemy_decomposeHistory')) {
            return;
        }

        this.isInitialized = true;
        this.addAlchemyTab();
    }

    /**
     * Disable the viewer
     */
    disable() {
        // The filter popup and its document click listener live outside the modal
        this.closeActiveFilterPopup();
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
     * Inject "Decompose History" tab into the alchemy tab bar.
     * The alchemy tab bar contains Coinify, Decompose, Transmute, Unrefine, Current Action.
     * We identify it by the presence of a "Decompose" tab text.
     */
    addAlchemyTab() {
        const ensureTabExists = () => {
            const tablist = document.querySelector('[role="tablist"]');
            if (!tablist) return;

            // Verify this is the alchemy tablist by checking for "Decompose" tab
            const hasDecompose = Array.from(tablist.children).some(
                (btn) => btn.textContent.includes('Decompose') && !btn.dataset.mwiDecomposeHistoryTab
            );
            if (!hasDecompose) return;

            // Already injected?
            if (tablist.querySelector('[data-mwi-decompose-history-tab="true"]')) return;

            // Clone an existing tab for structure
            const referenceTab = Array.from(tablist.children).find(
                (btn) => btn.textContent.includes('Decompose') && !btn.dataset.mwiDecomposeHistoryTab
            );
            if (!referenceTab) return;

            const tab = referenceTab.cloneNode(true);
            tab.setAttribute('data-mwi-decompose-history-tab', 'true');
            tab.classList.remove('Mui-selected');
            tab.setAttribute('aria-selected', 'false');
            tab.setAttribute('tabindex', '-1');

            // Set label
            const badge = tab.querySelector('.TabsComponent_badge__1Du26');
            if (badge) {
                // Replace first text node (the label) while keeping badge span
                const badgeSpan = badge.querySelector('.MuiBadge-badge');
                badge.textContent = '';
                badge.appendChild(document.createTextNode('Decompose History'));
                if (badgeSpan) badge.appendChild(badgeSpan);
            } else {
                tab.textContent = 'Decompose History';
            }

            tab.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                this.openModal();
            });

            tablist.appendChild(tab);
            tablist.style.overflowX = 'auto';
            tablist.style.flexWrap = 'nowrap';
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
        this.sessions = await decomposeHistoryTracker.loadSessions();
        this.includePreFix = await loadIncludePreFix('decompose');
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
        this.modal.className = 'mwi-decompose-history-modal';
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
        content.className = 'mwi-decompose-history-content';
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
        title.textContent = 'Decompose History';
        title.style.cssText = 'margin: 0; color: #fff;';

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u2715';
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
        controls.className = 'mwi-decompose-history-controls';
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
        badges.className = 'mwi-decompose-history-badges';
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
        tableContainer.className = 'mwi-decompose-history-table-container';
        tableContainer.style.cssText = 'overflow-x: auto;';

        // Totals-by-input-item container
        const totalsContainer = document.createElement('div');
        totalsContainer.className = 'mwi-decompose-history-totals-container';
        totalsContainer.style.cssText = 'overflow-x: auto;';

        // Pagination
        const pagination = document.createElement('div');
        pagination.className = 'mwi-decompose-history-pagination';
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

    /**
     * Compute session profit: recorded output value minus consumed inputs (at
     * current buy price for the session's enhancement level — historical input
     * prices were not recorded), catalysts consumed, and the alchemy coin fee.
     *
     * The recorded output values are RAW sell prices — a record of what the
     * market said, which is what a record should be — while the forecast in
     * `alchemy-profit-calculator.js` quotes everything after the marketplace
     * cut. Comparing the two put history ahead of forecast by the tax on every
     * session. The tax is applied here, at read, so the stored figures stay a
     * record and every session ever saved is restated the same way. Coinify is
     * exempt: its output is coins, which no marketplace takes a cut of.
     *
     * An input the market cannot price falls back to its refinement craft cost
     * when it is a refined (★) item, and is reported as unpriced when even that
     * fails — an unknown cost is not a zero one.
     *
     * An output the market cannot price is excluded from `revenue` the same
     * way an unpriced input is excluded from `inputCost` — there is no number
     * to add, and adding zero would report "this earned nothing" for "we do
     * not know what this earned". `revenueUnpriced` carries that gap forward
     * the way `inputUnpriced` already does, so `Net` and `Break-even Input`
     * — both derived from `revenue` — can say they are incomplete too rather
     * than reading as a real loss.
     *
     * @param {Object} session
     * @returns {{profit: number, revenue: number, inputCost: number, catalystCost: number, coinCost: number,
     *   netConsumed: number, inputBasis: string|null, inputUnpriced: boolean, revenueUnpriced: boolean,
     *   revenueShopValued: boolean}}
     */
    computeSessionProfit(session) {
        const itemDetails = dataManager.getItemDetails(session.inputItemHrid);
        // The session's own bulk size, when it has one. Sessions recorded before
        // it was persisted have none, and the item's current value is the only
        // answer available for those.
        const bulkMultiplier = session.bulkMultiplier ?? itemDetails?.alchemyDetail?.bulkMultiplier ?? 1;
        const attempts = session.totalAttempts || 0;

        let revenue = 0;
        let revenueUnpriced = false;
        // A result the market cannot price (Labyrinth Token, from decomposing
        // scrolls) still has a value — the best conversion its own shop offers.
        // See alchemy-shop-value.js. That value is the market sell price of the
        // item the shop converts to, so turning it into gold is a market sale and
        // pays the same cut every other output here does.
        let revenueShopValued = false;
        for (const [resultItemHrid, result] of Object.entries(session.results || {})) {
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
            { hrid: CATALYST_OF_DECOMPOSITION_HRID, count: session.catalystOfDecompositionUsed || 0 },
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
            session.catalystOfDecompositionUsed === undefined && session.primeCatalystUsed === undefined;

        // Alchemy coin fee. This used to charge max(50, vendorPrice / 5) — the transmute
        // formula — while every other decompose site charged (10 + itemLevel) × 5. The fee is
        // absent from game data and unrecorded in session history, so nothing could adjudicate
        // it; the item-level formula won as the one the rest of the codebase already agreed on.
        // See utils/alchemy-fees.js.
        // The session's recorded bulkMultiplier is the one that was actually billed, so it
        // overrides whatever the item's bulk size happens to be now
        const coinCost = getAlchemyCoinCost(itemDetails, 'decompose', bulkMultiplier) * attempts;

        return {
            profit: revenue - inputCost - catalystCost - coinCost,
            revenue,
            revenueUnpriced,
            revenueShopValued,
            inputCost,
            catalystCost,
            catalystUnpriced,
            catalystUnrecorded,
            catalystHrids,
            coinCost,
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

        const tableContainer = this.modal.querySelector('.mwi-decompose-history-table-container');
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
            { key: '_expected', label: 'Expected', filterable: false },
            { key: 'results', label: 'Results', filterable: true },
            { key: '_catalystOfDecomposition', label: 'Catalyst of Decomposition', filterable: false },
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

            // Columns starting with _ are computed, not directly sortable by field;
            // 'results' holds an object and has no meaningful sort order
            const isSortable = !col.key.startsWith('_') && col.key !== 'results';
            const isCatalystCol = col.key === '_catalystOfDecomposition' || col.key === '_primeCatalyst';

            if (isSortable) {
                if (this.sortColumn === col.key) {
                    labelSpan.textContent = col.label + (this.sortDirection === 'asc' ? ' \u25B2' : ' \u25BC');
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
                    col.key === '_catalystOfDecomposition' ? CATALYST_OF_DECOMPOSITION_HRID : PRIME_CATALYST_HRID;
                renderCatalystColumnHeader(th, labelSpan, col.label, hrid, (el, h, size) =>
                    this.appendItemIcon(el, h, size)
                );
            } else {
                labelSpan.textContent = col.label;
                labelSpan.style.cursor = 'default';
            }

            headerContent.appendChild(labelSpan);

            if (col.filterable) {
                const filterBtn = document.createElement('button');
                filterBtn.textContent = '\u22EE';
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
                    ? 'No decompose history recorded yet.'
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
                appendPreFixMarker(dateCell, session, 'decompose');
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
                        : '0.0';
                rateCell.textContent = `${rate}%`;
                rateCell.style.padding = '6px 10px';
                row.appendChild(rateCell);

                // Expected — attempts × the success rate predicted when the session started
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

                // Catalyst of Decomposition
                const cocCell = document.createElement('td');
                cocCell.style.cssText = 'padding: 6px 10px; text-align: center;';
                // A session predating catalyst tracking has no count at all — its dash
                // means "unknown", not "none", and says so on hover
                const catalystUnrecorded = (this.profitCache.get(session.id) || this.computeSessionProfit(session))
                    .catalystUnrecorded;
                this.renderCatalystCell(
                    cocCell,
                    CATALYST_OF_DECOMPOSITION_HRID,
                    session.catalystOfDecompositionUsed || 0,
                    catalystUnrecorded
                );
                row.appendChild(cocCell);

                // Prime Catalyst
                const pcCell = document.createElement('td');
                pcCell.style.cssText = 'padding: 6px 10px; text-align: center;';
                this.renderCatalystCell(
                    pcCell,
                    PRIME_CATALYST_HRID,
                    session.primeCatalystUsed || 0,
                    catalystUnrecorded
                );
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
                    (profitDetail.catalystUnpriced ? '†' : '') +
                    (profitDetail.catalystUnrecorded ? '‡' : '') +
                    (profitDetail.revenueUnpriced ? '¶' : '') +
                    (profitDetail.revenueShopValued ? '§' : '');
                profitCell.style.cssText = `
                    padding: 6px 10px;
                    font-weight: bold;
                    color: ${profitDetail.profit >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS};
                `;
                profitCell.title =
                    `Output value: ${formatKMB(profitDetail.revenue, 1)}` +
                    `${profitDetail.revenueUnpriced ? ' (¶ unpriced — incomplete, not zero)' : ''}` +
                    `${profitDetail.revenueShopValued ? ' (§ includes a shop-derived value — see the result line below)' : ''}\n` +
                    `${formatInputCostLine(profitDetail)}\n` +
                    `Catalysts: −${formatKMB(profitDetail.catalystCost, 1)}\n` +
                    `Alchemy coins: −${formatKMB(profitDetail.coinCost, 1)}`;
                row.appendChild(profitCell);

                // Delete
                const deleteCell = document.createElement('td');
                deleteCell.style.cssText = 'padding: 6px 4px; text-align: center;';
                const deleteBtn = document.createElement('button');
                deleteBtn.textContent = '\u2715';
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

    /**
     * Render the results cell for a session
     * Results sorted by totalValue desc
     * @param {HTMLElement} cell
     * @param {Object} session
     */
    renderResultsCell(cell, session) {
        const results = session.results || {};
        const entries = Object.entries(results);

        if (entries.length === 0) {
            const span = document.createElement('span');
            span.textContent = '\u2014';
            span.style.color = '#888';
            cell.appendChild(span);
            return;
        }

        // Sort by totalValue desc
        const sortedEntries = entries.sort(([, a], [, b]) => (b.totalValue || 0) - (a.totalValue || 0));

        sortedEntries.forEach(([itemHrid, result]) => {
            const line = document.createElement('div');
            line.style.cssText = 'display: flex; align-items: center; gap: 6px; margin-bottom: 2px;';

            this.appendItemIcon(line, itemHrid, 16);

            const text = document.createElement('span');
            const name = this.getItemName(itemHrid);

            // The market cannot price an untradeable output like Labyrinth Token —
            // the session recorded totalValue: 0 for it — but a game shop may still
            // convert it to gold. Shown as a shop-derived value, never as the
            // recorded (zero) market price.
            const shopValue = result.unpriced || !(result.totalValue > 0) ? getAlchemyOutputShopValue(itemHrid) : null;
            if (shopValue) {
                const perUnit = shopValue.valuePerUnit;
                const total = formatKMB(perUnit * (result.count || 0), 1);
                const each = formatKMB(perUnit, 1);
                text.textContent = `${name} x${result.count} = ${total}§ (${each} each)`;
                text.title = describeShopValue(shopValue, (n) => formatKMB(n, 1));
            } else {
                const total = formatKMB(result.totalValue || 0, 1);
                const each = formatKMB(result.priceEach || 0, 1);
                text.textContent = `${name} x${result.count} = ${total}${result.unpriced ? '¶' : ''} (${each} each)`;
                if (result.unpriced) {
                    text.title = 'The market could not price this output — this value is incomplete, not zero.';
                }
            }

            line.appendChild(text);
            cell.appendChild(line);
        });
    }

    // ─── Totals by Input Item ───────────────────────────────────────────────

    /**
     * Group the currently filtered sessions by input item and total them.
     *
     * Consumed/cost figures come from the same per-session `computeSessionProfit`
     * result already cached by `applyFilters`, so a totals row and the Profit
     * column of the rows it sums can never disagree about a single session.
     *
     * Decompose has no self-return and no drop table, so none of transmute's
     * "internally impossible counts" machinery applies here: every attempt
     * consumes its input and every success hands back a fixed set of materials.
     * What does carry over is the marker discipline — an input the market
     * cannot price, or a catalyst that could not be priced or was never
     * recorded, is excluded and said so, never quietly counted as zero.
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
                revenue: 0,
                revenueUnpriced: false,
                revenueShopValued: false,
                inputCost: 0,
                inputUnpriced: false,
                catalystCost: 0,
                catalystUnpricedSessions: 0,
                catalystUnrecordedSessions: 0,
                catalystHrids: new Set(),
                coinCost: 0,
            }),
            accumulate: (group, session, detail) => {
                group.sessionCount++;
                group.attempts += session.totalAttempts || 0;
                group.successes += session.totalSuccesses || 0;
                group.netConsumed += detail.netConsumed;
                group.revenue += detail.revenue;
                if (detail.revenueUnpriced) group.revenueUnpriced = true;
                if (detail.revenueShopValued) group.revenueShopValued = true;
                group.inputCost += detail.inputCost;
                if (detail.inputUnpriced) group.inputUnpriced = true;
                group.catalystCost += detail.catalystCost;
                if (detail.catalystUnpriced) group.catalystUnpricedSessions++;
                if (detail.catalystUnrecorded) group.catalystUnrecordedSessions++;
                for (const hrid of detail.catalystHrids || []) group.catalystHrids.add(hrid);
                group.coinCost += detail.coinCost;
            },
            finalize: (group) => finalizeDecomposeGroup(group),
        });
    }

    /**
     * A signature two decompose inputs share only when decomposing one is
     * genuinely the same trade as decomposing the other.
     *
     * The case this exists for is scrolls: a handful of attempts on each of
     * seven scroll types is seven rows too thin to read, when what is really
     * being asked is "is decomposing scrolls worth it". Membership is derived
     * from the game data rather than written down as a list of hrids, for the
     * same reasons transmute derives its own: a fixed list silently misses a
     * scroll the game adds later, and keeps averaging one in after the game
     * changes what it breaks into.
     *
     * Equivalent means the same `bulkMultiplier` and the same `decomposeItems`
     * — same output items, in the same counts. Decompose is deterministic, so
     * that is the whole of the trade: two inputs with identical outputs and
     * bulk return identical value per attempt, and their samples can be added.
     * Requiring the output *hrids* to match, not just the shape, is deliberate
     * and is the same rule transmute applies to its drop table: two items that
     * break into different materials at the same rate are not interchangeable,
     * and summing their revenue would be nonsense.
     *
     * @param {string} itemHrid
     * @returns {string|null} The signature, or null when the item has no usable
     *   decompose data (it then pools with nothing, which is the safe default)
     */
    getDecomposeEquivalenceKey(itemHrid) {
        const alchemy = dataManager.getItemDetails(itemHrid)?.alchemyDetail;
        const outputs = alchemy?.decomposeItems;
        if (!Array.isArray(outputs) || outputs.length === 0) return null;

        const entries = outputs.map((output) => `${output.itemHrid}:${output.count ?? 1}`).sort();
        return JSON.stringify({ bulk: alchemy.bulkMultiplier ?? 1, entries });
    }

    /**
     * Sum a set of equivalent per-item groups into one pooled group.
     *
     * Every marker a per-item row can carry has to keep holding here: an
     * unpriced input poisons the pooled input cost the same way, and unpriced
     * or unrecorded catalyst sessions are counted, not dropped.
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
            revenue: 0,
            revenueUnpriced: false,
            revenueShopValued: false,
            inputCost: 0,
            inputUnpriced: false,
            catalystCost: 0,
            catalystUnpricedSessions: 0,
            catalystUnrecordedSessions: 0,
            catalystHrids: new Set(),
            coinCost: 0,
        };

        for (const group of members) {
            pooled.sessionCount += group.sessionCount;
            pooled.attempts += group.attempts;
            pooled.successes += group.successes;
            pooled.netConsumed += group.netConsumed;
            pooled.revenue += group.revenue;
            pooled.inputCost += group.inputCost;
            pooled.catalystCost += group.catalystCost;
            pooled.catalystUnpricedSessions += group.catalystUnpricedSessions;
            pooled.catalystUnrecordedSessions += group.catalystUnrecordedSessions;
            pooled.coinCost += group.coinCost;
            pooled.inputUnpriced = pooled.inputUnpriced || group.inputUnpriced;
            pooled.revenueUnpriced = pooled.revenueUnpriced || group.revenueUnpriced;
            pooled.revenueShopValued = pooled.revenueShopValued || group.revenueShopValued;
            for (const hrid of group.catalystHrids || []) pooled.catalystHrids.add(hrid);
        }

        pooled.memberHrids.sort((a, b) => this.getItemName(a).localeCompare(this.getItemName(b)));
        return finalizeDecomposeGroup(pooled);
    }

    /**
     * Pooled rows for sets of equivalent decompose inputs, in addition to
     * (never instead of) the per-item rows.
     *
     * @param {Array<Object>} totals - Per-item groups from `computeInputItemTotals`
     * @returns {Array<Object>} Zero or more pooled groups
     */
    computePooledTotals(totals) {
        return poolEquivalentGroups(totals, {
            getKey: (hrid) => this.getDecomposeEquivalenceKey(hrid),
            buildPooled: (members) => this.buildPooledGroup(members),
            getSortName: (hrid) => this.getItemName(hrid),
        });
    }

    /**
     * Render the "Totals by Input Item" table below the session list.
     */
    renderTotals() {
        const container = this.modal.querySelector('.mwi-decompose-history-totals-container');
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
            columns: DECOMPOSE_TOTALS_COLUMNS,
            rows,
            legendParts: [...DECOMPOSE_TOTALS_LEGEND, preFixLegend('decompose')],
            controls: createPreFixToggle({
                sessions: this.filteredSessions,
                includePreFix: this.includePreFix,
                onChange: (include) => {
                    this.includePreFix = include;
                    saveIncludePreFix('decompose', include);
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
     * Build one totals row for a single input-item group (or a pooled one).
     * @param {Object} group
     * @param {number} index
     * @returns {HTMLTableRowElement}
     */
    buildTotalsRow(group, index) {
        const row = document.createElement('tr');
        row.style.cssText = totalsRowStyle(index, { pooled: group.pooled });

        const itemCell = document.createElement('td');
        itemCell.style.cssText = 'padding: 6px 10px; display: flex; align-items: center; gap: 8px;';
        if (group.pooled) {
            for (const hrid of group.memberHrids) this.appendItemIcon(itemCell, hrid, 18);
        } else {
            this.appendItemIcon(itemCell, group.inputItemHrid, 18);
        }
        const nameSpan = document.createElement('span');
        nameSpan.textContent = group.pooled
            ? `Pooled: ${group.memberHrids.length} equivalent inputs`
            : this.getItemName(group.inputItemHrid);
        if (group.pooled) {
            nameSpan.style.fontStyle = 'italic';
            itemCell.title = this.pooledMembershipTitle(group);
        }
        itemCell.appendChild(nameSpan);
        row.appendChild(itemCell);

        row.appendChild(createTotalsCell(String(group.sessionCount)));
        row.appendChild(createTotalsCell(String(group.attempts)));
        row.appendChild(createTotalsCell(String(group.netConsumed)));

        const successPct = group.successRate !== null ? `${(group.successRate * 100).toFixed(1)}%` : '—';
        row.appendChild(createTotalsCell(`${group.successes} (${successPct})`));

        row.appendChild(
            createTotalsCell(
                formatKMB(group.revenue, 1) + (group.revenueUnpriced ? '¶' : '') + (group.revenueShopValued ? '§' : ''),
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
            createTotalsCell(formatKMB(group.inputCost, 1) + (group.inputUnpriced ? '*' : ''), {
                title: group.inputUnpriced
                    ? 'At least one session in this group has an unpriced input — this total is incomplete, not fully costed.'
                    : undefined,
            })
        );

        const [catalystText, catalystTitle] = formatDecomposeCatalystTotal(group);
        row.appendChild(createTotalsCell(catalystText, { title: catalystTitle }));

        row.appendChild(createTotalsCell(formatKMB(group.coinCost, 1)));
        // Net and Break-even both derive from revenue, so an unpriced output
        // poisons them the same way it poisons revenue itself — carrying the
        // ¶ mark through here is what keeps a genuinely bad Net (a real loss)
        // apart from a Net that only looks bad because part of what was earned
        // could not be counted.
        row.appendChild(
            createTotalsCell(
                formatKMB(group.net, 1) + (group.revenueUnpriced ? '¶' : '') + (group.revenueShopValued ? '§' : ''),
                {
                    color: group.net >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS,
                    bold: true,
                    title: group.revenueUnpriced
                        ? 'Includes an unpriced output — this total is incomplete, not a confirmed figure.'
                        : group.revenueShopValued
                          ? 'Includes an output valued at its best Labyrinth Shop conversion, not a market price.'
                          : undefined,
                }
            )
        );
        row.appendChild(
            createTotalsCell(
                (group.breakEvenInputValue !== null ? formatKMB(group.breakEvenInputValue, 1) : '—') +
                    (group.revenueUnpriced ? '¶' : '') +
                    (group.revenueShopValued ? '§' : ''),
                {
                    title: group.revenueUnpriced
                        ? 'Includes an unpriced output — this total is incomplete, not a confirmed figure.'
                        : group.revenueShopValued
                          ? 'Includes an output valued at its best Labyrinth Shop conversion, not a market price.'
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
        return (
            `Pooled across ${group.memberHrids.length} inputs: ${names}. ` +
            'These break into the same materials, in the same counts, at the same bulk size, so decomposing any ' +
            'of them returns the same value per attempt and the samples can be added. Membership is read from ' +
            'the game data, not a fixed list — an item whose outputs differ drops out by itself. The per-item ' +
            'rows above are unchanged.'
        );
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
                acc.revenueUnpriced = acc.revenueUnpriced || group.revenueUnpriced;
                acc.revenueShopValued = acc.revenueShopValued || group.revenueShopValued;
                acc.inputCost += group.inputCost;
                acc.catalystCost += group.catalystCost;
                acc.coinCost += group.coinCost;
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
                revenueUnpriced: false,
                revenueShopValued: false,
                inputCost: 0,
                catalystCost: 0,
                coinCost: 0,
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
        row.appendChild(
            createTotalsCell(
                formatKMB(overall.revenue, 1) +
                    (overall.revenueUnpriced ? '¶' : '') +
                    (overall.revenueShopValued ? '§' : ''),
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
            createTotalsCell(formatKMB(overall.inputCost, 1) + (overall.inputUnpriced ? '*' : ''), { bold: true })
        );

        const [catalystText, catalystTitle] = formatDecomposeCatalystTotal(overall);
        row.appendChild(createTotalsCell(catalystText, { bold: true, title: catalystTitle }));

        row.appendChild(createTotalsCell(formatKMB(overall.coinCost, 1), { bold: true }));

        const net = overall.revenue - overall.inputCost - overall.catalystCost - overall.coinCost;
        row.appendChild(
            createTotalsCell(
                formatKMB(net, 1) + (overall.revenueUnpriced ? '¶' : '') + (overall.revenueShopValued ? '§' : ''),
                {
                    bold: true,
                    color: net >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS,
                    title: overall.revenueUnpriced
                        ? 'Includes an unpriced output — this total is incomplete, not a confirmed figure.'
                        : overall.revenueShopValued
                          ? 'Includes an output valued at its best Labyrinth Shop conversion, not a market price.'
                          : undefined,
                }
            )
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
     * @param {boolean} [unrecorded] - The session predates catalyst tracking
     */
    renderCatalystCell(cell, catalystHrid, count, unrecorded = false) {
        renderCatalystCountCell(cell, catalystHrid, count, (el, hrid, size) => this.appendItemIcon(el, hrid, size), {
            unrecorded,
        });
    }

    /**
     * Render controls bar (stats + clear history button)
     */
    renderControls() {
        const controls = this.modal.querySelector('.mwi-decompose-history-controls');
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
        const container = this.modal.querySelector('.mwi-decompose-history-badges');
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
            removeBtn.textContent = '\u2715';
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
        const pagination = this.modal.querySelector('.mwi-decompose-history-pagination');
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
            prevBtn.textContent = '\u25C0';
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
            nextBtn.textContent = '\u25B6';
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
            const fresh = await decomposeHistoryTracker.loadSessions();
            this.sessions = fresh.filter((s) => s.id !== sessionId);
            await decomposeHistoryTracker.deleteSessions(this.sessions);
        } catch (error) {
            console.error('[DecomposeHistoryViewer] Failed to delete session:', error);
        }

        this.applyFilters();
        this.renderTable();
    }

    /**
     * The Data Note cell for a session's CSV export row: every qualification
     * the on-screen row marks with a symbol (* † ‡ ¶ § ◷), spelled out in
     * readable text — a spreadsheet reader has no legend for the symbols, so a
     * qualified row exported as a plain number reads more confident than the
     * same row on screen. Empty when nothing qualifies the row.
     * @param {Object} detail - A `computeSessionProfit` result
     * @param {Object|null} [session] - The session, for the pre-fix note
     * @returns {string} Semicolon-joined notes, or ''
     */
    buildDataNote(detail, session = null) {
        const notes = [];
        if (detail.inputUnpriced) notes.push('input unpriced — total is incomplete');
        if (detail.catalystUnpriced) notes.push('catalyst could not be priced — excluded, not zero');
        if (detail.catalystUnrecorded) notes.push('catalyst not recorded (predates tracking) — excluded, not zero');
        if (detail.revenueUnpriced) notes.push('output unpriced — revenue is incomplete, not zero-earning');
        if (detail.revenueShopValued) {
            notes.push('output valued at its best Labyrinth Shop conversion, not a market price');
        }
        const preFix = session ? preFixDataNote(session, 'decompose') : '';
        if (preFix) notes.push(preFix);
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
            'Enh. Level',
            'Attempts',
            'Successes',
            'Failures',
            'Success Rate',
            'Results',
            'Catalyst of Decomposition',
            'Prime Catalyst',
            'Profit',
            'Data Note',
        ];

        const rows = this.sessions.map((session) => {
            const start = formatDateTime(new Date(session.startTime));
            const inputName = this.getItemName(session.inputItemHrid);
            const failures = session.totalAttempts - session.totalSuccesses;
            const rate =
                session.totalAttempts > 0
                    ? ((session.totalSuccesses / session.totalAttempts) * 100).toFixed(1) + '%'
                    : '0.0%';

            const resultParts = Object.entries(session.results || {})
                .sort(([, a], [, b]) => (b.totalValue || 0) - (a.totalValue || 0))
                .map(([hrid, result]) => {
                    const name = this.getItemName(hrid);
                    // The figure the Profit column used, not the recorded zero of an untradeable output
                    const shopValue =
                        result.unpriced || !(result.totalValue > 0) ? getAlchemyOutputShopValue(hrid) : null;
                    if (shopValue) {
                        const total = formatKMB(shopValue.valuePerUnit * (result.count || 0), 1);
                        const each = formatKMB(shopValue.valuePerUnit, 1);
                        return `${name} x${result.count} = ${total} (${each} each, Labyrinth Shop value)`;
                    }
                    const total = formatKMB(result.totalValue || 0, 1);
                    const each = formatKMB(result.priceEach || 0, 1);
                    return `${name} x${result.count} = ${total} (${each} each${result.unpriced ? ', unpriced' : ''})`;
                });

            const detail = this.profitCache.get(session.id) || this.computeSessionProfit(session);

            return [
                start,
                inputName,
                session.enhancementLevel,
                session.totalAttempts,
                session.totalSuccesses,
                failures,
                rate,
                resultParts.join('; '),
                session.catalystOfDecompositionUsed || 0,
                session.primeCatalystUsed || 0,
                Math.round(detail.profit),
                this.buildDataNote(detail, session),
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
        a.download = `decompose-history-${date}.csv`;
        a.click();

        URL.revokeObjectURL(url);
    }

    /**
     * Download a lossless JSON backup of the current character's stored
     * decompose sessions — the exact unmerged records the tracker persists,
     * wrapped in the same envelope the other two windows use. See
     * `alchemy-session-import.js` for the envelope shape and which fields
     * are safe to hand-edit.
     * @returns {Promise<void>}
     */
    async exportBackup() {
        const characterId = dataManager.getCurrentCharacterId();
        const stored = await decomposeHistoryTracker.loadStoredSessions();
        const envelope = buildAlchemyBackupEnvelope({ kind: 'decompose', characterId, sessions: stored });
        const date = new Date().toISOString().slice(0, 10);
        downloadFile(
            `decompose-history-backup-${date}.json`,
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
        const scopeBefore = decomposeHistoryTracker.getCharacterScope();

        const parsed = parseAlchemyBackupJson(text);
        if (!parsed.ok) {
            alert(`Import refused: ${parsed.error}`);
            return;
        }

        const envelope = parsed.envelope;
        const envelopeCheck = validateAlchemyBackupEnvelope(envelope, { kind: 'decompose' });
        if (!envelopeCheck.ok) {
            alert(`Import refused: ${envelopeCheck.error}`);
            return;
        }

        const sessionsCheck = validateAlchemySessions('decompose', envelope.sessions);
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

        if (decomposeHistoryTracker.activeSession) {
            alert('A decompose session is actively recording — stop it, then try the import again.');
            return;
        }

        const stored = await decomposeHistoryTracker.loadStoredSessions();

        if (
            dataManager.getCurrentCharacterId() !== charIdBefore ||
            decomposeHistoryTracker.getCharacterScope() !== scopeBefore
        ) {
            alert('The active character changed during import — cancelled to avoid writing to the wrong character.');
            return;
        }
        if (decomposeHistoryTracker.activeSession) {
            alert('A decompose session started recording during import — cancelled. Try again once it ends.');
            return;
        }

        const plan = planAlchemyImportMerge(stored, envelope.sessions);

        const confirmed = confirm(
            `Import ${envelope.sessions.length} session(s) into Decompose History:\n` +
                `${plan.replaced} replaced, ${plan.added} added, ${plan.unchanged} unchanged.\n\nContinue?`
        );
        if (!confirmed) return;

        if (
            dataManager.getCurrentCharacterId() !== charIdBefore ||
            decomposeHistoryTracker.getCharacterScope() !== scopeBefore ||
            decomposeHistoryTracker.activeSession
        ) {
            alert('The active character changed — import cancelled to avoid writing to the wrong character.');
            return;
        }

        const written = await decomposeHistoryTracker.importSessions(plan.merged);
        if (!written) {
            alert('Import failed: the sessions could not be written to storage. Nothing changed.');
            return;
        }

        this.sessions = await decomposeHistoryTracker.loadSessions();
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
            `\u26A0\uFE0F This will permanently delete ALL decompose history (${this.sessions.length} sessions).\nThis cannot be undone.\n\nAre you sure?`
        );
        if (!confirmed) return;

        try {
            // A clear that could not list the store deleted nothing, and the
            // sessions are still on disk — emptying the table and saying
            // "cleared" would be a lie the next reload exposes.
            if (!(await decomposeHistoryTracker.clearHistory())) {
                alert('Decompose history could NOT be cleared — storage could not be read. Nothing was deleted.');
                return;
            }
            this.sessions = [];
            this.filteredSessions = [];
            alert('Decompose history cleared.');
            this.applyFilters();
            this.renderTable();
        } catch (error) {
            console.error('[DecomposeHistoryViewer] Failed to clear history:', error);
            alert(`Failed to clear history: ${error.message}`);
        }
    }
}

const decomposeHistoryViewer = new DecomposeHistoryViewer();

export { decomposeHistoryViewer };

export default {
    name: 'Decompose History Viewer',
    initialize: () => decomposeHistoryViewer.initialize(),
    cleanup: () => {
        try {
            return decomposeHistoryViewer.disable();
        } catch (error) {
            console.error('[Decompose History Viewer] Disable failed part-way:', error);
        } finally {
            decomposeHistoryViewer.isInitialized = false;
        }
    },
};
