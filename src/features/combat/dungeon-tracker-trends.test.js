/** @vitest-environment happy-dom
 *
 * Run-over-run trends for the dungeon history.
 *
 * The math is the point: a window of runs is faster, slower or the same as the
 * window before it, a run is faster or slower than the five before it, and a
 * handful of runs is not a trend at all. The rendering test is here for the one
 * claim the stored data cannot support — earnings — which the block must never
 * make.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('./dungeon-tracker-storage.js', () => ({
    default: {
        getAllRuns: async () => [],
        deleteRun: async () => true,
    },
    filterRunsForCharacter: (runs) => runs,
    currentCharacter: () => 'me',
    runIdentity: (run) => `${run?.teamKey ?? ''}|${run?.timestamp ?? ''}|${run?.duration ?? ''}`,
}));
vi.mock('../../utils/formatters.js', () => ({ formatDateTime: () => '04/08 10:00' }));

const {
    computeTrend,
    buildTrends,
    buildRunDeltas,
    trendsFor,
    directionMarker,
    runDurationMs,
    trendKey,
    NOT_ENOUGH_RUNS,
    MIN_RUNS_FOR_TREND,
    _resetTrendMemo,
} = await import('./dungeon-tracker-trends.js');

const { default: DungeonTrackerUIHistory } = await import('./dungeon-tracker-ui-history.js');

/**
 * Runs newest first, from durations given newest first.
 * @param {Array<number>} durations - Milliseconds, newest run first
 * @param {Object} [extra] - Fields every run carries
 * @returns {Array<Object>} Stored-shaped runs
 */
function runs(durations, extra = {}) {
    return durations.map((duration, i) => ({
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        dungeonName: 'Chimerical Den',
        tier: 1,
        teamKey: 'Aster,Briar',
        duration,
        ...extra,
    }));
}

/** Ten runs of `ms` each, as one window. */
const window10 = (ms) => Array.from({ length: 10 }, () => ms);

describe('computeTrend', () => {
    test('improving: the recent window is faster than the one before it', () => {
        const trend = computeTrend(runs([...window10(80000), ...window10(100000)]));

        expect(trend.recentAvgMs).toBe(80000);
        expect(trend.priorAvgMs).toBe(100000);
        expect(trend.direction).toBe('faster');
        expect(trend.changePercent).toBeCloseTo(20);
        expect(directionMarker(trend.direction)).toBe('▼');
    });

    test('worsening: the recent window is slower', () => {
        const trend = computeTrend(runs([...window10(120000), ...window10(100000)]));

        expect(trend.direction).toBe('slower');
        expect(trend.changePercent).toBeCloseTo(-20);
        expect(directionMarker(trend.direction)).toBe('▲');
    });

    test('flat: a sub-percent difference is the same average', () => {
        const trend = computeTrend(runs([...window10(100500), ...window10(100000)]));

        expect(trend.direction).toBe('flat');
        expect(directionMarker(trend.direction)).toBe('→');
    });

    test('runs per hour comes from the recent average', () => {
        const trend = computeTrend(runs(window10(120000)));

        expect(trend.runsPerHour).toBeCloseTo(30);
    });

    test('a shorter earlier window still compares, once it has enough runs', () => {
        const trend = computeTrend(runs([...window10(80000), 100000, 100000, 100000]));

        expect(trend.priorAvgMs).toBe(100000);
        expect(trend.direction).toBe('faster');
    });

    test('too few earlier runs: a rate, but no comparison invented for it', () => {
        const trend = computeTrend(runs([...window10(80000), 100000, 100000]));

        expect(trend.recentAvgMs).toBe(80000);
        expect(trend.priorAvgMs).toBeNull();
        expect(trend.direction).toBeNull();
        expect(trend.changePercent).toBeNull();
        expect(trend.runsPerHour).toBeCloseTo(45);
    });
});

describe('the not-enough-runs guard', () => {
    test('below the minimum there is no average and no rate', () => {
        const trend = computeTrend(runs([100000, 100000]));

        expect(trend.enough).toBe(false);
        expect(trend.recentAvgMs).toBeNull();
        expect(trend.runsPerHour).toBeNull();
        expect(trend.direction).toBeNull();
    });

    test('the minimum itself is enough', () => {
        const trend = computeTrend(runs(Array(MIN_RUNS_FOR_TREND).fill(100000)));

        expect(trend.enough).toBe(true);
        expect(trend.runsPerHour).toBeCloseTo(36);
    });

    test('runs with no usable duration are not runs, and never divide', () => {
        const trend = computeTrend([
            { dungeonName: 'Chimerical Den', tier: 1, duration: 0 },
            { dungeonName: 'Chimerical Den', tier: 1, duration: null },
            { dungeonName: 'Chimerical Den', tier: 1 },
        ]);

        expect(trend.runCount).toBe(0);
        expect(trend.enough).toBe(false);
        expect(trend.recentAvgMs).toBeNull();
        expect(trend.runsPerHour).toBeNull();
    });

    test('an empty history trends nothing', () => {
        expect(buildTrends([])).toEqual([]);
        expect(computeTrend([]).enough).toBe(false);
    });

    test('duration falls back to the older totalTime field', () => {
        expect(runDurationMs({ totalTime: 5000 })).toBe(5000);
        expect(runDurationMs({ duration: -1 })).toBeNull();
    });
});

describe('grouping', () => {
    test('a dungeon at two tiers is two groups', () => {
        const list = [...runs(window10(80000), { tier: 2 }), ...runs(window10(100000), { tier: 1 })];
        const groups = buildTrends(list);

        expect(groups).toHaveLength(2);
        expect(groups.map((g) => g.label).sort()).toEqual(['Chimerical Den T1', 'Chimerical Den T2']);
    });

    test('a run recorded without a tier groups on its own', () => {
        expect(trendKey({ dungeonName: 'Pirate Cove', tier: null })).toBe('Pirate Cove::T?');
        expect(trendKey({ dungeonName: 'Pirate Cove', tier: 0 })).toBe('Pirate Cove::T0');
    });
});

describe('rolling-average delta', () => {
    test('a run faster than the previous five is marked faster', () => {
        // Newest first: the newest run is 50s against five 100s runs behind it
        const list = runs([50000, 100000, 100000, 100000, 100000, 100000]);
        const deltas = buildRunDeltas(list);
        const newest = deltas.get(`Aster,Briar|${list[0].timestamp}|50000`);

        expect(newest.direction).toBe('faster');
        expect(newest.deltaMs).toBe(-50000);
        expect(newest.percent).toBeCloseTo(50);
    });

    test('a slower run, and only the previous five count', () => {
        // Behind the newest run: five 100s runs, then a 1000s run it must ignore
        const list = runs([150000, 100000, 100000, 100000, 100000, 100000, 1000000]);
        const deltas = buildRunDeltas(list);
        const newest = deltas.get(`Aster,Briar|${list[0].timestamp}|150000`);

        expect(newest.direction).toBe('slower');
        expect(newest.percent).toBeCloseTo(-50);
    });

    test('a run without enough history behind it gets no delta', () => {
        const list = runs([100000, 100000, 100000]);
        const deltas = buildRunDeltas(list);

        // Oldest two have 1 and 0 runs behind them; the newest has exactly two
        expect(deltas.size).toBe(0);
    });

    test('deltas are measured within a dungeon+tier, not across them', () => {
        const t1 = runs([100000, 100000, 100000, 100000], { tier: 1 });
        const t2 = runs([50000, 10000, 10000, 10000], { tier: 2 });
        const deltas = buildRunDeltas([...t2, ...t1]);
        const newestT2 = deltas.get(`Aster,Briar|${t2[0].timestamp}|50000`);

        // Against its own tier's 10s runs, not the 100s runs of the other tier
        expect(newestT2.direction).toBe('slower');
        expect(newestT2.deltaMs).toBe(40000);
    });
});

describe('memoisation', () => {
    beforeEach(() => _resetTrendMemo());

    test('the same data recomputes nothing; changed data recomputes', () => {
        const list = runs(window10(100000));

        const first = trendsFor(list);
        // A fresh copy, as the panel is handed on every redraw
        expect(trendsFor([...list])).toBe(first);

        const changed = trendsFor([...runs([50000]), ...list]);
        expect(changed).not.toBe(first);
        expect(changed.groups[0].trend.runCount).toBe(11);
    });
});

describe('the rendered trends block', () => {
    /**
     * @param {Array<Object>} list - Runs to render trends for
     * @returns {HTMLElement} The block
     */
    function render(list) {
        _resetTrendMemo();
        const history = new DungeonTrackerUIHistory({}, (ms) => `${Math.round(ms / 1000)}s`);
        return history.trendsBlock(trendsFor(list).groups);
    }

    test('claims nothing about tokens or earnings — the stored run shape records none', () => {
        const block = render(runs([...window10(80000), ...window10(100000)]));
        const text = block.textContent;

        expect(text).toMatch(/runs\/hr/);
        expect(text).not.toMatch(/token/i);
        expect(text).not.toMatch(/gold|coin|earn|profit|\/hr gold/i);
    });

    test('a group with too few runs says so instead of quoting a rate', () => {
        const text = render(runs([100000, 100000])).textContent;

        expect(text).toContain(NOT_ENOUGH_RUNS);
        expect(text).not.toMatch(/runs\/hr/);
    });

    test('one row per dungeon+tier, with the direction marker', () => {
        const block = render([
            ...runs([...window10(80000), ...window10(100000)], { tier: 1 }),
            ...runs(window10(90000), { tier: 2 }),
        ]);
        const rows = block.querySelectorAll('[data-trend-key]');

        expect(rows).toHaveLength(2);
        expect(block.textContent).toContain('▼');
        expect(block.textContent).toContain('20.0% faster');
    });

    test('a per-run marker sits on runs that have five behind them', () => {
        _resetTrendMemo();
        const history = new DungeonTrackerUIHistory({}, (ms) => `${Math.round(ms / 1000)}s`);
        const list = runs([50000, 100000, 100000, 100000, 100000, 100000]);
        const html = history.renderRunList(list, trendsFor(list).deltas);

        expect(html).toContain('mwi-dt-run-delta');
        expect(html).toContain('50%');
    });
});
