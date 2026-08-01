import { describe, test, expect } from 'vitest';
import { expectedSpawnsPerWave, expectedSpawnsOverWaves } from './spawn-expectation.js';

/** A spawn table entry, in the shape the game's data uses */
const spawn = (name, rate, strength) => ({ combatMonsterHrid: `/monsters/${name}`, rate, strength });

describe('expectedSpawnsPerWave', () => {
    test('a wave that can only hold one monster is just the draw probabilities', () => {
        const table = { spawns: [spawn('a', 1, 1), spawn('b', 1, 1)], maxSpawnCount: 1, maxTotalStrength: 5 };
        expect(expectedSpawnsPerWave(table)).toEqual({ '/monsters/a': 0.5, '/monsters/b': 0.5 });
    });

    test('the strength budget makes a heavy monster rarer than its weight', () => {
        // Equal weights, but B costs the whole budget: drawing it first ends the
        // wave, and it can never be the second monster
        const table = { spawns: [spawn('a', 1, 1), spawn('b', 1, 2)], maxSpawnCount: 2, maxTotalStrength: 2 };
        const expected = expectedSpawnsPerWave(table);

        // A: 0.5 on the first draw, plus 0.5 × 0.5 on the second when the first was A
        expect(expected['/monsters/a']).toBeCloseTo(0.75, 12);
        // B: only ever the first draw
        expect(expected['/monsters/b']).toBeCloseTo(0.5, 12);
    });

    test('rates are weights and get normalised', () => {
        // Read as bare probabilities these would give 3 and 1 monsters from a
        // single draw. The game normalises by the table's total when it draws,
        // and so must this.
        const table = { spawns: [spawn('a', 3, 1), spawn('b', 1, 1)], maxSpawnCount: 1, maxTotalStrength: 5 };
        expect(expectedSpawnsPerWave(table)).toEqual({ '/monsters/a': 0.75, '/monsters/b': 0.25 });
    });

    test('a wave with room to spare fills to the spawn cap', () => {
        const table = { spawns: [spawn('a', 1, 1)], maxSpawnCount: 3, maxTotalStrength: 99 };
        expect(expectedSpawnsPerWave(table)['/monsters/a']).toBeCloseTo(3, 12);
    });

    test('the strength budget caps the wave below the spawn cap', () => {
        // Room for three draws, budget for two
        const table = { spawns: [spawn('a', 1, 1)], maxSpawnCount: 3, maxTotalStrength: 2 };
        expect(expectedSpawnsPerWave(table)['/monsters/a']).toBeCloseTo(2, 12);
    });

    test('expected counts never exceed the spawn cap', () => {
        const table = {
            spawns: [spawn('a', 5, 1), spawn('b', 3, 2), spawn('c', 2, 3)],
            maxSpawnCount: 4,
            maxTotalStrength: 6,
        };
        const total = Object.values(expectedSpawnsPerWave(table)).reduce((sum, n) => sum + n, 0);
        expect(total).toBeGreaterThan(0);
        expect(total).toBeLessThanOrEqual(4);
    });

    test('a monster too heavy to ever fit never appears', () => {
        const table = { spawns: [spawn('a', 1, 1), spawn('huge', 1, 99)], maxSpawnCount: 2, maxTotalStrength: 2 };
        expect(expectedSpawnsPerWave(table)['/monsters/huge']).toBe(0);
    });

    test('survives a missing, empty or weightless table', () => {
        expect(expectedSpawnsPerWave(null)).toEqual({});
        expect(expectedSpawnsPerWave({ spawns: [], maxSpawnCount: 3, maxTotalStrength: 3 })).toEqual({});
        expect(expectedSpawnsPerWave({ spawns: [spawn('a', 0, 1)], maxSpawnCount: 3, maxTotalStrength: 3 })).toEqual(
            {}
        );
        expect(expectedSpawnsPerWave({ spawns: [spawn('a', 1, 1)], maxSpawnCount: 0, maxTotalStrength: 3 })).toEqual(
            {}
        );
    });
});

describe('expectedSpawnsOverWaves', () => {
    test('scales the per-wave figure', () => {
        const table = { spawns: [spawn('a', 1, 1), spawn('b', 1, 1)], maxSpawnCount: 1, maxTotalStrength: 5 };
        expect(expectedSpawnsOverWaves(table, 10)).toEqual({ '/monsters/a': 5, '/monsters/b': 5 });
    });

    test('no waves means none of anything', () => {
        const table = { spawns: [spawn('a', 1, 1)], maxSpawnCount: 1, maxTotalStrength: 5 };
        expect(expectedSpawnsOverWaves(table, 0)).toEqual({ '/monsters/a': 0 });
    });

    test('a run length that is not a count gives nothing rather than NaN', () => {
        const table = { spawns: [spawn('a', 1, 1)], maxSpawnCount: 1, maxTotalStrength: 5 };
        expect(expectedSpawnsOverWaves(table, undefined)).toEqual({});
        expect(expectedSpawnsOverWaves(table, -3)).toEqual({});
    });
});
