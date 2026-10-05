import { describe, expect, test, vi } from 'vitest';

const seeds = vi.hoisted(() => []);
vi.mock('../guild-trial-model.js', async (importOriginal) => {
    const original = await importOriginal();
    return {
        ...original,
        trialRandom: (seed) => {
            seeds.push(seed);
            return original.trialRandom(seed);
        },
    };
});
import { simulateGuildSkilling } from './guild-skilling-simulator.js';

/** mulberry32 adds this to its state on every draw. */
const INCREMENT = 0x6d2b79f5n;
const MOD = 2n ** 32n;

function inverse(value) {
    let [oldR, r] = [value, MOD];
    let [oldS, s] = [1n, 0n];
    while (r) {
        const q = oldR / r;
        [oldR, r] = [r, oldR - q * r];
        [oldS, s] = [s, oldS - q * s];
    }
    return ((oldS % MOD) + MOD) % MOD;
}

/** How many draws apart two mulberry32 seeds walk the same stream (signed, nearest). */
function streamOffset(a, b) {
    const k = (((BigInt(b) - BigInt(a)) % MOD) * inverse(INCREMENT)) % MOD;
    const signed = (k + MOD) % MOD;
    return signed > MOD / 2n ? MOD - signed : signed;
}

describe('guild skilling attempt seeds', () => {
    // mulberry32 is one 2^32 cycle, so any two seeds are some distance apart on it. Raw
    // seeds stepped by 0x9e3779b9 put every pair of attempts 7 apart only 819,059 draws
    // apart (14 apart: 1.6M). Mixed seeds leave only chance overlaps: of 2,016 pairs,
    // about two are expected within 2M draws.
    test('attempts a fixed distance apart do not walk one stream at a fixed offset', () => {
        seeds.length = 0;
        simulateGuildSkilling({
            kind: 'skilling',
            trialHrid: '/guild_skilling/crafting',
            baseWork: 100,
            seconds: 1,
            runs: 64,
            seed: 1,
            members: [{ name: 'A', successRate: 0.5, workPower: 100, actionSeconds: 1 }],
        });
        expect(seeds).toHaveLength(64);
        let close = 0;
        for (let i = 0; i < seeds.length; i++)
            for (let j = i + 1; j < seeds.length; j++) if (streamOffset(seeds[i], seeds[j]) < 2_000_000n) close++;
        expect(close).toBeLessThanOrEqual(6);
    });
});
