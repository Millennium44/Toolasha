/**
 * Trigger Optimizer: runs the trigger search against the combat simulator.
 *
 * The search itself, the grids and the acceptance rule live in
 * `trigger-tuning.js` and are tested there with fake measurements. This file is
 * the thin layer that turns "measure this set of trigger values for this many
 * hours" into paired-seed combat sims, several at a time.
 *
 * Every sim in a comparison shares its seeds, so a difference between two
 * threshold values reflects the threshold rather than luck; the error bar on a
 * difference comes from the spread of that difference across seeds.
 *
 * It only ever simulates. It never changes a trigger in the game.
 */

import config from '../../core/config.js';
import { calculateSimRevenue } from './combat-sim-adapter.js';
import { runSimulation, getMaxWorkers } from './combat-sim-runner.js';
import { TASK_DAMAGE_OFF } from './engine/task-damage-mode.js';
import { deriveSeed, randomSeed } from './engine/rng.js';
import {
    PRECISIONS,
    DEFAULT_PRECISION,
    applyTriggerValues,
    collectTunables,
    estimateTriggerSims,
    runTriggerSearch,
} from './trigger-tuning.js';

/** Ceiling on simultaneous sims, whatever the thread setting says (matches the upgrade advisor) */
const MAX_CONCURRENCY = 6;

/** Offset that keeps the final head-to-head's seeds apart from the search's */
const FINAL_SEED_OFFSET = 5000;

/**
 * How many sims may be in flight at once.
 * @returns {number}
 */
function concurrency() {
    const budget = getMaxWorkers();
    if (config.getSetting('combatSim_uncapThreads')) return Math.max(1, budget);
    return Math.max(1, Math.min(budget, MAX_CONCURRENCY));
}

/**
 * A counting semaphore over async tasks.
 * @param {number} limit - Tasks at once
 * @returns {Function} `(task) => Promise` that runs the task when a slot is free
 */
function createLimiter(limit) {
    let running = 0;
    const waiting = [];
    const release = () => {
        running--;
        const next = waiting.shift();
        if (next) next();
    };
    return async (task) => {
        if (running >= limit) await new Promise((resolve) => waiting.push(resolve));
        running++;
        try {
            return await task();
        } finally {
            release();
        }
    };
}

/**
 * Reduce one sim result to the figures the objective reads, per player.
 * @param {Object} simResult - Merged SimResult
 * @param {Object} gameData - Game data payload
 * @param {Array<string>} hrids - Every player in the sim
 * @param {number} fallbackHours - Hours asked for, when the result carries no clock
 * @returns {{perPlayer: Object, encounters: number, pools: Object}}
 */
export function sampleFromResult(simResult, gameData, hrids, fallbackHours) {
    const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || fallbackHours;
    const perPlayer = {};
    const pools = {};
    for (const hrid of hrids) {
        const xp = Object.values(simResult.experienceGained?.[hrid] || {}).reduce((s, v) => s + v, 0);
        let profit = 0;
        try {
            profit = calculateSimRevenue(simResult, gameData, hrid, simHours)?.netPerHour || 0;
        } catch (error) {
            console.error('[TriggerOptimizer] Profit read failed:', error);
        }
        perPlayer[hrid] = {
            xp: xp / simHours,
            profit,
            deaths: (simResult.deaths?.[hrid] || 0) / simHours,
            dps: (simResult.totalDamageDealt?.[hrid] || 0) / (simHours * 3600),
        };
        const p = simResult.playerPools?.[hrid];
        if (p) pools[hrid] = { hp: p.maxHitpoints || 0, mp: p.maxManapoints || 0 };
    }
    return { perPlayer, encounters: (simResult.encounters || 0) / simHours, pools };
}

/**
 * Search for better threshold values on the chosen players' triggers.
 * @param {Object} params
 * @param {Object} params.gameData - Game data payload
 * @param {Array<Object>} params.playerDTOs - Every player in the sim
 * @param {number} params.playerIndex - The selected player
 * @param {string} params.zoneHrid - Zone
 * @param {number} params.difficultyTier - Tier
 * @param {Object} params.communityBuffs - Community buffs
 * @param {string} [params.scope] - 'me' (the selected player's triggers, judged on their figures) or
 *   'party' (everyone's triggers, judged on the party total)
 * @param {string} [params.precision] - 'quick', 'standard' or 'precise'
 * @param {Object} [params.playerNames] - hrid → display name
 * @param {Function} [onProgress] - Called with `{ current, total, description }`
 * @param {Object} [options] - `{ abortSignal: () => boolean }`
 * @returns {Promise<Object|null>} The search result plus `scope`, `precision`, `simCount`, `tunableCount`;
 *   `noTunables: true` when nothing qualifies; null when stopped before the baseline finished
 */
export async function runTriggerOptimization(params, onProgress, options = {}) {
    const {
        gameData,
        playerDTOs,
        playerIndex,
        zoneHrid,
        difficultyTier,
        communityBuffs,
        scope = 'me',
        precision: precisionKey = DEFAULT_PRECISION,
        playerNames = {},
    } = params;
    const { abortSignal } = options;
    const precision = PRECISIONS[precisionKey] || PRECISIONS[DEFAULT_PRECISION];
    const wholeParty = scope === 'party' && playerDTOs.length > 1;

    const playerIndices = wholeParty ? playerDTOs.map((_, i) => i) : [playerIndex];
    const tunables = collectTunables({ playerDTOs, playerIndices, gameData, playerNames });
    if (tunables.length === 0) return { noTunables: true, scope: wholeParty ? 'party' : 'me', changes: [] };

    const allHrids = playerDTOs.map((d) => d.hrid);
    const scopeHrids = wholeParty ? allHrids : [playerDTOs[playerIndex].hrid];
    const baseSeed = randomSeed();
    const limit = createLimiter(concurrency());
    const total = estimateTriggerSims(tunables.length, precision.key);
    let simCount = 0;
    const cache = new Map();

    const signature = (overrides) =>
        JSON.stringify(
            tunables
                .filter((t) => overrides[t.key] !== undefined && overrides[t.key] !== t.original)
                .map((t) => [t.key, overrides[t.key]])
        );

    /**
     * One paired-seed batch: the same threshold values on every seed.
     * @param {Object} overrides - tunable key → value
     * @param {number} hours - Hours per seed
     * @param {string} seedSet - 'search' or 'final'
     * @returns {Promise<Array<Object>|null>} One sample per seed; null once stopped
     */
    const measure = (overrides, hours, seedSet) => {
        const id = `${signature(overrides)}|${hours}|${seedSet}`;
        if (cache.has(id)) return cache.get(id);

        const dtos = applyTriggerValues(playerDTOs, tunables, overrides);
        const offset = seedSet === 'final' ? FINAL_SEED_OFFSET : 0;
        const runs = Array.from({ length: precision.seeds }, (_, k) =>
            limit(async () => {
                if (abortSignal?.()) return null;
                try {
                    const simResult = await runSimulation(
                        {
                            gameData,
                            playerDTOs: dtos,
                            zoneHrid,
                            difficultyTier,
                            hours,
                            communityBuffs,
                            seed: deriveSeed(baseSeed, offset + k),
                            taskDamageMode: TASK_DAMAGE_OFF,
                        },
                        null,
                        // One worker each: the limiter is what keeps the cores busy, and a
                        // preempting run would cancel its neighbors
                        { preempt: false, workers: 1 }
                    );
                    simCount++;
                    onProgress?.({ current: Math.min(simCount, total), total });
                    return sampleFromResult(simResult, gameData, allHrids, hours);
                } catch (error) {
                    // A stopped run cancels the sims in flight; that is not a failure
                    if (abortSignal?.()) return null;
                    throw error;
                }
            })
        );
        const batch = (async () => {
            const samples = await Promise.all(runs);
            return samples.some((s) => !s) ? null : samples;
        })();
        cache.set(id, batch);
        return batch;
    };

    const result = await runTriggerSearch({
        tunables,
        scopeHrids,
        measure,
        precision,
        onProgress: ({ description }) => onProgress?.({ current: Math.min(simCount, total), total, description }),
        aborted: abortSignal,
    });
    if (!result) return null;

    return {
        ...result,
        scope: wholeParty ? 'party' : 'me',
        precision: precision.key,
        simCount,
        tunableCount: tunables.length,
    };
}
