/**
 * The long-term per-trial results, read off the archived cycles.
 *
 * The claims: every finished cycle's tier per trial is kept long after the
 * cycle's tiles leave the four-cycle archive; two copies of one cycle never let
 * a zeroed re-archive or an older payload statement replace what the week
 * reached; another guild's cycles are never this guild's results; the cap keeps
 * the newest cycles whatever order they arrive in; and a cycle with no result
 * prints "—", never a zero.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ testServer: false }));
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => game.testServer === true,
}));

import {
    MAX_RESULT_CYCLES_TEST,
    MAX_RESULT_WEEKS,
    historyRowFor,
    mergeResults,
    resultPoints,
    resultsFromCycle,
    resultsFromHistory,
    trialHistoryCells,
    trialHistoryDetail,
    trialOfTile,
    trialResultsHistory,
    trialResultsOf,
} from './guild-trial-results.js';
import { FOREIGN_CYCLE_REASON } from './guild-trial-history.js';
import { trialWeekStart } from './guild-trials-math.js';

const DAY = 24 * 60 * 60 * 1000;
const WEEK = 7 * DAY;
const now = Date.parse('2026-10-28T12:00:00Z');
const thisWeek = trialWeekStart(now);
const weeksAgo = (n) => thisWeek - n * WEEK;

/** A card read on the Trials tab, as `recordTileSample` leaves it */
const badger = (tier, points, extra = {}) => ({
    name: 'Trial Badger',
    kind: 'combat',
    level: 100 + tier * 10,
    tier,
    points,
    pointsByTier: { [tier]: points },
    completed: true,
    samples: [{ t: 1, readings: [{ current: 5, max: 10 }] }],
    tiers: [],
    ...extra,
});

/** A trial filed off the guild payload alone, as `recordServerTiers` leaves it */
const alchemyServerOnly = (tier, at) => ({
    name: 'Alchemy',
    kind: 'skilling',
    samples: [],
    tiers: [],
    pointsByTier: {},
    tierSeenAt: {},
    serverTier: tier,
    serverTierAt: at,
    serverDone: true,
});

/** An archived cycle, as `archiveCycle` writes one */
const cycle = (week, tiles, extra = {}) => ({
    archivedAt: week + WEEK,
    reason: 'the week rolled over',
    weekStart: week,
    tiles,
    ...extra,
});

beforeEach(() => {
    game.testServer = false;
});

describe('trialOfTile', () => {
    test('names trials the way cards do, and nothing else', () => {
        expect(trialOfTile({ name: 'Trial Badger' })).toEqual({ kind: 'combat', key: 'badger', name: 'Trial Badger' });
        expect(trialOfTile({ name: 'Alchemy' })).toEqual({ kind: 'skilling', key: 'alchemy', name: 'Alchemy' });
        expect(trialOfTile({ name: 'Guild Experience' })).toBeNull();
        expect(trialOfTile({ name: '' })).toBeNull();
    });
});

describe('resultsFromCycle', () => {
    test('one entry per trial with what the card and the payload stated', () => {
        const results = resultsFromCycle(
            cycle(weeksAgo(1), {
                'combat::trial badger': badger(6, 2240),
                'skilling::alchemy': alchemyServerOnly(9, weeksAgo(1) + 3 * DAY),
            })
        );
        expect(results).toHaveLength(2);
        expect(results.find((r) => r.trial === 'badger')).toMatchObject({
            weekStart: weeksAgo(1),
            cycleFrom: null,
            kind: 'combat',
            name: 'Trial Badger',
            cardTier: 6,
            points: 2240,
            completed: true,
            serverTier: null,
        });
        expect(results.find((r) => r.trial === 'alchemy')).toMatchObject({
            cardTier: null,
            points: null,
            serverTier: 9,
            serverTierAt: weeksAgo(1) + 3 * DAY,
        });
    });

    test('another guild’s cycle is never a result', () => {
        expect(resultsFromCycle(cycle(weeksAgo(1), { a: badger(6, 2240) }, { reason: FOREIGN_CYCLE_REASON }))).toEqual(
            []
        );
    });

    test('a card nobody saw a result on is no result, and a junk tile is none either', () => {
        const results = resultsFromCycle(
            cycle(weeksAgo(1), {
                'skilling::milking': { name: 'Milking', kind: 'skilling', points: 0, samples: [], tiers: [] },
                'skilling::notice': { name: 'Guild Experience', kind: 'skilling', tier: 3, points: 10 },
            })
        );
        expect(results).toEqual([]);
    });

    test('a cycle archived only off zeroed cards is no result, and never a best', () => {
        // The cards after a cycle ends: a finite tier 0, nothing banked, not finished
        const zeroed = { name: 'Trial Badger', kind: 'combat', tier: 0, points: 0, samples: [], tiers: [] };
        expect(resultsFromCycle(cycle(weeksAgo(2), { a: zeroed }))).toEqual([]);
        const results = resultsFromHistory([
            cycle(weeksAgo(2), { a: zeroed }),
            cycle(weeksAgo(1), { a: { ...zeroed, tier: 0, points: 0, completed: true } }),
        ]);
        const [row] = trialResultsHistory(results, { now }).rows;
        // The zeroed week is no cycle of the history at all; the finished T0 is
        expect(trialHistoryCells(row)).toBe('T0 · best T0 (last week)');
    });

    test('a party that wiped before tier 1 is a real T0', () => {
        const [result] = resultsFromCycle(
            cycle(weeksAgo(1), {
                'combat::trial hedgehog': { name: 'Trial Hedgehog', kind: 'combat', points: 0, completed: true },
            })
        );
        expect(result).toMatchObject({ trial: 'hedgehog', cardTier: 0, points: 0 });
    });

    test('a cycle with no week stamp is filed by when it was archived; with neither, not at all', () => {
        const [stamped] = resultsFromCycle({ archivedAt: weeksAgo(2) + DAY, tiles: { a: badger(4, 1000) } });
        expect(stamped.weekStart).toBe(weeksAgo(2));
        expect(resultsFromCycle({ tiles: { a: badger(4, 1000) } })).toEqual([]);
    });
});

describe('mergeResults', () => {
    test('a week re-archived off its zeroed cards keeps the tier it reached', () => {
        // The heal archived the finished cycle mid-week; the rollover archived
        // the zeroed cards read since, which state a finite tier 0
        const reached = cycle(weeksAgo(1), { a: badger(5, 1800) }, { reason: 'a new cycle is scheduled' });
        const zeroed = cycle(weeksAgo(1), { a: badger(0, 0, { completed: false }) });
        for (const order of [
            [reached, zeroed],
            [zeroed, reached],
        ]) {
            const merged = mergeResults(resultsFromHistory(order));
            expect(merged).toHaveLength(1);
            expect(merged[0]).toMatchObject({ cardTier: 5, points: 1800 });
        }
    });

    test('the payload’s tier comes from the newer statement, the card’s fields from the fuller copy', () => {
        const early = cycle(weeksAgo(1), { a: badger(5, 1800, { serverTier: 5, serverTierAt: weeksAgo(1) + 1000 }) });
        const late = cycle(weeksAgo(1), {
            a: { name: 'Trial Badger', kind: 'combat', serverTier: 7, serverTierAt: weeksAgo(1) + 9000 },
        });
        const [merged] = mergeResults(resultsFromHistory([late, early]));
        expect(merged).toMatchObject({ cardTier: 5, points: 1800, serverTier: 7, serverTierAt: weeksAgo(1) + 9000 });
    });

    test('test-server cycles of one week are kept apart', () => {
        game.testServer = true;
        const history = [1, 2, 3].map((n) =>
            cycle(
                thisWeek,
                { a: badger(n, n * 100) },
                { reason: 'an earlier cycle of this week', cycleFrom: thisWeek + (n * DAY) / 4 }
            )
        );
        expect(mergeResults(resultsFromHistory(history)).map((r) => r.cardTier)).toEqual([1, 2, 3]);
    });

    test('live keeps the newest 52 weeks, whatever order they arrive in', () => {
        const results = [];
        for (let n = 1; n <= 60; n += 1)
            results.push(...resultsFromCycle(cycle(weeksAgo(n), { a: badger(n % 20, n) })));
        // A stale device's oldest weeks appended last
        const merged = mergeResults(results.slice(0, 10), results.slice(10).reverse());
        expect(merged).toHaveLength(MAX_RESULT_WEEKS);
        expect(merged[merged.length - 1].weekStart).toBe(weeksAgo(1));
        expect(merged[0].weekStart).toBe(weeksAgo(52));
    });

    test('the test server keeps the newest 120 cycles', () => {
        game.testServer = true;
        const results = [];
        for (let n = 0; n < 130; n += 1) {
            const from = thisWeek - n * (DAY / 4);
            results.push(
                ...resultsFromCycle(
                    cycle(trialWeekStart(from), { a: badger(3, 300) }, { cycleFrom: from, archivedAt: from })
                )
            );
        }
        const merged = mergeResults([...results].reverse());
        expect(merged).toHaveLength(MAX_RESULT_CYCLES_TEST);
        expect(merged[merged.length - 1].cycleFrom).toBe(thisWeek);
        expect(merged[0].cycleFrom).toBe(thisWeek - 119 * (DAY / 4));
    });

    test('stored entries that are not results are dropped', () => {
        expect(mergeResults([null, 5, { trial: 'badger' }])).toEqual([]);
        // …including one with no name, which the history's sort would throw on
        const named = resultsFromCycle(cycle(weeksAgo(1), { a: badger(6, 2240) }));
        expect(mergeResults(named, [{ ...named[0], trial: 'hedgehog', name: null }])).toHaveLength(1);
        expect(() =>
            trialResultsHistory([...named, { ...named[0], trial: 'hedgehog', name: null }], { now })
        ).not.toThrow();
    });
});

describe('trialResultsOf', () => {
    test('what was kept, with the archive folded in, for a week the archive has since dropped', () => {
        const kept = resultsFromCycle(cycle(weeksAgo(9), { a: badger(3, 700) }));
        const record = { trialResults: kept, history: [cycle(weeksAgo(1), { a: badger(6, 2240) })] };
        expect(trialResultsOf(record).map((r) => r.weekStart)).toEqual([weeksAgo(9), weeksAgo(1)]);
    });

    test('no history, no results', () => {
        expect(trialResultsOf({})).toEqual([]);
        expect(trialResultsOf(null)).toEqual([]);
    });
});

describe('resultPoints', () => {
    test('stated where the card saw the tier; priced off the ladder, marked, where only the payload did', () => {
        const [card] = resultsFromCycle(cycle(weeksAgo(1), { a: badger(6, 2240) }));
        expect(resultPoints(card, 0.2)).toEqual({ points: 2240, derived: false });

        const [server] = resultsFromCycle(cycle(weeksAgo(1), { a: alchemyServerOnly(9, 1) }));
        expect(resultPoints(server, null)).toBeNull();
        const priced = resultPoints(server, 0.2);
        expect(priced.derived).toBe(true);
        expect(priced.points).toBeGreaterThan(0);
    });
});

describe('trialResultsHistory', () => {
    test('nothing finished yet: no rows', () => {
        expect(trialResultsHistory([], { now }).rows).toEqual([]);
    });

    test('one week, one trial seen once', () => {
        const results = resultsFromCycle(cycle(weeksAgo(1), { a: badger(6, 2240) }));
        const { rows } = trialResultsHistory(results, { now });
        expect(rows).toHaveLength(1);
        expect(trialHistoryCells(rows[0])).toBe('T6 · best T6 (last week)');
    });

    test('a trial that changed tier across weeks, a week it is absent from, newest first, best and when', () => {
        const history = [
            cycle(weeksAgo(3), { a: badger(9, 4000), b: alchemyServerOnly(4, 1) }),
            cycle(weeksAgo(2), { b: alchemyServerOnly(6, 2) }),
            cycle(weeksAgo(1), { a: badger(7, 3000), b: alchemyServerOnly(5, 3) }),
        ];
        const history_ = trialResultsHistory(resultsFromHistory(history), { now });
        const badgerRow = historyRowFor(history_, 'Trial Badger');
        const alchemyRow = historyRowFor(history_, 'Alchemy');
        // Combat first
        expect(history_.rows.map((row) => row.name)).toEqual(['Trial Badger', 'Alchemy']);
        // Absent two weeks ago: a dash, never a zero
        expect(trialHistoryCells(badgerRow)).toBe('T7 · — · T9 · best T9 (3 weeks ago)');
        expect(trialHistoryCells(alchemyRow)).toBe('T5 · T6 · T4 · best T6 (2 weeks ago)');
        expect(trialHistoryDetail(badgerRow)).toContain('2 weeks ago: —');
        expect(trialHistoryDetail(badgerRow)).toContain('Last week: T7 · 3,000 pts');
    });

    test('a server-only week prices its points as derived', () => {
        const results = resultsFromCycle(cycle(weeksAgo(1), { b: alchemyServerOnly(6, 1) }));
        const { rows } = trialResultsHistory(results, { now, buildersHallBonus: 0 });
        expect(trialHistoryDetail(rows[0])).toMatch(/Last week: T6 · ~[\d,]+ pts/);
    });

    test('the live week’s own archive is the live record, not a past week', () => {
        const results = resultsFromCycle(
            cycle(thisWeek, { a: badger(6, 2240) }, { reason: 'a new cycle is scheduled' })
        );
        expect(trialResultsHistory(results, { now }).rows).toEqual([]);
    });

    test('a test-server cycle of this week is a past cycle', () => {
        game.testServer = true;
        const results = resultsFromHistory([
            cycle(
                thisWeek,
                { a: badger(2, 200) },
                { cycleFrom: thisWeek + DAY, reason: 'an earlier cycle of this week' }
            ),
            cycle(
                thisWeek,
                { a: badger(4, 400) },
                { cycleFrom: thisWeek + 2 * DAY, reason: 'an earlier cycle of this week' }
            ),
        ]);
        const { rows, cycles } = trialResultsHistory(results, { now });
        expect(cycles).toHaveLength(2);
        // The plain end time leads on the test server, and a finished cycle is never "This week"
        expect(cycles[0].label).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
        expect(cycles[0].label).not.toMatch(/this week/i);
        expect(trialHistoryCells(rows[0])).toMatch(/^T4 · T2 · best T4/);
    });

    test('more cycles than fit inline say how many more there are', () => {
        const history = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => cycle(weeksAgo(n), { a: badger(n, n * 100) }));
        const [row] = trialResultsHistory(resultsFromHistory(history), { now }).rows;
        expect(trialHistoryCells(row)).toBe('T1 · T2 · T3 · T4 · T5 · T6 · +2 earlier · best T8 (8 weeks ago)');
    });

    test('a card’s name with no past results has no row', () => {
        expect(historyRowFor(trialResultsHistory([], { now }), 'Trial Badger')).toBeNull();
        expect(historyRowFor({ rows: [] }, 'Guild Experience')).toBeNull();
    });
});
