/**
 * Upgrade Advisor for Combat Sim
 *
 * Generates equipment upgrade candidates, calculates their costs,
 * and runs simulations to rank them by "Gold per 0.01% improvement".
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import {
    buildGameDataPayload,
    calculateSimRevenue,
    getGuildBuffDetailMap,
    guildBuffMaxLevel,
    applyGuildBuffLevel,
} from './combat-sim-adapter.js';
import { runSimulation, runLabyrinthSimulation, getMaxWorkers } from './combat-sim-runner.js';
import { buildBuffDrinkPools, estimateFoodSimCount, runFoodOptimization } from './food-optimizer.js';
import { generateLabArmorCandidates } from './lab-armor-candidates.js';
import { bestGearForSkill } from './skilling-gear-candidates.js';
import { deriveSeed, randomSeed } from './engine/rng.js';
import labyrinthClearRate from '../combat/labyrinth-clear-rate.js';
import { resolveItemPrice } from '../../utils/profit-helpers.js';
import { getItemPrices } from '../../utils/market-data.js';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { getEnhancingParams, getAutoDetectedParams } from '../../utils/enhancement-config.js';
import { getCheapestProtectionPrice, getProductionCost } from '../enhancement/tooltip-enhancement.js';
import { explainAbilityLevelUpCost } from '../../utils/ability-cost-calculator.js';
import { buildOverridesForSkill } from './skilling-sim-helpers.js';
import { priceGuildCreditCosts } from '../../utils/guild-credit-pricing.js';

/** Enhancement breakpoints by slot type */
const BREAKPOINTS_DEFAULT = [7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const BREAKPOINTS_JEWELRY = [5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const BREAKPOINTS_BACK = [3, 5, 7, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20];
const BREAKPOINTS_REFINED = [10, 12, 13, 14, 15, 16, 17, 18, 19, 20];

const JEWELRY_SLOTS = new Set(['/equipment_types/earrings', '/equipment_types/ring', '/equipment_types/neck']);

/** Philosopher's accessories are always offered from this enhancement level */
const PHILO_START_LEVEL = 5;
const PHILO_HRID_PREFIX = '/items/philosophers_';

const CHARM_SLOT = '/equipment_types/charm';
const TRINKET_SLOT = '/equipment_types/trinket';
const MAIN_HAND_SLOT = '/equipment_types/main_hand';
const OFF_HAND_SLOT = '/equipment_types/off_hand';
const TWO_HAND_SLOT = '/equipment_types/two_hand';

/** Highest level a house room can reach */
const MAX_HOUSE_LEVEL = 8;

/**
 * Seed for one analysis run, or null to leave every sim on independent randomness.
 * Sharing a seed across the baseline and all candidates cancels the shared random
 * draws out of each delta; the setting exists because it also freezes the luck of
 * one particular sample into the absolute numbers.
 * @returns {number|null} Analysis seed
 */
function analysisSeed() {
    return config.getSettingValue('combatSim_sharedSeed', true) ? randomSeed() : null;
}

/** Combat skills evaluated by the Combat Levels advisor mode */
const COMBAT_LEVEL_SKILLS = [
    { key: 'staminaLevel', label: 'Stamina' },
    { key: 'intelligenceLevel', label: 'Intelligence' },
    { key: 'attackLevel', label: 'Attack' },
    { key: 'meleeLevel', label: 'Melee' },
    { key: 'defenseLevel', label: 'Defense' },
    { key: 'rangedLevel', label: 'Ranged' },
    { key: 'magicLevel', label: 'Magic' },
];

/**
 * Find the charm to wear while leveling a given combat skill: the equivalent
 * of the player's current charm attuned to that skill (matched by name tier,
 * e.g. "Expert Melee Charm" → "Expert Defense Charm"), or the highest-tier
 * charm for the skill when tiers can't be matched. Keeps the current charm's
 * enhancement level. Null when no charm for the skill exists.
 * @param {Object|null} currentCharm - Equipped charm ({hrid, enhancementLevel}) or null
 * @param {string} skillKey - DTO level key, e.g. "defenseLevel"
 * @param {Object} gameData - Game data
 * @param {string} [charmTier='auto'] - 'auto' (match the equipped charm's tier),
 *   'none' (no charm), or an explicit tier name prefix (e.g. 'Expert')
 * @returns {Object|null} Charm equipment entry or null
 */
export function findMatchingCharmForSkill(currentCharm, skillKey, gameData, charmTier = 'auto') {
    if (charmTier === 'none') return null;

    const skillName = skillKey.replace('Level', '');
    const targetFocus = `/skills/${skillName}`;
    const enhancementLevel = currentCharm?.enhancementLevel || 0;

    const currentDetail = currentCharm ? gameData.itemDetailMap[currentCharm.hrid] : null;
    // Explicit tier selection overrides matching from the equipped charm
    const tierPrefix = charmTier && charmTier !== 'auto' ? charmTier : currentDetail?.name?.split(' ')[0] || null;

    if (charmTier === 'auto' && currentDetail?.equipmentDetail?.combatStats?.focusTraining === targetFocus) {
        return { ...currentCharm };
    }

    let fallback = null;
    for (const [hrid, detail] of Object.entries(gameData.itemDetailMap)) {
        if (detail?.equipmentDetail?.type !== CHARM_SLOT) continue;
        if (detail.equipmentDetail.combatStats?.focusTraining !== targetFocus) continue;
        if (tierPrefix && detail.name?.startsWith(`${tierPrefix} `)) {
            return { hrid, enhancementLevel };
        }
        if (!fallback || (detail.itemLevel || 0) > (gameData.itemDetailMap[fallback.hrid]?.itemLevel || 0)) {
            fallback = { hrid, enhancementLevel };
        }
    }
    return fallback;
}

/** Offensive combat skills a weapon can train — the "main" skills of a style */
const OFFENSE_SKILLS = new Set(['attack', 'melee', 'ranged', 'magic']);

/**
 * Main skills trained by the player's weapon: the weapon's primary training
 * skill plus the offensive skills in its combat style's XP map (a melee-only
 * weapon trains melee; a spear trains attack and melee). Stamina/Intelligence/
 * Defense appear in every style's XP map and are deliberately excluded — they
 * aren't what the weapon is "for".
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @returns {Array<string>} Skill names, e.g. ['attack', 'melee']
 */
export function getMainTrainingSkills(playerDTO, gameData) {
    const weapon =
        playerDTO.equipment?.['/equipment_types/main_hand'] || playerDTO.equipment?.['/equipment_types/two_hand'];
    const stats = weapon ? gameData.itemDetailMap[weapon.hrid]?.equipmentDetail?.combatStats : null;
    const skills = new Set();

    const primary = stats?.primaryTraining;
    if (primary) skills.add(primary.split('/').pop());

    const styleHrid = stats?.combatStyleHrids?.[0];
    const skillExpMap = styleHrid ? gameData.combatStyleDetailMap?.[styleHrid]?.skillExpMap : null;
    if (skillExpMap) {
        for (const skillHrid of Object.keys(skillExpMap)) {
            const skillName = skillHrid.split('/').pop();
            if (OFFENSE_SKILLS.has(skillName)) {
                skills.add(skillName);
            }
        }
    }

    if (skills.size === 0) skills.add('melee');
    return [...skills];
}

/**
 * Combat skill keys irrelevant to the player's weapon style, excluded from
 * Combat Levels candidates: melee weapons don't sim Ranged/Magic, ranged
 * weapons don't sim Melee/Magic, magic weapons don't sim Melee/Ranged.
 * Attack is never excluded — it trains under every style (directly with a
 * spear, via the XP split otherwise). Unarmed counts as melee (the engine
 * sims it as smash); a weapon whose style can't be determined excludes
 * nothing.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @returns {Set<string>} Excluded DTO level keys, e.g. {'rangedLevel', 'magicLevel'}
 */
export function getStyleExcludedSkills(playerDTO, gameData) {
    const weapon =
        playerDTO.equipment?.['/equipment_types/main_hand'] || playerDTO.equipment?.['/equipment_types/two_hand'];
    const stats = weapon ? gameData.itemDetailMap[weapon.hrid]?.equipmentDetail?.combatStats : null;
    const style = weapon ? getItemDamageStyle(stats) : 'smash';
    if (style === 'ranged') return new Set(['meleeLevel', 'magicLevel']);
    if (style === 'magic') return new Set(['meleeLevel', 'rangedLevel']);
    if (style === 'unknown') return new Set();
    return new Set(['rangedLevel', 'magicLevel']);
}

/**
 * Get the next ability level target (next multiple of 10) above the current level.
 * Used as fallback when no explicit target level is provided.
 * @param {number} currentLevel - Current ability level
 * @returns {number|null} Next target level, or null if at max (200)
 */
function getNextAbilityBreakpoint(currentLevel) {
    const next = Math.ceil((currentLevel + 1) / 10) * 10;
    return next <= 200 ? next : null;
}

/**
 * Get the next enhancement breakpoint above the current level.
 * Uses slot-specific breakpoints: jewelry gets +5, back gets +3/+5,
 * refined items start at +10 minimum — except capes (back slot), the one
 * item type reasonably refined below +10, which keep the back breakpoints.
 * @param {number} currentLevel - Current enhancement level
 * @param {string} slot - Equipment slot HRID
 * @param {string} itemHrid - Item HRID (used to detect refined items)
 * @returns {number|null} Next breakpoint level, or null if already at max
 */
function getNextBreakpoint(currentLevel, slot, itemHrid) {
    let breakpoints;
    if (slot === '/equipment_types/back') {
        breakpoints = BREAKPOINTS_BACK;
    } else if (itemHrid.includes('_refined')) {
        breakpoints = BREAKPOINTS_REFINED;
    } else if (JEWELRY_SLOTS.has(slot)) {
        breakpoints = BREAKPOINTS_JEWELRY;
    } else {
        breakpoints = BREAKPOINTS_DEFAULT;
    }

    for (const bp of breakpoints) {
        if (bp > currentLevel) return bp;
    }
    return null;
}

/**
 * Find the Philosopher's accessory for a jewelry slot.
 * @param {string} slot - Equipment type hrid
 * @param {Object} gameData
 * @returns {{hrid: string, name: string}|null}
 */
function findPhiloAccessory(slot, gameData) {
    for (const [hrid, detail] of Object.entries(gameData.itemDetailMap || {})) {
        if (!hrid.startsWith(PHILO_HRID_PREFIX)) continue;
        if (detail?.equipmentDetail?.type !== slot) continue;
        return { hrid, name: detail.name || hrid.split('/').pop() };
    }
    return null;
}

/**
 * Offer Philosopher's accessories at +5 for every jewelry slot, regardless of
 * how enhanced the current accessory is. The normal tier/enhancement paths only
 * propose swaps at the current enhancement level, which hides the cheap +5
 * entry point behind, say, a +12 rebuy for someone wearing +12 jewelry.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @param {Array} candidates - Candidate list (mutated)
 */
function addPhiloAccessoryCandidates(playerDTO, gameData, candidates) {
    for (const slot of JEWELRY_SLOTS) {
        const equip = playerDTO.equipment?.[slot];
        // Empty slots aren't supported by candidate application (it matches on
        // the current item's hrid), so only suggest swaps for worn accessories
        if (!equip?.hrid) continue;

        const philo = findPhiloAccessory(slot, gameData);
        if (!philo || philo.hrid === equip.hrid) continue;

        const currentLevel = equip.enhancementLevel || 0;
        const alreadyQueued = candidates.some(
            (c) => c.slot === slot && c.upgradeHrid === philo.hrid && c.upgradeLevel === PHILO_START_LEVEL
        );
        if (alreadyQueued) continue;

        // Drop any same-slot swap to this philo item at a higher level: the
        // tier path proposes it at the worn enhancement level (a +12 rebuy for
        // +12 jewelry), which is the expensive version of this same upgrade
        for (let i = candidates.length - 1; i >= 0; i--) {
            const c = candidates[i];
            if (c.slot === slot && c.upgradeHrid === philo.hrid && c.upgradeLevel > PHILO_START_LEVEL) {
                candidates.splice(i, 1);
            }
        }

        const currentName = gameData.itemDetailMap[equip.hrid]?.name || equip.hrid.split('/').pop();
        candidates.push({
            slot,
            currentHrid: equip.hrid,
            currentLevel,
            upgradeHrid: philo.hrid,
            upgradeLevel: PHILO_START_LEVEL,
            description: `${currentName} +${currentLevel} → ${philo.name} +${PHILO_START_LEVEL}`,
            type: 'tier',
        });
    }
}

/**
 * Get the player's primary combat style from their weapon.
 * @param {Object} playerDTO
 * @param {Object} gameData
 * @returns {string} e.g., 'slash', 'stab', 'smash', 'ranged', 'magic'
 */
function getPlayerCombatStyle(playerDTO, gameData) {
    const weapon = playerDTO.equipment['/equipment_types/main_hand'];
    if (!weapon) return 'unknown';
    const weaponDetails = gameData.itemDetailMap[weapon.hrid];
    const stats = weaponDetails?.equipmentDetail?.combatStats;
    if (!stats) return 'unknown';

    if (stats.rangedDamage > 0) return 'ranged';
    if (stats.magicDamage > 0) return 'magic';
    if (stats.stabDamage > 0) return 'stab';
    if (stats.slashDamage > 0) return 'slash';
    if (stats.smashDamage > 0) return 'smash';
    return 'unknown';
}

/**
 * Get the combat style of an ability from its effects.
 * Uses combatStyleHrid for damage abilities, buff typeHrid/skill multipliers for buffs.
 * @param {Object} abilityDetail - From abilityDetailMap
 * @returns {string} 'stab', 'slash', 'smash', 'ranged', 'magic', 'melee', 'physical', or 'universal'
 */
function getAbilityCombatStyle(abilityDetail) {
    // Check for direct combat style on damage/heal effects
    for (const effect of abilityDetail.abilityEffects || []) {
        if (effect.combatStyleHrid) {
            return effect.combatStyleHrid.split('/').pop();
        }
    }

    // For buff abilities, analyze buff types and skill multipliers
    const buffTypes = new Set();
    const skillMultipliers = new Set();

    for (const effect of abilityDetail.abilityEffects || []) {
        if (effect.effectType?.includes('heal')) return 'universal';
        if (!effect.buffs) continue;
        for (const buff of effect.buffs) {
            if (buff.typeHrid) buffTypes.add(buff.typeHrid);
            if (buff.multiplierForSkillHrid) skillMultipliers.add(buff.multiplierForSkillHrid);
        }
    }

    // Skill multiplier is the strongest signal
    if (skillMultipliers.has('/skills/magic')) return 'magic';
    if (skillMultipliers.has('/skills/melee')) return 'melee';
    if (skillMultipliers.has('/skills/ranged')) return 'ranged';

    // Buff type analysis
    const hasElementalAmp =
        buffTypes.has('/buff_types/water_amplify') ||
        buffTypes.has('/buff_types/nature_amplify') ||
        buffTypes.has('/buff_types/fire_amplify');
    if (hasElementalAmp) return 'magic';

    const hasPhysicalAmp = buffTypes.has('/buff_types/physical_amplify');
    if (hasPhysicalAmp) return 'physical';

    // Attack speed without cast speed = physical only
    const hasAttackSpeed = buffTypes.has('/buff_types/attack_speed');
    const hasCastSpeed = buffTypes.has('/buff_types/cast_speed');
    if (hasAttackSpeed && !hasCastSpeed) return 'physical';

    // Universal buffs: attack_speed+cast_speed, damage, accuracy, evasion, armor, thorns, etc.
    return 'universal';
}

/**
 * Check if an ability is compatible with a player's weapon style.
 * @param {string} abilityStyle - From getAbilityCombatStyle()
 * @param {string} weaponStyle - From getPlayerCombatStyle()
 * @returns {boolean}
 */
function isAbilityCompatible(abilityStyle, weaponStyle) {
    // Universal abilities work for everyone
    if (abilityStyle === 'universal') return true;

    // Magic abilities only for magic weapons
    if (abilityStyle === 'magic') return weaponStyle === 'magic';

    // Ranged abilities only for ranged weapons
    if (abilityStyle === 'ranged') return weaponStyle === 'ranged';

    // Physical (non-elemental amplify) works for all melee and ranged
    const meleeStyles = ['stab', 'slash', 'smash'];
    if (abilityStyle === 'physical') {
        return meleeStyles.includes(weaponStyle) || weaponStyle === 'ranged';
    }

    // Melee-specific (e.g., fierce aura with /skills/melee multiplier)
    if (abilityStyle === 'melee') return meleeStyles.includes(weaponStyle);

    // Specific melee sub-styles (stab/slash/smash abilities) work with any melee weapon
    if (meleeStyles.includes(abilityStyle)) return meleeStyles.includes(weaponStyle);

    return abilityStyle === weaponStyle;
}

/**
 * Calculate the gold cost of enhancing an item from startLevel to targetLevel.
 * Uses incremental cost approach: cost(0→target) - cost(0→start), matching
 * the tooltip's enhancement path calculation exactly.
 * @param {string} itemHrid - Item HRID
 * @param {number} startLevel - Starting enhancement level
 * @param {number} targetLevel - Target enhancement level
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @param {Object} [options] - Options
 * @param {string} [options.slot] - Equipment slot HRID (forces auto-detect for back items)
 * @returns {number} Expected gold cost
 */
function calculateEnhancementCost(itemHrid, startLevel, targetLevel, gameData, options = {}) {
    // Genuine no-op: nothing to enhance
    if (targetLevel <= startLevel) {
        return 0;
    }

    const itemDetails = gameData.itemDetailMap[itemHrid];
    // No enhancement recipe: cost is unknown, not free. Reporting 0 here would
    // rank the upgrade as the best value in the list (gold-per-improvement 0).
    if (!itemDetails?.enhancementCosts || itemDetails.enhancementCosts.length === 0) {
        return null;
    }

    // Back items are non-tradeable, always use player's actual enhancing stats
    const enhancingParams = options.slot === '/equipment_types/back' ? getAutoDetectedParams() : getEnhancingParams();
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
                    // Every input comes from the player's own detected stats via
                    // getEnhancingParams — the observatory level and the blessed tea's real
                    // double-jump chance included, so the quote is their run, not a stock one
                    enhancingLevel: enhancingParams.enhancingLevel,
                    houseLevel: enhancingParams.houseLevel,
                    toolBonus: enhancingParams.toolBonus,
                    speedBonus: enhancingParams.speedBonus || 0,
                    itemLevel,
                    targetLevel: level,
                    protectFrom,
                    blessedTea: enhancingParams.teas?.blessed || false,
                    guzzlingBonus: enhancingParams.guzzlingBonus || 1.0,
                    blessedTeaBonus: enhancingParams.blessedTeaBonus,
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

        // Every protection strategy failed for this level — unknown, not free
        if (bestCost === Infinity) {
            return null;
        }
        fullCost[level] = bestCost;
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

    // Check for primary offensive stats (exclude defensiveDamage — it's a tank stat)
    const melee = (combatStats.stabDamage || 0) + (combatStats.slashDamage || 0) + (combatStats.smashDamage || 0);
    const ranged = combatStats.rangedDamage || 0;
    const magic = combatStats.magicDamage || 0;

    // If item has offensive damage stats, classify by highest
    if (melee > 0 || ranged > 0 || magic > 0) {
        if (ranged >= melee && ranged >= magic) return 'ranged';
        if (magic >= melee && magic >= ranged) return 'magic';
        return 'melee';
    }

    // Items with only defensiveDamage and no offensive damage are tanks
    if (combatStats.defensiveDamage > 0) return 'defensive';

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
 * Get the primary damage style of an item's combat stats.
 * @param {Object} combatStats - Item combat stats
 * @returns {string} 'slash', 'stab', 'smash', 'ranged', 'magic', or 'unknown'
 */
function getItemDamageStyle(combatStats) {
    if (!combatStats) return 'unknown';
    const slash = combatStats.slashDamage || 0;
    const stab = combatStats.stabDamage || 0;
    const smash = combatStats.smashDamage || 0;
    const ranged = combatStats.rangedDamage || 0;
    const magic = combatStats.magicDamage || 0;

    if (slash >= stab && slash >= smash && slash >= ranged && slash >= magic && slash > 0) return 'slash';
    if (stab >= slash && stab >= smash && stab >= ranged && stab >= magic && stab > 0) return 'stab';
    if (smash >= slash && smash >= stab && smash >= ranged && smash >= magic && smash > 0) return 'smash';
    if (ranged >= slash && ranged >= stab && ranged >= smash && ranged >= magic && ranged > 0) return 'ranged';
    if (magic > 0) return 'magic';
    return 'unknown';
}

/**
 * Which attack styles an item's offensive stats are for.
 *
 * An off-hand carrying melee accuracy is a melee off-hand, whatever else it
 * gives — pairing it with a crossbow offers a bow user a shield whose entire
 * offensive contribution is dead weight.
 *
 * @param {Object} stats - `equipmentDetail.combatStats`
 * @returns {Set<string>} Any of `magic`, `ranged`, `melee`; empty when the piece
 *   is purely defensive and so fits any style
 */
function offensiveStyles(stats = {}) {
    const styles = new Set();
    if ((stats.magicDamage || 0) > 0 || (stats.magicAccuracy || 0) > 0) styles.add('magic');
    if ((stats.rangedDamage || 0) > 0 || (stats.rangedAccuracy || 0) > 0) styles.add('ranged');
    const meleeDamage = (stats.stabDamage || 0) + (stats.slashDamage || 0) + (stats.smashDamage || 0);
    const meleeAccuracy = (stats.stabAccuracy || 0) + (stats.slashAccuracy || 0) + (stats.smashAccuracy || 0);
    if (meleeDamage > 0 || meleeAccuracy > 0) styles.add('melee');
    return styles;
}

/**
 * Find candidate off-hand items for a given combat style and level range.
 * Returns up to two options (deduped):
 *  - Style-matched: highest-itemLevel off-hand whose offensive stats match the
 *    weapon's damage style (e.g. Manticore Shield for ranged).
 *  - Highest-itemLevel: the strongest off-hand by item level among those that
 *    fit the style — either matching it or carrying no offensive stats at all.
 *
 * That second one used to be the strongest off-hand *overall*, which paired a
 * ranged main hand with a melee shield and offered it as an upgrade. An
 * off-hand built for another style is not a better off-hand, whatever its item
 * level says; a purely defensive one is still fair game for anybody.
 *
 * @param {Object} gameData - Game data
 * @param {string} damageStyle - Primary damage style of the weapon
 * @param {number} maxItemLevel - Maximum item level to consider
 * @returns {Array<{hrid: string, itemLevel: number}>}
 */
function findBestOffHand(gameData, damageStyle, maxItemLevel) {
    const family = damageStyle === 'magic' ? 'magic' : damageStyle === 'ranged' ? 'ranged' : 'melee';

    let styleMatched = null; // highest-itemLevel off-hand with style-matched stats
    let highest = null; // highest-itemLevel off-hand overall (with magic-exclusion for non-magic)

    for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
        const eq = item.equipmentDetail;
        if (!eq || eq.type !== '/equipment_types/off_hand') continue;
        if (!hasCombatStats(item)) continue;
        if ((item.itemLevel || 0) > maxItemLevel) continue;

        const level = item.itemLevel || 0;
        const styles = offensiveStyles(eq.combatStats);

        // An off-hand whose offensive stats are for another style is not an
        // upgrade for this weapon at any item level; one with none at all is
        // pure defence and fits anybody
        if ([...styles].some((style) => style !== family)) continue;

        if (!highest || level > highest.itemLevel) {
            highest = { hrid: itemHrid, itemLevel: level };
        }

        // Style-matched: the highest one that actually contributes to this
        // weapon's damage, rather than merely not clashing with it
        if (styles.has(family) && (!styleMatched || level > styleMatched.itemLevel)) {
            styleMatched = { hrid: itemHrid, itemLevel: level };
        }
    }

    const out = [];
    if (styleMatched) out.push({ hrid: styleMatched.hrid, itemLevel: styleMatched.itemLevel });
    if (highest && (!styleMatched || highest.hrid !== styleMatched.hrid)) {
        out.push({ hrid: highest.hrid, itemLevel: highest.itemLevel });
    }
    return out;
}

/**
 * Generate upgrade candidates for a player's equipment and/or abilities.
 * @param {Object} playerDTO - Player DTO with equipment
 * @param {Object} gameData - Game data from buildGameDataPayload()
 * @param {string} [mode='equipment'] - 'equipment' or 'abilities'
 * @param {number} [abilityTargetLevel=0] - Target level or increment for ability upgrades
 * @param {string} [abilityLevelType='increment'] - 'increment' (add N levels) or 'target' (absolute level)
 * @param {Object} [communityBuffs=null] - Configured community buffs, for the 'community_buff' set
 * @returns {Array} Candidates: [{slot, currentHrid, currentLevel, upgradeHrid, upgradeLevel, description, type}]
 */
export function generateCandidates(
    playerDTO,
    gameData,
    mode = 'equipment',
    abilityTargetLevel = 0,
    abilityLevelType = 'increment',
    skipBackSlot = false,
    combatLevelTargets = null,
    abilityTargets = null,
    houseTargetLevel = 0,
    houseTargets = null,
    communityBuffs = null
) {
    const candidates = [];

    if (mode === 'equipment') {
        const tierProgression = getEquipmentTierProgression(gameData);
        const upgradeMap = buildUpgradeMap(gameData);

        for (const [slot, equip] of Object.entries(playerDTO.equipment)) {
            if (!equip) continue;

            const currentHrid = equip.hrid;
            const currentLevel = equip.enhancementLevel || 0;
            const itemDetails = gameData.itemDetailMap[currentHrid];

            // Trinkets used to be skipped here because the engine dropped
            // taskDamage out of the attacker's damage roll, so every trinket
            // measured as inert and a table full of zero-gain rows was worse
            // than no rows. The engine applies it now (see
            // engine/combat-utilities.js), which makes a trinket an ordinary
            // rankable piece — with the caveat, carried on the row, that the
            // stat only pays while the monster is your task.
            if (skipBackSlot && slot === '/equipment_types/back') continue;
            if (!hasCombatStats(itemDetails)) continue;

            // Enhancement upgrade: next breakpoint
            const nextBP = getNextBreakpoint(currentLevel, slot, currentHrid);
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
                        if (upgradeItem.equipmentDetail.type !== slot) continue;
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
                const offensiveCurrentName = itemDetails?.name || currentHrid.split('/').pop();
                const offensiveCandidateHrids = new Set();
                if (slotItems) {
                    const currentIdx = slotItems.findIndex((item) => item.hrid === currentHrid);
                    if (currentIdx >= 0 && currentIdx < slotItems.length - 1) {
                        const currentItemLevel = itemDetails?.itemLevel || 0;
                        const currentIsRefined = currentHrid.endsWith('_refined');

                        // The group is item-level sorted, so the immediate neighbour can be
                        // a same-level sibling — a paid sidegrade, not an upgrade. Walk
                        // forward to the first genuinely better entry: a higher item level,
                        // or the refined variant of a non-refined item (same level, better
                        // stats). Refined → another refined at the same level is a sidegrade.
                        let nextTier = null;
                        for (let i = currentIdx + 1; i < slotItems.length; i++) {
                            const contender = slotItems[i];
                            const isUpgrade =
                                contender.itemLevel > currentItemLevel ||
                                (!currentIsRefined && contender.hrid.endsWith('_refined'));
                            if (isUpgrade) {
                                nextTier = contender;
                                break;
                            }
                        }

                        if (nextTier) {
                            const nextName = nextTier.name || nextTier.hrid.split('/').pop();
                            candidates.push({
                                slot,
                                currentHrid,
                                currentLevel,
                                upgradeHrid: nextTier.hrid,
                                upgradeLevel: currentLevel,
                                description: `${offensiveCurrentName} → ${nextName} (+${currentLevel})`,
                                type: 'tier',
                            });
                            offensiveCandidateHrids.add(nextTier.hrid);
                        }

                        // Also suggest the highest non-refined item in the same slot|role
                        // when the player is already wearing high-tier gear (T60+). This
                        // surfaces direct T95 jumps (e.g. Sighted → Marksman) that the
                        // single-step progression would otherwise hide behind T75 stepping
                        // stones.
                        if (currentItemLevel >= 60) {
                            let highestNonRefined = null;
                            for (let i = slotItems.length - 1; i >= 0; i--) {
                                if (!slotItems[i].hrid.endsWith('_refined')) {
                                    highestNonRefined = slotItems[i];
                                    break;
                                }
                            }
                            if (
                                highestNonRefined &&
                                highestNonRefined.hrid !== currentHrid &&
                                highestNonRefined.hrid !== nextTier?.hrid &&
                                highestNonRefined.itemLevel > currentItemLevel
                            ) {
                                const highestName = highestNonRefined.name || highestNonRefined.hrid.split('/').pop();
                                candidates.push({
                                    slot,
                                    currentHrid,
                                    currentLevel,
                                    upgradeHrid: highestNonRefined.hrid,
                                    upgradeLevel: currentLevel,
                                    description: `${offensiveCurrentName} → ${highestName} (+${currentLevel})`,
                                    type: 'tier',
                                });
                                offensiveCandidateHrids.add(highestNonRefined.hrid);
                            }
                        }
                    }
                }

                // Also walk the crafting-chain upgradeMap for offensive items so that
                // direct upgrade-action targets — most importantly the refined version
                // of the current weapon (e.g. Furious Spear → Furious Spear ★) — surface
                // even when the role-grouped progression would step sideways to a
                // different damage style first.
                const offensiveUpgrades = upgradeMap.get(currentHrid);
                if (offensiveUpgrades) {
                    for (const upgradeHrid of offensiveUpgrades) {
                        if (offensiveCandidateHrids.has(upgradeHrid)) continue;
                        if (upgradeHrid === currentHrid) continue;
                        const upgradeItem = gameData.itemDetailMap[upgradeHrid];
                        if (!upgradeItem?.equipmentDetail) continue;
                        if (upgradeItem.equipmentDetail.type !== slot) continue;
                        const upgradeRole = getItemRole(upgradeItem.equipmentDetail?.combatStats);
                        if (upgradeRole !== role) continue;

                        const upgradeName = upgradeItem.name || upgradeHrid.split('/').pop();
                        candidates.push({
                            slot,
                            currentHrid,
                            currentLevel,
                            upgradeHrid,
                            upgradeLevel: currentLevel,
                            description: `${offensiveCurrentName} → ${upgradeName} (+${currentLevel})`,
                            type: 'tier',
                        });
                        offensiveCandidateHrids.add(upgradeHrid);
                    }
                }
            }
        }

        // Cross-slot candidates: two_hand ↔ main_hand + off_hand
        const twoHandEquip = playerDTO.equipment['/equipment_types/two_hand'];
        const mainHandEquip = playerDTO.equipment['/equipment_types/main_hand'];
        const offHandEquip = playerDTO.equipment['/equipment_types/off_hand'];

        if (twoHandEquip) {
            // Case A: Player has two_hand → suggest main_hand + best off_hand
            const twoHandItem = gameData.itemDetailMap[twoHandEquip.hrid];
            const twoHandStats = twoHandItem?.equipmentDetail?.combatStats;
            const damageStyle = getItemDamageStyle(twoHandStats);

            if (damageStyle !== 'unknown') {
                const twoHandLevel = twoHandItem?.itemLevel || 0;
                const enhLevel = twoHandEquip.enhancementLevel || 0;

                // Find main_hand weapons with matching style at or above current level
                for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
                    const eq = item.equipmentDetail;
                    if (!eq || eq.type !== '/equipment_types/main_hand') continue;
                    if (!hasCombatStats(item)) continue;
                    if ((item.itemLevel || 0) < twoHandLevel) continue;

                    const style = getItemDamageStyle(eq.combatStats);
                    if (style !== damageStyle) continue;

                    // Find candidate off-hands at this tier (may return 1 or 2 options:
                    // style-matched and/or highest-itemLevel).
                    const offHandCandidates = findBestOffHand(gameData, damageStyle, item.itemLevel || 999);
                    if (!offHandCandidates.length) continue;

                    const mainName = item.name || itemHrid.split('/').pop();
                    const currentName = twoHandItem?.name || twoHandEquip.hrid.split('/').pop();

                    for (const bestOH of offHandCandidates) {
                        const ohItem = gameData.itemDetailMap[bestOH.hrid];
                        const ohName = ohItem?.name || bestOH.hrid.split('/').pop();

                        candidates.push({
                            slot: '/equipment_types/two_hand',
                            currentHrid: twoHandEquip.hrid,
                            currentLevel: enhLevel,
                            upgradeHrid: itemHrid,
                            upgradeLevel: enhLevel,
                            addedSlots: {
                                '/equipment_types/main_hand': { hrid: itemHrid, enhancementLevel: enhLevel },
                                '/equipment_types/off_hand': { hrid: bestOH.hrid, enhancementLevel: enhLevel },
                            },
                            clearedSlots: ['/equipment_types/two_hand'],
                            removedItems: [{ hrid: twoHandEquip.hrid, enhancementLevel: enhLevel }],
                            description: `${currentName} → ${mainName} + ${ohName} (+${enhLevel})`,
                            type: 'cross_slot',
                        });
                    }
                }
            }
        } else if (mainHandEquip) {
            // Case B: Player has main_hand (+off_hand) → suggest best two_hand
            const mainHandItem = gameData.itemDetailMap[mainHandEquip.hrid];
            const mainHandStats = mainHandItem?.equipmentDetail?.combatStats;
            const damageStyle = getItemDamageStyle(mainHandStats);

            if (damageStyle !== 'unknown') {
                const mainHandLevel = mainHandItem?.itemLevel || 0;
                const enhLevel = mainHandEquip.enhancementLevel || 0;

                // Find two_hand weapons with matching style above current main_hand level
                for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
                    const eq = item.equipmentDetail;
                    if (!eq || eq.type !== '/equipment_types/two_hand') continue;
                    if (!hasCombatStats(item)) continue;
                    if ((item.itemLevel || 0) <= mainHandLevel) continue;

                    const style = getItemDamageStyle(eq.combatStats);
                    if (style !== damageStyle) continue;
                    if (getItemRole(eq.combatStats) === 'defensive') continue;

                    const twoHandName = item.name || itemHrid.split('/').pop();
                    const currentName = mainHandItem?.name || mainHandEquip.hrid.split('/').pop();

                    const clearedSlots = ['/equipment_types/main_hand'];
                    if (offHandEquip) clearedSlots.push('/equipment_types/off_hand');

                    candidates.push({
                        slot: '/equipment_types/main_hand',
                        currentHrid: mainHandEquip.hrid,
                        currentLevel: enhLevel,
                        upgradeHrid: itemHrid,
                        upgradeLevel: enhLevel,
                        addedSlots: {
                            '/equipment_types/two_hand': { hrid: itemHrid, enhancementLevel: enhLevel },
                        },
                        clearedSlots,
                        removedItems: [
                            { hrid: mainHandEquip.hrid, enhancementLevel: enhLevel },
                            ...(offHandEquip
                                ? [{ hrid: offHandEquip.hrid, enhancementLevel: offHandEquip.enhancementLevel || 0 }]
                                : []),
                        ],
                        description: `${currentName} → ${twoHandName} (+${enhLevel})`,
                        type: 'cross_slot',
                    });
                }
            }
        }

        addPhiloAccessoryCandidates(playerDTO, gameData, candidates);
    } else if (mode === 'ability_level' || mode === 'ability_swap') {
        const playerStyle = getPlayerCombatStyle(playerDTO, gameData);
        const equippedAbilityHrids = new Set(playerDTO.abilities.filter((a) => a).map((a) => a.hrid));
        const abilityTargetsMap =
            abilityTargets && typeof abilityTargets === 'object' && Object.keys(abilityTargets).length > 0
                ? abilityTargets
                : null;

        for (let slotIdx = 0; slotIdx < playerDTO.abilities.length; slotIdx++) {
            const ability = playerDTO.abilities[slotIdx];
            if (!ability) continue;

            const abilityDetail = gameData.abilityDetailMap[ability.hrid];
            if (!abilityDetail) continue;
            const abilityName = abilityDetail.name || ability.hrid.split('/').pop();

            if (mode === 'ability_level') {
                // Level upgrade candidate. Per-ability targets (when set)
                // replace the uniform increment/target — abilities without an
                // entry or at/below their current level are skipped
                let targetLevel;
                if (abilityTargetsMap) {
                    targetLevel = Math.floor(abilityTargetsMap[ability.hrid] || 0);
                } else if (abilityLevelType === 'target') {
                    targetLevel =
                        abilityTargetLevel > ability.level
                            ? abilityTargetLevel
                            : getNextAbilityBreakpoint(ability.level);
                } else {
                    const increment = abilityTargetLevel > 0 ? abilityTargetLevel : 5;
                    targetLevel = ability.level + increment;
                }
                targetLevel = Math.min(targetLevel, 200);
                if (targetLevel > ability.level) {
                    candidates.push({
                        slot: `ability_${slotIdx}`,
                        currentHrid: ability.hrid,
                        currentLevel: ability.level,
                        upgradeHrid: ability.hrid,
                        upgradeLevel: targetLevel,
                        description: `${abilityName} Lv${ability.level} → Lv${targetLevel}`,
                        type: 'ability_level',
                    });
                }
            } else {
                // Swap candidates: other compatible abilities not already equipped
                for (const [abHrid, abDetail] of Object.entries(gameData.abilityDetailMap)) {
                    if (equippedAbilityHrids.has(abHrid)) continue;
                    if (abDetail.isSpecialAbility && slotIdx !== 0) continue;
                    if (!abDetail.isSpecialAbility && slotIdx === 0) continue;
                    if (abHrid === '/abilities/promote') continue;

                    const abStyle = getAbilityCombatStyle(abDetail);
                    if (!isAbilityCompatible(abStyle, playerStyle)) continue;

                    const swapName = abDetail.name || abHrid.split('/').pop();
                    candidates.push({
                        slot: `ability_${slotIdx}`,
                        currentHrid: ability.hrid,
                        currentLevel: ability.level,
                        upgradeHrid: abHrid,
                        upgradeLevel: ability.level,
                        description: `${abilityName} → ${swapName} (Lv${ability.level})`,
                        type: 'ability_swap',
                    });
                }
            }
        }
    }

    if (mode === 'combat_level') {
        // Simulate boosted combat skill levels to rank which skill is most
        // effective to level next. Uniform boost of +N (abilityTargetLevel
        // carries N) or explicit per-skill target levels when provided.
        const boost = Math.max(1, Math.floor(abilityTargetLevel) || 5);
        const targets =
            combatLevelTargets && typeof combatLevelTargets === 'object' && Object.keys(combatLevelTargets).length > 0
                ? combatLevelTargets
                : null;
        const excludedSkills = getStyleExcludedSkills(playerDTO, gameData);
        for (const skill of COMBAT_LEVEL_SKILLS) {
            if (excludedSkills.has(skill.key)) continue;
            const currentLevel = Math.max(1, Math.floor(playerDTO[skill.key] || 1));
            const upgradeLevel = targets ? Math.min(200, Math.floor(targets[skill.key] || 0)) : currentLevel + boost;
            if (upgradeLevel <= currentLevel) continue;
            candidates.push({
                type: 'combat_level',
                slot: `combat_level|${skill.key}`,
                skillKey: skill.key,
                currentLevel,
                upgradeLevel,
                levelBoost: upgradeLevel - currentLevel,
                description: `${skill.label} ${currentLevel} → ${upgradeLevel}`,
            });
        }
    }

    if (mode === 'house') {
        candidates.push(...generateHouseCandidates(playerDTO, gameData, houseTargetLevel, houseTargets));
    }

    if (mode === 'guild_shrine') {
        candidates.push(...generateGuildShrineCandidates(playerDTO, { combat: true }));
    }

    if (mode === 'drink') {
        candidates.push(...generateDrinkCandidates(playerDTO, gameData));
    }

    if (mode === 'community_buff') {
        candidates.push(...generateCommunityBuffCandidates(communityBuffs));
    }

    // The engine applies taskDamage to every hit, because the game does and
    // because leaving it out understated anyone wearing a task trinket. What
    // neither the engine nor the sim knows is whether the monster in front of
    // you is your task — so a trinket's simulated gain is its on-task gain, and
    // the row has to say so rather than let it read as an always-on number
    for (const candidate of candidates) {
        if (candidate.slot === TRINKET_SLOT) {
            candidate.caveat =
                'Simulated as though every fight is a task fight — taskDamage applies to every hit here, ' +
                'so this is the on-task gain. Off task, expect less.';
        }
    }

    candidates.forEach(clampRefinedCandidateToMinLevel);
    return candidates;
}

/**
 * Buff types the combat engine actually reads (see engine/combat-unit.js and
 * combat-utilities.js). A house room whose buffs land in this set changes a fight
 * no matter how the game labels the room.
 */
const COMBAT_BUFF_TYPES = new Set([
    '/buff_types/accuracy',
    '/buff_types/armor',
    '/buff_types/attack_speed',
    '/buff_types/cast_speed',
    '/buff_types/combat_drop_quantity',
    '/buff_types/combat_drop_rate',
    '/buff_types/critical_damage',
    '/buff_types/critical_rate',
    '/buff_types/damage',
    '/buff_types/damage_taken',
    '/buff_types/elemental_thorns',
    '/buff_types/evasion',
    '/buff_types/fire_amplify',
    '/buff_types/fire_resistance',
    '/buff_types/fury_accuracy',
    '/buff_types/fury_damage',
    '/buff_types/healing_amplify',
    '/buff_types/hp_regen',
    '/buff_types/life_steal',
    '/buff_types/mp_regen',
    '/buff_types/nature_amplify',
    '/buff_types/nature_resistance',
    '/buff_types/physical_amplify',
    '/buff_types/physical_thorns',
    '/buff_types/rare_find',
    '/buff_types/retaliation',
    '/buff_types/tenacity',
    '/buff_types/threat',
    '/buff_types/water_amplify',
    '/buff_types/water_resistance',
    '/buff_types/wisdom',
]);

const COMBAT_ACTION_TYPE = '/action_types/combat';

/**
 * Does this house room change a combat sim?
 *
 * Three independent signals, because the game exposes the action-type tag in more
 * than one place and a global buff carries no tag at all: the room's own
 * usableInActionTypeMap, a per-buff usableInActionTypeMap, or a buff type the
 * combat engine reads. Any of them is enough. Over-including a room only costs a
 * sim that comes back at 0.00%; under-including hides a real upgrade, which is
 * how the first version produced an empty list.
 * @param {Object} roomDetail - Entry from houseRoomDetailMap
 * @returns {boolean}
 */
export function houseRoomAffectsCombat(roomDetail) {
    const buffs = [...(roomDetail?.actionBuffs || []), ...(roomDetail?.globalBuffs || [])];
    if (buffs.length === 0) return false;

    if (roomDetail?.usableInActionTypeMap?.[COMBAT_ACTION_TYPE]) return true;
    return buffs.some(
        (buff) => buff?.usableInActionTypeMap?.[COMBAT_ACTION_TYPE] || COMBAT_BUFF_TYPES.has(buff?.typeHrid)
    );
}

/**
 * Canonical key for what a candidate actually equips, used to deduplicate.
 *
 * Keyed on the full slot assignment rather than one representative slot: a
 * multi-slot candidate differs from the single-slot swap of its first piece, and
 * a single-slot cross_slot candidate is the same change as the equivalent tier
 * candidate. Keying on the first slot alone collapsed the pair candidates into
 * their body-only sibling and let single-slot duplicates through.
 * @param {Object} candidate - Upgrade candidate
 * @returns {string} Key describing the resulting equipment change
 */
export function candidateAssignmentKey(candidate) {
    if (candidate.addedSlots) {
        const added = Object.entries(candidate.addedSlots)
            .map(([slot, item]) => `${slot}=${item.hrid}@${item.enhancementLevel || 0}`)
            .sort()
            .join(',');
        const cleared = [...(candidate.clearedSlots || [])].sort().join(',');
        return `equip:${added}!${cleared}`;
    }
    if (
        candidate.type === 'combat_level' ||
        candidate.type === 'house' ||
        candidate.type === 'guild_shrine' ||
        candidate.type === 'community_buff' ||
        candidate.type === 'drink' ||
        candidate.slot?.startsWith('ability_')
    ) {
        return `${candidate.type}:${candidate.slot}=${candidate.upgradeHrid || ''}@${candidate.upgradeLevel}`;
    }
    return `equip:${candidate.slot}=${candidate.upgradeHrid}@${candidate.upgradeLevel}!`;
}

/**
 * Count what the house scan saw, so an empty candidate list can explain itself
 * instead of reading as "no upgrades available".
 * @param {Object} playerDTO - Player DTO
 * @param {Object} gameData - Game data payload
 * @returns {{rooms: number, withBuffs: number, combatRelevant: number, belowCap: number}}
 */
export function describeHouseScan(playerDTO, gameData) {
    const roomMap = gameData?.houseRoomDetailMap || {};
    let withBuffs = 0;
    let combatRelevant = 0;
    let belowCap = 0;

    for (const [roomHrid, roomDetail] of Object.entries(roomMap)) {
        const buffs = [...(roomDetail?.actionBuffs || []), ...(roomDetail?.globalBuffs || [])];
        if (buffs.length > 0) withBuffs++;
        if (!houseRoomAffectsCombat(roomDetail)) continue;
        combatRelevant++;
        const level = Math.max(0, Math.floor(Number(playerDTO?.houseRooms?.[roomHrid]) || 0));
        if (level < MAX_HOUSE_LEVEL) belowCap++;
    }

    return { rooms: Object.keys(roomMap).length, withBuffs, combatRelevant, belowCap };
}

/**
 * Generate house room upgrade candidates for every combat-relevant room.
 * @param {Object} playerDTO - Player DTO (houseRooms carries current levels)
 * @param {Object} gameData - Game data payload (houseRoomDetailMap)
 * @param {number} [targetLevel] - Level to sim every room at; 0/unset means one level up
 * @param {Object|null} [perRoomTargets] - roomHrid → target level; takes precedence
 *   over targetLevel, and a room absent from it is skipped (blank means skip)
 * @returns {Array<Object>} Candidates of type 'house'
 */
export function generateHouseCandidates(playerDTO, gameData, targetLevel = 0, perRoomTargets = null) {
    const roomMap = gameData?.houseRoomDetailMap;
    if (!roomMap) return [];

    const target = Math.min(MAX_HOUSE_LEVEL, Math.max(0, Math.floor(Number(targetLevel) || 0)));
    const explicit = perRoomTargets && typeof perRoomTargets === 'object' ? perRoomTargets : null;

    const candidates = [];
    for (const [roomHrid, roomDetail] of Object.entries(roomMap)) {
        if (!houseRoomAffectsCombat(roomDetail)) continue;

        const currentLevel = Math.max(0, Math.floor(Number(playerDTO.houseRooms?.[roomHrid]) || 0));
        if (currentLevel >= MAX_HOUSE_LEVEL) continue;

        // Per-room target wins; then the uniform target; otherwise one level up.
        // With per-room targets open, a room left blank is deliberately skipped.
        let upgradeLevel;
        if (explicit) {
            upgradeLevel = Math.min(MAX_HOUSE_LEVEL, Math.floor(Number(explicit[roomHrid]) || 0));
        } else {
            upgradeLevel = target > 0 ? target : currentLevel + 1;
        }
        if (upgradeLevel <= currentLevel) continue;

        const roomName = roomDetail.name || roomHrid.split('/').pop().replace(/_/g, ' ');
        candidates.push({
            type: 'house',
            slot: `house|${roomHrid}`,
            roomHrid,
            currentLevel,
            upgradeLevel,
            description: `${roomName} Lv${currentLevel} → Lv${upgradeLevel}`,
        });
    }
    return candidates;
}

/**
 * Buff types the skilling clear-rate metrics can actually measure a change in.
 * A shrine granting only rare-find has a real effect on a run and no effect on
 * any number this analysis reports, so offering it would be offering a row that
 * can only ever read 0.00%.
 */
const SKILLING_METRIC_BUFF_TYPES = new Set([
    '/buff_types/efficiency',
    '/buff_types/action_speed',
    '/buff_types/wisdom',
]);

/**
 * Display name for a shrine, from its hrid.
 * @param {string} shrineHrid - e.g. '/guild_shrines/force'
 * @returns {string} e.g. 'Force'
 */
function shrineName(shrineHrid) {
    const slug =
        String(shrineHrid || '')
            .split('/')
            .pop() || 'guild';
    return slug
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
}

/**
 * Generate one-level-up candidates for the guild shrine buffs.
 *
 * ## What the shrine level does and does not gate
 *
 * Two levels are in play and they are not the same number. The character buys
 * levels in a *buff*, and those are the levels these candidates step. The guild
 * builds levels in the *shrine*, and that caps how far members can buy. So a
 * candidate above the shrine's own level is still a real, correctly priced
 * purchase — it simply cannot be made until the guild upgrades the building,
 * which is not a cost this row can put a number on. Those rows are generated
 * anyway and carry `needsShrineLevel` so the detail can say so, rather than being
 * hidden as if the upgrade did not exist.
 *
 * A shrine level of 0 means no guild building data reached the client at all,
 * which is not the same as "the shrine is not built" — `shrineLevelKnown` keeps
 * those apart so nothing claims a cap that was never read.
 *
 * @param {Object} playerDTO - Player DTO carrying `guildShrineLevels`
 * @param {Object} [options]
 * @param {boolean} [options.combat=true] - Combat shrines when true, skilling when false
 * @returns {Array<Object>} Candidates of type 'guild_shrine'
 */
export function generateGuildShrineCandidates(playerDTO, { combat = true } = {}) {
    const detailMap = getGuildBuffDetailMap();
    const levels = playerDTO?.guildShrineLevels;
    // No level map means this DTO is somebody whose guild we know nothing about
    // (an imported player, a party member read off a profile) — not a guildless
    // character, so guessing zero would invent an upgrade path for them
    if (!levels || Object.keys(detailMap).length === 0) return [];

    const candidates = [];
    for (const [buffHrid, detail] of Object.entries(detailMap)) {
        if (Boolean(detail.isCombat) !== combat) continue;
        if (!combat && !(detail.buffs || []).some((buff) => SKILLING_METRIC_BUFF_TYPES.has(buff?.typeHrid))) continue;

        const maxLevel = guildBuffMaxLevel(detail);
        const currentLevel = Math.max(0, Math.floor(Number(levels[buffHrid]) || 0));
        const upgradeLevel = currentLevel + 1;
        if (maxLevel <= 0 || upgradeLevel > maxLevel) continue;

        const levelCost = detail.levelCosts?.[String(upgradeLevel)] || {};
        const shrineLevel = Math.max(
            0,
            Math.floor(Number(dataManager.getGuildBuildingLevel?.(detail.shrineHrid)) || 0)
        );
        const label = shrineName(detail.shrineHrid);

        candidates.push({
            type: 'guild_shrine',
            slot: `guild_shrine|${buffHrid}`,
            buffHrid,
            shrineHrid: detail.shrineHrid,
            isCombat: Boolean(detail.isCombat),
            currentLevel,
            upgradeLevel,
            maxLevel,
            buffTypes: (detail.buffs || []).map((buff) => buff?.typeHrid).filter(Boolean),
            guildTokenCost: Math.max(0, Math.floor(Number(levelCost.guildTokenCost) || 0)),
            creditCosts: levelCost.creditCosts || [],
            shrineLevel,
            shrineLevelKnown: shrineLevel > 0,
            needsShrineLevel: shrineLevel > 0 && upgradeLevel > shrineLevel ? upgradeLevel : null,
            description: `${label} Shrine Lv${currentLevel} → Lv${upgradeLevel}`,
        });
    }
    return candidates;
}

/** Drink slots a combat loadout has */
const DRINK_SLOTS = 3;

/**
 * Buff drinks worth simulating: a tier up in each family you already run, and
 * the best of each family you run none of.
 *
 * The advisor could weigh a chestpiece against an ability against a house room
 * and had nothing at all to say about the three coffee slots, which for most
 * characters are a larger and far cheaper lever than any of them. The food
 * optimizer does not cover this: it walks tiers *within an occupied slot* on a
 * survival criterion, and a coffee neither restores anything nor occupies a
 * food slot.
 *
 * Two shapes of candidate, and no more:
 *   - **A tier up** in a family already equipped, which competes with nothing.
 *   - **The best drink of a family you are not running**, into a free slot.
 * Every intermediate tier of a family you do not run is deliberately left out —
 * it would trade sims for rows nobody would buy, and the top tier answers the
 * question ("is this buff worth a slot") that the lower ones only blur.
 *
 * Cost is zero rather than a price: a coffee is drunk continuously, and the
 * sim's own consumable accounting already subtracts its hourly spend from
 * Profit/hr. Charging it again as an outlay would count it twice.
 *
 * @param {Object} playerDTO - Player DTO carrying `drinks`
 * @param {Object} gameData - Game data payload
 * @returns {Array<Object>} Candidates of type 'drink'
 */
export function generateDrinkCandidates(playerDTO, gameData) {
    const pools = buildBuffDrinkPools(gameData);
    if (pools.size === 0) return [];

    const drinks = Array.isArray(playerDTO?.drinks) ? playerDTO.drinks : [];
    const familyOf = (hrid) => {
        for (const [family, pool] of pools) {
            if (pool.some((entry) => entry.hrid === hrid)) return family;
        }
        return null;
    };

    const equipped = new Map(); // family → { index, entry }
    let freeSlot = -1;
    for (let index = 0; index < DRINK_SLOTS; index++) {
        const worn = drinks[index];
        if (!worn?.hrid) {
            if (freeSlot === -1) freeSlot = index;
            continue;
        }
        const family = familyOf(worn.hrid);
        if (!family) continue;
        equipped.set(family, { index, entry: pools.get(family).find((e) => e.hrid === worn.hrid) });
    }

    const candidates = [];
    const combatRelevant = (entry) => entry.buffTypes.some((type) => COMBAT_BUFF_TYPES.has(type));

    for (const [family, pool] of pools) {
        const usable = pool.filter(combatRelevant);
        if (usable.length === 0) continue;

        const worn = equipped.get(family);
        if (worn?.entry) {
            const better = usable.filter((entry) => entry.itemLevel > worn.entry.itemLevel);
            if (better.length === 0) continue;
            const next = better[0];
            candidates.push({
                type: 'drink',
                slot: `drink_${worn.index}`,
                drinkIndex: worn.index,
                currentHrid: worn.entry.hrid,
                upgradeHrid: next.hrid,
                upgradeLevel: 0,
                triggers: next.triggers,
                buffFamily: family,
                description: `${worn.entry.name} → ${next.name}`,
            });
            continue;
        }

        // Not running this family at all: only worth a row if there is a slot
        // free to run it in, and only the best of it
        if (freeSlot === -1) continue;
        const best = usable[usable.length - 1];
        candidates.push({
            type: 'drink',
            slot: `drink_${freeSlot}`,
            drinkIndex: freeSlot,
            currentHrid: null,
            upgradeHrid: best.hrid,
            upgradeLevel: 0,
            triggers: best.triggers,
            buffFamily: family,
            description: `Add ${best.name}`,
        });
    }

    return candidates;
}

/**
 * Put a drink candidate into its slot, in place.
 * @param {Object} dto - Player DTO (mutated)
 * @param {Object} candidate - Candidate of type 'drink'
 */
function applyDrinkToDTO(dto, candidate) {
    if (!Array.isArray(dto.drinks)) dto.drinks = [];
    while (dto.drinks.length < DRINK_SLOTS) dto.drinks.push(null);
    dto.drinks[candidate.drinkIndex] = { hrid: candidate.upgradeHrid, triggers: candidate.triggers || null };
}

/** Community buffs the combat sim reads, with what one more level is worth */
const COMMUNITY_BUFF_CANDIDATES = [
    { key: 'comExp', label: 'Community EXP buff' },
    { key: 'comDrop', label: 'Community combat drop buff' },
];

/** Highest level a community buff reaches */
const MAX_COMMUNITY_BUFF_LEVEL = 20;

/**
 * What one more level of a community buff would be worth.
 *
 * Not a purchase, and the advisor says so by pricing it at unknown rather than
 * free — it lands in the unpriced group, where rows that cannot be ranked on
 * gold are visible and clearly separate from the ones that can. It is still
 * worth simulating: the levels are already editable in the sim's own DTO, the
 * question "how much is the drop buff actually doing for me" is asked
 * constantly, and answering it costs one sim per level rather than a guess.
 *
 * @param {Object} communityBuffs - `{ mooPass, comExp, comDrop }` as configured
 * @returns {Array<Object>} Candidates of type 'community_buff'
 */
export function generateCommunityBuffCandidates(communityBuffs) {
    const candidates = [];
    for (const { key, label } of COMMUNITY_BUFF_CANDIDATES) {
        const currentLevel = Math.max(0, Math.floor(Number(communityBuffs?.[key]) || 0));
        const upgradeLevel = currentLevel + 1;
        if (upgradeLevel > MAX_COMMUNITY_BUFF_LEVEL) continue;
        candidates.push({
            type: 'community_buff',
            slot: `community_buff|${key}`,
            buffKey: key,
            currentLevel,
            upgradeLevel,
            description: `${label} Lv${currentLevel} → Lv${upgradeLevel}`,
        });
    }
    return candidates;
}

/**
 * The community-buff configuration a candidate should be simulated under.
 * Every other candidate type simulates under exactly what was configured.
 * @param {Object} communityBuffs - As configured
 * @param {Object} candidate - The candidate being evaluated
 * @returns {Object} Community buffs for this run
 */
function applyCommunityBuffCandidate(communityBuffs, candidate) {
    if (candidate?.type !== 'community_buff') return communityBuffs;
    return { ...communityBuffs, [candidate.buffKey]: candidate.upgradeLevel };
}

/**
 * Put a shrine candidate's level onto a DTO, in place.
 *
 * Both the level map and the resolved combat buff array are written: the map is
 * what the editor and the skilling metrics read, the array is what the combat
 * engine reads, and leaving either behind would sim the old shrine level.
 * @param {Object} dto - Player DTO (mutated)
 * @param {Object} candidate - Candidate of type 'guild_shrine'
 */
function applyGuildShrineToDTO(dto, candidate) {
    if (!dto.guildShrineLevels) dto.guildShrineLevels = {};
    dto.guildShrineLevels[candidate.buffHrid] = candidate.upgradeLevel;

    const detail = getGuildBuffDetailMap()[candidate.buffHrid];
    if (detail?.isCombat) {
        dto.guildCombatBuffs = applyGuildBuffLevel(dto.guildCombatBuffs, detail, candidate.upgradeLevel);
    }
}

/**
 * Itemised cost of a shrine level: credits at their gold value, tokens counted.
 *
 * Guild tokens have no market and nothing converts into them, so they are left
 * out of the gold figure entirely and reported as a count. That makes the Cost
 * column — and every ranking built on it — an understatement of what the level
 * costs, which is why the token count travels with it into the row detail.
 *
 * @param {Object} candidate - Candidate of type 'guild_shrine'
 * @returns {Object} Same shape as `explainUpgradeCost`, plus `guild`
 */
function explainGuildShrineCost(candidate) {
    const { lines, total, unpriced } = priceGuildCreditCosts(candidate.creditCosts);

    return {
        guild: {
            tokens: candidate.guildTokenCost || 0,
            credits: lines,
            shrineLevel: candidate.shrineLevel,
            shrineLevelKnown: candidate.shrineLevelKnown,
            needsShrineLevel: candidate.needsShrineLevel,
            shrineName: shrineName(candidate.shrineHrid),
        },
        buys: [],
        credits: [],
        gross: total,
        credit: 0,
        net: total,
        unpriced,
        creditApplied: false,
        source: 'guild',
    };
}

/**
 * Market cost of a house room upgrade: every level from the current one up to the
 * target, counting coins at face value and materials at their buy price.
 * @param {Object} candidate - House candidate
 * @param {Object} gameData - Game data payload
 * @returns {number|null} Total cost, or null when a level or material has no price
 */
function calculateHouseUpgradeCost(candidate, gameData) {
    const costsMap = gameData?.houseRoomDetailMap?.[candidate.roomHrid]?.upgradeCostsMap;
    if (!costsMap) return null;

    let total = 0;
    for (let level = candidate.currentLevel + 1; level <= candidate.upgradeLevel; level++) {
        const costs = costsMap[level] ?? costsMap[String(level)];
        if (!Array.isArray(costs) || costs.length === 0) return null;

        for (const entry of costs) {
            const count = Number(entry?.count) || 0;
            if (!entry?.itemHrid || count <= 0) continue;
            if (entry.itemHrid === '/items/coin') {
                total += count;
                continue;
            }
            const { price } = resolveItemPrice(entry.itemHrid, { side: 'buy' });
            if (!price || price <= 0) return null; // Unknown material cost must not rank as free
            total += price * count;
        }
    }
    return total > 0 ? total : null;
}

/**
 * Clamp candidates that acquire a refined item to at least +10.
 * Refined equipment is not normally worth holding below +10, so a refined
 * suggestion carrying a lower current enhancement level would be a poor
 * acquisition — instead of dropping it, suggest the refined item at +10
 * (cost and sim both use the clamped level). Capes (back slot) are exempt:
 * they are the one item type reasonably refined below +10. Enhancement
 * candidates on an already-equipped refined item are unaffected.
 * @param {Object} candidate - Candidate from generateCandidates() (mutated in place)
 */
function clampRefinedCandidateToMinLevel(candidate) {
    const MIN_REFINED_LEVEL = 10;
    const BACK_SLOT = '/equipment_types/back';
    let clamped = false;

    if (
        candidate.slot !== BACK_SLOT &&
        candidate.upgradeHrid !== candidate.currentHrid &&
        candidate.upgradeHrid?.endsWith('_refined') &&
        candidate.upgradeLevel < MIN_REFINED_LEVEL
    ) {
        candidate.upgradeLevel = MIN_REFINED_LEVEL;
        clamped = true;
    }

    if (candidate.addedSlots) {
        for (const [slot, added] of Object.entries(candidate.addedSlots)) {
            if (
                slot !== BACK_SLOT &&
                added?.hrid?.endsWith('_refined') &&
                (added.enhancementLevel || 0) < MIN_REFINED_LEVEL
            ) {
                added.enhancementLevel = MIN_REFINED_LEVEL;
                clamped = true;
            }
        }
    }

    if (clamped) {
        // Reflect the clamped level(s) in the display text, e.g. "(+4)" → "(+10)",
        // or "(+4/+10)" when a cross-slot swap mixes refined and non-refined items
        const levels = candidate.addedSlots
            ? Object.values(candidate.addedSlots).map((item) => item.enhancementLevel || 0)
            : [candidate.upgradeLevel];
        const unique = [...new Set(levels)];
        const levelText = unique.length === 1 ? `+${unique[0]}` : levels.map((l) => `+${l}`).join('/');
        candidate.description = candidate.description.replace(/\(\+\d+\)$/, `(${levelText})`);
    }
}

/**
 * Calculate the total net gold cost for a candidate upgrade.
 * Uses market prices as primary source (buy upgraded - sell current).
 * Falls back to enhancement cost estimate if market data unavailable.
 *
 * The figure is allowed to come out **negative**, and used to be floored at
 * zero. The floor was not a safety net: it turned every swap whose resale
 * covers its purchase into a free upgrade, and a free upgrade divides into an
 * infinitely good value on every ladder in the table. A swap that pays for
 * itself is a real and rather good thing, and saying so by its true size —
 * "this hands you 40M back" — ranks it above everything without pretending its
 * value per improvement is unbounded. `computeGoldPerImprovement` is where that
 * ordering is made explicit.
 *
 * @param {Object} candidate - Candidate from generateCandidates()
 * @param {Object} gameData - Game data
 * @returns {number|null} Net gold cost, negative when the resale exceeds the
 *   purchase, or null when some part of it has no known price
 */
export function calculateUpgradeCost(candidate, gameData) {
    // Combat skill levels cost XP and time, not gold
    if (candidate.type === 'combat_level') {
        return null;
    }

    // A drink is not bought once, it is drunk forever. Its price per hour is
    // already subtracted from Profit/hr by the sim's own consumable accounting,
    // so charging it again as an outlay would count it twice.
    if (candidate.type === 'drink') {
        return 0;
    }

    // Nobody buys a community buff level; it is what the community happens to
    // have running. Unknown rather than free, so it lands in the unpriced group
    // instead of topping a value ladder it does not belong on.
    if (candidate.type === 'community_buff') {
        return null;
    }

    if (candidate.type === 'house') {
        return calculateHouseUpgradeCost(candidate, gameData);
    }

    // Gold for the credits only — the guild tokens are shown beside it, never
    // folded into it, because nothing converts gold into tokens
    if (candidate.type === 'guild_shrine') {
        return explainGuildShrineCost(candidate).net;
    }

    // Books, at the market price of the book — and null rather than 0 when there
    // is no listing, so an ability nobody is selling is not ranked as free
    if (ABILITY_CANDIDATE_TYPES.has(candidate.type)) {
        return explainAbilityCandidateCost(candidate, gameData).net;
    }

    if (candidate.type === 'cross_slot') {
        let buyCost = 0;
        for (const [slot, item] of Object.entries(candidate.addedSlots)) {
            const { price } = resolveUpgradeBuyPrice(item.hrid, item.enhancementLevel, slot, gameData);
            if (price === null) {
                return null; // Unknown acquisition cost — don't rank as free
            }
            buyCost += price;
        }
        // Credit resale of every item the swap removes (e.g. both main and off hand
        // when moving to a two-hander), not just the primary current item.
        const removedItems = candidate.removedItems || [
            { hrid: candidate.currentHrid, enhancementLevel: candidate.currentLevel },
        ];
        let sellCredit = 0;
        for (const removed of removedItems) {
            sellCredit += resolveItemPrice(removed.hrid, {
                side: 'sell',
                enhancementLevel: removed.enhancementLevel,
            }).price;
        }
        return buyCost - sellCredit;
    }

    if (candidate.type === 'enhancement') {
        // Primary: market price delta (buy at target level - sell at current level)
        // Only use if BOTH levels have actual market listings
        const upgradedMarket = getItemPrices(candidate.currentHrid, candidate.upgradeLevel);
        const currentMarket = getItemPrices(candidate.currentHrid, candidate.currentLevel);

        if (upgradedMarket?.ask > 0 && currentMarket?.bid > 0) {
            return upgradedMarket.ask - currentMarket.bid;
        }

        // Fallback: enhancement cost estimate with protection
        return calculateEnhancementCost(
            candidate.currentHrid,
            candidate.currentLevel,
            candidate.upgradeLevel,
            gameData,
            { slot: candidate.slot }
        );
    }

    // Tier upgrade: buy new item at target enhancement - sell current item
    const { price: buyPrice } = resolveUpgradeBuyPrice(
        candidate.upgradeHrid,
        candidate.upgradeLevel,
        candidate.slot,
        gameData
    );
    if (buyPrice === null) {
        return null; // Unknown acquisition cost — don't rank as free
    }
    const sellPrice = resolveItemPrice(candidate.currentHrid, {
        side: 'sell',
        enhancementLevel: candidate.currentLevel,
    }).price;

    return buyPrice - sellPrice;
}

/**
 * Where a priced figure came from.
 *
 * Three different things end up in the same Cost column, and they are not the
 * same kind of number. A market delta is what the order book says today; a
 * simulated enhance path is an expectation over a random process nobody has
 * run yet; a production cost is what the materials would come to if you made
 * the thing yourself. Ranking them against each other is still the right thing
 * to do — they are all gold — but a reader who cannot tell which is which
 * cannot tell how much to trust a row, so every priced row carries its basis.
 */
export const COST_SOURCES = {
    market: { label: 'mkt', title: 'Market listings on both sides — what the order book says today.' },
    sim: {
        label: 'sim',
        title:
            'No listing at this enhancement level, so the price is the base item plus a simulated ' +
            'enhancement path — an expected cost over a random process, not a quote.',
    },
    craft: {
        label: 'craft',
        title: 'No market listing, so the price is what the materials to make it come to.',
    },
    books: { label: 'books', title: 'Ability books at their market price.' },
    guild: { label: 'guild', title: 'Guild credits at the gold value of the cheapest items that make them.' },
    ongoing: {
        label: 'per-hr',
        title: 'No purchase price — this is an ongoing per-hour spend, already netted out of Profit/hr.',
    },
};

/** Cost bases in descending order of how much a reader should trust them */
const COST_SOURCE_RANK = ['market', 'books', 'guild', 'craft', 'sim', 'ongoing'];

/**
 * The weakest basis among several, since a total is only as solid as its
 * shakiest part.
 * @param {Array<string|null>} sources - Per-item bases
 * @returns {string|null} The least trustworthy one present
 */
function weakestCostSource(sources) {
    let worst = null;
    for (const source of sources) {
        if (!source) continue;
        if (worst === null || COST_SOURCE_RANK.indexOf(source) > COST_SOURCE_RANK.indexOf(worst)) worst = source;
    }
    return worst;
}

/**
 * Resolve the buy price of an item at a given enhancement level.
 * When no price exists at that level (common for refined gear, which rarely
 * has listings above +0), fall back to the base item price plus the expected
 * enhancement cost to reach the level. Returns a null price when nothing is
 * known at all so callers can surface "unknown" instead of a free upgrade.
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Target enhancement level
 * @param {string} slot - Equipment slot HRID (for enhancement cost params)
 * @param {Object} gameData - Game data payload
 * @returns {{price: number|null, source: string|null}} Buy price in gold and its basis
 */
function resolveUpgradeBuyPrice(itemHrid, enhancementLevel, slot, gameData) {
    if (enhancementLevel > 0) {
        // Same method as enhancement candidates: use the market only when the
        // target level has an actual listing. resolveItemPrice cannot be used
        // here — its production-cost fallback ignores the enhancement level and
        // would price a +10 item as a +0 craft.
        const market = getItemPrices(itemHrid, enhancementLevel);
        if (market?.ask > 0) {
            return { price: market.ask, source: 'market' };
        }

        // No listing at the target level: base item price + enhancement cost
        const basePrice = resolveItemPrice(itemHrid, { side: 'buy', enhancementLevel: 0 }).price;
        const enhanceCost = calculateEnhancementCost(itemHrid, 0, enhancementLevel, gameData, { slot });
        // Unknown enhancement cost must stay unknown — pricing the item as a
        // bare +0 craft would understate an enhanced buy by the whole enhance path
        if (enhanceCost == null) {
            return { price: null, source: null };
        }
        const total = Math.max(0, basePrice) + Math.max(0, enhanceCost);
        return total > 0 ? { price: total, source: 'sim' } : { price: null, source: null };
    }

    const direct = resolveItemPrice(itemHrid, { side: 'buy', enhancementLevel: 0 }).price;
    if (!(direct > 0)) return { price: null, source: null };
    // A listing beats the production-cost fallback inside resolveItemPrice, so
    // an ask at +0 is the market speaking and anything else is a craft estimate
    const listed = getItemPrices(itemHrid, 0);
    return { price: direct, source: listed?.ask > 0 ? 'market' : 'craft' };
}

/**
 * Resolve the candidate sets to generate. The Upgrade tab passes a list of
 * checked sets; older single-mode callers pass one mode string ('combined' being
 * shorthand for equipment plus ability levels).
 * @param {string[]|undefined} upgradeModes - Checked candidate sets
 * @param {string|undefined} upgradeMode - Legacy single mode
 * @returns {string[]} Modes to generate candidates for
 */
export function resolveCandidateModes(upgradeModes, upgradeMode) {
    if (Array.isArray(upgradeModes) && upgradeModes.length > 0) {
        // 'food' is a separate optimizer, not a ranked candidate set
        return [...new Set(upgradeModes.filter((mode) => mode !== 'food'))];
    }
    if (upgradeMode === 'combined') return ['equipment', 'ability_level'];
    return upgradeMode ? [upgradeMode] : ['equipment'];
}

/** Candidate types paid for in ability books rather than at the equipment market */
const ABILITY_CANDIDATE_TYPES = new Set(['ability_level', 'ability_swap']);

/**
 * Itemised cost for an ability candidate: the books, and nothing coming back.
 *
 * Two things the equipment breakdown gets wrong about an ability. It prices the
 * upgrade as a market listing for the ability at its level — which does not
 * exist, so a perfectly ordinary "Fireball 48 → 53" reads as "no price found" —
 * and it credits the resale of the level you are leaving, which cannot happen:
 * an ability is not an item and cannot be sold back.
 *
 * @param {Object} candidate - Candidate of type `ability_level` or `ability_swap`
 * @param {Object} gameData - Game data payload
 * @returns {Object} Same shape as `explainUpgradeCost`, plus `books`
 */
function explainAbilityCandidateCost(candidate, gameData) {
    // A swap is learned from scratch; a level-up starts from where it is now
    const swap = candidate.type === 'ability_swap';
    const hrid = swap ? candidate.upgradeHrid : candidate.currentHrid || candidate.upgradeHrid;
    const fromLevel = swap ? 0 : candidate.currentLevel || 0;
    const currentXp = swap ? 0 : (gameData?.levelExperienceTable || [])[fromLevel] || 0;
    const books = explainAbilityLevelUpCost(hrid, fromLevel, currentXp, candidate.upgradeLevel || 0);

    return {
        books,
        // A swap prices a book learned and levelled from nothing. That is the
        // single biggest thing about an ability-swap row and it used to live
        // only in a tab tooltip, where a row claiming a 900M cost gave no hint
        // that the 900M assumes you own none of it
        freshBook: swap,
        buys: [],
        // Never anything here: levels spent on an ability stay spent
        credits: [],
        gross: books.total,
        credit: 0,
        net: books.total,
        unpriced: books.total === null ? [books.bookName] : [],
        creditApplied: false,
        source: 'books',
    };
}

/**
 * Itemised cost for a candidate: what gets bought, at what price, and what the
 * gear it replaces would fetch. Purely for display — the ranking still uses
 * calculateUpgradeCost — so a row showing a blank cost can say which item has no
 * price instead of leaving the reader guessing.
 * @param {Object} candidate - Upgrade candidate
 * @param {Object} gameData - Game data payload
 * @returns {Object} { buys, credits, gross, credit, net, unpriced, source }
 */
export function explainUpgradeCost(candidate, gameData) {
    if (ABILITY_CANDIDATE_TYPES.has(candidate.type)) return explainAbilityCandidateCost(candidate, gameData);
    if (candidate.type === 'guild_shrine') return explainGuildShrineCost(candidate);
    if (candidate.type === 'drink') {
        return {
            buys: [],
            credits: [],
            gross: 0,
            credit: 0,
            net: 0,
            unpriced: [],
            creditApplied: false,
            source: 'ongoing',
        };
    }
    if (candidate.type === 'house') {
        // Coins at face value plus materials at their buy price — a build cost,
        // not a listing for the room
        const total = calculateHouseUpgradeCost(candidate, gameData);
        return {
            buys: [],
            credits: [],
            gross: total,
            credit: 0,
            net: total,
            unpriced: [],
            creditApplied: false,
            source: total == null ? null : 'craft',
        };
    }

    const nameOf = (hrid) => gameData?.itemDetailMap?.[hrid]?.name || hrid?.split('/').pop().replace(/_/g, ' ') || '?';

    const buys = [];
    if (candidate.addedSlots) {
        for (const [slot, item] of Object.entries(candidate.addedSlots)) {
            const { price, source } = resolveUpgradeBuyPrice(item.hrid, item.enhancementLevel || 0, slot, gameData);
            buys.push({
                hrid: item.hrid,
                name: nameOf(item.hrid),
                enhancementLevel: item.enhancementLevel || 0,
                price,
                source,
            });
        }
    } else if (candidate.upgradeHrid) {
        const { price, source } = resolveUpgradeBuyPrice(
            candidate.upgradeHrid,
            candidate.upgradeLevel || 0,
            candidate.slot,
            gameData
        );
        buys.push({
            hrid: candidate.upgradeHrid,
            name: nameOf(candidate.upgradeHrid),
            enhancementLevel: candidate.upgradeLevel || 0,
            price,
            source,
        });
    }

    const removed =
        candidate.removedItems ||
        (candidate.currentHrid ? [{ hrid: candidate.currentHrid, enhancementLevel: candidate.currentLevel || 0 }] : []);
    const credits = removed.map((item) => ({
        hrid: item.hrid,
        name: nameOf(item.hrid),
        enhancementLevel: item.enhancementLevel || 0,
        price: resolveItemPrice(item.hrid, { side: 'sell', enhancementLevel: item.enhancementLevel || 0 }).price || 0,
    }));

    const unpriced = buys.filter((buy) => buy.price === null).map((buy) => buy.name);
    const gross = unpriced.length > 0 ? null : buys.reduce((sum, buy) => sum + buy.price, 0);
    const credit = credits.reduce((sum, entry) => sum + entry.price, 0);

    // An enhancement candidate buys nothing new: it is a market delta between
    // two levels of one item where both are listed, and the enhance path
    // otherwise. Nothing above sees that, so name it here
    let source = weakestCostSource(buys.map((buy) => buy.source));
    if (candidate.type === 'enhancement') {
        const upgraded = getItemPrices(candidate.currentHrid, candidate.upgradeLevel);
        const current = getItemPrices(candidate.currentHrid, candidate.currentLevel);
        source = upgraded?.ask > 0 && current?.bid > 0 ? 'market' : 'sim';
    }

    return {
        buys,
        credits,
        gross,
        credit,
        // Not floored at zero: see calculateUpgradeCost. A swap whose resale
        // beats its purchase hands gold back, and the breakdown says so
        net: gross === null ? null : gross - credit,
        unpriced,
        // Set by the lab analysis when replaced gear is kept rather than sold
        creditApplied: credits.length > 0,
        source: unpriced.length > 0 ? null : source,
    };
}

/**
 * Run the full upgrade analysis: baseline sim + one sim per candidate.
 * @param {Object} params - { playerDTOs, playerIndex, zoneHrid, difficultyTier, hours, communityBuffs, upgradeModes,
 *   upgradeMode, abilityLevelType, abilityTargetLevel, skipBackSlot, combatLevelTargets, charmTier,
 *   houseTargetLevel, houseTargets, optimizeFood }
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline, results: [{candidate, cost, metrics, deltas, goldPer}], food }
 */
export async function runUpgradeAnalysis(params, onProgress, options = {}) {
    const {
        playerDTOs,
        playerIndex,
        zoneHrid,
        difficultyTier,
        hours,
        communityBuffs,
        upgradeModes,
        upgradeMode,
        abilityLevelType,
        abilityTargetLevel,
        skipBackSlot,
        combatLevelTargets,
        abilityTargets,
        charmTier,
        houseTargetLevel = 0,
        houseTargets = null,
        optimizeFood = false,
        extraCandidates = [],
    } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const playerDTO = playerDTOs[playerIndex];
    const playerHrid = playerDTO.hrid;

    // One seed for the whole analysis: baseline and every candidate draw the same
    // random numbers, so a delta reflects the upgrade rather than the gap between
    // two independent samples. A fresh seed per analysis keeps re-runs resampling.
    const simSeed = analysisSeed();

    const candidateModes = resolveCandidateModes(upgradeModes, upgradeMode);
    const candidates = candidateModes.flatMap((mode) =>
        generateCandidates(
            playerDTO,
            gameData,
            mode,
            abilityTargetLevel,
            abilityLevelType,
            skipBackSlot,
            combatLevelTargets,
            abilityTargets,
            houseTargetLevel,
            houseTargets,
            communityBuffs
        )
    );
    // Candidates the caller asked for by name, alongside whatever the mode
    // generated. This is how one specific thing — "what would the Critical Aura
    // do for me" — gets ranked against the upgrades you were already weighing,
    // rather than becoming a change applied to all of them.
    const already = new Set(candidates.map(candidateAssignmentKey));
    for (const candidate of extraCandidates) {
        const key = candidateAssignmentKey(candidate);
        if (already.has(key)) continue;
        already.add(key);
        candidates.push(candidate);
    }

    const candidatesWithCost = candidates.map((c) => {
        // The breakdown already knows which side of the market — or which
        // estimate — each figure came from. Reading it here is what lets a row
        // say so, rather than three different kinds of number sharing a column
        let costDetail = null;
        try {
            costDetail = explainUpgradeCost(c, gameData);
        } catch (error) {
            console.error('[UpgradeAdvisor] Reading the cost basis failed:', error);
        }
        return { ...c, cost: calculateUpgradeCost(c, gameData), costSource: costDetail?.source ?? null, costDetail };
    });

    const combatLevelCount = candidatesWithCost.filter((c) => c.type === 'combat_level').length;
    const foodSimCount = optimizeFood ? estimateFoodSimCount(gameData, playerDTO.food) : 0;
    // +1 baseline, + XP-rate sims for combat levels, + the food search
    const total = candidatesWithCost.length + combatLevelCount + foodSimCount + 1;
    let current = 0;

    // Run baseline sim
    onProgress?.({ current: 0, total, description: 'Running baseline...' });
    // One worker, like every candidate below. The shared seed only cancels
    // sampling noise while both runs draw the same stream in the same order,
    // and the chunking decides the streams: a baseline split four ways is four
    // streams, a candidate unsplit is one, and the two are independent samples
    // however carefully the seed is shared. That mismatch put an identical
    // phantom delta on every combat-inert candidate — a skilling house room
    // "improving" DPS by 0.06%.
    const baselineResult = await runSimulation(
        { gameData, playerDTOs, zoneHrid, difficultyTier, hours, communityBuffs, seed: simSeed },
        null,
        { workers: 1 }
    );
    current++;

    if (abortSignal?.()) return { baseline: null, results: [] };

    onProgress?.({ current, total, description: 'Baseline complete' });

    // Calculate baseline metrics
    const baselineMetrics = computeMetrics(baselineResult, gameData, playerHrid, hours);

    // Run sim for each candidate: one worker each, several candidates at a time.
    //
    // The other way round — one candidate at a time with its hours split across
    // the workers — sounds equivalent, since either way the same total hours get
    // simulated on the same cores. It is not. Splitting means every candidate
    // pays the worker startup and the game-data clone once per chunk instead of
    // once, and it cannot start the next candidate until its own slowest chunk
    // lands. Measured on four workers: 3.3× slower for a 100-hour candidate,
    // 1.14× slower even at five seconds of work apiece, and never faster.
    //
    // Fanning out is still right for a *single* run, where there is no queue to
    // fill — a lone 600-hour sim is about twice as quick split four ways.
    const lanes = Math.max(1, Math.min(analysisConcurrency(), candidatesWithCost.length));
    const progress = { current };

    const evaluateCandidate = async (candidate) => {
        if (abortSignal?.()) return null;

        // Clone playerDTOs and apply candidate upgrade
        const modifiedDTOs = JSON.parse(JSON.stringify(playerDTOs));

        if (candidate.slot.startsWith('ability_')) {
            // Ability upgrade/swap
            const slotIdx = parseInt(candidate.slot.split('_')[1]);
            const existingAbility = modifiedDTOs[playerIndex].abilities[slotIdx];
            if (existingAbility?.hrid === candidate.upgradeHrid) {
                // Leveling the equipped ability: keep its configured combat
                // triggers — wiping them made every level-up sim against the
                // baseline's tuned triggers and read as a regression
                modifiedDTOs[playerIndex].abilities[slotIdx] = {
                    ...existingAbility,
                    level: candidate.upgradeLevel,
                };
            } else {
                modifiedDTOs[playerIndex].abilities[slotIdx] = {
                    hrid: candidate.upgradeHrid,
                    level: candidate.upgradeLevel,
                    triggers: null,
                };
            }
        } else if (candidate.type === 'combat_level') {
            // Combat skill level boost (simulated charm)
            modifiedDTOs[playerIndex][candidate.skillKey] = candidate.upgradeLevel;
        } else if (candidate.type === 'house') {
            // House room level (a room at level 0 isn't in the map yet)
            if (!modifiedDTOs[playerIndex].houseRooms) modifiedDTOs[playerIndex].houseRooms = {};
            modifiedDTOs[playerIndex].houseRooms[candidate.roomHrid] = candidate.upgradeLevel;
        } else if (candidate.type === 'guild_shrine') {
            // One more level in a guild shrine buff, rebuilt at its new value
            applyGuildShrineToDTO(modifiedDTOs[playerIndex], candidate);
        } else if (candidate.type === 'drink') {
            // A coffee into its slot, with the item's own default triggers —
            // the same thing the game hands you when you equip one
            applyDrinkToDTO(modifiedDTOs[playerIndex], candidate);
        } else if (candidate.type === 'community_buff') {
            // Nothing on the DTO: community buffs are an argument to the sim
        } else if (candidate.type === 'cross_slot') {
            // Weapon-configuration swap (two_hand ↔ main_hand + off_hand):
            // clear the replaced slots and equip every added item
            for (const slot of candidate.clearedSlots) {
                modifiedDTOs[playerIndex].equipment[slot] = null;
            }
            for (const [slot, item] of Object.entries(candidate.addedSlots)) {
                modifiedDTOs[playerIndex].equipment[slot] = item;
            }
        } else {
            // Equipment upgrade
            modifiedDTOs[playerIndex].equipment[candidate.slot] = {
                hrid: candidate.upgradeHrid,
                enhancementLevel: candidate.upgradeLevel,
            };
        }

        const simResult = await runSimulation(
            {
                gameData,
                playerDTOs: modifiedDTOs,
                zoneHrid,
                difficultyTier,
                hours,
                communityBuffs: applyCommunityBuffCandidate(communityBuffs, candidate),
                seed: simSeed,
            },
            null,
            // One worker each: the queue is what keeps the cores busy here.
            // Preempting would have each candidate cancel the one before it.
            { preempt: false, workers: 1 }
        );

        if (abortSignal?.()) return null;

        const metrics = computeMetrics(simResult, gameData, playerHrid, hours);
        const deltas = computeDeltas(baselineMetrics, metrics);
        const goldPer = computeGoldPerImprovement(candidate.cost, deltas);

        const economics = computeEconomics(candidate.cost, baselineMetrics, metrics);
        const noise = rateDeltaNoisePct(baselineResult, simResult, playerHrid);
        const significantBy = significantDeltas(deltas, noise);

        const row = {
            candidate,
            cost: candidate.cost,
            costSource: candidate.costSource ?? null,
            costDetail: candidate.costDetail ?? null,
            metrics,
            deltas,
            goldPer,
            economics,
            noise,
            significantBy,
            // The single flag `planWithinBudget` reads. A row is worth planning
            // around if any of the three axes a budget can shop for cleared its
            // error bar; the planner narrows this to the axis actually chosen
            significant: Boolean(significantBy.dps || significantBy.profit || significantBy.xp),
        };
        if (candidate.type === 'combat_level') {
            // Leveling posture: XP rates with the matching charm for this skill
            // equipped (current levels), since that's what you'd wear to grind it
            onProgress?.({ current: progress.current, total, description: `XP rate: ${candidate.description}` });
            const xpDTOs = JSON.parse(JSON.stringify(playerDTOs));
            const currentCharm = xpDTOs[playerIndex].equipment[CHARM_SLOT] || null;
            const matchingCharm = findMatchingCharmForSkill(currentCharm, candidate.skillKey, gameData, charmTier);
            xpDTOs[playerIndex].equipment[CHARM_SLOT] = matchingCharm;
            const xpSimResult = await runSimulation(
                { gameData, playerDTOs: xpDTOs, zoneHrid, difficultyTier, hours, communityBuffs, seed: simSeed },
                null,
                { preempt: false, workers: 1 }
            );
            progress.current++;
            // How much faster the whole zone goes once the levels are in. The
            // candidate's own sim already ran at the boosted levels and the
            // baseline at the current ones, so the ratio of their XP rates is
            // free, and it is what lets the estimate stop pretending the grind
            // ends at the speed it started
            row.levelXpSpeedup = xpRateSpeedup(baselineResult, simResult, playerHrid);
            row.levelTimeHours = estimateCombatLevelTime(
                candidate,
                xpSimResult,
                gameData,
                playerHrid,
                row.levelXpSpeedup
            );
            row.levelingCharmName = matchingCharm
                ? gameData.itemDetailMap[matchingCharm.hrid]?.name || 'matching charm'
                : 'no charm';

            // While a focus charm redirects XP to this skill, the weapon's main
            // training skill(s) level slower — estimate how long each would take
            // to reach its own target in this same leveling setup
            const boost = Math.max(1, Math.floor(abilityTargetLevel) || 5);
            const targets =
                combatLevelTargets &&
                typeof combatLevelTargets === 'object' &&
                Object.keys(combatLevelTargets).length > 0
                    ? combatLevelTargets
                    : null;
            const mainSkills = getMainTrainingSkills(playerDTO, gameData);
            row.isMainSkill = mainSkills.includes(candidate.skillKey.replace('Level', ''));
            row.mainSkillTimes = [];
            for (const skillName of mainSkills) {
                const skillKey = `${skillName}Level`;
                if (skillKey === candidate.skillKey) continue;
                const currentLevel = Math.max(1, Math.floor(playerDTO[skillKey] || 1));
                const upgradeLevel = targets ? Math.min(200, Math.floor(targets[skillKey] || 0)) : currentLevel + boost;
                if (upgradeLevel <= currentLevel) continue;
                row.mainSkillTimes.push({
                    skillKey,
                    label: skillName.charAt(0).toUpperCase() + skillName.slice(1),
                    currentLevel,
                    upgradeLevel,
                    hours: estimateCombatLevelTime(
                        { skillKey, currentLevel, upgradeLevel },
                        xpSimResult,
                        gameData,
                        playerHrid
                    ),
                });
            }
        }
        progress.current++;
        onProgress?.({ current: progress.current, total, description: candidate.description });
        return row;
    };

    onProgress?.({ current: progress.current, total, description: `Simulating ${candidatesWithCost.length} upgrades` });
    const results = (await mapConcurrent(candidatesWithCost, evaluateCandidate, lanes)).filter(Boolean);
    current = progress.current;

    // Score only what can actually be bought — combat levels have no gold cost,
    // so ranking them alongside gear would seed the ladders with non-purchases
    assignRankScores(results.filter((r) => r.candidate.type !== 'combat_level'));

    // Sort by best value (lowest gold per 0.01% DPS improvement)
    results.sort((a, b) => {
        const aVal = a.goldPer.dps === Infinity ? Number.MAX_VALUE : a.goldPer.dps;
        const bVal = b.goldPer.dps === Infinity ? Number.MAX_VALUE : b.goldPer.dps;
        return aVal - bVal;
    });

    // Food is not a ranked upgrade — it is a cost floor at fixed survival, so it
    // gets its own search and its own result shape
    let food = null;
    if (optimizeFood && !abortSignal?.()) {
        try {
            food = await runFoodOptimization(
                {
                    gameData,
                    playerDTOs,
                    playerIndex,
                    zoneHrid,
                    difficultyTier,
                    hours,
                    communityBuffs,
                    seed: simSeed,
                    baselineResult,
                },
                ({ description }) => {
                    current++;
                    onProgress?.({ current, total, description });
                },
                { abortSignal }
            );
        } catch (error) {
            console.error('[UpgradeAdvisor] Food optimization failed:', error);
        }
    }

    return {
        baseline: baselineMetrics,
        results,
        food,
        // Explains an empty house result rather than leaving it as "no upgrades"
        houseScan: candidateModes.includes('house') ? describeHouseScan(playerDTO, gameData) : null,
    };
}

/**
 * How much faster the character earns XP once a candidate's levels are in.
 *
 * Total XP per hour in the boosted run against the same figure in the baseline.
 * Total rather than the one skill's, because the skill being levelled is the
 * one thing a focus charm redistributes — the honest signal for "the zone dies
 * faster now" is everything the character earned.
 *
 * @param {Object} baselineResult - Baseline SimResult
 * @param {Object} upgradedResult - SimResult at the boosted levels
 * @param {string} playerHrid - Whose experience to read
 * @returns {number} Ratio ≥ 1 in the normal case, 1 when it cannot be read
 */
function xpRateSpeedup(baselineResult, upgradedResult, playerHrid) {
    const rate = (result) => {
        const simHours = (result?.simulatedTime || 0) / (3600 * 1e9);
        if (!(simHours > 0)) return 0;
        const xp = result?.experienceGained?.[playerHrid] || {};
        return Object.values(xp).reduce((sum, value) => sum + (value || 0), 0) / simHours;
    };
    const before = rate(baselineResult);
    const after = rate(upgradedResult);
    if (!(before > 0) || !(after > 0)) return 1;
    return after / before;
}

/**
 * Estimate hours of grinding needed to raise a combat skill from its current
 * level to the candidate's boosted level.
 *
 * Integrated level by level rather than divided once. Dividing the whole XP gap
 * by today's rate answers "how long at the speed I go now", but the levels
 * being bought are exactly what makes the character faster — the last level of
 * the span is earned at the end rate, not the start rate — so a one-shot
 * division overstates every span long enough to matter, and overstates the
 * longest ones worst. The rate is walked linearly from the measured start rate
 * to `speedup ×` that, and each level's own XP gap is charged at the rate in
 * force while it is being earned.
 *
 * Linear in level is an approximation and a mild one: the real curve is a
 * function of accuracy and damage against a fixed monster, and over the five to
 * twenty levels these candidates span, its shape matters far less than not
 * pretending the rate is constant.
 *
 * Infinity when the current setup earns no XP in that skill.
 *
 * @param {Object} candidate - combat_level candidate
 * @param {Object} baselineResult - Sim result in the leveling posture
 * @param {Object} gameData - Game data (levelExperienceTable)
 * @param {string} playerHrid - Player HRID in the sim result
 * @param {number} [speedup=1] - XP-rate multiplier once the levels are in
 * @returns {number} Hours needed, or Infinity
 */
function estimateCombatLevelTime(candidate, baselineResult, gameData, playerHrid, speedup = 1) {
    const levelXpTable = gameData.levelExperienceTable || [];
    const skillName = candidate.skillKey.replace('Level', '');
    const simHours = (baselineResult.simulatedTime || 0) / (3600 * 1e9) || 1;
    const startRate = (baselineResult.experienceGained?.[playerHrid]?.[skillName] || 0) / simHours;
    if (!(startRate > 0)) return Infinity;

    const targetXp = levelXpTable[candidate.upgradeLevel];
    if (!Number.isFinite(targetXp)) return Infinity;

    // Use the character's actual XP when their live skill matches the simmed
    // level; otherwise assume the start of the current level
    let currentXp = levelXpTable[candidate.currentLevel] || 0;
    const liveSkill = dataManager.getSkills?.()?.find((s) => s.skillHrid === `/skills/${skillName}`);
    if (liveSkill && liveSkill.level === candidate.currentLevel && Number.isFinite(liveSkill.experience)) {
        currentXp = liveSkill.experience;
    }
    if (targetXp <= currentXp) return 0;

    const span = candidate.upgradeLevel - candidate.currentLevel;
    const growth = Number.isFinite(speedup) && speedup > 0 ? speedup : 1;
    if (!(span > 0) || growth === 1) return (targetXp - currentXp) / startRate;

    let hours = 0;
    let xpSoFar = currentXp;
    for (let level = candidate.currentLevel; level < candidate.upgradeLevel; level++) {
        const levelEndXp = Number.isFinite(levelXpTable[level + 1]) ? levelXpTable[level + 1] : targetXp;
        const gap = Math.max(0, Math.min(levelEndXp, targetXp) - xpSoFar);
        if (gap <= 0) continue;
        // Rate at the midpoint of the level being earned, so the first level is
        // charged at very nearly the measured rate and the last at very nearly
        // the boosted one, rather than a whole level of either being lost
        const progress = (level - candidate.currentLevel + 0.5) / span;
        hours += gap / (startRate * (1 + (growth - 1) * progress));
        xpSoFar += gap;
    }
    return hours;
}

/**
 * Compute key metrics from a sim result.
 */
function computeMetrics(simResult, gameData, playerHrid, hours) {
    const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || hours;
    const xp = simResult.experienceGained?.[playerHrid] || {};
    const totalXpPerHour = Object.values(xp).reduce((s, v) => s + v, 0) / simHours;
    const deaths = (simResult.deaths?.[playerHrid] || 0) / simHours;
    const encounters = (simResult.encounters || 0) / simHours;

    // Profit/hr
    const revenue = calculateSimRevenue(simResult, gameData, playerHrid, simHours);

    return {
        xpPerHour: totalXpPerHour,
        profitPerHour: revenue.netPerHour,
        deathsPerHour: deaths,
        encountersPerHour: encounters,
        dps: (simResult.totalDamageDealt?.[playerHrid] || 0) / (simHours * 3600),
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
        deaths: pctDelta(baseline.deathsPerHour, upgraded.deathsPerHour),
        encounters: pctDelta(baseline.encountersPerHour, upgraded.encountersPerHour),
    };
}

/**
 * How much of a combat row's percentage delta could be the sample.
 *
 * The labyrinth side of the advisor has had this since `attemptsNoise`: a win
 * rate measured over finite trials carries an error, and a delta between two of
 * them carries both. The combat side had nothing, so `significant` was never
 * set on a combat row, the budget planner's noise skip never fired, and a 0.3%
 * DPS "gain" measured over ninety encounters was presented exactly like a 12%
 * one measured over nine thousand.
 *
 * Every metric here is a total divided by hours, and the total is a sum over
 * encounters — so the count of encounters is the sample size, and the relative
 * error of the rate goes as 1/√n. Taking the per-encounter coefficient of
 * variation as 1 is a deliberate round number: the true figure varies by metric
 * and by zone, it is not in the SimResult, and being roughly right about the
 * order of magnitude is the whole job. Deaths are counted rather than summed,
 * so they get the Poisson √d instead, which at two deaths a run is enormous —
 * correctly, since two deaths is not a measurement of anything.
 *
 * Baseline and candidate are added in quadrature. Like `attemptsNoise` this
 * overstates: the runs share a seed, so their errors are correlated and partly
 * cancel out of the difference. Overstating costs an honest row its colour;
 * understating recommends a purchase that did nothing.
 *
 * @param {Object} baselineResult - Baseline SimResult
 * @param {Object} upgradedResult - Candidate SimResult
 * @param {string} playerHrid - Whose deaths are being counted
 * @returns {Object} One standard error per metric, as a percentage of the metric
 */
export function rateDeltaNoisePct(baselineResult, upgradedResult, playerHrid) {
    const encounters = (result) => Math.max(1, Number(result?.encounters) || 0);
    const deaths = (result) => Math.max(1, Number(result?.deaths?.[playerHrid]) || 0);

    const quadrature = (a, b) => Math.sqrt(1 / a + 1 / b) * 100;
    const perEncounter = quadrature(encounters(baselineResult), encounters(upgradedResult));
    const perDeath = quadrature(deaths(baselineResult), deaths(upgradedResult));

    return {
        dps: perEncounter,
        xp: perEncounter,
        profit: perEncounter,
        encounters: perEncounter,
        deaths: perDeath,
    };
}

/**
 * Which of a row's deltas cleared their own error bar.
 * @param {Object} deltas - Percentage deltas from `computeDeltas`
 * @param {Object} noise - Percentage standard errors from `rateDeltaNoisePct`
 * @returns {Object} Per-metric booleans
 */
export function significantDeltas(deltas, noise) {
    const verdict = {};
    for (const key of Object.keys(deltas || {})) {
        const error = noise?.[key];
        verdict[key] = Number.isFinite(error) ? Math.abs(deltas[key]) > SIGNIFICANCE_Z * error : true;
    }
    return verdict;
}

/** Improvement step the gold-per figures are quoted against, in percent. */
export const GOLD_PER_STEP_PCT = 0.01;

/**
 * Compute gold per 0.01% improvement for each metric.
 * Lower = better value.
 *
 * The step size only rescales the figures — it divides every row by the same
 * constant, so the ranking is identical whichever step is quoted.
 */
function computeGoldPerImprovement(cost, deltas) {
    // Unknown cost (null) must rank as Infinity, never as free
    const safeCost = cost == null ? Infinity : cost;
    // pctDelta is already in percent (e.g. 2 = 2%), so a 0.01% step means
    // dividing by pctDelta / 0.01
    const steps = (pctDelta) => Math.abs(pctDelta) / GOLD_PER_STEP_PCT;

    // Gold per improvement is cost ÷ improvement, and at or below zero cost the
    // division stops meaning anything: zero divided by any gain is zero, so
    // every free upgrade ties at the top however small its gain, and a negative
    // cost divided by a tiny gain runs off to minus infinity, so the *worst*
    // paying-for-itself swap outranks the best one. Below zero the figure is
    // therefore the net gold itself — what the swap actually hands back — which
    // keeps every one of them above every purchase while ordering them among
    // themselves by size rather than by how nearly their gain vanished.
    const atOrBelowFree = (pctDelta) => (safeCost <= 0 && pctDelta !== 0 ? safeCost : null);

    const goldPer = (pctDelta) => {
        if (pctDelta <= 0) return Infinity;
        return atOrBelowFree(pctDelta) ?? safeCost / steps(pctDelta);
    };

    // For deaths, fewer is better — use negative delta (reduction)
    const goldPerReduction = (pctDelta) => {
        if (pctDelta >= 0) return Infinity; // Deaths didn't decrease
        return atOrBelowFree(pctDelta) ?? safeCost / steps(pctDelta);
    };

    return {
        dps: goldPer(deltas.dps),
        xp: goldPer(deltas.xp),
        profit: goldPer(deltas.profit),
        encounters: goldPer(deltas.encounters),
        deaths: goldPerReduction(deltas.deaths),
    };
}

/** Hours in a year, for annualising an hourly profit gain. */
const HOURS_PER_YEAR = 24 * 365;

/**
 * Extra simulated time a candidate may take to reach the baseline's fight
 * count. Upgrades usually kill faster and need less, but a defensive swap can
 * need more, and a run cut short by the clock is no longer paired.
 */
const PAIRED_TIME_HEADROOM = 3;

/**
 * Make every run in a comparison play exactly as many fights as the baseline
 * did.
 *
 * The advisor ranks by the *difference* two loadouts make, and shares one seed
 * across the baseline and every candidate so their random draws cancel out of
 * that difference. That cancellation needs the runs to line up fight for fight.
 * Stopping each on its own precision would end them at different points on
 * different slices of the sequence and throw the pairing away, leaving a
 * one-point delta to be read off two independently noisy numbers.
 *
 * A time budget breaks it more quietly: a candidate that kills faster fits more
 * fights into the same hours, so the two runs cover different encounters
 * altogether. Taking the count from the baseline keeps the sample the time
 * budget would have bought, while making it identical across candidates.
 *
 * @param {Object} baselineResult - The baseline run's SimResult
 * @returns {Object} A stopping rule pinned to that fight count
 */
function pairedTrialRule(baselineResult) {
    const trials = Math.max(1, Math.floor(Number(baselineResult?.labyAttemptCount) || 0));
    return { minTrials: trials, maxTrials: trials };
}

/**
 * How long the upgrade takes to afford, and how long it takes to pay for itself.
 *
 * Gold per 0.01% answers "which upgrade is the most efficient". These answer a
 * different question — "is it worth buying at all" — and the two often disagree.
 * An upgrade with an excellent gold-per-DPS figure and a nine-month payback is
 * still a bad purchase for anyone whose bankroll is the binding constraint.
 *
 * Both are derived from the averaged profit figures rather than any single run.
 * A profit delta thin enough to be RNG would otherwise send the repay period
 * asymptotic, and a table cell reading "412 years" from noise is worse than
 * useless — it looks like a measurement.
 *
 * @param {number|null} cost - Gold cost; null means unknown, never free
 * @param {Object} baseline - Baseline metrics ({ profitPerHour })
 * @param {Object} upgraded - Upgraded metrics ({ profitPerHour })
 * @returns {Object} { profitGainPerHour, paybackHours, repayHours } — hours are
 *   Infinity when the cost is unknown, or when the relevant profit is not positive
 */
export function computeEconomics(cost, baseline, upgraded) {
    const safeCost = cost == null ? Infinity : cost;
    const profitGainPerHour = (upgraded?.profitPerHour ?? 0) - (baseline?.profitPerHour ?? 0);

    // Free is free: nothing to save up for and nothing to earn back
    if (safeCost <= 0) {
        return {
            profitGainPerHour,
            paybackHours: 0,
            repayHours: 0,
            roiAnnualPct: profitGainPerHour > 0 ? Infinity : 0,
        };
    }

    const basePerHour = baseline?.profitPerHour ?? 0;
    return {
        profitGainPerHour,
        paybackHours: basePerHour > 0 ? safeCost / basePerHour : Infinity,
        repayHours: profitGainPerHour > 0 ? safeCost / profitGainPerHour : Infinity,
        // A year of the added profit against the outlay. Null when the cost is
        // unknown — zero would read as "no return" rather than "no idea"
        roiAnnualPct: Number.isFinite(safeCost) ? (profitGainPerHour * HOURS_PER_YEAR * 100) / safeCost : null,
    };
}

/** Placings that earn points in the rank score, best first. */
export const RANK_PLACES = 5;

/**
 * Metrics the Score can be built from, and which direction is good.
 *
 * Only value metrics appear here — every one weighs a result against what it
 * costs. Raw deltas are deliberately absent: ranking by ΔDPS alone rewards
 * whatever is most expensive, which is the opposite of what the score is for.
 */
export const SCORE_METRICS = [
    { key: 'dps', label: 'Gold/0.01% DPS', lowerIsBetter: true, value: (r) => r.goldPer?.dps },
    { key: 'xp', label: 'Gold/0.01% EXP', lowerIsBetter: true, value: (r) => r.goldPer?.xp },
    { key: 'profit', label: 'Gold/0.01% Profit', lowerIsBetter: true, value: (r) => r.goldPer?.profit },
    { key: 'encounters', label: 'Gold/0.01% EPH', lowerIsBetter: true, value: (r) => r.goldPer?.encounters },
    { key: 'deaths', label: 'Gold/0.01% DPH', lowerIsBetter: true, value: (r) => r.goldPer?.deaths },
    { key: 'repay', label: 'Repay time', lowerIsBetter: true, value: (r) => r.economics?.repayHours },
    { key: 'roi', label: 'ROI (1yr)', lowerIsBetter: false, value: (r) => r.economics?.roiAnnualPct },
];

/**
 * Metrics scored unless the user says otherwise.
 *
 * ROI is off by default because it is `profit gain / cost` and repay time is
 * `cost / profit gain` — the same ratio inverted. Scoring both counts one
 * signal twice, exactly the trap that keeps the Time column out of the list.
 */
export const DEFAULT_SCORE_KEYS = ['dps', 'xp', 'profit', 'encounters', 'deaths', 'repay'];

/**
 * Score every candidate by how often it places well across the value metrics.
 *
 * Sorting by one column answers only that column's question, and a candidate
 * that is second-best at everything never surfaces. Ranking within each metric
 * and summing the placings finds those all-rounders.
 *
 * The scoring is deliberately ordinal, and that is also its limitation: winning
 * a metric by a mile scores exactly what winning it by a hair scores. It is a
 * shortlisting aid, not a verdict, which is why it is not the default sort.
 *
 * The Time column (cost over current profit rate) is excluded on purpose.
 * Baseline profit is one number shared by every row, so dividing each cost by it
 * preserves the cost ordering exactly — Time is the Cost column in hours, and
 * scoring it would count cost twice. Repay is the one that carries new
 * information, dividing by a gain that differs per row.
 *
 * Ties share a placing, so two candidates that measure identically cannot be
 * separated by list order.
 *
 * Mutates and returns the rows, adding `score` and a `rankPoints` breakdown.
 *
 * @param {Array<Object>} results - Rows carrying `goldPer` and `economics`
 * @param {Object} [options]
 * @param {Array<string>} [options.keys=DEFAULT_SCORE_KEYS] - SCORE_METRICS keys to count
 * @param {number} [options.places=RANK_PLACES] - How many placings earn points
 * @returns {Array<Object>} The same rows
 */
export function assignRankScores(results, options = {}) {
    const places = options.places ?? RANK_PLACES;
    const keys = options.keys ?? DEFAULT_SCORE_KEYS;
    const metrics = SCORE_METRICS.filter((m) => keys.includes(m.key));

    for (const row of results) {
        row.rankPoints = {};
        row.score = 0;
    }

    for (const metric of metrics) {
        const ladder = [...new Set(results.map(metric.value).filter((v) => Number.isFinite(v)))]
            .sort((a, b) => (metric.lowerIsBetter ? a - b : b - a))
            .slice(0, places);
        if (!ladder.length) continue;

        for (const row of results) {
            const index = ladder.indexOf(metric.value(row));
            if (index === -1) continue;
            row.rankPoints[metric.key] = { label: metric.label, place: index + 1, points: places - index };
            row.score += places - index;
        }
    }

    return results;
}

// ─── Labyrinth Buff Upgrade Candidates ──────────────────────────────────────

const LABYRINTH_BUFF_DEFS = [
    {
        key: 'labyrinthCombatDamageLevel',
        name: 'Combat Damage',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'combat_damage',
        typeHrid: '/buff_types/damage',
        valueKey: 'ratioBoost',
    },
    {
        key: 'labyrinthAttackSpeedLevel',
        name: 'Attack Speed',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'attack_speed',
        typeHrid: '/buff_types/attack_speed',
        valueKey: 'ratioBoost',
    },
    {
        key: 'labyrinthCastSpeedLevel',
        name: 'Cast Speed',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'cast_speed',
        typeHrid: '/buff_types/cast_speed',
        valueKey: 'flatBoost',
    },
    {
        key: 'labyrinthCriticalRateLevel',
        name: 'Critical Rate',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'combat',
        uniqueKey: 'critical_rate',
        typeHrid: '/buff_types/critical_rate',
        valueKey: 'flatBoost',
    },
    {
        key: 'labyrinthSkillActionSpeedLevel',
        name: 'Skilling Speed',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'actionSpeedBonus',
    },
    {
        key: 'labyrinthSkillingEfficiencyLevel',
        name: 'Skilling Efficiency',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'efficiencyBonus',
    },
    {
        key: 'labyrinthSkillingSuccessLevel',
        name: 'Success Rate',
        step: 0.005,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'successBonus',
    },
    {
        key: 'labyrinthSkillingDoubleProgressLevel',
        name: 'Double Progress',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 40,
        category: 'skilling',
        metric: 'doubleProgressBonus',
    },
    {
        key: 'labyrinthExperienceLevel',
        name: 'Experience',
        step: 0.01,
        maxLevel: 12,
        tokenCost: 80,
        category: 'experience',
    },
];

const LABYRINTH_SKILLS = [
    '/skills/woodcutting',
    '/skills/foraging',
    '/skills/milking',
    '/skills/cooking',
    '/skills/brewing',
    '/skills/cheesesmithing',
    '/skills/crafting',
    '/skills/tailoring',
    '/skills/alchemy',
    '/skills/enhancing',
];

/**
 * Generate labyrinth buff upgrade candidates from characterInfo.
 * @returns {Array} Buff candidates with type 'labyrinth_buff'
 */
export function generateLabyrinthBuffCandidates() {
    const info = dataManager.characterData?.characterInfo;
    if (!info) return [];

    const candidates = [];
    for (const def of LABYRINTH_BUFF_DEFS) {
        const currentLevel = Math.max(0, Math.floor(Number(info[def.key]) || 0));
        if (currentLevel >= def.maxLevel) continue;

        candidates.push({
            type: 'labyrinth_buff',
            category: def.category,
            buffKey: def.key,
            currentLevel,
            step: def.step,
            tokenCost: def.tokenCost * (currentLevel + 1),
            description: `${def.name} Lv${currentLevel}\u2192${currentLevel + 1}`,
            uniqueKey: def.uniqueKey,
            typeHrid: def.typeHrid,
            valueKey: def.valueKey,
            metric: def.metric,
        });
    }
    return candidates;
}

/**
 * Clone labyrinth combat buffs with +1 to a specific buff.
 * @param {Array} baseBuffs - Current labyrinth combat buffs
 * @param {Object} candidate - Buff candidate with uniqueKey/typeHrid/valueKey/step
 * @returns {Array} Modified buffs array
 */
function buildModifiedCombatBuffs(baseBuffs, candidate) {
    const uniqueHrid = `/buff_uniques/labyrinth_upgrade_${candidate.uniqueKey}`;
    const modified = JSON.parse(JSON.stringify(baseBuffs));

    const existing = modified.find((b) => b.uniqueHrid === uniqueHrid);
    if (existing) {
        existing[candidate.valueKey] += candidate.step;
    } else {
        const buff = {
            uniqueHrid,
            typeHrid: candidate.typeHrid,
            ratioBoost: 0,
            ratioBoostLevelBonus: 0,
            flatBoost: 0,
            flatBoostLevelBonus: 0,
            startTime: '0001-01-01T00:00:00Z',
            duration: 0,
        };
        buff[candidate.valueKey] = candidate.step;
        modified.push(buff);
    }
    return modified;
}

/**
 * Cost breakdown for a lab candidate, noting resale that was deliberately not
 * credited because the replaced gear is being kept for other floors.
 * @param {Object} candidate - Upgrade candidate
 * @param {Object} gameData - Game data payload
 * @returns {Object} Breakdown from explainUpgradeCost plus kept-gear detail
 */
function explainLabCandidateCost(candidate, gameData) {
    const detail = explainUpgradeCost(candidate, gameData);
    if (!candidate.keptItems?.length) return detail;

    const nameOf = (hrid) => gameData?.itemDetailMap?.[hrid]?.name || hrid.split('/').pop().replace(/_/g, ' ');
    detail.kept = candidate.keptItems.map((item) => ({
        hrid: item.hrid,
        name: nameOf(item.hrid),
        enhancementLevel: item.enhancementLevel || 0,
        price: resolveItemPrice(item.hrid, { side: 'sell', enhancementLevel: item.enhancementLevel || 0 }).price || 0,
    }));
    detail.keptValue = detail.kept.reduce((sum, entry) => sum + entry.price, 0);
    return detail;
}

/**
 * Run labyrinth upgrade analysis: baseline sim + equipment sims + buff sims.
 * Ranks upgrades by win rate / clear rate delta, grouped by cost type (token vs gold).
 * @param {Object} params
 * @param {Array} params.playerDTOs - Player DTOs (only first used — labyrinth is solo)
 * @param {number} params.playerIndex - Index of the player to analyze
 * @param {string} params.monsterHrid - Labyrinth monster HRID
 * @param {number} params.roomLevel - Room level to test at
 * @param {string[]} params.crates - Crate item HRIDs
 * @param {number} params.hours - Hours to simulate per candidate
 * @param {Object} params.communityBuffs - Community buffs
 * @param {Array} [params.labyrinthCombatBuffs] - Combat buffs from labyrinth upgrades
 * @param {string} params.upgradeMode - 'equipment', 'ability_level', or 'ability_swap'
 * @param {number} [params.abilityTargetLevel] - Target ability level
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline, results: [{candidate, costType, ...}] }
 */
export async function runLabyrinthUpgradeAnalysis(params, onProgress, options = {}) {
    const {
        playerDTOs,
        playerIndex,
        monsterHrid,
        roomLevel,
        crates,
        hours,
        communityBuffs,
        labyrinthCombatBuffs = [],
        upgradeMode,
        abilityLevelType,
        abilityTargetLevel,
        skipBackSlot,
        combatLevelTargets,
        abilityTargets,
        extraCandidates = [],
    } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const playerDTO = playerDTOs[playerIndex];

    // Shared across baseline and every candidate so win-rate deltas measure the
    // upgrade, not the gap between two independent random samples
    const simSeed = analysisSeed();

    const zoneHrid =
        Object.keys(gameData.actionDetailMap).find((k) => k.includes('/actions/combat/')) || '/actions/combat/fly';

    // Generate candidates ('combined' runs equipment and ability levels together)
    const labCandidateModes = upgradeMode === 'combined' ? ['equipment', 'ability_level'] : [upgradeMode];
    const candidates = labCandidateModes.flatMap((mode) =>
        generateCandidates(
            playerDTO,
            gameData,
            mode,
            abilityTargetLevel,
            abilityLevelType,
            skipBackSlot,
            combatLevelTargets,
            abilityTargets
        )
    );

    // The labyrinth lives or dies on body/legs, so always evaluate the Anchorbound
    // plate and the top-tier armor matching this loadout's weapon — the tier
    // progression only ever steps one rung from what's worn and would hide them
    if (labCandidateModes.includes('equipment')) {
        const forced = generateLabArmorCandidates(playerDTO, gameData, dataManager.getInventory());
        // The labyrinth needs every element set, so these swaps are usually an
        // added purchase rather than a trade-in — pricing them net of selling the
        // piece they replace would understate what they actually cost
        const keepReplaced = config.getSettingValue('labSim_keepReplacedGear', true);
        const seen = new Set(candidates.map(candidateAssignmentKey));
        for (const candidate of forced) {
            const key = candidateAssignmentKey(candidate);
            if (seen.has(key)) continue;
            seen.add(key);
            if (keepReplaced) {
                candidate.keptItems = candidate.removedItems;
                candidate.removedItems = [];
            }
            candidates.push(candidate);
        }
    }

    // Candidates the caller asked for by name, alongside whatever the mode
    // generated. This is how one specific thing — "what would the Critical Aura
    // do for me" — gets ranked against the upgrades you were already weighing,
    // rather than becoming a change applied to all of them.
    const already = new Set(candidates.map(candidateAssignmentKey));
    for (const candidate of extraCandidates) {
        const key = candidateAssignmentKey(candidate);
        if (already.has(key)) continue;
        already.add(key);
        candidates.push(candidate);
    }

    const candidatesWithCost = candidates.map((c) => ({
        ...c,
        cost: calculateUpgradeCost(c, gameData),
    }));

    // Generate buff candidates. Skilling buffs are handled in the skilling tab;
    // the Experience token is ranked in neither tab — it moves XP/room, not
    // clear rate, and this analysis has no XP metric to rank it by.
    const buffCandidates = generateLabyrinthBuffCandidates();
    const combatBuffCandidates = buffCandidates.filter((c) => c.category === 'combat');

    const total = candidatesWithCost.length + combatBuffCandidates.length + 1;
    let current = 0;

    // Run baseline labyrinth sim
    onProgress?.({ current: 0, total, description: 'Running baseline...' });
    const baselineResult = await runLabyrinthSimulation({
        gameData,
        playerDTOs: [playerDTOs[playerIndex]],
        zoneHrid,
        monsterHrid,
        roomLevel,
        crates,
        hours,
        communityBuffs,
        labyrinthCombatBuffs,
        seed: simSeed,
    });
    current++;
    // Every candidate below plays exactly the baseline's fight count
    const pairedRule = pairedTrialRule(baselineResult);
    const pairedHours = hours * PAIRED_TIME_HEADROOM;

    if (abortSignal?.()) return { baseline: null, results: [] };

    const baselineAttempts = baselineResult.labyAttemptCount || 1;
    const baselineEncounters = baselineResult.encounters || 0;
    const baselineWinRate = baselineEncounters / baselineAttempts;

    onProgress?.({ current, total, description: `Baseline: ${(baselineWinRate * 100).toFixed(1)}%` });

    const results = [];
    const progress = { current };

    // Every candidate is one worker against the same baseline with the same
    // seed and the same trial count, so they are independent runs that were
    // being done one at a time
    const runCandidate = async (candidate, playerDTO, buffs, describe) => {
        if (abortSignal?.()) return null;
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [playerDTO],
            zoneHrid,
            monsterHrid,
            roomLevel,
            crates,
            hours: pairedHours,
            precision: pairedRule,
            communityBuffs,
            labyrinthCombatBuffs: buffs,
            seed: simSeed,
        });
        if (abortSignal?.()) return null;
        progress.current++;
        onProgress?.({ current: progress.current, total, description: describe });
        const attempts = simResult.labyAttemptCount || 1;
        return (simResult.encounters || 0) / attempts;
    };

    // ── Equipment / ability sims ──
    onProgress?.({ current: progress.current, total, description: `Simulating ${candidatesWithCost.length} upgrades` });
    const equipmentRates = await mapConcurrent(candidatesWithCost, (candidate) =>
        runCandidate(
            candidate,
            applyCandidateToDTO(playerDTOs[playerIndex], candidate),
            labyrinthCombatBuffs,
            candidate.description
        )
    );

    for (let i = 0; i < candidatesWithCost.length; i++) {
        const candidate = candidatesWithCost[i];
        const winRate = equipmentRates[i];
        if (winRate === null || winRate === undefined) continue;
        const winRateDelta = winRate - baselineWinRate;

        results.push({
            candidate,
            costDetail: explainLabCandidateCost(candidate, gameData),
            costType: 'gold',
            cost: candidate.cost,
            winRate,
            winRateDelta,
            goldPerWinRate:
                winRateDelta > 0 && candidate.cost != null ? candidate.cost / (winRateDelta * 100) : Infinity,
            metricType: 'winRate',
        });
    }

    // ── Combat buff sims ──
    const buffRates = await mapConcurrent(combatBuffCandidates, (buffCandidate) =>
        runCandidate(
            buffCandidate,
            playerDTOs[playerIndex],
            buildModifiedCombatBuffs(labyrinthCombatBuffs, buffCandidate),
            buffCandidate.description
        )
    );

    for (let i = 0; i < combatBuffCandidates.length; i++) {
        const buffCandidate = combatBuffCandidates[i];
        const winRate = buffRates[i];
        if (winRate === null || winRate === undefined) continue;
        const winRateDelta = winRate - baselineWinRate;

        results.push({
            candidate: buffCandidate,
            costType: 'token',
            tokenCost: buffCandidate.tokenCost,
            winRate,
            winRateDelta,
            metricType: 'winRate',
        });
    }

    // Sort: token results first, then gold; within each group by best delta descending
    results.sort((a, b) => {
        if (a.costType !== b.costType) return a.costType === 'token' ? -1 : 1;
        const aDelta = a.winRateDelta ?? a.clearRateDelta ?? 0;
        const bDelta = b.winRateDelta ?? b.clearRateDelta ?? 0;
        return bDelta - aDelta;
    });

    return {
        baseline: {
            winRate: baselineWinRate,
            encounters: baselineEncounters,
            attempts: baselineAttempts,
        },
        results,
    };
}

/** Win-rate floor for expected-attempts math so 0% fights stay finite (= 1000 tries) */
const ATTEMPT_WIN_RATE_FLOOR = 0.001;

/** How many standard errors a gain has to clear before it is called a gain */
const SIGNIFICANCE_Z = 1.96;

/**
 * The sampling error on "attempts saved across the run".
 *
 * Every win rate here is a proportion measured over a finite number of simulated
 * attempts, so every one carries an error — and the table's headline figure is a
 * sum of ten of them, put through 1/p, which magnifies the error badly at low
 * win rates. Without this, a run of luck on one 30% room reads as a 1.6B item
 * being worth buying.
 *
 * Per fight the standard error of the rate is the binomial √(p(1−p)/n), and
 * 1/p turns that into se/p² (the derivative of 1/p). Baseline and candidate are
 * added in quadrature, which is conservative: they share a seed, so their errors
 * are correlated and partly cancel. Overstating the noise costs a few honest
 * rows their colour; understating it recommends purchases that did nothing.
 *
 * @param {Array<Object>} appliedFights - The candidate's fights, applied ones only
 * @param {Array<Object>} baselineFights - The baseline, index-aligned by monster
 * @returns {number} One standard error of the attempts delta
 */
export function attemptsNoise(appliedFights, baselineFights = []) {
    const byMonster = new Map(
        (baselineFights || []).map((fight) => [`${fight.monsterHrid}@${fight.roomLevel}`, fight])
    );

    let variance = 0;
    for (const fight of appliedFights || []) {
        const base = byMonster.get(`${fight.monsterHrid}@${fight.roomLevel}`);
        for (const side of [fight, base]) {
            if (!side) continue;
            const trials = Math.max(1, Number(side.trials) || 0);
            const rate = Math.max(ATTEMPT_WIN_RATE_FLOOR, Math.min(1, Number(side.winRate) || 0));
            // d(1/p)/dp = −1/p², so the error on the tries figure is se/p²
            const standardError = Math.sqrt((rate * (1 - rate)) / trials);
            variance += (standardError / (rate * rate)) ** 2;
        }
    }
    return Math.sqrt(variance);
}

/**
 * The piece a candidate would displace in one particular loadout.
 *
 * One purchase serves every loadout, and with tier upgrades applying wherever
 * they would help, "what it replaces" is a different answer per room. The row's
 * own description can only name one of them.
 *
 * @param {Object} candidate - The upgrade
 * @param {Object} dto - The loadout
 * @param {Object} [gameData] - For the item's name
 * @returns {string} Display name, or '' where it displaces nothing
 */
export function replacedIn(candidate, dto, gameData) {
    const slots = candidate.addedSlots ? Object.keys(candidate.addedSlots) : [candidate.slot];
    const names = [];
    for (const slot of slots) {
        const worn = dto?.equipment?.[slot];
        if (!worn?.hrid || worn.hrid === candidate.upgradeHrid) continue;
        const detail = gameData?.itemDetailMap?.[worn.hrid];
        const name = detail?.name || worn.hrid.split('/').pop().replace(/_/g, ' ');
        names.push(worn.enhancementLevel ? `${name} +${worn.enhancementLevel}` : name);
    }
    return names.join(' + ');
}

/**
 * What two upgrades have to share before buying both is wasteful.
 *
 * Some pairs are genuinely alternatives: two targets for one ability, or two
 * levels of one combat skill, where the higher already contains the lower.
 * Buying both spends the second one's price for nothing.
 *
 * Equipment slots are *not* in that category, which is the whole point of a
 * labyrinth run — a second chestpiece is wasteful only if it serves the same
 * rooms as the first. Where it serves rooms the first cannot reach, it is a
 * second purchase doing a second job, and the plan treats it that way.
 *
 * @param {Object} candidate - The upgrade
 * @returns {string} Key that candidates in the same group share
 */
export function conflictKey(candidate) {
    if (candidate.type === 'combat_level') return `skill:${candidate.skillKey}`;
    if (candidate.type === 'house') return `house:${candidate.slot}`;
    if (candidate.type === 'guild_shrine') return `guild:${candidate.buffHrid}`;
    if (candidate.type === 'community_buff') return `community:${candidate.buffKey}`;
    // Two coffees of one buff family cannot both be up, whichever slots they
    // would sit in — the game's own conflict rule, keyed the same way
    if (candidate.type === 'drink') return `drink:${candidate.buffFamily}`;
    if (candidate.slot?.startsWith('ability_')) return `ability:${candidate.upgradeHrid}`;

    const slots = candidate.addedSlots
        ? [...Object.keys(candidate.addedSlots), ...(candidate.clearedSlots || [])]
        : [candidate.slot];
    // A two-hander and a main-hand+off-hand pair are competing for the same
    // hands even though they name different slots
    const hands = ['/equipment_types/two_hand', '/equipment_types/main_hand', '/equipment_types/off_hand'];
    if (slots.some((slot) => hands.includes(slot))) return 'slot:weapon';
    return `slot:${[...new Set(slots)].sort().join('+')}`;
}

/**
 * Whether a group admits exactly one purchase, whatever the rooms say.
 *
 * A skill level, an ability level and a house room are one number the character
 * carries everywhere. There is no second copy to wear in another room, so the
 * higher target simply contains the lower and buying both is buying one twice.
 *
 * @param {Object} candidate - The upgrade
 * @returns {boolean}
 */
function isExclusive(candidate) {
    return (
        candidate.type === 'combat_level' ||
        candidate.type === 'house' ||
        candidate.type === 'guild_shrine' ||
        candidate.type === 'community_buff' ||
        candidate.type === 'drink' ||
        Boolean(candidate.slot?.startsWith('ability_'))
    );
}

/**
 * The best set of upgrades a budget will buy.
 *
 * ## Why not simply the top few by value
 *
 * A labyrinth run is ten fights in ten loadouts, and a purchase only helps the
 * rooms it reaches. Ranking by total value and allowing one item per slot
 * answers a question about a single fight; the question here is which purchases
 * cover the most rooms most effectively, and the answer can be **two
 * chestpieces** — one for the melee loadouts, one for the casters. What it must
 * never be is two chestpieces for the same rooms, where the second is gold spent
 * on a piece that never gets worn.
 *
 * So each candidate is valued at what it adds *beyond what is already bought*.
 * Within a slot a room wears whichever picked piece is best for it, so a second
 * piece is worth exactly the rooms it improves on the first — nothing more.
 * Across slots the gains are taken as adding up, which is the assumption the
 * combination check exists to test.
 *
 * Greedy rather than an exact optimum, deliberately: the values are simulated
 * estimates with real error bars, an optimum computed from them is false
 * precision, and a list whose order can be read off the table is worth more than
 * one that is a percent better and inexplicable.
 *
 * @param {Array<Object>} results - Ranked analysis results
 * @param {number} budget - Coins available
 * @param {Object} [options] - `{ baselineFights, includeUnmeasured }`
 * @returns {{picks: Array<Object>, totalCost: number, attemptsSaved: number,
 *   skipped: Array<{result: Object, reason: string}>, budget: number}}
 */
export function planWithinBudget(results, budget, { baselineFights = [], includeUnmeasured = false } = {}) {
    const baseTries = baselineFights.map((fight) => expectedFightAttempts(fight.winRate || 0));

    /** What one candidate saves in each fight, in expected attempts */
    const savingsOf = (result) => {
        if (!baseTries.length || !result.fights?.length) {
            // No per-fight detail to work from — value it at the run total, which
            // is what a plan without a baseline can honestly say
            return [Math.max(0, -result.attemptsDelta)];
        }
        return result.fights.map((fight, index) =>
            fight.applied === false
                ? 0
                : Math.max(0, (baseTries[index] ?? 0) - expectedFightAttempts(fight.winRate || 0))
        );
    };

    const eligible = [];
    const skipped = [];
    for (const result of results || []) {
        // A budget is in coins, so a row without a price cannot be planned
        // around. A *negative* one can: a swap whose resale beats its purchase
        // hands money back into the budget, and used to be discarded here
        // alongside the unpriceable ones
        if (!Number.isFinite(result.cost)) continue;
        if (!(result.attemptsDelta < 0)) continue;
        if (!includeUnmeasured && result.significant === false) {
            skipped.push({ result, reason: 'within the noise of the simulation' });
            continue;
        }
        eligible.push({ result, savings: savingsOf(result), key: conflictKey(result.candidate) });
    }

    const picks = [];
    const taken = new Set();
    // The best saving reached so far in each group, per fight. A room wears one
    // piece per slot, so this is what a further piece has to beat to be worth
    // anything there.
    const bestBySlot = new Map();
    let spent = 0;

    const marginalOf = (entry) => {
        const standing = bestBySlot.get(entry.key);
        if (!standing) return entry.savings.reduce((sum, saving) => sum + saving, 0);
        let marginal = 0;
        for (let i = 0; i < entry.savings.length; i++) {
            marginal += Math.max(standing[i] || 0, entry.savings[i]) - (standing[i] || 0);
        }
        return marginal;
    };

    const remaining = [...eligible];
    while (remaining.length) {
        let best = null;
        for (const entry of remaining) {
            if (isExclusive(entry.result.candidate) && taken.has(entry.key)) continue;
            if (spent + entry.result.cost > budget) continue;
            const marginal = marginalOf(entry);
            if (marginal <= 0) continue;
            const cost = entry.result.cost;
            // Gain per coin is meaningless at or below zero cost — everything
            // free ties at infinity and a refund divided by a small gain is
            // *more* negative the worse the row is. So the free-and-refunding
            // rows are taken first, biggest refund first, and only then does
            // the ratio decide among things that actually cost money
            const value = cost > 0 ? marginal / cost : Infinity;
            const contender = { entry, marginal, value, cost, free: cost <= 0 };
            if (!best) {
                best = contender;
            } else if (contender.free !== best.free) {
                if (contender.free) best = contender;
            } else if (contender.free) {
                if (contender.cost < best.cost || (contender.cost === best.cost && marginal > best.marginal)) {
                    best = contender;
                }
            } else if (value > best.value) {
                best = contender;
            }
        }
        if (!best) break;

        const { entry, marginal } = best;
        remaining.splice(remaining.indexOf(entry), 1);
        taken.add(entry.key);
        spent += entry.result.cost;
        picks.push({
            ...entry.result,
            marginalAttemptsSaved: marginal,
            rooms: entry.savings.filter((saving) => saving > 0).length,
        });

        const standing = bestBySlot.get(entry.key) || entry.savings.map(() => 0);
        bestBySlot.set(
            entry.key,
            standing.map((saving, index) => Math.max(saving, entry.savings[index]))
        );

        // A piece nobody would now wear is gold spent on nothing: if an earlier
        // pick in this group has been beaten in every room it covered, take it
        // back out and give the budget back
        for (let i = picks.length - 2; i >= 0; i--) {
            const older = picks[i];
            if (conflictKey(older.candidate) !== entry.key) continue;
            const olderSavings = savingsOf(older);
            if (olderSavings.every((saving, index) => saving <= (entry.savings[index] ?? 0) + 1e-9)) {
                spent -= older.cost;
                picks.splice(i, 1);
                skipped.push({ result: older, reason: 'a later pick covers every room it did' });
            }
        }
    }

    for (const entry of remaining) {
        skipped.push({
            result: entry.result,
            reason: spent + entry.result.cost > budget ? 'over budget' : 'adds nothing the picks do not already cover',
        });
    }

    // What the set saves across the run, if gains in different slots add up
    let attemptsSaved = 0;
    for (const savings of bestBySlot.values()) {
        for (const saving of savings) attemptsSaved += saving;
    }

    return { picks, totalCost: spent, attemptsSaved, skipped, budget };
}

/**
 * Run a job per item, several at a time.
 *
 * A labyrinth fight is its own worker with its own seed and its own trial count,
 * so ten fights are ten independent runs that were being done one after another
 * on a machine with eight cores idle. Bounded rather than all at once: each
 * worker gets its own copy of the game data, and a fleet of them competing for
 * one core apiece is slower than a queue.
 *
 * Results come back in the order the items were given, whatever order they
 * finished in — every figure downstream is indexed by fight.
 *
 * @param {Array} items - What to run
 * @param {Function} run - `(item, index) => Promise`
 * @param {number} [limit] - How many at once
 * @returns {Promise<Array>} Results, in input order
 */
async function mapConcurrent(items, run, limit = analysisConcurrency()) {
    const results = new Array(items.length);
    const width = Math.max(1, Math.min(limit, items.length));
    let next = 0;
    let failure = null;

    const lane = async () => {
        while (failure === null) {
            const index = next++;
            if (index >= items.length) return;
            try {
                results[index] = await run(items[index], index);
            } catch (error) {
                // Stop handing out work. Without this the other lanes keep
                // starting simulations for a run whose result has already been
                // thrown away — a failed analysis would go on spawning workers
                // for every fight it had left.
                failure = error;
            }
        }
    };

    await Promise.all(Array.from({ length: width }, lane));
    if (failure) throw failure;
    return results;
}

/**
 * How many simulations an analysis may have in flight at once.
 *
 * Capped, not simply "as many as there are cores". Each simulation is a Worker
 * that receives its own structured clone of the whole game data — every item,
 * ability, monster and action in the game — so the fleet costs memory in
 * proportion to its width. And the tab it is competing with is the game itself:
 * an analysis that takes every core makes the thing you are playing stutter,
 * which is a poor trade for a run finishing sooner.
 *
 * The tile badges and the skip-level searches also run labyrinth sims in the
 * background without asking anyone, so this is a budget for one analysis rather
 * than for the page.
 *
 * @returns {number} Simulations at once
 */
function analysisConcurrency() {
    const budget = getMaxWorkers();
    if (config.getSetting('combatSim_uncapThreads')) return Math.max(1, budget);
    return Math.max(1, Math.min(budget, ANALYSIS_MAX_CONCURRENCY));
}

/** Ceiling on simultaneous sims per analysis, whatever the thread setting says */
const ANALYSIS_MAX_CONCURRENCY = 6;

/** Expected labyrinth attempts to clear one fight (retry until win) */
function expectedFightAttempts(winRate) {
    return 1 / Math.max(winRate, ATTEMPT_WIN_RATE_FLOOR);
}

/**
 * Sim every labyrinth combat room — each with its assigned loadout at its
 * skip-derived room level — under each combat-level boost, to rank which
 * skill level upgrade improves the whole run the most. The collective metric
 * is the expected number of combat attempts to clear every fight (Σ 1/win
 * rate — the labyrinth lets you retry a failed room), which naturally weights
 * the worst fights. The all-fights-in-one-go product (run clear chance) is
 * also returned but is near zero whenever several fights sit below ~50%.
 *
 * Candidates are the union of style-relevant skills across all fight loadouts
 * (loadouts can differ in style, e.g. a ranged loadout for one monster and a
 * melee loadout for another), so a skill shows if any assigned loadout trains it.
 *
 * Each is then measured only against the fights it is actually about — see
 * `candidateAppliesToDTO`. A combat level is every fight; a piece of gear is the
 * fights whose loadout wears what it replaces, and the rest keep their baseline
 * untouched rather than being simulated wearing something they would never wear.
 * @param {Object} params - { fights, crates, hours, communityBuffs, labyrinthCombatBuffs, abilityTargetLevel, combatLevelTargets }
 *   where fights = [{ monsterHrid, monsterName, roomLevel, dto, loadoutName }]
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline: { fights, runClearChance, expectedAttempts },
 *   results: [{candidate, fights, runClearChance, runClearDelta, expectedAttempts, attemptsDelta, avgWinDelta}] }
 */
export async function runLabyrinthAllFightsAnalysis(params, onProgress, options = {}) {
    const {
        fights,
        crates,
        hours,
        communityBuffs,
        labyrinthCombatBuffs = [],
        abilityTargetLevel,
        combatLevelTargets,
        abilityTargets,
        modes = ['combat_level'],
        extraCandidates = [],
    } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const zoneHrid =
        Object.keys(gameData.actionDetailMap).find((k) => k.includes('/actions/combat/')) || '/actions/combat/fly';

    // The union of candidates across every fight's loadout.
    //
    // Union rather than per-fight, because the question is what to buy — one
    // thing, once, that has to serve every room. A candidate generated from the
    // Cyclops loadout is still worth simming against the Mimic, and the two
    // loadouts usually differ in only a slot or two.
    //
    // Keyed by what the candidate actually changes rather than by skill, since
    // combat levels are one per skill but equipment is many per slot.
    const candidatesByKey = new Map();
    for (const fight of fights) {
        for (const mode of modes) {
            const fightCandidates = generateCandidates(
                fight.dto,
                gameData,
                mode,
                abilityTargetLevel,
                'increment',
                false,
                combatLevelTargets,
                abilityTargets
            );
            for (const candidate of fightCandidates) {
                const key = candidateAssignmentKey(candidate);
                if (!candidatesByKey.has(key)) candidatesByKey.set(key, candidate);
            }
        }
    }
    for (const candidate of extraCandidates) {
        const key = candidateAssignmentKey(candidate);
        if (!candidatesByKey.has(key)) candidatesByKey.set(key, candidate);
    }
    // Which fights each candidate is actually about. A combat level is every
    // fight; a piece of gear is only the fights whose loadout wears the piece it
    // replaces — installing a melee sword into a magic loadout measures a
    // costume change, not an upgrade, and drags the aggregate with it.
    const candidates = [...candidatesByKey.values()]
        .map((candidate) => ({
            ...candidate,
            cost: candidate.cost ?? calculateUpgradeCost(candidate, gameData),
            appliesTo: fights.map((fight) => candidateAppliesToDTO(candidate, fight.dto, gameData)),
        }))
        .filter((candidate) => candidate.appliesTo.some(Boolean));

    // Only the fights a candidate touches are simulated; the rest keep their
    // baseline, which is both the truth and a great deal less work
    const simsPerCandidate = candidates.reduce((sum, c) => sum + c.appliesTo.filter(Boolean).length, 0);
    const total = fights.length + simsPerCandidate;
    // An object rather than a counter variable: the fight passes run
    // concurrently and close over it, and a plain `let` shared by closures
    // inside a loop is exactly the shape lint is right to be suspicious of
    const progress = { current: 0 };

    // Per-fight seeds derived from one analysis seed: fight N is simmed with the
    // same random draws in the baseline pass and in every candidate pass, so a
    // win-rate delta is the level boost rather than two independent samples
    const simSeed = analysisSeed();
    const fightSeed = (fightIndex) => deriveSeed(simSeed, fightIndex);

    // A fight's baseline pass sets the fight count every candidate pass for
    // that fight must match, so each comparison stays paired
    const pairedRules = new Map();
    const simFightWinRate = async (fight, dtoOverride, seed, fightIndex) => {
        const rule = pairedRules.get(fightIndex) || null;
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [dtoOverride || fight.dto],
            zoneHrid,
            monsterHrid: fight.monsterHrid,
            roomLevel: fight.roomLevel,
            crates,
            hours: rule ? hours * PAIRED_TIME_HEADROOM : hours,
            precision: rule,
            communityBuffs,
            labyrinthCombatBuffs,
            seed,
        });
        const attempts = simResult.labyAttemptCount || 1;
        if (!rule) pairedRules.set(fightIndex, pairedTrialRule(simResult));
        return { winRate: (simResult.encounters || 0) / attempts, trials: attempts };
    };

    const fightMeta = (fight) => ({
        monsterHrid: fight.monsterHrid,
        monsterName: fight.monsterName,
        roomLevel: fight.roomLevel,
        loadoutName: fight.loadoutName,
    });

    // Baseline pass: every fight with its current levels. Fights are independent
    // — their own worker, their own seed — so they run several at a time.
    if (abortSignal?.()) return { baseline: null, results: [] };
    onProgress?.({ current: progress.current, total, description: `Baseline: ${fights.length} fights` });
    const baselineFights = await mapConcurrent(fights, async (fight, i) => {
        if (abortSignal?.()) return { ...fightMeta(fight), winRate: 0, trials: 1 };
        const { winRate, trials } = await simFightWinRate(fight, null, fightSeed(i), i);
        progress.current++;
        onProgress?.({ current: progress.current, total, description: `Baseline: ${fight.monsterName}` });
        return { ...fightMeta(fight), winRate, trials };
    });
    if (abortSignal?.()) return { baseline: null, results: [] };
    const baselineRunClear = baselineFights.reduce((product, f) => product * f.winRate, 1);
    const baselineAttempts = baselineFights.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);

    // One pass per candidate, over the fights that candidate is about
    const results = [];
    for (const candidate of candidates) {
        let aborted = false;
        const fightResults = await mapConcurrent(fights, async (fight, i) => {
            if (abortSignal?.()) {
                aborted = true;
                return { ...fightMeta(fight), winRate: baselineFights[i].winRate, winRateDelta: 0, applied: false };
            }
            // A fight this upgrade does not reach keeps its baseline exactly —
            // no sim, because there is nothing to find out
            if (!candidate.appliesTo[i]) {
                return {
                    ...fightMeta(fight),
                    winRate: baselineFights[i].winRate,
                    winRateDelta: 0,
                    applied: false,
                };
            }
            const boostedDTO = applyCandidateToDTO(fight.dto, candidate);
            const { winRate, trials } = await simFightWinRate(fight, boostedDTO, fightSeed(i), i);
            progress.current++;
            onProgress?.({
                current: progress.current,
                total,
                description: `${candidate.description}: ${fight.monsterName}`,
            });
            return {
                ...fightMeta(fight),
                winRate,
                trials,
                winRateDelta: winRate - baselineFights[i].winRate,
                applied: true,
                // What it goes in place of *here* — with one purchase serving
                // several loadouts, that is not the same piece in every room
                replaced: replacedIn(candidate, fight.dto, gameData),
            };
        });
        if (aborted) break;

        const applied = fightResults.filter((f) => f.applied);
        const runClearChance = fightResults.reduce((product, f) => product * f.winRate, 1);
        const expectedAttempts = fightResults.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);
        const attemptsDeltaNoise = attemptsNoise(applied, baselineFights);
        // Averaged over the rooms it reaches rather than every room: a weapon
        // that only goes in two of eight loadouts is not a quarter as good at
        // its job, and dividing by eight would say it was
        const avgWinDelta = applied.reduce((sum, f) => sum + f.winRateDelta, 0) / (applied.length || 1);
        const attemptsDelta = expectedAttempts - baselineAttempts;
        const cost = candidate.cost;
        // Attempts saved across a whole run, per billion coins. The figure the
        // question actually asks: a cheap thing that helps a little can beat an
        // expensive thing that helps a lot, and a ranking by raw gain never
        // says so. Candidates with no gold price — a combat level costs
        // experience — get null rather than a zero that would sort them last.
        const attemptsSaved = -attemptsDelta;
        const perGold = cost > 0 ? (attemptsSaved / cost) * 1e6 : null;

        results.push({
            candidate,
            fights: fightResults,
            appliedFights: applied.length,
            runClearChance,
            runClearDelta: runClearChance - baselineRunClear,
            expectedAttempts,
            attemptsDelta,
            attemptsDeltaNoise,
            // A gain smaller than the sampling error of the sims it came from is
            // not a gain that has been measured, whatever the number says
            significant: Math.abs(attemptsDelta) > SIGNIFICANCE_Z * attemptsDeltaNoise,
            avgWinDelta,
            cost,
            attemptsSavedPerMillion: perGold,
        });
    }

    // Best value first where there is a price, then the priceless ones by raw
    // gain — a combat level and a helmet cannot be ranked against each other in
    // coins, and pretending otherwise would bury one of them
    results.sort((a, b) => {
        const priced = (result) => (result.attemptsSavedPerMillion === null ? 1 : 0);
        return (
            priced(a) - priced(b) ||
            (b.attemptsSavedPerMillion ?? 0) - (a.attemptsSavedPerMillion ?? 0) ||
            a.attemptsDelta - b.attemptsDelta
        );
    });

    return {
        baseline: { fights: baselineFights, runClearChance: baselineRunClear, expectedAttempts: baselineAttempts },
        results,
        // Handed back so a combination check re-runs against the same random
        // draws and the same trial counts, rather than against a fresh sample
        pairing: { seed: simSeed, rules: [...pairedRules.entries()] },
        context: { fights, crates, hours, communityBuffs, labyrinthCombatBuffs },
    };
}

/**
 * What a set of upgrades is worth bought *together*.
 *
 * Every row in the table was measured on its own against the same baseline, and
 * that is the right way to rank them — but it is the wrong way to add them up.
 * Two upgrades that both rescue the same failing room each get credited with
 * rescuing it, and the sum promises a saving neither the pair nor anything else
 * will deliver. The overlap can only be found by running them together.
 *
 * The same seed and the same trial counts as the analysis it came from, so the
 * combined figure is comparable with the individual ones rather than being a
 * fresh sample that differs for its own reasons.
 *
 * @param {Object} params - `{ picks, baseline, pairing, context }` from an
 *   all-fights analysis, where `picks` are the results to install together
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal }
 * @returns {Promise<Object>} `{ fights, expectedAttempts, attemptsDelta,
 *   summedDelta, overlap }` — overlap is how much of the promised saving the
 *   upgrades take from each other
 */
export async function runLabyrinthCombinationCheck(params, onProgress, options = {}) {
    const { picks, baseline, pairing, context } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');
    if (!picks?.length || !baseline?.fights?.length) throw new Error('Nothing to check');

    const { fights, crates, hours, communityBuffs, labyrinthCombatBuffs = [] } = context || {};
    const zoneHrid =
        Object.keys(gameData.actionDetailMap).find((k) => k.includes('/actions/combat/')) || '/actions/combat/fly';
    const rules = new Map(pairing?.rules || []);
    const total = fights.length;
    let current = 0;

    const fightResults = [];
    for (let i = 0; i < fights.length; i++) {
        if (abortSignal?.()) return null;
        const fight = fights[i];
        onProgress?.({ current, total, description: `Together: ${fight.monsterName}` });

        // Every pick that belongs in this loadout goes on at once — that is the
        // whole question. Two picks for the same slot are not both worn: the
        // room wears whichever of them is better *here*, which is exactly how
        // the plan valued the second one.
        const bySlot = new Map();
        for (const pick of picks) {
            if (!candidateAppliesToDTO(pick.candidate, fight.dto, gameData)) continue;
            const key = conflictKey(pick.candidate);
            const standing = bySlot.get(key);
            const gain = pick.fights?.[i]?.winRateDelta ?? 0;
            if (!standing || gain > standing.gain) bySlot.set(key, { pick, gain });
        }

        let dto = fight.dto;
        const installed = [];
        for (const { pick } of bySlot.values()) {
            // Re-checked against the loadout as it now stands: a swap can fill a
            // hand that was empty when the picks were chosen
            if (!candidateAppliesToDTO(pick.candidate, dto, gameData)) continue;
            dto = applyCandidateToDTO(dto, pick.candidate);
            installed.push(pick.candidate.description);
        }

        const rule = rules.get(i) || null;
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [dto],
            zoneHrid,
            monsterHrid: fight.monsterHrid,
            roomLevel: fight.roomLevel,
            crates,
            hours: rule ? hours * PAIRED_TIME_HEADROOM : hours,
            precision: rule,
            communityBuffs,
            labyrinthCombatBuffs,
            seed: deriveSeed(pairing?.seed ?? null, i),
        });
        const attempts = simResult.labyAttemptCount || 1;
        const winRate = (simResult.encounters || 0) / attempts;

        fightResults.push({
            monsterHrid: fight.monsterHrid,
            monsterName: fight.monsterName,
            roomLevel: fight.roomLevel,
            loadoutName: fight.loadoutName,
            winRate,
            trials: attempts,
            winRateDelta: winRate - (baseline.fights[i]?.winRate ?? 0),
            installed,
        });
        current++;
    }

    const expectedAttempts = fightResults.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);
    const attemptsDelta = expectedAttempts - baseline.expectedAttempts;
    const summedDelta = picks.reduce((sum, pick) => sum + pick.attemptsDelta, 0);

    return {
        fights: fightResults,
        expectedAttempts,
        attemptsDelta,
        summedDelta,
        // Positive means the set delivers less than the parts promised, which is
        // the usual direction: two fixes for one room cannot both be the fix
        overlap: attemptsDelta - summedDelta,
        noise: attemptsNoise(fightResults, baseline.fights),
    };
}

// ─── Editor-Based Skilling Analysis ──────────────────────────────────────────

const SKILLING_DTO_KEYS = {
    '/skills/woodcutting': 'woodcuttingLevel',
    '/skills/foraging': 'foragingLevel',
    '/skills/milking': 'milkingLevel',
    '/skills/cooking': 'cookingLevel',
    '/skills/brewing': 'brewingLevel',
    '/skills/cheesesmithing': 'cheesesmithingLevel',
    '/skills/crafting': 'craftingLevel',
    '/skills/tailoring': 'tailoringLevel',
    '/skills/alchemy': 'alchemyLevel',
    '/skills/enhancing': 'enhancingLevel',
};

/**
 * Overrides for one skill, including the guild shrine levels the editor is set to.
 *
 * `getSkillingMetricsFromOverrides` otherwise reads the character's live guild
 * buffs straight off the data manager, which is right until the editor is asking
 * "what if this shrine were a level higher" — then the live read would quietly
 * hold every candidate at the current level. Passing the levels rather than
 * finished buffs lets it keep the server's own numbers for every shrine that has
 * not been touched.
 *
 * @param {Object} editorState - `{ equipment, houseRooms, tokenUpgrades, communityBuffLevels }`
 * @param {Object} editorDTO - The editor's player, for its shrine levels
 * @param {string} actionTypeHrid - e.g. '/action_types/woodcutting'
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @returns {Object} Overrides for getSkillingMetricsFromOverrides()
 */
function skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData) {
    const overrides = { ...buildOverridesForSkill(editorState, actionTypeHrid, crateHrids, gameData) };
    if (editorDTO?.guildShrineLevels) overrides.guildShrineLevels = editorDTO.guildShrineLevels;
    return overrides;
}

/**
 * Compute per-skill clear results from editor state.
 * @param {number} roomLevel
 * @param {Object} editorDTO - Player DTO from editor
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @param {Object} [skillEquipmentMap] - Per-skill equipment overrides { '/skills/X': { slot: { hrid, enhancementLevel } } }
 * @returns {Array<Object>} Per-skill results with skill name, clear chance, etc.
 */
export function computeSkillingClearRatesFromEditor(
    roomLevel,
    editorDTO,
    crateHrids,
    gameData,
    skillEquipmentMap = {}
) {
    const results = [];

    for (const skillHrid of LABYRINTH_SKILLS) {
        const skillId = skillHrid.replace('/skills/', '');
        const skillName = skillId.charAt(0).toUpperCase() + skillId.slice(1);
        const dtoKey = SKILLING_DTO_KEYS[skillHrid];
        const baseLevel = editorDTO[dtoKey] || 1;

        const skillRoomLevel = resolveSkillRoomLevel(roomLevel, skillHrid);
        if (skillRoomLevel <= 0) {
            results.push({
                clearChance: 0,
                expectedSeconds: Infinity,
                skipped: true,
                roomLevel: 0,
                baseLevel,
                effectiveLevel: baseLevel,
                successChance: 0,
                attempts: 0,
                skillHrid,
                skillId,
                skillName,
            });
            continue;
        }

        const actionTypeHrid = `/action_types/${skillId}`;
        const editorState = {
            equipment: skillEquipmentMap[skillHrid] || editorDTO.equipment,
            houseRooms: editorDTO.houseRooms,
            tokenUpgrades: editorDTO.tokenUpgrades,
            communityBuffLevels: editorDTO.communityBuffLevels,
        };

        const overrides = skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData);
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides(skillId, actionTypeHrid, overrides);

        let result;
        if (skillHrid === '/skills/enhancing') {
            result = labyrinthClearRate.computeEnhancingClearWithParams(metrics, baseLevel, skillRoomLevel);
        } else {
            result = labyrinthClearRate.computeSkillingClearWithParams(metrics, baseLevel, skillRoomLevel);
        }
        result.skillHrid = skillHrid;
        result.skillId = skillId;
        result.skillName = skillName;
        result.roomLevel = skillRoomLevel;
        results.push(result);
    }

    return results;
}

/**
 * Compute average skilling clear rate from editor state.
 * @param {number} roomLevel
 * @param {Object} editorDTO - Player DTO from editor
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @param {Object} [options]
 * @param {Object} [options.metricOverride] - { key, delta } to add to one metric across all skills
 * @param {Object} [options.skillEquipmentMap] - Per-skill equipment overrides
 * @returns {number} Average clear rate (0-1)
 */
/**
 * Resolve the room level for a skill: roomLevel may be a single number or a
 * per-skill map { [skillHrid]: level } built from the automation skip levels.
 * @param {number|Object} roomLevel
 * @param {string} skillHrid
 * @returns {number} Room level (0 = skill is skipped)
 */
function resolveSkillRoomLevel(roomLevel, skillHrid) {
    if (roomLevel && typeof roomLevel === 'object') {
        return Math.max(0, Math.floor(Number(roomLevel[skillHrid]) || 0));
    }
    return Math.max(0, Math.floor(Number(roomLevel) || 0));
}

function computeAverageSkillingClearRateFromEditor(roomLevel, editorDTO, crateHrids, gameData, options = {}) {
    const { metricOverride = null, skillEquipmentMap = {}, targetSkill = null } = options;

    let total = 0;
    let count = 0;

    const skillsToEval = targetSkill ? [targetSkill] : LABYRINTH_SKILLS;

    for (const skillHrid of skillsToEval) {
        const skillRoomLevel = resolveSkillRoomLevel(roomLevel, skillHrid);
        if (skillRoomLevel <= 0) continue; // Skill room is skipped

        const skillId = skillHrid.replace('/skills/', '');
        const actionTypeHrid = `/action_types/${skillId}`;
        const dtoKey = SKILLING_DTO_KEYS[skillHrid];
        const baseLevel = editorDTO[dtoKey] || 1;

        const editorState = {
            equipment: skillEquipmentMap[skillHrid] || editorDTO.equipment,
            houseRooms: editorDTO.houseRooms,
            tokenUpgrades: editorDTO.tokenUpgrades,
            communityBuffLevels: editorDTO.communityBuffLevels,
        };

        const overrides = skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData);
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides(skillId, actionTypeHrid, overrides);

        if (metricOverride) {
            metrics[metricOverride.key] = (metrics[metricOverride.key] || 0) + metricOverride.delta;
        }

        let clearChance;
        if (skillHrid === '/skills/enhancing') {
            clearChance = labyrinthClearRate.computeEnhancingClearWithParams(
                metrics,
                baseLevel,
                skillRoomLevel
            ).clearChance;
        } else {
            clearChance = labyrinthClearRate.computeSkillingClearWithParams(
                metrics,
                baseLevel,
                skillRoomLevel
            ).clearChance;
        }

        total += clearChance;
        count++;
    }

    return count > 0 ? total / count : 0;
}

/**
 * Average XP a cleared skilling room awards, across the rooms being run.
 *
 * Enhancing rooms used to be skipped here, because
 * `computeEnhancingClearWithParams` reported no `xpPerRoom` and averaging a
 * zero in would have understated every other room. It reports one now, so the
 * skip has become the bug it was guarding against: an enhancing room in the run
 * contributed nothing to the XP metric, and the Experience token and shrine
 * rows — which are ranked on exactly this number — were valued as though a
 * tenth of the run awarded no experience.
 * @param {number|Object} roomLevel - One level, or a per-skill map
 * @param {Object} editorDTO - Player DTO from editor
 * @param {string[]} crateHrids - Selected crate HRIDs
 * @param {Object} gameData - From buildGameDataPayload()
 * @param {Object} [options] - { skillEquipmentMap, targetSkill }
 * @returns {number} Average XP per room (0 when no room qualifies)
 */
function computeAverageSkillingXpPerRoomFromEditor(roomLevel, editorDTO, crateHrids, gameData, options = {}) {
    const { skillEquipmentMap = {}, targetSkill = null } = options;

    let total = 0;
    let count = 0;

    const skillsToEval = targetSkill ? [targetSkill] : LABYRINTH_SKILLS;

    for (const skillHrid of skillsToEval) {
        const skillRoomLevel = resolveSkillRoomLevel(roomLevel, skillHrid);
        if (skillRoomLevel <= 0) continue;

        const skillId = skillHrid.replace('/skills/', '');
        const actionTypeHrid = `/action_types/${skillId}`;
        const dtoKey = SKILLING_DTO_KEYS[skillHrid];
        const baseLevel = editorDTO[dtoKey] || 1;

        const editorState = {
            equipment: skillEquipmentMap[skillHrid] || editorDTO.equipment,
            houseRooms: editorDTO.houseRooms,
            tokenUpgrades: editorDTO.tokenUpgrades,
            communityBuffLevels: editorDTO.communityBuffLevels,
        };

        const overrides = skillingOverrides(editorState, editorDTO, actionTypeHrid, crateHrids, gameData);
        const metrics = labyrinthClearRate.getSkillingMetricsFromOverrides(skillId, actionTypeHrid, overrides);
        // Enhancing clears on its own model, and now reports XP from it
        const result =
            skillHrid === '/skills/enhancing'
                ? labyrinthClearRate.computeEnhancingClearWithParams(metrics, baseLevel, skillRoomLevel)
                : labyrinthClearRate.computeSkillingClearWithParams(metrics, baseLevel, skillRoomLevel);

        total += result.xpPerRoom || 0;
        count++;
    }

    return count > 0 ? total / count : 0;
}

/**
 * Generate labyrinth buff candidates from editor token upgrade levels.
 *
 * The Experience token comes along despite not being category 'skilling'. It
 * buys no clear rate at all — every other row here is ranked by that — so it
 * used to fall out of both filters and never appear anywhere, which read as
 * "not worth buying" rather than "measured against the wrong yardstick". Its
 * rows are scored on XP per room instead.
 * @param {Object} tokenUpgrades - { speed, efficiency, success, doubleProgress, experience }
 * @returns {Array} Buff candidates with type 'labyrinth_buff'
 */
export function generateLabyrinthBuffCandidatesFromEditor(tokenUpgrades) {
    const skillingDefs = LABYRINTH_BUFF_DEFS.filter((d) => d.category === 'skilling' || d.category === 'experience');
    const editorKeyMap = {
        labyrinthSkillActionSpeedLevel: 'speed',
        labyrinthSkillingEfficiencyLevel: 'efficiency',
        labyrinthSkillingSuccessLevel: 'success',
        labyrinthSkillingDoubleProgressLevel: 'doubleProgress',
        labyrinthExperienceLevel: 'experience',
    };

    const candidates = [];
    for (const def of skillingDefs) {
        const editorKey = editorKeyMap[def.key];
        const currentLevel = Math.max(0, Math.floor(Number(tokenUpgrades?.[editorKey]) || 0));
        if (currentLevel >= def.maxLevel) continue;

        candidates.push({
            type: 'labyrinth_buff',
            category: def.category,
            buffKey: def.key,
            editorKey,
            currentLevel,
            step: def.step,
            tokenCost: def.tokenCost * (currentLevel + 1),
            description: `${def.name} Lv${currentLevel}\u2192${currentLevel + 1}`,
            metric: def.metric,
        });
    }
    return candidates;
}

/**
 * Generate skilling equipment enhancement candidates from editor equipment.
 * Considers per-skill equipment overrides to find all unique items that need
 * upgrading. When targetSkill is set, only the gear actually worn for that
 * skill's room (its loadout override, or the base equipment) is considered.
 * @param {Object} editorDTO - Player DTO from editor
 * @param {Object} gameData - From buildGameDataPayload()
 * @param {Object} [skillEquipmentMap] - Per-skill equipment overrides
 * @param {string|null} [targetSkill] - Skill HRID to restrict candidates to
 * @returns {Array} Enhancement candidates with gold cost
 */
export function generateSkillingEquipmentCandidates(editorDTO, gameData, skillEquipmentMap = {}, targetSkill = null) {
    const itemDetailMap = gameData.itemDetailMap || {};
    const candidates = [];
    const seen = new Set();

    let equipmentSets;
    if (targetSkill) {
        equipmentSets = [skillEquipmentMap[targetSkill] || editorDTO.equipment || {}];
    } else {
        equipmentSets = [editorDTO.equipment || {}];
        for (const skillEquip of Object.values(skillEquipmentMap)) {
            if (skillEquip) equipmentSets.push(skillEquip);
        }
    }

    for (const equipment of equipmentSets) {
        for (const [slot, equip] of Object.entries(equipment)) {
            if (!equip?.hrid) continue;
            if (slot === '/equipment_types/trinket' || slot === '/equipment_types/charm') continue;
            const dedupKey = `${slot}:${equip.hrid}:${equip.enhancementLevel || 0}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);

            const itemDetails = itemDetailMap[equip.hrid];
            if (!itemDetails?.equipmentDetail?.noncombatStats) continue;

            const hasNoncombat = Object.values(itemDetails.equipmentDetail.noncombatStats).some((v) => v > 0);
            if (!hasNoncombat) continue;

            const currentLevel = equip.enhancementLevel || 0;
            const nextBP = getNextBreakpoint(currentLevel, slot, equip.hrid);
            if (!nextBP) continue;

            const itemName = itemDetails.name || equip.hrid.split('/').pop();
            const candidate = {
                slot,
                currentHrid: equip.hrid,
                currentLevel,
                upgradeHrid: equip.hrid,
                upgradeLevel: nextBP,
                description: `${itemName} +${currentLevel} \u2192 +${nextBP}`,
                type: 'enhancement',
            };
            candidate.cost = calculateUpgradeCost(candidate, gameData);
            candidates.push(candidate);
        }

        // Philosopher's accessories at +5, even when the worn jewelry is
        // enhanced higher — same reasoning as the combat advisor
        const philoCandidates = [];
        addPhiloAccessoryCandidates({ equipment }, gameData, philoCandidates);
        for (const candidate of philoCandidates) {
            const dedupKey = `philo:${candidate.slot}:${candidate.upgradeHrid}:${candidate.currentHrid}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            candidate.cost = calculateUpgradeCost(candidate, gameData);
            candidates.push(candidate);
        }
    }

    // Gear you are not wearing — the celestial tool and the skill's outfit,
    // which the loop above can never reach because it only ever enhances what is
    // already on. Each one belongs to one skill and is applied to that skill
    // alone: a Milking outfit does nothing in a Crafting room, and a candidate
    // with no skill on it would be applied to every room and appear to help.
    // Every labyrinth skill, not just the ones with a loadout assigned: a skill
    // with no loadout of its own still runs a room, in the base kit, and is
    // exactly the skill most likely to be missing its tool
    const levels = new Map((dataManager.getSkills?.() || []).map((skill) => [skill.skillHrid, skill.level]));
    for (const skill of targetSkill ? [targetSkill] : LABYRINTH_SKILLS) {
        const forSkill = bestGearForSkill({
            skill,
            equipment: skillEquipmentMap[skill] || editorDTO.equipment || {},
            itemDetailMap,
            levels,
        });
        for (const candidate of forSkill) {
            const dedupKey = `gear:${skill}:${candidate.slot}:${candidate.upgradeHrid}`;
            if (seen.has(dedupKey)) continue;
            seen.add(dedupKey);
            candidate.cost = calculateUpgradeCost(candidate, gameData);
            candidates.push(candidate);
        }
    }

    return candidates;
}

/**
 * Whether an upgrade is even about this loadout.
 *
 * The all-fights analysis pools candidates from every fight and then measures
 * each against every fight, which is right for a combat level — one number the
 * whole character carries — and wrong for a piece of gear. A sword upgrade
 * generated from the melee loadout, installed into the magic loadout, replaces
 * the staff with a sword: not an upgrade, a costume change, and it comes back as
 * a large negative that drags the aggregate for every room the buyer would never
 * have applied it to.
 *
 * The honest answer for a room the piece does not belong to is that nothing
 * happens there, which is also the cheap one — no simulation is needed to work
 * out that a fight is unchanged.
 *
 * @param {Object} candidate - From `generateCandidates`
 * @param {Object} dto - The loadout a fight is assigned
 * @returns {boolean} Whether applying it to this loadout means anything
 */
export function candidateAppliesToDTO(candidate, dto, gameData = null) {
    if (!candidate || !dto) return false;

    // The character's own, wherever they are worn: skills, rooms and shrine
    // levels are not held in a loadout and change every fight at once
    if (candidate.type === 'combat_level' || candidate.type === 'house' || candidate.type === 'guild_shrine') {
        return true;
    }

    if (candidate.slot?.startsWith('ability_')) {
        const abilities = dto.abilities || [];
        if (candidate.type === 'ability_level') {
            // Only where it is actually cast — levelling an ability this
            // loadout does not slot changes nothing about the fight
            return abilities.some(
                (ability) => ability?.hrid === candidate.upgradeHrid && (ability.level || 0) < candidate.upgradeLevel
            );
        }
        // A swap brings a new ability in, so it applies unless this loadout is
        // already running it at least that high
        const slotIdx = parseInt(candidate.slot.split('_')[1]);
        const existing = abilities[slotIdx];
        return !(existing?.hrid === candidate.upgradeHrid && (existing.level || 0) >= candidate.upgradeLevel);
    }

    const equipment = dto.equipment || {};

    if (candidate.type === 'cross_slot') {
        const removed = candidate.removedItems || (candidate.currentHrid ? [{ hrid: candidate.currentHrid }] : []);
        // A swap that empties nothing is filling empty slots, so it only
        // applies where they are in fact empty
        if (!removed.length) return Object.keys(candidate.addedSlots || {}).every((slot) => !equipment[slot]);
        return removed.every((item) => Object.values(equipment).some((worn) => worn?.hrid === item.hrid));
    }

    const worn = equipment[candidate.slot];
    // A bare slot is only bare in the loadouts where it is bare
    if (!candidate.currentHrid) return !worn?.hrid;

    // Enhancing is about one particular item: it helps the loadouts wearing
    // *that* item and nobody else, and not once it is already at the target
    if (candidate.upgradeHrid === candidate.currentHrid) {
        if (worn?.hrid !== candidate.currentHrid) return false;
        return (worn.enhancementLevel || 0) < (candidate.upgradeLevel || 0);
    }

    return tierAppliesToWorn(candidate, worn, equipment, gameData);
}

/**
 * Whether buying this piece would improve the slot a loadout has filled.
 *
 * A tier upgrade is one purchase that every loadout can share, and matching on
 * the exact item it replaces was too narrow: a candidate generated from the
 * loadout wearing a Fine Sword was credited for that room alone, while the
 * loadout wearing a Cursed Sword — which the same purchase would also improve —
 * was recorded as untouched. One price, a fraction of the benefit.
 *
 * So the question is not "is this the item I named" but "would this item be an
 * upgrade here": same slot, not a style the loadout does not fight in, and not a
 * step down in tier.
 *
 * @param {Object} candidate - A tier candidate
 * @param {Object|null} worn - What the loadout has in that slot
 * @param {Object|null} gameData - For item levels and styles; without it this
 *   falls back to the exact-item rule rather than guessing
 * @returns {boolean}
 */
function tierAppliesToWorn(candidate, worn, equipment, gameData) {
    // An empty hand is not a free slot when the other one holds a two-hander:
    // installing a sword beside a bow builds a kit the game would never let you
    // wear. Trading between the two is a cross-slot swap, which has its own
    // candidates and prices the trade properly.
    const twoHand = equipment?.['/equipment_types/two_hand'];
    const oneHand = equipment?.['/equipment_types/main_hand'];
    if (twoHand?.hrid && (candidate.slot === MAIN_HAND_SLOT || candidate.slot === OFF_HAND_SLOT)) return false;
    if (oneHand?.hrid && candidate.slot === TWO_HAND_SLOT) return false;

    // Nothing there is improved by anything
    if (!worn?.hrid) return true;
    // Already the piece being bought: only the enhancement could differ
    if (worn.hrid === candidate.upgradeHrid) {
        return (worn.enhancementLevel || 0) < (candidate.upgradeLevel || 0);
    }

    const details = gameData?.itemDetailMap;
    const upgrade = details?.[candidate.upgradeHrid];
    const current = details?.[worn.hrid];
    if (!upgrade || !current) return worn.hrid === candidate.currentHrid;

    // A lower-tier piece is not an upgrade for this room even though it is for
    // the room the candidate came from
    if ((upgrade.itemLevel || 0) < (current.itemLevel || 0)) return false;

    const upgradeStats = upgrade.equipmentDetail?.combatStats;
    const currentStats = current.equipmentDetail?.combatStats;
    const upgradeStyle = getItemDamageStyle(upgradeStats);
    const currentStyle = getItemDamageStyle(currentStats);
    // Armour and jewellery have no style of their own, and swapping one in is
    // fair game for any loadout; two *weapons* of different styles are not
    // substitutes, whatever their item levels say
    if (upgradeStyle !== 'unknown' && currentStyle !== 'unknown' && upgradeStyle !== currentStyle) return false;

    // Nor is a damage piece a substitute for a defensive one — the loadout was
    // built around what it is wearing
    const upgradeRole = getItemRole(upgradeStats);
    const currentRole = getItemRole(currentStats);
    if (upgradeRole !== 'unknown' && currentRole !== 'unknown' && upgradeRole !== currentRole) return false;

    return true;
}

/**
 * The same player, with one candidate applied.
 *
 * A deep copy, always: the caller's DTO is the character the panel is showing
 * and a dozen candidates measured against a DTO that kept the last one's change
 * would each be measuring the pile rather than the piece.
 *
 * Shared by the single-fight and all-fights analyses so a candidate means the
 * same thing in both. They diverged once, and a candidate that applies one way
 * in one view and another way in the other is worse than a candidate that does
 * not work at all — only one of those is visible.
 *
 * @param {Object} playerDTO - The player to change
 * @param {Object} candidate - From `generateCandidates`
 * @returns {Object} A new DTO
 */
export function applyCandidateToDTO(playerDTO, candidate) {
    const dto = JSON.parse(JSON.stringify(playerDTO));

    if (candidate.slot?.startsWith('ability_')) {
        // Levelling an ability follows the ability, not the slot number it
        // happened to sit in on the loadout the candidate came from — another
        // loadout can cast the same ability from a different slot, and writing
        // to the index would overwrite whatever that one keeps there
        const byName =
            candidate.type === 'ability_level'
                ? (dto.abilities || []).findIndex((ability) => ability?.hrid === candidate.upgradeHrid)
                : -1;
        const slotIdx = byName >= 0 ? byName : parseInt(candidate.slot.split('_')[1]);
        const existing = dto.abilities[slotIdx];
        dto.abilities[slotIdx] =
            existing?.hrid === candidate.upgradeHrid
                ? // Keep configured triggers when levelling the equipped ability
                  { ...existing, level: candidate.upgradeLevel }
                : { hrid: candidate.upgradeHrid, level: candidate.upgradeLevel, triggers: null };
        return dto;
    }

    if (candidate.type === 'combat_level') {
        dto[candidate.skillKey] = candidate.upgradeLevel;
        return dto;
    }

    if (candidate.type === 'guild_shrine') {
        applyGuildShrineToDTO(dto, candidate);
        return dto;
    }

    if (candidate.type === 'drink') {
        applyDrinkToDTO(dto, candidate);
        return dto;
    }

    // A community buff is not on the character at all — it is an argument to
    // the simulation — so there is nothing here to change
    if (candidate.type === 'community_buff') {
        return dto;
    }

    if (candidate.type === 'cross_slot') {
        for (const slot of candidate.clearedSlots) dto.equipment[slot] = null;
        for (const [slot, item] of Object.entries(candidate.addedSlots)) dto.equipment[slot] = item;
        return dto;
    }

    dto.equipment[candidate.slot] = { hrid: candidate.upgradeHrid, enhancementLevel: candidate.upgradeLevel };
    return dto;
}

/**
 * Put one candidate's item into the equipment it applies to.
 *
 * A candidate carrying a `skillKey` belongs to that skill and goes into that
 * skill's equipment only — a Milking outfit put into every skill's kit would
 * report a gain in rooms it cannot affect. One without a key is an enhancement
 * of gear already worn, which is the same piece wherever it appears, so it is
 * applied everywhere it is found.
 *
 * @param {Object} candidate - The upgrade
 * @param {Object} payload - `{hrid, enhancementLevel}` to install
 * @param {Object} dto - The editor's own player
 * @param {Object} equipMap - Per-skill equipment overrides
 * @param {string|null} targetSkill - The skill being analysed, when only one is
 */
export function applyToEquipment(candidate, payload, dto, equipMap, targetSkill) {
    const { skillKey, slot, currentHrid, currentLevel = 0 } = candidate;

    if (skillKey) {
        // A skill with no loadout of its own runs in the character's base kit,
        // and writing the piece there would put a Milking outfit into every
        // other skill that shares it. It gets a kit of its own instead, copied
        // from the one it was running, so the change lands on that skill alone.
        if (!equipMap[skillKey]) equipMap[skillKey] = { ...(dto.equipment || {}) };
        equipMap[skillKey][slot] = payload;
        return;
    }

    // The same item, at the same enhancement — enhancing the sword you own
    // upgrades it in every kit it is worn in, but a second copy of it worn a few
    // levels higher elsewhere is a different item and would be dragged *down* to
    // this candidate's target by an hrid-only match
    const isTheSameItem = (worn) => worn?.hrid === currentHrid && (worn.enhancementLevel || 0) === currentLevel;

    if (isTheSameItem(dto.equipment?.[slot])) dto.equipment[slot] = payload;
    for (const [skill, skillEquip] of Object.entries(equipMap)) {
        // In single-skill mode the other skills' kits are not being simulated;
        // rewriting them is invisible work at best and confusing at worst
        if (targetSkill && skill !== targetSkill) continue;
        if (isTheSameItem(skillEquip?.[slot])) skillEquip[slot] = payload;
    }
}

/**
 * Run skilling upgrade analysis from editor state.
 * @param {Object} params
 * @param {Object} params.editorDTO - Player DTO from editor
 * @param {number} params.roomLevel - Room level
 * @param {string[]} params.crateHrids - Selected crate HRIDs
 * @param {Object} [params.skillEquipmentMap] - Per-skill equipment overrides
 * @param {Function} onProgress - Called with { current, total, description }
 * @param {Object} [options] - { abortSignal: () => boolean }
 * @returns {Promise<Object>} { baseline, results }
 */
export async function runSkillingUpgradeAnalysis(params, onProgress, options = {}) {
    const { editorDTO, roomLevel, crateHrids, skillEquipmentMap = {}, targetSkill = null } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const tokenUpgrades = editorDTO.tokenUpgrades || {};
    const buffCandidates = generateLabyrinthBuffCandidatesFromEditor(tokenUpgrades);
    const equipCandidates = generateSkillingEquipmentCandidates(editorDTO, gameData, skillEquipmentMap, targetSkill);
    const guildCandidates = generateGuildShrineCandidates(editorDTO, { combat: false }).map((candidate) => ({
        ...candidate,
        cost: calculateUpgradeCost(candidate, gameData),
    }));
    const clearRateOpts = { skillEquipmentMap, targetSkill };

    // Yield so Stop clicks and progress paints can land between the heavy sync chunks
    await new Promise((resolve) => setTimeout(resolve, 0));

    const total = buffCandidates.length + equipCandidates.length + guildCandidates.length + 1;
    let current = 0;

    onProgress?.({ current: 0, total, description: 'Computing baseline...' });
    const baselineClearRate = computeAverageSkillingClearRateFromEditor(
        roomLevel,
        editorDTO,
        crateHrids,
        gameData,
        clearRateOpts
    );
    current++;

    if (abortSignal?.()) return { baseline: null, results: [] };

    onProgress?.({ current, total, description: `Baseline: ${(baselineClearRate * 100).toFixed(1)}%` });

    // Only paid for when something is ranked on it — the Experience token and the
    // Scholar shrine are the candidates that are, and both are often absent
    const scholarBuff = '/buff_types/wisdom';
    const hasXpCandidate =
        buffCandidates.some((c) => c.category === 'experience') ||
        guildCandidates.some((c) => c.buffTypes?.includes(scholarBuff));
    const baselineXpPerRoom = hasXpCandidate
        ? computeAverageSkillingXpPerRoomFromEditor(roomLevel, editorDTO, crateHrids, gameData, clearRateOpts)
        : 0;

    const results = [];

    for (const buffCandidate of buffCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${buffCandidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        modifiedDTO.tokenUpgrades[buffCandidate.editorKey] = buffCandidate.currentLevel + 1;

        if (buffCandidate.category === 'experience') {
            const modifiedXpPerRoom = computeAverageSkillingXpPerRoomFromEditor(
                roomLevel,
                modifiedDTO,
                crateHrids,
                gameData,
                clearRateOpts
            );
            const xpPerRoomDelta = modifiedXpPerRoom - baselineXpPerRoom;

            results.push({
                candidate: buffCandidate,
                costType: 'token',
                tokenCost: buffCandidate.tokenCost,
                // The room is cleared exactly as often as before; only what it
                // pays out changes, so the clear-rate columns stay at baseline
                clearRate: baselineClearRate,
                clearRateDelta: 0,
                xpPerRoom: modifiedXpPerRoom,
                xpPerRoomDelta,
                tokensPerXp: xpPerRoomDelta > 0 ? buffCandidate.tokenCost / xpPerRoomDelta : Infinity,
                metricType: 'xpPerRoom',
            });
            current++;
            onProgress?.({ current, total, description: buffCandidate.description });
            continue;
        }

        const modifiedClearRate = computeAverageSkillingClearRateFromEditor(
            roomLevel,
            modifiedDTO,
            crateHrids,
            gameData,
            clearRateOpts
        );
        const clearRateDelta = modifiedClearRate - baselineClearRate;

        results.push({
            candidate: buffCandidate,
            costType: 'token',
            tokenCost: buffCandidate.tokenCost,
            clearRate: modifiedClearRate,
            clearRateDelta,
            metricType: 'clearRate',
        });
        current++;
        onProgress?.({ current, total, description: buffCandidate.description });
    }

    // Guild shrines are paid for in credits *and* tokens, which is neither of the
    // two cost types the tables above use, so they keep their own — and a shrine
    // can move clear rate and XP at once, so both are measured for every one
    for (const candidate of guildCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${candidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        applyGuildShrineToDTO(modifiedDTO, candidate);

        const modifiedClearRate = computeAverageSkillingClearRateFromEditor(
            roomLevel,
            modifiedDTO,
            crateHrids,
            gameData,
            clearRateOpts
        );
        const clearRateDelta = modifiedClearRate - baselineClearRate;

        const movesXp = candidate.buffTypes?.includes(scholarBuff);
        const modifiedXpPerRoom = movesXp
            ? computeAverageSkillingXpPerRoomFromEditor(roomLevel, modifiedDTO, crateHrids, gameData, clearRateOpts)
            : baselineXpPerRoom;
        const xpPerRoomDelta = modifiedXpPerRoom - baselineXpPerRoom;

        results.push({
            candidate,
            costType: 'guild',
            cost: candidate.cost,
            tokenCost: candidate.guildTokenCost,
            costDetail: explainUpgradeCost(candidate, gameData),
            clearRate: modifiedClearRate,
            clearRateDelta,
            goldPerClearRate:
                clearRateDelta > 0 && candidate.cost != null ? candidate.cost / (clearRateDelta * 100) : Infinity,
            xpPerRoom: modifiedXpPerRoom,
            xpPerRoomDelta,
            metricType: movesXp && clearRateDelta <= 1e-12 ? 'xpPerRoom' : 'clearRate',
        });
        current++;
        onProgress?.({ current, total, description: candidate.description });
    }

    for (const candidate of equipCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${candidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        const modifiedSkillEquipMap = JSON.parse(JSON.stringify(skillEquipmentMap));
        const upgradePayload = { hrid: candidate.upgradeHrid, enhancementLevel: candidate.upgradeLevel };

        applyToEquipment(candidate, upgradePayload, modifiedDTO, modifiedSkillEquipMap, targetSkill);

        const evaluate = (evalCandidate, dto, equipMap) => {
            const payload = { hrid: evalCandidate.upgradeHrid, enhancementLevel: evalCandidate.upgradeLevel };
            applyToEquipment(evalCandidate, payload, dto, equipMap, targetSkill);
            return computeAverageSkillingClearRateFromEditor(roomLevel, dto, crateHrids, gameData, {
                skillEquipmentMap: equipMap,
                targetSkill,
            });
        };

        let evalCandidate = candidate;
        let modifiedClearRate = computeAverageSkillingClearRateFromEditor(
            roomLevel,
            modifiedDTO,
            crateHrids,
            gameData,
            {
                skillEquipmentMap: modifiedSkillEquipMap,
                targetSkill,
            }
        );
        let clearRateDelta = modifiedClearRate - baselineClearRate;

        // A breakpoint jump sometimes lands between improvement thresholds —
        // keep raising the target one level at a time until the clear rate
        // actually moves (skip when the baseline is already maxed)
        const MAX_ENHANCEMENT = 20;
        while (clearRateDelta <= 1e-9 && baselineClearRate < 0.999999 && evalCandidate.upgradeLevel < MAX_ENHANCEMENT) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (abortSignal?.()) break;
            const nextLevel = evalCandidate.upgradeLevel + 1;
            const bumped = {
                ...evalCandidate,
                upgradeLevel: nextLevel,
                description: evalCandidate.description.replace(/\+\d+$/, `+${nextLevel}`),
            };
            bumped.cost = calculateUpgradeCost(bumped, gameData);
            const freshDTO = JSON.parse(JSON.stringify(editorDTO));
            const freshEquipMap = JSON.parse(JSON.stringify(skillEquipmentMap));
            modifiedClearRate = evaluate(bumped, freshDTO, freshEquipMap);
            clearRateDelta = modifiedClearRate - baselineClearRate;
            evalCandidate = bumped;
        }

        results.push({
            candidate: evalCandidate,
            costType: 'gold',
            cost: evalCandidate.cost,
            clearRate: modifiedClearRate,
            clearRateDelta,
            // Unknown cost (null) must rank as Infinity, never as free
            goldPerClearRate:
                clearRateDelta > 0 && evalCandidate.cost != null
                    ? evalCandidate.cost / (clearRateDelta * 100)
                    : Infinity,
            metricType: 'clearRate',
        });
        current++;
        onProgress?.({ current, total, description: evalCandidate.description });
    }

    // Tokens first, then shrines, then gold; within each group by best delta
    const costOrder = { token: 0, guild: 1, gold: 2 };
    results.sort((a, b) => {
        if (a.costType !== b.costType) return (costOrder[a.costType] ?? 3) - (costOrder[b.costType] ?? 3);
        return (b.clearRateDelta ?? 0) - (a.clearRateDelta ?? 0);
    });

    return {
        baseline: { clearRate: baselineClearRate, xpPerRoom: baselineXpPerRoom },
        results,
    };
}

export default {
    generateCandidates,
    calculateUpgradeCost,
    runUpgradeAnalysis,
    runLabyrinthUpgradeAnalysis,
    generateLabyrinthBuffCandidates,
    generateLabyrinthBuffCandidatesFromEditor,
    generateGuildShrineCandidates,
    generateDrinkCandidates,
    generateCommunityBuffCandidates,
    getEquipmentTierProgression,
    computeSkillingClearRatesFromEditor,
    generateSkillingEquipmentCandidates,
    runSkillingUpgradeAnalysis,
};
