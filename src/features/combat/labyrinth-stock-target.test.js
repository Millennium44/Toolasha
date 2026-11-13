import { describe, expect, test } from 'vitest';
import { labCapacity, labPerRunNeed, labShortfall } from './labyrinth-stock-target.js';

const run = (key, torch) => ({
    key,
    startTrusted: true,
    left: { torch: 0 },
    start: { torch },
    spent: { torch },
    endedAt: 1000,
});

describe('labyrinth stock target', () => {
    test('capacity comes from characterInfo, else the base cap', () => {
        expect(labCapacity({ labyrinthTorchCap: 320 }, 'torch')).toBe(320);
        expect(labCapacity({}, 'torch')).toBe(100);
        expect(labCapacity(undefined, 'shroud')).toBe(4);
        expect(labCapacity({ labyrinthBeaconCap: 0 }, 'beacon')).toBe(5);
    });

    test('measured basis averages the recorded runs, rounding up; capacity basis and no runs use the cap', () => {
        expect(labPerRunNeed('torch', 100, [run('a', 60), run('b', 81)], 'measured')).toEqual({
            perRun: 71,
            observedRuns: 2,
        });
        expect(labPerRunNeed('torch', 100, [run('a', 60)], 'capacity')).toEqual({ perRun: 100, observedRuns: 0 });
        expect(labPerRunNeed('torch', 100, [], 'measured')).toEqual({ perRun: 100, observedRuns: 0 });
    });

    test('only the last five measured runs count', () => {
        const runs = [1, 2, 3, 4, 5, 600].map((n, i) => run(`r${i}`, n));
        expect(labPerRunNeed('torch', 100, runs, 'measured').observedRuns).toBe(5);
    });

    test('shortfall is runs x need less held, never negative', () => {
        expect(labShortfall(71, 10, 100)).toBe(610);
        expect(labShortfall(2.5, 3, 0)).toBe(8);
        expect(labShortfall(5, 1, 99)).toBe(0);
    });
});
