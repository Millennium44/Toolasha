import { describe, test, expect } from 'vitest';
import { dropCF, multiplyCFs, powCF, constantCF, invertToCDF, waveCF, sessionLuck } from './drop-luck.js';

/** A zone that always spawns exactly one of one monster */
const soloZone = {
    spawns: [{ combatMonsterHrid: '/monsters/m', rate: 1, strength: 1 }],
    maxSpawnCount: 1,
    maxTotalStrength: 1,
};

/** The exact CDF of a binomial, to check the transform against */
function binomialCDF(k, n, p) {
    let sum = 0;
    let term = Math.pow(1 - p, n);
    for (let i = 0; i <= k; i++) {
        sum += term;
        term *= ((n - i) / (i + 1)) * (p / (1 - p));
    }
    return sum;
}

/** Read a count distribution back out of a CDF over income, at price 1 */
function countDistribution(drop, waves = 1) {
    const { cdf } = sessionLuck(
        { spawnInfo: soloZone, monsterDrops: { '/monsters/m': [drop] }, normalCount: waves },
        0
    );
    const pmf = [];
    for (let k = 0; k <= Math.ceil(drop.maxCount * waves); k++) {
        pmf.push(cdf(k + 0.5) - (k ? cdf(k - 0.5) : 0));
    }
    return pmf;
}

describe('characteristic function algebra', () => {
    test('a constant is constant at every frequency', () => {
        const values = constantCF(3)(8, 1);
        expect(values).toHaveLength(8);
        for (const [re, im] of values) {
            expect(re).toBe(3);
            expect(im).toBe(0);
        }
    });

    test('multiplying nothing gives one, which is the sum of nothing', () => {
        expect(multiplyCFs([])(4, 1)[0]).toEqual([1, 0]);
    });

    test('a product of two constants is their product', () => {
        expect(multiplyCFs([constantCF(2), constantCF(5)])(4, 1)[0]).toEqual([10, 0]);
    });

    test('a power is repeated multiplication', () => {
        const cf = dropCF({ minCount: 1, maxCount: 1, dropRate: 0.5, price: 100 });
        const cubed = powCF(cf, 3)(16, 1e-4);
        const byHand = multiplyCFs([cf, cf, cf])(16, 1e-4);

        for (let i = 0; i < 16; i++) {
            expect(cubed[i][0]).toBeCloseTo(byHand[i][0], 10);
            expect(cubed[i][1]).toBeCloseTo(byHand[i][1], 10);
        }
    });

    test('every characteristic function is one at zero frequency', () => {
        // Total probability. If this drifts, everything downstream is scaled wrong
        const cf = dropCF({ minCount: 2, maxCount: 7, dropRate: 0.3, price: 55 });
        const [re, im] = cf(8, 1e-5)[0];
        expect(re).toBeCloseTo(1, 10);
        expect(im).toBeCloseTo(0, 10);
    });
});

describe('the count a drop pays', () => {
    test('a fixed count is that count', () => {
        const pmf = countDistribution({ minCount: 3, maxCount: 3, dropRate: 1, price: 1 });
        expect(pmf[3]).toBeCloseTo(1, 3);
    });

    test('a range spreads evenly, with half weight at each end', () => {
        // Uniform on [1, 5] rounded to the nearest whole item: the end bins are
        // half outside the range, so they get half the weight of the interior
        const pmf = countDistribution({ minCount: 1, maxCount: 5, dropRate: 1, price: 1 });
        expect(pmf[0]).toBeCloseTo(0, 3);
        expect(pmf[1]).toBeCloseTo(0.125, 3);
        expect(pmf[2]).toBeCloseTo(0.25, 3);
        expect(pmf[3]).toBeCloseTo(0.25, 3);
        expect(pmf[4]).toBeCloseTo(0.25, 3);
        expect(pmf[5]).toBeCloseTo(0.125, 3);
    });

    test('a fractional fixed count splits between its neighbours', () => {
        // Only whole items drop, so 1.5 has to be half ones and half twos —
        // rounding it to a flat 2 would overpay by a third
        const pmf = countDistribution({ minCount: 1.5, maxCount: 1.5, dropRate: 1, price: 1 });
        expect(pmf[1]).toBeCloseTo(0.5, 3);
        expect(pmf[2]).toBeCloseTo(0.5, 3);
    });

    test('a drop rate below one leaves mass at nothing', () => {
        const pmf = countDistribution({ minCount: 1, maxCount: 3, dropRate: 0.5, price: 1 });
        expect(pmf[0]).toBeCloseTo(0.5, 3);
        expect(pmf.slice(1).reduce((sum, p) => sum + p, 0)).toBeCloseTo(0.5, 3);
    });
});

describe('inversion against a distribution that can be written down', () => {
    test('matches an exact binomial across its whole range', () => {
        // One monster, one drop, fixed count: income is 1000 × Binomial(20, ½)
        const session = {
            spawnInfo: soloZone,
            monsterDrops: { '/monsters/m': [{ minCount: 1, maxCount: 1, dropRate: 0.5, price: 1000 }] },
            normalCount: 20,
        };
        const { cdf, limit } = sessionLuck(session, 0);

        // The window search has to find 20000 starting from 100000000
        expect(limit).toBeGreaterThan(20000);
        expect(limit).toBeLessThan(30000);

        for (let k = 0; k <= 20; k++) {
            expect(cdf(1000 * (k + 0.5))).toBeCloseTo(binomialCDF(k, 20, 0.5), 3);
        }
    });

    test('reports a percentile, not a value', () => {
        const session = {
            spawnInfo: soloZone,
            monsterDrops: { '/monsters/m': [{ minCount: 1, maxCount: 1, dropRate: 0.5, price: 1000 }] },
            normalCount: 20,
        };
        // 10 kills' worth is the typical session — and the percentile there is
        // 0.588 rather than 0.5, because a fifth of all sessions land on exactly
        // 10 and the percentile counts them as not having done worse
        expect(sessionLuck(session, 10500).percentile).toBeCloseTo(binomialCDF(10, 20, 0.5), 2);
        expect(sessionLuck(session, 0).percentile).toBeLessThan(0.01);
        expect(sessionLuck(session, 20000).percentile).toBeGreaterThan(0.99);
    });

    test('stays a CDF: bounded, and never goes backwards', () => {
        const session = {
            spawnInfo: soloZone,
            monsterDrops: {
                '/monsters/m': [
                    { minCount: 1, maxCount: 4, dropRate: 0.8, price: 300 },
                    { minCount: 1, maxCount: 1, dropRate: 0.005, price: 500000 },
                ],
            },
            normalCount: 40,
        };
        const { cdf, limit } = sessionLuck(session, 0);

        let previous = -1;
        for (let i = 0; i <= 200; i++) {
            const value = cdf((i / 200) * limit);
            expect(value).toBeGreaterThanOrEqual(0);
            expect(value).toBeLessThanOrEqual(1);
            expect(value).toBeGreaterThanOrEqual(previous - 1e-9);
            previous = value;
        }
        expect(cdf(-1)).toBe(0);
        expect(cdf(limit * 10)).toBe(1);
    });
});

describe('waveCF', () => {
    test('the strength budget keeps a heavy monster out of the income', () => {
        // B costs the whole budget, so a wave is either one B or up to two As.
        // A wave can therefore never pay for both.
        const zone = {
            spawns: [
                { combatMonsterHrid: '/monsters/a', rate: 1, strength: 1 },
                { combatMonsterHrid: '/monsters/b', rate: 1, strength: 2 },
            ],
            maxSpawnCount: 2,
            maxTotalStrength: 2,
        };
        const drops = {
            '/monsters/a': [{ minCount: 1, maxCount: 1, dropRate: 1, price: 1 }],
            '/monsters/b': [{ minCount: 1, maxCount: 1, dropRate: 1, price: 10 }],
        };
        const { cdf } = invertToCDF(waveCF(zone, drops), 1e8);

        // Income is 10 (B, probability ½), 2 (A then A, ¼) or 1 (A then overflow, ¼)
        expect(cdf(0.5)).toBeCloseTo(0, 2);
        expect(cdf(1.5)).toBeCloseTo(0.25, 2);
        expect(cdf(2.5)).toBeCloseTo(0.5, 2);
        expect(cdf(9.5)).toBeCloseTo(0.5, 2);
        expect(cdf(10.5)).toBeCloseTo(1, 2);
    });

    test('an empty or weightless table pays nothing', () => {
        expect(waveCF({ spawns: [] }, {})(4, 1)[0]).toEqual([1, 0]);
        expect(waveCF({ spawns: [{ combatMonsterHrid: '/m', rate: 0, strength: 1 }] }, {})(4, 1)[0]).toEqual([1, 0]);
    });

    test('rates are weights and get normalised', () => {
        // Read as bare probabilities, a table summing to 4 would give a wave four
        // times the income it should
        const zone = {
            spawns: [
                { combatMonsterHrid: '/monsters/a', rate: 3, strength: 1 },
                { combatMonsterHrid: '/monsters/b', rate: 1, strength: 1 },
            ],
            maxSpawnCount: 1,
            maxTotalStrength: 1,
        };
        const drops = {
            '/monsters/a': [{ minCount: 1, maxCount: 1, dropRate: 1, price: 100 }],
            '/monsters/b': [{ minCount: 1, maxCount: 1, dropRate: 1, price: 100 }],
        };
        const { cdf } = invertToCDF(waveCF(zone, drops), 1e8);

        // Exactly one monster spawns either way, so income is always 100
        expect(cdf(50)).toBeCloseTo(0, 2);
        expect(cdf(150)).toBeCloseTo(1, 2);
    });
});

describe('sessionLuck', () => {
    test('boss waves add to the income', () => {
        const session = {
            spawnInfo: soloZone,
            monsterDrops: { '/monsters/m': [{ minCount: 1, maxCount: 1, dropRate: 1, price: 100 }] },
            bossDrops: { boss: [{ minCount: 1, maxCount: 1, dropRate: 1, price: 5000 }] },
            normalCount: 10,
            bossCount: 2,
        };
        // Everything is certain here: 10 × 100 + 2 × 5000
        const { cdf } = sessionLuck(session, 0);
        expect(cdf(10900)).toBeCloseTo(0, 2);
        expect(cdf(11100)).toBeCloseTo(1, 2);
    });

    test('a session with no drops at all is not a crash', () => {
        const { percentile } = sessionLuck({ spawnInfo: soloZone, monsterDrops: {}, normalCount: 5 }, 0);
        expect(Number.isFinite(percentile)).toBe(true);
    });

    test('a single high-value drop does not undersize the window', () => {
        // One kill, one guaranteed item worth 500 million: well past the 1e8 /
        // 2e5-per-wave heuristic that used to seed the search alone. Before the
        // window was widened to account for the session's own maximum possible
        // income, the search would converge on a window many times too small —
        // the transform is periodic, so the true payout wrapped back into the
        // window at essentially a random position, and the reported percentile
        // and CDF were wrong without any error or warning.
        const session = {
            spawnInfo: soloZone,
            monsterDrops: { '/monsters/m': [{ minCount: 1, maxCount: 1, dropRate: 1, price: 5e8 }] },
            normalCount: 1,
        };
        const { limit, cdf } = sessionLuck(session, 5e8);

        // The window has to actually contain the deterministic payout
        expect(limit).toBeGreaterThan(5e8);
        // Below the guaranteed payout there should be essentially no mass, and
        // above it the CDF should be saturated — a distribution smeared across
        // an undersized, wrapped-around window fails both of these
        expect(cdf(4.9e8)).toBeLessThan(0.01);
        expect(cdf(5.1e8)).toBeGreaterThan(0.99);
    });

    test('a large observed income does not undersize the window either', () => {
        // Same idea, but triggered through the `income` argument rather than the
        // drop table: a session that actually paid more than the wave-count
        // heuristic anticipated must still get a window that contains that value.
        const session = {
            spawnInfo: soloZone,
            monsterDrops: { '/monsters/m': [{ minCount: 1, maxCount: 1, dropRate: 0.01, price: 5e8 }] },
            normalCount: 1,
        };
        const { limit } = sessionLuck(session, 5e8);
        expect(limit).toBeGreaterThan(5e8);
    });
});
