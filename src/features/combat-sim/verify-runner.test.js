import { describe, test, expect, vi, beforeEach } from 'vitest';

const sim = vi.hoisted(() => ({
    /** Every runSimulation call: { seed, hours, workers, preempt, precision, marker } */
    calls: [],
    labCalls: [],
    /** Called before each runSimulation resolves; may throw or flip an abort flag */
    onRun: null,
    onLabRun: null,
    /** Lab: attempts a baseline run plays, by seed (the "new" trial count) */
    labAttempts: (seed) => 200 + (seed % 5),
    /** Random seeds handed out by the mocked generator, in order */
    seeds: [],
    /** Items nothing priced, by candidate marker (a result carries them the way calculateSimRevenue reports them) */
    unpriced: {},
    /** The market price the mocked valuation reads; a price cache holds the first value it saw */
    price: 0,
}));

vi.mock('./combat-sim-runner.js', () => ({
    runSimulation: vi.fn(async (params, _progress, opts) => {
        const marker = params.playerDTOs[0].applied ?? 'base';
        sim.calls.push({
            seed: params.seed,
            hours: params.hours,
            workers: opts?.workers,
            preempt: opts?.preempt,
            precision: params.precision,
            marker,
        });
        sim.onRun?.(marker, params);
        return { seed: params.seed, marker, hours: params.hours, unpriced: sim.unpriced[marker] ?? [] };
    }),
    runLabyrinthSimulation: vi.fn(async (params) => {
        const marker = params.playerDTOs[0].applied ?? 'base';
        sim.labCalls.push({
            seed: params.seed,
            hours: params.hours,
            precision: params.precision,
            monsterHrid: params.monsterHrid,
            marker,
            buffs: params.labyrinthCombatBuffs,
        });
        sim.onLabRun?.(marker, params);
        const attempts = params.precision ? params.precision.minTrials : sim.labAttempts(params.seed);
        // The candidate wins more often than the base by a seed-independent margin
        const winRate = marker === 'good' ? 0.6 : marker === 'worse' ? 0.3 : 0.5;
        return { seed: params.seed, labyAttemptCount: attempts, encounters: Math.round(attempts * winRate) };
    }),
}));

vi.mock('./combat-sim-adapter.js', () => ({
    seedSimPriceCache: (cache) => cache,

    buildGameDataPayload: vi.fn(() => ({ actionDetailMap: { '/actions/combat/fly': {} } })),
    calculateSimRevenue: vi.fn(),
}));

vi.mock('./engine/rng.js', async (importOriginal) => ({
    ...(await importOriginal()),
    randomSeed: vi.fn(() => sim.seeds.shift() ?? 777),
}));

vi.mock('./trigger-tuning.js', async (importOriginal) => {
    const actual = await importOriginal();
    return { ...actual, pairedDiff: vi.fn(actual.pairedDiff) };
});

// A faithful stand-in for the parts of the advisor this file reads: importing the real module drags in
// pricing, storage and the guild shop, none of which is under test here
vi.mock('./upgrade-advisor.js', () => ({
    PAIRED_TIME_HEADROOM: 3,
    applyCandidateToDTO: vi.fn((dto, candidate) => {
        if (candidate.explode) throw new Error('cannot apply');
        return { ...dto, applied: candidate.effect };
    }),
    applyCommunityBuffCandidate: (buffs) => buffs,
    buildModifiedCombatBuffs: (base, candidate) => [...base, { token: candidate.description }],
    candidateAssignmentKey: (candidate) => `key:${candidate.description}`,
    computeDeltas: (base, up) => {
        const pct = (b, u) => (b === 0 ? 0 : ((u - b) / Math.abs(b)) * 100);
        return {
            dps: pct(base.dps, up.dps),
            xp: pct(base.xpPerHour, up.xpPerHour),
            profit: pct(base.profitPerHour, up.profitPerHour),
            deaths: 0,
            encounters: pct(base.encountersPerHour, up.encountersPerHour),
        };
    },
    // Luck shared by every run on a seed (cancels in a paired difference) plus the candidate's own effect
    computeMetrics: (result, _gameData, _hrid, hours, options = {}) => {
        const cache = options.priceCache;
        if (cache && !cache.has('price')) cache.set('price', sim.price);
        const price = cache ? cache.get('price') : sim.price;
        const luck = (result.seed % 7) * 10;
        const effect = result.marker === 'good' ? 100 : result.marker === 'bad' ? -100 : 0;
        const wobble = result.marker === 'wobble' ? (result.seed % 2 ? 300 : -300) : 0;
        return {
            xpPerHour: 1000 + luck + effect + wobble,
            profitPerHour: result.marker === 'nan' ? NaN : 5000 + luck * 5 + effect * 5 + wobble + price,
            unpriced: result.unpriced ?? [],
            revenuePerHour: sim.gross,
            costPerHour: sim.gross,
            dps: 100 + luck / 10 + effect / 10,
            encountersPerHour: 50 + luck / 10 + effect / 10,
            deathsPerHour: 0,
            hours,
        };
    },
    expectedFightAttempts: (winRate) => 1 / Math.max(winRate, 0.001),
    pairedTrialRule: (result) => ({ minTrials: result.labyAttemptCount, maxTrials: result.labyAttemptCount }),
}));

const sampleOptions = vi.hoisted(() => []);

vi.mock('./trigger-optimizer.js', () => ({
    concurrency: () => 2,
    createLimiter: (limit) => {
        let running = 0;
        const waiting = [];
        return async (task) => {
            if (running >= limit) await new Promise((resolve) => waiting.push(resolve));
            running++;
            try {
                return await task();
            } finally {
                running--;
                waiting.shift()?.();
            }
        };
    },
    sampleFromResult: (result, _gameData, _hrids, _hours, options) => ({
        perPlayer: {
            p1: {
                xp: 1000 + (result.seed % 7) * 10 + (result.marker === 'good' ? 200 : 0),
                profit: 0,
                revenue: 0,
                cost: 0,
                unpriced: [],
                profitFailed: false,
                deaths: 0,
                dps: 100,
            },
        },
        encounters: 50,
        pools: {},
        __opts: sampleOptions.push(options),
    }),
}));

vi.mock('./lab-trigger-optimizer.js', () => ({
    labTrials: (hours) => Math.max(20, Math.round(hours * 10)),
    labSampleFromResults: (results, hrid, trials) => {
        const attempts = results.reduce((sum, r) => sum + 1 / Math.max(r.encounters / r.labyAttemptCount, 0.001), 0);
        return {
            perPlayer: {
                [hrid]: { xp: 0, profit: 0, revenue: 0, cost: 0, unpriced: [], profitFailed: false, deaths: 0, dps: 0 },
            },
            encounters: 0,
            pools: {},
            attempts,
            trials,
        };
    },
}));

const { runSimulation, runLabyrinthSimulation } = await import('./combat-sim-runner.js');
const tuning = await import('./trigger-tuning.js');
const {
    VERIFY_DEFAULTS,
    canVerifyTriggerResult,
    classifyVerdict,
    isCloseCall,
    verifyCombatCandidates,
    verifyLabCandidates,
    verifyTriggerChanges,
} = await import('./verify-runner.js');

const candidate = (description, effect) => ({ description, effect });
const row = (description, effect, extra = {}) => ({ candidate: candidate(description, effect), ...extra });

const makeContext = (overrides = {}) => ({
    gameData: { hello: true },
    playerDTOs: [{ hrid: 'p1' }],
    playerIndex: 0,
    playerHrid: 'p1',
    zoneHrid: '/actions/combat/fly',
    difficultyTier: 0,
    hours: 24,
    communityBuffs: {},
    seed: 4242,
    ...overrides,
});

beforeEach(() => {
    sim.calls.length = 0;
    sim.labCalls.length = 0;
    sim.onRun = null;
    sim.onLabRun = null;
    sim.seeds = [];
    sim.unpriced = {};
    sim.price = 0;
    vi.clearAllMocks();
});

describe('classifyVerdict', () => {
    // 5 seeds: 4 degrees of freedom, t = 2.776, so the bound for se = 1 is 2.776
    test('confirms only a gain strictly above the t bound', () => {
        expect(classifyVerdict({ mean: 2.777, se: 1, seeds: 5 })).toBe('confirmed');
        expect(classifyVerdict({ mean: 2.776, se: 1, seeds: 5 })).toBe('not-confirmed');
        expect(classifyVerdict({ mean: 2.775, se: 1, seeds: 5 })).toBe('not-confirmed');
    });

    test('calls a loss beyond the bound worse, and a smaller one not confirmed', () => {
        expect(classifyVerdict({ mean: -2.777, se: 1, seeds: 5 })).toBe('worse');
        expect(classifyVerdict({ mean: -2.7, se: 1, seeds: 5 })).toBe('not-confirmed');
    });

    test('flips the sign when lower is better', () => {
        expect(classifyVerdict({ mean: -3, se: 1, seeds: 5, betterIsHigher: false })).toBe('confirmed');
        expect(classifyVerdict({ mean: 3, se: 1, seeds: 5, betterIsHigher: false })).toBe('worse');
    });

    test('proves nothing with fewer than two seeds or an unusable error', () => {
        expect(classifyVerdict({ mean: 100, se: 0.1, seeds: 1 })).toBe('not-confirmed');
        expect(classifyVerdict({ mean: 100, se: Infinity, seeds: 5 })).toBe('not-confirmed');
        expect(classifyVerdict({ mean: 100, se: null, seeds: 5 })).toBe('not-confirmed');
        expect(classifyVerdict({ mean: NaN, se: 1, seeds: 5 })).toBe('not-confirmed');
    });

    test('a zero error with a real gain is confirmed, with no gain is not', () => {
        expect(classifyVerdict({ mean: 1, se: 0, seeds: 4 })).toBe('confirmed');
        expect(classifyVerdict({ mean: 0, se: 0, seeds: 4 })).toBe('not-confirmed');
    });
});

describe('isCloseCall', () => {
    test('a positive combat gain the analysis called insignificant is a close call', () => {
        expect(
            isCloseCall({ deltas: { dps: 1, xp: 0, profit: 0 }, noise: { dps: 5 }, significantBy: { dps: false } })
        ).toBe(true);
    });

    test('a clear, significant gain is not', () => {
        expect(
            isCloseCall({ deltas: { dps: 20, xp: 0, profit: 0 }, noise: { dps: 1 }, significantBy: { dps: true } })
        ).toBe(false);
    });

    test('the delta within twice its noise counts even when positive-significant is unknown', () => {
        expect(isCloseCall({ deltas: { dps: 1.9, xp: 0, profit: 0 }, noise: { dps: 1 } })).toBe(true);
        expect(isCloseCall({ deltas: { dps: 2.1, xp: 0, profit: 0 }, noise: { dps: 1 } })).toBe(false);
    });

    test('the ranked metric picks the axis', () => {
        const rowValue = {
            deltas: { dps: 30, xp: 0.5, profit: 0, encounters: 0.2 },
            noise: { dps: 1, xp: 5, encounters: 5 },
            significantBy: { dps: true, xp: false },
        };
        expect(isCloseCall(rowValue)).toBe(false);
        expect(isCloseCall(rowValue, { metric: 'xp' })).toBe(true);
        expect(isCloseCall(rowValue, { metric: 'eph' })).toBe(true);
    });

    test('a score the caller ranked on decides for profit too, not the percent-of-net delta', () => {
        // +5000% of a near-zero net profit is "significant" by the row's own rule, but +500 gold against a
        // 2,500 gold error is inside the noise
        const nearBreakEven = {
            deltas: { dps: 0, xp: 0, profit: 5000 },
            noise: { profit: 5 },
            significantBy: { profit: true },
        };
        expect(isCloseCall(nearBreakEven, { metric: 'profit' })).toBe(false);
        expect(isCloseCall(nearBreakEven, { metric: 'profit', score: { gain: 500, noise: 2500, within: true } })).toBe(
            true
        );
        expect(
            isCloseCall(nearBreakEven, { metric: 'profit', score: { gain: 50000, noise: 2500, within: false } })
        ).toBe(false);
    });

    test('reads a Lab row by attempts', () => {
        expect(isCloseCall({ attemptsDelta: -3, attemptsDeltaNoise: 5, significant: false })).toBe(true);
        expect(isCloseCall({ attemptsDelta: -30, attemptsDeltaNoise: 5, significant: true })).toBe(false);
        expect(isCloseCall({ attemptsDelta: 3, attemptsDeltaNoise: 5, significant: false })).toBe(true);
    });

    test('rows without anything to read are not close calls', () => {
        expect(isCloseCall(null)).toBe(false);
        expect(isCloseCall({})).toBe(false);
    });
});

describe('verifyCombatCandidates', () => {
    test('runs the baseline and every candidate on identical seeds, one worker, no preempt, no precision', async () => {
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good'), row('bad', 'bad')],
            seeds: 4,
            metric: 'xp',
        });
        expect(out.stopped).toBe(false);
        expect(sim.calls).toHaveLength(4 * 3);
        for (const call of sim.calls) {
            expect(call.workers).toBe(1);
            expect(call.preempt).toBe(false);
            expect(call.precision).toBeUndefined();
        }
        const bySeed = new Map();
        for (const call of sim.calls) bySeed.set(call.seed, [...(bySeed.get(call.seed) || []), call.marker].sort());
        expect(bySeed.size).toBe(4);
        for (const markers of bySeed.values()) expect(markers).toEqual(['bad', 'base', 'good']);
    });

    test('draws a fresh seed block, never the analysis seed, even when the generator hands it back', async () => {
        sim.seeds = [4242, 4242, 9001];
        await verifyCombatCandidates({ context: makeContext({ seed: 4242 }), rows: [row('good', 'good')], seeds: 3 });
        expect(sim.calls.length).toBe(6);
        expect(sim.calls.every((c) => c.seed !== 4242)).toBe(true);
        // Three distinct seeds, one per k
        expect(new Set(sim.calls.map((c) => c.seed)).size).toBe(3);
    });

    test('forces a seed when the analysis ran unseeded', async () => {
        await verifyCombatCandidates({ context: makeContext({ seed: null }), rows: [row('good', 'good')], seeds: 2 });
        expect(sim.calls.every((c) => Number.isFinite(c.seed))).toBe(true);
    });

    test('splits hours * multiplier across the seeds', async () => {
        const out = await verifyCombatCandidates({
            context: makeContext({ hours: 24 }),
            rows: [row('good', 'good')],
            seeds: 8,
            hoursMultiplier: 4,
        });
        expect(out.hoursPerSeed).toBe(12);
        expect(sim.calls.every((c) => c.hours === 12)).toBe(true);
    });

    test('judges on the paired per-seed differences with pairedDiff', async () => {
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good'), row('bad', 'bad')],
            seeds: 6,
            metric: 'xp',
        });
        expect(tuning.pairedDiff).toHaveBeenCalledTimes(2);
        const [good, bad] = out.rows;
        // Seed luck is shared by both sides, so it cancels: the gain is the candidate's own, with no spread
        expect(good.key).toBe('key:good');
        expect(good.seeds).toBe(6);
        expect(good.mean).toBeGreaterThan(0);
        expect(good.verdict).toBe('confirmed');
        expect(bad.verdict).toBe('worse');
        expect(out.unit).toBe('%');
    });

    test('reports profit in gold, not percent', async () => {
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 3,
            metric: 'profit',
        });
        expect(out.unit).toBe('gold/hr');
        expect(out.rows[0].mean).toBeCloseTo(500, 6);
    });

    test('a noisy candidate is not confirmed', async () => {
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('wobble', 'wobble')],
            seeds: 6,
            metric: 'xp',
        });
        expect(out.rows[0].verdict).toBe('not-confirmed');
    });

    test('Balanced and EPH metrics produce a finite gain', async () => {
        for (const metric of ['balanced', 'eph', 'dps']) {
            const out = await verifyCombatCandidates({
                context: makeContext(),
                rows: [row('good', 'good')],
                seeds: 3,
                metric,
            });
            expect(Number.isFinite(out.rows[0].mean)).toBe(true);
        }
    });

    test('Balanced sizes the profit term against gross revenue and cost, not net profit', async () => {
        const run = () =>
            verifyCombatCandidates({
                context: makeContext(),
                rows: [row('good', 'good')],
                seeds: 3,
                metric: 'balanced',
            });
        let netOnly;
        let withGross;
        try {
            netOnly = await run();
            sim.gross = 1_000_000;
            withGross = await run();
        } finally {
            delete sim.gross;
        }
        // +500 profit on ~5k net is a ~10% term; on 1M of cash flow it is ~0.05%, so the score drops by
        // about a quarter of that 10% (the profit term is one of four averaged)
        expect(netOnly.rows[0].mean - withGross.rows[0].mean).toBeGreaterThan(2);
    });

    test('Stop mid-run returns what finished, flagged stopped', async () => {
        const state = { stop: false };
        sim.onRun = () => {
            if (sim.calls.length >= 5) state.stop = true;
        };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good'), row('bad', 'bad')],
            seeds: 4,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.rows).toHaveLength(2);
        expect(out.rows.every((r) => r.seeds < 4)).toBe(true);
        expect(sim.calls.length).toBeLessThan(12);
        // A row left with under two seeds proves nothing, and survives JSON
        for (const r of out.rows) {
            if (r.seeds < 2) expect(r.verdict).toBe('not-confirmed');
        }
        expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    });

    test('a candidate that fails to simulate is an error row and the others finish', async () => {
        sim.onRun = (marker) => {
            if (marker === 'boom') throw new Error('engine fell over');
        };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('boom', 'boom'), row('good', 'good')],
            seeds: 3,
            metric: 'xp',
        });
        errorSpy.mockRestore();
        expect(out.rows[0].verdict).toBe('error');
        expect(out.rows[0].error).toBe('engine fell over');
        expect(out.rows[1].verdict).toBe('confirmed');
    });

    test('a candidate that cannot be applied is an error row and costs no simulation', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [{ candidate: { description: 'broken', explode: true } }, row('good', 'good')],
            seeds: 2,
        });
        errorSpy.mockRestore();
        expect(out.rows[0].verdict).toBe('error');
        expect(sim.calls.filter((c) => c.marker !== 'base' && c.marker !== 'good')).toHaveLength(0);
        expect(out.rows[1].verdict).not.toBe('error');
    });

    test('a failing baseline errors every row', async () => {
        sim.onRun = (marker) => {
            if (marker === 'base') throw new Error('baseline down');
        };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const out = await verifyCombatCandidates({ context: makeContext(), rows: [row('good', 'good')], seeds: 2 });
        errorSpy.mockRestore();
        expect(out.error).toBe('baseline down');
        expect(out.rows.map((r) => r.verdict)).toEqual(['error']);
    });

    test('refuses fewer than two seeds, zero rows, an unknown metric and a missing context without simulating', async () => {
        const base = { context: makeContext(), rows: [row('good', 'good')] };
        expect((await verifyCombatCandidates({ ...base, seeds: 1 })).refused).toBe('seeds');
        expect((await verifyCombatCandidates({ ...base, seeds: 0 })).refused).toBe('seeds');
        expect((await verifyCombatCandidates({ ...base, rows: [] })).refused).toBe('rows');
        expect((await verifyCombatCandidates({ ...base, metric: 'nonsense' })).refused).toBe('metric');
        expect((await verifyCombatCandidates({ ...base, context: {} })).refused).toBe('context');
        expect(runSimulation).not.toHaveBeenCalled();
    });

    test('exposes its defaults', () => {
        expect(VERIFY_DEFAULTS).toEqual({ seeds: 8, hoursMultiplier: 4, top: 3 });
    });
});

describe('verifyCombatCandidates profit completeness and held prices', () => {
    test('an unpriced drop on the candidate side makes a profit verify not-confirmed, flagged, with no figure', async () => {
        sim.unpriced = { good: ['Rare Drop'] };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 4,
            metric: 'profit',
        });
        const [good] = out.rows;
        expect(good.verdict).toBe('not-confirmed');
        expect(good.profitLeftOut).toBe(true);
        expect(good.unpriced).toEqual(['Rare Drop']);
        expect(good.mean).toBeNull();
    });

    test('an unpriced item on the baseline side leaves every row not-confirmed on profit, never worse', async () => {
        sim.unpriced = { base: ['Key'] };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good'), row('bad', 'bad')],
            seeds: 4,
            metric: 'profit',
        });
        expect(out.rows.map((r) => r.verdict)).toEqual(['not-confirmed', 'not-confirmed']);
        expect(out.rows.every((r) => r.profitLeftOut)).toBe(true);
    });

    test('balanced leaves the profit term out on both sides and flags it', async () => {
        // The candidate is better on xp, dps and encounters but its profit reads far lower; with profit
        // dropped from the composite the verdict follows the other three
        sim.unpriced = { good: ['Rare Drop'] };
        const withProfit = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 4,
            metric: 'balanced',
        });
        expect(withProfit.rows[0].profitLeftOut).toBe(true);
        expect(withProfit.rows[0].verdict).toBe('confirmed');

        sim.unpriced = {};
        const priced = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 4,
            metric: 'balanced',
        });
        expect(priced.rows[0].profitLeftOut).toBeUndefined();
        // The profit term is gone from one run and present in the other, so the scores differ
        expect(withProfit.rows[0].mean).not.toBe(priced.rows[0].mean);
    });

    test('a fully priced run is unchanged: confirmed, no flag', async () => {
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 4,
            metric: 'profit',
        });
        expect(out.rows[0].verdict).toBe('confirmed');
        expect(out.rows[0].profitLeftOut).toBeUndefined();
        expect(out.rows[0].unpriced).toBeUndefined();
    });

    test('a price change partway through the run does not read as a gain: one cache values every run', async () => {
        // The market jumps as soon as the first candidate starts; the baselines were valued before it
        sim.onRun = (marker) => {
            if (marker !== 'base') sim.price = 1_000_000;
        };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('flat', 'flat')],
            seeds: 4,
            metric: 'profit',
        });
        expect(out.rows[0].verdict).toBe('not-confirmed');
        expect(out.rows[0].mean).toBe(0);
    });
});

describe('verifyLabCandidates', () => {
    const fights = [
        { monsterHrid: '/monsters/a', monsterName: 'A', roomLevel: 10, dto: { hrid: 'p1' } },
        { monsterHrid: '/monsters/b', monsterName: 'B', roomLevel: 20, dto: { hrid: 'p1' } },
        { monsterHrid: '/monsters/c', monsterName: 'C', roomLevel: 30, dto: { hrid: 'p1' } },
    ];
    const labContext = (extra = {}) => ({
        fights,
        crates: [],
        hours: 10,
        communityBuffs: {},
        labyrinthCombatBuffs: [{ base: true }],
        ...extra,
    });
    const labRow = (description, effect, applied = [true, true, true], extra = {}) => ({
        candidate: { description, effect, appliesTo: applied },
        fights: applied.map((a) => ({ applied: a })),
        ...extra,
    });

    test('trial counts come from the new baseline, not the old pairing rules', async () => {
        const out = await verifyLabCandidates({
            context: labContext(),
            pairing: { seed: 5, rules: [[0, { minTrials: 9999, maxTrials: 9999 }]] },
            rows: [labRow('good', 'good')],
            seeds: 2,
        });
        const baselines = sim.labCalls.filter((c) => c.marker === 'base');
        const candidates = sim.labCalls.filter((c) => c.marker === 'good');
        expect(baselines).toHaveLength(6);
        expect(candidates).toHaveLength(6);
        for (const b of baselines) expect(b.precision).toBeNull();
        for (const c of candidates) {
            const base = baselines.find((b) => b.seed === c.seed && b.monsterHrid === c.monsterHrid);
            expect(c.precision).toEqual({
                minTrials: sim.labAttempts(base.seed),
                maxTrials: sim.labAttempts(base.seed),
            });
            expect(c.precision.minTrials).not.toBe(9999);
        }
        expect(out.rows[0].seeds).toBe(2);
    });

    test('baseline and candidate share each fight seed, derived per seed and fight, distinct from the pairing seed', async () => {
        sim.seeds = [5, 31337];
        await verifyLabCandidates({
            context: labContext(),
            pairing: { seed: 5 },
            rows: [labRow('good', 'good')],
            seeds: 2,
        });
        const seeds = new Set(sim.labCalls.map((c) => c.seed));
        // 2 seeds x 3 fights
        expect(seeds.size).toBe(6);
        for (const seed of seeds) {
            const group = sim.labCalls.filter((c) => c.seed === seed);
            expect(group.map((c) => c.marker).sort()).toEqual(['base', 'good']);
        }
    });

    test('per-seed hours split the multiplied total; candidates get the headroom', async () => {
        const out = await verifyLabCandidates({
            context: labContext({ hours: 10 }),
            rows: [labRow('good', 'good')],
            seeds: 4,
            hoursMultiplier: 4,
        });
        expect(out.hoursPerSeed).toBe(10);
        expect(sim.labCalls.filter((c) => c.marker === 'base').every((c) => c.hours === 10)).toBe(true);
        expect(sim.labCalls.filter((c) => c.marker === 'good').every((c) => c.hours === 30)).toBe(true);
    });

    test('fights a row does not reach are neither simulated for it nor counted', async () => {
        const out = await verifyLabCandidates({
            context: labContext(),
            rows: [labRow('good', 'good', [true, false, false])],
            seeds: 2,
        });
        expect(sim.labCalls.every((c) => c.monsterHrid === '/monsters/a')).toBe(true);
        expect(out.rows[0].mean).toBeLessThan(0);
        expect(out.rows[0].verdict).toBe('confirmed');
    });

    test('a worse row is called worse; fewer expected attempts is better', async () => {
        const out = await verifyLabCandidates({
            context: labContext(),
            rows: [labRow('good', 'good'), labRow('worse', 'worse')],
            seeds: 3,
        });
        expect(out.rows[0].verdict).toBe('confirmed');
        expect(out.rows[0].mean).toBeLessThan(0);
        expect(out.rows[1].verdict).toBe('worse');
        expect(out.rows[1].mean).toBeGreaterThan(0);
        expect(tuning.pairedDiff).toHaveBeenCalledTimes(2);
    });

    test('token rows change the buffs, not the loadout', async () => {
        await verifyLabCandidates({
            context: labContext(),
            rows: [
                {
                    candidate: { type: 'labyrinth_buff', description: 'Token', appliesTo: [true, true, true] },
                    fights: [],
                },
            ],
            seeds: 2,
        });
        const tokenRuns = sim.labCalls.filter((c) => c.buffs.length === 2);
        expect(tokenRuns).toHaveLength(6);
        expect(tokenRuns.every((c) => c.marker === 'base')).toBe(true);
    });

    test('a combat-level row also applies its alongside primary-skill boost', async () => {
        const { applyCandidateToDTO } = await import('./upgrade-advisor.js');
        await verifyLabCandidates({
            context: labContext(),
            rows: [
                {
                    candidate: {
                        type: 'combat_level',
                        description: 'Level',
                        effect: 'good',
                        appliesTo: [true, true, true],
                    },
                    alongside: [{ skillKey: 'meleeLevel', upgradeLevel: 90 }],
                    fights: [],
                },
            ],
            seeds: 2,
        });
        expect(applyCandidateToDTO).toHaveBeenCalled();
        // The boosted DTO is the one that was simulated
        expect(runLabyrinthSimulation.mock.calls.some(([p]) => p.playerDTOs[0].meleeLevel === 90)).toBe(true);
    });

    test('Stop mid-run returns a partial result flagged stopped', async () => {
        const state = { stop: false };
        sim.onLabRun = () => {
            if (sim.labCalls.length >= 4) state.stop = true;
        };
        const out = await verifyLabCandidates({
            context: labContext(),
            rows: [labRow('good', 'good')],
            seeds: 4,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.rows[0].seeds).toBeLessThan(4);
        expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    });

    test('a failing candidate is an error row and the rest finish', async () => {
        sim.onLabRun = (marker) => {
            if (marker === 'boom') throw new Error('lab fell over');
        };
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const out = await verifyLabCandidates({
            context: labContext(),
            rows: [labRow('boom', 'boom'), labRow('good', 'good')],
            seeds: 2,
        });
        errorSpy.mockRestore();
        expect(out.rows[0].verdict).toBe('error');
        expect(out.rows[0].error).toBe('lab fell over');
        expect(out.rows[1].verdict).toBe('confirmed');
    });

    test('refuses fewer than two seeds, no rows and no fights without simulating', async () => {
        const rows = [labRow('good', 'good')];
        expect((await verifyLabCandidates({ context: labContext(), rows, seeds: 1 })).refused).toBe('seeds');
        expect((await verifyLabCandidates({ context: labContext(), rows: [], seeds: 4 })).refused).toBe('rows');
        expect((await verifyLabCandidates({ context: labContext({ fights: [] }), rows })).refused).toBe('context');
        expect(runLabyrinthSimulation).not.toHaveBeenCalled();
    });
});

describe('verifyTriggerChanges', () => {
    const tunable = {
        key: 't1',
        original: 30,
        playerIndex: 0,
        slotType: 'abilities',
        slotIndex: 0,
        rowIndex: 0,
        baseRows: [{ value: 30 }],
    };
    const combatResult = (extra = {}) => ({
        objective: 'xp',
        precision: 'standard',
        minGain: 0.5,
        baseSeed: 11,
        changes: [{ key: 't1', to: 50 }],
        verifyContext: {
            kind: 'combat',
            gameData: {},
            playerDTOs: [{ hrid: 'p1', abilities: [{ hrid: 'a', triggers: [{ value: 30 }] }] }],
            playerIndex: 0,
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            communityBuffs: {},
            scopeHrids: ['p1'],
            allHrids: ['p1'],
            tunables: [tunable],
        },
        ...extra,
    });

    test('every sample is valued at the sale taxes the tuner run recorded', async () => {
        sampleOptions.length = 0;
        const result = combatResult();
        result.verifyContext.saleTaxRates = { p1: 0 };
        await verifyTriggerChanges({ result, seeds: 2, hoursMultiplier: 1 });
        expect(sampleOptions.length).toBeGreaterThan(0);
        expect(sampleOptions.every((options) => options.saleTaxRates?.p1 === 0)).toBe(true);
    });

    test('a remembered result cannot be verified', async () => {
        const cached = { objective: 'xp', precision: 'standard', changes: [{ key: 't1', to: 50 }] };
        expect(canVerifyTriggerResult(cached)).toBe(false);
        expect(canVerifyTriggerResult(null)).toBe(false);
        expect(canVerifyTriggerResult(combatResult())).toBe(true);
        expect((await verifyTriggerChanges({ result: cached })).refused).toBe('unavailable');
        expect(runSimulation).not.toHaveBeenCalled();
    });

    test('runs the original and the tuned setup on the same fresh seeds at the multiplied confirm hours', async () => {
        const out = await verifyTriggerChanges({ result: combatResult(), seeds: 8, hoursMultiplier: 4 });
        // standard: 40 h / 4 seeds * 1.5^2 = 22.5 h per confirm seed, 8 confirm seeds, x4 over 8 seeds
        expect(out.hoursPerSeed).toBeCloseTo(22.5 * 4, 6);
        expect(sim.calls).toHaveLength(16);
        expect(sim.calls.every((c) => c.workers === 1 && c.preempt === false && c.seed !== 11)).toBe(true);
        const bySeed = new Map();
        for (const call of sim.calls) bySeed.set(call.seed, (bySeed.get(call.seed) || 0) + 1);
        expect([...bySeed.values()].every((n) => n === 2)).toBe(true);
        expect(out.basis).toBe('recommended');
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0].key).toBe('triggers');
        expect(out.rows[0].seeds).toBe(8);
    });

    test('falls back to the best row found when nothing was recommended, and refuses when there is nothing', async () => {
        const best = combatResult({ changes: [], bestMeasured: { key: 't1', to: 40 } });
        expect((await verifyTriggerChanges({ result: best, seeds: 2 })).basis).toBe('best-found');
        const none = combatResult({ changes: [] });
        expect((await verifyTriggerChanges({ result: none, seeds: 2 })).refused).toBe('nothing');
    });

    test('refuses fewer than two seeds', async () => {
        expect((await verifyTriggerChanges({ result: combatResult(), seeds: 1 })).refused).toBe('seeds');
        expect(runSimulation).not.toHaveBeenCalled();
    });

    test('a Lab group result is verified on attempts with a fixed trial count per fight', async () => {
        const labResult = {
            precision: 'standard',
            minGain: 0.02,
            baseSeed: 3,
            changes: [{ key: 't1', to: 50 }],
            verifyContext: {
                kind: 'lab',
                gameData: {},
                fights: [
                    {
                        monsterHrid: '/monsters/a',
                        roomLevel: 1,
                        dto: { hrid: 'p1', abilities: [{ hrid: 'a', triggers: [{ value: 30 }] }] },
                    },
                ],
                hrid: 'p1',
                zoneHrid: '/actions/combat/fly',
                crates: [],
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                tunables: [tunable],
            },
        };
        const out = await verifyTriggerChanges({ result: labResult, seeds: 2, hoursMultiplier: 1 });
        expect(out.unit).toBe('attempts');
        expect(sim.labCalls).toHaveLength(4);
        const trials = sim.labCalls[0].precision.minTrials;
        expect(sim.labCalls.every((c) => c.precision.minTrials === trials && c.precision.maxTrials === trials)).toBe(
            true
        );
        expect(out.rows[0].seeds).toBe(2);
        expect(JSON.parse(JSON.stringify(out))).toEqual(out);
    });
});

describe('Stop never reads as a confirmation or a failure', () => {
    const fights = [{ monsterHrid: '/monsters/a', monsterName: 'A', roomLevel: 10, dto: { hrid: 'p1' } }];
    const labContext = () => ({
        fights,
        crates: [],
        hours: 10,
        communityBuffs: {},
        labyrinthCombatBuffs: [],
    });
    const labRow = (description, effect) => ({
        candidate: { description, effect, appliesTo: [true] },
        fights: [{ applied: true }],
    });
    const triggerResult = () => ({
        objective: 'xp',
        precision: 'standard',
        minGain: 0.5,
        baseSeed: 11,
        changes: [{ key: 't1', to: 50 }],
        verifyContext: {
            kind: 'combat',
            gameData: {},
            playerDTOs: [{ hrid: 'p1', abilities: [{ hrid: 'a', triggers: [{ value: 30 }] }] }],
            playerIndex: 0,
            zoneHrid: '/actions/combat/fly',
            difficultyTier: 0,
            communityBuffs: {},
            scopeHrids: ['p1'],
            allHrids: ['p1'],
            tunables: [
                {
                    key: 't1',
                    original: 30,
                    playerIndex: 0,
                    slotType: 'abilities',
                    slotIndex: 0,
                    rowIndex: 0,
                    baseRows: [{ value: 30 }],
                },
            ],
        },
    });

    test('a stopped Combat run with a few consistent seeds is not confirmed', async () => {
        const state = { stop: false };
        sim.onRun = () => {
            // Eight baselines, then a few candidate seeds, then Stop
            if (sim.calls.length >= 12) state.stop = true;
        };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 8,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.rows[0].seeds).toBeGreaterThanOrEqual(2);
        expect(out.rows[0].seeds).toBeLessThan(8);
        expect(out.rows[0].verdict).toBe('not-confirmed');
    });

    test('a stopped Lab run with a few consistent seeds is not confirmed', async () => {
        const state = { stop: false };
        sim.onLabRun = () => {
            if (sim.labCalls.length >= 12) state.stop = true;
        };
        const out = await verifyLabCandidates({
            context: labContext(),
            rows: [labRow('good', 'good')],
            seeds: 8,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.rows[0].seeds).toBeGreaterThanOrEqual(2);
        expect(out.rows[0].seeds).toBeLessThan(8);
        expect(out.rows[0].verdict).toBe('not-confirmed');
    });

    test('a stopped trigger verify with a few seeds is not confirmed', async () => {
        const state = { stop: false };
        sim.onRun = () => {
            if (sim.calls.length >= 8) state.stop = true;
        };
        const out = await verifyTriggerChanges({
            result: triggerResult(),
            seeds: 8,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.rows[0].seeds).toBeLessThan(8);
        expect(out.rows[0].verdict).not.toBe('confirmed');
    });

    test('Stop terminating a combat trigger verify in flight keeps the seeds that finished', async () => {
        const state = { stop: false };
        sim.onRun = () => {
            // Four seeds' pairs finish; then Stop, whose cancel rejects every simulation still running
            if (sim.calls.length > 8) {
                state.stop = true;
                throw new Error('Cancelled');
            }
        };
        const out = await verifyTriggerChanges({ result: triggerResult(), seeds: 8, abortSignal: () => state.stop });
        expect(out.stopped).toBe(true);
        expect(out.error).toBeUndefined();
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0].seeds).toBe(4);
        expect(out.rows[0].verdict).toBe('not-confirmed');
    });

    test('a trigger verify whose every simulation was cancelled with no Stop is a failure, not a zero-seed verdict', async () => {
        sim.onRun = () => {
            throw new Error('Cancelled');
        };
        const out = await verifyTriggerChanges({ result: triggerResult(), seeds: 2, abortSignal: () => false });
        expect(out.stopped).toBe(false);
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0].verdict).toBe('error');
        expect(out.rows[0].seeds).toBe(0);
    });

    test('another simulator cancelling a trigger verify mid-run (no Stop of ours) is a failure, not a partial', async () => {
        sim.onRun = () => {
            // Four seeds' pairs finish; then someone else's cancelActiveSimulations() rejects the rest
            if (sim.calls.length > 8) throw new Error('Cancelled');
        };
        const out = await verifyTriggerChanges({ result: triggerResult(), seeds: 8, abortSignal: () => false });
        expect(out.stopped).toBe(false);
        expect(out.rows).toHaveLength(1);
        expect(out.rows[0].verdict).toBe('error');
        expect(out.error).toBeTruthy();
    });

    test('another simulator cancelling a lab trigger verify mid-run is a failure, not a partial', async () => {
        sim.onLabRun = () => {
            if (sim.labCalls.length > 4) throw new Error('Cancelled');
        };
        const labResult = {
            ...triggerResult(),
            verifyContext: {
                kind: 'lab',
                gameData: {},
                fights: [
                    { monsterHrid: '/monsters/a', roomLevel: 1, dto: triggerResult().verifyContext.playerDTOs[0] },
                ],
                hrid: 'p1',
                zoneHrid: '/actions/combat/fly',
                crates: [],
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                tunables: triggerResult().verifyContext.tunables,
            },
        };
        const out = await verifyTriggerChanges({ result: labResult, seeds: 8, abortSignal: () => false });
        expect(out.stopped).toBe(false);
        expect(out.rows[0].verdict).toBe('error');
        expect(out.error).toBeTruthy();
    });

    test('another simulator cancelling a Combat candidate (no Stop of ours) is an error row, not a dropped seed', async () => {
        // One seed finishes; the other is cancelled from elsewhere
        let goodRuns = 0;
        sim.onRun = (marker) => {
            if (marker === 'good' && ++goodRuns === 2) throw new Error('Cancelled');
        };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 2,
            abortSignal: () => false,
        });
        expect(out.stopped).toBe(false);
        expect(out.rows[0].verdict).toBe('error');
    });

    test('Stop terminating a lab trigger verify in flight keeps the seeds that finished', async () => {
        const state = { stop: false };
        sim.onLabRun = () => {
            if (sim.labCalls.length > 4) {
                state.stop = true;
                throw new Error('Cancelled');
            }
        };
        const labResult = {
            ...triggerResult(),
            verifyContext: {
                kind: 'lab',
                gameData: {},
                fights: [
                    { monsterHrid: '/monsters/a', roomLevel: 1, dto: triggerResult().verifyContext.playerDTOs[0] },
                ],
                hrid: 'p1',
                zoneHrid: '/actions/combat/fly',
                crates: [],
                communityBuffs: {},
                labyrinthCombatBuffs: [],
                tunables: triggerResult().verifyContext.tunables,
            },
        };
        const out = await verifyTriggerChanges({ result: labResult, seeds: 8, abortSignal: () => state.stop });
        expect(out.stopped).toBe(true);
        expect(out.error).toBeUndefined();
        expect(out.rows[0].seeds).toBe(2);
        expect(out.rows[0].verdict).toBe('not-confirmed');
    });

    test('Stop during the Combat baseline is a stop, not an error', async () => {
        const state = { stop: false };
        sim.onRun = () => {
            state.stop = true;
            throw new Error('Cancelled');
        };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 2,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.error).toBeUndefined();
        expect(out.rows.some((r) => r.verdict === 'error')).toBe(false);
    });

    test('a candidate cancelled by Stop is not an error row', async () => {
        const state = { stop: false };
        sim.onRun = (marker) => {
            if (marker === 'good') {
                state.stop = true;
                throw new Error('Cancelled');
            }
        };
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('good', 'good')],
            seeds: 2,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.rows.some((r) => r.verdict === 'error')).toBe(false);
    });

    test('Stop during the Lab baseline is a stop, not an error', async () => {
        const state = { stop: false };
        sim.onLabRun = () => {
            // Stop lands while the candidates are already waiting on their baselines
            queueMicrotask(() => {
                state.stop = true;
            });
            throw new Error('Cancelled');
        };
        const out = await verifyLabCandidates({
            context: labContext(),
            rows: [labRow('good', 'good')],
            seeds: 2,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.error).toBeUndefined();
        expect(out.rows.some((r) => r.verdict === 'error')).toBe(false);
    });

    test('Stop during a trigger verify is a stop, not an error', async () => {
        const state = { stop: false };
        sim.onRun = () => {
            state.stop = true;
            throw new Error('Cancelled');
        };
        const out = await verifyTriggerChanges({
            result: triggerResult(),
            seeds: 2,
            abortSignal: () => state.stop,
        });
        expect(out.stopped).toBe(true);
        expect(out.error).toBeUndefined();
        expect(out.rows.some((r) => r.verdict === 'error')).toBe(false);
    });

    test('a Combat row with no usable seed (every gain non-finite) is an error, not a verdict', async () => {
        const out = await verifyCombatCandidates({
            context: makeContext(),
            rows: [row('nan', 'nan')],
            seeds: 2,
            metric: 'profit',
        });
        expect(out.stopped).toBe(false);
        expect(out.rows[0].verdict).toBe('error');
    });
});
