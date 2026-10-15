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
    MAX_CONDITION_SIMS,
    applyTriggerRows,
    buildConditionCandidates,
    conditionSlots,
    estimateConditionSimsPerFight,
    runConditionSearch,
} from './lab-condition-search.js';
import {
    PRECISIONS,
    DEFAULT_PRECISION,
    DEFAULT_OBJECTIVE,
    OBJECTIVES,
    ROUND_GROWTH,
    applyTriggerValues,
    collectTunables,
    estimateTriggerSims,
    mean,
    objectiveScore,
    profitValuation,
    runTriggerSearch,
    scopeMetrics,
    zoneMaxEnemies,
    zoneEnemyHp,
    MIN_GAIN,
} from './trigger-tuning.js';
import { getItemPrice } from '../../utils/market-data.js';

/** Ceiling on simultaneous sims, whatever the thread setting says (matches the upgrade advisor) */
const MAX_CONCURRENCY = 6;

/** Seeds one stream can hold; stream N's seeds are indices N * this + k */
export const STREAM_WIDTH = 64;

/**
 * How many sims may be in flight at once.
 * @returns {number}
 */
export function concurrency() {
    const budget = getMaxWorkers();
    if (config.getSetting('combatSim_uncapThreads')) return Math.max(1, budget);
    return Math.max(1, Math.min(budget, MAX_CONCURRENCY));
}

/**
 * A counting semaphore over async tasks.
 * @param {number} limit - Tasks at once
 * @returns {Function} `(task) => Promise` that runs the task when a slot is free
 */
export function createLimiter(limit) {
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
 * @param {Object} [options]
 * @param {Map} [options.priceCache] - The run's held prices (see `calculateSimRevenue`)
 * @returns {{perPlayer: Object, encounters: number, pools: Object}} perPlayer: hrid →
 *   `{ xp, profit, revenue, cost, unpriced, profitFailed, deaths, dps }`, rates per hour (dps per
 *   second); `unpriced` names the drops, consumables and keys nothing priced, `profitFailed` a
 *   valuation that threw
 */
export function sampleFromResult(simResult, gameData, hrids, fallbackHours, { priceCache } = {}) {
    const simHours = (simResult.simulatedTime || 0) / (3600 * 1e9) || fallbackHours;
    const perPlayer = {};
    const pools = {};
    for (const hrid of hrids) {
        const xp = Object.values(simResult.experienceGained?.[hrid] || {}).reduce((s, v) => s + v, 0);
        let profit = 0;
        let revenue = 0;
        let cost = 0;
        let unpriced = [];
        // A valuation that threw is unknown, not zero: the search leaves profit out of any comparison it is in
        let profitFailed = false;
        try {
            const value = calculateSimRevenue(simResult, gameData, hrid, simHours, { priceCache });
            profit = value?.netPerHour || 0;
            // Gross loot value and spend set the scale a profit change is judged against (profitScale)
            revenue = value?.revenuePerHour || 0;
            cost = value?.costPerHour || 0;
            // Counted at zero in the totals, so a profit built on any of them is a guess
            unpriced = [
                ...(value?.unpricedDrops || []),
                ...(value?.unpricedConsumables || []),
                ...(value?.unpricedKeys || []),
            ];
        } catch (error) {
            console.error('[TriggerOptimizer] Profit read failed:', error);
            profitFailed = true;
        }
        perPlayer[hrid] = {
            xp: xp / simHours,
            profit,
            revenue,
            cost,
            unpriced,
            profitFailed,
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
export function triggerUseFromResult(simResult, hrids) {
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
 * Every monster a zone or dungeon can spawn, from its spawn tables.
 * @param {Object} gameData - Game data payload
 * @param {string} zoneHrid - Zone action hrid
 * @returns {Array<string>} Monster hrids, each once
 */
export function zoneMonsterHrids(gameData, zoneHrid) {
    const info = gameData?.actionDetailMap?.[zoneHrid]?.combatZoneInfo;
    const hrids = new Set();
    const add = (spawn) => {
        if (spawn?.combatMonsterHrid) hrids.add(spawn.combatMonsterHrid);
    };
    for (const spawn of info?.fightInfo?.randomSpawnInfo?.spawns || []) add(spawn);
    for (const spawn of info?.fightInfo?.bossSpawns || []) add(spawn);
    for (const table of Object.values(info?.dungeonInfo?.randomSpawnInfoMap || {})) {
        for (const spawn of table?.spawns || []) add(spawn);
    }
    for (const wave of Object.values(info?.dungeonInfo?.fixedSpawnsMap || {})) {
        for (const spawn of wave || []) add(spawn);
    }
    return [...hrids];
}

/**
 * The condition search's cost before it runs: slots, single conditions per slot, and the most sims it
 * can run (its own ceiling, capped at `maxConditionSims`). Only the selected player's slots are searched.
 * @param {Object} params
 * @param {Object} params.gameData - Game data payload
 * @param {Object} params.dto - The selected player's DTO
 * @param {string} params.zoneHrid - Zone
 * @param {string} [params.include] - 'both', 'abilities' or 'consumables'
 * @param {string} [params.precision] - A PRECISIONS key
 * @param {number} [params.maxConditionSims] - Ceiling on the run's condition sims
 * @returns {{slots: number, counts: Array<number>, sims: number}}
 */
export function estimateConditionRun({
    gameData,
    dto,
    zoneHrid,
    include = 'both',
    precision = DEFAULT_PRECISION,
    maxConditionSims = MAX_CONDITION_SIMS,
}) {
    const p = PRECISIONS[precision] || PRECISIONS[DEFAULT_PRECISION];
    const monsterHrids = zoneMonsterHrids(gameData, zoneHrid);
    const counts = conditionSlots(dto, gameData, include).map(
        (slot) =>
            buildConditionCandidates({
                slot,
                dto,
                gameData,
                monsterHrids,
                // The pools are not known before the run; any positive figure yields the same number of rows
                pools: { hp: 1000, mp: 1000 },
                enemyHp: 1000,
            }).length
    );
    // The scoring baseline adds one batch of seeds
    const sims = counts.length > 0 ? estimateConditionSimsPerFight(counts, p) + p.seeds : 0;
    return { slots: counts.length, counts, sims: Math.min(maxConditionSims, sims) };
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
 * @param {string} [params.objective] - 'balanced' (default), 'xp' or 'profit': what the score measures
 * @param {boolean} [params.searchConditions] - Also search new trigger conditions (slow, opt-in): after the
 *   threshold tuner, for the selected player's abilities and consumables (per `include`)
 * @param {number} [params.maxConditionSims] - Ceiling on the condition search's sims for the run
 * @param {Function} [onProgress] - Called with `{ current, total, description }`
 * @param {Object} [options] - `{ abortSignal: () => boolean }`
 * @returns {Promise<Object|null>} The search result plus `scope`, `precision`, `simCount`, `tunableCount`;
 *   `noTunables: true` when nothing qualifies; null when stopped before the baseline finished. With
 *   `searchConditions`, also `conditions` (`runConditionSearch`'s result less its samples, plus `slotCount`,
 *   `afterThresholds`, and `skipped` when it could not run) and `conditionSimCount`
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
        objective: objectiveKey = DEFAULT_OBJECTIVE,
        searchConditions = false,
        maxConditionSims = MAX_CONDITION_SIMS,
    } = params;
    const objective = OBJECTIVES.some((o) => o.key === objectiveKey) ? objectiveKey : DEFAULT_OBJECTIVE;
    const { abortSignal } = options;
    const precision = PRECISIONS[precisionKey] || PRECISIONS[DEFAULT_PRECISION];
    const wholeParty = scope === 'party' && playerDTOs.length > 1;

    const playerIndices = wholeParty ? playerDTOs.map((_, i) => i) : [playerIndex];
    const tunables = collectTunables({ playerDTOs, playerIndices, gameData, playerNames, include });
    const conditionEstimate = searchConditions
        ? estimateConditionRun({
              gameData,
              dto: playerDTOs[playerIndex],
              zoneHrid,
              include,
              precision: precisionKey,
              maxConditionSims,
          })
        : { slots: 0, counts: [], sims: 0 };
    if (tunables.length === 0 && conditionEstimate.slots === 0) {
        return { noTunables: true, scope: wholeParty ? 'party' : 'me', include, objective, changes: [] };
    }

    const allHrids = playerDTOs.map((d) => d.hrid);
    const scopeHrids = wholeParty ? allHrids : [playerDTOs[playerIndex].hrid];
    const baseSeed = randomSeed();
    const limit = createLimiter(concurrency());
    const total = Math.max(
        1,
        (tunables.length > 0 ? estimateTriggerSims(tunables.length, precision.key) : 0) + conditionEstimate.sims
    );
    let simCount = 0;
    // Sims the condition search launched (a cache hit costs nothing); the cap is on this
    let conditionSimCount = 0;
    const cache = new Map();
    // Every price is read once and held for the whole run. Sims finish over minutes, and valuing each
    // against whatever the market said when it finished made a price update look like a trigger effect.
    const priceCache = new Map();
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
    const runBatch = (id, dtos, hours, stream, count, offset) => {
        if (cache.has(id)) return cache.get(id);

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
                    return sampleFromResult(simResult, gameData, allHrids, hours, { priceCache });
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

    const measure = (overrides, hours, stream, count, offset = 0) =>
        runBatch(
            `${signature(overrides)}|${hours}|${stream}|${count}|${offset}`,
            applyTriggerValues(playerDTOs, tunables, overrides),
            hours,
            stream,
            count,
            offset
        );

    let result;
    if (tunables.length > 0) {
        result = await runTriggerSearch({
            tunables,
            scopeHrids,
            measure,
            precision,
            maxEnemies: zoneMaxEnemies(gameData, zoneHrid),
            enemyHp: zoneEnemyHp(gameData, zoneHrid, difficultyTier, monsterMaxHpReader(gameData)),
            minGain,
            objective,
            onProgress: ({ description }) => onProgress?.({ current: Math.min(simCount, total), total, description }),
            aborted: stopped,
        });
        if (!result) return null;
    } else {
        // Nothing for the threshold tuner; only the condition search has something to do
        result = { noTunables: true, changes: [], stopped: false };
    }

    const out = {
        ...result,
        scope: wholeParty ? 'party' : 'me',
        include,
        objective,
        precision: precision.key,
        minGain,
        simCount,
        tunableCount: tunables.length,
    };
    if (!searchConditions || result.stopped || stopped()) return out;

    // Start from the thresholds the tuner kept, so the two searches' changes are one setup
    const tuned = Object.fromEntries((result.changes || []).map((c) => [c.key, c.to]));
    const startDtos = tunables.length > 0 ? applyTriggerValues(playerDTOs, tunables, tuned) : playerDTOs;
    const startDto = startDtos[playerIndex];
    // A food or drink with no market price is never searched: a new condition that makes it fire would
    // add a cost nothing can value, and the objective would judge it on XP and damage alone (the threshold
    // tuner refuses the same thing through its own-item check)
    const slots = conditionSlots(startDto, gameData, include).filter(
        (slot) =>
            slot.slotType === 'abilities' || getItemPrice(slot.itemHrid, { context: 'profit', side: 'buy' }) != null
    );
    const hoursPerSeed = precision.pointHours / precision.seeds;
    const confirmHours = hoursPerSeed * ROUND_GROWTH * ROUND_GROWTH;
    const hoursFor = { screen: hoursPerSeed, pair: hoursPerSeed, confirm: confirmHours, final: confirmHours };
    const tunedSignature = signature(tuned);

    /** One paired-seed batch with some of the selected player's slots given new trigger rows */
    const conditionBatch = (edits, hours, stream, count, offset = 0) => {
        const editsKey = JSON.stringify(
            Object.keys(edits)
                .sort()
                .map((k) => [k, edits[k]])
        );
        const id = `cond|${editsKey}|${tunedSignature}|${hours}|${stream}|${count}|${offset}`;
        if (!cache.has(id)) conditionSimCount += count;
        const dtos = startDtos.map((dto, i) => (i === playerIndex ? applyTriggerRows(startDto, edits) : dto));
        return runBatch(id, dtos, hours, stream, count, offset);
    };

    let conditions;
    // The score is the objective's change against the starting setup, so that setup is measured first, on
    // its own seeds; both sides of every paired comparison are scored the same way
    // (a cap smaller than that one batch leaves no room for any search, so it is not run)
    const canMeasure = slots.length > 0 && maxConditionSims >= precision.seeds;
    const baseline = canMeasure
        ? await conditionBatch({}, hoursPerSeed * ROUND_GROWTH, 'cbaseline', precision.seeds)
        : null;
    if (slots.length === 0 || !canMeasure) {
        conditions = {
            changes: [],
            rejected: [],
            bestMeasured: [],
            skipped: slots.length === 0 ? 'no-slots' : 'cap',
        };
    } else if (!baseline || stopped()) {
        conditions = { changes: [], rejected: [], bestMeasured: [], stopped: true };
    } else {
        const baseMetrics = baseline.map((sample) => scopeMetrics(sample, scopeHrids));
        const baseScope = {};
        for (const key of ['xp', 'profit', 'revenue', 'cost', 'deaths', 'dps', 'encounters', 'attempts']) {
            baseScope[key] = mean(baseMetrics.map((m) => m[key]));
        }
        const baseComplete = profitValuation([baseline], scopeHrids).complete;
        if (objective === 'profit' && !baseComplete) {
            // Profit/h with a baseline that cannot be valued has nothing to optimize
            conditions = { changes: [], rejected: [], bestMeasured: [], skipped: 'profit' };
        } else {
            // One rule per comparison: profit counts only when the baseline and BOTH sides valued completely,
            // as the threshold search's scoreSets does, so a candidate is never judged on a different objective
            // from its reference
            const scoreSets = (sets) => {
                const withProfit = baseComplete && profitValuation(sets, scopeHrids).complete;
                return sets.map((set) =>
                    set.map((s) => objectiveScore(scopeMetrics(s, scopeHrids), baseScope, objective, { withProfit }))
                );
            };
            const monsterHrids = zoneMonsterHrids(gameData, zoneHrid);
            const hpOf = monsterMaxHpReader(gameData);
            // Tier-aware: each spawn's own tier offset plus the selected tier, as the threshold search reads it
            const enemyHp = zoneEnemyHp(gameData, zoneHrid, difficultyTier, hpOf)?.single || 0;
            const search = await runConditionSearch({
                slots,
                candidatesFor: (slot, referenceSamples) =>
                    buildConditionCandidates({
                        slot,
                        dto: startDto,
                        gameData,
                        monsterHrids,
                        pools: referenceSamples?.find((s) => s?.pools?.[startDto.hrid])?.pools?.[startDto.hrid],
                        enemyHp,
                    }),
                measure: (edits, { stream, count, offset = 0, stage }) =>
                    conditionBatch(edits, hoursFor[stage] || confirmHours, stream, count, offset),
                precision,
                minGain,
                scoreSets,
                aborted: stopped,
                // Seed runs, as `conditionBatch` counts them (cache hits would cost nothing, so this errs toward
                // stopping)
                overBudget: (seedRuns = 0) => conditionSimCount + seedRuns > maxConditionSims,
                onProgress: ({ description }) =>
                    onProgress?.({ current: Math.min(simCount, total), total, description }),
            });
            // The samples are only for scoring; the result keeps the figures
            const { finalSamples: _samples, ...rest } = search;
            conditions = rest;
        }
    }
    return {
        ...out,
        stopped: out.stopped || stopped(),
        simCount,
        conditionSimCount,
        conditions: { ...conditions, slotCount: slots.length, afterThresholds: Object.keys(tuned).length > 0 },
    };
}
