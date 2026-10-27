/**
 * Dungeon Key Runway
 *
 * Estimates how long the player's entry keys will last at their recent clear pace. A key is only
 * spent when a run is cleared (the chest is the cost), so failed and canceled attempts are not
 * counted and only successful clears feed the average.
 */

import dataManager from '../../core/data-manager.js';
import { calculateExpectedDrops } from '../combat-sim/combat-sim-adapter.js';
import combatStatsDataCollector from '../combat-stats/combat-stats-data-collector.js';
import { isRefinementChest } from '../../utils/dungeon-chest-luck.js';
import { DUNGEON_CHEST_ENTRY_KEYS } from '../../utils/dungeon-keys.js';

/** Number of most recent clears averaged for the estimate. */
export const KEY_RUNWAY_WINDOW = 20;

/** Fewest clears needed before an estimate is shown. */
export const KEY_RUNWAY_MIN_SAMPLES = 3;

/**
 * @param {Array<{timestamp: string|number, duration?: number, totalTime?: number}>} clears -
 *   Successful runs for one dungeon/team (durations in milliseconds), in any order
 * @param {number} keys - Entry keys currently held
 * @param {number} [keysPerClear=1] - Entry keys one clear spends: one per regular chest it pays
 * @returns {{seconds: number, sampleSize: number}|null} Estimated seconds until the keys run
 *   out, or null when there are no keys or too few clears to estimate
 */
export function estimateKeyRunway(clears, keys, keysPerClear = 1) {
    if (!(keys > 0)) return null;
    if (!(keysPerClear > 0)) return null;

    const durations = [...clears]
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
        .slice(0, KEY_RUNWAY_WINDOW)
        .map((run) => run.duration || run.totalTime || 0)
        .filter((duration) => duration > 0);

    if (durations.length < KEY_RUNWAY_MIN_SAMPLES) return null;

    const averageMs = durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
    return { seconds: ((averageMs / 1000) * keys) / keysPerClear, sampleSize: durations.length };
}

/**
 * Entry keys one clear spends. A key is consumed per regular chest received, and a
 * solo player is paid several shares of the chest, so a party of one runs through
 * several keys per clear where a full party spends one.
 *
 * @param {string} dungeonHrid - The dungeon action
 * @param {number|null} tier - Difficulty tier
 * @param {number} partySize - How many split the payout
 * @returns {number|null} Expected keys per clear, or null when the reward table is not loaded
 */
export function entryKeysPerClear(dungeonHrid, tier, partySize) {
    try {
        const actionDetailMap = dataManager.getInitClientData?.()?.actionDetailMap || {};
        if (!Array.isArray(actionDetailMap[dungeonHrid]?.combatZoneInfo?.dungeonInfo?.rewardDropTable)) return null;

        const me = combatStatsDataCollector.getLatestData?.()?.players?.find((player) => player?.isCurrentPlayer);
        const quantity = Number(me?.combatStats?.combatDropQuantity);
        const rewards = calculateExpectedDrops(
            {
                isDungeon: true,
                dungeonsCompleted: 1,
                zoneName: dungeonHrid,
                numberOfPlayers: partySize > 0 ? partySize : 1,
                difficultyTier: tier || 0,
                dropRateMultiplier: { player1: 1 },
                rareFindMultiplier: { player1: 1 },
                combatDropQuantity: { player1: Number.isFinite(quantity) ? quantity : 0 },
                debuffOnLevelGap: { player1: 0 },
                deaths: {},
            },
            { actionDetailMap, combatMonsterDetailMap: {} },
            'player1'
        );

        let keys = 0;
        for (const [itemHrid, count] of rewards || []) {
            if (DUNGEON_CHEST_ENTRY_KEYS[itemHrid] && !isRefinementChest(itemHrid) && count > 0) keys += count;
        }
        return keys > 0 ? keys : null;
    } catch (error) {
        console.error('[DungeonKeyRunway] Reading the chests a clear pays failed:', error);
        return null;
    }
}
