import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({ default: { getSetting: () => false, getSettingValue: (_k, d) => d } }));
vi.mock('../../core/storage.js', () => ({ default: { getJSON: async () => null, setJSON: async () => {} } }));
vi.mock('../../core/data-manager.js', () => ({ default: { getSkills: () => null } }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));

const { groupByFloor, floorSummary } = await import('./labyrinth-room-logs.js');

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
