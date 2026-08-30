/**
 * Alchemy success-rate calibration.
 *
 * The two ways this could lie are the ones asserted hardest: judging a session
 * against a model it never saw (the unstamped ones), and letting one kind of
 * alchemy answer for another. The Wilson verdicts are pinned on both sides of
 * the interval, because "consistent" is a claim as much as "sim too high" is.
 */

import { describe, test, expect } from 'vitest';
import {
    compareSuccessRate,
    summarizeKind,
    summarizeAlchemyCalibration,
    isStamped,
    comboKey,
    verdictText,
    MIN_ATTEMPTS,
} from './alchemy-calibration.js';

/**
 * A tracker session, with only the fields the arithmetic reads.
 * @param {Object} fields - Overrides
 * @returns {Object}
 */
const session = ({
    id = 's1',
    inputItemHrid = '/items/cheese',
    predictedRate = 0.6,
    attempts = 200,
    successes = 120,
    catalyst = null,
    enhancementLevel = 0,
} = {}) => ({
    id,
    inputItemHrid,
    enhancementLevel,
    predictedRate,
    predictedAt: 1,
    predictedCatalystHrid: catalyst,
    totalAttempts: attempts,
    totalSuccesses: successes,
});

describe('isStamped', () => {
    test('accepts only a session carrying a usable prediction', () => {
        expect(isStamped(session())).toBe(true);
        expect(isStamped({ ...session(), predictedRate: null })).toBe(false);
        expect(isStamped({ ...session(), predictedRate: 0 })).toBe(false);
        expect(isStamped({ ...session(), predictedRate: undefined })).toBe(false);
        expect(isStamped(null)).toBe(false);
    });
});

describe('compareSuccessRate', () => {
    test('calls a sample consistent when the prediction is inside its interval', () => {
        const check = compareSuccessRate(120, 200, 0.6);
        expect(check.observed).toBeCloseTo(0.6);
        expect(check.verdict).toBe('consistent');
        expect(check.low).toBeLessThan(0.6);
        expect(check.high).toBeGreaterThan(0.6);
    });

    test('names which way the model is wrong when the interval excludes it', () => {
        // 400 successes in 1000 against a promised 60% — the model is too high
        expect(compareSuccessRate(400, 1000, 0.6).verdict).toBe('sim too high');
        // And the other way: the runs did better than promised
        expect(compareSuccessRate(800, 1000, 0.6).verdict).toBe('sim too low');
    });

    test('refuses below the attempt floor however extreme the sample looks', () => {
        const check = compareSuccessRate(0, MIN_ATTEMPTS - 1, 0.6);
        expect(check.verdict).toBe('too few attempts');
        expect(check.low).toBeNull();
        expect(verdictText(check)).toBe('Too few attempts to call');
    });

    test('a session with no prediction is not judged, it is named', () => {
        const check = compareSuccessRate(120, 200, null);
        expect(check.verdict).toBe('unstamped');
        expect(verdictText(check)).toBe('No prediction stamped');
    });

    test('successes cannot outnumber attempts, and nothing is not a crash', () => {
        expect(compareSuccessRate(500, 200, 0.6).observed).toBe(1);
        expect(compareSuccessRate(0, 0, 0.6).verdict).toBe('too few attempts');
        expect(compareSuccessRate(0, 0, 0.6).observed).toBeNull();
    });
});

describe('summarizeKind', () => {
    test('excludes unstamped sessions from the arithmetic and counts them', () => {
        const group = summarizeKind('decompose', [
            session({ id: 'a', attempts: 200, successes: 120, predictedRate: 0.6 }),
            // Recorded before stamping existed: it must not vote
            { ...session({ id: 'b', attempts: 5000, successes: 0 }), predictedRate: null },
        ]);

        expect(group.sessions).toBe(2);
        expect(group.stampedSessions).toBe(1);
        expect(group.unstamped).toBe(1);
        expect(group.attempts).toBe(200);
        expect(group.observed).toBeCloseTo(0.6);
        // The 5000 failed attempts would have condemned the model outright
        expect(group.verdict).toBe('consistent');
    });

    test('weights the pooled prediction by the attempts each session made', () => {
        const group = summarizeKind('transmute', [
            session({ id: 'a', predictedRate: 0.5, attempts: 900, successes: 450 }),
            session({ id: 'b', predictedRate: 0.9, attempts: 100, successes: 90 }),
        ]);
        // 0.5 over 900 and 0.9 over 100 is 0.54, not the 0.7 an unweighted mean gives
        expect(group.predicted).toBeCloseTo(0.54);
        expect(group.observed).toBeCloseTo(0.54);
    });

    test('splits combos by item AND catalyst, gating each on its own attempts', () => {
        const group = summarizeKind('transmute', [
            session({ id: 'a', inputItemHrid: '/items/cheese', attempts: 400, successes: 240 }),
            session({
                id: 'b',
                inputItemHrid: '/items/cheese',
                catalyst: '/items/prime_catalyst',
                predictedRate: 0.75,
                attempts: 400,
                successes: 240,
            }),
            session({ id: 'c', inputItemHrid: '/items/milk', attempts: 10, successes: 3 }),
        ]);

        expect(group.combos).toHaveLength(3);
        const plain = group.combos.find((combo) => combo.key === '/items/cheese|none|+0');
        const primed = group.combos.find((combo) => combo.key === '/items/cheese|/items/prime_catalyst|+0');
        const thin = group.combos.find((combo) => combo.key === '/items/milk|none|+0');

        // The catalyst is worth 15 or 25 percent of the rate, so the same item
        // run two ways was predicted two different things
        expect(plain.verdict).toBe('consistent');
        expect(primed.verdict).toBe('sim too high');
        expect(thin.verdict).toBe('too few attempts');
        // Decided combos lead; the thin one keeps its count and no figure
        expect(group.combos[group.combos.length - 1]).toBe(thin);
    });

    test('a kind with nothing but unstamped sessions issues no verdict', () => {
        const group = summarizeKind('coinify', [{ ...session(), predictedRate: null }]);
        expect(group.attempts).toBe(0);
        expect(group.verdict).toBe('too few attempts');
        expect(group.unstamped).toBe(1);
        expect(group.combos).toEqual([]);
    });
});

describe('comboKey', () => {
    test('separates item, catalyst and enhancement level', () => {
        expect(comboKey(session())).toBe('/items/cheese|none|+0');
        expect(comboKey(session({ catalyst: '/items/prime_catalyst', enhancementLevel: 3 }))).toBe(
            '/items/cheese|/items/prime_catalyst|+3'
        );
        expect(comboKey({})).toBe('unknown|none|+0');
    });
});

describe('summarizeAlchemyCalibration', () => {
    test('keeps the three kinds apart, so a wrong one cannot hide behind two right ones', () => {
        const summary = summarizeAlchemyCalibration({
            // Badly wrong: promised 60%, delivered 40% over a thousand attempts
            transmute: [session({ id: 't', predictedRate: 0.6, attempts: 1000, successes: 400 })],
            decompose: [session({ id: 'd', predictedRate: 0.6, attempts: 1000, successes: 600 })],
            coinify: [session({ id: 'c', predictedRate: 0.7, attempts: 1000, successes: 700 })],
        });

        expect(summary.kinds.map((group) => group.kind)).toEqual(['transmute', 'decompose', 'coinify']);
        expect(summary.kinds[0].verdict).toBe('sim too high');
        expect(summary.kinds[1].verdict).toBe('consistent');
        expect(summary.kinds[2].verdict).toBe('consistent');
        // Pooled, the transmute miss would have been diluted to nothing
        expect(summary.attempts).toBe(3000);
    });

    test('leaves out a kind with no sessions at all', () => {
        const summary = summarizeAlchemyCalibration({ coinify: [session()] });
        expect(summary.kinds).toHaveLength(1);
        expect(summary.kinds[0].kind).toBe('coinify');
    });

    test('nothing at all is empty, not a crash', () => {
        expect(summarizeAlchemyCalibration(null).kinds).toEqual([]);
        expect(summarizeAlchemyCalibration({}).kinds).toEqual([]);
    });
});
