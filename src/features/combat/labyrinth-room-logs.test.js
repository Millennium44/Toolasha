/** @vitest-environment happy-dom */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, Z_FLOATING_PANEL: 1100 },
}));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getSkills: () => null } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));

const { groupByFloor, floorSummary, labyrinthRoomLogs } = await import('./labyrinth-room-logs.js');

const room = (over = {}) => ({
    runKey: 'run|15',
    floor: 15,
    startedAt: 1_000_000,
    endedAt: 1_060_000,
    xp: 30_000,
    completed: true,
    ...over,
});

describe('groupByFloor', () => {
    test('splits a newest-first list into floors', () => {
        const groups = groupByFloor([
            room(),
            room(),
            room({ runKey: 'run|14', floor: 14 }),
            room({ runKey: 'run|13', floor: 13 }),
        ]);
        expect(groups.map((g) => g.floor)).toEqual([15, 14, 13]);
        expect(groups[0].sessions).toHaveLength(2);
    });

    test('a floor revisited on a later run is its own group', () => {
        // Merging every session sharing a floor number would blend two separate
        // visits into one throughput figure
        const groups = groupByFloor([room({ runKey: 'runB|3', floor: 3 }), room({ runKey: 'runA|3', floor: 3 })]);
        expect(groups).toHaveLength(2);
        expect(groups.every((g) => g.floor === 3)).toBe(true);
    });

    test('survives rooms logged before floors were recorded', () => {
        const groups = groupByFloor([{ startedAt: 1 }, { startedAt: 2 }]);
        expect(groups).toHaveLength(1);
        expect(groups[0].floor).toBe(0);
    });

    test('handles nothing at all', () => {
        expect(groupByFloor(null)).toEqual([]);
    });
});

describe('floorSummary', () => {
    test('adds up time, experience and clears', () => {
        const summary = floorSummary([room(), room({ endedAt: 1_120_000, xp: 30_000, completed: false })]);
        expect(summary).toMatchObject({ rooms: 2, cleared: 1, seconds: 180, xp: 60_000 });
        expect(summary.xpPerHour).toBe(1_200_000);
    });

    test('a room still running contributes no time', () => {
        // An unfinished room has no duration yet, and guessing one would make
        // the floor's rate lurch about while you are standing in it
        const summary = floorSummary([room({ endedAt: 0, xp: 0 })]);
        expect(summary.seconds).toBe(0);
        expect(summary.xpPerHour).toBeNull();
    });

    test('no experience measured means no rate, not a rate of zero', () => {
        expect(floorSummary([room({ xp: 0 })]).xpPerHour).toBeNull();
    });

    test('handles an empty floor', () => {
        expect(floorSummary([])).toMatchObject({ rooms: 0, cleared: 0, xpPerHour: null });
    });
});

describe('the sim accuracy list opens a room type at a time', () => {
    const row = (level, over = {}) => ({
        subjectHrid: '/skills/milking',
        kind: 'skilling',
        monster: 'milking',
        level,
        attempts: 2,
        clears: 1,
        predicted: 0.5,
        observed: 0.5,
        low: 0.1,
        high: 0.9,
        likelihood: 0.5,
        verdict: 'consistent',
        measured: null,
        timing: null,
        rates: null,
        ...over,
    });

    const snapshot = {
        rows: [row(173), row(186), row(191)],
        summary: { buckets: 3, attempts: 6, clears: 3, judged: 6, judgedClears: 3, expected: 3, contested: 0 },
        bySubject: [
            {
                subjectHrid: '/skills/milking',
                kind: 'skilling',
                monster: 'milking',
                levels: 3,
                lowestLevel: 173,
                highestLevel: 191,
                attempts: 6,
                clears: 3,
                judged: 6,
                judgedClears: 3,
                expected: 3,
                predicted: 0.5,
                observed: 0.5,
                low: 0.2,
                high: 0.8,
                offBy: 0,
                verdict: 'consistent',
            },
        ],
    };

    const text = () => document.querySelector('.mwi-lab-logs-list').textContent;
    const cards = () => document.querySelectorAll('.mwi-lab-logs-list > div');

    beforeEach(async () => {
        document.body.innerHTML = '';
        labyrinthRoomLogs.panel = null;
        labyrinthRoomLogs.view = 'accuracy';
        labyrinthRoomLogs.expandedSubjects = new Set();
        labyrinthRoomLogs.simSource = { accuracy: async () => snapshot };
        await labyrinthRoomLogs.renderAccuracy();
    });

    test('a room type starts closed, showing its pooled reading only', () => {
        // The record runs to a couple of hundred rooms; opening on all of them
        // is a wall rather than a list
        // Not a bare 'Lv.173' — the pooled row names the range it covers
        expect(text()).toContain('Milking — all levels');
        expect(text()).not.toContain('Milking Lv.173');
    });

    test('and says there is something behind it', () => {
        expect(text()).toContain('click to open');
    });

    test('clicking it shows its levels', async () => {
        [...cards()][1].click();
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).toContain('Milking Lv.173');
        expect(text()).toContain('Milking Lv.191');
    });

    test('and clicking it again puts them away', async () => {
        [...cards()][1].click();
        await labyrinthRoomLogs.renderAccuracy();
        [...cards()][1].click();
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).not.toContain('Milking Lv.173');
    });

    test('one room type opening does not open the others', async () => {
        labyrinthRoomLogs.simSource = {
            accuracy: async () => ({
                ...snapshot,
                rows: [...snapshot.rows, row(200, { subjectHrid: '/skills/brewing', monster: 'brewing' })],
                bySubject: [
                    ...snapshot.bySubject,
                    { ...snapshot.bySubject[0], subjectHrid: '/skills/brewing', monster: 'brewing', levels: 1 },
                ],
            }),
        };
        labyrinthRoomLogs.expandedSubjects = new Set(['/skills/milking']);
        await labyrinthRoomLogs.renderAccuracy();

        expect(text()).toContain('Milking Lv.173');
        expect(text()).not.toContain('Brewing Lv.200');
    });
});
