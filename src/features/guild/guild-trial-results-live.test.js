/**
 * The running cycle's finished trials in the Trial history, read off the live record for display only.
 *
 * The claims: a finished trial (card `completed`, or the payload's `serverDone`) shows in a first column of its
 * own as soon as it is over, by the archive's own tier and percent rules; an unfinished one is blank there; once
 * the cycle is archived the column is the archived one, never a second copy; Best can come from it; and nothing of
 * it is ever written into the stored results, so no total or best counts it twice.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({ testServer: false }));
vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => game.testServer === true,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => fallback,
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => null } }));

import {
    LIVE_CYCLE_KEY,
    historyRowFor,
    liveTrialResults,
    trialHistoryCell,
    trialHistoryDetail,
    trialHistoryTiers,
    trialResultsHistory,
    trialResultsOf,
    withTrialResults,
} from './guild-trial-results.js';
import { archiveCycle, rollRecordToWeek } from './guild-trials-store.js';
import { trialWeekStart } from './guild-trials-math.js';

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const WEEK = 7 * DAY;
const now = Date.parse('2026-10-28T12:00:00Z');
const thisWeek = trialWeekStart(now);

/** A finished card, as `recordTileSample` leaves it */
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
    tierSeenAt: {},
    ...extra,
});

/** A trial filed off the guild payload alone, as `recordServerTiers` leaves it */
const alchemy = (tier, done, extra = {}) => ({
    name: 'Alchemy',
    kind: 'skilling',
    samples: [],
    tiers: [],
    pointsByTier: {},
    tierSeenAt: {},
    serverTier: tier,
    serverTierAt: now - HOUR,
    serverDone: done,
    ...extra,
});

/** A card still running: read, not finished, the payload not done */
const milking = (tier) => ({
    name: 'Milking',
    kind: 'skilling',
    level: 100 + tier * 10,
    tier,
    points: 0,
    pointsByTier: {},
    completed: false,
    samples: [{ t: 1, readings: [{ current: 5, max: 10 }] }],
    tiers: [],
    tierSeenAt: {},
    serverTier: tier,
    serverTierAt: now - 60_000,
    serverDone: false,
});

const historyOf = (record) =>
    trialResultsHistory(trialResultsOf(record), {
        now,
        live: { results: liveTrialResults(record, now), cycleStart: record.cycleStart ?? null },
    });

beforeEach(() => {
    game.testServer = false;
});

describe('the running cycle on the live server', () => {
    const lastWeek = {
        archivedAt: thisWeek,
        reason: 'the week rolled over',
        weekStart: thisWeek - WEEK,
        tiles: { a: badger(9, 4000), b: alchemy(4, true), c: milking(5) },
    };
    const record = () => ({
        weekStart: thisWeek,
        tiles: {
            a: badger(7, 3000, { serverProgress: { tier: 7, pct: 64, at: now - HOUR } }),
            b: alchemy(6, true),
            c: milking(3),
        },
        history: [lastWeek],
        trialResults: [],
    });

    test('a finished trial shows in a leading "This week" column; an unfinished one is blank there', () => {
        const history = historyOf(record());
        expect(history.cycles.map((cycle) => cycle.label)).toEqual(['This week', 'Last week']);
        expect(history.cycles[0]).toMatchObject({ key: LIVE_CYCLE_KEY, live: true });

        const badgerRow = historyRowFor(history, 'Trial Badger');
        expect(badgerRow.weeks.map(trialHistoryCell)).toEqual(['T7 64%', 'T9']);
        // Finished on the payload's word alone
        expect(historyRowFor(history, 'Alchemy').weeks.map(trialHistoryCell)).toEqual(['T6', 'T4']);
        // Still running this week: blank, not "—" and not "did not run"
        const milkingRow = historyRowFor(history, 'Milking');
        expect(milkingRow.weeks[0]).toMatchObject({ pending: true, tier: null });
        expect(milkingRow.weeks[0].notRun).toBeUndefined();
        expect(trialHistoryCell(milkingRow.weeks[0])).toBe('');
        expect(trialHistoryDetail(milkingRow)).toContain('This week: not finished yet');
        expect(trialHistoryDetail(milkingRow)).not.toContain('This week: did not run');
        expect(trialHistoryTiers(milkingRow)).toBe('running · T5');
    });

    test('Best can be the finished live result', () => {
        const live = record();
        live.tiles.b = alchemy(8, true);
        const row = historyRowFor(historyOf(live), 'Alchemy');
        expect(row.best).toEqual({ tier: 8, progress: null, label: 'This week' });
        // …and not the running Milking tier, which is no result yet
        expect(historyRowFor(historyOf(live), 'Milking').best).toMatchObject({ tier: 5, label: 'Last week' });
    });

    test('nothing of it is stored: the stored results are the archive’s alone', () => {
        const live = record();
        const stored = withTrialResults(live).trialResults;
        expect(stored.every((result) => result.weekStart === thisWeek - WEEK)).toBe(true);
        expect(stored).toHaveLength(3);
        expect(trialResultsOf(live)).toEqual(stored);
    });

    test('after the rollover the week is one archived column, with the archived values', () => {
        const live = record();
        const later = now + WEEK;
        const rolled = rollRecordToWeek(live, trialWeekStart(later));
        expect(rolled.tiles).toEqual({});
        const history = trialResultsHistory(trialResultsOf(rolled), {
            now: later,
            live: { results: liveTrialResults(rolled, later), cycleStart: null },
        });
        expect(history.cycles.map((cycle) => cycle.label)).toEqual(['Last week', '2 weeks ago']);
        expect(history.cycles.some((cycle) => cycle.live)).toBe(false);
        expect(historyRowFor(history, 'Trial Badger').weeks.map(trialHistoryCell)).toEqual(['T7 64%', 'T9']);
        // The running trial, archived at the rollover, is that week's result now
        expect(historyRowFor(history, 'Milking').weeks.map(trialHistoryCell)).toEqual(['T3', 'T5']);
    });

    test('the week’s own archive and the record fold into the one column, once per trial', () => {
        const live = record();
        const archivedMidWeek = archiveCycle(
            { ...live, tiles: { b: alchemy(5, true) } },
            'a new cycle is scheduled',
            now - 2 * HOUR
        );
        const both = { ...archivedMidWeek, tiles: live.tiles };
        const history = historyOf(both);
        expect(history.cycles.filter((cycle) => cycle.live)).toHaveLength(1);
        expect(history.cycles.map((cycle) => cycle.label)).toEqual(['This week', 'Last week']);
        // One Alchemy entry: the newer statement of the two copies
        expect(historyRowFor(history, 'Alchemy').weeks.map(trialHistoryCell)).toEqual(['T6', 'T4']);
    });

    test('a record of an earlier week, not yet rolled, gives no live column', () => {
        const stale = { ...record(), weekStart: thisWeek - WEEK, history: [] };
        expect(historyOf(stale).cycles).toEqual([]);
    });

    test('no finished trial: no live column, and nothing to draw before any cycle has finished', () => {
        const running = { weekStart: thisWeek, tiles: { c: milking(3) }, history: [] };
        expect(historyOf(running)).toEqual({ cycles: [], rows: [] });
        expect(historyOf({ ...running, history: [lastWeek] }).cycles.map((cycle) => cycle.label)).toEqual([
            'Last week',
        ]);
    });

    test('the last tier carries no percent, and a percent read at another tier is not shown', () => {
        const live = {
            weekStart: thisWeek,
            tiles: {
                a: badger(21, 9000, { serverProgress: { tier: 21, pct: 40, at: now } }),
                b: alchemy(15, true, { serverProgress: { tier: 14, pct: 63, at: now } }),
            },
            history: [],
        };
        const history = historyOf(live);
        expect(historyRowFor(history, 'Trial Badger').weeks.map(trialHistoryCell)).toEqual(['T21']);
        expect(historyRowFor(history, 'Alchemy').weeks.map(trialHistoryCell)).toEqual(['T15']);
    });
});

describe('the running cycle on the test server', () => {
    // The running cycle's skilling hour began Monday 3 PM; the cycle before it was archived at that start
    const start = thisWeek + 3 * DAY + 15 * HOUR;
    const previous = {
        archivedAt: start + 60_000,
        reason: 'an earlier cycle of this week',
        weekStart: thisWeek,
        cycleFrom: start,
        tiles: { a: badger(4, 1000), b: alchemy(3, true) },
    };
    const record = () => ({
        weekStart: thisWeek,
        cycleStart: start + 7_000,
        tiles: { a: badger(6, 2000), b: milking(2) },
        history: [previous],
        trialResults: [],
    });

    beforeEach(() => {
        game.testServer = true;
    });

    test('a finished trial leads under the time the cycle ran; the cycle before keeps its own column', () => {
        const history = historyOf(record());
        expect(history.cycles).toHaveLength(2);
        expect(history.cycles[0]).toMatchObject({ key: LIVE_CYCLE_KEY, live: true });
        expect(history.cycles[0].label).toMatch(/^[A-Z][a-z]{2} \d{1,2}:\d{2} [AP]M$/);
        expect(history.cycles[0].label).not.toBe(history.cycles[1].label);
        expect(historyRowFor(history, 'Trial Badger').weeks.map(trialHistoryCell)).toEqual(['T6', 'T4']);
        // A trial with no finished result anywhere has no row yet
        expect(historyRowFor(history, 'Milking')).toBeNull();
    });

    test('once archived, the column is the archived one under the same label, with no second copy', () => {
        const live = record();
        const liveLabel = historyOf(live).cycles[0].label;
        // The next cycle starts a day later and archives this one under its own start
        const next = start + DAY;
        const archived = archiveCycle(live, 'an earlier cycle of this week', next + 60_000, { cycleFrom: next });
        const after = { ...archived, tiles: {}, cycleStart: next };
        const history = trialResultsHistory(trialResultsOf(after), {
            now: next + 2 * HOUR,
            live: { results: liveTrialResults(after, next + 2 * HOUR), cycleStart: next },
        });
        expect(history.cycles.some((cycle) => cycle.live)).toBe(false);
        expect(history.cycles).toHaveLength(2);
        expect(history.cycles[0].label).toBe(liveLabel);
        expect(historyRowFor(history, 'Trial Badger').weeks.map(trialHistoryCell)).toEqual(['T6', 'T4']);
    });

    test('a record still holding a cycle the archive already has (a synced archive) shows it once', () => {
        const live = record();
        const next = start + DAY;
        // Another device archived the cycle; this record has not been cut yet
        const synced = archiveCycle(live, 'an earlier cycle of this week', next + 60_000, { cycleFrom: next });
        const stale = { ...synced, tiles: live.tiles, cycleStart: live.cycleStart };
        const history = historyOf(stale);
        expect(history.cycles.some((cycle) => cycle.live)).toBe(false);
        expect(history.cycles).toHaveLength(2);
        expect(historyRowFor(history, 'Trial Badger').weeks.map(trialHistoryCell)).toEqual(['T6', 'T4']);
    });

    test('with no cycle start seen, the column is still drawn, as "This cycle"', () => {
        const live = { ...record(), cycleStart: undefined };
        expect(historyOf(live).cycles[0]).toMatchObject({ label: 'This cycle', live: true });
    });
});
