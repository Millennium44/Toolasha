/**
 * What a pull is allowed to claim it did.
 *
 * The counts here are the ones the apply result can actually support. A result
 * that reports which keys it left as they were gives an unchanged count; one that
 * does not keeps it unknown: a zero there would read as "nothing else moved",
 * which such a result cannot say.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
    countRows,
    beginPullTiming,
    finishPullTiming,
    longestStallDuring,
    buildPullSummary,
    formatPullSummaryLine,
    formatPullStoreLine,
    rememberPullSummary,
    lastPullSummary,
    clearPullSummary,
} from './pull-summary.js';

/** One folded key, one whole write and one held key, in one store */
const oneOfEach = {
    merged: [{ store: 'guildHistory', key: 'trials', label: 'trial records' }],
    mergeHeld: [{ store: 'guildHistory', key: 'chests', label: 'chest tallies' }],
    // The held key was dropped from the payload, so the store was asked for two:
    // the fold and the whole write
    expected: { guildHistory: 2 },
};

beforeEach(() => {
    clearPullSummary();
});

describe('the counts', () => {
    test('one folded key, one whole write and one held key are counted apart', () => {
        const summary = buildPullSummary(oneOfEach);

        expect(summary.combined).toBe(1);
        expect(summary.writtenWhole).toBe(1);
        expect(summary.held).toBe(1);
        expect(summary.writtenWholePartial).toBe(false);
        expect(summary.stores).toHaveLength(1);
        expect(summary.stores[0]).toMatchObject({
            store: 'guildHistory',
            combined: 1,
            writtenWhole: 1,
            held: 1,
            overwritten: 0,
        });
    });

    test('a folded record carries its key and the registration that folded it', () => {
        const summary = buildPullSummary(oneOfEach);
        expect(summary.stores[0].combinedRecords).toEqual([{ key: 'trials', label: 'trial records' }]);
        expect(summary.stores[0].heldRecords).toEqual([{ key: 'chests', label: 'chest tallies' }]);
    });

    test('unchanged is unknown, never zero, when the result does not report it', () => {
        const summary = buildPullSummary(oneOfEach);
        expect(summary.unchanged).toBeNull();
        expect(summary.stores[0].unchanged).toBeNull();
        expect(formatPullStoreLine(summary.stores[0])).toContain('unchanged unknown');
    });

    test('unchanged is counted per store when the result reports it', () => {
        const summary = buildPullSummary({ ...oneOfEach, unchanged: { guildHistory: 3, settings: 4 } });
        expect(summary.unchanged).toBe(7);
        expect(summary.stores.map((store) => [store.store, store.unchanged])).toEqual([
            ['guildHistory', 3],
            ['settings', 4],
        ]);
        expect(formatPullStoreLine(summary.stores[0])).toContain('3 unchanged');
        expect(formatPullSummaryLine(summary)).toContain('7 already the same');
    });

    test('a reported empty unchanged count is zero, not unknown', () => {
        const summary = buildPullSummary({ ...oneOfEach, unchanged: {} });
        expect(summary.unchanged).toBe(0);
        expect(summary.stores[0].unchanged).toBe(0);
        expect(formatPullSummaryLine(summary)).not.toContain('already the same');
    });

    test('a fold that threw is written whole and named separately', () => {
        const summary = buildPullSummary({
            mergeFailed: [{ store: 'settings', key: 'plans', label: 'plans' }],
            expected: { settings: 1 },
        });

        expect(summary.overwritten).toBe(1);
        expect(summary.combined).toBe(0);
        // It took the download whole, so it is one of the whole writes too
        expect(summary.writtenWhole).toBe(1);
        expect(formatPullStoreLine(summary.stores[0])).toBe(
            'settings: 0 combined, 1 written whole, 0 held, 1 overwritten, unchanged unknown'
        );
    });

    test('a store with no expected count reports its whole writes as unknown, not zero', () => {
        const summary = buildPullSummary({
            merged: [{ store: 'mystery', key: 'k', label: 'thing' }],
            expected: {},
        });

        expect(summary.stores[0].writtenWhole).toBeNull();
        expect(summary.writtenWholePartial).toBe(true);
        expect(formatPullStoreLine(summary.stores[0])).toContain('written whole unknown');
    });

    test('an empty pull result summarises to nothing rather than throwing', () => {
        const summary = buildPullSummary();
        expect(summary).toMatchObject({ combined: 0, writtenWhole: 0, held: 0, stores: [] });
    });
});

describe('the toast line', () => {
    test('names only the outcomes that happened', () => {
        expect(formatPullSummaryLine(buildPullSummary(oneOfEach))).toBe(
            'Pull applied: 1 record combined, 1 written whole, 1 held unreadable.'
        );
    });

    test('pluralises, and drops the clauses that are zero', () => {
        const summary = buildPullSummary({
            merged: [
                { store: 's', key: 'a', label: 'a' },
                { store: 's', key: 'b', label: 'b' },
            ],
            expected: { s: 5 },
        });
        expect(formatPullSummaryLine(summary)).toBe('Pull applied: 2 records combined, 3 written whole.');
    });

    test('an unknown store count makes the whole-write figure a floor', () => {
        const summary = buildPullSummary({
            merged: [{ store: 'known', key: 'a', label: 'a' }],
            mergeHeld: [{ store: 'mystery', key: 'b', label: 'b' }],
            expected: { known: 3 },
        });
        expect(formatPullSummaryLine(summary)).toBe(
            'Pull applied: 1 record combined, at least 2 written whole, 1 held unreadable.'
        );
    });

    test('a pull that changed nothing says so', () => {
        expect(formatPullSummaryLine(buildPullSummary())).toBe('Pull applied: no records changed.');
        expect(formatPullSummaryLine(null)).toBe('');
    });
});

describe('the keys written whole are named', () => {
    test('each store lists the keys the apply wrote that no fold produced', () => {
        const summary = buildPullSummary({
            ...oneOfEach,
            writtenWholeKeys: [{ store: 'guildHistory', key: 'networthDetail_32030' }],
        });

        expect(summary.stores[0].wholeRecords).toEqual([{ key: 'networthDetail_32030' }]);
    });

    test('a failed fold is named once, as overwritten, and a store with no expected count names nothing', () => {
        const summary = buildPullSummary({
            mergeFailed: [{ store: 'guildHistory', key: 'trials', label: 'trial records' }],
            writtenWholeKeys: [
                { store: 'guildHistory', key: 'trials' },
                { store: 'guildHistory', key: 'other' },
                { store: 'unknownStore', key: 'x' },
            ],
            expected: { guildHistory: 2 },
        });
        const byStore = Object.fromEntries(summary.stores.map((store) => [store.store, store]));

        expect(byStore.guildHistory.wholeRecords).toEqual([{ key: 'other' }]);
        expect(byStore.unknownStore.wholeRecords).toEqual([]);
    });

    test('a result that does not name them leaves the list empty, not the count wrong', () => {
        const summary = buildPullSummary(oneOfEach);

        expect(summary.stores[0].wholeRecords).toEqual([]);
        expect(summary.stores[0].writtenWhole).toBe(1);
    });
});

describe('the session memory', () => {
    test('a second pull replaces the first, and a clear empties it', () => {
        rememberPullSummary(buildPullSummary(oneOfEach));
        expect(lastPullSummary().combined).toBe(1);

        rememberPullSummary(buildPullSummary({ expected: { settings: 4 } }));
        expect(lastPullSummary().combined).toBe(0);
        expect(lastPullSummary().writtenWhole).toBe(4);

        clearPullSummary();
        expect(lastPullSummary()).toBeNull();
    });
});

describe('row counts', () => {
    test('a value that throws when inspected counts as not applicable', () => {
        const hostile = new Proxy(
            {},
            {
                getPrototypeOf() {
                    throw new Error('no');
                },
            }
        );
        expect(countRows(hostile)).toBeNull();
    });

    test('an array is its length, a plain object its own keys, a missing value 0, anything else not countable', () => {
        expect(countRows(['a', 'b', 'b', 'c'])).toBe(4);
        expect(countRows({ x: 1, y: 2, z: 3 })).toBe(3);
        expect(countRows(Object.create(null))).toBe(0);
        expect(countRows(undefined)).toBe(0);
        expect(countRows(null)).toBe(0);
        expect(countRows([])).toBe(0);
        expect(countRows('text')).toBeNull();
        expect(countRows(7)).toBeNull();
        expect(countRows(true)).toBeNull();
        expect(countRows(new Map([[1, 2]]))).toBeNull();
        expect(countRows(new Date())).toBeNull();
    });

    test('counting does not copy or touch the value', () => {
        const value = Array.from({ length: 50_000 }, (_, i) => ({ i }));
        const before = value[0];
        expect(countRows(value)).toBe(50_000);
        expect(value[0]).toBe(before);
    });

    test('the summary keeps counts as numbers and drops anything else', () => {
        const summary = buildPullSummary({
            merged: [
                {
                    store: 's',
                    key: 'a_1',
                    label: 'a',
                    counts: { local: 12, pulled: 15, merged: 15, extra: ['secret'] },
                },
                { store: 's', key: 'b_1', label: 'b', counts: { local: 'many', pulled: -3, merged: Infinity } },
                { store: 's', key: 'c_1', label: 'c', counts: 'nope' },
                { store: 's', key: 'd_1', label: 'd' },
            ],
            expected: { s: 4 },
        });
        const [a, b, c, d] = summary.stores[0].combinedRecords;
        expect(a.counts).toEqual({ local: 12, pulled: 15, merged: 15 });
        expect(b.counts).toEqual({ local: null, pulled: null, merged: null });
        expect(c).not.toHaveProperty('counts');
        expect(d).not.toHaveProperty('counts');
    });
});

describe('timing around a pull', () => {
    const clock = (values) => {
        const queue = [...values];
        return { perfNow: () => queue.shift() };
    };

    test('notes the start, and closes with a duration', () => {
        const begun = beginPullTiming({ perfNow: () => 5000, sinceLoadNow: () => 7000, visibilityNow: () => 'hidden' });
        expect(begun).toEqual({ startPerf: 5000, sinceLoadMs: 7000, visibility: 'hidden' });
        const done = finishPullTiming(begun, null, clock([8200]));
        expect(done).toMatchObject({ startPerf: 5000, endPerf: 8200, durationMs: 3200, visibility: 'hidden' });
        expect(done.stall.status).toBe('unmeasured');
    });

    test('a clock that is missing or goes backwards gives no duration, not a negative one', () => {
        expect(
            finishPullTiming({ startPerf: null, sinceLoadMs: null, visibility: null }, null, clock([10])).durationMs
        ).toBeNull();
        expect(
            finishPullTiming({ startPerf: 500, sinceLoadMs: 1, visibility: null }, null, clock([100])).durationMs
        ).toBe(0);
        expect(finishPullTiming(null, null)).toBeNull();
    });

    test('the page clock helpers survive a browser without a time origin or a document', () => {
        const begun = beginPullTiming();
        expect(begun.startPerf === null || Number.isFinite(begun.startPerf)).toBe(true);
        expect(begun.visibility === null || typeof begun.visibility === 'string').toBe(true);
    });

    describe('the longest stall that overlaps the pull', () => {
        // The pull ran from 10_000 to 13_000 on the performance clock
        const run = (windows, extra = {}) =>
            longestStallDuring(
                { running: true, totalMs: windows.reduce((t, w) => t + (w?.lostMs || 0), 0), windows, ...extra },
                10_000,
                13_000
            );

        test('uses the stretch the page lost, which ends when the late beat ran', () => {
            // The beat ran at 14_000 after losing 2_500 ms: the lost time began at 11_500, inside the pull
            expect(run([{ perfAt: 14_000, lostMs: 2500, visibilityState: 'hidden' }])).toEqual({
                status: 'found',
                lostMs: 2500,
                visibility: 'hidden',
            });
        });

        test('a stall that ended before the pull began, or began after it ended, is not an overlap', () => {
            expect(run([{ perfAt: 9_900, lostMs: 4000, visibilityState: 'hidden' }]).status).toBe('none');
            expect(run([{ perfAt: 20_000, lostMs: 5000, visibilityState: 'hidden' }]).status).toBe('none');
        });

        test('the largest of several wins, and a stall that spans the whole pull counts', () => {
            const result = run([
                { perfAt: 11_000, lostMs: 400, visibilityState: 'visible' },
                { perfAt: 12_000, lostMs: 900, visibilityState: 'visible' },
                { perfAt: 25_000, lostMs: 20_000, visibilityState: 'hidden' },
            ]);
            expect(result).toEqual({ status: 'found', lostMs: 20_000, visibility: 'hidden' });
        });

        test('a ring that has dropped older windows and starts after the pull cannot say none', () => {
            const result = longestStallDuring(
                {
                    running: true,
                    totalMs: 90_000,
                    windows: [{ perfAt: 500_000, lostMs: 1000, visibilityState: 'visible' }],
                },
                10_000,
                13_000
            );
            expect(result.status).toBe('rolled-off');
        });

        test('a ring that has dropped windows but still reaches back past the pull answers none', () => {
            const result = longestStallDuring(
                {
                    running: true,
                    totalMs: 90_000,
                    windows: [
                        { perfAt: 5_000, lostMs: 1000, visibilityState: 'visible' },
                        { perfAt: 500_000, lostMs: 1000, visibilityState: 'visible' },
                    ],
                },
                10_000,
                13_000
            );
            expect(result.status).toBe('none');
        });

        test('an empty ring with nothing lost is none; no heartbeat or no diagnostics is unmeasured', () => {
            expect(run([]).status).toBe('none');
            expect(longestStallDuring({ running: false, totalMs: 0, windows: [] }, 10_000, 13_000).status).toBe(
                'unmeasured'
            );
            for (const lostTime of [undefined, null, {}, { windows: 'x' }, 'x']) {
                expect(longestStallDuring(lostTime, 10_000, 13_000).status).toBe('unmeasured');
            }
            expect(longestStallDuring({ running: true, windows: [] }, null, 13_000).status).toBe('unmeasured');
        });

        test('malformed windows are skipped, not trusted', () => {
            const result = run([
                null,
                { perfAt: 'x', lostMs: 5 },
                { perfAt: 12_000 },
                { perfAt: 12_000, lostMs: 600, visibilityState: 'hidden' },
            ]);
            expect(result).toEqual({ status: 'found', lostMs: 600, visibility: 'hidden' });
        });
    });

    test('the summary stores timing as numbers and short strings only', () => {
        const summary = buildPullSummary({
            timing: {
                startPerf: 1,
                endPerf: 2,
                sinceLoadMs: 3,
                durationMs: 1,
                visibility: 'visible',
                stall: { status: 'found', lostMs: 900, visibility: 'hidden', secret: 'x' },
                extra: { value: 'secret' },
            },
        });
        expect(summary.timing).toEqual({
            startPerf: 1,
            endPerf: 2,
            sinceLoadMs: 3,
            durationMs: 1,
            visibility: 'visible',
            stall: { status: 'found', lostMs: 900, visibility: 'hidden' },
        });
        expect(buildPullSummary({}).timing).toBeNull();
        expect(buildPullSummary({ timing: 'nope' }).timing).toBeNull();
        expect(buildPullSummary({ timing: { stall: { status: 'weird' } } }).timing.stall.status).toBe('unmeasured');
    });
});
