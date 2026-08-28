/**
 * Philosopher's Stone Transmutation Calculator
 *
 * Calculates expected value and ROI for transmuting items into Philosopher's Stones.
 * Shows a sortable table of all items that can transmute into philos with live market data.
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import alchemyProfitCalculator from './alchemy-profit-calculator.js';
import { formatLargeNumber, formatPercentage, timeReadable } from '../../utils/formatters.js';
import { getEnhancementMultiplier } from '../../utils/enhancement-multipliers.js';
import { calculateActionStats } from '../../utils/action-calculator.js';
import { SECONDS_PER_HOUR } from '../../utils/profit-constants.js';
import { getAlchemyCoinCost } from '../../utils/alchemy-fees.js';
import {
    calculateActionsPerHour,
    calculatePriceAfterTax,
    calculateTeaCostsPerHour,
    resolveItemPrice,
} from '../../utils/profit-helpers.js';
import { createCuratedRecord, mergeMaps } from '../../utils/persisted-record.js';
import { settingsUI as sharedSettingsUI } from '../../utils/bundle-bridge.js';
import { navigateToMarketplace } from '../../utils/marketplace-tabs.js';

const PHILO_HRID = '/items/philosophers_stone';
const PRIME_CATALYST_HRID = '/items/prime_catalyst';
const PRIME_CATALYST_ADDITIVE_BONUS = 0.25; // 25% additive boost
const TRANSMUTE_ACTION_HRID = '/actions/alchemy/transmute';
const CATALYTIC_TEA_HRID = '/items/catalytic_tea';
const CATALYTIC_TEA_BUFF_TYPE = '/buff_types/alchemy_success';
// Only used when actionDetailMap is unavailable (offline/no init data) — the
// real time comes from actionDetails.baseTimeCost, scaled by speed/efficiency.
const FALLBACK_ACTION_TIME_SECONDS = 20;
// Under-level transmute penalty: perLevel × (alchemyLevel − itemLevel).
// Matches alchemy-profit-calculator.js.
const LEVEL_PENALTY_NUMERATOR = 0.9;

/**
 * Which side of the book each pricing mode buys and sells at.
 * Mirrors the profitCalc_pricingMode options in settings-schema.js.
 */
const PRICING_MODES = {
    conservative: { buy: 'ask', sell: 'bid', label: 'Instant buy / Instant sell' },
    hybrid: { buy: 'ask', sell: 'ask', label: 'Instant buy / Patient sell' },
    optimistic: { buy: 'bid', sell: 'ask', label: 'Patient buy / Patient sell' },
    patientBuy: { buy: 'bid', sell: 'bid', label: 'Patient buy / Instant sell' },
};

// Philo gamba is a long-tail lottery: rows are only worth acting on if they
// still pay when every stone is dumped into a standing bid, so this table
// starts conservative even when the global profit setting is more generous.
const DEFAULT_PRICING_MODE = 'conservative';
const GLOBAL_PRICING_MODE = 'global';

/** The key the calculator's settings live under, per character */
const SETTINGS_KEY = 'philoCalculatorSettings';

/**
 * Fold stored settings under the ones in memory — only consulted before this
 * character's settings have been read back (see `createCuratedRecord`): the
 * toggles key by key with memory winning, and the per-item cost overrides
 * likewise entry by entry, so a cost typed in before the read landed is kept
 * and none stored is dropped.
 * @param {Object} stored - The settings as read back
 * @param {Object} memory - The settings as held
 * @returns {Object} The merged settings
 */
function mergeSettings(stored, memory) {
    const theirs = stored && typeof stored === 'object' ? stored : {};
    const ours = memory && typeof memory === 'object' ? memory : {};
    const maps = mergeMaps();
    return { ...maps(theirs, ours), itemCostOverrides: maps(theirs.itemCostOverrides, ours.itemCostOverrides) };
}

/**
 * The settings as stored, per character. A curated record because the
 * per-item cost overrides are typed in by hand: a read that cannot be made
 * leaves the values in hand rather than blanking them, no write goes out over
 * a store that could not be read first, and once this character's settings
 * have been read back a cleared override stays cleared.
 */
const settingsRecord = createCuratedRecord({
    base: SETTINGS_KEY,
    store: 'settings',
    empty: () => ({}),
    merge: mergeSettings,
    migrate: 'adopt',
    immediate: true,
    label: 'PhiloCalculator',
});

/** Whose settings the record holds, so a switch never shows one character the other's */
let settingsOwner = null;

class PhiloCalculator {
    constructor() {
        this.isInitialized = false;
        this.modal = null;
        this.sortColumn = 'cost';
        this.sortDirection = 'desc';

        // User-editable inputs
        this.philoPrice = 0;
        this.philoBid = 0;
        this.philoAsk = 0;
        this.catalystPrice = 0;
        this.useCatalyst = true;
        this.useCatalyticTea = false;
        this.catalyticTeaRatioBoost = 0;
        this.drinkConcentrationLevel = null; // 0-20; null = not saved yet (auto-detect from gear)
        this.hideNegativeProfitItems = true;
        this.filterText = '';
        this.pricingMode = DEFAULT_PRICING_MODE;
        // Per-item manual cost basis, hrid → coins (the buy-side twin of the
        // philo price input)
        this.itemCostOverrides = {};
        this._manualPhiloPrice = false;
        this._manualCatalystPrice = false;
        this._escHandler = null;

        // Cached row data
        this.rows = [];
        // Lazy map of refined-item hrid → producing action (for craft-cost pricing)
        this._refineActionByOutput = null;
        // Per-pass caches, cleared on every recalculation
        this._actionStatsCache = new Map();
        this._bonusRevenueCache = new Map();
    }

    /**
     * Initialize the feature
     */
    initialize() {
        if (this.isInitialized) {
            return;
        }

        if (!config.getSetting('market_showPhiloCalculator')) {
            return;
        }

        this.isInitialized = true;
        this.addSettingsButton();
    }

    /**
     * Disable / cleanup the feature
     */
    disable() {
        try {
            this.closeModal();
            this.isInitialized = false;
        } catch (error) {
            console.error('[Philo Calculator] Disable failed part-way:', error);
        } finally {
            this.isInitialized = false;
        }
    }

    /**
     * Close the modal and remove its document-level listeners
     */
    closeModal() {
        if (this.modal) {
            this.modal.remove();
            this.modal = null;
        }
        if (this._escHandler) {
            document.removeEventListener('keydown', this._escHandler);
            this._escHandler = null;
        }
    }

    /**
     * Add "Philo Gamba" button to settings panel
     */
    addSettingsButton() {
        const ensureButtonExists = () => {
            const settingsPanel = document.querySelector('[class*="SettingsPanel"]');
            if (!settingsPanel) return;

            if (settingsPanel.querySelector('.mwi-philo-calc-button')) {
                return;
            }

            const button = document.createElement('button');
            button.className = 'mwi-philo-calc-button';
            button.textContent = 'Philo Gamba';
            button.style.cssText = `
                margin: 10px;
                padding: 8px 16px;
                background: #4a90e2;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 14px;
            `;

            button.addEventListener('mouseenter', () => {
                button.style.background = '#357abd';
            });

            button.addEventListener('mouseleave', () => {
                button.style.background = '#4a90e2';
            });

            button.addEventListener('click', () => {
                this.openModal();
            });

            // Insert after the market history button if it exists, otherwise at top
            const historyButton = settingsPanel.querySelector('.mwi-market-history-button');
            if (historyButton) {
                historyButton.after(button);
            } else {
                settingsPanel.insertBefore(button, settingsPanel.firstChild);
            }
        };

        const settingsUI = sharedSettingsUI();
        if (settingsUI && typeof settingsUI.onSettingsPanelAppear === 'function') {
            settingsUI.onSettingsPanelAppear(ensureButtonExists);
        }

        ensureButtonExists();
    }

    /**
     * Get item name from game data
     * @param {string} itemHrid - Item HRID
     * @returns {string} Item name
     */
    getItemName(itemHrid) {
        const initData = dataManager.getInitClientData();
        const itemData = initData?.itemDetailMap?.[itemHrid];
        return itemData?.name || itemHrid.replace('/items/', '').replaceAll('_', ' ');
    }

    /**
     * Resolve the pricing mode this table is currently calculating with.
     * 'global' defers to the shared profitCalc_pricingMode setting; anything
     * unrecognised falls back to the conservative default.
     * @returns {string} A key of PRICING_MODES
     */
    resolvePricingMode() {
        if (this.pricingMode === GLOBAL_PRICING_MODE) {
            const globalMode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
            return PRICING_MODES[globalMode] ? globalMode : 'hybrid';
        }
        return PRICING_MODES[this.pricingMode] ? this.pricingMode : DEFAULT_PRICING_MODE;
    }

    /**
     * Which book side ('ask' or 'bid') the active pricing mode uses
     * @param {string} side - 'buy' or 'sell'
     * @returns {string} 'ask' or 'bid'
     */
    getPriceType(side) {
        return PRICING_MODES[this.resolvePricingMode()][side];
    }

    /**
     * Philo sale price for a given book side. A manually entered price wins
     * outright — the user has told us what they will actually get.
     * @param {string} [sellType] - 'bid' or 'ask'; defaults to the active mode
     * @returns {number} Price before market tax
     */
    getPhiloPrice(sellType) {
        if (this._manualPhiloPrice) {
            return this.philoPrice || 0;
        }
        const type = sellType || this.getPriceType('sell');
        return (type === 'bid' ? this.philoBid : this.philoAsk) || 0;
    }

    /**
     * Load default prices from market data (respecting the active pricing mode)
     */
    loadDefaultPrices() {
        const philoPriceData = marketAPI.getPrice(PHILO_HRID, 0);
        this.philoBid = philoPriceData?.bid > 0 ? philoPriceData.bid : 0;
        this.philoAsk = philoPriceData?.ask > 0 ? philoPriceData.ask : 0;
        if (!this._manualPhiloPrice) {
            this.philoPrice = this.getPhiloPrice();
        }

        if (!this._manualCatalystPrice) {
            const catalystPriceData = marketAPI.getPrice(PRIME_CATALYST_HRID, 0);
            const buyType = this.getPriceType('buy');
            const preferred = catalystPriceData?.[buyType];
            const other = catalystPriceData?.[buyType === 'ask' ? 'bid' : 'ask'];
            this.catalystPrice = preferred > 0 ? preferred : other > 0 ? other : 0;
        }
    }

    /**
     * Calculate catalytic tea base bonus from game data (item definition)
     * @returns {number} Base ratioBoost from item definition
     */
    calculateCatalyticTeaRatioBoost() {
        try {
            const gameData = dataManager.getInitClientData();
            if (!gameData?.itemDetailMap) return 0;

            const teaItem = gameData.itemDetailMap['/items/catalytic_tea'];
            if (!teaItem?.consumableDetail?.buffs) return 0;

            // Find alchemy success buff
            for (const buff of teaItem.consumableDetail.buffs) {
                if (buff.typeHrid === CATALYTIC_TEA_BUFF_TYPE) {
                    return buff.ratioBoost || 0;
                }
            }

            return 0;
        } catch (error) {
            console.error('[PhiloCalculator] Failed to calculate catalytic tea ratio boost:', error);
            return 0;
        }
    }

    /**
     * What would be written: every setting the calculator keeps.
     * @returns {Object} The settings as held
     */
    settingsSnapshot() {
        return {
            useCatalyst: this.useCatalyst,
            useCatalyticTea: this.useCatalyticTea,
            drinkConcentrationLevel: this.drinkConcentrationLevel,
            hideNegativeProfitItems: this.hideNegativeProfitItems,
            filterText: this.filterText,
            pricingMode: this.pricingMode,
            itemCostOverrides: this.itemCostOverrides,
        };
    }

    /**
     * Load settings from storage.
     *
     * Read every time the calculator is opened, so the key is the one
     * belonging to whoever is logged in now. A read that cannot be made leaves
     * the values in hand — unless they are another character's, which must
     * not stand in for this one's nor be folded into their record.
     */
    async loadSettings() {
        try {
            const who = dataManager.getCurrentCharacterId?.() || null;
            if (who !== settingsOwner) {
                settingsRecord.reset();
                settingsOwner = who;
            }
            const previous = settingsRecord.get();
            settingsRecord.set({});
            const readable = await settingsRecord.load();
            if (!readable) settingsRecord.set(previous);
            const saved = readable ? settingsRecord.get() : null;
            if (saved && Object.keys(saved).length > 0) {
                this.useCatalyst = saved.useCatalyst !== false;
                this.useCatalyticTea = saved.useCatalyticTea || false;
                // ?? not || — an explicitly saved +0 must not fall back to auto-detect
                this.drinkConcentrationLevel = saved.drinkConcentrationLevel ?? null;
                this.hideNegativeProfitItems = saved.hideNegativeProfitItems !== false;
                this.filterText = saved.filterText || '';
                const savedMode = saved.pricingMode;
                this.pricingMode =
                    savedMode === GLOBAL_PRICING_MODE || PRICING_MODES[savedMode] ? savedMode : DEFAULT_PRICING_MODE;
                this.itemCostOverrides =
                    saved.itemCostOverrides && typeof saved.itemCostOverrides === 'object'
                        ? { ...saved.itemCostOverrides }
                        : {};
            }
        } catch (error) {
            console.error('[PhiloCalculator] Failed to load settings:', error);
        }
    }

    /**
     * Save settings to storage
     */
    async saveSettings() {
        try {
            settingsRecord.set(this.settingsSnapshot());
            await settingsRecord.save();
        } catch (error) {
            console.error('[PhiloCalculator] Failed to save settings:', error);
        }
    }

    /**
     * Get drink concentration for a given enhancement level
     * @param {number} enhancementLevel - Enhancement level (0-20)
     * @returns {number} Drink concentration as decimal (e.g., 0.1032 for 10.32%)
     */
    getDrinkConcentrationForLevel(enhancementLevel) {
        try {
            const gameData = dataManager.getInitClientData();
            const equipment = dataManager.getEquipment();
            if (!equipment || !gameData?.itemDetailMap) return 0;

            let totalConcentration = 0;
            const baseConcentrationByLevel = new Map();

            // Scan equipment for drink concentration items and their base values
            for (const [_slotHrid, equippedItem] of equipment) {
                const itemDetails = gameData.itemDetailMap[equippedItem.itemHrid];
                if (!itemDetails?.equipmentDetail?.noncombatStats?.drinkConcentration) continue;

                const baseConcentration = itemDetails.equipmentDetail.noncombatStats.drinkConcentration;
                baseConcentrationByLevel.set(equippedItem.itemHrid, baseConcentration);
            }

            // If we have drink concentration items, apply the requested enhancement level
            for (const [itemHrid, baseConcentration] of baseConcentrationByLevel) {
                const itemDetails = gameData.itemDetailMap[itemHrid];
                const multiplier = getEnhancementMultiplier(itemDetails, enhancementLevel);
                totalConcentration += baseConcentration * multiplier;
            }

            return totalConcentration;
        } catch (error) {
            console.error('[PhiloCalculator] Failed to get drink concentration:', error);
            return 0;
        }
    }

    /**
     * Resolve the crafting cost of a refined item: the market cost of the
     * refinement materials its upgrade action consumes, plus the acquisition
     * cost of the base item being refined (market ask → shop → production
     * cost). Bases with no resolvable price (skilling capes, which the player
     * already owns) contribute nothing.
     * @param {string} itemHrid - Refined item HRID
     * @returns {number|null} Craft cost, or null when not resolvable
     */
    getRefinementCraftCost(itemHrid) {
        if (!this._refineActionByOutput) {
            this._refineActionByOutput = new Map();
            const actions = dataManager.getInitClientData()?.actionDetailMap || {};
            for (const action of Object.values(actions)) {
                for (const output of action.outputItems || []) {
                    if (output.itemHrid?.endsWith('_refined') && !this._refineActionByOutput.has(output.itemHrid)) {
                        this._refineActionByOutput.set(output.itemHrid, action);
                    }
                }
            }
        }

        const action = this._refineActionByOutput.get(itemHrid);
        if (!action) return null;

        let cost = 0;
        for (const input of action.inputItems || []) {
            const count = input.count || 0;
            if (input.itemHrid === '/items/coin') {
                cost += count;
                continue;
            }
            const priceData = marketAPI.getPrice(input.itemHrid, 0);
            const price = priceData?.ask > 0 ? priceData.ask : priceData?.bid > 0 ? priceData.bid : null;
            if (price === null) return null;
            cost += price * count;
        }

        if (action.upgradeItemHrid) {
            const base = resolveItemPrice(action.upgradeItemHrid, { side: 'buy', mode: 'ask', context: 'profit' });
            if (!base.missing && base.price > 0) {
                cost += base.price;
            }
        }

        return cost > 0 ? cost : null;
    }

    /**
     * Scan itemDetailMap for all items that can transmute into Philosopher's Stone
     * @returns {Array} Array of { itemHrid, itemDetails } objects
     */
    findPhiloTransmuteItems() {
        const gameData = dataManager.getInitClientData();
        if (!gameData?.itemDetailMap) return [];

        const results = [];

        for (const [itemHrid, itemDetails] of Object.entries(gameData.itemDetailMap)) {
            const alchemy = itemDetails?.alchemyDetail;
            if (!alchemy?.transmuteDropTable || !alchemy.transmuteSuccessRate) continue;

            const hasPhilo = alchemy.transmuteDropTable.some((drop) => drop.itemHrid === PHILO_HRID);
            if (hasPhilo) {
                results.push({ itemHrid, itemDetails });
            }
        }

        return results;
    }

    /**
     * Under-level transmute success penalty.
     * perLevel = 0.9 / itemLevel, applied only when below the item's level.
     * @param {number} itemLevel - Item level being transmuted
     * @returns {number} Negative penalty term, or 0 when at/above level
     */
    getLevelPenalty(itemLevel) {
        const level = itemLevel || 1;
        const skills = dataManager.getSkills();
        const alchemySkill = skills?.find((s) => s.skillHrid === '/skills/alchemy');
        const alchemyLevel = alchemySkill?.level || 1;
        return alchemyLevel < level ? (LEVEL_PENALTY_NUMERATOR / level) * (alchemyLevel - level) : 0;
    }

    /**
     * Action time and efficiency for transmuting an item of a given level.
     * Alchemy scales efficiency off the item's level rather than the action's
     * own requirement, so results are cached per item level.
     * @param {number} itemLevel - Item level being transmuted
     * @returns {{actionTime: number, efficiency: number, estimated: boolean}} Action stats
     */
    getActionStats(itemLevel) {
        const level = itemLevel || 1;
        if (this._actionStatsCache.has(level)) {
            return this._actionStatsCache.get(level);
        }

        let stats = { actionTime: FALLBACK_ACTION_TIME_SECONDS, efficiency: 0, estimated: true };
        try {
            const gameData = dataManager.getInitClientData();
            const actionDetails = gameData?.actionDetailMap?.[TRANSMUTE_ACTION_HRID];
            if (actionDetails?.baseTimeCost) {
                const actionStats = calculateActionStats(actionDetails, {
                    skills: dataManager.getSkills(),
                    equipment: dataManager.getEquipment(),
                    itemDetailMap: gameData.itemDetailMap,
                    includeCommunityBuff: true,
                    levelRequirementOverride: level,
                });
                if (actionStats?.actionTime > 0) {
                    stats = {
                        actionTime: actionStats.actionTime,
                        efficiency: (actionStats.totalEfficiency || 0) / 100,
                        estimated: false,
                    };
                }
            }
        } catch (error) {
            console.error('[PhiloCalculator] Failed to calculate action stats:', error);
        }

        this._actionStatsCache.set(level, stats);
        return stats;
    }

    /**
     * Catalytic tea cost charged against a single action. Teas are consumed on
     * a clock, not per action, so the hourly burn is divided by the action rate
     * the same way calculateTeaCostsPerHour is consumed elsewhere.
     * @param {number} actionsPerHour - Effective actions per hour (with efficiency)
     * @returns {number} Coins per action
     */
    getTeaCostPerAction(actionsPerHour) {
        if (!this.useCatalyticTea || !(actionsPerHour > 0)) {
            return 0;
        }

        try {
            const gameData = dataManager.getInitClientData();
            const buyType = this.getPriceType('buy');
            const teaCosts = calculateTeaCostsPerHour({
                drinkSlots: [{ itemHrid: CATALYTIC_TEA_HRID }],
                drinkConcentration: this.getDrinkConcentrationForLevel(this.drinkConcentrationLevel),
                itemDetailMap: gameData?.itemDetailMap || {},
                getItemPrice: (hrid) => {
                    const resolved = resolveItemPrice(hrid, { side: 'buy', mode: buyType, context: 'profit' });
                    return resolved.missing ? null : resolved.price;
                },
            });
            return teaCosts.totalCostPerHour / actionsPerHour;
        } catch (error) {
            console.error('[PhiloCalculator] Failed to calculate tea cost:', error);
            return 0;
        }
    }

    /**
     * Alchemy essence and rare (artisan's crate) revenue for one transmute
     * attempt. The rates and prices come from the canonical alchemy calculator
     * rather than being re-derived here; a row whose input has no market data
     * there simply contributes no bonus revenue.
     * @param {string} itemHrid - Item being transmuted
     * @returns {number} Coins per action, after market tax
     */
    getBonusRevenuePerAction(itemHrid) {
        if (this._bonusRevenueCache.has(itemHrid)) {
            return this._bonusRevenueCache.get(itemHrid);
        }

        let total = 0;
        try {
            const transmute = alchemyProfitCalculator.calculateTransmuteProfit(itemHrid);
            for (const drop of transmute?.dropRevenues || []) {
                if (!drop?.isEssence && !drop?.isRare) continue;
                // Taxed, unlike the canonical calculator: essences and crates
                // are sold like any other drop, and this table taxes every
                // sold drop uniformly.
                total += calculatePriceAfterTax(drop.revenuePerAttempt || 0);
            }
        } catch (error) {
            console.error('[PhiloCalculator] Failed to resolve bonus drop revenue:', error);
            total = 0;
        }

        this._bonusRevenueCache.set(itemHrid, total);
        return total;
    }

    /**
     * Resolve what one input item costs to acquire, and what a returned copy of
     * it is worth back.
     *
     * The book side follows the active pricing mode. Refined items compare the
     * +0 quote against crafting (base item + refinement materials) and take the
     * cheaper path; capes are often listed only at low enhancement levels, so
     * those are scanned as a last resort — and a row priced that way is flagged,
     * because a +3 listing is not a cost basis a +0 transmute can be run at.
     * @param {string} itemHrid - Item HRID
     * @returns {{itemCost: number, selfReturnUnitValue: number, source: string, fallbackLevel: number}|null}
     */
    resolveItemCost(itemHrid) {
        const override = this.itemCostOverrides[itemHrid];
        if (typeof override === 'number' && override > 0) {
            return { itemCost: override, selfReturnUnitValue: override, source: 'override', fallbackLevel: 0 };
        }

        const buyType = this.getPriceType('buy');
        const quoteAt = (level) => {
            const priceData = marketAPI.getPrice(itemHrid, level);
            return priceData?.[buyType] > 0 ? priceData[buyType] : null;
        };

        let itemCost = quoteAt(0);
        let source = itemCost === null ? null : 'market';
        let fallbackLevel = 0;

        if (itemHrid.endsWith('_refined')) {
            const craftCost = this.getRefinementCraftCost(itemHrid);
            if (craftCost !== null && (itemCost === null || craftCost < itemCost)) {
                itemCost = craftCost;
                source = 'craft';
            }
            for (let level = 1; level <= 5 && itemCost === null; level++) {
                const quote = quoteAt(level);
                if (quote !== null) {
                    itemCost = quote;
                    source = 'enhanced';
                    fallbackLevel = level;
                }
            }
        }

        if (itemCost === null || itemCost === undefined) return null;

        // A self-return hands back a +0 item, never the enhanced listing the
        // cost basis had to borrow from, so credit it at the base item's own
        // quote (0 when the base has no market at all).
        let selfReturnUnitValue = itemCost;
        if (source === 'enhanced') {
            const base = marketAPI.getPrice(itemHrid, 0);
            selfReturnUnitValue = base?.bid > 0 ? base.bid : base?.ask > 0 ? base.ask : 0;
        }

        return { itemCost, selfReturnUnitValue, source, fallbackLevel };
    }

    /**
     * Calculate all columns for a single item
     * @param {string} itemHrid - Item HRID
     * @param {Object} itemDetails - Item detail object
     * @returns {Object|null} Row data or null if price unavailable
     */
    calculateRow(itemHrid, itemDetails) {
        const alchemy = itemDetails.alchemyDetail;
        const baseTransmuteRate = alchemy.transmuteSuccessRate;

        // Find philo drop rate
        const philoDrop = alchemy.transmuteDropTable.find((d) => d.itemHrid === PHILO_HRID);
        if (!philoDrop) return null;

        const itemLevel = itemDetails.itemLevel || 1;

        // Calculate additive bonuses. The under-level penalty is a negative
        // term in the same sum, matching the game's success formula:
        // min(1, base × (1 + catalyst + levelPenalty + tea))
        const levelPenalty = this.getLevelPenalty(itemLevel);
        let totalBonus = levelPenalty;

        // Catalytic tea bonus
        if (this.useCatalyticTea && this.catalyticTeaRatioBoost > 0) {
            const drinkConcentration = this.getDrinkConcentrationForLevel(this.drinkConcentrationLevel);
            totalBonus += this.catalyticTeaRatioBoost * (1 + drinkConcentration);
        }

        // Prime catalyst bonus (additive, not multiplicative)
        if (this.useCatalyst) {
            totalBonus += PRIME_CATALYST_ADDITIVE_BONUS;
        }

        const successRate = Math.max(0, Math.min(1.0, baseTransmuteRate * (1 + totalBonus)));
        if (!(successRate > 0)) return null; // Under-levelled into never succeeding
        const bulkMultiplier = alchemy.bulkMultiplier || 1;

        const philoDropRate = philoDrop.dropRate;
        const avgPhiloCount = (philoDrop.minCount + philoDrop.maxCount) / 2;
        // Philos actually produced per action — bulk transmutes roll the whole
        // drop table at bulk scale, the same scale the input cost is charged at
        const philosPerAction = successRate * philoDropRate * avgPhiloCount * bulkMultiplier;
        if (!(philosPerAction > 0)) return null;

        const costBasis = this.resolveItemCost(itemHrid);
        if (!costBasis) return null;
        const { itemCost, selfReturnUnitValue, source: costSource, fallbackLevel } = costBasis;

        // Catalyst cost per action (consumed only on success)
        const catalystCostPerAction = this.useCatalyst ? successRate * this.catalystPrice : 0;

        // Transmute coin fee — see utils/alchemy-fees.js (bulkMultiplier already folded in)
        const coinCost = getAlchemyCoinCost(itemDetails, 'transmute');

        // Real action time and efficiency from game data
        const { actionTime, efficiency, estimated } = this.getActionStats(itemLevel);
        const actionsPerHour = calculateActionsPerHour(actionTime) * (1 + efficiency);
        const teaCostPerAction = this.getTeaCostPerAction(actionsPerHour);

        // Total cost per transmute action
        const totalCostPerAction = itemCost * bulkMultiplier + catalystCostPerAction + coinCost + teaCostPerAction;

        const bonusRevenuePerAction = this.getBonusRevenuePerAction(itemHrid);

        /**
         * Expected revenue of one action when every sellable drop is liquidated
         * on the given book side. Sold drops pay market tax; the self-return
         * does not, because it goes straight back into the transmuter.
         * @param {string} sellType - 'bid' (instant) or 'ask' (patient)
         * @returns {number} Coins per action
         */
        const expectedValueFor = (sellType) => {
            let ev = 0;
            for (const drop of alchemy.transmuteDropTable) {
                let dropValue;
                if (drop.itemHrid === itemHrid) {
                    dropValue = selfReturnUnitValue;
                } else if (drop.itemHrid === PHILO_HRID) {
                    dropValue = calculatePriceAfterTax(this.getPhiloPrice(sellType));
                } else {
                    const quote = marketAPI.getPrice(drop.itemHrid, 0)?.[sellType];
                    if (!(quote > 0)) continue;
                    dropValue = calculatePriceAfterTax(quote);
                }

                const avgCount = (drop.minCount + drop.maxCount) / 2;
                ev += successRate * drop.dropRate * avgCount * bulkMultiplier * dropValue;
            }
            return ev + bonusRevenuePerAction;
        };

        const evInstant = expectedValueFor('bid');
        const evPatient = expectedValueFor('ask');
        const evPerAction = this.getPriceType('sell') === 'bid' ? evInstant : evPatient;

        // Profit per action (EV now includes philo value)
        const profitPerAction = evPerAction - totalCostPerAction;

        // Actions and items needed per philo
        const actionsPerPhilo = 1 / philosPerAction;

        // Net items consumed per action (input minus expected self-returns),
        // both sides at bulk scale
        const selfDrop = alchemy.transmuteDropTable.find((d) => d.itemHrid === itemHrid);
        const selfDropRate = selfDrop ? selfDrop.dropRate : 0;
        const avgSelfCount = selfDrop ? (selfDrop.minCount + selfDrop.maxCount) / 2 : 0;
        const returnChancePerAction = successRate * selfDropRate;
        const itemsPerAction = bulkMultiplier * (1 - returnChancePerAction * avgSelfCount);

        // Items needed per philo (net items consumed × actions needed)
        const itemsPerPhilo = actionsPerPhilo * itemsPerAction;

        // Profit per philo obtained, at both liquidation speeds
        const profitPerPhilo = profitPerAction * actionsPerPhilo;
        const profitPerPhiloInstant = (evInstant - totalCostPerAction) * actionsPerPhilo;
        const profitPerPhiloPatient = (evPatient - totalCostPerAction) * actionsPerPhilo;

        // Profit margin
        const profitMargin = profitPerAction / totalCostPerAction;

        // Time per philo (efficiency buys extra actions, not shorter ones)
        const timePerPhiloSeconds = actionsPerHour > 0 ? (actionsPerPhilo / actionsPerHour) * SECONDS_PER_HOUR : 0;

        const profitPerHour = profitPerAction * actionsPerHour;

        // Revenue and cost per hour
        const revenuePerHour = evPerAction * actionsPerHour;
        const costPerHour = totalCostPerAction * actionsPerHour;

        return {
            itemHrid,
            name: this.getItemName(itemHrid),
            cost: itemCost,
            costSource,
            costFallbackLevel: fallbackLevel,
            // Displayed as the game shows them: conditional on a successful transmute
            philoChance: philoDropRate,
            returnChance: selfDropRate,
            transmuteChance: baseTransmuteRate,
            effectiveTransmuteChance: successRate,
            levelPenalty,
            transmuteCost: totalCostPerAction,
            teaCostPerAction,
            bonusRevenuePerAction,
            ev: evPerAction,
            evInstant,
            evPatient,
            itemsPerAction,
            actionsPerPhilo,
            itemsPerPhilo,
            profitPerPhilo,
            profitPerPhiloInstant,
            profitPerPhiloPatient,
            profitMargin,
            actionTime,
            efficiency,
            actionTimeEstimated: estimated,
            actionsPerHour,
            timePerPhiloSeconds,
            profitPerHour,
            revenuePerHour,
            costPerHour,
            pricingMode: this.resolvePricingMode(),
        };
    }

    /**
     * Calculate all rows
     */
    calculateAllRows() {
        const items = this.findPhiloTransmuteItems();
        this.rows = [];
        // Gear, teas and prices can all have moved since the last pass
        this._actionStatsCache.clear();
        this._bonusRevenueCache.clear();

        for (const { itemHrid, itemDetails } of items) {
            const row = this.calculateRow(itemHrid, itemDetails);
            if (row) {
                this.rows.push(row);
            }
        }

        this.sortRows();
    }

    /**
     * Sort rows by current sort column and direction
     */
    sortRows() {
        const col = this.sortColumn;
        const dir = this.sortDirection === 'asc' ? 1 : -1;

        this.rows.sort((a, b) => {
            const aVal = a[col];
            const bVal = b[col];

            if (typeof aVal === 'string') {
                return dir * aVal.localeCompare(bVal);
            }
            return dir * (aVal - bVal);
        });
    }

    /**
     * Handle column header click for sorting
     * @param {string} column - Column key to sort by
     */
    toggleSort(column) {
        if (this.sortColumn === column) {
            this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
        } else {
            this.sortColumn = column;
            this.sortDirection = 'desc';
        }
        this.sortRows();
        this.renderTable();
    }

    /**
     * Open the calculator modal
     */
    async openModal() {
        this.closeModal();

        // Load saved settings first
        await this.loadSettings();

        this.loadDefaultPrices();
        this.catalyticTeaRatioBoost = this.calculateCatalyticTeaRatioBoost();

        // Set default drink concentration level (only if not previously saved)
        if (this.drinkConcentrationLevel === null) {
            let currentDrinkEnhancementLevel = 0;
            const gameData = dataManager.getInitClientData();
            const equipment = dataManager.getEquipment();
            if (equipment && gameData?.itemDetailMap) {
                for (const [_slotHrid, equippedItem] of equipment) {
                    const itemDetails = gameData.itemDetailMap[equippedItem.itemHrid];
                    if (itemDetails?.equipmentDetail?.noncombatStats?.drinkConcentration) {
                        currentDrinkEnhancementLevel = equippedItem.enhancementLevel || 0;
                        break;
                    }
                }
            }
            this.drinkConcentrationLevel = currentDrinkEnhancementLevel;
        }

        this.calculateAllRows();

        this.modal = document.createElement('div');
        this.modal.style.cssText = `
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0, 0, 0, 0.7);
            z-index: 10000;
            display: flex;
            align-items: center;
            justify-content: center;
        `;

        const dialog = document.createElement('div');
        dialog.style.cssText = `
            background: #2a2a2a;
            color: #ffffff;
            border-radius: 8px;
            width: 95%;
            max-width: 1200px;
            max-height: 90vh;
            display: flex;
            flex-direction: column;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
        `;

        // Header
        const header = document.createElement('div');
        header.style.cssText = `
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 16px 20px;
            border-bottom: 1px solid #444;
        `;
        header.innerHTML = `
            <span style="font-size: 18px; font-weight: bold;">Philosopher's Stone Calculator</span>
        `;

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '\u00D7';
        closeBtn.style.cssText = `
            background: none;
            border: none;
            color: #fff;
            font-size: 24px;
            cursor: pointer;
            padding: 0 4px;
        `;
        closeBtn.addEventListener('click', () => {
            this.closeModal();
        });
        header.appendChild(closeBtn);

        // Controls
        const controls = this.createControls();

        // Table container
        const tableContainer = document.createElement('div');
        tableContainer.className = 'philo-calc-table-container';
        tableContainer.style.cssText = `
            overflow: auto;
            flex: 1;
            padding: 0 20px 20px;
        `;

        dialog.appendChild(header);
        dialog.appendChild(controls);
        dialog.appendChild(tableContainer);
        this.modal.appendChild(dialog);

        // Close on backdrop click
        this.modal.addEventListener('click', (e) => {
            if (e.target === this.modal) {
                this.closeModal();
            }
        });

        // Close on Escape key (handler removed in closeModal to avoid accumulating listeners)
        this._escHandler = (e) => {
            if (e.key === 'Escape' && this.modal) {
                this.closeModal();
            }
        };
        document.addEventListener('keydown', this._escHandler);

        document.body.appendChild(this.modal);
        this.renderTable();
    }

    /**
     * Create the input controls section (philo price, catalyst price, checkbox)
     * @returns {HTMLElement} Controls container
     */
    createControls() {
        const container = document.createElement('div');
        container.style.cssText = `
            padding: 12px 20px;
            display: flex;
            gap: 20px;
            align-items: center;
            flex-wrap: wrap;
            border-bottom: 1px solid #444;
        `;

        // Philo price input
        const philoLabel = document.createElement('label');
        philoLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 13px;';
        philoLabel.textContent = 'Philo Price: ';
        const philoInput = document.createElement('input');
        philoInput.type = 'text';
        philoInput.className = 'philo-calc-price-input';
        philoInput.value = this.philoPrice.toLocaleString();
        philoInput.style.cssText = `
            width: 130px;
            padding: 4px 8px;
            background: #1a1a1a;
            color: #fff;
            border: 1px solid #555;
            border-radius: 4px;
            font-size: 13px;
        `;
        philoInput.title = 'Sale price per Philosopher’s Stone. Overrides the market quote for every column.';
        philoInput.addEventListener('change', () => {
            const parsed = parseInt(philoInput.value.replaceAll(',', '').replaceAll('.', ''), 10);
            if (!isNaN(parsed)) {
                this.philoPrice = parsed;
                this._manualPhiloPrice = true;
                this.recalculate();
            }
        });
        philoLabel.appendChild(philoInput);

        // Catalyst price input
        const catLabel = document.createElement('label');
        catLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 13px;';
        catLabel.textContent = 'Catalyst Price: ';
        const catInput = document.createElement('input');
        catInput.type = 'text';
        catInput.className = 'philo-calc-price-input';
        catInput.value = this.catalystPrice.toLocaleString();
        catInput.style.cssText = `
            width: 130px;
            padding: 4px 8px;
            background: #1a1a1a;
            color: #fff;
            border: 1px solid #555;
            border-radius: 4px;
            font-size: 13px;
        `;
        catInput.addEventListener('change', () => {
            const parsed = parseInt(catInput.value.replaceAll(',', '').replaceAll('.', ''), 10);
            if (!isNaN(parsed)) {
                this.catalystPrice = parsed;
                this._manualCatalystPrice = true;
                this.recalculate();
            }
        });
        catLabel.appendChild(catInput);

        // Use catalyst checkbox
        const checkLabel = document.createElement('label');
        checkLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.useCatalyst;
        checkbox.style.cursor = 'pointer';
        checkbox.addEventListener('change', () => {
            this.useCatalyst = checkbox.checked;
            this.recalculate();
            this.saveSettings();
        });
        checkLabel.appendChild(checkbox);
        checkLabel.appendChild(document.createTextNode('Use Prime Catalyst'));

        container.appendChild(philoLabel);
        container.appendChild(catLabel);
        container.appendChild(checkLabel);
        container.appendChild(this.createPricingModeControl());

        // Catalytic Tea checkbox
        const teaCheckLabel = document.createElement('label');
        teaCheckLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;';
        const teaCheckbox = document.createElement('input');
        teaCheckbox.type = 'checkbox';
        teaCheckbox.checked = this.useCatalyticTea;
        teaCheckbox.style.cursor = 'pointer';
        teaCheckbox.addEventListener('change', () => {
            this.useCatalyticTea = teaCheckbox.checked;
            this.recalculate();
            this.saveSettings();
        });
        teaCheckLabel.appendChild(teaCheckbox);

        // Display base ratioBoost if available
        const boostText =
            this.catalyticTeaRatioBoost > 0
                ? ` (${formatPercentage(this.catalyticTeaRatioBoost, 1)})`
                : ' (unavailable)';
        teaCheckLabel.appendChild(document.createTextNode(`Catalytic Tea${boostText}`));
        container.appendChild(teaCheckLabel);

        // Drink Concentration Dropdown
        const drinkLabel = document.createElement('label');
        drinkLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 13px;';
        drinkLabel.textContent = 'Drink Concentration: ';
        const drinkSelect = document.createElement('select');
        drinkSelect.style.cssText = `
            padding: 4px 8px;
            background: #1a1a1a;
            color: #fff;
            border: 1px solid #555;
            border-radius: 4px;
            font-size: 13px;
        `;

        // Populate dropdown with enhancement levels +0 through +20
        for (let level = 0; level <= 20; level++) {
            const concentration = this.getDrinkConcentrationForLevel(level);
            const option = document.createElement('option');
            option.value = level;
            option.textContent = `+${level} (${formatPercentage(concentration, 2)})`;
            if (level === this.drinkConcentrationLevel) {
                option.selected = true;
            }
            drinkSelect.appendChild(option);
        }

        drinkSelect.addEventListener('change', () => {
            this.drinkConcentrationLevel = parseInt(drinkSelect.value, 10);
            this.recalculate();
            this.saveSettings();
        });
        drinkLabel.appendChild(drinkSelect);
        container.appendChild(drinkLabel);

        // Hide negative profit checkbox
        const hideNegCheckLabel = document.createElement('label');
        hideNegCheckLabel.style.cssText =
            'display: flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer;';
        const hideNegCheckbox = document.createElement('input');
        hideNegCheckbox.type = 'checkbox';
        hideNegCheckbox.checked = this.hideNegativeProfitItems;
        hideNegCheckbox.style.cursor = 'pointer';
        hideNegCheckbox.addEventListener('change', () => {
            this.hideNegativeProfitItems = hideNegCheckbox.checked;
            this.renderTable();
            this.saveSettings();
        });
        hideNegCheckLabel.appendChild(hideNegCheckbox);
        hideNegCheckLabel.appendChild(document.createTextNode('Hide Negative Profit'));
        container.appendChild(hideNegCheckLabel);

        // Filter label
        const filterLabel = document.createElement('label');
        filterLabel.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 13px;';
        filterLabel.textContent = 'Filter: ';
        const filterInput = document.createElement('input');
        filterInput.type = 'text';
        filterInput.placeholder = 'Item name...';
        filterInput.value = this.filterText;
        filterInput.style.cssText = `
            width: 140px;
            padding: 4px 8px;
            background: #1a1a1a;
            color: #fff;
            border: 1px solid #555;
            border-radius: 4px;
            font-size: 13px;
        `;
        filterInput.addEventListener('input', () => {
            this.filterText = filterInput.value;
            this.renderTable();
            this.saveSettings();
        });
        filterLabel.appendChild(filterInput);
        container.appendChild(filterLabel);

        // Refresh prices button
        const refreshBtn = document.createElement('button');
        refreshBtn.textContent = 'Refresh Prices';
        refreshBtn.style.cssText = `
            padding: 4px 12px;
            background: #4a90e2;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
            font-size: 13px;
        `;
        refreshBtn.addEventListener('mouseenter', () => {
            refreshBtn.style.background = '#357abd';
        });
        refreshBtn.addEventListener('mouseleave', () => {
            refreshBtn.style.background = '#4a90e2';
        });
        refreshBtn.addEventListener('click', async () => {
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Refreshing...';
            refreshBtn.style.opacity = '0.6';
            try {
                await marketAPI.fetch(true);
                this.loadDefaultPrices();
                // Update the price inputs to reflect new data
                this.syncPriceInputs();
                this.recalculate();
            } catch (error) {
                console.error('[PhiloCalculator] Failed to refresh prices:', error);
            }
            refreshBtn.disabled = false;
            refreshBtn.textContent = 'Refresh Prices';
            refreshBtn.style.opacity = '1';
        });
        container.appendChild(refreshBtn);

        return container;
    }

    /**
     * Pricing mode dropdown. Defaults to conservative rather than following the
     * global profit setting, and says so in its tooltip.
     * @returns {HTMLElement} Label wrapping the select
     */
    createPricingModeControl() {
        const label = document.createElement('label');
        label.style.cssText = 'display: flex; align-items: center; gap: 6px; font-size: 13px;';
        label.textContent = 'Pricing: ';

        const globalMode = config.getSettingValue('profitCalc_pricingMode', 'hybrid');
        const globalLabel = PRICING_MODES[globalMode]?.label || globalMode;
        label.title =
            `Defaults to ${PRICING_MODES[DEFAULT_PRICING_MODE].label} regardless of the global profit ` +
            `pricing mode (currently ${globalLabel}): a philo hunt only pays if it still pays when the ` +
            'stones are sold into standing bids, so this table refuses to assume a patient sale. ' +
            'Choose Global to follow the shared setting instead.';

        const select = document.createElement('select');
        select.style.cssText = `
            padding: 4px 8px;
            background: #1a1a1a;
            color: #fff;
            border: 1px solid #555;
            border-radius: 4px;
            font-size: 13px;
        `;

        const options = [
            [GLOBAL_PRICING_MODE, `Global (${globalLabel})`],
            ...Object.entries(PRICING_MODES).map(([value, mode]) => [value, mode.label]),
        ];
        for (const [value, text] of options) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            if (value === this.pricingMode) {
                option.selected = true;
            }
            select.appendChild(option);
        }

        select.addEventListener('change', () => {
            this.pricingMode = select.value;
            // Un-pinned prices track whichever side of the book the new mode reads
            this.loadDefaultPrices();
            this.syncPriceInputs();
            this.recalculate();
            this.saveSettings();
        });

        label.appendChild(select);
        return label;
    }

    /**
     * Push the current philo/catalyst prices back into their inputs
     */
    syncPriceInputs() {
        const inputs = this.modal?.querySelectorAll('.philo-calc-price-input');
        if (!inputs) return;
        if (inputs[0]) inputs[0].value = this.philoPrice.toLocaleString();
        if (inputs[1]) inputs[1].value = this.catalystPrice.toLocaleString();
    }

    /**
     * Recalculate all rows and re-render
     */
    recalculate() {
        this.calculateAllRows();
        this.renderTable();
    }

    /**
     * Draw the cost cell: the resolved cost basis, a marker explaining where it
     * came from, and click-to-edit for a manual override.
     * @param {HTMLElement} td - Cell to fill
     * @param {Object} row - Row data
     */
    renderCostCell(td, row) {
        const markers = {
            craft: {
                glyph: ' ⚒',
                title: 'Cost is the refinement craft estimate (base item + materials), not a listing.',
            },
            enhanced: {
                glyph: ` ⚠+${row.costFallbackLevel}`,
                title:
                    `No +0 listing — cost basis borrowed from the +${row.costFallbackLevel} ask, which is dearer ` +
                    'than a +0 item and is not a price this transmute can actually be run at. Self-returns are ' +
                    'credited at the base item price, so this row is a lower bound at best. Click to override.',
            },
            override: { glyph: ' ✎', title: 'Manual cost override. Click to change, clear the field to remove.' },
        };

        const marker = markers[row.costSource];
        td.textContent = formatLargeNumber(Math.round(row.cost)) + (marker?.glyph || '');
        td.title = marker?.title || 'Click to override this item’s cost basis.';
        td.style.cursor = 'pointer';
        if (row.costSource === 'enhanced') {
            td.style.color = config.COLOR_WARNING;
        }

        td.addEventListener('click', () => this.editCostOverride(td, row));
    }

    /**
     * Swap a cost cell for an input so the user can pin the item's cost basis,
     * the same way the philo price input pins the sell side.
     * @param {HTMLElement} td - Cost cell
     * @param {Object} row - Row data
     */
    editCostOverride(td, row) {
        if (td.querySelector('input')) return;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = String(this.itemCostOverrides[row.itemHrid] ?? Math.round(row.cost));
        input.style.cssText = `
            width: 90px;
            padding: 2px 4px;
            background: #1a1a1a;
            color: #fff;
            border: 1px solid #4a90e2;
            border-radius: 3px;
            font-size: 12px;
            text-align: right;
        `;

        const commit = () => {
            const raw = input.value.replaceAll(',', '').replaceAll('.', '').trim();
            const parsed = parseInt(raw, 10);
            if (raw === '' || parsed <= 0 || isNaN(parsed)) {
                delete this.itemCostOverrides[row.itemHrid];
            } else {
                this.itemCostOverrides[row.itemHrid] = parsed;
            }
            this.recalculate();
            this.saveSettings();
        };

        input.addEventListener('keydown', (e) => {
            e.stopPropagation(); // Escape belongs to the input, not the modal
            if (e.key === 'Enter') input.blur();
            if (e.key === 'Escape') this.renderTable();
        });
        input.addEventListener('blur', commit);

        td.textContent = '';
        td.appendChild(input);
        input.focus();
        input.select();
    }

    /**
     * Draw the paired instant | patient profit cell
     * @param {HTMLElement} td - Cell to fill
     * @param {Object} row - Row data
     */
    renderPairedProfitCell(td, row) {
        const part = (value) => {
            const span = document.createElement('span');
            span.textContent = formatLargeNumber(Math.round(value));
            span.style.color = value >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS;
            return span;
        };

        const separator = document.createElement('span');
        separator.textContent = ' | ';
        separator.style.color = '#888';

        td.appendChild(part(row.profitPerPhiloInstant));
        td.appendChild(separator);
        td.appendChild(part(row.profitPerPhiloPatient));
        td.title = 'Instant: stones sold into standing bids. Patient: stones listed at ask and waited out.';
    }

    /**
     * Render the results table
     */
    renderTable() {
        const container = this.modal?.querySelector('.philo-calc-table-container');
        if (!container) return;

        const columns = [
            { key: 'name', label: 'Item', align: 'left' },
            { key: 'cost', label: 'Cost' },
            { key: 'philoChance', label: 'Philo %' },
            { key: 'returnChance', label: 'Return %' },
            { key: 'transmuteChance', label: 'Base Xmute %' },
            { key: 'effectiveTransmuteChance', label: 'Eff. Xmute %' },
            { key: 'transmuteCost', label: 'Xmute Cost' },
            { key: 'ev', label: 'EV' },
            { key: 'itemsPerAction', label: 'Items/Act' },
            { key: 'actionsPerPhilo', label: 'Acts/Philo' },
            { key: 'itemsPerPhilo', label: 'Items/Philo' },
            {
                key: 'profitPerPhiloInstant',
                label: 'Profit/Philo (instant | patient)',
                title: 'Left: stones sold into standing bids. Right: stones listed and waited out at ask. Sorts on instant.',
            },
            { key: 'profitMargin', label: 'Margin' },
            { key: 'timePerPhiloSeconds', label: 'Time/Philo' },
            { key: 'profitPerHour', label: 'Profit/Hr' },
            { key: 'revenuePerHour', label: 'Revenue/Hr' },
            { key: 'costPerHour', label: 'Cost/Hr' },
        ];

        const table = document.createElement('table');
        table.style.cssText = `
            width: 100%;
            border-collapse: collapse;
            font-size: 12px;
        `;

        // Header
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');

        for (const col of columns) {
            const th = document.createElement('th');
            th.style.cssText = `
                padding: 8px 6px;
                text-align: ${col.align || 'right'};
                border-bottom: 2px solid #555;
                cursor: pointer;
                user-select: none;
                white-space: nowrap;
                position: sticky;
                top: 0;
                background: #2a2a2a;
                z-index: 1;
            `;

            const arrow = this.sortColumn === col.key ? (this.sortDirection === 'asc' ? ' \u25B2' : ' \u25BC') : '';
            th.textContent = col.label + arrow;
            if (col.title) {
                th.title = col.title;
            }

            th.addEventListener('click', () => this.toggleSort(col.key));
            headerRow.appendChild(th);
        }

        thead.appendChild(headerRow);
        table.appendChild(thead);

        // Body
        const tbody = document.createElement('tbody');

        // Apply item name filter
        const filterLower = this.filterText.toLowerCase();
        let filteredRows = filterLower
            ? this.rows.filter((row) => row.name.toLowerCase().includes(filterLower))
            : this.rows;

        // Apply negative profit filter
        if (this.hideNegativeProfitItems) {
            filteredRows = filteredRows.filter((row) => row.profitPerPhilo >= 0);
        }

        for (let i = 0; i < filteredRows.length; i++) {
            const row = filteredRows[i];
            const tr = document.createElement('tr');
            const bgColor = i % 2 === 0 ? '#2a2a2a' : '#252525';
            tr.style.cssText = `background: ${bgColor};`;

            for (const col of columns) {
                const td = document.createElement('td');
                td.style.cssText = `
                    padding: 6px;
                    text-align: ${col.align || 'right'};
                    white-space: nowrap;
                `;

                const value = row[col.key];

                // Format based on column type
                switch (col.key) {
                    case 'name':
                        td.textContent = value;
                        // The rest of the modal is about this item; the name is
                        // the way to it. Same pattern as the ledger's rows.
                        td.style.cursor = 'pointer';
                        td.title = 'Open this item in the marketplace.';
                        td.addEventListener('mouseenter', () => (td.style.textDecoration = 'underline'));
                        td.addEventListener('mouseleave', () => (td.style.textDecoration = ''));
                        td.addEventListener('click', () => {
                            navigateToMarketplace(row.itemHrid, 0);
                            this.closeModal();
                        });
                        break;
                    case 'cost':
                        this.renderCostCell(td, row);
                        break;
                    case 'profitPerPhiloInstant':
                        this.renderPairedProfitCell(td, row);
                        break;
                    case 'philoChance':
                    case 'returnChance':
                    case 'transmuteChance':
                    case 'effectiveTransmuteChance':
                        td.textContent = formatPercentage(value, 2);
                        break;
                    case 'profitMargin':
                        td.textContent = formatPercentage(value, 1);
                        td.style.color = value >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS;
                        break;
                    case 'timePerPhiloSeconds':
                        td.textContent = timeReadable(value);
                        break;
                    case 'profitPerHour':
                        td.textContent = formatLargeNumber(Math.round(value));
                        td.style.color = value >= 0 ? config.COLOR_PROFIT : config.COLOR_LOSS;
                        break;
                    case 'revenuePerHour':
                    case 'costPerHour':
                        td.textContent = formatLargeNumber(Math.round(value));
                        break;
                    case 'actionsPerPhilo':
                    case 'itemsPerPhilo':
                        td.textContent = formatLargeNumber(Math.round(value));
                        break;
                    case 'itemsPerAction':
                        td.textContent = value.toFixed(2);
                        break;
                    default:
                        td.textContent = formatLargeNumber(Math.round(value));
                        break;
                }

                tr.appendChild(td);
            }

            tbody.appendChild(tr);
        }

        table.appendChild(tbody);

        container.innerHTML = '';
        container.appendChild(table);
    }
}

const philoCalculator = new PhiloCalculator();

// Exported for tests, which need an instance whose settings no other test has touched
export { PhiloCalculator, PRICING_MODES };
export default philoCalculator;
