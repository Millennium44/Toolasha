/**
 * The calibration arithmetic.
 *
 * What is worth pinning down here is not that a percentage divides — it is the
 * two ways this feature could lie. Calling a gap "persistent" off three runs
 * would have players rebuilding a loadout because of one bad drop table roll,
 * and letting a single spectacular run set the verdict would do the same from
 * the other direction. Both rules are asserted below.
 */

import { describe, test, expect } from 'vitest';
import {
    deviationPercent,
    median,
    mean,
    summarizeCalibration,
    dailySeries,
    xpGoldSplit,
    cohortSplit,
    actionSplit,
    bidSpread,
    DEFAULT_GAP_PERCENT,
} from './calibration-math.js';

const HOUR = 3600_000;

/**
 * A record, with only the fields the arithmetic reads.
 * @param {string} actionType - Skill
 * @param {number} predicted - Predicted per hour
 * @param {number} actual - Actual per hour
 * @param {number} [t] - When it finished
 * @returns {Object}
 */
const record = (actionType, predicted, actual, t = Date.now()) => ({ actionType, predicted, actual, t });

describe('deviationPercent', () => {
    test('is negative when the run paid less than promised', () => {
        expect(deviationPercent(1000, 800)).toBe(-20);
        expect(deviationPercent(1000, 1250)).toBe(25);
    });

    test('refuses a prediction with no scale to be wrong against', () => {
        expect(deviationPercent(0, 500)).toBeNull();
        expect(deviationPercent(0.5, 500)).toBeNull();
        expect(deviationPercent(NaN, 500)).toBeNull();
        expect(deviationPercent(1000, undefined)).toBeNull();
    });

    test('measures a negative prediction against its own size', () => {
        // A loss forecast at -1000 that came in at -500 is 50% better, not worse
        expect(deviationPercent(-1000, -500)).toBe(50);
    });
});

describe('median and mean', () => {
    test('median takes the middle, mean takes the weight', () => {
        expect(median([5, 1, 3])).toBe(3);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(mean([1, 2, 3])).toBe(2);
    });

    test('nothing in, null out', () => {
        expect(median([])).toBeNull();
        expect(mean([NaN, undefined])).toBeNull();
    });
});

describe('summarizeCalibration', () => {
    test('groups by action type and ranks the worst gap first', () => {
        const records = [
            ...Array.from({ length: 6 }, () => record('milking', 1000, 950)),
            ...Array.from({ length: 6 }, () => record('cooking', 1000, 500)),
        ];

        const summary = summarizeCalibration(records);

        expect(summary.groups.map((group) => group.actionType)).toEqual(['cooking', 'milking']);
        expect(summary.groups[0].medianDeviation).toBe(-50);
        expect(summary.overall.samples).toBe(12);
    });

    test('needs enough runs before it calls a gap persistent', () => {
        const few = Array.from({ length: 4 }, () => record('cooking', 1000, 400));
        expect(summarizeCalibration(few).flagged).toHaveLength(0);

        const enough = Array.from({ length: 5 }, () => record('cooking', 1000, 400));
        const flagged = summarizeCalibration(enough).flagged;
        expect(flagged).toHaveLength(1);
        expect(flagged[0].direction).toBe('optimistic');
    });

    test('one lucky run does not speak for the skill', () => {
        // Five honest runs and one that hit a rare drop worth ten hours of profit
        const records = [
            ...Array.from({ length: 5 }, () => record('foraging', 1000, 1000)),
            record('foraging', 1000, 11000),
        ];

        const group = summarizeCalibration(records).groups[0];

        // The mean is dragged way up; the median — and so the verdict — is not
        expect(group.actualMean).toBeGreaterThan(2000);
        expect(group.medianDeviation).toBe(0);
        expect(group.flagged).toBe(false);
    });

    test('a pessimistic calculator is flagged too', () => {
        const records = Array.from({ length: 6 }, () => record('brewing', 1000, 1000 + DEFAULT_GAP_PERCENT * 20));
        expect(summarizeCalibration(records).flagged[0].direction).toBe('pessimistic');
    });

    test('honours a window and ignores unusable pairs', () => {
        const now = 10 * 24 * HOUR;
        const records = [
            record('milking', 1000, 500, now - 9 * 24 * HOUR),
            record('milking', 1000, 900, now - HOUR),
            record('milking', null, 900, now - HOUR),
        ];

        const summary = summarizeCalibration(records, { now, windowMs: 24 * HOUR });
        expect(summary.overall.samples).toBe(1);
        expect(summary.overall.medianDeviation).toBe(-10);
    });
});

describe('dailySeries', () => {
    /** `YYYY-MM-DD` for a local time, the way the reader's own calendar reads it. */
    const localDay = (date) =>
        `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    /** A local time on a given day, so the test says the same thing in every timezone. */
    const at = (year, month, day, hour) => new Date(year, month - 1, day, hour, 0, 0).getTime();

    test('buckets by day, oldest first, inside the window', () => {
        const now = at(2026, 8, 4, 12);
        const records = [
            record('milking', 1000, 900, at(2026, 8, 3, 2)),
            record('milking', 1000, 700, at(2026, 8, 3, 22)),
            record('milking', 1000, 1100, at(2026, 8, 4, 9)),
            // Older than the window
            record('milking', 1000, 100, at(2026, 7, 1, 9)),
        ];

        const series = dailySeries(records, { now, days: 7 });

        expect(series.map((day) => day.day)).toEqual(['2026-08-03', '2026-08-04']);
        expect(series[0].samples).toBe(2);
        expect(series[0].actualMean).toBe(800);
        expect(series[1].deviation).toBe(10);
    });

    test('a day is the reader’s own day, not a UTC one', () => {
        // Late evening local time: west of Greenwich this is already tomorrow in UTC, and
        // bucketing by UTC would file an evening's actions under the next day's heading
        const evening = new Date(2026, 7, 3, 23, 30, 0);
        const morning = new Date(2026, 7, 3, 7, 0, 0);
        const now = new Date(2026, 7, 4, 12, 0, 0).getTime();

        const series = dailySeries(
            [record('milking', 1000, 900, morning.getTime()), record('milking', 1000, 700, evening.getTime())],
            { now, days: 7 }
        );

        expect(series).toHaveLength(1);
        expect(series[0].day).toBe(localDay(evening));
        expect(series[0].day).toBe(localDay(morning));
        expect(series[0].samples).toBe(2);
    });
});

describe('xpGoldSplit', () => {
    /**
     * A combat pair carrying both rates.
     * @param {number} goldDeviation - Percent the gold rate came out at
     * @param {number|null} xpDeviation - Percent the XP rate came out at, or null for a pair without XP
     * @returns {Object}
     */
    const combatPair = (goldDeviation, xpDeviation) => ({
        actionType: 'combat',
        predicted: 1000,
        actual: 1000 * (1 + goldDeviation / 100),
        predictedXpPerHour: xpDeviation === null ? null : 500,
        actualXpPerHour: xpDeviation === null ? null : 500 * (1 + xpDeviation / 100),
        t: Date.now(),
    });

    /**
     * The same pair repeated, which is what a median needs to be allowed to speak.
     * @param {number} count - How many
     * @param {number} goldDeviation - Gold deviation percent
     * @param {number|null} xpDeviation - XP deviation percent
     * @returns {Array<Object>}
     */
    const pairs = (count, goldDeviation, xpDeviation) =>
        Array.from({ length: count }, () => combatPair(goldDeviation, xpDeviation));

    test('refuses below the minimum rather than calling a split on a handful', () => {
        const split = xpGoldSplit(pairs(4, -30, -1));
        expect(split.verdict).toBe('insufficient');
        expect(split.text).toContain('Too few');
        expect(split.rated).toBe(4);
    });

    test('XP inside the band with gold outside it points at drops or prices', () => {
        const split = xpGoldSplit(pairs(6, -30, -2));
        expect(split.verdict).toBe('drops_or_prices');
        expect(split.text).toContain('drops or prices');
        expect(split.xpDeviation).toBeCloseTo(-2);
        expect(split.goldDeviation).toBeCloseTo(-30);
    });

    test('both off the same way indicts the fight model, not the loot', () => {
        const split = xpGoldSplit(pairs(6, -30, -28));
        expect(split.verdict).toBe('fight_model');
        expect(split.text).toContain('mis-models the fight');
    });

    test('both off in opposite directions refuses to name one cause', () => {
        const split = xpGoldSplit(pairs(6, -30, 28));
        expect(split.verdict).toBe('opposed');
    });

    test('XP off while gold lands is its own finding', () => {
        const split = xpGoldSplit(pairs(6, 2, -30));
        expect(split.verdict).toBe('xp_only');
    });

    test('neither off is said plainly rather than dressed as a finding', () => {
        const split = xpGoldSplit(pairs(6, 3, -4));
        expect(split.verdict).toBe('aligned');
    });

    test('pairs without an XP rate are excluded and counted, never read as zero XP', () => {
        // Six good pairs at -2% XP, plus four legacy pairs with no XP fields. Folding the
        // legacy ones in as zeros would drag the XP median down and manufacture a verdict.
        const split = xpGoldSplit([...pairs(6, -30, -2), ...pairs(4, -30, null)]);
        expect(split.rated).toBe(6);
        expect(split.withoutXp).toBe(4);
        expect(split.xpDeviation).toBeCloseTo(-2);
        expect(split.verdict).toBe('drops_or_prices');
    });

    test('both medians come from the same pairs, so the comparison is like for like', () => {
        // The pairs that carry XP are the ones the gold rate landed on; the ones without XP
        // are catastrophic. Pooling gold over everything would report a gold gap that none
        // of the XP-carrying runs had.
        const split = xpGoldSplit([...pairs(6, -2, -2), ...pairs(20, -80, null)]);
        expect(split.goldDeviation).toBeCloseTo(-2);
        expect(split.verdict).toBe('aligned');
    });

    test('an XP prediction of zero has no scale to be wrong against', () => {
        const split = xpGoldSplit(
            Array.from({ length: 6 }, () => ({
                predicted: 1000,
                actual: 700,
                predictedXpPerHour: 0,
                actualXpPerHour: 400,
            }))
        );
        expect(split.rated).toBe(0);
        expect(split.withoutXp).toBe(6);
        expect(split.verdict).toBe('insufficient');
    });

    test('nothing at all is a refusal, not a crash', () => {
        expect(xpGoldSplit([]).verdict).toBe('insufficient');
        expect(xpGoldSplit(null).verdict).toBe('insufficient');
    });
});

describe('cohortSplit', () => {
    /**
     * Pairs in one gear cohort.
     * @param {number} count - How many
     * @param {number} deviation - Percent each came out at
     * @param {boolean|null} fingerprintMatch - Gear flag
     * @returns {Array<Object>}
     */
    const cohortPairs = (count, deviation, fingerprintMatch) =>
        Array.from({ length: count }, () => ({
            actionType: 'combat',
            predicted: 1000,
            actual: 1000 * (1 + deviation / 100),
            fingerprintMatch,
        }));

    test('refuses when either cohort is thin, however far apart the medians look', () => {
        const split = cohortSplit([...cohortPairs(20, -2, true), ...cohortPairs(3, -31, false)]);
        expect(split.verdict).toBe('insufficient');
        expect(split.text).toContain('Too few');
        expect(split.detail).toContain('different-gear cohort');
    });

    test('the refusal names the thin cohort as the one that is short, not the one that is not', () => {
        // The sentence has to say which side is missing pairs. Naming it and
        // then asserting it "has that many" states the opposite of the
        // condition that produced the refusal, and the reader who acts on it
        // goes and plays more runs in the cohort that was already full.
        const short = cohortSplit([...cohortPairs(20, -2, true), ...cohortPairs(3, -31, false)]);
        expect(short.detail).not.toContain('different-gear cohort has that many');

        const other = cohortSplit([...cohortPairs(3, -2, true), ...cohortPairs(20, -31, false)]);
        expect(other.detail).not.toContain('matched-gear cohort has that many');

        // Both short is the one phrasing that was already true, and stays true
        const both = cohortSplit([...cohortPairs(3, -2, true), ...cohortPairs(3, -31, false)]);
        expect(both.detail).toContain('neither cohort has that many');
    });

    test('matched clean and mismatched off says the gear explains the pooled gap', () => {
        const split = cohortSplit([...cohortPairs(6, -2, true), ...cohortPairs(6, -31, false)]);
        expect(split.verdict).toBe('mismatch_explains');
        expect(split.figures).toContain('matched -2.0% (6)');
        expect(split.figures).toContain('mismatched -31.0% (6)');
        expect(split.text).toContain('the gear it never saw');
    });

    test('both cohorts off alike clears the gear of the charge', () => {
        const split = cohortSplit([...cohortPairs(6, -28, true), ...cohortPairs(6, -31, false)]);
        expect(split.verdict).toBe('sim_off');
    });

    test('the matched cohort missing alone indicts the forecast', () => {
        const split = cohortSplit([...cohortPairs(6, -31, true), ...cohortPairs(6, -2, false)]);
        expect(split.verdict).toBe('matched_off');
    });

    test('both cohorts inside the band is no finding at all', () => {
        const split = cohortSplit([...cohortPairs(6, -2, true), ...cohortPairs(6, 3, false)]);
        expect(split.verdict).toBe('both_clean');
    });

    test('both off and far apart is two findings, not one', () => {
        const split = cohortSplit([...cohortPairs(6, -20, true), ...cohortPairs(6, 40, false)]);
        expect(split.verdict).toBe('split');
    });

    test('an undetermined gear match is its own bucket, never folded into either side', () => {
        const split = cohortSplit([
            ...cohortPairs(6, -2, true),
            ...cohortPairs(6, -31, false),
            ...cohortPairs(9, -70, null),
            ...cohortPairs(2, -70, undefined),
        ]);
        expect(split.matched.rated).toBe(6);
        expect(split.mismatched.rated).toBe(6);
        expect(split.unsigned.rated).toBe(11);
        expect(split.matched.medianDeviation).toBeCloseTo(-2);
        expect(split.verdict).toBe('mismatch_explains');
    });

    test('nothing at all is a refusal, not a crash', () => {
        expect(cohortSplit([]).verdict).toBe('insufficient');
        expect(cohortSplit(null).verdict).toBe('insufficient');
    });
});

describe('actionSplit', () => {
    /**
     * Runs of one action, all missing by the same amount.
     * @param {string} actionHrid - Which action
     * @param {number} count - How many runs
     * @param {number} deviation - Percent each run missed by
     * @returns {Array<Object>}
     */
    const runs = (actionHrid, count, deviation) =>
        Array.from({ length: count }, (_, i) => ({
            id: `${actionHrid}-${i}`,
            actionType: 'milking',
            actionHrid,
            predicted: 1000,
            actual: 1000 * (1 + deviation / 100),
            t: i,
        }));

    test('splits a pooled median into the actions that made it', () => {
        const split = actionSplit([...runs('/actions/milking/cow', 6, -40), ...runs('/actions/milking/sheep', 6, 0)]);

        expect(split.actions).toHaveLength(2);
        expect(split.decided).toBe(2);
        // Worst first, so the action responsible for the pooled gap leads
        expect(split.actions[0].actionHrid).toBe('/actions/milking/cow');
        expect(split.actions[0].medianDeviation).toBeCloseTo(-40);
        expect(split.actions[0].flagged).toBe(true);
        expect(split.actions[1].medianDeviation).toBeCloseTo(0);
        expect(split.actions[1].flagged).toBe(false);
    });

    test('withholds the figure for an action with too few runs of its own', () => {
        const split = actionSplit([...runs('/actions/milking/cow', 20, -2), ...runs('/actions/milking/sheep', 3, -80)]);

        expect(split.thin).toBe(1);
        expect(split.decided).toBe(1);
        const thin = split.actions.find((action) => action.actionHrid === '/actions/milking/sheep');
        expect(thin.rated).toBe(3);
        expect(thin.decided).toBe(false);
        // The gate is the action's own count, never the group's
        expect(thin.medianDeviation).toBeNull();
        expect(thin.text).toBe('too few to call');
        expect(thin.flagged).toBe(false);
    });

    test('gates on rated runs, not on runs recorded', () => {
        // Five runs, but two have no scale to be wrong against, so four are rated
        const split = actionSplit([...runs('/actions/milking/cow', 4, -30), ...runs('/actions/milking/cow', 2, 0)]);
        // ids collide by construction; what matters is that the unrateable pair
        // below drops out of `rated` and takes the action under the bar
        const cow = split.actions[0];
        expect(cow.samples).toBe(6);
        expect(cow.rated).toBe(6);
        expect(cow.decided).toBe(true);

        const unrateable = actionSplit([
            ...runs('/actions/milking/cow', 4, -30),
            { actionHrid: '/actions/milking/cow', predicted: 0, actual: 500, t: 9 },
        ]);
        expect(unrateable.actions[0].samples).toBe(5);
        expect(unrateable.actions[0].rated).toBe(4);
        expect(unrateable.actions[0].decided).toBe(false);
    });

    test('counts pairs with no action rather than inventing one for them', () => {
        const split = actionSplit([
            ...runs('/actions/milking/cow', 6, -40),
            { predicted: 1000, actual: 500, t: 1 },
            { actionHrid: null, predicted: 1000, actual: 500, t: 2 },
        ]);
        expect(split.unattributed).toBe(2);
        expect(split.actions).toHaveLength(1);
    });

    test('nothing at all is empty, not a crash', () => {
        expect(actionSplit([]).actions).toEqual([]);
        expect(actionSplit(null).actions).toEqual([]);
    });
});

describe('bidSpread', () => {
    /**
     * Runs whose ask and bid figures differ by a fixed share.
     * @param {number} count - How many
     * @param {number} sharePercent - What share of the ask figure the spread is
     * @returns {Array<Object>}
     */
    const priced = (count, sharePercent) =>
        Array.from({ length: count }, (_, i) => ({
            id: `p${i}`,
            predicted: 1_000_000,
            actual: 1_000_000,
            actualBid: 1_000_000 * (1 - sharePercent / 100),
            t: i,
        }));

    test('names the share of the forecast that only exists at the ask', () => {
        const spread = bidSpread(priced(6, 30));
        expect(spread.rated).toBe(6);
        expect(spread.askShare).toBeCloseTo(30);
        expect(spread.verdict).toBe('ask_dependent');
        expect(spread.text).toBe('30% of this forecast depends on selling into the ask');
    });

    test('excludes pairs with no bid figure and counts them', () => {
        const spread = bidSpread([
            ...priced(5, 20),
            { predicted: 1_000_000, actual: 1_000_000, t: 9 },
            { predicted: 1_000_000, actual: 1_000_000, actualBid: null, t: 10 },
            { predicted: 1_000_000, actual: 1_000_000, actualBid: NaN, t: 11 },
        ]);
        expect(spread.rated).toBe(5);
        expect(spread.withoutBid).toBe(3);
        // A missing bid figure is not a zero spread, so it never drags the median
        expect(spread.askShare).toBeCloseTo(20);
    });

    test('refuses below the minimum, and says how short it is', () => {
        const spread = bidSpread([...priced(3, 25), { predicted: 1000, actual: 1000, t: 4 }]);
        expect(spread.verdict).toBe('insufficient');
        expect(spread.text).toBe('Too few bid-priced runs to call');
        expect(spread.detail).toContain('3 of the 5');
        expect(spread.detail).toContain('1 recorded without one');
    });

    test('a run that netted nothing has no share to be a share of', () => {
        const spread = bidSpread([...priced(5, 10), { predicted: 1000, actual: 0, actualBid: -50, t: 9 }]);
        expect(spread.rated).toBe(5);
        expect(spread.withoutBid).toBe(0);
        expect(spread.askShare).toBeCloseTo(10);
    });

    test('says so the other way round when the bid figure is the higher one', () => {
        const spread = bidSpread(priced(6, -12));
        expect(spread.verdict).toBe('bid_favoured');
        expect(spread.text).toBe('12% more than the forecast if sold at the bid');
    });

    test('nothing at all is a refusal, not a crash', () => {
        expect(bidSpread([]).verdict).toBe('insufficient');
        expect(bidSpread(null).verdict).toBe('insufficient');
    });
});
