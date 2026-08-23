/**
 * Alchemy Profit Calculator Module
 * Calculates real-time profit for alchemy actions accounting for:
 * - Success rate (failures consume materials but not catalyst)
 * - Efficiency bonuses
 * - Tea buff costs and duration
 * - Market prices (ask/bid based on pricing mode)
 */

import marketAPI from '../../api/marketplace.js';
import dataManager from '../../core/data-manager.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { parseRareFindBonus, parseEssenceFindBonus } from '../../utils/equipment-parser.js';
import { getDrinkConcentration } from '../../utils/tea-parser.js';
import { getActionEfficiencyContext } from '../../utils/efficiency.js';
import { getCommunityProductionEfficiency } from '../../utils/community-buffs.js';
import { calculatePriceAfterTax } from '../../utils/profit-helpers.js';

const ALCHEMY_ACTION_TYPE = '/action_types/alchemy';

class AlchemyProfit {
    constructor() {
        this.cachedData = null;
        this.lastFingerprint = null;
    }

    /**
     * Extract alchemy action data from the DOM
     * @returns {Object|null} Action data or null if extraction fails
     */
    async extractActionData() {
        try {
            const alchemyComponent = document.querySelector('[class*="SkillActionDetail_alchemyComponent"]');
            if (!alchemyComponent) return null;

            // Get action HRID from current actions
            const actionHrid = this.getCurrentActionHrid();

            // Get success rate with breakdown
            const successRateBreakdown = this.extractSuccessRate();
            if (successRateBreakdown === null) return null;

            // Get action time (base 20 seconds)
            const actionSpeedBreakdown = this.extractActionSpeed();
            const actionTime = 20 / (1 + actionSpeedBreakdown.total);

            // Get efficiency
            const efficiencyBreakdown = this.extractEfficiency();

            // Get rare find
            const rareFindBreakdown = this.extractRareFind();

            // Get essence find
            const essenceFindBreakdown = this.extractEssenceFind();

            // Get requirements (inputs)
            const requirements = await this.extractRequirements();

            // Get drops (outputs) - now passing actionHrid for game data lookup
            const drops = await this.extractDrops(actionHrid);

            // Get catalyst
            const catalyst = await this.extractCatalyst();

            // Get consumables (tea/drinks)
            const consumables = await this.extractConsumables();
            const teaDuration = this.extractTeaDuration();

            return {
                successRate: successRateBreakdown.total,
                successRateBreakdown,
                actionTime,
                efficiency: efficiencyBreakdown.total,
                efficiencyBreakdown,
                actionSpeedBreakdown,
                rareFindBreakdown,
                essenceFindBreakdown,
                requirements,
                drops,
                catalyst,
                consumables,
                teaDuration,
            };
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract action data:', error);
            return null;
        }
    }

    /**
     * Get current alchemy action HRID
     * @returns {string|null} Action HRID or null
     */
    getCurrentActionHrid() {
        try {
            // Get current actions from dataManager
            const currentActions = dataManager.getCurrentActions();
            if (!currentActions || currentActions.length === 0) return null;

            // Find alchemy action (type = /action_types/alchemy)
            for (const action of currentActions) {
                if (action.actionHrid && action.actionHrid.startsWith('/actions/alchemy/')) {
                    return action.actionHrid;
                }
            }

            return null;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to get current action HRID:', error);
            return null;
        }
    }

    /**
     * Extract success rate with breakdown from the DOM and active buffs
     * @returns {Object} Success rate breakdown { total, base, tea }
     */
    extractSuccessRate() {
        try {
            const element = document.querySelector(
                '[class*="SkillActionDetail_successRate"] [class*="SkillActionDetail_value"]'
            );
            if (!element) return null;

            const text = element.textContent.trim();
            const match = text.match(/(\d+\.?\d*)/);
            if (!match) return null;

            const totalSuccessRate = parseFloat(match[1]) / 100;

            // Calculate tea bonus from active drinks
            const gameData = dataManager.getInitClientData();
            if (!gameData) {
                return {
                    total: totalSuccessRate,
                    base: totalSuccessRate,
                    tea: 0,
                };
            }

            const actionTypeHrid = '/action_types/alchemy';
            const drinkSlots = dataManager.getActionDrinkSlots(actionTypeHrid);
            const equipment = dataManager.getEquipment();

            // Get drink concentration from equipment
            const drinkConcentration = getDrinkConcentration(equipment, gameData.itemDetailMap);

            // Calculate tea success rate bonus
            let teaBonus = 0;

            if (drinkSlots && drinkSlots.length > 0) {
                for (const drink of drinkSlots) {
                    if (!drink || !drink.itemHrid) continue;

                    const itemDetails = gameData.itemDetailMap[drink.itemHrid];
                    if (!itemDetails || !itemDetails.consumableDetail || !itemDetails.consumableDetail.buffs) {
                        continue;
                    }

                    // Check for alchemy_success buff
                    for (const buff of itemDetails.consumableDetail.buffs) {
                        if (buff.typeHrid === '/buff_types/alchemy_success') {
                            // ratioBoost is a percentage multiplier (e.g., 0.05 = 5% of base)
                            // It scales with drink concentration
                            const ratioBoost = buff.ratioBoost * (1 + drinkConcentration);
                            teaBonus += ratioBoost;
                        }
                    }
                }
            }

            // Calculate base success rate (before tea bonus)
            // Formula: total = base × (1 + tea_ratio_boost)
            // So: base = total / (1 + tea_ratio_boost)
            const baseSuccessRate = totalSuccessRate / (1 + teaBonus);

            return {
                total: totalSuccessRate,
                base: baseSuccessRate,
                tea: teaBonus,
            };
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract success rate:', error);
            return null;
        }
    }

    /**
     * The action type this panel is about. Alchemy is always alchemy, but the shared
     * efficiency context is written against an action detail, so give it one: the level
     * requirement is the only part that varies and it is read off the panel.
     * @returns {Object} A minimal action detail for the efficiency context
     */
    alchemyActionDetails() {
        return {
            type: ALCHEMY_ACTION_TYPE,
            // The panel prices per action, never in wall-clock seconds, so the base time
            // is irrelevant here — only the speed and efficiency bonuses are read back
            baseTimeCost: 0,
            levelRequirement: { level: this.extractRequiredLevel(), skillHrid: '/skills/alchemy' },
        };
    }

    /**
     * The shared efficiency context for the alchemy panel.
     *
     * This used to be two hand-rolled copies of the efficiency stack that had drifted:
     * neither counted personal (seal) or guild buffs, the speed reading had a hardcoded
     * `teaSpeed = 0`, and the community buff was applied without checking the game's
     * `usableInActionTypeMap`. The shared context is the same one the action panel and
     * the production profit calculator use, so alchemy can no longer disagree with them.
     *
     * @returns {Object|null} Efficiency context, or null when game data is unavailable
     */
    efficiencyContext() {
        const gameData = dataManager.getInitClientData();
        if (!gameData) return null;

        return getActionEfficiencyContext(this.alchemyActionDetails(), {
            isProduction: true,
            gameData,
            communityEfficiency: getCommunityProductionEfficiency(ALCHEMY_ACTION_TYPE),
        });
    }

    /**
     * Extract action speed buff using the shared efficiency context
     * @returns {Object} Action speed breakdown { total, equipment, tea, personal, guild }
     */
    extractActionSpeed() {
        try {
            const context = this.efficiencyContext();
            if (!context) {
                return { total: 0, equipment: 0, tea: 0, personal: 0, guild: 0 };
            }

            // speedBonus is the equipment share; personal (seal) and guild buffs stack
            // additively on top of it, exactly as the action panel adds them
            const equipment = context.speedBonus;
            const personal = context.personalSpeedBonus;
            const guild = context.guildSpeedBonus;

            return {
                total: equipment + personal + guild,
                equipment,
                // Speed teas do not exist for alchemy; the field stays for callers that read it
                tea: 0,
                personal,
                guild,
            };
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract action speed:', error);
            return { total: 0, equipment: 0, tea: 0, personal: 0, guild: 0 };
        }
    }

    /**
     * Extract efficiency using the shared efficiency context
     * @returns {Object} Efficiency breakdown { total, level, house, tea, equipment, community, ... }
     */
    extractEfficiency() {
        const empty = {
            total: 0,
            level: 0,
            house: 0,
            tea: 0,
            equipment: 0,
            community: 0,
            achievement: 0,
            personal: 0,
            guild: 0,
        };

        try {
            const context = this.efficiencyContext();
            if (!context) return empty;

            return {
                total: context.efficiencyBreakdown.totalEfficiency / 100, // Convert percentage to decimal
                level: context.efficiencyBreakdown.levelEfficiency,
                house: context.houseEfficiency,
                tea: context.teaEfficiency,
                equipment: context.equipmentEfficiency,
                community: context.communityEfficiency,
                achievement: context.achievementEfficiency,
                personal: context.personalEfficiency,
                guild: context.guildEfficiency,
            };
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract efficiency:', error);
            return empty;
        }
    }

    /**
     * Extract rare find bonus from equipment and buffs
     * @returns {Object} Rare find breakdown { total, equipment, achievement }
     */
    extractRareFind() {
        try {
            const gameData = dataManager.getInitClientData();
            if (!gameData) {
                return { total: 0, equipment: 0, achievement: 0 };
            }

            const equipment = dataManager.getEquipment();
            const actionTypeHrid = '/action_types/alchemy';

            // Parse equipment rare find bonuses (alchemyRareFind + skillingRareFind, enhancement-scaled)
            const equipmentRareFind = parseRareFindBonus(equipment, actionTypeHrid, gameData.itemDetailMap);

            // Get achievement rare find bonus (Veteran tier: +2%)
            const achievementRareFind =
                dataManager.getAchievementBuffFlatBoost(actionTypeHrid, '/buff_types/rare_find') * 100;

            const total = equipmentRareFind + achievementRareFind;

            return {
                total: total / 100, // Convert to decimal
                equipment: equipmentRareFind,
                achievement: achievementRareFind,
            };
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract rare find:', error);
            return { total: 0, equipment: 0, achievement: 0 };
        }
    }

    /**
     * Extract essence find bonus from equipment and buffs
     * @returns {Object} Essence find breakdown { total, equipment }
     */
    extractEssenceFind() {
        try {
            const gameData = dataManager.getInitClientData();
            if (!gameData) {
                return { total: 0, equipment: 0 };
            }

            const equipment = dataManager.getEquipment();

            // Parse equipment essence find bonuses (skillingEssenceFind, enhancement-scaled)
            const equipmentEssenceFind = parseEssenceFindBonus(equipment, gameData.itemDetailMap);

            return {
                total: equipmentEssenceFind / 100, // Convert to decimal
                equipment: equipmentEssenceFind,
            };
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract essence find:', error);
            return { total: 0, equipment: 0 };
        }
    }

    /**
     * Extract required level from notes
     * @returns {number} Required alchemy level
     */
    extractRequiredLevel() {
        try {
            const notesEl = document.querySelector('[class*="SkillActionDetail_notes"]');
            if (!notesEl) return 0;

            const text = notesEl.textContent;
            const match = text.match(/(\d+)/);
            return match ? parseInt(match[1]) : 0;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract required level:', error);
            return 0;
        }
    }

    /**
     * Extract tea buff duration from React props
     * @returns {number} Duration in seconds (default 300)
     */
    extractTeaDuration() {
        try {
            const rootEl = document.getElementById('root');
            const rootFiber =
                rootEl?._reactRootContainer?.current || rootEl?._reactRootContainer?._internalRoot?.current;
            if (!rootFiber) return 300;

            function find(fiber) {
                if (!fiber) return null;
                if (fiber.memoizedProps?.actionBuffs) return fiber;
                return find(fiber.child) || find(fiber.sibling);
            }

            const fiberNode = find(rootFiber);
            if (!fiberNode) return 300;

            const buffs = fiberNode.memoizedProps.actionBuffs;
            for (const buff of buffs) {
                if (buff.uniqueHrid && buff.uniqueHrid.endsWith('tea')) {
                    const duration = buff.duration || 0;
                    return duration / 1e9; // Convert nanoseconds to seconds
                }
            }

            return 300; // Default 5 minutes
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract tea duration:', error);
            return 300;
        }
    }

    /**
     * Extract requirements (input materials) from the DOM
     * @returns {Promise<Array>} Array of requirement objects
     */
    async extractRequirements() {
        try {
            const elements = document.querySelectorAll(
                '[class*="SkillActionDetail_itemRequirements"] [class*="Item_itemContainer"]'
            );
            const requirements = [];

            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const itemData = await this.extractItemData(el, true, i);
                if (itemData) {
                    requirements.push(itemData);
                }
            }

            return requirements;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract requirements:', error);
            return [];
        }
    }

    /**
     * Extract drops (outputs) from the DOM
     * @returns {Promise<Array>} Array of drop objects
     */
    async extractDrops(actionHrid) {
        try {
            const elements = document.querySelectorAll(
                '[class*="SkillActionDetail_dropTable"] [class*="Item_itemContainer"]'
            );
            const drops = [];

            // Get action details from game data for drop rates
            const gameData = dataManager.getInitClientData();
            const actionDetail = actionHrid && gameData ? gameData.actionDetailMap?.[actionHrid] : null;

            for (let i = 0; i < elements.length; i++) {
                const el = elements[i];
                const itemData = await this.extractItemData(el, false, i, actionDetail);
                if (itemData) {
                    drops.push(itemData);
                }
            }

            return drops;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract drops:', error);
            return [];
        }
    }

    /**
     * Extract catalyst from the DOM
     * @returns {Promise<Object>} Catalyst object with prices
     */
    async extractCatalyst() {
        try {
            const element =
                document.querySelector(
                    '[class*="SkillActionDetail_catalystItemInputContainer"] [class*="ItemSelector_itemContainer"]'
                ) ||
                document.querySelector(
                    '[class*="SkillActionDetail_catalystItemInputContainer"] [class*="SkillActionDetail_itemContainer"]'
                );

            if (!element) {
                return { ask: 0, bid: 0 };
            }

            const itemData = await this.extractItemData(element, false, -1);
            return itemData || { ask: 0, bid: 0 };
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract catalyst:', error);
            return { ask: 0, bid: 0 };
        }
    }

    /**
     * Extract consumables (tea/drinks) from the DOM
     * @returns {Promise<Array>} Array of consumable objects
     */
    async extractConsumables() {
        try {
            const elements = document.querySelectorAll(
                '[class*="ActionTypeConsumableSlots_consumableSlots"] [class*="Item_itemContainer"]'
            );
            const consumables = [];

            for (const el of elements) {
                const itemData = await this.extractItemData(el, false, -1);
                if (itemData && itemData.itemHrid !== '/items/coin') {
                    consumables.push(itemData);
                }
            }

            return consumables;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract consumables:', error);
            return [];
        }
    }

    /**
     * Calculate the cost to create an enhanced item
     * @param {string} itemHrid - Item HRID
     * @param {number} targetLevel - Target enhancement level
     * @param {string} priceType - 'ask' or 'bid'
     * @returns {number} Total cost to create the enhanced item
     */
    calculateEnhancementCost(itemHrid, targetLevel, priceType) {
        if (targetLevel === 0) {
            const priceData = marketAPI.getPrice(itemHrid, 0);
            return priceType === 'ask' ? priceData?.ask || 0 : priceData?.bid || 0;
        }

        const gameData = dataManager.getInitClientData();
        if (!gameData) return 0;

        const itemData = gameData.itemDetailMap?.[itemHrid];
        if (!itemData) return 0;

        // Start with base item cost
        const basePriceData = marketAPI.getPrice(itemHrid, 0);
        let totalCost = priceType === 'ask' ? basePriceData?.ask || 0 : basePriceData?.bid || 0;

        // Add enhancement material costs for each level
        const enhancementMaterials = itemData.enhancementCosts;
        if (!enhancementMaterials || !Array.isArray(enhancementMaterials)) {
            return totalCost;
        }

        // Enhance from level 0 to targetLevel
        for (let level = 0; level < targetLevel; level++) {
            for (const cost of enhancementMaterials) {
                const materialHrid = cost.itemHrid;
                const materialCount = cost.count || 0;

                if (materialHrid === '/items/coin') {
                    totalCost += materialCount; // Coins are 1:1
                } else {
                    const materialPrice = marketAPI.getPrice(materialHrid, 0);
                    const price = priceType === 'ask' ? materialPrice?.ask || 0 : materialPrice?.bid || 0;
                    totalCost += price * materialCount;
                }
            }
        }

        return totalCost;
    }

    /**
     * Calculate value recovered from decomposing an enhanced item
     * @param {string} itemHrid - Item HRID
     * @param {number} enhancementLevel - Enhancement level
     * @param {string} priceType - 'ask' or 'bid'
     * @returns {number} Total value recovered from decomposition
     */
    calculateDecompositionValue(itemHrid, enhancementLevel, priceType) {
        if (enhancementLevel === 0) return 0;

        const gameData = dataManager.getInitClientData();
        if (!gameData) return 0;

        const itemDetails = gameData.itemDetailMap?.[itemHrid];
        if (!itemDetails) return 0;

        let totalValue = 0;

        // 1. Base item decomposition outputs
        if (itemDetails.decompositionDetail?.results) {
            for (const result of itemDetails.decompositionDetail.results) {
                const priceData = marketAPI.getPrice(result.itemHrid, 0);
                if (priceData) {
                    const price = priceType === 'ask' ? priceData.ask : priceData.bid;
                    totalValue += calculatePriceAfterTax(price * result.amount); // market tax (see profit-constants)
                }
            }
        }

        // 2. Enhancing Essence from enhancement level
        // Formula: round(2 × (0.5 + 0.1 × (1.05^itemLevel)) × (2^enhancementLevel))
        const itemLevel = itemDetails.itemLevel || 1;
        const essenceAmount = Math.round(2 * (0.5 + 0.1 * Math.pow(1.05, itemLevel)) * Math.pow(2, enhancementLevel));

        const essencePriceData = marketAPI.getPrice('/items/enhancing_essence', 0);
        if (essencePriceData) {
            const essencePrice = priceType === 'ask' ? essencePriceData.ask : essencePriceData.bid;
            totalValue += calculatePriceAfterTax(essencePrice * essenceAmount); // market tax (see profit-constants)
        }

        return totalValue;
    }

    /**
     * Extract item data (HRID, prices, count, drop rate) from DOM element
     * @param {HTMLElement} element - Item container element
     * @param {boolean} isRequirement - True if this is a requirement (has count), false if drop (has drop rate)
     * @param {number} index - Index in the list (for extracting count/rate text)
     * @returns {Promise<Object|null>} Item data object or null
     */
    async extractItemData(element, isRequirement, index, actionDetail = null) {
        try {
            // Get item HRID from SVG use element
            const use = element.querySelector('svg use');
            if (!use) return null;

            const href = use.getAttribute('href');
            if (!href) return null;

            const itemId = href.split('#')[1];
            if (!itemId) return null;

            const itemHrid = `/items/${itemId}`;

            // Get enhancement level
            let enhancementLevel = 0;
            if (isRequirement) {
                const enhEl = element.querySelector('[class*="Item_enhancementLevel"]');
                if (enhEl) {
                    const match = enhEl.textContent.match(/\+(\d+)/);
                    enhancementLevel = match ? parseInt(match[1]) : 0;
                }
            }

            // Get market prices
            let ask = 0,
                bid = 0;
            if (itemHrid === '/items/coin') {
                ask = bid = 1;
            } else {
                // Check if this is an openable container (loot crate)
                const itemDetails = dataManager.getItemDetails(itemHrid);
                if (itemDetails?.isOpenable) {
                    // Use expected value calculator for openable containers
                    const containerValue = expectedValueCalculator.getCachedValue(itemHrid);
                    if (containerValue !== null && containerValue > 0) {
                        ask = bid = containerValue;
                    } else {
                        // Fallback to marketplace if EV not available
                        const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);
                        ask = priceData?.ask || 0;
                        bid = priceData?.bid || 0;
                    }
                } else {
                    // Regular item - use marketplace price
                    const priceData = marketAPI.getPrice(itemHrid, enhancementLevel);
                    if (priceData && (priceData.ask > 0 || priceData.bid > 0)) {
                        // Market data exists for this specific enhancement level
                        ask = priceData.ask || 0;
                        bid = priceData.bid || 0;
                    } else {
                        // No market data for this enhancement level - calculate cost
                        ask = this.calculateEnhancementCost(itemHrid, enhancementLevel, 'ask');
                        bid = this.calculateEnhancementCost(itemHrid, enhancementLevel, 'bid');
                    }
                }
            }

            const result = { itemHrid, ask, bid, enhancementLevel };

            // Get count or drop rate
            if (isRequirement && index >= 0) {
                // Extract count from requirement
                const countElements = document.querySelectorAll(
                    '[class*="SkillActionDetail_itemRequirements"] [class*="SkillActionDetail_inputCount"]'
                );

                if (countElements[index]) {
                    const text = countElements[index].textContent.trim();
                    // Extract number after the "/" character (format: "/ 2" or "/ 450")
                    const match = text.match(/\/\s*([\d,]+)/);
                    let parsedCount = 1;

                    if (match) {
                        const cleaned = match[1].replace(/,/g, '');
                        parsedCount = parseFloat(cleaned);
                    }

                    result.count = parsedCount || 1;
                } else {
                    result.count = 1;
                }
            } else if (!isRequirement) {
                // Extract count and drop rate from action detail (game data) or DOM fallback
                let dropRateFromGameData = null;

                // Try to get drop rate from game data first
                if (actionDetail && actionDetail.dropTable) {
                    const dropEntry = actionDetail.dropTable.find((drop) => drop.itemHrid === itemHrid);
                    if (dropEntry) {
                        dropRateFromGameData = dropEntry.dropRate;
                    }
                }

                // Extract count from DOM
                const dropElements = document.querySelectorAll(
                    '[class*="SkillActionDetail_drop"], [class*="SkillActionDetail_essence"], [class*="SkillActionDetail_rare"]'
                );

                for (const dropElement of dropElements) {
                    // Check if this drop element contains our item
                    const dropItemElement = dropElement.querySelector('[class*="Item_itemContainer"] svg use');
                    if (dropItemElement) {
                        const dropHref = dropItemElement.getAttribute('href');
                        const dropItemId = dropHref ? dropHref.split('#')[1] : null;
                        const dropItemHrid = dropItemId ? `/items/${dropItemId}` : null;

                        if (dropItemHrid === itemHrid) {
                            // Found the matching drop element
                            const text = dropElement.textContent.trim();

                            // Extract count (at start of text)
                            const countMatch = text.match(/^([\d\s,.]+)/);
                            if (countMatch) {
                                const cleaned = countMatch[1].replace(/,/g, '').trim();
                                result.count = parseFloat(cleaned) || 1;
                            } else {
                                result.count = 1;
                            }

                            // Use drop rate from game data if available, otherwise try DOM
                            if (dropRateFromGameData !== null) {
                                result.dropRate = dropRateFromGameData;
                            } else {
                                // Extract drop rate percentage from DOM (handles both "7.29%" and "~7.29%")
                                const rateMatch = text.match(/~?([\d,.]+)%/);
                                if (rateMatch) {
                                    const cleaned = rateMatch[1].replace(/,/g, '');
                                    result.dropRate = parseFloat(cleaned) / 100 || 1;
                                } else {
                                    result.dropRate = 1;
                                }
                            }

                            break; // Found it, stop searching
                        }
                    }
                }

                // If we didn't find a matching drop element, set defaults
                if (result.count === undefined) {
                    result.count = 1;
                }
                if (result.dropRate === undefined) {
                    // Use game data drop rate if available, otherwise default to 1
                    result.dropRate = dropRateFromGameData !== null ? dropRateFromGameData : 1;
                }
            }

            return result;
        } catch (error) {
            console.error('[AlchemyProfit] Failed to extract item data:', error);
            return null;
        }
    }

    /**
     * Generate state fingerprint for change detection
     * @returns {string} Fingerprint string
     */
    getStateFingerprint() {
        try {
            const successRate =
                document.querySelector('[class*="SkillActionDetail_successRate"] [class*="SkillActionDetail_value"]')
                    ?.textContent || '';
            const consumables = Array.from(
                document.querySelectorAll(
                    '[class*="ActionTypeConsumableSlots_consumableSlots"] [class*="Item_itemContainer"]'
                )
            )
                .map((el) => el.querySelector('svg use')?.getAttribute('href') || 'empty')
                .join('|');

            // Get catalyst (from the catalyst input container)
            // Use Item_itemContainer to avoid the info icon's use[href]; item icons use xlink:href
            const catalystUse = document.querySelector(
                '[class*="SkillActionDetail_catalystItemInputContainer"] [class*="Item_itemContainer"] svg use'
            );
            const catalyst = catalystUse?.getAttribute('xlink:href') || catalystUse?.getAttribute('href') || 'none';

            // Get requirements (input materials)
            const requirements = Array.from(
                document.querySelectorAll('[class*="SkillActionDetail_itemRequirements"] [class*="Item_itemContainer"]')
            )
                .map((el) => {
                    const href = el.querySelector('svg use')?.getAttribute('href') || 'empty';
                    const enh = el.querySelector('[class*="Item_enhancementLevel"]')?.textContent || '0';
                    return `${href}${enh}`;
                })
                .join('|');

            // Get selected alchemy tab (Coinify/Decompose/Transmute/etc)
            const alchemyContainer = document.querySelector('[class*="AlchemyPanel_tabsComponentContainer"]');
            const selectedTab =
                alchemyContainer?.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() || '';

            // Don't include infoText - it contains our profit display which causes update loops
            return `${selectedTab}:${successRate}:${consumables}:${catalyst}:${requirements}`;
        } catch {
            return '';
        }
    }
}

const alchemyProfit = new AlchemyProfit();

export default alchemyProfit;
