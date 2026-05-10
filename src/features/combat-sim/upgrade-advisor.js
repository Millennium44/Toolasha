/**
 * Upgrade Advisor for Combat Sim
 *
 * Generates equipment upgrade candidates, calculates their costs,
 * and runs simulations to rank them by "Gold per 0.01% improvement".
 */

import { buildGameDataPayload, calculateSimRevenue } from './combat-sim-adapter.js';
import { runSimulation } from './combat-sim-runner.js';
import { resolveItemPrice } from '../../utils/profit-helpers.js';
import { getItemPrices } from '../../utils/market-data.js';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { getEnhancingParams } from '../../utils/enhancement-config.js';
import { getCheapestProtectionPrice, getProductionCost } from '../enhancement/tooltip-enhancement.js';

/** Enhancement breakpoints: the next target level from any given current level */
const BREAKPOINTS = [7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20];

/**
 * Get the next enhancement breakpoint above the current level.
 * @param {number} currentLevel - Current enhancement level
 * @returns {number|null} Next breakpoint level, or null if already at max
 */
function getNextBreakpoint(currentLevel) {
    for (const bp of BREAKPOINTS) {
        if (bp > currentLevel) return bp;
    }
    return null;
}

/**
 * Calculate the gold cost of enhancing an item from startLevel to targetLevel.
 * Uses incremental cost approach: cost(0→target) - cost(0→start), matching
 * the tooltip's enhancement path calculation exactly.
 * @param {string} itemHrid - Item HRID
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {number} Expected gold cost
 */
function calculateEnhancementCost(itemHrid, startLevel, targetLevel, gameData) {
    const itemDetails = gameData.itemDetailMap[itemHrid];
    if (!itemDetails?.enhancementCosts || itemDetails.enhancementCosts.length === 0) {
        return 0;
    }

    const enhancingParams = getEnhancingParams();
    const itemLevel = itemDetails.itemLevel || 1;

    // Calculate per-attempt material cost (matches tooltip-enhancement pricing)
    let perAttemptCost = 0;
    for (const material of itemDetails.enhancementCosts) {
        let price = 0;
        if (material.itemHrid.startsWith('/items/trainee_')) {
            price = 250000;
        } else if (material.itemHrid === '/items/coin') {
            price = 1;
        } else {
            const marketPrice = getItemPrices(material.itemHrid, 0);
            if (marketPrice) {
                let ask = marketPrice.ask;
                let bid = marketPrice.bid;
                if (ask > 0 && bid < 0) bid = ask;
                if (bid > 0 && ask < 0) ask = bid;
                if (ask > 0) {
                    price = ask;
                }
            }
            // Fallback if no valid market ask
            if (price === 0) {
                const itemDetail = gameData.itemDetailMap[material.itemHrid];
                price = getProductionCost(material.itemHrid, 'ask') || itemDetail?.sellPrice || 0;
            }
        }
        perAttemptCost += price * material.count;
    }

    // Get cheapest protection price
    const { price: protPrice } = getCheapestProtectionPrice(itemHrid);

    // Calculate full path cost for each level from 1 to targetLevel
    // Find optimal protectFrom for each level (same approach as tooltip)
    // Then: incremental cost = fullCost(targetLevel) - fullCost(startLevel)
    const fullCost = new Array(targetLevel + 1).fill(0);

    for (let level = 1; level <= targetLevel; level++) {
        let bestCost = Infinity;

        // Try all protection strategies: no protection, protect from 2, 3, ..., level
        const protectOptions = [0];
        for (let pf = 2; pf <= level; pf++) {
            protectOptions.push(pf);
        }

        for (const protectFrom of protectOptions) {
            try {
                const result = calculateEnhancement({
                    enhancingLevel: enhancingParams.enhancingLevel,
                    toolBonus: enhancingParams.toolBonus,
                    speedBonus: enhancingParams.speedBonus || 0,
                    itemLevel,
                    targetLevel: level,
                    protectFrom,
                    blessedTea: enhancingParams.teas?.blessed || false,
                    guzzlingBonus: enhancingParams.guzzlingBonus || 1.0,
                });

                const materialCost = perAttemptCost * result.attempts;
                const protectionCost = protPrice * (result.protectionCount || 0);
                const totalForLevel = materialCost + protectionCost;

                if (totalForLevel < bestCost) {
                    bestCost = totalForLevel;
                }
            } catch {
                // Skip this strategy if calculation fails
            }
        }

        fullCost[level] = bestCost === Infinity ? 0 : bestCost;
    }

    // Incremental cost = cost to reach targetLevel - cost to reach startLevel
    return Math.max(0, Math.round(fullCost[targetLevel] - fullCost[startLevel]));
}

/**
 * Classify an item's combat role based on its primary offensive/defensive stats.
 * Items with the same role are valid tier comparison targets.
 * @param {Object} combatStats - equipmentDetail.combatStats
 * @returns {string} Role identifier
 */
function getItemRole(combatStats) {
    if (!combatStats) return 'unknown';

    // Check for elemental amplify — sub-classifies magic gear by element
    const fireAmp = combatStats.fireAmplify || 0;
    const natureAmp = combatStats.natureAmplify || 0;
    const waterAmp = combatStats.waterAmplify || 0;

    if (fireAmp > 0 || natureAmp > 0 || waterAmp > 0) {
        if (fireAmp >= natureAmp && fireAmp >= waterAmp) return 'magic_fire';
        if (natureAmp >= fireAmp && natureAmp >= waterAmp) return 'magic_nature';
        return 'magic_water';
    }

    // Check for primary offensive stats
    const melee = (combatStats.stabDamage || 0) + (combatStats.slashDamage || 0) + (combatStats.smashDamage || 0);
    const ranged = combatStats.rangedDamage || 0;
    const magic = combatStats.magicDamage || 0;

    // If item has offensive damage stats, classify by highest
    if (melee > 0 || ranged > 0 || magic > 0) {
        if (ranged >= melee && ranged >= magic) return 'ranged';
        if (magic >= melee && magic >= ranged) return 'magic';
        return 'melee';
    }

    // Check accuracy as secondary signal
    const meleeAcc =
        (combatStats.stabAccuracy || 0) + (combatStats.slashAccuracy || 0) + (combatStats.smashAccuracy || 0);
    const rangedAcc = combatStats.rangedAccuracy || 0;
    const magicAcc = combatStats.magicAccuracy || 0;

    if (meleeAcc > 0 || rangedAcc > 0 || magicAcc > 0) {
        if (rangedAcc >= meleeAcc && rangedAcc >= magicAcc) return 'ranged';
        if (magicAcc >= meleeAcc && magicAcc >= rangedAcc) return 'magic';
        return 'melee';
    }

    // Defensive/utility gear — armor, evasion, HP
    return 'defensive';
}

/**
 * Get equipment tier progression for a given slot, grouped by role.
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {Object} Map of "slot|role" → sorted item entries (weakest to strongest)
 */
export function getEquipmentTierProgression(gameData) {
    const progression = {};

    for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
        if (!item.equipmentDetail?.type) continue;
        if (!item.equipmentDetail.combatStats) continue;
        if (!hasCombatStats(item)) continue;

        const slot = item.equipmentDetail.type;
        const role = getItemRole(item.equipmentDetail.combatStats);
        const key = `${slot}|${role}`;
        if (!progression[key]) {
            progression[key] = [];
        }

        progression[key].push({
            hrid: itemHrid,
            itemLevel: item.itemLevel || 0,
            sortIndex: item.sortIndex ?? 9999,
            name: item.name,
        });
    }

    // Sort each group by itemLevel (primary), then refined after non-refined, then sortIndex
    for (const key of Object.keys(progression)) {
        progression[key].sort((a, b) => {
            if (a.itemLevel !== b.itemLevel) return a.itemLevel - b.itemLevel;
            const aRefined = a.hrid.endsWith('_refined') ? 1 : 0;
            const bRefined = b.hrid.endsWith('_refined') ? 1 : 0;
            if (aRefined !== bRefined) return aRefined - bRefined;
            return a.sortIndex - b.sortIndex;
        });
    }

    return progression;
}

/** Combat-relevant stats that affect simulation outcomes */
const COMBAT_STATS = new Set([
    'stabAccuracy',
    'slashAccuracy',
    'smashAccuracy',
    'rangedAccuracy',
    'magicAccuracy',
    'stabDamage',
    'slashDamage',
    'smashDamage',
    'rangedDamage',
    'magicDamage',
    'defensiveDamage',
    'taskDamage',
    'physicalAmplify',
    'waterAmplify',
    'natureAmplify',
    'fireAmplify',
    'healingAmplify',
    'stabEvasion',
    'slashEvasion',
    'smashEvasion',
    'rangedEvasion',
    'magicEvasion',
    'armor',
    'waterResistance',
    'natureResistance',
    'fireResistance',
    'maxHitpoints',
    'maxManapoints',
    'lifeSteal',
    'hpRegenPer10',
    'mpRegenPer10',
    'physicalThorns',
    'elementalThorns',
    'criticalRate',
    'criticalDamage',
    'armorPenetration',
    'waterPenetration',
    'naturePenetration',
    'firePenetration',
    'abilityHaste',
    'tenacity',
    'manaLeech',
    'castSpeed',
    'threat',
    'parry',
    'mayhem',
    'pierce',
    'curse',
    'fury',
    'weaken',
    'ripple',
    'bloom',
    'blaze',
    'attackSpeed',
    'autoAttackDamage',
    'abilityDamage',
    'retaliation',
    'maxHitpointsRatio',
    'maxManapointsRatio',
]);

/**
 * Check if an item has any combat-relevant stats (not just utility like foodSlots).
 * @param {Object} itemDetails - Item detail from itemDetailMap
 * @returns {boolean}
 */
function hasCombatStats(itemDetails) {
    if (!itemDetails?.equipmentDetail?.combatStats) return false;
    for (const stat of Object.keys(itemDetails.equipmentDetail.combatStats)) {
        if (COMBAT_STATS.has(stat) && itemDetails.equipmentDetail.combatStats[stat] !== 0) {
            return true;
        }
    }
    return false;
}

/**
 * Build a map of valid tier upgrades based on crafting/production chains.
 * An item X can upgrade to item Y if Y's crafting action uses X as:
 *   - upgradeItemHrid (direct upgrade chain), OR
 *   - one of its inputItems (combination recipes like Philosopher's)
 *
 * Only considers equipment outputs and equipment inputs.
 * @param {Object} gameData
 * @returns {Map<string, Set<string>>} itemHrid → Set of possible upgrade output hrids
 */
function buildUpgradeMap(gameData) {
    const map = new Map();

    for (const action of Object.values(gameData.actionDetailMap)) {
        if (!action.outputItems?.length) continue;
        const outputHrid = action.outputItems[0].itemHrid;

        // Only consider equipment outputs
        const outputItem = gameData.itemDetailMap[outputHrid];
        if (!outputItem?.equipmentDetail?.type) continue;

        // upgradeItemHrid → output (direct upgrade chain)
        if (action.upgradeItemHrid) {
            const upgradeItem = gameData.itemDetailMap[action.upgradeItemHrid];
            if (upgradeItem?.equipmentDetail?.type) {
                if (!map.has(action.upgradeItemHrid)) map.set(action.upgradeItemHrid, new Set());
                map.get(action.upgradeItemHrid).add(outputHrid);
            }
        }

        // inputItems → output (combination recipes like Philosopher's)
        if (action.inputItems) {
            for (const input of action.inputItems) {
                const inputItem = gameData.itemDetailMap[input.itemHrid];
                if (!inputItem?.equipmentDetail?.type) continue;

                if (!map.has(input.itemHrid)) map.set(input.itemHrid, new Set());
                map.get(input.itemHrid).add(outputHrid);
            }
        }
    }

    return map;
}

/**
 * Generate upgrade candidates for a player's equipment.
 * @param {Object} playerDTO - Player DTO with equipment
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @returns {Array} Candidates: [{slot, currentHrid, currentLevel, upgradeHrid, upgradeLevel, description, type}]
 */
export function generateCandidates(playerDTO, gameData) {
    const candidates = [];
    const tierProgression = getEquipmentTierProgression(gameData);
    const upgradeMap = buildUpgradeMap(gameData);

    for (const [slot, equip] of Object.entries(playerDTO.equipment)) {
        if (!equip) continue;

        const currentHrid = equip.hrid;
        const currentLevel = equip.enhancementLevel || 0;
        const itemDetails = gameData.itemDetailMap[currentHrid];

        // Skip trinkets and items with no combat stats (tools, etc.)
        if (slot === '/equipment_types/trinket') continue;
        if (!hasCombatStats(itemDetails)) continue;

        // Enhancement upgrade: next breakpoint
        const nextBP = getNextBreakpoint(currentLevel);
        if (nextBP) {
            const itemName = gameData.itemDetailMap[currentHrid]?.name || currentHrid.split('/').pop();
            candidates.push({
                slot,
                currentHrid,
                currentLevel,
                upgradeHrid: currentHrid,
                upgradeLevel: nextBP,
                description: `${itemName} +${currentLevel} → +${nextBP}`,
                type: 'enhancement',
            });
        }

        // Tier upgrade
        const role = getItemRole(itemDetails?.equipmentDetail?.combatStats);

        if (role === 'defensive') {
            // Defensive items: use crafting chain (upgrade path + combination recipes)
            const upgrades = upgradeMap.get(currentHrid);
            if (upgrades) {
                for (const upgradeHrid of upgrades) {
                    const upgradeItem = gameData.itemDetailMap[upgradeHrid];
                    if (!upgradeItem?.equipmentDetail) continue;
                    // Must be same slot
                    if (upgradeItem.equipmentDetail.type !== slot) continue;
                    // Must also be defensive (don't suggest offensive items)
                    const upgradeRole = getItemRole(upgradeItem.equipmentDetail?.combatStats);
                    if (upgradeRole !== 'defensive') continue;

                    const upgradeName = upgradeItem.name || upgradeHrid.split('/').pop();
                    const currentName = itemDetails?.name || currentHrid.split('/').pop();
                    candidates.push({
                        slot,
                        currentHrid,
                        currentLevel,
                        upgradeHrid,
                        upgradeLevel: currentLevel,
                        description: `${currentName} → ${upgradeName} (+${currentLevel})`,
                        type: 'tier',
                    });
                }
            }
        } else {
            // Offensive items: keep existing role-based tier progression
            const slotKey = `${slot}|${role}`;
            const slotItems = tierProgression[slotKey];
            if (slotItems) {
                const currentIdx = slotItems.findIndex((item) => item.hrid === currentHrid);
                if (currentIdx >= 0 && currentIdx < slotItems.length - 1) {
                    const nextTier = slotItems[currentIdx + 1];
                    const nextName = nextTier.name || nextTier.hrid.split('/').pop();
                    const currentName = gameData.itemDetailMap[currentHrid]?.name || currentHrid.split('/').pop();
                    candidates.push({
                        slot,
                        currentHrid,
                        currentLevel,
                        upgradeHrid: nextTier.hrid,
                        upgradeLevel: currentLevel,
                        description: `${currentName} → ${nextName} (+${currentLevel})`,
                        type: 'tier',
                    });
                }
            }
        }
    }

    return candidates;
}

/**
 * Calculate the total gold cost for a candidate upgrade.
 * Uses market prices as primary source (buy upgraded - sell current).
 * Falls back to enhancement cost estimate if market data unavailable.
 * @param {Object} candidate - Candidate from generateCandidates()
 * @param {Object} gameData - Game data
 * @returns {number} Total gold cost
 */
export function calculateUpgradeCost(candidate, gameData) {
    if (candidate.type === 'enhancement') {
        // Primary: market price delta (buy at target level - sell at current level)
        // Only use if BOTH levels have actual market listings
        const upgradedMarket = getItemPrices(candidate.currentHrid, candidate.upgradeLevel);
        const currentMarket = getItemPrices(candidate.currentHrid, candidate.currentLevel);

        if (upgradedMarket?.ask > 0 && currentMarket?.bid > 0) {
            return Math.max(0, upgradedMarket.ask - currentMarket.bid);
        }

        // Fallback: enhancement cost estimate with protection
        return calculateEnhancementCost(
            candidate.currentHrid,
            candidate.currentLevel,
            candidate.upgradeLevel,
            gameData
        );
    }

    // Tier upgrade: buy new item at same enhancement - sell current item
    const buyPrice = resolveItemPrice(candidate.upgradeHrid, {
        side: 'buy',
        enhancementLevel: candidate.upgradeLevel,
    }).price;
    const sellPrice = resolveItemPrice(candidate.currentHrid, {
        side: 'sell',
        enhancementLevel: candidate.currentLevel,
    }).price;

    return Math.max(0, buyPrice - sellPrice);
}

/**
 * Run the full upgrade analysis: baseline sim + one sim per candidate.
 * @param {Object} params - { playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs }
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline, results: [{candidate, cost, metrics, deltas, goldPer}] }
 */
export async function runUpgradeAnalysis(params, onProgress, options = {}) {
    const { playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const playerDTO = playerDTOs[playerIndex];
    const playerHrid = playerDTO.hrid;

    // Generate candidates and compute costs
    const candidates = generateCandidates(playerDTO, gameData);
    const candidatesWithCost = candidates.map((c) => ({
        ...c,
        cost: calculateUpgradeCost(c, gameData),
    }));

    const total = candidatesWithCost.length + 1; // +1 for baseline
    let current = 0;

    // Run baseline sim
    onProgress?.({ current: 0, total, description: 'Running baseline...' });
    const baselineResult = await runSimulation(
        { gameData, playerDTOs, zoneHrid, difficultyTier, hours, communityBuffs },
        null
    );
    current++;

    if (abortSignal?.()) return { baseline: null, results: [] };

    onProgress?.({ current, total, description: 'Baseline complete' });

    // Calculate baseline metrics
    const baselineMetrics = computeMetrics(baselineResult, gameData, playerHrid, hours);

    // Run sim for each candidate
    const results = [];
    for (const candidate of candidatesWithCost) {
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Simulating: ${candidate.description}` });

        // Clone playerDTOs and swap equipment
        const modifiedDTOs = JSON.parse(JSON.stringify(playerDTOs));
        modifiedDTOs[playerIndex].equipment[candidate.slot] = {
            hrid: candidate.upgradeHrid,
            enhancementLevel: candidate.upgradeLevel,
        };

        const simResult = await runSimulation(
            { gameData, playerDTOs: modifiedDTOs, zoneHrid, difficultyTier, hours, communityBuffs },
            null
        );

        if (abortSignal?.()) break;

        const metrics = computeMetrics(simResult, gameData, playerHrid, hours);
        const deltas = computeDeltas(baselineMetrics, metrics);
        const goldPer = computeGoldPerImprovement(candidate.cost, deltas);

        results.push({ candidate, cost: candidate.cost, metrics, deltas, goldPer });
        current++;
        onProgress?.({ current, total, description: candidate.description });
    }

    // Sort by best value (lowest gold per 0.01% DPS improvement)
    results.sort((a, b) => {
        const aVal = a.goldPer.dps === Infinity ? Number.MAX_VALUE : a.goldPer.dps;
        const bVal = b.goldPer.dps === Infinity ? Number.MAX_VALUE : b.goldPer.dps;
        return aVal - bVal;
    });

    return { baseline: baselineMetrics, results };
}

/**
 * Compute key metrics from a sim result.
 */
function computeMetrics(simResult, gameData, playerHrid, hours) {
    const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;
    const xp = simResult.experienceGained?.[playerHrid] || {};
    const totalXpPerHour = Object.values(xp).reduce((s, v) => s + v, 0) / simHours;
    const deaths = (simResult.deaths?.[playerHrid] || 0) / simHours;

    // Profit/hr
    const revenue = calculateSimRevenue(simResult, gameData, playerHrid, simHours);

    return {
        xpPerHour: totalXpPerHour,
        profitPerHour: revenue.netPerHour,
        deathsPerHour: deaths,
        dps: totalXpPerHour, // Total combat XP/hr as DPS proxy
    };
}

/**
 * Compute percentage deltas between baseline and upgraded metrics.
 */
function computeDeltas(baseline, upgraded) {
    const pctDelta = (base, upg) => {
        if (base === 0) return upg > 0 ? 100 : 0;
        return ((upg - base) / Math.abs(base)) * 100;
    };

    return {
        dps: pctDelta(baseline.dps, upgraded.dps),
        xp: pctDelta(baseline.xpPerHour, upgraded.xpPerHour),
        profit: pctDelta(baseline.profitPerHour, upgraded.profitPerHour),
    };
}

/**
 * Compute gold per 0.01% improvement for each metric.
 * Lower = better value.
 */
function computeGoldPerImprovement(cost, deltas) {
    const goldPer = (pctDelta) => {
        if (pctDelta <= 0) return Infinity;
        // Gold per 0.01% = cost / (pctDelta * 10000)
        // But pctDelta is already in percent, so:
        // e.g., 2% delta = cost / (2 * 100) = cost per 0.01%
        return cost / (pctDelta * 100);
    };

    return {
        dps: goldPer(deltas.dps),
        xp: goldPer(deltas.xp),
        profit: goldPer(deltas.profit),
    };
}

export default {
    generateCandidates,
    calculateUpgradeCost,
    runUpgradeAnalysis,
    getEquipmentTierProgression,
};
