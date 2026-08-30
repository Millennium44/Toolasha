/**
 * The checkpoint series' own arithmetic and write path.
 *
 * The two properties worth pinning here are the ones a surface cannot check for
 * itself: a checkpoint is written once per series per day and never moved, and
 * a rate over a long window comes back with the idleness in that window
 * attached rather than averaged away.
 */
import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    quota: false,
    stored: [],
    saved: null,
    saves: 0,
}));

vi.mock('../core/storage.js', () => ({
    default: { isQuotaExceeded: () => state.quota },
}));

vi.mock('./chunked-history.js', () => ({
    timeChunkId: (t) => new Date(t).toISOString().slice(0, 7),
    createChunkedHistory: () => ({
        load: vi.fn(async () => state.stored.map((entry) => ({ ...entry }))),
        save: vi.fn(async (charId, entries, options) => {
            state.saves++;
            state.saved = { charId, entries: entries.map((entry) => ({ ...entry })), options };
            return true;
        }),
        forget: vi.fn(),
    }),
}));

const {
    createDailyCheckpoints,
    localDayKey,
    localDayStart,
    dayDiff,
    seriesOf,
    historyStart,
    gainedSince,
    checkpointRate,
} = await import('./daily-checkpoints.js');

/** Local noon on a day, so a timezone offset cannot move the day id */
const noon = (year, month, day) => new Date(year, month - 1, day, 12).getTime();

const build = () =>
    createDailyCheckpoints({
        storeName: 'xpHistory',
        prefix: 'testCheckpointRec',
        legacyKey: (charId) => `testCheckpoints_${charId}`,
        label: 'TestCheckpoints',
    });

beforeEach(() => {
    state.quota = false;
    state.stored = [];
    state.saved = null;
    state.saves = 0;
});

describe('day arithmetic', () => {
    test('a day id is the local calendar day, and round-trips to its own midnight', () => {
        const t = noon(2026, 3, 14);
        expect(localDayKey(t)).toBe('2026-03-14');
        expect(localDayStart('2026-03-14')).toBe(new Date(2026, 2, 14).getTime());
    });

    test('a day span counts calendar days, so a clock change is not an off-by-one', () => {
        expect(dayDiff('2026-03-01', '2026-03-15')).toBe(14);
        // Northern-hemisphere spring forward and autumn back both live in here
        expect(dayDiff('2026-03-01', '2026-04-01')).toBe(31);
        expect(dayDiff('2026-10-01', '2026-11-01')).toBe(31);
    });

    test('a day id that is not one is NaN rather than a silent zero', () => {
        expect(Number.isNaN(dayDiff('not-a-day', '2026-03-01'))).toBe(true);
    });
});

describe('writing today’s checkpoint', () => {
    test('writes one entry per series on the first call of the day', async () => {
        const store = build();
        const written = await store.recordToday(
            'char-1',
            [
                { k: '/skills/milking', xp: 100, level: 5 },
                { k: '/skills/cooking', xp: 200, level: 7 },
            ],
            noon(2026, 3, 14)
        );

        expect(written).toBe(2);
        expect(state.saved.charId).toBe('char-1');
        // Handed to the store in sample order; the comparator it was built with
        // is what puts them in day-then-series order on the way to disk
        expect(state.saved.entries).toEqual([
            { d: '2026-03-14', k: '/skills/milking', xp: 100, level: 5 },
            { d: '2026-03-14', k: '/skills/cooking', xp: 200, level: 7 },
        ]);
    });

    test('a second call the same day writes nothing and does not move the reading', async () => {
        const store = build();
        const now = noon(2026, 3, 14);
        await store.recordToday('char-1', [{ k: '/skills/milking', xp: 100, level: 5 }], now);
        const savesAfterFirst = state.saves;

        const written = await store.recordToday(
            'char-1',
            [{ k: '/skills/milking', xp: 999, level: 9 }],
            now + 60 * 60 * 1000
        );

        expect(written).toBe(0);
        expect(state.saves).toBe(savesAfterFirst);
        // The morning's reading is the anchor every gain is measured from;
        // overwriting it at teatime would shrink the day to a few hours
        expect(state.saved.entries).toEqual([{ d: '2026-03-14', k: '/skills/milking', xp: 100, level: 5 }]);
    });

    test('the next day gets its own entry, and yesterday’s is left exactly as it was', async () => {
        const store = build();
        await store.recordToday('char-1', [{ k: '/skills/milking', xp: 100, level: 5 }], noon(2026, 3, 14));
        await store.recordToday('char-1', [{ k: '/skills/milking', xp: 400, level: 6 }], noon(2026, 3, 15));

        expect(state.saved.entries).toEqual([
            { d: '2026-03-14', k: '/skills/milking', xp: 100, level: 5 },
            { d: '2026-03-15', k: '/skills/milking', xp: 400, level: 6 },
        ]);
    });

    test('a day with no play records the flat truth rather than nothing', async () => {
        const store = build();
        await store.recordToday('char-1', [{ k: '/skills/milking', xp: 100, level: 5 }], noon(2026, 3, 14));
        await store.recordToday('char-1', [{ k: '/skills/milking', xp: 100, level: 5 }], noon(2026, 3, 15));

        // Two entries with the same experience: an idle day is a reading, not a
        // gap, and dropping it is what would let idleness vanish from a rate
        expect(state.saved.entries).toHaveLength(2);
        expect(state.saved.entries.map((entry) => entry.d)).toEqual(['2026-03-14', '2026-03-15']);
    });

    test('nothing is ever written for a day in the past', async () => {
        state.stored = [{ d: '2026-03-10', k: '/skills/milking', xp: 50, level: 4 }];
        const store = build();
        await store.recordToday('char-1', [{ k: '/skills/milking', xp: 100, level: 5 }], noon(2026, 3, 14));

        // The four days between the stored checkpoint and today stay missing.
        // A checkpoint invented for them would be a number nobody measured
        expect(state.saved.entries.map((entry) => entry.d)).toEqual(['2026-03-10', '2026-03-14']);
    });

    test('a full disk writes nothing at all', async () => {
        state.quota = true;
        const store = build();
        expect(await store.recordToday('char-1', [{ k: '/skills/milking', xp: 1, level: 1 }])).toBe(0);
        expect(state.saved).toBeNull();
    });

    test('a sample with no series key or no experience is not a checkpoint', async () => {
        const store = build();
        const written = await store.recordToday(
            'char-1',
            [{ k: null, xp: 5 }, { k: '/skills/milking' }, { k: '/skills/milking', xp: 7 }],
            noon(2026, 3, 14)
        );

        expect(written).toBe(1);
        // A level the game did not report is zero rather than undefined: the
        // entry is stored as JSON and an undefined field would simply vanish
        expect(state.saved.entries).toEqual([{ d: '2026-03-14', k: '/skills/milking', xp: 7, level: 0 }]);
    });
});

describe('character scoping', () => {
    test('a switch mid-read means the departing character’s entries are never written back', async () => {
        let release;
        const gate = new Promise((resolve) => (release = resolve));
        const store = build();
        store._store.load = vi.fn(async () => {
            await gate;
            return [{ d: '2026-03-13', k: '/skills/milking', xp: 10, level: 2 }];
        });

        const recording = store.recordToday('char-1', [{ k: '/skills/milking', xp: 100, level: 5 }], noon(2026, 3, 14));
        store.forget();
        release();

        expect(await recording).toBe(0);
        expect(state.saved).toBeNull();
    });

    test('forget empties what is held, so the arriving character reads nothing of the old one’s', async () => {
        const store = build();
        await store.recordToday('char-1', [{ k: '/skills/milking', xp: 100, level: 5 }], noon(2026, 3, 14));
        expect(store.peek()).toHaveLength(1);

        store.forget();

        expect(store.peek()).toEqual([]);
        expect(store.characterId()).toBeNull();
    });
});

describe('reading a series', () => {
    const entries = [
        { d: '2026-03-05', k: 'a', xp: 100, level: 1 },
        { d: '2026-03-01', k: 'a', xp: 40, level: 1 },
        { d: '2026-03-01', k: 'b', xp: 900, level: 9 },
        { d: '2026-02-27', k: 'a', xp: 10, level: 1 },
    ];

    test('a series is only its own key, oldest first', () => {
        expect(seriesOf(entries, 'a').map((entry) => entry.d)).toEqual(['2026-02-27', '2026-03-01', '2026-03-05']);
    });

    test('the history start is the first day recorded for that series', () => {
        expect(historyStart(entries, 'a')).toBe('2026-02-27');
        expect(historyStart(entries, 'b')).toBe('2026-03-01');
        expect(historyStart(entries, 'missing')).toBeNull();
    });

    test('a gain is measured against the live total, from the first checkpoint in the window', () => {
        expect(gainedSince(entries, 'a', '2026-03-01', 250)).toEqual({ gained: 210, since: '2026-03-01' });
    });

    test('a window that opens before the history starts reports the day it really starts from', () => {
        // Asked for February, and the answer says it could only measure from
        // the 27th — which is the difference between "you gained little" and
        // "nothing was watching"
        expect(gainedSince(entries, 'a', '2026-02-01', 250)).toEqual({ gained: 240, since: '2026-02-27' });
    });

    test('a window with no checkpoint in it reports nothing rather than zero', () => {
        expect(gainedSince(entries, 'a', '2026-04-01', 250)).toBeNull();
    });

    test('experience below the anchor is clamped, not reported as a loss', () => {
        expect(gainedSince(entries, 'a', '2026-03-05', 5).gained).toBe(0);
    });
});

describe('the rate a long window measures', () => {
    /** One checkpoint per day from a list of daily totals, starting 2026-03-01 */
    const series = (totals) =>
        totals.map((xp, index) => ({
            d: localDayKey(noon(2026, 3, 1 + index)),
            k: 'a',
            xp,
            level: 1,
        }));

    test('idle days are counted in the window and named in the count of days that gained', () => {
        // Five days: gains on the first and the fourth, nothing in between
        const rate = checkpointRate(series([0, 2400, 2400, 2400, 4800]), 'a');

        expect(rate.days).toBe(4);
        expect(rate.daysWithGain).toBe(2);
        expect(rate.gained).toBe(4800);
        // 4800 over four days, not over the two that had any play in them
        expect(rate.experiencePerHour).toBeCloseTo(4800 / 96, 6);
        expect(rate.from).toBe('2026-03-01');
        expect(rate.to).toBe('2026-03-05');
    });

    test('a window shorter than the minimum is refused rather than extrapolated', () => {
        expect(checkpointRate(series([0, 100, 200]), 'a', 3)).toBeNull();
        expect(checkpointRate(series([0, 100, 200, 300]), 'a', 3)).not.toBeNull();
    });

    test('a window in which nothing was ever gained has no rate to report', () => {
        expect(checkpointRate(series([500, 500, 500, 500, 500]), 'a')).toBeNull();
    });

    test('a single checkpoint is not a measurement', () => {
        expect(checkpointRate(series([100]), 'a')).toBeNull();
        expect(checkpointRate([], 'a')).toBeNull();
    });

    test('another series’ checkpoints are not folded into this one’s window', () => {
        const mixed = [...series([0, 100, 200, 300]), { d: '2026-03-04', k: 'b', xp: 999999, level: 1 }];
        expect(checkpointRate(mixed, 'a').gained).toBe(300);
    });
});
