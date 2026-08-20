/**
 * Market Sort by Profitability
 * Adds ability to sort marketplace items by profit/hour or by alchemy profit
 *
 * ## The alchemy modes
 *
 * "What is this book worth if I buy it and transmute it?" is a marketplace
 * question, not an alchemy-panel one, so the two alchemy modes answer it on the
 * item grid. None of the arithmetic is here: every figure comes off
 * `alchemy-profit-calculator.js`, the same calculator the alchemy panel and the
 * Best Items table quote, asked once per alchemy action per item and the best
 * answer kept. That calculator already carries the success rate, the catalyst
 * choice, the tea costs and the coin fee, and re-deriving any of it here would
 * be a second opinion about the same number.
 *
 * The one thing these modes insist on is the pricing: the requested flow is
 * insta-buy the input at ask and insta-sell the outputs at bid, which is the
 * `'conservative'` pricing mode whatever the user's global setting says. That
 * is pinned with `withProfitPricingMode` around the calculator calls rather
 * than by touching the setting, so nothing else in the script sees it move.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import domObserver from '../../core/dom-observer.js';
import marketAPI from '../../api/marketplace.js';
import profitCalculator from './profit-calculator.js';
import alchemyProfitCalculator from './alchemy-profit-calculator.js';
import { calculateGatheringProfit } from '../actions/gathering-profit.js';
import { formatLargeNumber, formatKMB } from '../../utils/formatters.js';
import { withProfitPricingMode } from '../../utils/market-data.js';

/**
 * The sort modes the button offers, in dropdown order.
 * `metric` is the field of an alchemy candidate a mode ranks by; production
 * profit has no candidates and leaves it null.
 */
export const SORT_MODES = [
    { value: 'profit', label: 'Profit', buttonLabel: 'Sort by Profit', metric: null },
    { value: 'alchemyProfit', label: 'Alchemy profit', buttonLabel: 'Sort by Alchemy', metric: 'profitPerAction' },
    {
        value: 'alchemyProfitPerHour',
        label: 'Alchemy profit/hr',
        buttonLabel: 'Sort by Alchemy/hr',
        metric: 'profitPerHour',
    },
];

const DEFAULT_SORT_MODE = 'profit';

/**
 * The three alchemy actions an item might go through, and how to price each.
 * Transmute takes no enhancement level — the item goes in as it is.
 */
const ALCHEMY_ACTIONS = [
    { action: 'coinify', method: 'calculateCoinifyProfit', withEnhancement: true },
    { action: 'decompose', method: 'calculateDecomposeProfit', withEnhancement: true },
    { action: 'transmute', method: 'calculateTransmuteProfit', withEnhancement: false },
];

/** Ask in, bid out — the flow the alchemy modes quote, regardless of the global setting */
const ALCHEMY_PRICING_MODE = 'conservative';

const ALCHEMY_TOOLTIP =
    'Insta-buy at ask, best alchemy action, insta-sell at bid — includes catalyst cost if the ' +
    "engine's current catalyst setting uses one. Ignores the global pricing mode on purpose.";

/**
 * Look up a sort mode descriptor, falling back to the default for anything unknown.
 * @param {string} value - Mode id
 * @returns {Object} The mode descriptor
 */
export function getSortMode(value) {
    return SORT_MODES.find((mode) => mode.value === value) || SORT_MODES[0];
}

/**
 * Whether a mode is one of the alchemy modes.
 * @param {string} value - Mode id
 * @returns {boolean} True when the mode ranks by alchemy profit
 */
export function isAlchemyMode(value) {
    return getSortMode(value).metric !== null;
}

class MarketSort {
    constructor() {
        this.isActive = false;
        this.unregisterHandlers = [];
        this.isInitialized = false;

        // Profit cache for current session (cleared on navigation)
        this.profitCache = new Map();

        // Alchemy candidates per item, keyed by item hrid. One entry holds every
        // alchemy action that priced, so both alchemy modes read the same
        // computation and switching mode costs nothing.
        this.alchemyCache = new Map();

        // The market fetch the alchemy cache was computed against; a newer one
        // invalidates it, because every figure in it is a price.
        this.alchemyCacheStamp = null;

        // Original order storage (item HRIDs in original order)
        this.originalOrder = [];

        // Sort state
        this.sortDirection = 'desc'; // 'desc' = highest profit first
        this.sortMode = DEFAULT_SORT_MODE;
        this.isSorting = false;
        this.hasSorted = false;
        // Whether `originalOrder` holds the grid's own order. Separate from
        // `hasSorted` because changing mode restarts the direction toggle
        // without giving back the order the game shipped.
        this.hasCapturedOrder = false;
        this.sortButton = null;
        this.modeSelect = null;
    }

    /**
     * The idle label for the sort button under the current mode.
     * @param {boolean} [withArrow=false] - Whether to append the direction arrow
     * @returns {string} Button text
     */
    sortButtonLabel(withArrow = false) {
        const label = getSortMode(this.sortMode).buttonLabel;
        if (!withArrow) return label;
        return `${label} ${this.sortDirection === 'desc' ? '▼' : '▲'}`;
    }

    /**
     * Put the sort button back to its un-sorted label.
     * @returns {void}
     */
    resetSortButtonLabel() {
        if (this.sortButton) {
            this.sortButton.textContent = this.sortButtonLabel();
        }
    }

    /**
     * Forget every cached figure — for a tab change, a navigation or a mode change.
     * @returns {void}
     */
    clearCaches() {
        this.profitCache.clear();
        this.alchemyCache.clear();
        this.alchemyCacheStamp = null;
    }

    /**
     * Initialize market sort
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('marketSort')) {
            return;
        }

        this.isInitialized = true;
        this.sortMode = getSortMode(config.getSettingValue('marketSort_mode', DEFAULT_SORT_MODE)).value;

        // Register DOM observers for marketplace panel
        this.registerDOMObservers();

        this.isActive = true;
    }

    /**
     * Register DOM observers for marketplace panel
     */
    registerDOMObservers() {
        // Watch for marketplace panel appearing
        const unregister = domObserver.onClass(
            'market-sort-container',
            'MarketplacePanel_itemFilterContainer',
            (filterContainer) => {
                this.injectSortUI(filterContainer);
            }
        );

        this.unregisterHandlers.push(unregister);

        // Clear cache when navigating away from marketplace
        const unregisterNav = domObserver.onClass(
            'market-sort-nav',
            'MarketplacePanel_panel',
            () => {
                // Panel appeared, don't clear cache
            },
            () => {
                // Panel disappeared, clear cache and original order
                this.clearCaches();
                this.originalOrder = [];
                this.hasSorted = false;
                this.hasCapturedOrder = false;
                this.sortDirection = 'desc';
                this.resetSortButtonLabel();
            }
        );

        this.unregisterHandlers.push(unregisterNav);

        // Watch for tab changes within marketplace (items container gets replaced)
        const unregisterItems = domObserver.onClass('market-sort-items', 'MarketplacePanel_marketItems', () => {
            // Items container appeared/changed - reset sort state
            this.clearCaches();
            this.originalOrder = [];
            this.hasSorted = false;
            this.hasCapturedOrder = false;
            this.sortDirection = 'desc';
            this.resetSortButtonLabel();
            // Remove profit indicators from any stale elements
            document.querySelectorAll('.toolasha-profit-indicator').forEach((el) => el.remove());
        });

        this.unregisterHandlers.push(unregisterItems);

        // Check immediately in case marketplace is already open
        const existingFilterContainer = document.querySelector('div[class*="MarketplacePanel_itemFilterContainer"]');
        if (existingFilterContainer) {
            this.injectSortUI(existingFilterContainer);
        }
    }

    /**
     * Inject sort UI into marketplace panel
     * @param {HTMLElement} filterContainer - Filter container element
     */
    injectSortUI(filterContainer) {
        // Check if already injected
        if (document.querySelector('#toolasha-market-sort')) {
            return;
        }

        // Create sort container
        const sortDiv = document.createElement('div');
        sortDiv.id = 'toolasha-market-sort';
        sortDiv.style.cssText = 'display: flex; gap: 8px; margin-top: 8px; align-items: center;';

        // Create the mode dropdown
        const modeSelect = document.createElement('select');
        modeSelect.id = 'toolasha-market-sort-mode';
        modeSelect.style.cssText = `
            padding: 5px 6px;
            border-radius: 4px;
            background: rgba(0, 0, 0, 0.4);
            color: #fff;
            border: 1px solid rgba(91, 141, 239, 0.5);
            cursor: pointer;
            font-size: 12px;
        `;

        for (const mode of SORT_MODES) {
            const option = document.createElement('option');
            option.value = mode.value;
            option.textContent = mode.label;
            modeSelect.appendChild(option);
        }

        modeSelect.value = this.sortMode;
        modeSelect.addEventListener('change', () => this.handleModeChange(modeSelect.value));

        this.modeSelect = modeSelect;
        sortDiv.appendChild(modeSelect);

        // Create sort button
        const sortButton = document.createElement('button');
        sortButton.id = 'toolasha-sort-profit-btn';
        sortButton.textContent = getSortMode(this.sortMode).buttonLabel;
        sortButton.style.cssText = `
            padding: 6px 12px;
            border-radius: 4px;
            background: rgba(91, 141, 239, 0.2);
            color: #fff;
            border: 1px solid rgba(91, 141, 239, 0.5);
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
        `;

        sortButton.addEventListener('mouseenter', () => {
            if (!this.isSorting) {
                sortButton.style.background = 'rgba(91, 141, 239, 0.4)';
            }
        });

        sortButton.addEventListener('mouseleave', () => {
            if (!this.isSorting) {
                sortButton.style.background = 'rgba(91, 141, 239, 0.2)';
            }
        });

        sortButton.addEventListener('click', () => this.handleSortClick());

        this.sortButton = sortButton;
        sortDiv.appendChild(sortButton);
        this.applyModeTooltip();

        // Create reset button
        const resetButton = document.createElement('button');
        resetButton.textContent = 'Reset Order';
        resetButton.style.cssText = `
            padding: 6px 12px;
            border-radius: 4px;
            background: rgba(100, 100, 100, 0.2);
            color: #fff;
            border: 1px solid rgba(100, 100, 100, 0.5);
            cursor: pointer;
            font-size: 12px;
            transition: background 0.2s;
        `;

        resetButton.addEventListener('mouseenter', () => {
            resetButton.style.background = 'rgba(100, 100, 100, 0.4)';
        });

        resetButton.addEventListener('mouseleave', () => {
            resetButton.style.background = 'rgba(100, 100, 100, 0.2)';
        });

        resetButton.addEventListener('click', () => this.resetOrder());

        sortDiv.appendChild(resetButton);

        // Insert after the filter container
        filterContainer.parentElement.insertBefore(sortDiv, filterContainer.nextSibling);
    }

    /**
     * Explain the current mode on both controls.
     *
     * The alchemy modes need saying out loud that they ignore the global
     * pricing mode — the figure is otherwise indistinguishable from one that
     * respects it, and a user who has set "optimistic" would read it wrong.
     *
     * @returns {void}
     */
    applyModeTooltip() {
        const tooltip = isAlchemyMode(this.sortMode)
            ? ALCHEMY_TOOLTIP
            : 'Profit per hour from producing or gathering this item.';
        if (this.sortButton) this.sortButton.title = tooltip;
        if (this.modeSelect) this.modeSelect.title = tooltip;
    }

    /**
     * Switch sort mode: persist it, drop the badges the old mode drew, and
     * re-sort from the top so the next click still means "descending".
     * @param {string} value - The newly selected mode id
     * @returns {void}
     */
    handleModeChange(value) {
        const mode = getSortMode(value);
        if (mode.value === this.sortMode) return;

        this.sortMode = mode.value;
        config.setSettingValue('marketSort_mode', mode.value);

        // The badges on screen are the previous mode's figures
        document.querySelectorAll('.toolasha-profit-indicator').forEach((el) => el.remove());
        this.hasSorted = false;
        this.sortDirection = 'desc';
        this.resetSortButtonLabel();
        this.applyModeTooltip();
    }

    /**
     * Handle sort button click
     */
    async handleSortClick() {
        if (this.isSorting) {
            return;
        }

        // Toggle direction only if we've already sorted once
        if (this.hasSorted) {
            this.sortDirection = this.sortDirection === 'desc' ? 'asc' : 'desc';
        }

        this.sortButton.textContent = this.sortDirection === 'desc' ? 'Sorting... ▼' : 'Sorting... ▲';
        this.sortButton.style.background = 'rgba(91, 141, 239, 0.6)';
        this.isSorting = true;

        try {
            await this.sortByProfitability();
        } finally {
            this.isSorting = false;
            this.sortButton.textContent = this.sortButtonLabel(true);
            this.sortButton.style.background = 'rgba(91, 141, 239, 0.2)';
        }
    }

    /**
     * Sort marketplace items by profitability
     */
    async sortByProfitability() {
        const marketItemsContainer = document.querySelector('div[class*="MarketplacePanel_marketItems"]');
        if (!marketItemsContainer) {
            return;
        }

        const gameData = dataManager.getInitClientData();
        if (!gameData || !gameData.itemDetailMap) {
            return;
        }

        // A new market fetch makes every cached figure a quote against prices
        // that no longer exist. Cheaper to notice here than to re-derive.
        this.invalidateOnPriceRefresh();

        // Get all visible item divs
        const itemDivs = Array.from(marketItemsContainer.querySelectorAll('div[class*="Item_itemContainer"]'));
        const visibleItems = itemDivs.filter((div) => div.style.display !== 'none');

        // Store original order on first sort
        if (!this.hasCapturedOrder) {
            this.originalOrder = visibleItems.map((div) => {
                const useElement = div.querySelector('use');
                const href = useElement?.getAttribute('href') || '';
                const hrefName = href.split('#')[1] || '';
                return `/items/${hrefName}`;
            });
            this.hasCapturedOrder = true;
        }
        this.hasSorted = true;

        // Calculate profits for all items (using cache when available)
        const itemsWithProfit = [];

        for (const itemDiv of visibleItems) {
            const useElement = itemDiv.querySelector('use');
            if (!useElement) {
                itemsWithProfit.push({ element: itemDiv, profit: null, itemHrid: null });
                continue;
            }

            const href = useElement.getAttribute('href');
            if (!href) {
                itemsWithProfit.push({ element: itemDiv, profit: null, itemHrid: null });
                continue;
            }

            const hrefName = href.split('#')[1];
            if (!hrefName) {
                itemsWithProfit.push({ element: itemDiv, profit: null, itemHrid: null });
                continue;
            }

            const itemHrid = `/items/${hrefName}`;

            // Check cache first. Keyed by mode as well as item: the modes quote
            // different things about the same tile.
            const cacheKey = `${this.sortMode}:${itemHrid}`;
            if (this.profitCache.has(cacheKey)) {
                itemsWithProfit.push({ element: itemDiv, ...this.profitCache.get(cacheKey), itemHrid });
                continue;
            }

            // Calculate profit
            const result = await this.calculateItemProfit(itemHrid, gameData);
            this.profitCache.set(cacheKey, result);
            itemsWithProfit.push({ element: itemDiv, ...result, itemHrid });
        }

        // Sort items
        itemsWithProfit.sort((a, b) => {
            // Items without profit go to the end
            if (a.profit === null && b.profit === null) return 0;
            if (a.profit === null) return 1;
            if (b.profit === null) return -1;

            // Sort by profit
            return this.sortDirection === 'desc' ? b.profit - a.profit : a.profit - b.profit;
        });

        // Reorder DOM elements
        for (const item of itemsWithProfit) {
            marketItemsContainer.appendChild(item.element);

            // Add profit indicator
            this.addProfitIndicator(item.element, item.profit, item.detail);
        }
    }

    /**
     * Calculate the figure the current mode ranks by.
     * @param {string} itemHrid - Item HRID
     * @param {Object} gameData - Game data
     * @returns {Promise<{profit: number|null, detail: string|null}>} The figure and what it describes
     */
    async calculateItemProfit(itemHrid, gameData) {
        const mode = getSortMode(this.sortMode);

        if (mode.metric) {
            const best = this.bestAlchemyCandidate(itemHrid, mode.metric);
            if (!best) return { profit: null, detail: null };
            return { profit: best[mode.metric], detail: best.action };
        }

        // Try production profit first (craftable items)
        const productionProfit = await profitCalculator.calculateProfit(itemHrid);
        if (productionProfit && productionProfit.profitPerHour !== undefined) {
            return { profit: productionProfit.profitPerHour, detail: null };
        }

        // Try gathering profit (find action that produces this item)
        const gatheringAction = this.findGatheringAction(itemHrid, gameData);
        if (gatheringAction) {
            const gatheringProfit = await calculateGatheringProfit(gatheringAction);
            if (gatheringProfit && gatheringProfit.profitPerHour !== undefined) {
                return { profit: gatheringProfit.profitPerHour, detail: null };
            }
        }

        return { profit: null, detail: null };
    }

    /**
     * Drop every cached figure when the market data behind it has been replaced.
     *
     * Prices are the only input to these numbers that moves on its own, and the
     * market API stamps each fetch, so one comparison covers the lot.
     *
     * @returns {void}
     */
    invalidateOnPriceRefresh() {
        const stamp = marketAPI?.lastFetchTimestamp ?? null;
        if (this.alchemyCacheStamp !== null && this.alchemyCacheStamp !== stamp) {
            this.profitCache.clear();
            this.alchemyCache.clear();
        }
        this.alchemyCacheStamp = stamp;
    }

    /**
     * Every alchemy action that can be run on an item, priced.
     *
     * The whole calculation is the alchemy profit calculator's — coinify,
     * decompose and transmute each asked once, ineligible ones answering null
     * and dropping out. The pricing is pinned to `'conservative'` for the
     * duration: ask for what goes in, bid for what comes out, which is the
     * insta-buy/insta-sell flow these modes describe and is not necessarily the
     * user's global pricing mode.
     *
     * Memoised per item until the prices behind it are refetched, because the
     * grid asks about hundreds of items and each answer is three calculator
     * passes over the character's gear, teas and efficiency.
     *
     * @param {string} itemHrid - Item HRID
     * @returns {Array<{action: string, profitPerAction: number, profitPerHour: number, catalyst: string|null}>} Candidates, unsorted
     */
    alchemyCandidates(itemHrid) {
        const cached = this.alchemyCache.get(itemHrid);
        if (cached) return cached;

        const candidates = [];
        try {
            withProfitPricingMode(ALCHEMY_PRICING_MODE, () => {
                for (const { action, method, withEnhancement } of ALCHEMY_ACTIONS) {
                    let data;
                    try {
                        data = withEnhancement
                            ? alchemyProfitCalculator[method](itemHrid, 0)
                            : alchemyProfitCalculator[method](itemHrid);
                    } catch {
                        continue;
                    }
                    if (!data) continue;

                    const profitPerAction = Number(data.profitPerAction);
                    const profitPerHour = Number(data.profitPerHour);
                    if (!Number.isFinite(profitPerAction) || !Number.isFinite(profitPerHour)) continue;

                    candidates.push({
                        action,
                        profitPerAction,
                        profitPerHour,
                        catalyst: data.winningCatalystHrid || null,
                    });
                }
            });
        } catch (error) {
            console.error('[Market Sort] Alchemy pricing failed for', itemHrid, error);
        }

        this.alchemyCache.set(itemHrid, candidates);
        return candidates;
    }

    /**
     * The alchemy action that pays best on an item under a given metric.
     * @param {string} itemHrid - Item HRID
     * @param {string} metric - 'profitPerAction' or 'profitPerHour'
     * @returns {Object|null} The winning candidate, or null when nothing prices
     */
    bestAlchemyCandidate(itemHrid, metric) {
        let best = null;
        for (const candidate of this.alchemyCandidates(itemHrid)) {
            if (!best || candidate[metric] > best[metric]) best = candidate;
        }
        return best;
    }

    /**
     * Find gathering action that produces an item
     * @param {string} itemHrid - Item HRID
     * @param {Object} gameData - Game data
     * @returns {string|null} Action HRID or null
     */
    findGatheringAction(itemHrid, gameData) {
        const gatheringTypes = ['/action_types/foraging', '/action_types/woodcutting', '/action_types/milking'];

        for (const [actionHrid, action] of Object.entries(gameData.actionDetailMap)) {
            if (!gatheringTypes.includes(action.type)) {
                continue;
            }

            // Check drop table for this item
            if (action.dropTable) {
                for (const drop of action.dropTable) {
                    if (drop.itemHrid === itemHrid) {
                        return actionHrid;
                    }
                }
            }
        }

        return null;
    }

    /**
     * Add profit indicator to item element
     * @param {HTMLElement} itemDiv - Item container element
     * @param {number|null} profit - The current mode's figure, or null when it does not apply
     * @param {string|null} [detail=null] - The winning alchemy action, for the badge's tooltip
     */
    addProfitIndicator(itemDiv, profit, detail = null) {
        // Remove existing indicator
        const existing = itemDiv.querySelector('.toolasha-profit-indicator');
        if (existing) {
            existing.remove();
        }

        const alchemyMode = isAlchemyMode(this.sortMode);

        // An item with no alchemy action, or one whose inputs or outputs have no
        // price, has nothing to say — it sorts to the bottom and stays bare
        // rather than claiming a dash means zero.
        if (profit === null && alchemyMode) {
            return;
        }

        // Create indicator
        const indicator = document.createElement('div');
        indicator.className = 'toolasha-profit-indicator';

        const format = alchemyMode ? (value) => formatKMB(value) : (value) => formatLargeNumber(value, 0);

        let displayText;
        let color;

        if (profit === null) {
            displayText = '—';
            color = 'rgba(150, 150, 150, 0.8)';
        } else if (profit >= 0) {
            displayText = `+${format(profit)}`;
            color = profit > 100000 ? '#4CAF50' : profit > 0 ? '#8BC34A' : 'rgba(150, 150, 150, 0.8)';
        } else {
            displayText = format(profit);
            color = '#F44336';
        }

        if (alchemyMode && detail) {
            indicator.title = `${detail} — ${ALCHEMY_TOOLTIP}`;
        }

        indicator.textContent = displayText;
        indicator.style.cssText = `
            position: absolute;
            top: 2px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 9px;
            font-weight: 600;
            color: ${color};
            background: rgba(0, 0, 0, 0.7);
            padding: 1px 3px;
            border-radius: 2px;
            white-space: nowrap;
            pointer-events: ${indicator.title ? 'auto' : 'none'};
            z-index: 10;
        `;

        // Ensure parent has position relative for absolute positioning
        if (getComputedStyle(itemDiv).position === 'static') {
            itemDiv.style.position = 'relative';
        }

        itemDiv.appendChild(indicator);
    }

    /**
     * Reset item order to original
     */
    resetOrder() {
        const marketItemsContainer = document.querySelector('div[class*="MarketplacePanel_marketItems"]');
        if (!marketItemsContainer) {
            return;
        }

        // Remove all profit indicators
        document.querySelectorAll('.toolasha-profit-indicator').forEach((el) => el.remove());

        // Restore original order if we have it
        if (this.originalOrder.length > 0) {
            const itemDivs = Array.from(marketItemsContainer.querySelectorAll('div[class*="Item_itemContainer"]'));

            // Create a map of itemHrid -> element
            const elementMap = new Map();
            for (const div of itemDivs) {
                const useElement = div.querySelector('use');
                const href = useElement?.getAttribute('href') || '';
                const hrefName = href.split('#')[1] || '';
                const itemHrid = `/items/${hrefName}`;
                elementMap.set(itemHrid, div);
            }

            // Reorder based on original order
            for (const itemHrid of this.originalOrder) {
                const element = elementMap.get(itemHrid);
                if (element) {
                    marketItemsContainer.appendChild(element);
                }
            }
        }

        // Clear cache and reset state
        this.clearCaches();
        this.originalOrder = [];
        this.hasSorted = false;
        this.hasCapturedOrder = false;

        // Reset sort direction
        this.sortDirection = 'desc';
        this.resetSortButtonLabel();
    }

    /**
     * Cleanup on disable
     */
    disable() {
        try {
            this.unregisterHandlers.forEach((unregister) => unregister());
            this.unregisterHandlers = [];

            // Remove sort UI
            const sortDiv = document.querySelector('#toolasha-market-sort');
            if (sortDiv) {
                sortDiv.remove();
            }

            // Remove profit indicators
            document.querySelectorAll('.toolasha-profit-indicator').forEach((el) => el.remove());

            // Clear cache
            this.clearCaches();
            this.originalOrder = [];
            this.hasSorted = false;
            this.hasCapturedOrder = false;

            this.isActive = false;
            this.isInitialized = false;
            this.sortButton = null;
            this.modeSelect = null;
        } catch (error) {
            console.error('[Market Sort] Disable failed part-way:', error);
        } finally {
            this.isActive = false;
            this.isInitialized = false;
        }
    }
}

const marketSort = new MarketSort();

export default marketSort;
