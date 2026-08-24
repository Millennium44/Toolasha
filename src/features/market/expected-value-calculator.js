/**
 * Expected Value Calculator Module
 * Calculates expected value for openable containers
 */

import marketAPI from '../../api/marketplace.js';
import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { calculateDungeonTokenValue } from '../../utils/token-valuation.js';
import { getItemPrice } from '../../utils/market-data.js';
import { getCustomPrice } from '../settings/custom-price-overrides.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';
import { calculateEVBatch, terminateEVWorkerPool } from '../../utils/ev-worker-manager.js';
import { MARKET_TAX } from '../../utils/profit-constants.js';

/**
 * ExpectedValueCalculator class handles EV calculations for openable containers
 */
class ExpectedValueCalculator {
    constructor() {
        // Constants
        this.MARKET_TAX = MARKET_TAX; // marketplace tax (see profit-constants)
        this.CONVERGENCE_ITERATIONS = 4; // Nested container convergence

        // Cache for container EVs
        this.containerCache = new Map();
        // How many drops of each cached container could not be priced, so a nested
        // lookup can report the parent as partial rather than silently confident
        this.containerMissingCounts = new Map();

        // Special item HRIDs
        this.COIN_HRID = '/items/coin';
        this.COWBELL_HRID = '/items/cowbell';
        this.COWBELL_BAG_HRID = '/items/bag_of_10_cowbells';

        // Dungeon token HRIDs
        this.DUNGEON_TOKENS = [
            '/items/chimerical_token',
            '/items/sinister_token',
            '/items/enchanted_token',
            '/items/pirate_token',
        ];

        // Flag to track if initialized
        this.isInitialized = false;

        // Retry handler reference for cleanup
        this.retryHandler = null;
    }

    /**
     * Initialize the calculator
     * Pre-calculates all openable containers with nested convergence
     */
    async initialize() {
        if (this.isInitialized) {
            return true;
        }

        if (!dataManager.getInitClientData()) {
            // Init data not yet available - set up retry on next character update
            if (!this.retryHandler) {
                this.retryHandler = () => {
                    this.initialize(); // Retry initialization
                };
                dataManager.on('character_initialized', this.retryHandler);
            }
            return false;
        }

        // Data is available - remove retry handler if it exists
        if (this.retryHandler) {
            dataManager.off('character_initialized', this.retryHandler);
            this.retryHandler = null;
        }

        // Wait for market data to load
        if (!marketAPI.isLoaded()) {
            // Joins the startup fetch the entrypoint already began (or the cache)
            await marketAPI.fetch();
        }

        // Calculate all containers with 4-iteration convergence for nesting (now async with workers)
        await this.calculateNestedContainers();

        this.isInitialized = true;

        // Notify listeners that calculator is ready
        dataManager.emit('expected_value_initialized', { timestamp: Date.now() });

        return true;
    }

    /**
     * Calculate all containers with nested convergence using workers
     * Iterates 4 times to resolve nested container values
     */
    async calculateNestedContainers() {
        const initData = dataManager.getInitClientData();
        if (!initData || !initData.openableLootDropMap) {
            return;
        }

        // Get all openable container HRIDs
        const containerHrids = Object.keys(initData.openableLootDropMap);

        // Iterate 4 times for convergence (handles nesting depth)
        for (let iteration = 0; iteration < this.CONVERGENCE_ITERATIONS; iteration++) {
            // Build price map for all items (includes cached container EVs from previous iterations)
            const priceMap = this.buildPriceMap(containerHrids, initData);

            // Prepare container data for workers
            const containerData = containerHrids.map((containerHrid) => ({
                containerHrid,
                dropTable: initData.openableLootDropMap[containerHrid],
                priceMap,
                COIN_HRID: this.COIN_HRID,
                MARKET_TAX: this.MARKET_TAX,
            }));

            // Calculate all containers in parallel using workers
            try {
                const results = await calculateEVBatch(containerData);

                // Update cache with results
                for (const result of results) {
                    if (result.ev !== null) {
                        this.containerCache.set(result.containerHrid, result.ev);
                        // The worker only returns a number, so the "how much of this
                        // is missing" half is recounted here against the same price
                        // map it was handed — otherwise a cache hit would report a
                        // partially priced container as a firm figure.
                        this.containerMissingCounts.set(
                            result.containerHrid,
                            this.countUnpricedDrops(initData.openableLootDropMap[result.containerHrid], priceMap)
                        );
                    }
                }
            } catch (error) {
                // Worker failed, fall back to main thread calculation
                console.warn('[ExpectedValueCalculator] Worker failed, falling back to main thread:', error);
                // Go through calculateContainerValue rather than writing the cache here:
                // it is the one place that sets the value and its missing-drop count
                // together, and that refuses to cache a figure the cycle guard truncated.
                // Setting containerCache alone left resolveContainerValue hitting a value
                // with no count, reporting a partially priced chest as a firm number.
                for (const containerHrid of containerHrids) {
                    this.calculateContainerValue(containerHrid, initData);
                }
            }
        }
    }

    /**
     * How many of a container's drops the price map could not value, counting a nested
     * container's own unpriced drops too — the convergence iterations make that count
     * available by the time the outer container is recomputed.
     * @param {Array} dropTable - The container's drop table
     * @param {Object} priceMap - Map of itemHrid to {price, canBeSold}
     * @returns {number} Number of drops with no reachable price
     */
    countUnpricedDrops(dropTable, priceMap) {
        if (!dropTable) return 0;

        let missing = 0;
        for (const drop of dropTable) {
            const dropRate = drop.dropRate || 0;
            const minCount = drop.minCount || 0;
            const maxCount = drop.maxCount || 0;
            if (dropRate <= 0 || (minCount === 0 && maxCount === 0)) continue;

            const price = priceMap[drop.itemHrid]?.price ?? null;
            if (price === null) missing++;
            else missing += this.containerMissingCounts.get(drop.itemHrid) || 0;
        }
        return missing;
    }

    /**
     * Build price map for all items needed for container calculations
     * @param {Array} containerHrids - Array of container HRIDs
     * @param {Object} initData - Game data
     * @returns {Object} Map of itemHrid to {price, canBeSold}
     */
    buildPriceMap(containerHrids, initData) {
        const priceMap = {};
        const processedItems = new Set();

        // Collect all unique items from all containers
        for (const containerHrid of containerHrids) {
            const dropTable = initData.openableLootDropMap[containerHrid];
            if (!dropTable) continue;

            for (const drop of dropTable) {
                const itemHrid = drop.itemHrid;
                if (processedItems.has(itemHrid)) continue;
                processedItems.add(itemHrid);

                // Get price and tradeable status
                const price = this.getDropPrice(itemHrid);
                const itemDetails = dataManager.getItemDetails(itemHrid);
                const canBeSold = itemDetails?.isTradable !== false;

                priceMap[itemHrid] = {
                    price,
                    canBeSold,
                };
            }
        }

        return priceMap;
    }

    /**
     * Calculate expected value for a single container.
     * @param {string} containerHrid - Container item HRID
     * @param {Object} initData - Cached game data (optional, will fetch if not provided)
     * @returns {number|null} Expected value or null if unavailable
     */
    calculateSingleContainer(containerHrid, initData = null) {
        const result = this.calculateContainerValue(containerHrid, initData);
        return result.expectedValue;
    }

    /**
     * Calculate a container's expected value, and say how much of it is missing.
     *
     * A drop nobody can price is skipped, which makes the total a lower bound rather
     * than an estimate. That distinction used to be counted into a local nobody read
     * (`_missingDataCount`) and then thrown away, so a chest whose best item had no
     * market data reported a confident small number instead of "at least this much".
     *
     * @param {string} containerHrid - Container item HRID
     * @param {Object} [initData] - Cached game data (optional, will fetch if not provided)
     * @param {{path: Set<string>, truncated: boolean}} [context] - Recursion state for nested containers
     * @returns {{expectedValue: number|null, missingCount: number, isPartial: boolean}}
     */
    calculateContainerValue(containerHrid, initData = null, context = null) {
        const unavailable = { expectedValue: null, missingCount: 0, isPartial: false };
        const ctx = context || { path: new Set(), truncated: false };

        // Use cached data if provided, otherwise fetch
        if (!initData) {
            initData = dataManager.getInitClientData();
        }
        if (!initData || !initData.openableLootDropMap) {
            return unavailable;
        }

        // Get drop table for this container
        const dropTable = initData.openableLootDropMap[containerHrid];
        if (!dropTable || dropTable.length === 0) {
            return unavailable;
        }

        let totalExpectedValue = 0;
        let missingCount = 0;

        // Calculate expected value for each drop
        for (const drop of dropTable) {
            const itemHrid = drop.itemHrid;
            const dropRate = drop.dropRate || 0;
            const minCount = drop.minCount || 0;
            const maxCount = drop.maxCount || 0;

            // Skip invalid drops
            if (dropRate <= 0 || (minCount === 0 && maxCount === 0)) {
                continue;
            }

            // Calculate average drop count
            const avgCount = (minCount + maxCount) / 2;

            // Get price for this drop.
            //
            // The truncation flag is saved and restored around each drop: it says "a
            // cycle was cut inside THIS branch", and one self-cyclic sibling used to
            // leave it raised for the rest of the traversal, so every later container
            // refused to cache and the whole pass recomputed from scratch. The parent
            // still inherits it afterwards — a container none of whose branches could
            // be fully valued must not cache either.
            const outerTruncated = ctx.truncated;
            ctx.truncated = false;
            const resolved = this.resolveSellSideValue(itemHrid, 0, ctx);
            ctx.truncated = outerTruncated || ctx.truncated;
            const price = resolved?.value ?? null;

            if (price === null) {
                missingCount++;
                continue; // Skip drops with missing data — the total becomes a lower bound
            }

            // A nested container carries its own unpriceable drops up: a chest holding a
            // crate with an unpriceable drop is itself a lower bound, not a firm figure
            missingCount += resolved.missingCount || 0;

            // Check if item is tradeable (for tax calculation)
            const itemDetails = dataManager.getItemDetails(itemHrid);
            const canBeSold = itemDetails?.isTradable !== false;

            // Special case: Coin never has market tax (it's currency, not a market item)
            const isCoin = itemHrid === this.COIN_HRID;

            const dropValue = isCoin
                ? avgCount * dropRate * price // No tax for coins
                : canBeSold
                  ? calculatePriceAfterTax(avgCount * dropRate * price, this.MARKET_TAX)
                  : avgCount * dropRate * price;
            totalExpectedValue += dropValue;
        }

        // Cache the result for future lookups — but not when the cycle guard cut a
        // branch off this pass, because the figure is then an artefact of where the
        // recursion started rather than what the container is worth
        if (!ctx.truncated) {
            // The value cache stays gated on a positive figure — a zero is indistinguishable
            // from "not costed yet" to the readers that check `has()`. The missing count is
            // not: a container whose drops are ALL unpriceable is worth 0 and has N missing,
            // and skipping the count left an outer container reading 0 through
            // countUnpricedDrops and calling itself confident.
            if (totalExpectedValue > 0) {
                this.containerCache.set(containerHrid, totalExpectedValue);
            }
            this.containerMissingCounts.set(containerHrid, missingCount);
        }

        return { expectedValue: totalExpectedValue, missingCount, isPartial: missingCount > 0 };
    }

    /**
     * Resolve a sell-side economic value for an item, applying the same special-case chain
     * (Coin, Cowbell, dungeon tokens, cached container EV, ordinary market item) that drop
     * valuation has always used, plus metadata saying where the number came from and whether
     * market tax still has to be applied. Tax is left to the caller because the special cases
     * are already net figures and would otherwise be taxed twice.
     * @param {string} itemHrid - Item HRID
     * @param {number} [enhancementLevel=0] - Enhancement level (ignored for special currencies)
     * @param {{path: Set<string>, truncated: boolean}} [context] - Recursion state for nested containers
     * @returns {{value: number, source: string, needsTax: boolean, missingCount?: number}|null} Resolved value or null
     */
    resolveSellSideValue(itemHrid, enhancementLevel = 0, context = null) {
        // Special case: Coin (face value = 1, never taxed)
        if (itemHrid === this.COIN_HRID) {
            return { value: 1, source: 'coin', needsTax: false };
        }

        // Special case: Cowbell (use bag price ÷ 10, with 18% tax)
        if (itemHrid === this.COWBELL_HRID) {
            if (!config.getSetting('expectedValue_includeCowbells')) {
                return { value: 0, source: 'cowbell', needsTax: false };
            }
            // Get Cowbell Bag price using profit context (sell side - you're selling the bag)
            const bagValue = getItemPrice(this.COWBELL_BAG_HRID, { context: 'profit', side: 'sell' }) || 0;

            if (bagValue > 0) {
                // Apply 18% market tax (Cowbell Bag only), then divide by 10
                return { value: calculatePriceAfterTax(bagValue, 0.18) / 10, source: 'cowbell', needsTax: false };
            }
            return null; // No bag price available
        }

        // Special case: Dungeon Tokens (calculate value from shop items)
        if (this.DUNGEON_TOKENS.includes(itemHrid)) {
            const value = calculateDungeonTokenValue(
                itemHrid,
                'profitCalc_pricingMode',
                'expectedValue_respectPricingMode'
            );
            return value !== null ? { value, source: 'dungeonToken', needsTax: false } : null;
        }

        // Nested container: worth its contents, computed on demand rather than read out of
        // whatever the cache happened to hold when this drop table's turn came round
        const nested = this.resolveContainerValue(itemHrid, context);
        if (nested !== null) {
            // Already tax-adjusted per drop inside
            return {
                value: nested.value,
                source: 'expectedValue',
                needsTax: false,
                missingCount: nested.missingCount,
            };
        }

        // Regular market item - get price based on pricing mode (sell side - you're selling drops)
        const dropPrice = getItemPrice(itemHrid, { enhancementLevel, context: 'profit', side: 'sell' });
        if (!(dropPrice > 0)) return null;
        const hasOverride = getCustomPrice(itemHrid, enhancementLevel, 'sell') !== null;
        return { value: dropPrice, source: hasOverride ? 'custom' : 'market', needsTax: true };
    }

    /**
     * Resolve a buy-side economic value — the mirror of resolveSellSideValue, for something
     * being consumed or lost rather than gained. Never taxed, because nothing is being sold.
     * An openable container is valued at its ordinary buy price here, not its expected value:
     * consuming one means losing (or re-buying) the container, not opening it.
     * @param {string} itemHrid - Item HRID
     * @param {number} [enhancementLevel=0] - Enhancement level (ignored for special currencies)
     * @returns {{value: number, source: string}|null} Resolved value or null
     */
    resolveBuySideValue(itemHrid, enhancementLevel = 0) {
        if (itemHrid === this.COIN_HRID) {
            return { value: 1, source: 'coin' };
        }

        if (itemHrid === this.COWBELL_HRID) {
            if (!config.getSetting('expectedValue_includeCowbells')) {
                return { value: 0, source: 'cowbell' };
            }
            const bagValue = getItemPrice(this.COWBELL_BAG_HRID, { context: 'profit', side: 'buy' }) || 0;
            return bagValue > 0 ? { value: bagValue / 10, source: 'cowbell' } : null;
        }

        if (this.DUNGEON_TOKENS.includes(itemHrid)) {
            const value = calculateDungeonTokenValue(
                itemHrid,
                'profitCalc_pricingMode',
                'expectedValue_respectPricingMode'
            );
            return value !== null ? { value, source: 'dungeonToken' } : null;
        }

        // Ordinary market item (including a consumed openable, valued as a purchase rather than
        // an opening) - buy side, because this is what re-acquiring it costs
        const buyPrice = getItemPrice(itemHrid, { enhancementLevel, context: 'profit', side: 'buy' });
        if (!(buyPrice > 0)) return null;
        const hasOverride = getCustomPrice(itemHrid, enhancementLevel, 'buy') !== null;
        return { value: buyPrice, source: hasOverride ? 'custom' : 'market' };
    }

    /**
     * Get price for a drop item
     * Handles special cases (Coin, Cowbell, Dungeon Tokens, nested containers)
     * @param {string} itemHrid - Item HRID
     * @param {{path: Set<string>, truncated: boolean}} [context] - Recursion state for nested containers
     * @returns {number|null} Price or null if unavailable
     */
    getDropPrice(itemHrid, context = null) {
        return this.resolveSellSideValue(itemHrid, 0, context)?.value ?? null;
    }

    /**
     * What a nested container inside a drop table is worth.
     *
     * A container's expected value used to be read only out of `containerCache`, which
     * meant a chest containing a crate was worth the crate's contents if the crate had
     * already been costed this pass and worth its bare market price (or nothing) if it
     * had not — the same chest, two answers, decided by iteration order. Computing it on
     * demand makes the answer the same whoever asks first.
     *
     * `context.path` is the cycle guard: a container that (directly or through a chain)
     * contains itself would otherwise recurse forever. A container already on the path
     * contributes nothing rather than looping, and marks the pass truncated so nothing
     * computed under it is cached.
     *
     * @param {string} itemHrid - Possibly a container
     * @param {{path: Set<string>, truncated: boolean}|null} context - Recursion state
     * @returns {{value: number, missingCount: number}|null} Value and unpriced-drop count, or null when this is not a container
     */
    resolveContainerValue(itemHrid, context = null) {
        if (this.containerCache.has(itemHrid)) {
            return {
                value: this.containerCache.get(itemHrid),
                missingCount: this.containerMissingCounts.get(itemHrid) || 0,
            };
        }

        const initData = dataManager.getInitClientData();
        const dropTable = initData?.openableLootDropMap?.[itemHrid];
        if (!dropTable || dropTable.length === 0) {
            return null;
        }

        const ctx = context || { path: new Set(), truncated: false };
        if (ctx.path.has(itemHrid)) {
            ctx.truncated = true;
            return null; // Already being valued further up this chain
        }
        ctx.path.add(itemHrid);
        try {
            const result = this.calculateContainerValue(itemHrid, initData, ctx);
            if (result.expectedValue === null) return null;
            return { value: result.expectedValue, missingCount: result.missingCount };
        } finally {
            ctx.path.delete(itemHrid);
        }
    }

    /**
     * Calculate expected value for an openable container
     * @param {string} itemHrid - Container item HRID
     * @returns {Object|null} EV data or null
     */
    calculateExpectedValue(itemHrid) {
        if (!this.isInitialized) {
            console.warn('[ExpectedValueCalculator] Not initialized');
            return null;
        }

        // Get item details
        const itemDetails = dataManager.getItemDetails(itemHrid);
        if (!itemDetails) {
            return null;
        }

        // Verify this is an openable container
        if (!itemDetails.isOpenable) {
            return null; // Not an openable container
        }

        // Get detailed drop breakdown (calculates with fresh market prices)
        const drops = this.getDropBreakdown(itemHrid);

        // Calculate total expected value from fresh drop data
        const expectedReturn = drops.reduce((sum, drop) => sum + drop.expectedValue, 0);

        // Drops nobody can price contribute nothing, so the total is a floor, not an estimate.
        // Callers that render it are expected to say so — see formatExpectedValue.
        // Unpriced drops here, plus anything unpriceable inside a nested container
        const missingCount = drops.reduce((n, drop) => n + (drop.hasPriceData ? 0 : 1) + (drop.missingCount || 0), 0);

        return {
            itemName: itemDetails.name,
            itemHrid,
            expectedValue: expectedReturn,
            missingCount,
            isPartial: missingCount > 0,
            drops,
        };
    }

    /**
     * Get cached expected value for a container (for use by other modules)
     * @param {string} itemHrid - Container item HRID
     * @returns {number|null} Cached EV or null
     */
    getCachedValue(itemHrid) {
        return this.containerCache.get(itemHrid) || null;
    }

    /**
     * Get detailed drop breakdown for display
     * @param {string} containerHrid - Container HRID
     * @returns {Array} Array of drop objects
     */
    getDropBreakdown(containerHrid) {
        const initData = dataManager.getInitClientData();
        if (!initData || !initData.openableLootDropMap) {
            return [];
        }

        const dropTable = initData.openableLootDropMap[containerHrid];
        if (!dropTable) {
            return [];
        }

        const drops = [];

        for (const drop of dropTable) {
            const itemHrid = drop.itemHrid;
            const dropRate = drop.dropRate || 0;
            const minCount = drop.minCount || 0;
            const maxCount = drop.maxCount || 0;

            if (dropRate <= 0) {
                continue;
            }

            // Get item details
            const itemDetails = dataManager.getItemDetails(itemHrid);
            if (!itemDetails) {
                continue;
            }

            // Calculate average count
            const avgCount = (minCount + maxCount) / 2;

            // Get price, keeping the count of anything unpriceable inside a
            // nested container - a crate with three unpriced drops prices, but
            // only partially, and the breakdown has to say so
            const resolved = this.resolveSellSideValue(itemHrid, 0);
            const price = resolved?.value ?? null;
            const nestedMissing = resolved?.missingCount || 0;

            // Calculate expected value for this drop
            const itemCanBeSold = itemDetails.isTradable !== false;

            // Special case: Coin never has market tax (it's currency, not a market item)
            const isCoin = itemHrid === this.COIN_HRID;

            const dropValue =
                price !== null
                    ? isCoin
                        ? avgCount * dropRate * price // No tax for coins
                        : itemCanBeSold
                          ? calculatePriceAfterTax(avgCount * dropRate * price, this.MARKET_TAX)
                          : avgCount * dropRate * price
                    : 0;

            drops.push({
                itemHrid,
                itemName: itemDetails.name,
                dropRate,
                avgCount,
                priceEach: price || 0,
                expectedValue: dropValue,
                hasPriceData: price !== null,
                missingCount: nestedMissing,
            });
        }

        // Sort by expected value (highest first)
        drops.sort((a, b) => b.expectedValue - a.expectedValue);

        return drops;
    }

    /**
     * How to say an expected value out loud, given that some of it may be unpriceable.
     *
     * A partial total is a floor: "at least this much, and these many drops could not be
     * priced". Rendering it as a plain figure claims a precision the data does not have.
     *
     * @param {{expectedValue: number, missingCount: number, isPartial: boolean}|null} evData
     * @param {Function} format - Number formatter, e.g. formatKMB
     * @returns {string} Display string, or '--' when there is nothing to show
     */
    formatExpectedValue(evData, format = (n) => String(Math.round(n))) {
        if (!evData || evData.expectedValue === null || evData.expectedValue === undefined) {
            return '--';
        }

        const figure = format(evData.expectedValue);
        if (!evData.isPartial) {
            return figure;
        }

        const drops = evData.missingCount === 1 ? 'drop' : 'drops';
        return `\u2265 ${figure} (${evData.missingCount} ${drops} unpriced)`;
    }

    /**
     * Invalidate cache (call when market data refreshes)
     */
    invalidateCache() {
        this.containerCache.clear();
        this.containerMissingCounts.clear();
        this.isInitialized = false;

        // Re-initialize if data is available
        if (dataManager.getInitClientData() && marketAPI.isLoaded()) {
            this.initialize();
        }
    }

    /**
     * Cleanup calculator state and handlers
     */
    cleanup() {
        if (this.retryHandler) {
            dataManager.off('character_initialized', this.retryHandler);
            this.retryHandler = null;
        }

        this.containerCache.clear();
        this.containerMissingCounts.clear();
        this.isInitialized = false;

        // The pool recreates itself on the next batch; idle workers should not
        // outlive the feature that spawned them
        terminateEVWorkerPool();
    }

    disable() {
        try {
            this.cleanup();
        } catch (error) {
            console.error('[Expected Value Calculator] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }
}

const expectedValueCalculator = new ExpectedValueCalculator();

export default expectedValueCalculator;
