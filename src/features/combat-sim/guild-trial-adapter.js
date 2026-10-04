import dataManager from '../../core/data-manager.js';
import { buildGameDataPayload } from './combat-sim-adapter.js';

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
        for (const buff of detail.actionBuffs || []) {
            if (buff?.usableInActionTypeMap?.['/action_types/combat'] !== true) continue;
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
export function memberFromSkillingReading(data, name = 'Current character') {
    const values = ['tier', 'successRate', 'progressPerAction', 'actionTimeMs', 'doubleProgressChance'];
    if (!values.every((key) => Number.isFinite(Number(data?.[key])))) return null;
    if (!(data.tier >= 1 && data.tier <= 21 && data.actionTimeMs > 0 && data.progressPerAction >= 0)) return null;
    return {
        name,
        referenceTier: Number(data.tier),
        successRate: Number(data.successRate),
        successLossPerTier: 0.08,
        workPower: Number(data.progressPerAction),
        actionSeconds: Number(data.actionTimeMs) / 1000,
        doubleChance: Number(data.doubleProgressChance),
        source: `Trial reading at tier ${data.tier}`,
    };
}

/** Recover base work from a server reading that includes the full signed-up roster. */
export function baseWorkFromSkillingReading(data) {
    if (!Array.isArray(data?.participantIds) || !data.participantIds.length) return null;
    const tier = Number(data.tier);
    const target = Number(data.targetWorkValue);
    if (!(tier >= 1 && tier <= 21 && Number.isInteger(tier) && target > 0 && Number.isFinite(target))) return null;
    return target / ((1 + 0.1 * (tier - 1)) * (1 + 0.01 * data.participantIds.length));
}
