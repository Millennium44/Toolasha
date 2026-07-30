/**
 * Upgrade Advisor for Combat Sim
 *
 * Generates equipment upgrade candidates, calculates their costs,
 * and runs simulations to rank them by "Gold per 0.01% improvement".
 */

import config from '../../core/config.js';
import dataManager from '../../core/data-manager.js';
import { buildGameDataPayload, calculateSimRevenue } from './combat-sim-adapter.js';
import { runSimulation, runLabyrinthSimulation } from './combat-sim-runner.js';
import { estimateFoodSimCount, runFoodOptimization } from './food-optimizer.js';
import { generateLabArmorCandidates } from './lab-armor-candidates.js';
import { deriveSeed, randomSeed } from './engine/rng.js';
import labyrinthClearRate from '../combat/labyrinth-clear-rate.js';
import { resolveItemPrice } from '../../utils/profit-helpers.js';
import { getItemPrices } from '../../utils/market-data.js';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import { getEnhancingParams, getAutoDetectedParams } from '../../utils/enhancement-config.js';
import { getCheapestProtectionPrice, getProductionCost } from '../enhancement/tooltip-enhancement.js';
import { calculateAbilityLevelUpCost } from '../../utils/ability-cost-calculator.js';
import { buildOverridesForSkill } from './skilling-sim-helpers.js';

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
 * Find candidate off-hand items for a given combat style and level range.
 * Returns up to two options (deduped):
 *  - Style-matched: highest-itemLevel off-hand whose offensive stats match the
 *    weapon's damage style (e.g. Manticore Shield for ranged).
 *  - Highest-itemLevel: the strongest off-hand by item level overall, regardless
 *    of style fit (e.g. Knight's Aegis for any cross-slot upgrade).
 * @param {Object} gameData - Game data
 * @param {string} damageStyle - Primary damage style of the weapon
 * @param {number} maxItemLevel - Maximum item level to consider
 * @returns {Array<{hrid: string, itemLevel: number}>}
 */
function findBestOffHand(gameData, damageStyle, maxItemLevel) {
    const isMagic = damageStyle === 'magic';
    const isRanged = damageStyle === 'ranged';
    const isMelee = damageStyle === 'slash' || damageStyle === 'stab' || damageStyle === 'smash';

    let styleMatched = null; // highest-itemLevel off-hand with style-matched stats
    let highest = null; // highest-itemLevel off-hand overall (with magic-exclusion for non-magic)

    for (const [itemHrid, item] of Object.entries(gameData.itemDetailMap)) {
        const eq = item.equipmentDetail;
        if (!eq || eq.type !== '/equipment_types/off_hand') continue;
        if (!hasCombatStats(item)) continue;
        if ((item.itemLevel || 0) > maxItemLevel) continue;

        const level = item.itemLevel || 0;
        const stats = eq.combatStats || {};
        const hasMagicStats = (stats.magicDamage || 0) > 0 || (stats.magicAccuracy || 0) > 0;

        // Build "highest overall" candidate (mirrors original behavior)
        if (isMagic) {
            if (!highest) {
                highest = { hrid: itemHrid, itemLevel: level, isMagic: hasMagicStats };
            } else if (hasMagicStats && !highest.isMagic) {
                highest = { hrid: itemHrid, itemLevel: level, isMagic: true };
            } else if (hasMagicStats === highest.isMagic && level > highest.itemLevel) {
                highest = { hrid: itemHrid, itemLevel: level, isMagic: hasMagicStats };
            }
        } else if (!hasMagicStats && (!highest || level > highest.itemLevel)) {
            // For non-magic, exclude off-hands with magic stats from "highest"
            highest = { hrid: itemHrid, itemLevel: level };
        }

        // Build "style-matched" candidate — highest itemLevel among off-hands whose
        // offensive stats match the weapon's damage style.
        let styleMatch = false;
        if (isMagic) {
            styleMatch = hasMagicStats;
        } else if (isRanged) {
            styleMatch = (stats.rangedDamage || 0) > 0 || (stats.rangedAccuracy || 0) > 0;
        } else if (isMelee) {
            const meleeDmg = (stats.stabDamage || 0) + (stats.slashDamage || 0) + (stats.smashDamage || 0);
            const meleeAcc = (stats.stabAccuracy || 0) + (stats.slashAccuracy || 0) + (stats.smashAccuracy || 0);
            styleMatch = meleeDmg > 0 || meleeAcc > 0;
        }
        if (styleMatch && (!styleMatched || level > styleMatched.itemLevel)) {
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
    houseTargets = null
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

            // Skip trinkets and items with no combat stats (tools, etc.)
            if (slot === '/equipment_types/trinket') continue;
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
    if (candidate.type === 'combat_level' || candidate.type === 'house' || candidate.slot?.startsWith('ability_')) {
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
 * Calculate the total gold cost for a candidate upgrade.
 * Uses market prices as primary source (buy upgraded - sell current).
 * Falls back to enhancement cost estimate if market data unavailable.
 * @param {Object} candidate - Candidate from generateCandidates()
 * @param {Object} gameData - Game data
 * @returns {number} Total gold cost
 */
export function calculateUpgradeCost(candidate, gameData) {
    // Combat skill levels cost XP and time, not gold
    if (candidate.type === 'combat_level') {
        return null;
    }

    if (candidate.type === 'house') {
        return calculateHouseUpgradeCost(candidate, gameData);
    }

    if (candidate.type === 'ability_level') {
        const levelXpTable = gameData.levelExperienceTable || [];
        const currentXp = levelXpTable[candidate.currentLevel] || 0;
        return calculateAbilityLevelUpCost(
            candidate.currentHrid,
            candidate.currentLevel,
            currentXp,
            candidate.upgradeLevel
        );
    }

    if (candidate.type === 'ability_swap') {
        return calculateAbilityLevelUpCost(candidate.upgradeHrid, 0, 0, candidate.upgradeLevel);
    }

    if (candidate.type === 'cross_slot') {
        let buyCost = 0;
        for (const [slot, item] of Object.entries(candidate.addedSlots)) {
            const price = resolveUpgradeBuyPrice(item.hrid, item.enhancementLevel, slot, gameData);
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
        return Math.max(0, buyCost - sellCredit);
    }

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
            gameData,
            { slot: candidate.slot }
        );
    }

    // Tier upgrade: buy new item at target enhancement - sell current item
    const buyPrice = resolveUpgradeBuyPrice(candidate.upgradeHrid, candidate.upgradeLevel, candidate.slot, gameData);
    if (buyPrice === null) {
        return null; // Unknown acquisition cost — don't rank as free
    }
    const sellPrice = resolveItemPrice(candidate.currentHrid, {
        side: 'sell',
        enhancementLevel: candidate.currentLevel,
    }).price;

    return Math.max(0, buyPrice - sellPrice);
}

/**
 * Resolve the buy price of an item at a given enhancement level.
 * When no price exists at that level (common for refined gear, which rarely
 * has listings above +0), fall back to the base item price plus the expected
 * enhancement cost to reach the level. Returns null when no price is known
 * at all so callers can surface "unknown" instead of a free upgrade.
 * @param {string} itemHrid - Item HRID
 * @param {number} enhancementLevel - Target enhancement level
 * @param {string} slot - Equipment slot HRID (for enhancement cost params)
 * @param {Object} gameData - Game data payload
 * @returns {number|null} Buy price in gold, or null when unknown
 */
function resolveUpgradeBuyPrice(itemHrid, enhancementLevel, slot, gameData) {
    if (enhancementLevel > 0) {
        // Same method as enhancement candidates: use the market only when the
        // target level has an actual listing. resolveItemPrice cannot be used
        // here — its production-cost fallback ignores the enhancement level and
        // would price a +10 item as a +0 craft.
        const market = getItemPrices(itemHrid, enhancementLevel);
        if (market?.ask > 0) {
            return market.ask;
        }

        // No listing at the target level: base item price + enhancement cost
        const basePrice = resolveItemPrice(itemHrid, { side: 'buy', enhancementLevel: 0 }).price;
        const enhanceCost = calculateEnhancementCost(itemHrid, 0, enhancementLevel, gameData, { slot });
        // Unknown enhancement cost must stay unknown — pricing the item as a
        // bare +0 craft would understate an enhanced buy by the whole enhance path
        if (enhanceCost == null) {
            return null;
        }
        const total = Math.max(0, basePrice) + Math.max(0, enhanceCost);
        return total > 0 ? total : null;
    }

    const direct = resolveItemPrice(itemHrid, { side: 'buy', enhancementLevel: 0 }).price;
    return direct > 0 ? direct : null;
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

/**
 * Itemised cost for a candidate: what gets bought, at what price, and what the
 * gear it replaces would fetch. Purely for display — the ranking still uses
 * calculateUpgradeCost — so a row showing a blank cost can say which item has no
 * price instead of leaving the reader guessing.
 * @param {Object} candidate - Upgrade candidate
 * @param {Object} gameData - Game data payload
 * @returns {Object} { buys, credits, gross, credit, net, unpriced }
 */
export function explainUpgradeCost(candidate, gameData) {
    const nameOf = (hrid) => gameData?.itemDetailMap?.[hrid]?.name || hrid?.split('/').pop().replace(/_/g, ' ') || '?';

    const buys = [];
    if (candidate.addedSlots) {
        for (const [slot, item] of Object.entries(candidate.addedSlots)) {
            buys.push({
                hrid: item.hrid,
                name: nameOf(item.hrid),
                enhancementLevel: item.enhancementLevel || 0,
                price: resolveUpgradeBuyPrice(item.hrid, item.enhancementLevel || 0, slot, gameData),
            });
        }
    } else if (candidate.upgradeHrid) {
        buys.push({
            hrid: candidate.upgradeHrid,
            name: nameOf(candidate.upgradeHrid),
            enhancementLevel: candidate.upgradeLevel || 0,
            price: resolveUpgradeBuyPrice(candidate.upgradeHrid, candidate.upgradeLevel || 0, candidate.slot, gameData),
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

    return {
        buys,
        credits,
        gross,
        credit,
        net: gross === null ? null : Math.max(0, gross - credit),
        unpriced,
        // Set by the lab analysis when replaced gear is kept rather than sold
        creditApplied: credits.length > 0,
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
            houseTargets
        )
    );
    const candidatesWithCost = candidates.map((c) => ({
        ...c,
        cost: calculateUpgradeCost(c, gameData),
    }));

    const combatLevelCount = candidatesWithCost.filter((c) => c.type === 'combat_level').length;
    const foodSimCount = optimizeFood ? estimateFoodSimCount(gameData, playerDTO.food) : 0;
    // +1 baseline, + XP-rate sims for combat levels, + the food search
    const total = candidatesWithCost.length + combatLevelCount + foodSimCount + 1;
    let current = 0;

    // Run baseline sim
    onProgress?.({ current: 0, total, description: 'Running baseline...' });
    const baselineResult = await runSimulation(
        { gameData, playerDTOs, zoneHrid, difficultyTier, hours, communityBuffs, seed: simSeed },
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
            { gameData, playerDTOs: modifiedDTOs, zoneHrid, difficultyTier, hours, communityBuffs, seed: simSeed },
            null
        );

        if (abortSignal?.()) break;

        const metrics = computeMetrics(simResult, gameData, playerHrid, hours);
        const deltas = computeDeltas(baselineMetrics, metrics);
        const goldPer = computeGoldPerImprovement(candidate.cost, deltas);

        const economics = computeEconomics(candidate.cost, baselineMetrics, metrics);

        const row = { candidate, cost: candidate.cost, metrics, deltas, goldPer, economics };
        if (candidate.type === 'combat_level') {
            // Leveling posture: XP rates with the matching charm for this skill
            // equipped (current levels), since that's what you'd wear to grind it
            onProgress?.({ current, total, description: `XP rate: ${candidate.description}` });
            const xpDTOs = JSON.parse(JSON.stringify(playerDTOs));
            const currentCharm = xpDTOs[playerIndex].equipment[CHARM_SLOT] || null;
            const matchingCharm = findMatchingCharmForSkill(currentCharm, candidate.skillKey, gameData, charmTier);
            xpDTOs[playerIndex].equipment[CHARM_SLOT] = matchingCharm;
            const xpSimResult = await runSimulation(
                { gameData, playerDTOs: xpDTOs, zoneHrid, difficultyTier, hours, communityBuffs, seed: simSeed },
                null
            );
            current++;
            row.levelTimeHours = estimateCombatLevelTime(candidate, xpSimResult, gameData, playerHrid);
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
            if (abortSignal?.()) {
                results.push(row);
                break;
            }
        }
        results.push(row);
        current++;
        onProgress?.({ current, total, description: candidate.description });
    }

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
 * Estimate hours of grinding (at the baseline sim's per-skill XP rates) needed
 * to raise a combat skill from its current level to the candidate's boosted
 * level. Infinity when the current setup earns no XP in that skill.
 * @param {Object} candidate - combat_level candidate
 * @param {Object} baselineResult - Baseline sim result
 * @param {Object} gameData - Game data (levelExperienceTable)
 * @param {string} playerHrid - Player HRID in the sim result
 * @returns {number} Hours needed, or Infinity
 */
function estimateCombatLevelTime(candidate, baselineResult, gameData, playerHrid) {
    const levelXpTable = gameData.levelExperienceTable || [];
    const skillName = candidate.skillKey.replace('Level', '');
    const simHours = (baselineResult.simulatedTime || 0) / (3600 * 1e9) || 1;
    const xpPerHour = (baselineResult.experienceGained?.[playerHrid]?.[skillName] || 0) / simHours;
    if (!(xpPerHour > 0)) return Infinity;

    const targetXp = levelXpTable[candidate.upgradeLevel];
    if (!Number.isFinite(targetXp)) return Infinity;

    // Use the character's actual XP when their live skill matches the simmed
    // level; otherwise assume the start of the current level
    let currentXp = levelXpTable[candidate.currentLevel] || 0;
    const liveSkill = dataManager.getSkills?.()?.find((s) => s.skillHrid === `/skills/${skillName}`);
    if (liveSkill && liveSkill.level === candidate.currentLevel && Number.isFinite(liveSkill.experience)) {
        currentXp = liveSkill.experience;
    }

    return Math.max(0, targetXp - currentXp) / xpPerHour;
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

    const goldPer = (pctDelta) => {
        if (pctDelta <= 0) return Infinity;
        return safeCost / steps(pctDelta);
    };

    // For deaths, fewer is better — use negative delta (reduction)
    const goldPerReduction = (pctDelta) => {
        if (pctDelta >= 0) return Infinity; // Deaths didn't decrease
        return safeCost / steps(pctDelta);
    };

    return {
        dps: goldPer(deltas.dps),
        xp: goldPer(deltas.xp),
        profit: goldPer(deltas.profit),
        encounters: goldPer(deltas.encounters),
        deaths: goldPerReduction(deltas.deaths),
    };
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
    if (safeCost <= 0) return { profitGainPerHour, paybackHours: 0, repayHours: 0 };

    const basePerHour = baseline?.profitPerHour ?? 0;
    return {
        profitGainPerHour,
        paybackHours: basePerHour > 0 ? safeCost / basePerHour : Infinity,
        repayHours: profitGainPerHour > 0 ? safeCost / profitGainPerHour : Infinity,
    };
}

/** Placings that earn points in the rank score, best first. */
export const RANK_PLACES = 5;

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
 * Payback is excluded on purpose. Baseline profit is one number shared by every
 * row, so dividing each cost by it preserves the cost ordering exactly — payback
 * is the Cost column in hours, and scoring it would count cost twice. Repay is
 * the one that carries new information, dividing by a gain that differs per row.
 *
 * Ties share a placing, so two candidates that measure identically cannot be
 * separated by list order.
 *
 * Mutates and returns the rows, adding `score` and a `rankPoints` breakdown.
 *
 * @param {Array<Object>} results - Rows carrying `goldPer` and `economics`
 * @param {number} [places=RANK_PLACES] - How many placings earn points
 * @returns {Array<Object>} The same rows
 */
export function assignRankScores(results, places = RANK_PLACES) {
    // Every metric here is lower-is-better, so one ladder direction serves all
    const metrics = [
        { key: 'dps', label: 'Gold/0.01% DPS', value: (r) => r.goldPer?.dps },
        { key: 'xp', label: 'Gold/0.01% EXP', value: (r) => r.goldPer?.xp },
        { key: 'profit', label: 'Gold/0.01% Profit', value: (r) => r.goldPer?.profit },
        { key: 'repay', label: 'Repay time', value: (r) => r.economics?.repayHours },
    ];

    for (const row of results) {
        row.rankPoints = {};
        row.score = 0;
    }

    for (const metric of metrics) {
        const ladder = [...new Set(results.map(metric.value).filter((v) => Number.isFinite(v)))]
            .sort((a, b) => a - b)
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

    const candidatesWithCost = candidates.map((c) => ({
        ...c,
        cost: calculateUpgradeCost(c, gameData),
    }));

    // Generate buff candidates (skilling buffs handled in skilling tab, experience excluded — no combat impact)
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

    if (abortSignal?.()) return { baseline: null, results: [] };

    const baselineAttempts = baselineResult.labyAttemptCount || 1;
    const baselineEncounters = baselineResult.encounters || 0;
    const baselineWinRate = baselineEncounters / baselineAttempts;

    onProgress?.({ current, total, description: `Baseline: ${(baselineWinRate * 100).toFixed(1)}%` });

    const results = [];

    // ── Equipment / ability sims ──
    for (const candidate of candidatesWithCost) {
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Simulating: ${candidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(playerDTOs[playerIndex]));

        if (candidate.slot.startsWith('ability_')) {
            const slotIdx = parseInt(candidate.slot.split('_')[1]);
            const existingAbility = modifiedDTO.abilities[slotIdx];
            if (existingAbility?.hrid === candidate.upgradeHrid) {
                // Keep configured triggers when leveling the equipped ability
                modifiedDTO.abilities[slotIdx] = {
                    ...existingAbility,
                    level: candidate.upgradeLevel,
                };
            } else {
                modifiedDTO.abilities[slotIdx] = {
                    hrid: candidate.upgradeHrid,
                    level: candidate.upgradeLevel,
                    triggers: null,
                };
            }
        } else if (candidate.type === 'combat_level') {
            // Combat skill level boost (simulated charm)
            modifiedDTO[candidate.skillKey] = candidate.upgradeLevel;
        } else if (candidate.type === 'cross_slot') {
            for (const slot of candidate.clearedSlots) {
                modifiedDTO.equipment[slot] = null;
            }
            for (const [slot, item] of Object.entries(candidate.addedSlots)) {
                modifiedDTO.equipment[slot] = item;
            }
        } else {
            modifiedDTO.equipment[candidate.slot] = {
                hrid: candidate.upgradeHrid,
                enhancementLevel: candidate.upgradeLevel,
            };
        }

        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [modifiedDTO],
            zoneHrid,
            monsterHrid,
            roomLevel,
            crates,
            hours,
            communityBuffs,
            labyrinthCombatBuffs,
            seed: simSeed,
        });

        if (abortSignal?.()) break;

        const attempts = simResult.labyAttemptCount || 1;
        const encounters = simResult.encounters || 0;
        const winRate = encounters / attempts;
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
        current++;
        onProgress?.({ current, total, description: candidate.description });
    }

    // ── Combat buff sims ──
    for (const buffCandidate of combatBuffCandidates) {
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Simulating: ${buffCandidate.description}` });

        const modifiedBuffs = buildModifiedCombatBuffs(labyrinthCombatBuffs, buffCandidate);
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [playerDTOs[playerIndex]],
            zoneHrid,
            monsterHrid,
            roomLevel,
            crates,
            hours,
            communityBuffs,
            labyrinthCombatBuffs: modifiedBuffs,
            seed: simSeed,
        });

        if (abortSignal?.()) break;

        const attempts = simResult.labyAttemptCount || 1;
        const encounters = simResult.encounters || 0;
        const winRate = encounters / attempts;
        const winRateDelta = winRate - baselineWinRate;

        results.push({
            candidate: buffCandidate,
            costType: 'token',
            tokenCost: buffCandidate.tokenCost,
            winRate,
            winRateDelta,
            metricType: 'winRate',
        });
        current++;
        onProgress?.({ current, total, description: buffCandidate.description });
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
    } = params;
    const { abortSignal } = options;
    const gameData = buildGameDataPayload();
    if (!gameData) throw new Error('No game data available');

    const zoneHrid =
        Object.keys(gameData.actionDetailMap).find((k) => k.includes('/actions/combat/')) || '/actions/combat/fly';

    // Union of combat-level candidates across the fight loadouts
    const candidatesByKey = new Map();
    for (const fight of fights) {
        const fightCandidates = generateCandidates(
            fight.dto,
            gameData,
            'combat_level',
            abilityTargetLevel,
            'increment',
            false,
            combatLevelTargets
        );
        for (const candidate of fightCandidates) {
            if (!candidatesByKey.has(candidate.skillKey)) {
                candidatesByKey.set(candidate.skillKey, candidate);
            }
        }
    }
    const candidates = [...candidatesByKey.values()];

    const total = fights.length * (candidates.length + 1);
    let current = 0;

    // Per-fight seeds derived from one analysis seed: fight N is simmed with the
    // same random draws in the baseline pass and in every candidate pass, so a
    // win-rate delta is the level boost rather than two independent samples
    const simSeed = analysisSeed();
    const fightSeed = (fightIndex) => deriveSeed(simSeed, fightIndex);

    const simFightWinRate = async (fight, dtoOverride, seed) => {
        const simResult = await runLabyrinthSimulation({
            gameData,
            playerDTOs: [dtoOverride || fight.dto],
            zoneHrid,
            monsterHrid: fight.monsterHrid,
            roomLevel: fight.roomLevel,
            crates,
            hours,
            communityBuffs,
            labyrinthCombatBuffs,
            seed,
        });
        const attempts = simResult.labyAttemptCount || 1;
        return (simResult.encounters || 0) / attempts;
    };

    const fightMeta = (fight) => ({
        monsterHrid: fight.monsterHrid,
        monsterName: fight.monsterName,
        roomLevel: fight.roomLevel,
        loadoutName: fight.loadoutName,
    });

    // Baseline pass: every fight with its current levels
    const baselineFights = [];
    for (let i = 0; i < fights.length; i++) {
        const fight = fights[i];
        if (abortSignal?.()) return { baseline: null, results: [] };
        onProgress?.({ current, total, description: `Baseline: ${fight.monsterName}` });
        const winRate = await simFightWinRate(fight, null, fightSeed(i));
        baselineFights.push({ ...fightMeta(fight), winRate });
        current++;
    }
    const baselineRunClear = baselineFights.reduce((product, f) => product * f.winRate, 1);
    const baselineAttempts = baselineFights.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);

    // One pass per combat-level candidate across every fight
    const results = [];
    for (const candidate of candidates) {
        const fightResults = [];
        let aborted = false;
        for (let i = 0; i < fights.length; i++) {
            if (abortSignal?.()) {
                aborted = true;
                break;
            }
            onProgress?.({ current, total, description: `${candidate.description}: ${fights[i].monsterName}` });
            const boostedDTO = JSON.parse(JSON.stringify(fights[i].dto));
            boostedDTO[candidate.skillKey] = candidate.upgradeLevel;
            const winRate = await simFightWinRate(fights[i], boostedDTO, fightSeed(i));
            fightResults.push({
                ...fightMeta(fights[i]),
                winRate,
                winRateDelta: winRate - baselineFights[i].winRate,
            });
            current++;
        }
        if (aborted) break;

        const runClearChance = fightResults.reduce((product, f) => product * f.winRate, 1);
        const expectedAttempts = fightResults.reduce((sum, f) => sum + expectedFightAttempts(f.winRate), 0);
        const avgWinDelta = fightResults.reduce((sum, f) => sum + f.winRateDelta, 0) / (fightResults.length || 1);
        results.push({
            candidate,
            fights: fightResults,
            runClearChance,
            runClearDelta: runClearChance - baselineRunClear,
            expectedAttempts,
            attemptsDelta: expectedAttempts - baselineAttempts,
            avgWinDelta,
        });
    }

    // Biggest attempts reduction (most negative delta) first
    results.sort((a, b) => a.attemptsDelta - b.attemptsDelta);

    return {
        baseline: { fights: baselineFights, runClearChance: baselineRunClear, expectedAttempts: baselineAttempts },
        results,
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

        const overrides = buildOverridesForSkill(editorState, actionTypeHrid, crateHrids, gameData);
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

        const overrides = buildOverridesForSkill(editorState, actionTypeHrid, crateHrids, gameData);
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
 * Generate labyrinth buff candidates from editor token upgrade levels.
 * @param {Object} tokenUpgrades - { speed, efficiency, success, doubleProgress }
 * @returns {Array} Buff candidates with type 'labyrinth_buff'
 */
function generateLabyrinthBuffCandidatesFromEditor(tokenUpgrades) {
    const skillingDefs = LABYRINTH_BUFF_DEFS.filter((d) => d.category === 'skilling');
    const editorKeyMap = {
        labyrinthSkillActionSpeedLevel: 'speed',
        labyrinthSkillingEfficiencyLevel: 'efficiency',
        labyrinthSkillingSuccessLevel: 'success',
        labyrinthSkillingDoubleProgressLevel: 'doubleProgress',
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

    return candidates;
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
    const clearRateOpts = { skillEquipmentMap, targetSkill };

    // Yield so Stop clicks and progress paints can land between the heavy sync chunks
    await new Promise((resolve) => setTimeout(resolve, 0));

    const total = buffCandidates.length + equipCandidates.length + 1;
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

    const results = [];

    for (const buffCandidate of buffCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${buffCandidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        modifiedDTO.tokenUpgrades[buffCandidate.editorKey] = buffCandidate.currentLevel + 1;

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

    for (const candidate of equipCandidates) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (abortSignal?.()) break;

        onProgress?.({ current, total, description: `Evaluating: ${candidate.description}` });

        const modifiedDTO = JSON.parse(JSON.stringify(editorDTO));
        const modifiedSkillEquipMap = JSON.parse(JSON.stringify(skillEquipmentMap));
        const upgradePayload = { hrid: candidate.upgradeHrid, enhancementLevel: candidate.upgradeLevel };

        if (modifiedDTO.equipment?.[candidate.slot]?.hrid === candidate.currentHrid) {
            modifiedDTO.equipment[candidate.slot] = upgradePayload;
        }
        for (const skillEquip of Object.values(modifiedSkillEquipMap)) {
            if (skillEquip?.[candidate.slot]?.hrid === candidate.currentHrid) {
                skillEquip[candidate.slot] = upgradePayload;
            }
        }

        const evaluate = (evalCandidate, dto, equipMap) => {
            const payload = { hrid: evalCandidate.upgradeHrid, enhancementLevel: evalCandidate.upgradeLevel };
            if (dto.equipment?.[evalCandidate.slot]?.hrid === evalCandidate.currentHrid) {
                dto.equipment[evalCandidate.slot] = payload;
            }
            for (const skillEquip of Object.values(equipMap)) {
                if (skillEquip?.[evalCandidate.slot]?.hrid === evalCandidate.currentHrid) {
                    skillEquip[evalCandidate.slot] = payload;
                }
            }
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

    results.sort((a, b) => {
        if (a.costType !== b.costType) return a.costType === 'token' ? -1 : 1;
        return (b.clearRateDelta ?? 0) - (a.clearRateDelta ?? 0);
    });

    return {
        baseline: { clearRate: baselineClearRate },
        results,
    };
}

export default {
    generateCandidates,
    calculateUpgradeCost,
    runUpgradeAnalysis,
    runLabyrinthUpgradeAnalysis,
    generateLabyrinthBuffCandidates,
    getEquipmentTierProgression,
    computeSkillingClearRatesFromEditor,
    generateSkillingEquipmentCandidates,
    runSkillingUpgradeAnalysis,
};
