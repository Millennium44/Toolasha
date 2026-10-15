/**
 * Lab Sim trigger tuning: the Combat Sim's trigger search, judged on labyrinth fights.
 *
 * Triggers are saved with a loadout, and a loadout fights every labyrinth room it is assigned
 * to, so a threshold is tuned once per loadout across all of its fights. The score is the drop
 * in expected attempts to clear those fights, Σ 1/win rate — the figure the Upgrade tab's list
 * ranks on — through the search's `LAB_OBJECTIVE`. Everything else (the grids, successive
 * halving, the fresh-seed confirmation and the all-together check) is `runTriggerSearch`
 * unchanged; this file only supplies the measurement: one sample per seed, each seed running
 * every fight of the loadout with the same number of attempts, so two threshold values meet the
 * same random draws fight for fight.
 *
 * It only ever simulates. It never changes a trigger in the game.
 */

import { runLabyrinthSimulation } from './combat-sim-runner.js';
import Monster from './engine/monster.js';
import { getGameData, setGameData } from './engine/game-data.js';
import { deriveSeed, randomSeed } from './engine/rng.js';
import {
    MAX_CONDITION_SIMS,
    applyTriggerRows,
    buildConditionCandidates,
    conditionSlots,
    estimateConditionSimsPerFight,
    runConditionSearch,
} from './lab-condition-search.js';
import { STREAM_WIDTH, concurrency, createLimiter, triggerUseFromResult } from './trigger-optimizer.js';
import {
    PRECISIONS,
    DEFAULT_PRECISION,
    LAB_OBJECTIVE,
    ROUND_GROWTH,
    applyTriggerValues,
    collectTunables,
    estimateTriggerSims,
    runTriggerSearch,
} from './trigger-tuning.js';

/**
 * Smallest gain worth offering, in expected attempts across a loadout's fights: two attempts
 * saved per hundred trips through them. The 95% check on fresh seeds applies on top.
 */
export const LAB_MIN_GAIN = 0.02;

/**
 * Attempts each fight gets per hour the search asks for. The search sizes its measurements in
 * hours (Quick spends 5 per seed in its first round); a labyrinth fight is sized in attempts,
 * and a fixed count is what keeps two runs paired attempt for attempt.
 */
export const LAB_TRIALS_PER_HOUR = 10;

/** Fewest attempts any one fight is simulated for */
export const LAB_MIN_TRIALS = 20;

/** Simulated-time ceiling per attempt, generous: a labyrinth fight times out at 120 s */
const CEILING_SECONDS_PER_TRIAL = 240;

/** Win-rate floor for the expected-attempts figure, as the Upgrade tab uses (`expectedFightAttempts`) */
export const ATTEMPT_WIN_RATE_FLOOR = 0.001;

/** Group key of the fights that have no saved loadout and fight in the worn gear */
export const CURRENT_GEAR_KEY = 'current';

/** What the "current gear" group is called */
export const CURRENT_GEAR_NAME = 'Current gear';

/**
 * Attempts one fight is simulated for, for an asked-for number of hours.
 * @param {number} hours - Hours per seed, as the search asks
 * @returns {number}
 */
export function labTrials(hours) {
    return Math.max(LAB_MIN_TRIALS, Math.round((Number(hours) || 0) * LAB_TRIALS_PER_HOUR));
}

/**
 * Expected attempts to clear one fight, retrying until it is won (the Upgrade tab's rule).
 * @param {number} winRate - 0..1
 * @param {number} [floor] - Smallest win rate counted
 * @returns {number}
 */
export function expectedAttempts(winRate, floor = ATTEMPT_WIN_RATE_FLOOR) {
    return 1 / Math.max(Number(winRate) || 0, floor);
}

/**
 * Group fights by the loadout they fight in. A fight with no loadout id (0, null, or a loadout
 * the snapshot store does not hold, which `_collectLabyrinthFights` passes as 0) fights in the
 * worn gear, and those share one "current gear" group. Groups and their fights keep the order
 * the fights came in.
 * @param {Array<Object>} fights - `{ monsterHrid, monsterName, roomLevel, dto, loadoutName, loadoutId }`
 * @returns {Array<{key: string, name: string, loadoutId: number, fights: Array<Object>}>}
 */
export function groupFightsByLoadout(fights) {
    const groups = new Map();
    for (const fight of fights || []) {
        const id = Number(fight?.loadoutId) || 0;
        const key = id > 0 ? `loadout:${id}` : CURRENT_GEAR_KEY;
        if (!groups.has(key)) {
            groups.set(key, {
                key,
                name: id > 0 ? fight.loadoutName || `Loadout #${id}` : CURRENT_GEAR_NAME,
                loadoutId: id,
                fights: [],
            });
        }
        groups.get(key).fights.push(fight);
    }
    return [...groups.values()];
}

/**
 * The player DTO a group's sims run, with an hrid the sim results are keyed by.
 * @param {Object} dto - A fight's loadout DTO
 * @returns {Object}
 */
function withHrid(dto) {
    return dto?.hrid ? dto : { ...dto, hrid: 'player1' };
}

/**
 * The tunable trigger rows of a group: read from its first fight's loadout, which every fight
 * of the group shares (the same saved loadout builds the same slots).
 * @param {Object} group - From `groupFightsByLoadout`
 * @param {Object} gameData - Game data payload
 * @param {string} include - 'both', 'abilities' or 'consumables'
 * @returns {Array<Object>}
 */
export function groupTunables(group, gameData, include = 'both') {
    const dto = group?.fights?.[0]?.dto;
    if (!dto) return [];
    return collectTunables({ playerDTOs: [withHrid(dto)], playerIndices: [0], gameData, include });
}

/**
 * The single conditions the condition search would screen per slot of a group, for the estimate. The
 * pools are not known before the run; any positive figure yields the same number of rows.
 * @param {Object} group - From `groupFightsByLoadout`
 * @param {Object} gameData - Game data payload
 * @param {string} include - 'both', 'abilities' or 'consumables'
 * @returns {Array<number>} One count per searchable slot
 */
export function groupConditionCounts(group, gameData, include = 'both') {
    const dto = group?.fights?.[0]?.dto;
    if (!dto) return [];
    const monsterHrids = [...new Set(group.fights.map((f) => f.monsterHrid))];
    return conditionSlots(dto, gameData, include).map(
        (slot) =>
            buildConditionCandidates({
                slot,
                dto,
                gameData,
                monsterHrids,
                pools: { hp: 1000, mp: 1000 },
                enemyHp: 1000,
            }).length
    );
}

/**
 * What a run will cost, before it starts: the search's own sim estimate per group, times the
 * group's fights, and how many attempts each of those fight sims plays. With `searchConditions`, the
 * condition search's ceiling is counted apart (`conditionSims`), capped at `MAX_CONDITION_SIMS`.
 * @param {Object} params
 * @param {Array<Object>} params.groups - From `groupFightsByLoadout`, the ones to tune
 * @param {Object} params.gameData - Game data payload
 * @param {string} [params.include] - 'both', 'abilities' or 'consumables'
 * @param {string} [params.precision] - A PRECISIONS key
 * @param {boolean} [params.searchConditions] - Whether the condition search runs too
 * @returns {{groups: Array<{key: string, tunables: number, fights: number, sims: number, conditionSlots: number,
 *   conditionSims: number}>, sims: number, conditionSims: number, trials: {first: number, confirm: number}}}
 */
export function estimateLabTriggerRun({
    groups,
    gameData,
    include = 'both',
    precision = DEFAULT_PRECISION,
    searchConditions = false,
}) {
    const p = PRECISIONS[precision] || PRECISIONS[DEFAULT_PRECISION];
    const hoursPerSeed = p.pointHours / p.seeds;
    const perGroup = (groups || []).map((group) => {
        const tunables = groupTunables(group, gameData, include).length;
        const fights = group.fights.length;
        const counts = searchConditions ? groupConditionCounts(group, gameData, include) : [];
        return {
            key: group.key,
            tunables,
            fights,
            sims: tunables ? estimateTriggerSims(tunables, p.key) * fights : 0,
            conditionSlots: counts.length,
            conditionSims: estimateConditionSimsPerFight(counts, p) * fights,
        };
    });
    return {
        groups: perGroup,
        sims: perGroup.reduce((sum, g) => sum + g.sims, 0),
        conditionSims: Math.min(
            MAX_CONDITION_SIMS,
            perGroup.reduce((sum, g) => sum + g.conditionSims, 0)
        ),
        trials: { first: labTrials(hoursPerSeed), confirm: labTrials(hoursPerSeed * ROUND_GROWTH * ROUND_GROWTH) },
    };
}

/**
 * Max HP of a labyrinth monster at a room level, built the way the labyrinth builds it
 * (`Labyrinth.getMonster`: tier 0, the room level, the full ability kit).
 * @param {Object} gameData - Game data payload
 * @returns {Function} (monsterHrid, roomLevel) => max HP, 0 when it cannot be built
 */
export function labMonsterMaxHpReader(gameData) {
    return (hrid, roomLevel) => {
        if (!gameData?.combatMonsterDetailMap?.[hrid]) return 0;
        const previous = getGameData();
        setGameData(gameData);
        try {
            const monster = new Monster(hrid, 0, roomLevel, true);
            monster.updateCombatDetails();
            return monster.combatDetails.maxHitpoints || 0;
        } catch (error) {
            console.error('[LabTriggerOptimizer] Monster HP read failed:', error);
            return 0;
        } finally {
            setGameData(previous);
        }
    };
}

/**
 * One seed's sample for the search: the group's fights summed into the figures it reads.
 *
 * A fight won no times in its attempts reads as half a win, not as the Upgrade tab's 0.1%
 * floor: a per-seed figure of 1000 attempts would swamp every comparison it is in with one
 * unlucky seed. Both sides of a paired comparison play the same number of attempts, so they
 * meet the same floor.
 * @param {Array<Object>} simResults - One labyrinth SimResult per fight, in the group's order
 * @param {string} hrid - The player
 * @param {number} trials - Attempts each fight played
 * @returns {Object} `{ perPlayer, encounters, pools, attempts, fights, triggerUse? }`
 */
export function labSampleFromResults(simResults, hrid, trials) {
    const floor = Math.max(ATTEMPT_WIN_RATE_FLOOR, 0.5 / Math.max(1, trials));
    let attempts = 0;
    let xp = 0;
    let deaths = 0;
    let damage = 0;
    let ns = 0;
    const fights = simResults.map((r) => {
        const played = Number(r?.labyAttemptCount) || 0;
        const wins = Number(r?.encounters) || 0;
        const winRate = played > 0 ? wins / played : 0;
        attempts += expectedAttempts(winRate, floor);
        xp += Object.values(r?.experienceGained?.[hrid] || {}).reduce((s, v) => s + (Number(v) || 0), 0);
        deaths += Number(r?.deaths?.[hrid]) || 0;
        damage += Number(r?.totalDamageDealt?.[hrid]) || 0;
        ns += Number(r?.simulatedTime) || 0;
        return { winRate, wins, trials: played };
    });
    const hours = ns / (3600 * 1e9) || 1;
    const sample = {
        // Gold is not what a labyrinth trip is judged on, so the sample is "fully priced at zero":
        // an unpriced item here would stop the search from tuning that food at all
        perPlayer: {
            [hrid]: {
                xp: xp / hours,
                profit: 0,
                revenue: 0,
                cost: 0,
                unpriced: [],
                profitFailed: false,
                deaths: deaths / hours,
                dps: damage / (hours * 3600),
            },
        },
        encounters: 0,
        pools: {},
        attempts,
        fights,
    };
    const p = simResults.find((r) => r?.playerPools?.[hrid])?.playerPools?.[hrid];
    if (p) sample.pools[hrid] = { hp: p.maxHitpoints || 0, mp: p.maxManapoints || 0 };
    // Summed over every fight, so a food used in one room of the loadout is still read as used
    if (simResults.length > 0 && simResults.every((r) => r?.triggerChecks)) {
        const use = {};
        for (const r of simResults) {
            for (const [item, n] of Object.entries(triggerUseFromResult(r, [hrid])[hrid] || {})) {
                use[item] = (use[item] || 0) + n;
            }
        }
        sample.triggerUse = { [hrid]: use };
    }
    return sample;
}

/**
 * Per-fight win rates pooled over a batch of samples (wins over attempts).
 * @param {Array<Object>|null} samples - From the lab measure
 * @param {number} count - Fights in the group
 * @returns {Array<number|null>}
 */
function pooledWinRates(samples, count) {
    return Array.from({ length: count }, (_, i) => {
        let wins = 0;
        let trials = 0;
        for (const sample of samples || []) {
            wins += sample?.fights?.[i]?.wins || 0;
            trials += sample?.fights?.[i]?.trials || 0;
        }
        return trials > 0 ? wins / trials : null;
    });
}

/**
 * Tune the triggers of each loadout group against its own labyrinth fights.
 *
 * With `searchConditions`, each group then runs the condition search (`lab-condition-search.js`) on top
 * of whatever thresholds the tuner accepted, so its all-together check compares one coherent trigger set
 * against the rows the search started from.
 * @param {Object} params
 * @param {Object} params.gameData - Game data payload
 * @param {Array<Object>} params.groups - From `groupFightsByLoadout`, the ones to tune
 * @param {Array<string>} [params.crates] - Labyrinth crate hrids
 * @param {Object} [params.communityBuffs] - Community buffs
 * @param {Array<Object>} [params.labyrinthCombatBuffs] - Labyrinth token buffs
 * @param {string} [params.precision] - A PRECISIONS key
 * @param {string} [params.include] - 'both', 'abilities' or 'consumables'
 * @param {number} [params.minGain] - Smallest gain worth offering, in attempts
 * @param {boolean} [params.searchConditions] - Also search new trigger conditions (slow)
 * @param {number} [params.maxConditionSims] - Ceiling on the condition search's fight sims for the run
 * @param {Function} [onProgress] - Called with `{ current, total, description }`
 * @param {Object} [options] - `{ abortSignal: () => boolean }`
 * @returns {Promise<Object>} `{ groups, simCount, stopped, precision, include, minGain, searchConditions }`; each
 *   group `{ key, name, fights, result, baselineAttempts, tunedAttempts, conditions? }` with `result` the
 *   search's (null when stopped before its baseline), each fight `{ monsterHrid, monsterName, roomLevel,
 *   winRate, tunedWinRate }` (`tunedWinRate` only where an all-together check ran), and `conditions` the
 *   condition search's (`runConditionSearch` less its samples) plus `fights` (per-fight win rates of its
 *   all-together check) and `afterThresholds` (it started from the tuner's accepted values)
 */
export async function runLabTriggerOptimization(params, onProgress, options = {}) {
    const {
        gameData,
        groups,
        crates = [],
        communityBuffs,
        labyrinthCombatBuffs = [],
        precision: precisionKey = DEFAULT_PRECISION,
        include = 'both',
        minGain = LAB_MIN_GAIN,
        searchConditions = false,
        maxConditionSims = MAX_CONDITION_SIMS,
    } = params;
    const { abortSignal } = options;
    const precision = PRECISIONS[precisionKey] || PRECISIONS[DEFAULT_PRECISION];
    const hoursPerSeed = precision.pointHours / precision.seeds;
    const zoneHrid =
        Object.keys(gameData?.actionDetailMap || {}).find((k) => k.includes('/actions/combat/')) ||
        '/actions/combat/fly';
    const estimate = estimateLabTriggerRun({ groups, gameData, include, precision: precision.key, searchConditions });
    const total = Math.max(1, estimate.sims + estimate.conditionSims);
    const limit = createLimiter(concurrency());
    const hpOf = labMonsterMaxHpReader(gameData);
    // One object rather than separate `let`s: every group's measure closes over it
    const tally = { sims: 0, conditionSims: 0, failed: false };
    const stopped = () => tally.failed || Boolean(abortSignal?.());
    const report = (description) => onProgress?.({ current: Math.min(tally.sims, total), total, description });

    const out = [];
    for (const group of groups || []) {
        if (stopped()) break;
        const fights = group.fights.map((fight) => ({ ...fight, dto: withHrid(fight.dto) }));
        const hrid = fights[0]?.dto?.hrid;
        const tunables = groupTunables(group, gameData, include);
        const meta = fights.map((f) => ({
            monsterHrid: f.monsterHrid,
            monsterName: f.monsterName,
            roomLevel: f.roomLevel,
        }));

        const baseSeed = randomSeed();
        const streamIds = new Map();
        const streamId = (name) => {
            if (!streamIds.has(name)) streamIds.set(name, streamIds.size);
            return streamIds.get(name);
        };
        const cache = new Map();

        /**
         * One batch of seeds: every fight of the group on each seed, each fight in the DTO `dtoOf` builds
         * for it. Both searches measure through this, so their streams never share seeds.
         */
        const runSeeds = (id, dtoOf, trials, stream, count, offset) => {
            if (cache.has(id)) return cache.get(id);
            const ceiling = (trials * CEILING_SECONDS_PER_TRIAL) / 3600;
            const base = streamId(stream) * STREAM_WIDTH;
            const runs = Array.from({ length: count }, async (_, k) => {
                const seed = deriveSeed(baseSeed, base + offset + k);
                const results = await Promise.all(
                    fights.map((fight, i) =>
                        limit(async () => {
                            if (stopped()) return null;
                            try {
                                const simResult = await runLabyrinthSimulation({
                                    gameData,
                                    playerDTOs: [dtoOf(fight)],
                                    zoneHrid,
                                    monsterHrid: fight.monsterHrid,
                                    roomLevel: fight.roomLevel,
                                    crates,
                                    hours: ceiling,
                                    // A fixed count, so every setup on this seed plays the same attempts
                                    precision: { minTrials: trials, maxTrials: trials },
                                    communityBuffs,
                                    labyrinthCombatBuffs,
                                    seed: deriveSeed(seed, i),
                                });
                                tally.sims++;
                                report();
                                return simResult;
                            } catch (error) {
                                // A Stop cancels the sims in flight; that is not a failure
                                if (stopped()) return null;
                                tally.failed = true;
                                throw error;
                            }
                        })
                    )
                );
                return results.some((r) => !r) ? null : labSampleFromResults(results, hrid, trials);
            });
            const batch = (async () => {
                const samples = await Promise.all(runs);
                return samples.some((s) => !s) ? null : samples;
            })();
            cache.set(id, batch);
            return batch;
        };

        let result = null;
        let groupOut;
        if (tunables.length === 0) {
            result = { noTunables: true, changes: [] };
            groupOut = { key: group.key, name: group.name, fights: meta, result };
        } else {
            const signature = (overrides) =>
                JSON.stringify(
                    tunables
                        .filter((t) => overrides[t.key] !== undefined && overrides[t.key] !== t.original)
                        .map((t) => [t.key, overrides[t.key]])
                );
            // The baseline and the all-together batches, by stream and setup, for the per-fight figures
            const kept = new Map();
            const measure = (overrides, hours, stream, count, offset = 0) => {
                const batch = runSeeds(
                    `${signature(overrides)}|${hours}|${stream}|${count}|${offset}`,
                    (fight) => applyTriggerValues([fight.dto], tunables, overrides)[0],
                    labTrials(hours),
                    stream,
                    count,
                    offset
                );
                if (stream === 'baseline' || stream === 'final') kept.set(`${stream}|${signature(overrides)}`, batch);
                return batch;
            };

            const enemyHp = Math.max(0, ...fights.map((f) => hpOf(f.monsterHrid, f.roomLevel)));
            result = await runTriggerSearch({
                tunables,
                scopeHrids: [hrid],
                measure,
                precision,
                maxEnemies: 1,
                enemyHp: enemyHp > 0 ? { single: enemyHp, total: enemyHp } : null,
                minGain,
                objective: LAB_OBJECTIVE,
                onProgress: ({ description }) =>
                    report(`${group.name}: ${String(description || '').replace(/^Triggers: /, '')}`),
                aborted: stopped,
            });
            if (!result) {
                out.push({ key: group.key, name: group.name, fights: meta, result: null });
                break;
            }

            // Per-fight figures: the all-together check's two sides when it ran, else the baseline
            const proposed = result.changes.length > 0 ? result.changes : result.rejected || [];
            const tunedSig = signature(Object.fromEntries(proposed.map((c) => [c.key, c.to])));
            const finalOrig = result.combined ? await kept.get(`final|${signature({})}`) : null;
            const finalTuned = result.combined ? await kept.get(`final|${tunedSig}`) : null;
            const baseline = await kept.get(`baseline|${signature({})}`);
            const before = pooledWinRates(finalOrig || baseline, fights.length);
            const after = finalTuned ? pooledWinRates(finalTuned, fights.length) : fights.map(() => null);
            // The totals are what the search scored: the mean over seeds of each seed's attempts, on its
            // half-win floor, so "before − after" is the saving the all-together check reports. The
            // per-fight win rates above are pooled, which suits a rate but not this figure.
            const meanAttempts = (samples) =>
                samples?.length
                    ? samples.reduce((s, sample) => s + (Number(sample?.attempts) || 0), 0) / samples.length
                    : null;
            groupOut = {
                key: group.key,
                name: group.name,
                fights: meta.map((m, i) => ({ ...m, winRate: before[i], tunedWinRate: after[i] })),
                result: { ...result, minGain, precision: precision.key, include, tunableCount: tunables.length },
                baselineAttempts: meanAttempts(finalOrig || baseline),
                tunedAttempts: finalTuned ? meanAttempts(finalTuned) : null,
            };
        }

        if (searchConditions && !result.stopped && !stopped()) {
            // Start from the thresholds the tuner accepted, so the two searches' changes are one setup
            const tuned = Object.fromEntries((result.changes || []).map((c) => [c.key, c.to]));
            const startDto = (fight) =>
                tunables.length ? applyTriggerValues([fight.dto], tunables, tuned)[0] : fight.dto;
            const slots = conditionSlots(startDto(fights[0]), gameData, include);
            const monsterHrids = [...new Set(fights.map((f) => f.monsterHrid))];
            const enemyHp = Math.max(0, ...fights.map((f) => hpOf(f.monsterHrid, f.roomLevel)));
            const confirmHours = hoursPerSeed * ROUND_GROWTH * ROUND_GROWTH;
            const trialsFor = {
                screen: LAB_MIN_TRIALS,
                pair: labTrials(hoursPerSeed),
                confirm: labTrials(confirmHours),
            };
            trialsFor.final = trialsFor.confirm;
            const editsKey = (edits) =>
                JSON.stringify(
                    Object.keys(edits)
                        .sort()
                        .map((k) => [k, edits[k]])
                );
            const conditionMeasure = (edits, { stream, count, offset = 0, stage }) => {
                const trials = trialsFor[stage] || trialsFor.confirm;
                const id = `cond|${editsKey(edits)}|${trials}|${stream}|${count}|${offset}`;
                if (!cache.has(id)) tally.conditionSims += count * fights.length;
                return runSeeds(id, (fight) => applyTriggerRows(startDto(fight), edits), trials, stream, count, offset);
            };
            const search = await runConditionSearch({
                slots,
                candidatesFor: (slot, referenceSamples) =>
                    buildConditionCandidates({
                        slot,
                        dto: startDto(fights[0]),
                        gameData,
                        monsterHrids,
                        pools: referenceSamples?.find((s) => s?.pools?.[hrid])?.pools?.[hrid],
                        enemyHp,
                    }),
                measure: conditionMeasure,
                precision,
                minGain,
                aborted: stopped,
                // Seed runs × fights, as `conditionMeasure` counts them (cache hits would cost nothing,
                // so this errs toward stopping early)
                overBudget: (seedRuns = 0) => tally.conditionSims + seedRuns * fights.length > maxConditionSims,
                onProgress: ({ description }) =>
                    report(`${group.name}: ${String(description || '').replace(/^Conditions: /, 'conditions, ')}`),
            });
            const { finalSamples, ...conditions } = search;
            const before = finalSamples ? pooledWinRates(finalSamples.before, fights.length) : null;
            const after = finalSamples ? pooledWinRates(finalSamples.after, fights.length) : null;
            groupOut.conditions = {
                ...conditions,
                slotCount: slots.length,
                afterThresholds: Object.keys(tuned).length > 0,
                fights: meta.map((m, i) => ({
                    ...m,
                    winRate: before ? before[i] : null,
                    tunedWinRate: after ? after[i] : null,
                })),
            };
        }

        out.push(groupOut);
        if (result.stopped || groupOut.conditions?.stopped) break;
    }

    return {
        groups: out,
        simCount: tally.sims,
        conditionSimCount: tally.conditionSims,
        stopped: stopped(),
        precision: precision.key,
        include,
        minGain,
        searchConditions,
    };
}
