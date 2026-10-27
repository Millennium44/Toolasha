import { describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    table: [
        { itemHrid: '/items/pirate_chest', dropRate: 1, minCount: 1, maxCount: 1 },
        { itemHrid: '/items/pirate_refinement_chest', dropRate: 1, minCount: 1, maxCount: 1 },
        { itemHrid: '/items/pirate_token', dropRate: 1, minCount: 50, maxCount: 50 },
    ],
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({
            actionDetailMap: {
                '/actions/combat/pirate_cove': { combatZoneInfo: { dungeonInfo: { rewardDropTable: game.table } } },
            },
        }),
    },
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({ default: { getLatestData: () => null } }));
// The sim pays five shares of the completion chest across the party
vi.mock('../combat-sim/combat-sim-adapter.js', () => ({
    calculateExpectedDrops: (simResult) =>
        new Map([
            ['/items/pirate_chest', 5 / simResult.numberOfPlayers],
            ['/items/pirate_refinement_chest', 1],
            ['/items/pirate_token', 50],
        ]),
}));

import {
    estimateKeyRunway,
    entryKeysPerClear,
    KEY_RUNWAY_WINDOW,
    KEY_RUNWAY_MIN_SAMPLES,
} from './dungeon-key-runway.js';

const MIN = 60 * 1000;

function clearsWith(durationsMs, startMs = Date.UTC(2026, 0, 1)) {
    // Oldest first: index i happened i minutes after the start.
    return durationsMs.map((duration, i) => ({ timestamp: new Date(startMs + i * MIN).toISOString(), duration }));
}

describe('estimateKeyRunway', () => {
    test('multiplies held keys by the average clear time', () => {
        const result = estimateKeyRunway(clearsWith([10 * MIN, 20 * MIN, 30 * MIN]), 4);
        expect(result.sampleSize).toBe(3);
        expect(result.seconds).toBe(20 * 60 * 4);
    });

    test('averages only the most recent clears, not the whole history', () => {
        const old = Array(50).fill(60 * MIN); // slow, old runs
        const recent = Array(KEY_RUNWAY_WINDOW).fill(10 * MIN); // newer, faster runs
        const result = estimateKeyRunway(clearsWith([...old, ...recent]), 6);
        expect(result.sampleSize).toBe(KEY_RUNWAY_WINDOW);
        expect(result.seconds).toBe(10 * 60 * 6);
    });

    test('is independent of input order and uses totalTime as a fallback', () => {
        const clears = clearsWith([10 * MIN, 20 * MIN, 30 * MIN]).reverse();
        clears[0] = { timestamp: clears[0].timestamp, totalTime: 30 * MIN };
        expect(estimateKeyRunway(clears, 1).seconds).toBe(20 * 60);
    });

    test('returns null with no keys', () => {
        expect(estimateKeyRunway(clearsWith(Array(5).fill(10 * MIN)), 0)).toBeNull();
        expect(estimateKeyRunway(clearsWith(Array(5).fill(10 * MIN)), undefined)).toBeNull();
    });

    test('returns null with too few usable clears', () => {
        const few = clearsWith(Array(KEY_RUNWAY_MIN_SAMPLES - 1).fill(10 * MIN));
        expect(estimateKeyRunway(few, 5)).toBeNull();
        expect(estimateKeyRunway(clearsWith([0, 0, 0, 0]), 5)).toBeNull();
    });

    test('one key is one average clear; fractional or negative keys give nothing', () => {
        const clears = clearsWith([10 * MIN, 10 * MIN, 10 * MIN]);
        expect(estimateKeyRunway(clears, 1).seconds).toBe(10 * 60);
        expect(estimateKeyRunway(clears, -2)).toBeNull();
        expect(estimateKeyRunway(clears, NaN)).toBeNull();
    });

    test('an unknown dungeon has no clears, so no estimate', () => {
        expect(estimateKeyRunway([], 5)).toBeNull();
    });

    test('does not reorder or mutate the caller list', () => {
        const clears = clearsWith([10 * MIN, 20 * MIN, 30 * MIN]).reverse();
        const copy = JSON.stringify(clears);
        estimateKeyRunway(clears, 2);
        expect(JSON.stringify(clears)).toBe(copy);
    });
});

describe('entry keys per clear', () => {
    const PIRATE = '/actions/combat/pirate_cove';

    test('a solo player spends a key per chest share, a full party one, and a refinement chest none', () => {
        expect(entryKeysPerClear(PIRATE, 1, 1)).toBe(5);
        expect(entryKeysPerClear(PIRATE, 1, 5)).toBe(1);
    });

    test('an unloaded reward table is unknown, not one key', () => {
        expect(entryKeysPerClear('/actions/combat/never_heard_of_it', 0, 1)).toBeNull();
    });

    test('the runway divides the held keys by the keys each clear spends', () => {
        const clears = clearsWith([10 * MIN, 10 * MIN, 10 * MIN]);
        expect(estimateKeyRunway(clears, 10, 5).seconds).toBe(10 * 60 * 2);
        expect(estimateKeyRunway(clears, 10).seconds).toBe(10 * 60 * 10);
    });
});
