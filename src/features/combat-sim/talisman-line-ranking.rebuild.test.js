/**
 * Scoring a finished ranking again and rebuilding its set from the saved line measurements (no new line sims).
 *
 * The worst outcome is a re-score that quietly differs from what a fresh run would have said, or one that touches the
 * ranking it was made from (a stopped rebuild must leave it as it was). Each is checked here.
 */
import { describe, test, expect, vi } from 'vitest';
import { BELT_ITEMS, TALISMAN_ENHANCEMENT_TABLE } from '../../__fixtures__/talisman-bonuses.js';
import { FULL_MODIFIER_DETAILS } from '../../__fixtures__/talisman-full-modifiers.js';

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => true,
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key === 'combatSim_sharedSeed' ? true : fallback),
        getSetting: () => {},
    },
}));

const {
    COMBAT_RANKING_METRICS,
    balancedScore,
    createMeasurer,
    measureRaw,
    newlyUnpricedLineCosts,
    profitNoiseOfNetPct,
    rankingMetric,
    rebuildCombatLineRanking,
    rescoreMeasurement,
    runCombatLineRanking,
    scaleAcrossGrades,
    scoreMeasurement,
    setSignature,
} = await import('./talisman-line-ranking.js');

const LARGE_10 = { hrid: '/items/large_talisman_belt', enhancementLevel: 10 };
const ZONE = '/actions/combat/z';
const data = {
    talismansEnabled: true,
    talismanModifierDetailMap: FULL_MODIFIER_DETAILS,
    itemDetailMap: BELT_ITEMS,
    enhancementLevelTotalBonusMultiplierTable: TALISMAN_ENHANCEMENT_TABLE,
    talismanInfo: { maxGrade: 6, maxModifierCount: 4, maxSlotCount: 3 },
    actionDetailMap: { [ZONE]: { hrid: ZONE, type: '/action_types/combat', name: 'Z' } },
};

const CRIT = '/talisman_modifiers/critical_damage';
const SMITE = '/talisman_modifiers/smite'; // a Special line
const ABILITY = '/talisman_modifiers/ability_damage';
const HASTE = '/talisman_modifiers/attack_speed';
const CAST = '/talisman_modifiers/cast_speed';
const AUTO = '/talisman_modifiers/auto_attack_damage';
const KEYED = '/talisman_modifiers/armor'; // profit gain resting on an unpriced running cost

/** What one copy of a line adds to (dps, xp/hr, profit/hr) on the 1000/1000/1000 baseline */
const GAINS = {
    [CRIT]: [60, 5, 10],
    [SMITE]: [40, 2, 4],
    [ABILITY]: [12, 30, 8],
    [HASTE]: [11, 28, 6],
    [CAST]: [10, 26, 5],
    [AUTO]: [9, 24, 3],
    [KEYED]: [1, 1, 200],
};

function fakeDeps({ abortOn } = {}) {
    const calls = [];
    const runSimulation = vi.fn(async (params) => {
        calls.push(params);
        if (abortOn && calls.length === abortOn.call) {
            abortOn.flag.value = true;
            throw new Error('Cancelled');
        }
        let dps = 1000;
        let xp = 1000;
        let profit = 1000;
        const keyed = [];
        const seen = {};
        for (const t of params.playerDTOs[0].talismans || []) {
            for (const m of t.modifiers) {
                seen[m.hrid] = (seen[m.hrid] || 0) + 1;
                // A repeated copy adds half as much as the first
                const share = seen[m.hrid] === 1 ? 1 : 0.5;
                const [d, x, p] = GAINS[m.hrid] || [0, 0, 0];
                dps += d * share;
                xp += x * share;
                profit += p * share;
                if (m.hrid === KEYED) keyed.push('Dungeon Key');
            }
        }
        return { dps, xp, profit, unpricedCost: keyed, deaths: {}, encounters: 1000 };
    });
    return {
        calls,
        deps: {
            buildGameDataPayload: () => data,
            runSimulation,
            computeMetrics: (r) => ({
                dps: r.dps,
                xpPerHour: r.xp,
                profitPerHour: r.profit,
                revenuePerHour: r.profit + 500,
                costPerHour: 500,
                encountersPerHour: 10,
                deathsPerHour: 5,
                unpricedCost: r.unpricedCost,
                unpricedCostRates: { 'Dungeon Key': 1 },
            }),
            computeDeltas: (b, u) => ({
                dps: ((u.dps - b.dps) / b.dps) * 100,
                xp: ((u.xpPerHour - b.xpPerHour) / b.xpPerHour) * 100,
                profit: ((u.profitPerHour - b.profitPerHour) / Math.abs(b.profitPerHour)) * 100,
                encounters: 0,
                deaths: 0,
            }),
            rateDeltaNoisePct: () => ({ dps: 0.1, xp: 0.1, profit: 0.1, encounters: 0.1, deaths: 0.1 }),
            significantDeltas: (d, n) =>
                Object.fromEntries(Object.keys(d).map((k) => [k, Math.abs(d[k]) > 1.96 * n[k]])),
            seedSimPriceCache: (cache) => cache,
            saleTaxRateOf: () => null,
            concurrency: () => 2,
        },
    };
}

const params = (overrides = {}) => ({
    playerDTOs: [
        { hrid: '/players/1', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] },
        { hrid: '/players/2', equipment: { '/equipment_types/belt': LARGE_10 }, talismans: [] },
    ],
    playerIndex: 0,
    selfHrid: '/players/1',
    zoneHrid: ZONE,
    difficultyTier: 1,
    hours: 10,
    communityBuffs: {},
    grade: 6,
    metricKey: 'dps',
    ...overrides,
});

const controls = (overrides = {}) => ({
    metricKey: 'dps',
    balanceWeights: { xp: 1, profit: 1, dps: 1 },
    setMode: 'practical',
    capGrade: 3,
    budget: 0,
    ...overrides,
});

/** The fields a metric decides, for comparing a re-score with a fresh run */
const scored = (row) => ({
    hrid: row.hrid,
    value: row.value,
    valuePct: row.valuePct,
    errPct: row.errPct,
    significant: row.significant,
    byGrade: row.byGrade,
    byGradePct: row.byGradePct,
    noEffect: row.noEffect,
    deathsRise: row.deathsRise,
    costUnpriced: row.costUnpriced,
});

const hridsOf = (set) => set.talismans.map((t) => t.modifiers.map((m) => m.hrid).sort());

describe('measure and score steps', () => {
    /** The measureAgainst of before the split, kept as the oracle the new two steps must reproduce */
    function oracle({ deps, playerHrid, metric, balanceWeights, seed }, metricsOf, result, against) {
        const Z = 1.96;
        const metrics = metricsOf(result, against.hours);
        const deltas = deps.computeDeltas(against.metrics, metrics);
        const noise = deps.rateDeltaNoisePct(against.result, result, playerHrid);
        const significantBy = deps.significantDeltas(deltas, noise, {
            baseline: against.metrics,
            upgraded: metrics,
            deathCounts: { baseline: against.result?.deaths?.[playerHrid], upgraded: result?.deaths?.[playerHrid] },
        });
        const change = {};
        for (const m of COMBAT_RANKING_METRICS) {
            change[m.key] = (m.rate(metrics) || 0) - (m.rate(against.metrics) || 0);
        }
        const costUnpriced = newlyUnpricedLineCosts(against.metrics, metrics);
        const profitDriven =
            costUnpriced.length > 0 && (metric.balanced ? (balanceWeights?.profit ?? 1) > 0 : metric.key === 'profit');
        const unpricedFields = costUnpriced.length ? { costUnpriced } : {};
        const deathsRise = Boolean(significantBy?.deaths) && Number(deltas?.deaths) > 0;
        if (metric.balanced) {
            const score = balancedScore(
                { deltas, noise, change, baseline: against.metrics, significantBy },
                balanceWeights
            );
            return {
                metrics,
                deltas,
                noise,
                significantBy,
                change,
                value: score.valuePct,
                valuePct: score.valuePct,
                errPct: score.errPct,
                significant: score.significant && !profitDriven,
                ...unpricedFields,
                deathsRise,
                noEffect: seed != null && COMBAT_RANKING_METRICS.every((m) => change[m.key] === 0),
            };
        }
        const good = metric.lowerIsBetter ? -change[metric.key] : change[metric.key];
        const goodPct = metric.lowerIsBetter ? -deltas[metric.key] : deltas[metric.key];
        return {
            metrics,
            deltas,
            noise,
            significantBy,
            change,
            value: good,
            valuePct: goodPct,
            errPct:
                metric.key === 'profit'
                    ? Z * profitNoiseOfNetPct(noise?.profit, against.metrics)
                    : Z * (Number(noise?.[metric.key]) || 0),
            significant: Boolean(significantBy?.[metric.key]) && !profitDriven,
            ...unpricedFields,
            deathsRise,
            noEffect: seed != null && COMBAT_RANKING_METRICS.every((m) => change[m.key] === 0),
        };
    }

    const { deps } = fakeDeps();
    const sim = (dps, xp, profit, unpricedCost = []) => ({ dps, xp, profit, unpricedCost, deaths: {} });
    const baselineSim = sim(1000, 1000, 1000);
    // A baseline near break-even, as a close-call round's longer baseline can be
    const nearZero = { ...deps.computeMetrics(sim(1000, 1000, 3)), unpricedCostRates: { 'Dungeon Key': 1 } };
    const defaultBaseline = deps.computeMetrics(baselineSim);
    const against = (metrics) => ({ result: baselineSim, metrics, hours: 10 });
    const withLine = [
        sim(1060, 1005, 1010),
        sim(1012, 1030, 1008),
        sim(1001, 1001, 1200, ['Dungeon Key']),
        sim(1000, 1000, 1000),
    ];

    test.each(COMBAT_RANKING_METRICS.map((m) => m.key))(
        'the split gives the old measurement exactly, ranked by %s',
        (key) => {
            const metric = rankingMetric(key);
            const weights = { xp: 2, profit: 1, dps: 3 };
            for (const baseline of [defaultBaseline, nearZero]) {
                for (const result of withLine) {
                    const { measureAgainst, metricsOf } = createMeasurer({
                        deps,
                        gameData: data,
                        playerHrid: '/players/1',
                        priceCache: new Map(),
                        saleTaxRate: null,
                        metric,
                        balanceWeights: weights,
                        seed: 7,
                    });
                    const fresh = measureAgainst(result, against(baseline));
                    const old = oracle(
                        { deps, playerHrid: '/players/1', metric, balanceWeights: weights, seed: 7 },
                        metricsOf,
                        result,
                        against(baseline)
                    );
                    // Everything the old record held, the same; the new record also names its baseline
                    const { baselineMetrics, ...rest } = fresh;
                    expect(rest).toEqual(old);
                    expect(baselineMetrics).toBe(baseline);
                }
            }
        }
    );

    test('scoring a stored measurement under another metric equals measuring fresh under that metric', () => {
        const weights = { xp: 1, profit: 2, dps: 1 };
        for (const from of COMBAT_RANKING_METRICS) {
            for (const to of COMBAT_RANKING_METRICS) {
                for (const result of withLine) {
                    const make = (metric) =>
                        createMeasurer({
                            deps,
                            gameData: data,
                            playerHrid: '/players/1',
                            priceCache: new Map(),
                            saleTaxRate: null,
                            metric,
                            balanceWeights: weights,
                            seed: 7,
                        });
                    const before = make(from).measureAgainst(result, against(nearZero));
                    expect(rescoreMeasurement(before, to, weights)).toEqual(
                        make(to).measureAgainst(result, against(nearZero))
                    );
                }
            }
        }
    });

    test('the unpriced-cost line is never significant by profit, and is by DPS', () => {
        const raw = measureRaw(
            { deps, playerHrid: '/players/1', seed: 7 },
            withLine[2],
            deps.computeMetrics(withLine[2]),
            against(defaultBaseline)
        );
        expect(raw.costUnpriced).toEqual(['Dungeon Key']);
        expect(scoreMeasurement(raw, rankingMetric('profit')).significant).toBe(false);
        expect(scoreMeasurement(raw, rankingMetric('profit')).value).toBeGreaterThan(0);
        // Balanced with a zero profit weight does not lean on the free cost
        expect(
            scoreMeasurement(raw, rankingMetric('balanced'), { xp: 1, profit: 0, dps: 1 }).significant
        ).toBeDefined();
    });
});

describe('rebuildCombatLineRanking', () => {
    async function ranked(overrides = {}) {
        const sim = fakeDeps();
        const result = await runCombatLineRanking(params(overrides), null, sim.deps);
        expect(result.status).toBe('done');
        return { ...sim, result };
    }

    test('a fresh run keeps what a rebuild needs, and names the metric it ran under', async () => {
        const { result } = await ranked();
        expect(result.rebuild.ranWith).toEqual({ metricKey: 'dps', balanceWeights: null });
        expect(result.rebuild.priceCache).toBeInstanceOf(Map);
        expect(result.rebuild.baselineResult).toBeTruthy();
        expect(result.rows.every((r) => r.baselineMetrics)).toBe(true);
        expect(result.combined.baselineMetrics).toBeTruthy();
        expect(result.current).toBeNull();
    });

    test('a metric switch scores every row as a fresh run would, reorders them and replans the set', async () => {
        const { result, deps } = await ranked();
        const calls = deps.runSimulation.mock.calls.length;
        const rebuilt = await rebuildCombatLineRanking(result, controls({ metricKey: 'xp' }), null, deps);
        expect(rebuilt.status).toBe('done');
        // The new set differs, so one combined sim ran: no line sims
        expect(rebuilt.rebuilt).toMatchObject({ rescored: true, simmed: true, setChanged: true });
        expect(deps.runSimulation.mock.calls.length - calls).toBe(1);
        expect(rebuilt.sims).toBe(result.sims + 1);

        const fresh = await runCombatLineRanking(params({ metricKey: 'xp' }), null, fakeDeps().deps);
        const byHrid = (rows) => Object.fromEntries(rows.map((r) => [r.hrid, scored(r)]));
        expect(byHrid(rebuilt.rows)).toEqual(byHrid(fresh.rows));
        expect(rebuilt.rows[0].hrid).not.toBe(result.rows[0].hrid);
        expect(hridsOf(rebuilt.set)).toEqual(hridsOf(fresh.set).map((l) => l));
        expect(rebuilt.metricKey).toBe('xp');
        expect(rebuilt.rebuilt.metricDiffers).toBe(true);
        expect(rebuilt.noise.measured).toBe(fresh.noise.measured);
        expect(rebuilt.rerollTargets).toEqual(fresh.rerollTargets);
        // The combined figure is the new set's, measured against the run's own baseline and scored by XP
        expect(rebuilt.combined.value).toBeCloseTo(fresh.combined.value, 9);
    });

    test('the copies run is scored again with the row (a duplicate line across talismans)', async () => {
        const { result, deps } = await ranked();
        const withCopies = result.rows.filter((r) => r.copies);
        expect(withCopies.length).toBeGreaterThan(0);
        const rebuilt = await rebuildCombatLineRanking(result, controls({ metricKey: 'xp' }), null, deps);
        for (const row of rebuilt.rows.filter((r) => r.copies)) {
            expect(row.copiesValue).toBe(row.copies.value);
            // The sim gave a second and third copy half the first's gain: 5 + 2.5 + 2.5 on the XP of a Crit line
            if (row.hrid === CRIT) expect(row.copiesValue).toBeCloseTo(10, 9);
        }
        // Crit repeats across the three talismans in the DPS set, never twice on one
        for (const t of result.set.talismans) {
            expect(new Set(t.modifiers.map((m) => m.hrid)).size).toBe(t.modifiers.length);
        }
    });

    test('Balanced weights that change nothing about the set re-score without a sim', async () => {
        const { result, deps } = await ranked();
        const calls = deps.runSimulation.mock.calls.length;
        // All the weight on DPS: the same order and the same set as ranking by DPS
        const rebuilt = await rebuildCombatLineRanking(
            result,
            controls({ metricKey: 'balanced', balanceWeights: { xp: 0, profit: 0, dps: 1 } }),
            null,
            deps
        );
        expect(deps.runSimulation.mock.calls.length).toBe(calls);
        expect(rebuilt.rebuilt).toMatchObject({ rescored: true, simmed: false, setChanged: false });
        expect(setSignature(rebuilt.set)).toBe(setSignature(result.set));
        expect(rebuilt.sims).toBe(result.sims);
        // The stored combined measurement stands, re-scored in percent
        expect(rebuilt.combined.valuePct).toBeCloseTo(result.combined.valuePct, 9);
        expect(rebuilt.balanceWeights).toEqual({ xp: 0, profit: 0, dps: 1 });
    });

    test('a set-mode change replans from the same rows with at most one sim, and leaves the previous result alone', async () => {
        const { result, deps } = await ranked();
        const before = JSON.stringify({ rows: result.rows, set: result.set, combined: result.combined });
        const calls = deps.runSimulation.mock.calls.length;
        const rebuilt = await rebuildCombatLineRanking(result, controls({ setMode: 'ideal' }), null, deps);
        expect(deps.runSimulation.mock.calls.length - calls).toBe(1);
        expect(rebuilt.setMode).toBe('ideal');
        expect(rebuilt.rebuilt).toMatchObject({ rescored: false, simmed: true });
        // Ideal aims at the simulated grade
        expect(rebuilt.set.talismans.every((t) => t.modifiers.every((m) => m.grade === 6))).toBe(true);
        // The sim was of the new set, on the first player's slot, the other player's belt untouched
        const last = deps.runSimulation.mock.calls.at(-1)[0];
        expect(last.playerDTOs[0].talismans).toEqual(rebuilt.set.talismans);
        expect(last.playerDTOs[1].talismans).toEqual([]);
        expect(last.hours).toBe(10);
        expect(last.seed).toBe(result.rebuild.seed);
        expect(JSON.stringify({ rows: result.rows, set: result.set, combined: result.combined })).toBe(before);
        // Same metric: no caveat about the shortlist
        expect(rebuilt.rebuilt.metricDiffers).toBe(false);
    });

    test('a Special line rides along: one per talisman in Practical, rows keep their flags', async () => {
        const { result, deps } = await ranked();
        const rebuilt = await rebuildCombatLineRanking(result, controls({ metricKey: 'profit' }), null, deps);
        expect(rebuilt.rows.find((r) => r.hrid === SMITE).special).toBe(true);
        for (const t of rebuilt.set.talismans) {
            expect(t.modifiers.filter((m) => m.hrid === SMITE).length).toBeLessThanOrEqual(1);
        }
    });

    test('an unpriced profit line is a ceiling by profit and a real gain by DPS, in either direction', async () => {
        const { result, deps } = await ranked({ metricKey: 'profit' });
        const keyed = (r) => r.rows.find((x) => x.hrid === KEYED);
        expect(keyed(result).costUnpriced).toEqual(['Dungeon Key']);
        expect(keyed(result).significant).toBe(false);
        const toDps = await rebuildCombatLineRanking(result, controls({ metricKey: 'dps' }), null, deps);
        const dpsFresh = await runCombatLineRanking(params({ metricKey: 'dps' }), null, fakeDeps().deps);
        expect(scored(keyed(toDps))).toEqual(scored(keyed(dpsFresh)));
        const back = await rebuildCombatLineRanking(toDps, controls({ metricKey: 'profit' }), null, deps);
        expect(scored(keyed(back))).toEqual(scored(keyed(result)));
        // Back on the metric the run used, the shortlist caveat goes away
        expect(back.rebuilt.metricDiffers).toBe(false);
        expect(toDps.rebuilt.metricDiffers).toBe(true);
    });

    test('the worn talismans are scored again from their stored measurement, with their records', async () => {
        const worn = [{ slotIndex: 2, modifiers: [{ hrid: ABILITY, grade: 2 }] }];
        const sim = fakeDeps();
        const p = params();
        p.playerDTOs[0].talismans = worn;
        const result = await runCombatLineRanking(p, null, sim.deps);
        expect(result.current.talismans).toEqual(worn);
        const calls = sim.deps.runSimulation.mock.calls.length;
        const rebuilt = await rebuildCombatLineRanking(result, controls({ metricKey: 'xp' }), null, sim.deps);
        expect(rebuilt.current.talismans).toEqual(worn);
        expect(rebuilt.current.value).not.toBe(result.current.value);
        // Only the combined sim could have run
        expect(sim.deps.runSimulation.mock.calls.length - calls).toBeLessThanOrEqual(1);
    });

    test('the grade-capped orb stamps of the old ranking never survive a rebuild', async () => {
        const { result, deps } = await ranked();
        for (const row of result.rows) Object.assign(row, { orbCost: 9, perOrb: 9, orbLimits: null });
        const rebuilt = await rebuildCombatLineRanking(result, controls({ metricKey: 'xp' }), null, deps);
        for (const row of rebuilt.rows) {
            expect(row.orbCost).toBeUndefined();
            expect(row.perOrb).toBeUndefined();
        }
        expect(result.rows[0].perOrb).toBe(9);
    });

    test('Stop during the combined sim: stopped, nothing sent back to replace the previous result', async () => {
        const flag = { value: false };
        const { result, deps } = await ranked();
        const calls = deps.runSimulation.mock.calls.length;
        const before = JSON.stringify(result.rows);
        deps.runSimulation.mockImplementationOnce(async () => {
            flag.value = true;
            throw new Error('Cancelled');
        });
        const outcome = await rebuildCombatLineRanking(result, controls({ setMode: 'ideal' }), null, deps, {
            abortSignal: () => flag.value,
        });
        expect(outcome).toMatchObject({ status: 'stopped', stage: 'check' });
        expect(outcome.rows).toBeUndefined();
        expect(deps.runSimulation.mock.calls.length - calls).toBe(1);
        expect(JSON.stringify(result.rows)).toBe(before);
        expect(result.setMode).toBe('practical');
    });

    test('a cancel from another panel ends it as stopped and says so', async () => {
        const { result, deps } = await ranked();
        deps.runSimulation.mockImplementationOnce(async () => {
            throw new Error('Cancelled by another run');
        });
        const outcome = await rebuildCombatLineRanking(result, controls({ setMode: 'ideal' }), null, deps);
        expect(outcome).toMatchObject({ status: 'stopped', cancelledElsewhere: true });
    });

    test('a result that cannot be rebuilt is refused with a reason, not guessed at', async () => {
        const { result, deps } = await ranked();
        expect((await rebuildCombatLineRanking({ ...result, status: 'stopped' }, controls(), null, deps)).status).toBe(
            'refused'
        );
        const { rebuild, ...bare } = result;
        expect(rebuild).toBeTruthy();
        expect((await rebuildCombatLineRanking(bare, controls(), null, deps)).status).toBe('refused');
        const noBaseline = { ...result, rows: result.rows.map(({ baselineMetrics: _dropped, ...r }) => ({ ...r })) };
        expect(baselineOf(result)).toBeTruthy();
        expect((await rebuildCombatLineRanking(noBaseline, controls(), null, deps)).status).toBe('refused');
    });

    test('a rebuild of a rebuild stays rebuildable and remembers the metric the run used', async () => {
        const { result, deps } = await ranked();
        const once = await rebuildCombatLineRanking(result, controls({ metricKey: 'xp' }), null, deps);
        const twice = await rebuildCombatLineRanking(
            once,
            controls({ metricKey: 'profit', setMode: 'ideal' }),
            null,
            deps
        );
        expect(twice.status).toBe('done');
        expect(twice.rebuild.ranWith).toEqual({ metricKey: 'dps', balanceWeights: null });
        expect(twice.rows.map((r) => r.hrid).sort()).toEqual(result.rows.map((r) => r.hrid).sort());
        // The byGrade list is still the row's scaled figures
        const row = twice.rows[0];
        expect(row.byGrade).toEqual(scaleAcrossGrades(row.value, row.detail, 6));
    });
});

function baselineOf(result) {
    return result.rows[0].baselineMetrics;
}
