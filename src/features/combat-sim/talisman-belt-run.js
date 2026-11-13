/**
 * Talisman belt advisor, combat run
 *
 * Test server only. For each candidate belt (see features/talismans/talisman-belt-advisor.js) the player's build is
 * simulated with that belt in the belt slot and the talismans slotted now, against the same build with the belt worn
 * now. Nothing is scaled: the sim is not linear in Talisman Power (defense lines divide, Special lines trigger), so
 * every candidate is its own sim.
 *
 * It measures the way the Talisman lines ranking does: the same shared seed, one worker per sim, the upgrade advisor's
 * metrics, deltas, error bars and verdicts (`createMeasurer`), profit never "significant" when it rests on a running
 * cost counted as free.
 *
 * The talismans are those the build wears on its own belt (`wornTalismans`), and the same list goes on every candidate:
 * a record in a slot the belt worn does not have is not worn, and a larger belt must not bring it to life.
 */

import config from '../../core/config.js';
import { TALISMAN_MODELED_STATS } from './engine/player.js';
import { computeTalismanCombat } from './engine/talisman-combat.js';
import { TASK_DAMAGE_OFF } from './engine/task-damage-mode.js';
import { randomSeed } from './engine/rng.js';
import {
    DEFAULT_BALANCE_WEIGHTS,
    SIM_BELT_TYPE,
    combatRankingReadiness,
    createMeasurer,
    mapLanes,
    normalizeBalanceWeights,
    rankingMetric,
    wornTalismans,
} from './talisman-line-ranking.js';
import { beltCandidates, beltCosts } from '../talismans/talisman-belt-advisor.js';

const COMBAT_STAT_TARGET = '/talisman_modifier_targets/combat_stat';

/**
 * Whether any worn line changes a combat stat (a skilling-only line on the belt changes nothing in a fight).
 * @param {Array<Object>} talismans - Worn talismans
 * @param {Object} modifierDetailMap
 * @returns {boolean}
 */
export function hasCombatLines(talismans, modifierDetailMap) {
    return (talismans || []).some((t) =>
        (t.modifiers || []).some((m) => modifierDetailMap?.[m.hrid]?.targetHrid === COMBAT_STAT_TARGET)
    );
}

/**
 * How many sims a belt check runs: the baseline and one per candidate.
 * @param {number} candidates
 * @returns {number}
 */
export function estimateBeltSims(candidates) {
    return candidates > 0 ? 1 + candidates : 0;
}

/**
 * Value every candidate belt for one player in one zone and tier.
 *
 * @param {Object} params
 * @param {Array<Object>} params.playerDTOs - The roster as the run starts (not mutated)
 * @param {number} params.playerIndex
 * @param {string|null} params.selfHrid
 * @param {string} params.zoneHrid
 * @param {number} params.difficultyTier
 * @param {number} params.hours
 * @param {Object} params.communityBuffs
 * @param {string} params.metricKey - A COMBAT_RANKING_METRICS key
 * @param {Object} [params.balanceWeights]
 * @param {Function} onProgress - `{current, total, description}`
 * @param {Object} deps - The ranking's: `{buildGameDataPayload, runSimulation, computeMetrics, computeDeltas,
 *   rateDeltaNoisePct, significantDeltas, seedSimPriceCache, saleTaxRateOf, concurrency}`, and `costDeps` for the
 *   price readers
 * @param {Object} [options] - `{abortSignal: () => boolean}`
 * @returns {Promise<Object>} `{status: 'done'|'stopped'|'refused', ...}`
 */
export async function runCombatBeltAdvisor(params, onProgress, deps, options = {}) {
    const {
        playerDTOs,
        playerIndex,
        selfHrid = null,
        zoneHrid,
        difficultyTier,
        hours,
        communityBuffs,
        metricKey,
        balanceWeights = DEFAULT_BALANCE_WEIGHTS,
    } = params;
    const { abortSignal } = options;
    let cancelledElsewhere = false;
    const stopped = () => cancelledElsewhere || Boolean(abortSignal?.());
    const gameData = deps.buildGameDataPayload();
    const playerDTO = playerDTOs?.[playerIndex] || null;
    const ready = combatRankingReadiness({ gameData, playerDTO, zoneHrid });
    if (!ready.ok) return { status: 'refused', ...ready };

    const worn = wornTalismans(playerDTO.talismans, ready.slots);
    if (worn.length === 0) {
        return {
            status: 'refused',
            reason: 'no_talismans',
            message:
                'This build has no talisman slotted on its belt, so a different belt changes nothing. Slot one first.',
        };
    }
    if (!hasCombatLines(worn, gameData.talismanModifierDetailMap)) {
        return {
            status: 'refused',
            reason: 'no_combat_lines',
            message: 'No slotted talisman has a combat line, so a different belt changes nothing in a fight.',
        };
    }
    const metric = rankingMetric(metricKey);
    const currentBelt = { hrid: ready.belt.hrid, enhancementLevel: ready.belt.enhancementLevel || 0 };
    const candidates = beltCandidates(
        currentBelt,
        gameData.itemDetailMap,
        gameData.enhancementLevelTotalBonusMultiplierTable
    );
    // Lines the sim does not read count for nothing on every belt, so the gains understate them
    const read = computeTalismanCombat({
        talismans: worn,
        belt: ready.belt,
        gameData,
        modeledStats: TALISMAN_MODELED_STATS,
    });
    const unmodeled = Object.keys(read.unmodeled);

    const playerHrid = playerDTO.hrid;
    const isSelf = selfHrid != null && playerHrid === selfHrid;
    const base = {
        kind: 'combat',
        metricKey: metric.key,
        power: ready.power,
        slots: ready.slots,
        belt: currentBelt,
        of: candidates.length,
        unmodeled,
        playerHrid,
        isSelf,
        balanceWeights: metric.balanced ? normalizeBalanceWeights(balanceWeights) : null,
    };
    if (candidates.length === 0) return { status: 'done', ...base, rows: [], measured: 0, sims: 0 };

    const saleTaxRate = deps.saleTaxRateOf(playerDTO, isSelf);
    const seed = config.getSettingValue('combatSim_sharedSeed', true) ? randomSeed() : null;
    const priceCache = new Map();
    deps.seedSimPriceCache(priceCache, gameData, {
        zoneHrid,
        ...(saleTaxRate != null ? { saleTaxRate } : {}),
        consumableHrids: [...(playerDTO.food || []), ...(playerDTO.drinks || [])].map((i) => i?.hrid),
    });
    const total = estimateBeltSims(candidates.length);
    let current = 0;
    const report = (description) => onProgress?.({ current, total, description });

    /** The roster with this player's belt replaced (the talismans stay the ones worn now) */
    const rosterWith = (belt) => {
        const roster = JSON.parse(JSON.stringify(playerDTOs));
        const player = roster[playerIndex];
        player.equipment = { ...(player.equipment || {}), [SIM_BELT_TYPE]: belt };
        player.talismans = JSON.parse(JSON.stringify(worn));
        return roster;
    };
    const simulate = async (belt) => {
        try {
            return await deps.runSimulation(
                {
                    gameData,
                    playerDTOs: rosterWith(belt),
                    zoneHrid,
                    difficultyTier,
                    hours,
                    communityBuffs,
                    seed,
                    taskDamageMode: TASK_DAMAGE_OFF,
                },
                null,
                // Never preempt: nothing else may run while this does, and a preempt would stop whatever runs elsewhere
                { preempt: false, workers: 1 }
            );
        } catch (error) {
            if (stopped()) return null;
            if (/cancel/i.test(String(error?.message))) {
                cancelledElsewhere = true;
                return null;
            }
            throw error;
        }
    };
    const stoppedResult = (rows) => ({
        status: 'stopped',
        ...base,
        rows,
        measured: rows.length,
        cancelledElsewhere,
        sims: current,
        hours,
        paired: seed != null,
    });

    report('Belts: baseline with the belt worn now');
    const baselineResult = await simulate({ ...ready.belt });
    if (!baselineResult || stopped()) return stoppedResult([]);
    current++;
    const { metricsOf, measureAgainst } = createMeasurer({
        deps,
        gameData,
        playerHrid,
        priceCache,
        saleTaxRate,
        metric,
        balanceWeights,
        seed,
    });
    const baseline = metricsOf(baselineResult, hours);
    base.baseline = baseline;
    base.unpriced = Array.isArray(baseline?.unpriced) ? baseline.unpriced : [];
    const against = { result: baselineResult, metrics: baseline, hours };

    const measured = await mapLanes(
        candidates,
        async (candidate) => {
            if (stopped()) return null;
            const result = await simulate({
                ...ready.belt,
                hrid: candidate.hrid,
                enhancementLevel: candidate.level,
            });
            if (!result || stopped()) return null;
            current++;
            report(`Belts: ${candidate.name} +${candidate.level}`);
            return { candidate, measure: measureAgainst(result, against) };
        },
        Math.max(1, deps.concurrency())
    );
    // The sale of your own belt is taxed at this build's rate (null: the live character's own)
    const costDeps =
        saleTaxRate != null ? { ...deps.costDeps, afterTax: (price) => price * (1 - saleTaxRate) } : deps.costDeps;
    const profitMatters = metric.balanced
        ? normalizeBalanceWeights(balanceWeights).profit > 0
        : metric.key === 'profit';
    const rows = measured.filter(Boolean).map(({ candidate, measure }) => ({
        ...candidate,
        ...measure,
        // A profit gain resting on a running cost counted as free is a ceiling, said apart from noise
        gainUnreal: profitMatters && Boolean(measure.costUnpriced?.length),
        costs: beltCosts(candidate, currentBelt, gameData, costDeps),
    }));
    if (stopped() || rows.length < candidates.length) return stoppedResult(rows);
    return { status: 'done', ...base, rows, measured: rows.length, sims: current, hours, paired: seed != null };
}
