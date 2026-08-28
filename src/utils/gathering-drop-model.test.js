import { describe, test, expect } from 'vitest';
import {
    buildGatheringSession,
    gatheringLootValue,
    gatheringSessionMean,
    gatheringSessionLuck,
    formatOrdinal,
    describeRunLuck,
} from './gathering-drop-model.js';

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

/** Prices by lookup table, unlisted items priceless */
const pricedAt = (prices) => (itemHrid) => prices[itemHrid] ?? null;

describe('buildGatheringSession', () => {
    test('no completed actions is no session — the floor combat uses, mirrored', () => {
        const actionDetail = { dropTable: [{ itemHrid: '/items/log', dropRate: 1, minCount: 1, maxCount: 1 }] };
        const priceOf = pricedAt({ '/items/log': 50 });

        expect(buildGatheringSession({ actionDetail, actionCount: 0, priceOf })).toBeNull();
        expect(buildGatheringSession({ actionDetail, actionCount: -3, priceOf })).toBeNull();
        expect(buildGatheringSession({ actionDetail, actionCount: undefined, priceOf })).toBeNull();
    });

    test('no drop table is no session, which is what production and combat look like here', () => {
        const priceOf = pricedAt({});
        expect(buildGatheringSession({ actionDetail: null, actionCount: 10, priceOf })).toBeNull();
        expect(buildGatheringSession({ actionDetail: {}, actionCount: 10, priceOf })).toBeNull();
        expect(buildGatheringSession({ actionDetail: { dropTable: [] }, actionCount: 10, priceOf })).toBeNull();
    });

    test('nothing priced is no session rather than a distribution of nothing', () => {
        const actionDetail = { dropTable: [{ itemHrid: '/items/unpriced', dropRate: 1, minCount: 1, maxCount: 1 }] };

        expect(buildGatheringSession({ actionDetail, actionCount: 10, priceOf: pricedAt({}) })).toBeNull();
    });

    test('prices the table and drops what cannot roll or cannot sell', () => {
        const actionDetail = {
            dropTable: [
                { itemHrid: '/items/log', dropRate: 1, minCount: 1, maxCount: 2 },
                { itemHrid: '/items/never', dropRate: 0, minCount: 1, maxCount: 1 },
                { itemHrid: '/items/nothing', dropRate: 1, minCount: 0, maxCount: 0 },
                { itemHrid: '/items/unpriced', dropRate: 0.5, minCount: 1, maxCount: 1 },
            ],
        };
        const session = buildGatheringSession({
            actionDetail,
            actionCount: 25,
            priceOf: pricedAt({ '/items/log': 40, '/items/never': 10, '/items/nothing': 10 }),
        });

        expect(session.actionCount).toBe(25);
        expect(session.drops).toEqual([{ itemHrid: '/items/log', minCount: 1, maxCount: 2, dropRate: 1, price: 40 }]);
    });

    test('a rate above one is clamped, not trusted', () => {
        const actionDetail = { dropTable: [{ itemHrid: '/items/log', dropRate: 1.4, minCount: 1, maxCount: 1 }] };
        const session = buildGatheringSession({ actionDetail, actionCount: 5, priceOf: pricedAt({ '/items/log': 1 }) });

        expect(session.drops[0].dropRate).toBe(1);
    });
});

describe('gatheringLootValue', () => {
    const session = {
        drops: [
            { itemHrid: '/items/log', minCount: 1, maxCount: 1, dropRate: 1, price: 40 },
            { itemHrid: '/items/gem', minCount: 1, maxCount: 1, dropRate: 0.01, price: 100000 },
        ],
        actionCount: 100,
    };

    test('counts modelled items at the model’s own prices', () => {
        expect(gatheringLootValue(session, { '/items/log': 100, '/items/gem': 2 })).toBe(100 * 40 + 2 * 100000);
    });

    test('leaves unmodelled loot out, mirroring what the distribution never rolls for', () => {
        // The essence is real income, but the model has no distribution for it —
        // counting it here would read every essence proc as gathering luck
        expect(gatheringLootValue(session, { '/items/log': 10, '/items/essence': 3 })).toBe(400);
    });

    test('strips enhancement suffixes before matching', () => {
        expect(gatheringLootValue(session, { '/items/log::0': 5 })).toBe(200);
    });

    test('nothing dropped is nothing owed back', () => {
        expect(gatheringLootValue(session, {})).toBe(0);
        expect(gatheringLootValue(session, null)).toBe(0);
    });
});

describe('gatheringSessionMean', () => {
    test('rate x average count x price, summed and scaled by actions', () => {
        const session = {
            drops: [
                { itemHrid: '/items/log', minCount: 2, maxCount: 4, dropRate: 0.5, price: 100 },
                { itemHrid: '/items/gem', minCount: 1, maxCount: 1, dropRate: 0.01, price: 10000 },
            ],
            actionCount: 20,
        };
        // (0.5 * 3 * 100 + 0.01 * 1 * 10000) * 20 = (150 + 100) * 20
        expect(gatheringSessionMean(session)).toBeCloseTo(5000, 6);
    });
});

describe('gatheringSessionLuck against a distribution that can be written down', () => {
    test('matches an exact binomial across its whole range', () => {
        // One drop, fixed count, coin flip: income is 1000 x Binomial(20, 1/2)
        const session = {
            drops: [{ itemHrid: '/items/x', minCount: 1, maxCount: 1, dropRate: 0.5, price: 1000 }],
            actionCount: 20,
        };
        const { cdf, limit } = gatheringSessionLuck(session, 0);

        // The window search has to find 20000 starting from 100000000
        expect(limit).toBeGreaterThan(20000);
        expect(limit).toBeLessThan(30000);

        for (let k = 0; k <= 20; k++) {
            expect(cdf(1000 * (k + 0.5))).toBeCloseTo(binomialCDF(k, 20, 0.5), 3);
        }
    });

    test('one expensive drop cannot shrink the window under its own payout', () => {
        // 50 actions at a guaranteed 500M drop: the old heuristic window
        // (max(1e8, 2e5 x 50) = 1e8) is far below the 25B the transform must
        // represent, which aliased the CDF into nonsense
        const session = {
            drops: [{ itemHrid: '/items/big', minCount: 1, maxCount: 1, dropRate: 1, price: 5e8 }],
            actionCount: 50,
        };
        const { limit, percentile } = gatheringSessionLuck(session, 50 * 5e8);
        expect(limit).toBeGreaterThanOrEqual(50 * 5e8);
        // A guaranteed income is neither lucky nor unlucky nonsense
        expect(percentile).toBeGreaterThanOrEqual(0);
        expect(percentile).toBeLessThanOrEqual(1);
    });

    test('reports a percentile, not a value', () => {
        const session = {
            drops: [{ itemHrid: '/items/x', minCount: 1, maxCount: 1, dropRate: 0.5, price: 1000 }],
            actionCount: 20,
        };
        expect(gatheringSessionLuck(session, 10500).percentile).toBeCloseTo(binomialCDF(10, 20, 0.5), 2);
        expect(gatheringSessionLuck(session, 0).percentile).toBeLessThan(0.01);
        expect(gatheringSessionLuck(session, 20000).percentile).toBeGreaterThan(0.99);
    });

    test('a rare-dominated run is judged by its lumps, not by a bell curve', () => {
        // A certain 100-coin drop plus a 1-in-100 rare worth a million, over 100
        // actions. Income is 10,000 guaranteed plus 1,000,000 per rare, and the
        // rare count is Binomial(100, 0.01) — so the distribution is a few
        // discrete lumps a million apart, exactly what a normal approximation
        // flattens away.
        const session = {
            drops: [
                { itemHrid: '/items/log', minCount: 1, maxCount: 1, dropRate: 1, price: 100 },
                { itemHrid: '/items/gem', minCount: 1, maxCount: 1, dropRate: 0.01, price: 1000000 },
            ],
            actionCount: 100,
        };
        const { cdf } = gatheringSessionLuck(session, 10000);

        // Between the lumps the CDF is flat at the exact binomial:
        // P(0 rares) = 0.99^100 = 0.3660, P(<=1) = 0.7358. A normal
        // approximation puts a zero-rare run one sigma under the mean, around
        // the 16th percentile — a "bad run" verdict for the single most common
        // outcome. The exact distribution knows better.
        expect(cdf(510000)).toBeCloseTo(Math.pow(0.99, 100), 2);
        expect(cdf(1510000)).toBeCloseTo(binomialCDF(1, 100, 0.01), 2);

        // The verdicts a real session sees. A real income lands exactly on a
        // lump, and the smoothed CDF read at an atom gives the mid-p value —
        // everything below the lump plus half the lump itself. So zero rares
        // reads near 0.366/2 = 0.183 and one rare near 0.366 + 0.370/2 = 0.551:
        // ordinary and mildly lucky, never the catastrophe or miracle a smooth
        // curve a million coins wide would print.
        const zeroRares = gatheringSessionLuck(session, 10000).percentile;
        expect(zeroRares).toBeCloseTo(Math.pow(0.99, 100) / 2, 1);
        const oneRare = gatheringSessionLuck(session, 1010000).percentile;
        expect(oneRare).toBeCloseTo(
            binomialCDF(0, 100, 0.01) + (binomialCDF(1, 100, 0.01) - binomialCDF(0, 100, 0.01)) / 2,
            1
        );
        expect(oneRare).toBeGreaterThan(zeroRares);
    });

    test('stays a CDF: bounded, and never goes backwards', () => {
        const session = {
            drops: [
                { itemHrid: '/items/a', minCount: 1, maxCount: 4, dropRate: 0.8, price: 300 },
                { itemHrid: '/items/b', minCount: 1, maxCount: 1, dropRate: 0.005, price: 500000 },
            ],
            actionCount: 40,
        };
        const { cdf, limit } = gatheringSessionLuck(session, 0);

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

    test('a long run costs the same shape of answer as a short one', () => {
        // The power in powCF is what makes this cheap; this pins that it is
        // also still right — mean of Binomial(50000, 0.2) x 10 is 100,000
        const session = {
            drops: [{ itemHrid: '/items/x', minCount: 1, maxCount: 1, dropRate: 0.2, price: 10 }],
            actionCount: 50000,
        };
        const atMean = gatheringSessionLuck(session, 100000).percentile;
        expect(atMean).toBeGreaterThan(0.4);
        expect(atMean).toBeLessThan(0.6);
    });
});

describe('the verdict in words', () => {
    test('ordinals read as ranks', () => {
        expect(formatOrdinal(0.73)).toBe('73rd');
        expect(formatOrdinal(0.11)).toBe('11th');
        expect(formatOrdinal(0.52)).toBe('52nd');
        expect(formatOrdinal(0.005)).toBe('1st');
        expect(formatOrdinal(0.999)).toBe('99th');
    });

    test('wording matches the combat verdict word for word', () => {
        // Pinned because combat's describeLuck lives in another bundle and the
        // two verdicts must read the same
        expect(describeRunLuck(0.5).text).toBe('50th percentile — 50 runs in 100 beat it');
        expect(describeRunLuck(0.03).text).toBe('3rd percentile — 97 runs in 100 beat it');
    });

    test('tones split at the same thresholds combat uses', () => {
        expect(describeRunLuck(0.75).tone).toBe('lucky');
        expect(describeRunLuck(0.74).tone).toBe('normal');
        expect(describeRunLuck(0.26).tone).toBe('normal');
        expect(describeRunLuck(0.25).tone).toBe('unlucky');
    });
});
