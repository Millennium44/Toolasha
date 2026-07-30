import { describe, it, expect, afterEach, vi } from 'vitest';
import {
    clearSimRng,
    deriveSeed,
    isSimRngSeeded,
    random,
    randomSeed,
    randomSetup,
    randomSpawn,
    seedSimRng,
    syncEncounterRng,
} from './rng.js';

/**
 * Draw n values from a stream.
 * @param {Function} draw - Stream function
 * @param {number} n - Count
 * @returns {number[]}
 */
function take(draw, n) {
    return Array.from({ length: n }, () => draw());
}

afterEach(() => {
    clearSimRng();
    vi.restoreAllMocks();
});

describe('seedSimRng', () => {
    it('replays the same sequence for the same seed', () => {
        seedSimRng(12345);
        const first = take(random, 20);
        seedSimRng(12345);
        expect(take(random, 20)).toEqual(first);
    });

    it('produces a different sequence for a different seed', () => {
        seedSimRng(1);
        const first = take(random, 20);
        seedSimRng(2);
        expect(take(random, 20)).not.toEqual(first);
    });

    it('keeps draws in [0, 1)', () => {
        seedSimRng(99);
        for (const value of take(random, 500)) {
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThan(1);
        }
    });

    it('spreads draws roughly uniformly', () => {
        seedSimRng(7);
        const values = take(random, 20000);
        const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
        expect(mean).toBeGreaterThan(0.48);
        expect(mean).toBeLessThan(0.52);

        const buckets = new Array(10).fill(0);
        for (const value of values) buckets[Math.floor(value * 10)]++;
        for (const count of buckets) {
            expect(count).toBeGreaterThan(1600);
            expect(count).toBeLessThan(2400);
        }
    });

    it('gives each stream an independent sequence', () => {
        seedSimRng(555);
        const combat = take(random, 10);
        seedSimRng(555);
        const spawn = take(randomSpawn, 10);
        seedSimRng(555);
        const setup = take(randomSetup, 10);

        expect(spawn).not.toEqual(combat);
        expect(setup).not.toEqual(combat);
        expect(setup).not.toEqual(spawn);
    });

    it('leaves the spawn stream unaffected by combat draws', () => {
        seedSimRng(31337);
        const spawnOnly = take(randomSpawn, 10);

        // A different loadout burns a different number of combat rolls; the spawn
        // sequence must not shift, or the two sims stop fighting the same monsters
        seedSimRng(31337);
        take(random, 137);
        expect(take(randomSpawn, 10)).toEqual(spawnOnly);
    });

    it('falls back to Math.random() when unseeded', () => {
        const spy = vi.spyOn(Math, 'random').mockReturnValue(0.42);

        expect(isSimRngSeeded()).toBe(false);
        expect(random()).toBe(0.42);
        expect(randomSpawn()).toBe(0.42);
        expect(randomSetup()).toBe(0.42);
        expect(spy).toHaveBeenCalledTimes(3);
    });

    it('treats null, undefined and non-numeric seeds as unseeded', () => {
        for (const seed of [null, undefined, '', NaN, 'abc']) {
            expect(seedSimRng(seed)).toBe(false);
            expect(isSimRngSeeded()).toBe(false);
        }
        expect(seedSimRng(0)).toBe(true);
        expect(isSimRngSeeded()).toBe(true);
    });

    it('clearSimRng returns every stream to Math.random()', () => {
        seedSimRng(4);
        expect(isSimRngSeeded()).toBe(true);
        clearSimRng();
        expect(isSimRngSeeded()).toBe(false);

        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        expect(random()).toBe(0.5);
    });
});

describe('syncEncounterRng', () => {
    it('starts an encounter from the same state regardless of earlier draws', () => {
        seedSimRng(8080);
        syncEncounterRng(5);
        const expected = take(random, 10);

        // A different loadout burns a different number of rolls before encounter 5
        seedSimRng(8080);
        take(random, 913);
        syncEncounterRng(5);
        expect(take(random, 10)).toEqual(expected);
    });

    it('gives consecutive encounters different draws', () => {
        seedSimRng(8080);
        syncEncounterRng(0);
        const first = take(random, 10);
        syncEncounterRng(1);
        expect(take(random, 10)).not.toEqual(first);
    });

    it('resets the setup stream alongside the combat stream', () => {
        seedSimRng(606);
        syncEncounterRng(2);
        const expected = take(randomSetup, 5);

        seedSimRng(606);
        take(randomSetup, 17);
        syncEncounterRng(2);
        expect(take(randomSetup, 5)).toEqual(expected);
    });

    it('leaves the spawn stream running so the monster order keeps advancing', () => {
        seedSimRng(4321);
        const continuous = take(randomSpawn, 6);

        seedSimRng(4321);
        const interrupted = [];
        for (let i = 0; i < 6; i++) {
            syncEncounterRng(i);
            interrupted.push(randomSpawn());
        }
        expect(interrupted).toEqual(continuous);
    });

    it('is a no-op while unseeded', () => {
        expect(syncEncounterRng(3)).toBe(false);
        expect(isSimRngSeeded()).toBe(false);
    });
});

describe('deriveSeed', () => {
    it('is deterministic in (seed, index)', () => {
        expect(deriveSeed(777, 3)).toBe(deriveSeed(777, 3));
    });

    it('gives each index a distinct seed', () => {
        const seeds = new Set(Array.from({ length: 32 }, (_, i) => deriveSeed(777, i)));
        expect(seeds.size).toBe(32);
    });

    it('returns null without a base seed', () => {
        expect(deriveSeed(null, 0)).toBe(null);
        expect(deriveSeed(undefined, 2)).toBe(null);
    });

    it('yields sequences that differ per index but replay per (seed, index)', () => {
        seedSimRng(deriveSeed(2024, 0));
        const chunk0 = take(random, 10);
        seedSimRng(deriveSeed(2024, 1));
        const chunk1 = take(random, 10);
        expect(chunk1).not.toEqual(chunk0);

        seedSimRng(deriveSeed(2024, 0));
        expect(take(random, 10)).toEqual(chunk0);
    });
});

describe('randomSeed', () => {
    it('returns a non-negative 31-bit integer', () => {
        for (let i = 0; i < 50; i++) {
            const seed = randomSeed();
            expect(Number.isInteger(seed)).toBe(true);
            expect(seed).toBeGreaterThanOrEqual(0);
            expect(seed).toBeLessThan(0x7fffffff);
        }
    });
});
