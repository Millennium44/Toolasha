import dataManager from '../../core/data-manager.js';
import { buildGameDataPayload } from './combat-sim-adapter.js';
import { anchorSkillingSuccessCurve, fitSkillingSuccessCurve } from './guild-trial-model.js';

/** The trial worker uses the same game maps, plus the game's encounter rosters. */
export function buildTrialGameData() {
    const data = buildGameDataPayload();
    return data ? { ...data, guildTrialDetailMap: dataManager.getInitClientData()?.guildTrialDetailMap } : null;
}

/** Resolve explicitly combat-scoped trial-building buffs, using their actual levels. */
export function trialBuildingBuffs(clientData, levels) {
    const buffs = [];
    for (const [hrid, detail] of Object.entries(clientData?.guildBuildingDetailMap || {})) {
        const level = Number(levels?.[hrid]);
        if (!(level > 0)) continue;
        // Shrine purchases are already carried by each player DTO. Non-trial
        // buildings supply points, capacity or guild XP, rather than combat buffs.
        for (const buff of detail.buffs || []) {
            if (clientData.buffTypeDetailMap?.[buff?.typeHrid]?.isCombat !== true) continue;
            buffs.push({
                ...buff,
                uniqueHrid: `${hrid}:${buff.typeHrid}`,
                flatBoost: (Number(buff.flatBoost) || 0) + (level - 1) * (Number(buff.flatBoostLevelBonus) || 0),
                ratioBoost: (Number(buff.ratioBoost) || 0) + (level - 1) * (Number(buff.ratioBoostLevelBonus) || 0),
                flatBoostLevelBonus: 0,
                ratioBoostLevelBonus: 0,
            });
        }
    }
    return buffs;
}

/** Normalize one real personal trial footer, never inventing other members' stats. */
export function memberFromSkillingReading(data, name = 'Current character', readings = []) {
    const values = ['tier', 'successRate', 'progressPerAction', 'actionTimeMs', 'doubleProgressChance'];
    if (!values.every((key) => typeof data?.[key] === 'number' && Number.isFinite(data[key]))) return null;
    if (
        !Number.isInteger(data.tier) ||
        data.tier < 1 ||
        data.tier > 21 ||
        data.successRate < 0.05 ||
        data.successRate > 1 ||
        data.progressPerAction < 0 ||
        data.progressPerAction > 1e7 ||
        data.actionTimeMs < 100 ||
        data.actionTimeMs > 3_600_000 ||
        data.doubleProgressChance < 0 ||
        data.doubleProgressChance > 1
    )
        return null;
    // Two uncapped readings either side of the bend fix level and bonus; otherwise
    // anchor the game curve on this reading rather than a flat 8-point decline.
    const fitted = fitSkillingSuccessCurve(readings);
    const curve = fitted || anchorSkillingSuccessCurve(data);
    const how = fitted
        ? 'success curve fitted to readings'
        : curve?.successLowerBound
          ? 'capped 100% success: least effective level consistent with it (lower bound)'
          : 'success curve anchored on this reading, assuming no success bonus';
    return {
        name,
        referenceTier: data.tier,
        successRate: data.successRate,
        successLossPerTier: 0.08,
        workPower: data.progressPerAction,
        actionSeconds: data.actionTimeMs / 1000,
        doubleChance: data.doubleProgressChance,
        source: `Trial reading at tier ${data.tier}${curve ? ` · ${how}` : ''}`,
        ...curve,
    };
}

/** Recover base work from a server reading that includes the full signed-up roster. */
export function baseWorkFromSkillingReading(data) {
    const participantIds = data?.participantIds;
    if (!Array.isArray(participantIds) || !participantIds.length) return null;
    if (
        !participantIds.every((id) => typeof id === 'number' && Number.isSafeInteger(id) && id > 0) ||
        new Set(participantIds).size !== participantIds.length
    )
        return null;
    const { tier, targetWorkValue: target } = data;
    if (
        !Number.isInteger(tier) ||
        tier < 1 ||
        tier > 21 ||
        typeof target !== 'number' ||
        !Number.isFinite(target) ||
        target <= 0
    )
        return null;
    const baseWork = target / ((1 + 0.1 * (tier - 1)) * (1 + 0.01 * participantIds.length));
    return baseWork >= 1 && baseWork <= 1e9 ? baseWork : null;
}
