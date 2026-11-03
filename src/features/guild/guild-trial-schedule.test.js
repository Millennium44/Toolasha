/**
 * The guild's trial schedule hour offset: what it means, and that the ledger's schedule follows it.
 *
 * Evidence (test server, 2026-11-02, capture toolasha-wire-captures-2026-11-02-trial.json): the offset is 21;
 * the game's chat line "The guild trials have begun!" arrived at 3:00:05 PM US Central on 11/2, 3:00:06 PM on
 * 11/1 and 4:00:06 PM on 10/31 (Central went from daylight to standard time on 11/1), which is 21:00 UTC each
 * time; the captured combat battle started 22:00:08 UTC.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

const server = vi.hoisted(() => ({ test: true }));
vi.mock('../../utils/game-server.js', () => ({ isTestServer: () => server.test, liveGameOrigin: (o) => o }));
vi.mock('../../core/storage.js', () => ({ default: {} }));

import { getScheduleHourOffset, parseScheduleHourOffset, setScheduleHourOffset } from './guild-trial-schedule.js';
import { ASSUMED_TEST_SKILLING_HOUR_UTC, ledgerWindowCycles, scheduledCycle } from './guild-trial-ledger.js';
import { trialWeekStart } from './guild-trials-math.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const utc = (iso) => Date.parse(iso);

afterEach(() => {
    setScheduleHourOffset(null);
    server.test = true;
});

describe('reading the offset', () => {
    test('0 is a value, not missing; junk and out-of-range are missing', () => {
        expect(parseScheduleHourOffset(0)).toBe(0);
        expect(parseScheduleHourOffset('0')).toBe(0);
        expect(parseScheduleHourOffset(21)).toBe(21);
        expect(parseScheduleHourOffset('21')).toBe(21);
        for (const bad of [null, undefined, '', -1, 24, 21.5, 'x', NaN, true, {}, []]) {
            expect(parseScheduleHourOffset(bad)).toBeNull();
        }
    });

    test('what the game stated is held, an unreadable value clears it, 0 stays 0', () => {
        expect(getScheduleHourOffset()).toBeNull();
        setScheduleHourOffset(21);
        expect(getScheduleHourOffset()).toBe(21);
        setScheduleHourOffset(0);
        expect(getScheduleHourOffset()).toBe(0);
        setScheduleHourOffset('junk');
        expect(getScheduleHourOffset()).toBeNull();
    });
});

describe('the test server’s daily schedule follows the offset', () => {
    test('offset 21 puts the cycle’s opening at the three observed "have begun" instants', () => {
        for (const [day, begun] of [
            ['2026-10-31', '2026-10-31T21:00:06Z'],
            ['2026-11-01', '2026-11-01T21:00:06Z'],
            ['2026-11-02', '2026-11-02T21:00:05Z'],
        ]) {
            const cycle = scheduledCycle(utc(begun), true, 21);
            expect(cycle.opens).toBe(utc(`${day}T21:00:00Z`));
            expect(cycle.assumed).toBe(false);
            // The captured combat battle, 22:00:08 UTC, is inside it, an hour after it opens
            const combat = utc(`${day}T22:00:08Z`);
            expect(scheduledCycle(combat, true, 21).opens).toBe(cycle.opens);
            expect(combat - cycle.opens).toBeLessThan(2 * HOUR);
        }
    });

    test('a stated offset moves the opening; 0 is midnight, not the old assumption', () => {
        const at = utc('2026-11-02T12:00:00Z');
        expect(scheduledCycle(at, true, 3)).toMatchObject({ opens: utc('2026-11-02T03:00:00Z'), assumed: false });
        expect(scheduledCycle(at, true, 0)).toMatchObject({ opens: utc('2026-11-02T00:00:00Z'), assumed: false });
        expect(scheduledCycle(at, true, 0).end).toBe(utc('2026-11-02T02:00:00Z'));
        // The combat hour follows the skilling hour: a 04:00 fight belongs to the offset-3 cycle
        expect(scheduledCycle(utc('2026-11-02T04:00:17Z'), true, 3).opens).toBe(utc('2026-11-02T03:00:00Z'));
    });

    test('a missing offset keeps the assumed 21:00 and says it was assumed', () => {
        expect(ASSUMED_TEST_SKILLING_HOUR_UTC).toBe(21);
        const cycle = scheduledCycle(utc('2026-11-02T22:00:17Z'), true);
        expect(cycle).toMatchObject({
            from: utc('2026-11-02T10:00:00Z'),
            opens: utc('2026-11-02T21:00:00Z'),
            end: utc('2026-11-02T23:00:00Z'),
            assumed: true,
        });
        // The same figures as a stated 21
        expect(scheduledCycle(utc('2026-11-02T22:00:17Z'), true, 21)).toEqual({ ...cycle, assumed: false });
    });

    test('the default is the offset the game stated, and clearing it falls back', () => {
        const at = utc('2026-11-02T12:00:00Z');
        setScheduleHourOffset(5);
        expect(scheduledCycle(at, true).opens).toBe(utc('2026-11-02T05:00:00Z'));
        setScheduleHourOffset(0);
        expect(scheduledCycle(at, true).opens).toBe(utc('2026-11-02T00:00:00Z'));
        setScheduleHourOffset(null);
        expect(scheduledCycle(at, true)).toMatchObject({ opens: utc('2026-11-02T21:00:00Z'), assumed: true });
    });

    test('the cycles of a window are consecutive days under any offset, so a changed offset only shifts the grid', () => {
        const now = utc('2026-11-02T23:30:00Z');
        for (const offset of [0, 3, 21, 23]) {
            setScheduleHourOffset(offset);
            const cycles = ledgerWindowCycles(4, { now, daily: true });
            expect(cycles.length).toBeGreaterThanOrEqual(4);
            for (let i = 1; i < cycles.length; i += 1) {
                expect(cycles[i].opens - cycles[i - 1].opens).toBe(DAY);
                expect(cycles[i].end - cycles[i].opens).toBe(2 * HOUR);
            }
        }
    });
});

describe('the live weekly schedule keeps its stored key', () => {
    test('from is the week start whatever the offset; opens follows it, end is a week on', () => {
        server.test = false;
        const at = utc('2026-11-03T12:00:00Z');
        const week = trialWeekStart(at);
        for (const offset of [null, 0, 21]) {
            const cycle = scheduledCycle(at, false, offset);
            expect(cycle.from).toBe(week);
            expect(cycle.end).toBe(week + 7 * DAY);
            expect(cycle.opens).toBe(week + (offset ?? 0) * HOUR);
            expect(cycle.assumed).toBe(offset === null);
        }
    });

    test('before a live cycle has opened, the newest cycle in a window is the one before', () => {
        const week = trialWeekStart(utc('2026-11-03T12:00:00Z'));
        const early = week + 2 * HOUR;
        setScheduleHourOffset(21);
        const held = ledgerWindowCycles(1, { now: early, daily: false });
        expect(held.at(-1).from).toBe(week - 7 * DAY);
        setScheduleHourOffset(0);
        expect(ledgerWindowCycles(1, { now: early, daily: false }).at(-1).from).toBe(week);
        setScheduleHourOffset(null);
        expect(ledgerWindowCycles(1, { now: early, daily: false }).at(-1).from).toBe(week);
    });

    test('a record stamped under a week is found under any offset', () => {
        server.test = false;
        const stored = trialWeekStart(utc('2026-10-20T12:00:00Z'));
        for (const offset of [null, 0, 9, 21]) {
            expect(scheduledCycle(stored + 3 * DAY, false, offset).from).toBe(stored);
        }
    });
});
