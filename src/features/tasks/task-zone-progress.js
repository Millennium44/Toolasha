/**
 * Per-Zone Combat Task Progress
 *
 * Groups every active combat task by the zone it is fought in and, per zone, works out the
 * fights and time needed to clear everything there, using the same bottleneck math as the
 * per-task "zone mode" estimate (task-zone-bottleneck.js).
 *
 * One combat sim runs per zone, one after another with a yield to the browser in between,
 * so a long list of zones never freezes the page and a closed popup can stop the rest. The
 * sims use the same settings as the task cards (the zone's last-used tier, per-monster task
 * damage) so a zone row agrees with the figure on its task cards.
 */

import dataManager from '../../core/data-manager.js';
import { buildAllPlayerDTOs, buildGameDataPayload, getCommunityBuffs } from '../combat-sim/combat-sim-adapter.js';
import { runSimulation } from '../combat-sim/combat-sim-runner.js';
import { TASK_DAMAGE_PER_MONSTER } from '../combat-sim/engine/task-damage-mode.js';
import { lastUsedTierForZone } from '../../utils/combat-actions.js';
import { characterIdentityChanged } from '../../utils/combat-zone-open.js';
import { computeZoneBottleneck, ZONE_SIM_HOURS } from './task-zone-bottleneck.js';

/**
 * Active combat tasks, grouped zone -> monster. Tasks and monsters are keyed by hrid; duplicate
 * tasks for one monster sum, because each kill progresses only one task at a time.
 * @param {Object} actionDetailMap - Game action details (used to skip dungeons)
 * @returns {Map<string, Map<string, {hrid: string, remaining: number, taskCount: number}>>}
 */
export function groupCombatTasksByZone(actionDetailMap) {
    const byZone = new Map();
    for (const quest of dataManager.characterQuests || []) {
        if (quest.category !== '/quest_category/random_task') continue;
        if (quest.status !== '/quest_status/in_progress' || !quest.monsterHrid) continue;

        const zoneHrid = dataManager.getCombatZoneForMonster(quest.monsterHrid);
        if (!zoneHrid || actionDetailMap?.[zoneHrid]?.combatZoneInfo?.isDungeon) continue;

        const remaining = Math.max((quest.goalCount ?? 0) - (quest.currentCount ?? 0), 0);
        if (!byZone.has(zoneHrid)) byZone.set(zoneHrid, new Map());
        const monsters = byZone.get(zoneHrid);
        const entry = monsters.get(quest.monsterHrid) || { hrid: quest.monsterHrid, remaining: 0, taskCount: 0 };
        entry.remaining += remaining;
        entry.taskCount += 1;
        monsters.set(quest.monsterHrid, entry);
    }
    return byZone;
}

/**
 * Soonest-to-clear zone first; zones that can never be cleared sort last.
 * @param {Array<{hoursNeeded: number}>} rows
 * @returns {Array<Object>} A sorted copy
 */
function sortRows(rows) {
    return [...rows].sort((a, b) => {
        if (a.hoursNeeded === b.hoursNeeded) return 0;
        return a.hoursNeeded < b.hoursNeeded ? -1 : 1;
    });
}

/**
 * @param {Object} [options]
 * @param {() => boolean} [options.isCancelled] - Polled between steps; true stops the run
 * @param {(rows: Array<Object>) => void} [options.onProgress] - Called with the rows so far
 *   (sorted) after each zone finishes
 * @returns {Promise<Array<{zoneHrid: string, zoneName: string, tier: number, hoursNeeded: number,
 *   fightsNeeded: number, bottleneckHrid: string, bottleneckName: string, taskCount: number}>|null>}
 *   Sorted ascending by hoursNeeded; empty when there are no combat tasks (no sim runs). Null when
 *   cancelled or the character changed mid-run: nothing in it belongs to anyone on screen.
 */
export async function computeAllZoneProgress({ isCancelled = () => false, onProgress } = {}) {
    // Identity is captured before the first await and checked after every one
    const characterId = dataManager.getCurrentCharacterId();
    const stale = () => isCancelled() || characterIdentityChanged(characterId);

    const gameData = buildGameDataPayload();
    if (!gameData) return [];

    const byZone = groupCombatTasksByZone(gameData.actionDetailMap);
    if (byZone.size === 0) return [];

    const { players } = await buildAllPlayerDTOs();
    if (stale()) return null;
    if (!players.length) return [];

    const communityBuffs = getCommunityBuffs();
    const monsterDetailMap = gameData.combatMonsterDetailMap || {};
    const rows = [];

    for (const [zoneHrid, monsters] of byZone) {
        const tier = lastUsedTierForZone(dataManager.getCurrentActions?.() || [], zoneHrid) ?? 0;

        let simResult;
        try {
            // preempt: false, so this does not kill a task card's sim that is running at the same time
            simResult = await runSimulation(
                {
                    gameData,
                    playerDTOs: players,
                    zoneHrid,
                    difficultyTier: tier,
                    hours: ZONE_SIM_HOURS,
                    communityBuffs,
                    taskDamageMode: TASK_DAMAGE_PER_MONSTER,
                },
                undefined,
                { preempt: false }
            );
        } catch (error) {
            if (stale()) return null;
            console.error('[TaskZoneProgress] Zone sim failed:', zoneHrid, error);
            continue;
        }
        if (stale()) return null;

        const entries = [...monsters.values()].map((m) => ({
            ...m,
            name: monsterDetailMap[m.hrid]?.name || m.hrid.split('/').pop(),
        }));
        const bottleneck = computeZoneBottleneck(entries, simResult);
        if (bottleneck) {
            rows.push({
                zoneHrid,
                zoneName: gameData.actionDetailMap?.[zoneHrid]?.name || zoneHrid.split('/').pop(),
                tier,
                hoursNeeded: bottleneck.hoursNeeded,
                fightsNeeded: bottleneck.fightsNeeded,
                bottleneckHrid: bottleneck.bottleneckHrid,
                bottleneckName: bottleneck.bottleneckName,
                taskCount: bottleneck.bottleneckTaskCount,
            });
            onProgress?.(sortRows(rows));
        }

        // Hand the thread back before the next zone's sim is set up
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (stale()) return null;
    }

    return sortRows(rows);
}
