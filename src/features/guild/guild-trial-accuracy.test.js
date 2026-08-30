/**
 * The attribution-accuracy arithmetic.
 *
 * Three things are worth pinning here and none of them are drawing: that a name
 * on one side of the join only is counted rather than scored, that a metric the
 * game never reported does not enter its median as a perfect score, and that the
 * archive fold stays additive so a cycle written before it existed still reads.
 */

import { describe, test, expect } from 'vitest';

import {
    ACCURACY_METRICS,
    OUTLIER_THRESHOLD_PCT,
    archivedAccuracyTrend,
    compactAccuracySummary,
    deltaPct,
    joinTrialStats,
    measuredOnlyNames,
    summarizeTrialAccuracy,
    summarizeWeekAccuracy,
} from './guild-trial-accuracy.js';

/** A pair where every name matches and the measurement is exactly right */
function perfectPair() {
    const reported = {
        Alice: { damage: 1000, healing: 200, taken: 300 },
        Bob: { damage: 500, healing: 0, taken: 100 },
    };
    return { reported, measured: JSON.parse(JSON.stringify(reported)) };
}

describe('deltaPct', () => {
    test('measures against the game figure', () => {
        expect(deltaPct(110, 100)).toBeCloseTo(10);
        expect(deltaPct(90, 100)).toBeCloseTo(-10);
    });

    test('a measured figure the game never reported is infinitely wrong', () => {
        expect(deltaPct(50, 0)).toBe(Infinity);
    });

    test('measuring nothing where nothing was reported is exactly right', () => {
        expect(deltaPct(0, 0)).toBe(0);
    });
});

describe('joinTrialStats', () => {
    test('orders by reported damage so the biggest contributors read first', () => {
        const rows = joinTrialStats(perfectPair());
        expect(rows.map((row) => row.name)).toEqual(['Alice', 'Bob']);
    });

    test('marks a reported name with no measured row unmatched, not zero-scored', () => {
        const rows = joinTrialStats({
            reported: { Alice: { damage: 100 }, Renamed: { damage: 100 } },
            measured: { Alice: { damage: 100 } },
        });
        const renamed = rows.find((row) => row.name === 'Renamed');
        expect(renamed.matched).toBe(false);
        // The cell still fills in — the row is in the table — but nothing is
        // entitled to read the -100% off it as a measurement failure
        expect(renamed.damage.deltaPct).toBe(-100);
        expect(rows.find((row) => row.name === 'Alice').matched).toBe(true);
    });

    test('a measured row of all zeroes still counts as matched', () => {
        const rows = joinTrialStats({
            reported: { Alice: { damage: 100 } },
            measured: { Alice: { damage: 0, healing: 0, taken: 0 } },
        });
        expect(rows[0].matched).toBe(true);
    });

    test('no reported side is no rows at all', () => {
        expect(joinTrialStats({ measured: { Alice: { damage: 1 } } })).toEqual([]);
        expect(joinTrialStats()).toEqual([]);
    });
});

describe('measuredOnlyNames', () => {
    test('names the measurement found that the game never mentioned', () => {
        expect(measuredOnlyNames({ Alice: {} }, { Alice: {}, Ghost: {} })).toEqual(['Ghost']);
    });

    test('tolerates either side missing', () => {
        expect(measuredOnlyNames(null, null)).toEqual([]);
        expect(measuredOnlyNames(null, { Ghost: {} })).toEqual(['Ghost']);
    });
});

describe('summarizeTrialAccuracy', () => {
    test('a perfect measurement is zero everywhere with nobody listed', () => {
        const accuracy = summarizeTrialAccuracy(perfectPair());
        for (const { key } of ACCURACY_METRICS) {
            expect(accuracy.metrics[key].median).toBe(0);
            expect(accuracy.totals[key].deltaPct).toBe(0);
        }
        expect(accuracy.outliers).toEqual([]);
        expect(accuracy.unmatched).toBe(0);
    });

    test('a metric the game reported nothing for is excluded, not scored perfect', () => {
        // Bob has no reported healing at all. Counting his row as a flawless 0%
        // would halve Alice's healing median by averaging it with a figure
        // nothing measured
        const accuracy = summarizeTrialAccuracy({
            reported: {
                Alice: { damage: 1000, healing: 100, taken: 0 },
                Bob: { damage: 1000, healing: 0, taken: 0 },
            },
            measured: {
                Alice: { damage: 1000, healing: 140, taken: 0 },
                Bob: { damage: 1000, healing: 0, taken: 0 },
            },
        });
        expect(accuracy.metrics.healing.players).toBe(1);
        expect(accuracy.metrics.healing.missing).toBe(1);
        expect(accuracy.metrics.healing.median).toBeCloseTo(40);
        // Nobody reported anything taken, so the metric has no denominator
        expect(accuracy.metrics.taken.players).toBe(0);
        expect(accuracy.metrics.taken.median).toBeNull();
        expect(accuracy.metrics.taken.worst).toBeNull();
    });

    test('unmatched names are counted and kept out of the medians and totals', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: {
                Alice: { damage: 1000, healing: 0, taken: 0 },
                Renamed: { damage: 1000, healing: 0, taken: 0 },
            },
            measured: { Alice: { damage: 1000, healing: 0, taken: 0 } },
        });
        expect(accuracy.players).toBe(2);
        expect(accuracy.matched).toBe(1);
        expect(accuracy.unmatched).toBe(1);
        expect(accuracy.unmatchedNames).toEqual(['Renamed']);
        // The one matched player was measured exactly; the unmatched name does
        // not drag the party total to -50%
        expect(accuracy.metrics.damage.median).toBe(0);
        expect(accuracy.totals.damage.reported).toBe(1000);
        expect(accuracy.totals.damage.deltaPct).toBe(0);
        expect(accuracy.outliers).toEqual([]);
    });

    test('a join that matched nobody has no total to report, rather than a perfect one', () => {
        // Every reported name unmatched — the whole-week rename case, or a
        // stream that never resolved display names. The totals are summed over
        // matched rows only, so both sides come to 0, and `deltaPct(0, 0)` is
        // 0 by the "measured nothing where nothing was reported" rule. That
        // rule is right per player and manufactures a perfect score over an
        // empty set: the ledger card headlines the trial "+0.0%" in green.
        const accuracy = summarizeTrialAccuracy({
            reported: {
                AliceOld: { damage: 1000, healing: 500, taken: 200 },
                BobOld: { damage: 800, healing: 0, taken: 300 },
            },
            measured: { AliceNew: { damage: 990, healing: 480, taken: 210 } },
        });

        expect(accuracy.matched).toBe(0);
        for (const { key } of ACCURACY_METRICS) {
            expect(accuracy.totals[key].deltaPct).toBeNull();
        }
    });

    test('a name only the measurement knows is counted from the other end', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: { Alice: { damage: 100 } },
            measured: { Alice: { damage: 100 }, Ghost: { damage: 50 } },
        });
        expect(accuracy.measuredOnly).toBe(1);
        expect(accuracy.players).toBe(1);
    });

    test('lists a player past the threshold, worst metric first', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: {
                Alice: { damage: 1000, healing: 100, taken: 100 },
                Bob: { damage: 1000, healing: 100, taken: 100 },
            },
            measured: {
                // 2% off on damage — inside the band, not news
                Alice: { damage: 1020, healing: 100, taken: 100 },
                // 60% off on healing, 5% on damage: healing is the one named
                Bob: { damage: 1050, healing: 160, taken: 100 },
            },
        });
        expect(accuracy.outliers).toHaveLength(1);
        expect(accuracy.outliers[0].name).toBe('Bob');
        expect(accuracy.outliers[0].worstMetric).toBe('healing');
        expect(accuracy.outliers[0].worstDeltaPct).toBeCloseTo(60);
        expect(accuracy.threshold).toBe(OUTLIER_THRESHOLD_PCT);
    });

    test('the threshold is a listing rule, not a verdict on the medians', () => {
        const pair = {
            reported: { Alice: { damage: 1000, healing: 0, taken: 0 } },
            measured: { Alice: { damage: 1100, healing: 0, taken: 0 } },
        };
        expect(summarizeTrialAccuracy({ ...pair, threshold: 5 }).outliers).toHaveLength(1);
        expect(summarizeTrialAccuracy({ ...pair, threshold: 50 }).outliers).toHaveLength(0);
        expect(summarizeTrialAccuracy({ ...pair, threshold: 50 }).metrics.damage.median).toBeCloseTo(10);
    });

    test('the worst delta keeps its sign', () => {
        const accuracy = summarizeTrialAccuracy({
            reported: { Alice: { damage: 1000 }, Bob: { damage: 1000 } },
            measured: { Alice: { damage: 1100 }, Bob: { damage: 700 } },
        });
        expect(accuracy.metrics.damage.worst).toBeCloseTo(-30);
        expect(accuracy.metrics.damage.median).toBeCloseTo(20);
    });

    test('an empty pair summarizes to nothing rather than throwing', () => {
        const accuracy = summarizeTrialAccuracy({});
        expect(accuracy.players).toBe(0);
        expect(accuracy.metrics.damage.median).toBeNull();
        // Not 0: no matched rows is nothing to report, the same as the
        // wholesale-rename case above. A 0 here draws as a green "+0.0%".
        expect(accuracy.totals.damage.deltaPct).toBeNull();
    });
});

describe('summarizeWeekAccuracy', () => {
    test('one entry per encounter, oldest first', () => {
        const week = summarizeWeekAccuracy({
            later: { reported: { A: { damage: 1 } }, measured: { A: { damage: 1 } }, at: 200 },
            earlier: { reported: { A: { damage: 1 } }, measured: { A: { damage: 1 } }, at: 100 },
        });
        expect(week.map((entry) => entry.encounter)).toEqual(['earlier', 'later']);
    });

    test('tolerates a missing or junk blob', () => {
        expect(summarizeWeekAccuracy(null)).toEqual([]);
        expect(summarizeWeekAccuracy({ broken: null })).toEqual([]);
    });
});

describe('compactAccuracySummary', () => {
    test('keeps the medians and the counts and drops the per-player table', () => {
        const compact = compactAccuracySummary({
            elite: {
                at: 5,
                reported: { Alice: { damage: 1000 }, Renamed: { damage: 1000 } },
                measured: { Alice: { damage: 1200 } },
            },
        });
        expect(Object.keys(compact)).toEqual(['elite']);
        expect(compact.elite).toEqual({
            at: 5,
            players: 2,
            matched: 1,
            unmatched: 1,
            measuredOnly: 0,
            metrics: {
                damage: { median: 20, worst: 20, players: 1 },
                healing: { median: null, worst: null, players: 0 },
                taken: { median: null, worst: null, players: 0 },
            },
        });
        expect(JSON.stringify(compact)).not.toContain('Alice');
    });

    test('an unreported metric survives the round trip as null, not zero', () => {
        const compact = compactAccuracySummary({
            elite: { at: 1, reported: { A: { damage: 100 } }, measured: { A: { damage: 100 } } },
        });
        expect(compact.elite.metrics.healing.median).toBeNull();
    });
});

describe('archivedAccuracyTrend', () => {
    /** An archive entry as `archiveCycle` writes one, with accuracy folded in */
    function cycle(weekStart, damageMedian, extra = {}) {
        return {
            archivedAt: weekStart + 1,
            reason: 'a new cycle is scheduled',
            weekStart,
            tiles: {},
            accuracy: {
                elite: {
                    at: weekStart,
                    players: 10,
                    matched: 10,
                    unmatched: 0,
                    measuredOnly: 0,
                    metrics: {
                        damage: { median: damageMedian, worst: damageMedian * 2, players: 10 },
                        healing: { median: null, worst: null, players: 0 },
                        taken: { median: null, worst: null, players: 0 },
                    },
                },
            },
            ...extra,
        };
    }

    test('one point per archived cycle, in the order they were archived', () => {
        const trend = archivedAccuracyTrend([cycle(100, 3), cycle(200, 5)]);
        expect(trend.map((entry) => entry.weekStart)).toEqual([100, 200]);
        expect(trend.map((entry) => entry.metrics.damage.median)).toEqual([3, 5]);
        expect(trend.every((entry) => entry.hasAccuracy)).toBe(true);
    });

    test('an old archive with no accuracy key says so rather than reading as perfect', () => {
        const old = { archivedAt: 5, reason: 'a new cycle is scheduled', weekStart: 4, tiles: { a: {} } };
        const trend = archivedAccuracyTrend([old, cycle(100, 3)]);
        expect(trend[0].hasAccuracy).toBe(false);
        expect(trend[0].trials).toBe(0);
        expect(trend[0].metrics).toEqual({});
        expect(trend[0].weekStart).toBe(4);
        expect(trend[1].hasAccuracy).toBe(true);
    });

    test('an entry whose accuracy is present but empty is treated as absent', () => {
        expect(archivedAccuracyTrend([{ weekStart: 1, accuracy: {} }])[0].hasAccuracy).toBe(false);
    });

    test("a cycle's figure is the middle of its trials' medians, and its worst the widest", () => {
        const entry = {
            weekStart: 1,
            accuracy: {
                one: { metrics: { damage: { median: 2, worst: 9, players: 5 } }, unmatched: 1 },
                two: { metrics: { damage: { median: 6, worst: -20, players: 5 } }, unmatched: 2 },
            },
        };
        const [folded] = archivedAccuracyTrend([entry]);
        expect(folded.trials).toBe(2);
        expect(folded.metrics.damage.median).toBe(4);
        expect(folded.metrics.damage.worst).toBe(-20);
        expect(folded.metrics.damage.players).toBe(10);
        expect(folded.unmatched).toBe(3);
    });

    test('tolerates no history at all', () => {
        expect(archivedAccuracyTrend(null)).toEqual([]);
        expect(archivedAccuracyTrend([null])).toEqual([]);
    });
});
