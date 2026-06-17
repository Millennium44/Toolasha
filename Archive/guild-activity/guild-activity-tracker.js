/**
 * Guild Activity Tracker
 * Intercepts guild activity WebSocket messages to track session stats,
 * budget usage, and calculate projections for guild skilling/combat activities.
 *
 * SR: changes by 0.008 per difficulty level.
 * When observed data exists, SR is anchored from the game's actual value and
 * extrapolated to other tiers. Otherwise: SR = 0.84 + (skillLevel - difficulty) * 0.008
 *
 * Data sources:
 * - guild_activity_progress — live session stats (successRate, progressPerAction, etc.)
 * - guild_activity_member_updated — star completion + budget tracking
 * - guild_updated — guild-wide star totals
 * - guild_characters_updated — per-member progress
 */

import dataManager from '../../core/data-manager.js';
import webSocketHook from '../../core/websocket.js';
import storage from '../../core/storage.js';
import config from '../../core/config.js';
import loadoutSnapshot from '../combat/loadout-snapshot.js';
import { parseEquipmentSpeedBonuses, parseEquipmentEfficiencyBonuses } from '../../utils/equipment-parser.js';

const STORE_NAME = 'guildHistory';
const SESSION_DURATION_MS = 600_000;
const TARGET_WORK_PER_TIER = 300;
const BASE_TARGET_WORK = 3000;
const GUILD_BASE_TIME_MS = 10_000;

const SR_BASE = 0.84;
const SR_PER_LEVEL = 0.008;

const ACTIVITY_TO_SKILL = {
    '/guild_skilling/milking': '/skills/milking',
    '/guild_skilling/foraging': '/skills/foraging',
    '/guild_skilling/woodcutting': '/skills/woodcutting',
    '/guild_skilling/cheesesmithing': '/skills/cheesesmithing',
    '/guild_skilling/crafting': '/skills/crafting',
    '/guild_skilling/tailoring': '/skills/tailoring',
    '/guild_skilling/cooking': '/skills/cooking',
    '/guild_skilling/brewing': '/skills/brewing',
    '/guild_skilling/alchemy': '/skills/alchemy',
    '/guild_skilling/enhancing': '/skills/enhancing',
};

const GATHERING_SKILLS = new Set(['/skills/milking', '/skills/foraging', '/skills/woodcutting']);
const GOURMET_SKILLS = new Set(['/skills/cooking', '/skills/brewing']);

class GuildActivityTracker {
    constructor() {
        this.currentSession = null;
        this.budget = null;
        this.observedTiers = {};
        this.guildStars = {};
        this.memberProgress = {};
        this.weeklyActivitySet = null;
        this.unregisterHandlers = [];
        this._initialized = false;
    }

    initialize() {
        if (!config.getSetting('guildActivityCalculator')) return;
        if (this._initialized) return;
        this._initialized = true;

        this._boundOnProgress = (data) => this._onActivityProgress(data);
        this._boundOnMemberUpdated = (data) => this._onMemberUpdated(data);
        this._boundOnGuildUpdated = (data) => this._onGuildUpdated(data);
        this._boundOnMembersUpdated = (data) => this._onMembersUpdated(data);
        this._boundOnCharacterInit = () => this._onCharacterInit();

        webSocketHook.on('guild_activity_progress', this._boundOnProgress);
        webSocketHook.on('guild_activity_member_updated', this._boundOnMemberUpdated);
        webSocketHook.on('guild_updated', this._boundOnGuildUpdated);
        webSocketHook.on('guild_characters_updated', this._boundOnMembersUpdated);
        dataManager.on('character_initialized', this._boundOnCharacterInit);

        this.unregisterHandlers.push(
            () => webSocketHook.off('guild_activity_progress', this._boundOnProgress),
            () => webSocketHook.off('guild_activity_member_updated', this._boundOnMemberUpdated),
            () => webSocketHook.off('guild_updated', this._boundOnGuildUpdated),
            () => webSocketHook.off('guild_characters_updated', this._boundOnMembersUpdated),
            () => dataManager.off('character_initialized', this._boundOnCharacterInit)
        );

        this._onCharacterInit();
        this._loadStoredData();
    }

    disable() {
        for (const unreg of this.unregisterHandlers) {
            unreg();
        }
        this.unregisterHandlers = [];
        this.currentSession = null;
        this._initialized = false;
    }

    async _loadStoredData() {
        try {
            this.observedTiers = await storage.get('observedTiers', STORE_NAME, {});
        } catch (error) {
            console.error('[GuildActivityTracker] Failed to load stored data:', error);
            this.observedTiers = {};
        }
    }

    async _saveObservedTiers() {
        try {
            await storage.set('observedTiers', this.observedTiers, STORE_NAME);
        } catch (error) {
            console.error('[GuildActivityTracker] Failed to save observed tiers:', error);
        }
    }

    _onCharacterInit() {
        const charData = dataManager.characterData;
        if (!charData) return;

        if (charData.guildWeeklyActivitySet) {
            this.weeklyActivitySet = charData.guildWeeklyActivitySet;
        }

        if (charData.guild) {
            this._parseGuildStars(charData.guild.currentWeekActivitiesData);
        }

        if (charData.guildCharacterMap) {
            this._parseMemberProgress(charData.guildCharacterMap);
        }
    }

    _onActivityProgress(data) {
        const session = {
            activityHrid: data.activityHrid,
            tier: data.tier,
            currentProgress: data.currentProgress,
            successRate: data.successRate,
            efficiency: data.efficiency,
            doubleProgressChance: data.doubleProgressChance,
            progressPerAction: data.progressPerAction,
            targetLevel: data.targetLevel,
            actionTimeMs: data.actionTimeMs,
            timeoutAt: data.timeoutAt,
            targetWorkValue: data.targetWorkValue,
            currentWorkValue: data.currentWorkValue,
            currentEnhLevel: data.currentEnhLevel,
            actionCounter: data.actionCounter,
            lastUpdate: Date.now(),
        };

        this.currentSession = session;

        const key = `${data.activityHrid}:${data.tier}`;
        this.observedTiers[key] = {
            activityHrid: data.activityHrid,
            tier: data.tier,
            successRate: data.successRate,
            efficiency: data.efficiency,
            doubleProgressChance: data.doubleProgressChance,
            progressPerAction: data.progressPerAction,
            targetWorkValue: data.targetWorkValue,
            targetLevel: data.targetLevel,
            actionTimeMs: data.actionTimeMs,
            skillLevel: this._getSkillLevel(data.activityHrid),
            observedAt: Date.now(),
        };
        this._saveObservedTiers();

        this._notifyListeners();
    }

    _onMemberUpdated(data) {
        this.budget = {
            secondsRemaining: data.budgetSecondsRemaining,
            secondsCap: data.budgetSecondsCap,
            updatedAt: Date.now(),
        };

        if (data.progressMap) {
            this.memberProgress = { ...data.progressMap };
        }

        this._notifyListeners();
    }

    _onGuildUpdated(data) {
        if (data.guild?.currentWeekActivitiesData) {
            this._parseGuildStars(data.guild.currentWeekActivitiesData);
        }
        if (data.guildWeeklyActivitySet) {
            this.weeklyActivitySet = data.guildWeeklyActivitySet;
        }
        this._notifyListeners();
    }

    _onMembersUpdated(data) {
        if (data.guildCharacterMap) {
            this._parseMemberProgress(data.guildCharacterMap);
        }
        this._notifyListeners();
    }

    _parseGuildStars(jsonString) {
        try {
            this.guildStars = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString || {};
        } catch {
            this.guildStars = {};
        }
    }

    _parseMemberProgress(charMap) {
        const selfId = dataManager.characterData?.character?.id;
        if (!selfId || !charMap[selfId]) return;

        const self = charMap[selfId];
        if (self.weeklyActivityProgressData) {
            try {
                this.memberProgress =
                    typeof self.weeklyActivityProgressData === 'string'
                        ? JSON.parse(self.weeklyActivityProgressData)
                        : self.weeklyActivityProgressData;
            } catch {
                this.memberProgress = {};
            }
        }
        if (self.weeklyActivitySecondsUsed !== undefined) {
            const cap = this.budget?.secondsCap || 7200;
            this.budget = {
                secondsRemaining: cap - self.weeklyActivitySecondsUsed,
                secondsCap: cap,
                updatedAt: Date.now(),
            };
        }
    }

    // ─── Public API ─────────────────────────────────────────────────────────────

    getCurrentSession() {
        return this.currentSession;
    }

    getBudget() {
        return this.budget;
    }

    getGuildStars() {
        return { ...this.guildStars };
    }

    getMemberProgress() {
        return { ...this.memberProgress };
    }

    getWeeklyActivitySet() {
        return this.weeklyActivitySet;
    }

    /**
     * Calculate probability of completing at least 1 star within a 10-minute session.
     * Uses normal approximation of binomial distribution.
     * @param {object} stats - Session stats
     * @returns {number} Probability (0-1)
     */
    calculateSessionCompletionChance(stats) {
        if (!stats || !stats.successRate || !stats.actionTimeMs) return 0;

        const n = Math.floor(SESSION_DURATION_MS / stats.actionTimeMs);
        const p = Math.min(1, stats.successRate);
        const isEnhancing = stats.targetLevel != null;

        let needSuccesses;
        if (isEnhancing) {
            needSuccesses = stats.targetLevel;
        } else {
            if (!stats.progressPerAction || !stats.targetWorkValue) return 0;
            const progressPerSuccess = stats.progressPerAction * (1 + (stats.doubleProgressChance || 0));
            needSuccesses = Math.ceil(stats.targetWorkValue / progressPerSuccess);
        }

        if (needSuccesses <= 0) return 1;
        if (needSuccesses > n) return 0;

        const mean = n * p;
        const std = Math.sqrt(n * p * (1 - p));
        if (std === 0) return mean >= needSuccesses ? 1 : 0;

        const z = (mean - needSuccesses + 0.5) / std;
        return this._normalCDF(z);
    }

    _normalCDF(z) {
        const a1 = 0.254829592;
        const a2 = -0.284496736;
        const a3 = 1.421413741;
        const a4 = -1.453152027;
        const a5 = 1.061405429;
        const pp = 0.3275911;
        const sign = z < 0 ? -1 : 1;
        const x = Math.abs(z) / Math.SQRT2;
        const t = 1.0 / (1.0 + pp * x);
        const y = 1.0 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
        return 0.5 * (1.0 + sign * y);
    }

    /**
     * Calculate expected time (ms) to complete one tier.
     * @param {object} stats - Tier stats
     * @returns {number} Milliseconds to complete the tier
     */
    calculateTimeToComplete(stats) {
        if (!stats || !stats.successRate || !stats.actionTimeMs) return Infinity;

        const isEnhancing = stats.targetLevel != null;

        if (isEnhancing) {
            if (!stats.targetLevel) return Infinity;
            return (stats.targetLevel / stats.successRate) * stats.actionTimeMs;
        }

        if (!stats.progressPerAction || !stats.targetWorkValue) return Infinity;
        const progressPerAttempt = stats.progressPerAction * stats.successRate * (1 + (stats.doubleProgressChance || 0));
        return (stats.targetWorkValue / progressPerAttempt) * stats.actionTimeMs;
    }

    // ─── SR Formula ─────────────────────────────────────────────────────────────

    /**
     * Compute SR for an activity at a given difficulty.
     * Anchors from observed data when available (exact), otherwise estimates from skill level.
     * @param {string} activityHrid - Activity hrid
     * @param {number} difficulty - Difficulty level (100 + tier * 10)
     * @returns {number} Success rate (clamped to [0.01, 1.0])
     */
    _computeSR(activityHrid, difficulty) {
        const observed = this._findObservedTier(activityHrid);
        if (observed) {
            const observedDifficulty = 100 + observed.tier * 10;
            const sr = observed.successRate + (observedDifficulty - difficulty) * SR_PER_LEVEL;
            return Math.max(0.01, Math.min(1.0, sr));
        }

        const skillLevel = this._getSkillLevel(activityHrid);
        if (!skillLevel) return 0.5;

        const sr = SR_BASE + (skillLevel - difficulty) * SR_PER_LEVEL;
        return Math.max(0.01, Math.min(1.0, sr));
    }

    /**
     * Find any observed tier data for an activity to use as SR anchor.
     * @param {string} activityHrid - Activity hrid
     * @returns {Object|null} Observed tier data or null
     */
    _findObservedTier(activityHrid) {
        for (const data of Object.values(this.observedTiers)) {
            if (data.activityHrid === activityHrid && data.successRate > 0) {
                return data;
            }
        }
        return null;
    }

    /**
     * Resolve equipment and drinks for an activity, preferring loadout snapshots.
     * @param {string} activityHrid - Activity hrid
     * @returns {{ equipment: Map|null, drinks: Array|null, loadoutName: string|null }}
     */
    _resolveLoadout(activityHrid) {
        const skillHrid = ACTIVITY_TO_SKILL[activityHrid];
        const actionTypeHrid = skillHrid?.replace('/skills/', '/action_types/');
        if (!actionTypeHrid) return { equipment: null, drinks: null, loadoutName: null };

        const snapshotEquip = loadoutSnapshot.getSnapshotForSkill(actionTypeHrid);
        const snapshotDrinks = loadoutSnapshot.getSnapshotDrinksForSkill(actionTypeHrid);
        const snapshotInfo = loadoutSnapshot.getSnapshotInfoForSkill(actionTypeHrid);

        return {
            equipment: snapshotEquip || dataManager.getEquipment(),
            drinks: snapshotDrinks || dataManager.getActionDrinkSlots(actionTypeHrid),
            loadoutName: snapshotInfo?.name || null,
        };
    }

    /**
     * Sum all applicable level buffs from active drinks for a guild activity.
     * Looks for buff_types/action_level (generic) and buff_types/{skill}_level (specific).
     * @param {string} activityHrid - Activity hrid
     * @param {Array} [drinks] - Drink slots to use (defaults to live slots)
     * @returns {number} Total drink level bonus (before concentration amplification)
     */
    _getDrinkLevelBonus(activityHrid, drinks) {
        const skillHrid = ACTIVITY_TO_SKILL[activityHrid];
        if (!skillHrid) return 0;

        const actionTypeHrid = skillHrid.replace('/skills/', '/action_types/');
        const resolvedDrinks = drinks || dataManager.getActionDrinkSlots(actionTypeHrid);
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap;
        if (!resolvedDrinks || !itemDetailMap) return 0;

        const skillName = skillHrid.replace('/skills/', '');
        const skillLevelType = `/buff_types/${skillName}_level`;

        let total = 0;
        for (const drink of resolvedDrinks) {
            if (!drink) continue;
            const itemHrid = drink.itemHrid || drink;
            const detail = itemDetailMap[itemHrid];
            if (!detail?.consumableDetail?.buffs) continue;

            for (const buff of detail.consumableDetail.buffs) {
                if (buff.typeHrid === '/buff_types/action_level' || buff.typeHrid === skillLevelType) {
                    total += buff.flatBoost;
                }
            }
        }

        return total;
    }

    /**
     * Sum a specific buff type from active drinks for a guild activity.
     * @param {string} activityHrid - Activity hrid
     * @param {string} buffTypeHrid - Buff type to sum (e.g., '/buff_types/efficiency')
     * @param {Array} [drinks] - Drink slots to use (defaults to live slots)
     * @returns {number} Total buff value (before concentration amplification)
     */
    _getDrinkBuffBonus(activityHrid, buffTypeHrid, drinks) {
        const skillHrid = ACTIVITY_TO_SKILL[activityHrid];
        if (!skillHrid) return 0;

        const actionTypeHrid = skillHrid.replace('/skills/', '/action_types/');
        const resolvedDrinks = drinks || dataManager.getActionDrinkSlots(actionTypeHrid);
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap;
        if (!resolvedDrinks || !itemDetailMap) return 0;

        let total = 0;
        for (const drink of resolvedDrinks) {
            if (!drink) continue;
            const itemHrid = drink.itemHrid || drink;
            const detail = itemDetailMap[itemHrid];
            if (!detail?.consumableDetail?.buffs) continue;

            for (const buff of detail.consumableDetail.buffs) {
                if (buff.typeHrid === buffTypeHrid) {
                    total += buff.flatBoost;
                }
            }
        }

        return total;
    }

    /**
     * Get the house room efficiency bonus for an activity's action type.
     * @param {string} actionTypeHrid - Action type hrid
     * @returns {number} House room efficiency bonus
     */
    _getHouseRoomEfficiency(actionTypeHrid) {
        const houseRooms = dataManager.getHouseRooms();
        const houseRoomDetailMap = dataManager.getInitClientData()?.houseRoomDetailMap;
        if (!houseRooms || !houseRoomDetailMap) return 0;

        for (const [roomHrid, room] of houseRooms) {
            if (!room.level || room.level <= 0) continue;
            const roomDef = houseRoomDetailMap[roomHrid];
            if (!roomDef?.usableInActionTypeMap?.[actionTypeHrid]) continue;

            const actionBuffs = roomDef.actionBuffs || [];
            for (const buff of actionBuffs) {
                if (buff.typeHrid === '/buff_types/efficiency') {
                    return buff.flatBoostLevelBonus * room.level;
                }
            }
        }

        return 0;
    }

    /**
     * Get the house room action speed bonus for an activity's action type.
     * @param {string} actionTypeHrid - Action type hrid
     * @returns {number} House room speed bonus
     */
    _getHouseRoomSpeed(actionTypeHrid) {
        const houseRooms = dataManager.getHouseRooms();
        const houseRoomDetailMap = dataManager.getInitClientData()?.houseRoomDetailMap;
        if (!houseRooms || !houseRoomDetailMap) return 0;

        for (const [roomHrid, room] of houseRooms) {
            if (!room.level || room.level <= 0) continue;
            const roomDef = houseRoomDetailMap[roomHrid];
            if (!roomDef?.usableInActionTypeMap?.[actionTypeHrid]) continue;

            const actionBuffs = roomDef.actionBuffs || [];
            for (const buff of actionBuffs) {
                if (buff.typeHrid === '/buff_types/action_speed') {
                    return buff.flatBoostLevelBonus * room.level;
                }
            }
        }

        return 0;
    }

    /**
     * Get a community buff value at its current level.
     * Formula: flatBoost + flatBoostLevelBonus * level
     * @param {string} communityBuffHrid - Community buff hrid
     * @returns {number} Total buff value
     */
    _getCommunityBuffValue(communityBuffHrid) {
        const level = dataManager.getCommunityBuffLevel(communityBuffHrid);
        if (!level) return 0;

        const communityBuffMap = dataManager.getInitClientData()?.communityBuffTypeDetailMap;
        if (!communityBuffMap) return 0;

        const def = communityBuffMap[communityBuffHrid];
        if (!def?.buff) return 0;

        return def.buff.flatBoost + def.buff.flatBoostLevelBonus * level;
    }

    /**
     * Compute total efficiency for a guild activity from all sources.
     * efficiency = equipEff + drinkEff*(1+DC) + houseEff + communityEff
     * @param {string} activityHrid - Activity hrid
     * @param {Map} [equipment] - Equipment map (defaults to live equipment)
     * @param {Array} [drinks] - Drink slots (defaults to live slots)
     * @returns {number} Total efficiency
     */
    _computeEfficiency(activityHrid, equipment, drinks) {
        const skillHrid = ACTIVITY_TO_SKILL[activityHrid];
        const actionTypeHrid = skillHrid?.replace('/skills/', '/action_types/');
        if (!actionTypeHrid) return 0;

        const resolvedEquipment = equipment || dataManager.getEquipment();
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap;
        const drinkConcentration = dataManager.characterData?.noncombatStats?.drinkConcentration || 0;

        const equipEfficiency =
            resolvedEquipment && itemDetailMap
                ? parseEquipmentEfficiencyBonuses(resolvedEquipment, actionTypeHrid, itemDetailMap) / 100
                : 0;

        const drinkEfficiency = this._getDrinkBuffBonus(activityHrid, '/buff_types/efficiency', drinks);
        const houseEfficiency = this._getHouseRoomEfficiency(actionTypeHrid);

        const isProcessing = !GATHERING_SKILLS.has(skillHrid) && skillHrid !== '/skills/enhancing';
        const communityEfficiency = isProcessing
            ? this._getCommunityBuffValue('/community_buff_types/production_efficiency')
            : 0;

        return equipEfficiency + drinkEfficiency * (1 + drinkConcentration) + houseEfficiency + communityEfficiency;
    }

    /**
     * Compute doubleProgressChance for a guild activity.
     * - Gathering: equipGathering + drinkGathering*(1+DC) + communityGathering
     * - Cooking/Brewing: drinkGourmet*(1+DC)
     * - Others: 0
     * @param {string} activityHrid - Activity hrid
     * @param {Array} [drinks] - Drink slots (defaults to live slots)
     * @returns {number} Double progress chance
     */
    _computeDoubleProgressChance(activityHrid, drinks) {
        const skillHrid = ACTIVITY_TO_SKILL[activityHrid];
        if (!skillHrid) return 0;

        const drinkConcentration = dataManager.characterData?.noncombatStats?.drinkConcentration || 0;

        if (GATHERING_SKILLS.has(skillHrid)) {
            const equipGathering = dataManager.characterData?.noncombatStats?.gatheringQuantity || 0;
            const drinkGathering = this._getDrinkBuffBonus(activityHrid, '/buff_types/gathering', drinks);
            const communityGathering = this._getCommunityBuffValue('/community_buff_types/gathering_quantity');
            return equipGathering + drinkGathering * (1 + drinkConcentration) + communityGathering;
        }

        if (GOURMET_SKILLS.has(skillHrid)) {
            const drinkGourmet = this._getDrinkBuffBonus(activityHrid, '/buff_types/gourmet', drinks);
            return drinkGourmet * (1 + drinkConcentration);
        }

        return 0;
    }

    /**
     * Compute all stats for a guild activity from current character state.
     * All values are exact (derived from game formulas).
     * @param {string} activityHrid - Activity hrid
     * @returns {object} Computed stats
     */
    _computeBaseStats(activityHrid) {
        const skillHrid = ACTIVITY_TO_SKILL[activityHrid];
        const actionTypeHrid = skillHrid?.replace('/skills/', '/action_types/');
        const isEnhancing = activityHrid.includes('enhancing');

        const { equipment, drinks, loadoutName } = this._resolveLoadout(activityHrid);
        const itemDetailMap = dataManager.getInitClientData()?.itemDetailMap;
        const drinkConcentration = dataManager.characterData?.noncombatStats?.drinkConcentration || 0;

        // Speed: equipment + house room + community (enhancing only)
        let speedBonus =
            equipment && itemDetailMap && actionTypeHrid
                ? parseEquipmentSpeedBonuses(equipment, actionTypeHrid, itemDetailMap)
                : 0;
        if (actionTypeHrid) {
            speedBonus += this._getHouseRoomSpeed(actionTypeHrid);
        }
        if (isEnhancing) {
            speedBonus += this._getCommunityBuffValue('/community_buff_types/enhancing_speed');
        }
        const actionTimeMs = Math.round(GUILD_BASE_TIME_MS / (1 + speedBonus));

        const totalEfficiency = this._computeEfficiency(activityHrid, equipment, drinks);
        const doubleProgressChance = this._computeDoubleProgressChance(activityHrid, drinks);

        const skillLevel = this._getSkillLevel(activityHrid);
        const drinkLevelBonus = this._getDrinkLevelBonus(activityHrid, drinks);
        const effectiveLevel = (skillLevel || 1) + Math.floor(drinkLevelBonus * (1 + drinkConcentration));

        const progressPerAction = effectiveLevel * (1 + totalEfficiency);

        return {
            activityHrid,
            tier: 0,
            successRate: 0,
            efficiency: totalEfficiency,
            doubleProgressChance,
            progressPerAction,
            targetWorkValue: BASE_TARGET_WORK,
            targetLevel: isEnhancing ? 5 : null,
            actionTimeMs,
            loadoutName,
        };
    }

    // ─── Tier Comparison ────────────────────────────────────────────────────────

    /**
     * Get tier comparison data for an activity.
     * Uses exact SR formula and observed data for tier-independent stats.
     * Falls back to computed estimates when no observation exists.
     * @param {string} activityHrid - Activity hrid
     * @returns {Array} Array of tier data with time and token calculations
     */
    getTierComparison(activityHrid) {
        const isEnhancing = activityHrid.includes('enhancing');
        const baseStats = this._computeBaseStats(activityHrid);

        if (!baseStats.actionTimeMs) return { tiers: [], loadoutName: baseStats.loadoutName };

        const tiers = [];

        for (let tier = 0; tier <= 20; tier++) {
            const difficulty = 100 + tier * 10;
            const sr = this._computeSR(activityHrid, difficulty);

            if (sr <= 0) continue;

            const targetWorkValue = isEnhancing
                ? baseStats.targetWorkValue
                : BASE_TARGET_WORK + tier * TARGET_WORK_PER_TIER;

            const stats = {
                ...baseStats,
                tier,
                successRate: sr,
                targetWorkValue,
            };

            const timeToCompleteMs = this.calculateTimeToComplete(stats);
            const tokenReward = activityHrid.includes('combat') ? 200 : 100;
            const tokensPerHour = timeToCompleteMs > 0 && isFinite(timeToCompleteMs)
                ? (3600_000 / timeToCompleteMs) * tokenReward
                : 0;

            tiers.push({
                tier,
                difficultyLevel: difficulty,
                successRate: sr,
                targetWorkValue,
                completionChance: this.calculateSessionCompletionChance(stats),
                timeToCompleteMs,
                tokensPerHour,
            });
        }

        return { tiers, loadoutName: baseStats.loadoutName };
    }

    _getSkillLevel(activityHrid) {
        const skillHrid = ACTIVITY_TO_SKILL[activityHrid];
        if (!skillHrid) return null;
        const skills = dataManager.getSkills();
        if (!skills) return null;
        const skill = skills.find((s) => s.skillHrid === skillHrid);
        return skill?.level || null;
    }

    _listeners = new Set();

    onUpdate(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    _notifyListeners() {
        for (const cb of this._listeners) {
            try {
                cb();
            } catch (error) {
                console.error('[GuildActivityTracker] Listener error:', error);
            }
        }
    }
}

const guildActivityTracker = new GuildActivityTracker();

export default {
    name: 'Guild Activity Calculator',
    initialize: () => guildActivityTracker.initialize(),
    cleanup: () => guildActivityTracker.disable(),
};

export { guildActivityTracker };
