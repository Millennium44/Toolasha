/**
 * Combat Statistics Calculator
 * Calculates income, profit, consumable costs, and other statistics
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import marketAPI from '../../api/marketplace.js';
import expectedValueCalculator from '../market/expected-value-calculator.js';
import { DUNGEON_CHEST_ENTRY_KEYS, DUNGEON_CHEST_CHEST_KEYS } from '../../utils/dungeon-keys.js';
import { describeKeyCost, getKeyPricingMode } from '../../utils/key-cost.js';
import { treasureTracker } from '../../utils/bundle-bridge.js';
import { MARKET_TAX, COWBELL_BAG_HRID, COWBELL_BAG_TAX } from '../../utils/profit-constants.js';
import { salesTaxNetted } from './sales-tax-view.js';

/**
 * Below this many openings a treasure reading is luck, not a rate.
 *
 * The adjustment exists to capture persistent effects — a level gap, a build —
 * and at a few hundred openings the sampling noise on the return falls under
 * the size of the effects worth adjusting for.
 */
export const MIN_OPENED_FOR_PROFIT_ADJUST = 300;

/**
 * How the player's own measured treasure rate should scale one dungeon chest's EV.
 *
 * The measurement is the treasure tracker's ledger — what actually came out of
 * this chest kind across every recorded opening, against the drop table's
 * expectation, both at today's prices. Only when the `dropLuck_profitAdjust`
 * setting is on, only for the regular dungeon chests a completion pays (never
 * other openables), and only when at least {@link MIN_OPENED_FOR_PROFIT_ADJUST}
 * openings back the reading — otherwise null, and the estimate stays at the
 * drop-table expectation.
 *
 * The tracker is reached through the global rather than imported: it lives in
 * the market bundle, this calculator is carried by others, and a second copy
 * of the tracker would be a second, empty ledger.
 *
 * @param {string} itemHrid - The loot item
 * @returns {{ratio: number, chests: number}|null} Null when no adjustment applies
 */
function chestLuckAdjustment(itemHrid) {
    if (!DUNGEON_CHEST_ENTRY_KEYS[itemHrid]) return null;
    if (!config.getSetting('dropLuck_profitAdjust')) return null;

    const measured = treasureTracker()?.measuredReturn?.(itemHrid);
    if (!measured || !(measured.opened >= MIN_OPENED_FOR_PROFIT_ADJUST)) return null;
    return { ratio: measured.ratio, chests: measured.opened };
}

/**
 * The adjustment in words, for wherever an adjusted figure is shown.
 *
 * The adjustment must never be silent: a profit estimate scaled by a personal
 * measurement has to say so, or it reads as the drop-table expectation it no
 * longer is.
 *
 * @param {{itemName: string, ratio: number, chests: number}} adjustment - One
 *   entry from `chestLuckAdjustments`
 * @returns {string} e.g. "Chimerical Chest EV adjusted by your measured -7.4% return (5,490 opened)"
 */
export function describeLuckAdjustment(adjustment) {
    const percent = (adjustment.ratio - 1) * 100;
    const signed = `${percent >= 0 ? '+' : ''}${percent.toFixed(1)}%`;
    const chests = Math.round(adjustment.chests).toLocaleString('en-US');
    return `${adjustment.itemName} EV adjusted by your measured ${signed} return (${chests} opened)`;
}

/**
 * Calculate total income from loot
 * @param {Object} lootMap - totalLootMap from player data
 * @returns {Object} { ask: number, bid: number }
 */
export function calculateIncome(lootMap) {
    let totalAsk = 0;
    let totalBid = 0;

    if (!lootMap) {
        return { ask: 0, bid: 0 };
    }

    for (const loot of Object.values(lootMap)) {
        const itemCount = loot.count;

        // Coins are revenue at face value (1 coin = 1 gold)
        if (loot.itemHrid === '/items/coin') {
            totalAsk += itemCount;
            totalBid += itemCount;
        } else {
            const itemDetails = dataManager.getItemDetails(loot.itemHrid);
            if (itemDetails?.isOpenable) {
                // Openable containers (chests, crates, etc.): use expected value
                const ev =
                    expectedValueCalculator.getCachedValue(loot.itemHrid) ||
                    expectedValueCalculator.calculateSingleContainer(loot.itemHrid);
                if (ev !== null && ev > 0) {
                    // A dungeon chest may be worth what *this player* measures
                    // it at rather than what the table promises — see
                    // `chestLuckAdjustment`; null means no adjustment
                    const adjustment = chestLuckAdjustment(loot.itemHrid);
                    const adjustedEv = adjustment ? ev * adjustment.ratio : ev;
                    totalAsk += adjustedEv * itemCount;
                    totalBid += adjustedEv * itemCount;
                }
            } else {
                // Other items: get market price
                const prices = marketAPI.getPrice(loot.itemHrid);
                if (prices) {
                    // Drops are sold on the market, so the sale tax comes off
                    // what they fetch when the reader has asked for net income.
                    // Coin is handled above (face value, never sold); containers
                    // use an expected value that is already net of the tax.
                    const mult = salesTaxNetted()
                        ? 1 - (loot.itemHrid === COWBELL_BAG_HRID ? COWBELL_BAG_TAX : MARKET_TAX)
                        : 1;
                    totalAsk += prices.ask * itemCount * mult;
                    totalBid += prices.bid * itemCount * mult;
                }
            }
        }
    }

    return { ask: totalAsk, bid: totalBid };
}

/**
 * Build per-chest income breakdown for expandable Income display
 * Only marks isDungeonRun when regular dungeon chests are present
 * @param {Object} lootMap - totalLootMap from player data
 * @returns {Object} { isDungeonRun: boolean, breakdown: Array }
 */
export function calculateIncomeBreakdown(lootMap) {
    if (!lootMap) {
        return { isDungeonRun: false, breakdown: [] };
    }

    let isDungeonRun = false;
    const breakdown = [];

    for (const loot of Object.values(lootMap)) {
        const itemDetails = dataManager.getItemDetails(loot.itemHrid);
        if (!itemDetails?.isOpenable) {
            continue;
        }

        if (DUNGEON_CHEST_ENTRY_KEYS[loot.itemHrid]) {
            isDungeonRun = true;
        }

        const evData = expectedValueCalculator.isInitialized
            ? expectedValueCalculator.calculateExpectedValue(loot.itemHrid)
            : null;
        const baseEv = evData?.expectedValue ?? 0;
        // Carried on the row rather than applied silently, so the display can
        // mark the figure and say what moved it
        const luckAdjustment = baseEv > 0 ? chestLuckAdjustment(loot.itemHrid) : null;
        const evPerChest = luckAdjustment ? baseEv * luckAdjustment.ratio : baseEv;
        const totalValue = evPerChest * loot.count;

        breakdown.push({
            itemHrid: loot.itemHrid,
            itemName: itemDetails.name,
            count: loot.count,
            evPerChest,
            totalValue,
            luckAdjustment,
            drops: evData?.drops ?? [],
        });
    }

    return { isDungeonRun, breakdown };
}

/**
 * Calculate entry and chest key costs from dungeon chests dropped
 *
 * Each regular dungeon chest in the loot map represents one entry key consumed,
 * and every chest (regular or refinement) represents one chest key.
 *
 * A key is costed at whichever of buying and crafting it is cheaper — see
 * `src/utils/key-cost.js`. The alternative and the crafting time ride along in
 * the breakdown so the display can show the choice rather than hide it. A key
 * that is neither on the market nor craftable is skipped, as before: an unknown
 * cost is not a zero one, and pretending otherwise would inflate profit.
 *
 * @param {Object} lootMap - totalLootMap from player data
 * @param {number} durationSeconds - Combat duration in seconds (for daily rate)
 * @returns {Object} { ask, bid, dailyCost, breakdown, pricingMode }
 */
export function calculateKeyCosts(lootMap, durationSeconds) {
    let totalCost = 0;
    const breakdown = [];
    const keyPricingSetting = getKeyPricingMode();

    if (!lootMap) {
        return { ask: 0, bid: 0, dailyCost: 0, breakdown: [], pricingMode: keyPricingSetting };
    }

    // Shared across every key in the run: dungeon key recipes lean on the same
    // materials, and costing them one key at a time re-derives the same tree.
    const memo = new Map();
    const actionStats = new Map();
    const costOf = (keyHrid) => describeKeyCost(keyHrid, { mode: keyPricingSetting, memo, actionStats });

    const addRow = (keyHrid, count) => {
        const keyCost = costOf(keyHrid);
        if (keyCost.unitCost === null) return;

        const itemCost = keyCost.unitCost * count;
        totalCost += itemCost;

        const consumedPerDay = durationSeconds > 0 ? Math.ceil((count / durationSeconds) * 86400) : 0;

        breakdown.push({
            itemHrid: keyHrid,
            itemName: keyCost.itemName,
            count,
            consumedPerDay,
            pricePerItem: keyCost.unitCost,
            totalCost: itemCost,
            keyCost,
        });
    };

    for (const loot of Object.values(lootMap)) {
        const keyHrid = DUNGEON_CHEST_ENTRY_KEYS[loot.itemHrid];
        if (!keyHrid) continue;
        addRow(keyHrid, loot.count);
    }

    // Second pass: aggregate chest key costs (regular + refinement chests share the same key)
    const chestKeyCounts = {};
    for (const loot of Object.values(lootMap)) {
        const keyHrid = DUNGEON_CHEST_CHEST_KEYS[loot.itemHrid];
        if (!keyHrid) continue;
        chestKeyCounts[keyHrid] = (chestKeyCounts[keyHrid] || 0) + loot.count;
    }

    for (const [keyHrid, count] of Object.entries(chestKeyCounts)) {
        addRow(keyHrid, count);
    }

    const finalDailyCost = durationSeconds > 0 ? calculateDailyRate(totalCost, durationSeconds) : 0;

    return { ask: totalCost, bid: totalCost, dailyCost: finalDailyCost, breakdown, pricingMode: keyPricingSetting };
}

/**
 * Calculate consumable costs based on actual consumption with baseline estimates
 * Uses weighted average: 90% actual data + 10% baseline estimate (like MCS)
 * @param {Array} consumables - combatConsumables array from player data (with consumed field)
 * @param {number} durationSeconds - Combat duration in seconds
 * @returns {Object} { total: number, breakdown: Array } Total cost and per-item breakdown
 */
export function calculateConsumableCosts(consumables, durationSeconds) {
    if (!consumables || consumables.length === 0 || !durationSeconds || durationSeconds <= 0) {
        return { total: 0, breakdown: [] };
    }

    let totalCost = 0;
    const breakdown = [];

    for (const consumable of consumables) {
        const consumed = consumable.consumed || 0;
        const actualConsumed = consumable.actualConsumed || 0;
        const _elapsedSeconds = consumable.elapsedSeconds || 0;

        // Skip if no consumption (even estimated)
        if (consumed <= 0) {
            continue;
        }

        const prices = marketAPI.getPrice(consumable.itemHrid);
        const itemPrice = prices ? prices.ask : 500;
        const itemCost = itemPrice * consumed;

        totalCost += itemCost;

        // Get item name from data manager
        const itemDetails = dataManager.getItemDetails(consumable.itemHrid);
        const itemName = itemDetails?.name || consumable.itemHrid;

        breakdown.push({
            itemHrid: consumable.itemHrid,
            itemName: itemName,
            count: consumed,
            consumedPerDay: consumable.consumedPerDay || 0,
            pricePerItem: itemPrice,
            totalCost: itemCost,
            startingCount: consumable.startingCount,
            currentCount: consumable.currentCount,
            actualConsumed: actualConsumed,
            defaultConsumed: consumable.defaultConsumed || 0,
            consumptionRate: consumable.consumptionRate,
            elapsedSeconds: consumable.elapsedSeconds || 0,
            inventoryAmount: consumable.inventoryAmount || consumable.currentCount,
            timeToZeroSeconds: consumable.timeToZeroSeconds || Infinity,
        });
    }

    return { total: totalCost, breakdown };
}

/**
 * Calculate total experience
 * @param {Object} experienceMap - totalSkillExperienceMap from player data
 * @returns {number} Total experience
 */
export function calculateTotalExperience(experienceMap) {
    if (!experienceMap) {
        return 0;
    }

    let total = 0;
    for (const exp of Object.values(experienceMap)) {
        total += exp;
    }

    return total;
}

/**
 * Calculate daily rate
 * @param {number} total - Total value
 * @param {number} durationSeconds - Duration in seconds
 * @returns {number} Value per day
 */
export function calculateDailyRate(total, durationSeconds) {
    if (durationSeconds <= 0) {
        return 0;
    }

    const durationDays = durationSeconds / 86400; // 86400 seconds in a day
    return total / durationDays;
}

/**
 * Format loot items for display
 * @param {Object} lootMap - totalLootMap from player data
 * @returns {Array} Array of { count, itemHrid, itemName, rarity }
 */
export function formatLootList(lootMap) {
    if (!lootMap) {
        return [];
    }

    const items = [];

    for (const loot of Object.values(lootMap)) {
        const itemDetails = dataManager.getItemDetails(loot.itemHrid);

        let totalValue = 0;
        if (loot.itemHrid === '/items/coin') {
            totalValue = loot.count;
        } else if (itemDetails?.isOpenable) {
            const ev =
                expectedValueCalculator.getCachedValue(loot.itemHrid) ||
                expectedValueCalculator.calculateSingleContainer(loot.itemHrid);
            if (ev !== null && ev > 0) {
                totalValue = ev * loot.count;
            }
        } else {
            const prices = marketAPI.getPrice(loot.itemHrid);
            if (prices) {
                totalValue = prices.ask * loot.count;
            }
        }

        items.push({
            count: loot.count,
            itemHrid: loot.itemHrid,
            itemName: itemDetails?.name || 'Unknown',
            rarity: itemDetails?.rarity || 0,
            totalValue,
        });
    }

    // Sort by total value descending, then by name for ties
    items.sort((a, b) => {
        if (b.totalValue !== a.totalValue) {
            return b.totalValue - a.totalValue;
        }
        return a.itemName.localeCompare(b.itemName);
    });

    return items;
}

/**
 * Calculate all statistics for a player
 * @param {Object} playerData - Player data from combat data
 * @param {number|null} durationSeconds - Combat duration in seconds (from DOM or null)
 * @returns {Object} Calculated statistics
 */
export function calculatePlayerStats(playerData, durationSeconds = null) {
    // Calculate income
    const income = calculateIncome(playerData.loot);
    const incomeBreakdownData = calculateIncomeBreakdown(playerData.loot);

    // Every chest whose EV was scaled by the player's measured luck, so each
    // display of income or profit can label the adjustment
    const chestLuckAdjustments = incomeBreakdownData.breakdown
        .filter((row) => row.luckAdjustment)
        .map((row) => ({ itemName: row.itemName, ...row.luckAdjustment }));

    // Use provided duration or default to 0 (will show 0 for rates if no duration)
    const duration = durationSeconds || 0;

    // Calculate daily income
    const dailyIncomeAsk = duration > 0 ? calculateDailyRate(income.ask, duration) : 0;
    const dailyIncomeBid = duration > 0 ? calculateDailyRate(income.bid, duration) : 0;

    // Calculate consumable costs based on ACTUAL consumption
    const consumableData = calculateConsumableCosts(playerData.consumables, duration);
    const consumableCosts = consumableData.total;
    const consumableBreakdown = consumableData.breakdown;

    // Calculate daily consumable costs using pre-calculated per-day rates (MCS-style)
    const dailyConsumableCosts = consumableBreakdown.reduce(
        (sum, item) => sum + (item.consumedPerDay || 0) * item.pricePerItem,
        0
    );

    // Calculate entry key costs (1:1 with regular dungeon chests dropped)
    const keyData = calculateKeyCosts(playerData.loot, duration);
    const keyCosts = { ask: keyData.ask, bid: keyData.bid };
    const dailyKeyCosts = keyData.dailyCost;
    const keyBreakdown = keyData.breakdown;
    const keyPricingMode = keyData.pricingMode;

    // Calculate daily profit (income minus consumables and key costs)
    const dailyProfitAsk = dailyIncomeAsk - dailyConsumableCosts - dailyKeyCosts;
    const dailyProfitBid = dailyIncomeBid - dailyConsumableCosts - dailyKeyCosts;

    // Calculate total experience
    const totalExp = calculateTotalExperience(playerData.experience);

    // Calculate experience per hour
    const expPerHour = duration > 0 ? (totalExp / duration) * 3600 : 0;

    // Calculate deaths per hour
    const deathsPerHour = duration > 0 ? (playerData.deathCount / duration) * 3600 : 0;

    // Format loot list
    const lootList = formatLootList(playerData.loot);

    return {
        name: playerData.name,
        income: {
            ask: income.ask,
            bid: income.bid,
        },
        dailyIncome: {
            ask: dailyIncomeAsk,
            bid: dailyIncomeBid,
        },
        consumableCosts,
        consumableBreakdown,
        dailyConsumableCosts,
        keyCosts,
        dailyKeyCosts,
        keyBreakdown,
        keyPricingMode,
        dailyProfit: {
            ask: dailyProfitAsk,
            bid: dailyProfitBid,
        },
        totalExp,
        expPerHour,
        deathCount: playerData.deathCount,
        deathsPerHour,
        lootList,
        incomeBreakdown: incomeBreakdownData.breakdown,
        isDungeonRun: incomeBreakdownData.isDungeonRun,
        chestLuckAdjustments,
        duration,
    };
}

/**
 * Calculate statistics for all players
 * @param {Object} combatData - Combat data from data collector
 * @param {number|null} durationSeconds - Combat duration in seconds (from DOM or null)
 * @returns {Array} Array of player statistics
 */
export function calculateAllPlayerStats(combatData, durationSeconds = null) {
    if (!combatData || !combatData.players) {
        return [];
    }

    // Calculate encounters per hour (EPH)
    const duration = durationSeconds || combatData.durationSeconds || 0;
    const battleId = combatData.battleId || 1;
    const encountersPerHour = duration > 0 ? (3600 * (battleId - 1)) / duration : 0;

    return combatData.players.map((player) => {
        const stats = calculatePlayerStats(player, durationSeconds);
        // Add EPH and formatted duration to each player's stats
        stats.encountersPerHour = encountersPerHour;
        stats.durationFormatted = formatDuration(duration);
        return stats;
    });
}

/**
 * Format duration in seconds to human-readable format
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted duration (e.g., "1h 23m", "3d 12h", "2mo 15d")
 */
function formatDuration(seconds) {
    if (!seconds || seconds <= 0) {
        return '0s';
    }

    if (seconds < 60) return `${Math.floor(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }

    // Days
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    if (d >= 365) {
        const years = Math.floor(d / 365);
        const days = d % 365;
        if (days >= 30) {
            const months = Math.floor(days / 30);
            return `${years}y ${months}mo`;
        }
        return days > 0 ? `${years}y ${days}d` : `${years}y`;
    }
    if (d >= 30) {
        const months = Math.floor(d / 30);
        const days = d % 30;
        return days > 0 ? `${months}mo ${days}d` : `${months}mo`;
    }
    return h > 0 ? `${d}d ${h}h` : `${d}d`;
}
