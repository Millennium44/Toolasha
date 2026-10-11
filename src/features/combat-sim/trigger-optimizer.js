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
import { getGameData, setGameData } from './engine/game-data.js';
import Monster from './engine/monster.js';
import { TASK_DAMAGE_OFF } from './engine/task-damage-mode.js';
import { deriveSeed, randomSeed } from './engine/rng.js';
import {
    PRECISIONS,
    DEFAULT_PRECISION,
    applyTriggerValues,
    collectTunables,
    estimateTriggerSims,
    runTriggerSearch,
    zoneMaxEnemies,
    zoneEnemyHp,
    MIN_GAIN,
} from './trigger-tuning.js';

/** Ceiling on simultaneous sims, whatever the thread setting says (matches the upgrade advisor) */
const MAX_CONCURRENCY = 6;

/** Seeds one stream can hold; stream N's seeds are indices N * this + k */
const STREAM_WIDTH = 64;

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
 * A reader of monster max HP at a tier, computed the way the sim builds its
 * monsters (`Monster.updateCombatDetails`, the engine's tier scaling). The engine
 * reads game data from a module singleton; it is pointed at this payload only
 * for the duration of each read and put back after.
 * @param {Object} gameData - Game data payload
 * @returns {Function} (monsterHrid, tier) => max HP, 0 when it cannot be built
 */
export function monsterMaxHpReader(gameData) {
    return (hrid, tier) => {
        if (!gameData?.combatMonsterDetailMap?.[hrid]) return 0;
        const previous = getGameData();
        setGameData(gameData);
        try {
            const monster = new Monster(hrid, tier);
            monster.updateCombatDetails();
            return monster.combatDetails.maxHitpoints || 0;
        } catch (error) {
            console.error('[TriggerOptimizer] Monster HP read failed:', error);
            return 0;
        } finally {
            setGameData(previous);
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
    const sample = { perPlayer, encounters: (simResult.encounters || 0) / simHours, pools };
    // Left out when the engine did not record trigger reads, so nothing is ever skipped on missing data
    if (simResult.triggerChecks) sample.triggerUse = triggerUseFromResult(simResult, hrids);
    return sample;
}

/**
 * Per player, how much each ability, food and drink came into play: trigger reads plus casts and
 * uses. Casts and uses are counted on top of the reads only as a belt and braces — a slot with
 * trigger rows cannot fire without its rows being read.
 * @param {Object} simResult - Merged SimResult carrying `triggerChecks`
 * @param {Array<string>} hrids - Players
 * @returns {Object} hrid → ability/item hrid → count
 */
function triggerUseFromResult(simResult, hrids) {
    const out = {};
    for (const hrid of hrids) {
        const use = { ...(simResult.triggerChecks?.[hrid] || {}) };
        for (const [item, n] of Object.entries(simResult.consumablesUsed?.[hrid] || {})) {
            use[item] = (use[item] || 0) + (n || 0);
        }
        // An ability that was ever cast has an entry here (its mana spent, possibly 0)
        for (const ability of Object.keys(simResult.manaUsed?.[hrid] || {})) use[ability] = (use[ability] || 0) + 1;
        out[hrid] = use;
    }
    return out;
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
 * @param {number} [params.minGain] - Smallest score gain worth offering
 * @param {Object} [params.playerNames] - hrid → display name
 * @param {string} [params.include] - 'both', 'abilities' or 'consumables': which kinds of row to tune
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
        minGain = MIN_GAIN,
        playerNames = {},
        include = 'both',
    } = params;
    const { abortSignal } = options;
    const precision = PRECISIONS[precisionKey] || PRECISIONS[DEFAULT_PRECISION];
    const wholeParty = scope === 'party' && playerDTOs.length > 1;

    const playerIndices = wholeParty ? playerDTOs.map((_, i) => i) : [playerIndex];
    const tunables = collectTunables({ playerDTOs, playerIndices, gameData, playerNames, include });
    if (tunables.length === 0) {
        return { noTunables: true, scope: wholeParty ? 'party' : 'me', include, changes: [] };
    }

    const allHrids = playerDTOs.map((d) => d.hrid);
    const scopeHrids = wholeParty ? allHrids : [playerDTOs[playerIndex].hrid];
    const baseSeed = randomSeed();
    const limit = createLimiter(concurrency());
    const total = estimateTriggerSims(tunables.length, precision.key);
    let simCount = 0;
    const cache = new Map();
    // A sim that failed stops the rest: the queue would otherwise keep starting sims for a run already lost
    let failed = false;
    const stopped = () => failed || Boolean(abortSignal?.());
    // Each named stream gets its own block of seeds, so selection, confirmation and the final check never share data
    const streamIds = new Map();
    const streamId = (name) => {
        if (!streamIds.has(name)) streamIds.set(name, streamIds.size);
        return streamIds.get(name);
    };

    const signature = (overrides) =>
        JSON.stringify(
            tunables
                .filter((t) => overrides[t.key] !== undefined && overrides[t.key] !== t.original)
                .map((t) => [t.key, overrides[t.key]])
        );

    /**
     * One paired-seed batch: the same threshold values on every seed of a stream.
     * @param {Object} overrides - tunable key → value
     * @param {number} hours - Hours per seed
     * @param {string} stream - Name of the seed set
     * @param {number} count - How many seeds
     * @param {number} [offset] - Index of the first seed within the stream
     * @returns {Promise<Array<Object>|null>} One sample per seed; null once stopped
     */
    const measure = (overrides, hours, stream, count, offset = 0) => {
        const id = `${signature(overrides)}|${hours}|${stream}|${count}|${offset}`;
        if (cache.has(id)) return cache.get(id);

        const dtos = applyTriggerValues(playerDTOs, tunables, overrides);
        const base = streamId(stream) * STREAM_WIDTH;
        const runs = Array.from({ length: count }, (_, k) =>
            limit(async () => {
                if (stopped()) return null;
                try {
                    const simResult = await runSimulation(
                        {
                            gameData,
                            playerDTOs: dtos,
                            zoneHrid,
                            difficultyTier,
                            hours,
                            communityBuffs,
                            seed: deriveSeed(baseSeed, base + offset + k),
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
                    if (stopped()) return null;
                    failed = true;
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
        maxEnemies: zoneMaxEnemies(gameData, zoneHrid),
        enemyHp: zoneEnemyHp(gameData, zoneHrid, difficultyTier, monsterMaxHpReader(gameData)),
        minGain,
        onProgress: ({ description }) => onProgress?.({ current: Math.min(simCount, total), total, description }),
        aborted: stopped,
    });
    if (!result) return null;

    return {
        ...result,
        scope: wholeParty ? 'party' : 'me',
        include,
        precision: precision.key,
        minGain,
        simCount,
        tunableCount: tunables.length,
    };
}
