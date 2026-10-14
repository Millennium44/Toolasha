/**
 * The combined forecast of a session that ran in several predicted legs (a merge of runs, a
 * resume under changed stats, an extension): predicted success rate per level and the expected
 * climb, rebuilt from what each leg recorded when it was predicted.
 *
 * The predictions here come from the real calculator, shaped the way calculateEnhancementPredictions
 * stores them, so the per-level expectations are the game's own arithmetic rather than a fixture
 * that agrees with the code.
 */

import { describe, expect, test } from 'vitest';
import { calculateEnhancement } from '../../utils/enhancement-calculator.js';
import {
    createSession,
    extendSession,
    finalizeSession,
    foldSessions,
    mergedExpectation,
    planSessionMerge,
    recordFailure,
    recordSuccess,
    resumeSession,
    SessionState,
    summedLegPredictions,
} from './enhancement-session.js';

const CAPE = '/items/sinister_cape';
const ITEM_LEVEL = 85;

/** Two stat sets: a lower and a higher enhancing level, so the same level predicts differently */
const LOW = { enhancingLevel: 110, toolBonus: 3 };
const HIGH = { enhancingLevel: 130, toolBonus: 6 };

/**
 * A prediction stored the way calculateEnhancementPredictions stores one.
 * @param {number} startLevel - Level the leg starts at
 * @param {number} targetLevel - Level it is headed for
 * @param {number} protectFrom - Protect-from level
 * @param {{enhancingLevel: number, toolBonus: number}} stats - Character stats
 * @param {boolean} [withLevels] - Include per-level expectations
 * @returns {Object}
 */
function predict(startLevel, targetLevel, protectFrom, stats, withLevels = true) {
    const base = { ...stats, itemLevel: ITEM_LEVEL, speedBonus: 0, startLevel };
    const result = calculateEnhancement({ ...base, targetLevel, protectFrom });
    const levelExpectations = {};
    if (withLevels) {
        for (let level = startLevel + 1; level < targetLevel; level++) {
            const part = calculateEnhancement({
                ...base,
                targetLevel: level,
                protectFrom: protectFrom <= level ? protectFrom : 0,
            });
            levelExpectations[level] = [part.attempts, part.protectionCount];
        }
    }
    return {
        expectedAttempts: Math.round(result.attemptsRounded),
        expectedProtections: Math.round(result.protectionCount),
        expectedAttemptsExact: result.attempts,
        expectedProtectionsExact: result.protectionCount,
        levelExpectations,
        successRates: result.successRates,
        successMultiplier: result.successMultiplier,
    };
}

let clock = 1_000_000;

/**
 * One finished run: a session predicted on `stats`, played through `moves`.
 * @param {string} id - Session id
 * @param {number} start - Start level
 * @param {Array<[number, number]>} moves - `[from, to]` per attempt
 * @param {Object} stats - Stats it was predicted with
 * @param {number} [target] - Target level
 * @returns {Object}
 */
function run(id, start, moves, stats, target = 7) {
    const session = createSession(CAPE, 'Sinister Cape', start, target, 4);
    session.id = id;
    session.predictions = predict(start, target, 4, stats);
    for (const [from, to] of moves) {
        if (to > from) recordSuccess(session, from, to);
        else recordFailure(session, from, to);
    }
    if (session.state !== SessionState.COMPLETED) finalizeSession(session);
    clock += 10_000;
    Object.assign(session, {
        startTime: clock,
        lastUpdateTime: clock + 5_000,
        endTime: clock + 5_000,
        lastAttempt: { attemptNumber: moves.length, level: session.currentLevel, timestamp: clock + 5_000 },
    });
    clock += 10_000;
    return session;
}

/** Four runs that chain +4 → +5 → +5 → +6 → +7 (the first and third on LOW stats, the others HIGH) */
function fourRuns() {
    return [
        run(
            's1',
            4,
            [
                [4, 3],
                [3, 4],
                [4, 5],
            ],
            LOW
        ),
        run(
            's2',
            5,
            [
                [5, 6],
                [6, 5],
            ],
            HIGH
        ),
        run(
            's3',
            5,
            [
                [5, 4],
                [4, 5],
                [5, 6],
            ],
            LOW
        ),
        run('s4', 6, [[6, 7]], HIGH),
    ];
}

function mergeFour() {
    const plan = planSessionMerge(fourRuns());
    expect(plan.ok).toBe(true);
    return foldSessions(plan.ordered);
}

describe('legs record how many attempts they made at each level', () => {
    test('each folded run keeps its own per-level tally, summing to its attempts', () => {
        const merged = mergeFour();
        expect(merged.legPredictions.map((leg) => leg.levelAttempts)).toEqual([
            { 3: 1, 4: 2 },
            { 5: 1, 6: 1 },
            { 4: 1, 5: 2 },
            { 6: 1 },
        ]);
        for (const leg of merged.legPredictions) {
            const total = Object.values(leg.levelAttempts).reduce((sum, n) => sum + n, 0);
            expect(total).toBe(leg.attempts);
        }
    });

    test('resuming or extending a session banks the leg with its tally; the next leg gets only its own', () => {
        const session = run(
            'r1',
            4,
            [
                [4, 5],
                [5, 4],
                [4, 5],
            ],
            LOW,
            6
        );
        session.currentLevel = 5;
        resumeSession(session, clock, { newPredictions: predict(5, 6, 4, HIGH) });
        session.predictions = predict(5, 6, 4, HIGH);
        recordFailure(session, 5, 4);
        recordSuccess(session, 4, 5);
        finalizeSession(session);
        extendSession(session, 8);
        expect(session.legPredictions.map((leg) => leg.levelAttempts)).toEqual([
            { 4: 2, 5: 1 },
            { 4: 1, 5: 1 },
        ]);
    });

    test('a tally that does not add up to the leg is left out rather than guessed', () => {
        const session = run('r2', 4, [[4, 5]], LOW);
        session.totalAttempts += 3; // attempts the per-level tally never saw
        const merged = foldSessions(planSessionMerge([session, run('r3', 5, [[5, 6]], LOW)]).ordered);
        expect(merged.legPredictions[0].levelAttempts).toBeUndefined();
    });
});

describe('predicted success rate per level', () => {
    test("is the legs' own rates weighted by the attempts each made at the level", () => {
        const merged = mergeFour();
        const { successRates } = mergedExpectation(merged);
        const low = predict(4, 7, 4, LOW).successRates;
        const high = predict(4, 7, 4, HIGH).successRates;
        expect(low[5].actualRate).not.toBeCloseTo(high[5].actualRate);

        // +4: only the first run attempted it... and the third once, both on LOW
        expect(successRates[4].actualRate).toBeCloseTo(low[4].actualRate, 9);
        // +5: s2 (HIGH) made 1 attempt, s3 (LOW) made 2
        expect(successRates[5].actualRate).toBeCloseTo((high[5].actualRate + 2 * low[5].actualRate) / 3, 9);
        // +6: s2 (HIGH) and s4 (HIGH), one each
        expect(successRates[6].actualRate).toBeCloseTo(high[6].actualRate, 9);
        expect(successRates[5].legs).toBe(2);
    });

    test("a level nobody attempted takes the latest leg's rate", () => {
        const { successRates } = mergedExpectation(mergeFour());
        const high = predict(6, 7, 4, HIGH).successRates;
        expect(successRates[2].actualRate).toBeCloseTo(high[2].actualRate, 9);
        expect(successRates[2].legs).toBe(0);
    });

    test('a leg without per-level tallies is weighted by its attempts spread over its levels', () => {
        const merged = mergeFour();
        delete merged.legPredictions[1].levelAttempts; // s2: 2 attempts over +5..+6 → 1 per level
        const { successRates } = mergedExpectation(merged);
        const low = predict(4, 7, 4, LOW).successRates;
        const high = predict(4, 7, 4, HIGH).successRates;
        expect(successRates[5].actualRate).toBeCloseTo((high[5].actualRate + 2 * low[5].actualRate) / 3, 9);
    });
});

describe('expected attempts and protections for the whole merged path', () => {
    test("is built step by step from the legs' own per-level expectations, attempt-weighted", () => {
        const merged = mergeFour();
        const { expected } = mergedExpectation(merged);
        expect(expected.basis).toBe('path');
        expect([expected.fromLevel, expected.toLevel]).toEqual([4, 7]);

        const a = predict(4, 7, 4, LOW); // s1
        const b = predict(5, 7, 4, HIGH); // s2
        const c = predict(5, 7, 4, LOW); // s3
        // step +4 → +5: only s1 started low enough to forecast it
        const step5 = a.levelExpectations[5][0];
        // step +5 → +6: s1 (made no attempts at +5), s2 (1), s3 (2)
        const m1 = a.levelExpectations[6][0] - a.levelExpectations[5][0];
        const m2 = b.levelExpectations[6][0];
        const m3 = c.levelExpectations[6][0];
        const step6 = (0 * m1 + 1 * m2 + 2 * m3) / 3;
        // step +6 → +7: s1 (0 attempts at +6), s2 (1), s3 (0), s4 (1)
        const n1 = a.expectedAttemptsExact - a.levelExpectations[6][0];
        const n2 = b.expectedAttemptsExact - b.levelExpectations[6][0];
        const n4 = predict(6, 7, 4, HIGH).expectedAttemptsExact;
        const step7 = (n2 + n4) / 2;
        expect(n1).toBeGreaterThan(0);
        expect(expected.expectedAttempts).toBe(Math.round(step5 + step6 + step7));
    });

    test("equals one run's whole forecast when every leg ran on the same stats", () => {
        const same = [
            run(
                't1',
                4,
                [
                    [4, 3],
                    [3, 4],
                    [4, 5],
                ],
                LOW
            ),
            run(
                't2',
                5,
                [
                    [5, 6],
                    [6, 5],
                ],
                LOW
            ),
            run(
                't3',
                5,
                [
                    [5, 4],
                    [4, 5],
                    [5, 6],
                ],
                LOW
            ),
            run('t4', 6, [[6, 7]], LOW),
        ];
        const merged = foldSessions(planSessionMerge(same).ordered);
        const whole = predict(4, 7, 4, LOW);
        const { expected } = mergedExpectation(merged);
        expect(expected.expectedAttempts).toBe(whole.expectedAttempts);
        expect(expected.expectedProtections).toBe(whole.expectedProtections);
    });

    test('reads against the furthest level a session that stopped short got to', () => {
        const stopped = [run('u1', 4, [[4, 5]], LOW), run('u2', 5, [[5, 6]], LOW)];
        const merged = foldSessions(planSessionMerge(stopped).ordered);
        const { expected } = mergedExpectation(merged);
        expect([expected.fromLevel, expected.toLevel]).toEqual([4, 6]);
        expect(expected.expectedAttempts).toBe(Math.round(predict(4, 6, 4, LOW).expectedAttemptsExact));
    });

    test('counts a Blessed jump that a failure then undid as reached', () => {
        // +4 → +6 on a Blessed success, a protected failure at +6 leaves +5; the second run picks
        // up at +5 and ends there too
        const first = run(
            'b1',
            4,
            [
                [4, 6],
                [6, 5],
            ],
            LOW
        );
        first.attemptsPerLevel[4].blessed = 1;
        const second = run(
            'b2',
            5,
            [
                [5, 4],
                [4, 5],
            ],
            LOW
        );
        const merged = foldSessions(planSessionMerge([first, second]).ordered);
        expect(merged.currentLevel).toBe(5);
        const { expected } = mergedExpectation(merged);
        expect([expected.fromLevel, expected.toLevel]).toEqual([4, 6]);
        expect(expected.expectedAttempts).toBe(Math.round(predict(4, 6, 4, LOW).expectedAttemptsExact));
    });

    test('is never stored on the session and the session stays out of calibration', () => {
        const merged = mergeFour();
        mergedExpectation(merged);
        expect(merged.predictions).toBeNull();
        expect(merged.mergedFrom).toEqual(['s1', 's2', 's3']);
    });
});

describe('sessions recorded before this change', () => {
    test('legs without per-level expectations still combine when each reached its own target', () => {
        const legacy = [run('v1', 4, [[4, 5]], LOW, 5), run('v2', 5, [[5, 6]], HIGH, 6)];
        for (const s of legacy) s.predictions.levelExpectations = {};
        const merged = foldSessions(planSessionMerge(legacy).ordered);
        for (const leg of merged.legPredictions) delete leg.levelAttempts;
        const result = mergedExpectation(merged);
        expect(result.expected.basis).toBe('path');
        expect(result.expected.expectedAttempts).toBe(summedLegPredictions(merged).expectedAttempts);
    });

    test('legs that stopped short without per-level expectations leave the expectation unknown', () => {
        const merged = mergeFour();
        for (const leg of merged.legPredictions) {
            leg.predictions = { ...leg.predictions, levelExpectations: undefined };
            delete leg.levelAttempts;
        }
        const result = mergedExpectation(merged);
        expect(result.expected).toBeNull();
        // ...while the rates are still combined, from the legs' totals
        expect(result.successRates[5].actualRate).toBeGreaterThan(0);
    });

    test('a run without a forecast leaves the expectation unknown, though the other legs could cover the climb', () => {
        const merged = mergeFour();
        const before = mergedExpectation(merged).expected;
        expect(before).not.toBeNull();
        // s3 (the third run) lost its forecast, e.g. its calculation failed on resume
        merged.legPredictions[2].predictions = null;
        const result = mergedExpectation(merged);
        expect(result.expected).toBeNull();
        // Rates stay only where every run that attempted the level had a forecast: +6 was s2 and s4
        expect(result.successRates[6]).toBeDefined();
        expect(result.successRates[5]).toBeUndefined();
        expect(result.successRates[4]).toBeUndefined();
    });

    test('attempts outside every recorded leg leave the expectation and rates unknown', () => {
        const merged = mergeFour();
        merged.totalAttempts += 2;
        const result = mergedExpectation(merged);
        expect(result.expected).toBeNull();
        expect(result.successRates).toEqual({});
    });

    test('a session with no legs has no combined forecast', () => {
        expect(mergedExpectation(run('w1', 4, [[4, 5]], LOW))).toBeNull();
    });

    test('a session whose levels no forecast covers shows nothing for those levels', () => {
        const merged = mergeFour();
        merged.legPredictions.forEach((leg) => {
            leg.predictions = { ...leg.predictions, successRates: undefined, levelExpectations: undefined };
        });
        const result = mergedExpectation(merged);
        expect(result.successRates).toEqual({});
    });
});
