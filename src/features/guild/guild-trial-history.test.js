/**
 * Reading the archived cycles back.
 *
 * Two claims are load-bearing. A failed week is a result and prints its zeros —
 * "combat T0 · 0 pts" — where a figure that never reached this client prints
 * "—", and the two must never look alike. And a cycle archived off another
 * guild's record is labelled and never has this guild's building bonuses
 * applied to it, because the token figure is derived from the buildings and
 * those are not its buildings.
 */

import { describe, test, expect } from 'vitest';

import { FOREIGN_CYCLE_REASON, describeCycleAge, pastWeekLine, summariseArchivedCycle } from './guild-trial-history.js';
import { trialWeekStart } from './guild-trials-math.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const now = Date.parse('2026-08-04T12:00:00Z');
const lastWeek = trialWeekStart(now) - WEEK_MS;

/**
 * An archived cycle as `archiveCycle` writes one — the shape the store's own
 * tests pin, with a combat and a skilling tile that both stated their points.
 * @param {Object} overrides - Fields to override
 * @returns {Object} The cycle
 */
function cycle(overrides = {}) {
    return {
        archivedAt: lastWeek + 2 * 24 * 60 * 60 * 1000,
        reason: 'a new cycle is scheduled',
        weekStart: lastWeek,
        tiles: {
            'combat::trial chameleon': {
                name: 'Trial Chameleon',
                kind: 'combat',
                tier: 5,
                points: 960,
                pointsByTier: { 5: 960 },
                completed: true,
                samples: [],
                tiers: [],
            },
            'skilling::milking': {
                name: 'Milking',
                kind: 'skilling',
                tier: 6,
                points: 840,
                pointsByTier: { 6: 840 },
                completed: true,
                samples: [],
                tiers: [],
            },
        },
        ...overrides,
    };
}

describe('describeCycleAge', () => {
    test('counts week boundaries, not elapsed days', () => {
        expect(describeCycleAge({ weekStart: trialWeekStart(now) }, now)).toBe('this week');
        expect(describeCycleAge({ weekStart: lastWeek }, now)).toBe('last week');
        expect(describeCycleAge({ weekStart: lastWeek - WEEK_MS }, now)).toBe('2 weeks ago');
    });

    test('falls back to when it was archived, for an entry with no week stamp', () => {
        expect(describeCycleAge({ archivedAt: lastWeek + 1000 }, now)).toBe('last week');
    });

    test('no timestamp at all is null rather than a guess', () => {
        expect(describeCycleAge({}, now)).toBeNull();
        expect(describeCycleAge(null, now)).toBeNull();
    });
});

describe('summariseArchivedCycle', () => {
    test('reads both halves, the stated points and the week off one cycle', () => {
        const summary = summariseArchivedCycle(cycle(), { now });

        expect(summary.when).toBe('last week');
        expect(summary.combatTier).toBe(5);
        expect(summary.skillingTier).toBe(6);
        expect(summary.points).toBe(1800);
        expect(summary.foreign).toBe(false);
    });

    test('tokens are derived only when both bonuses are in hand', () => {
        const bare = summariseArchivedCycle(cycle(), { now });
        expect(bare.tokens).toBeNull();

        const bonused = summariseArchivedCycle(cycle(), { now, buildersHallBonus: 0.2, treasuryBonus: 0.1 });
        // 1,800 stated ÷ 1.2 is 1,500 base; half of it at +10% Treasury is 825
        expect(bonused.tokens).toBeCloseTo(825, 9);
    });

    test('a failed week is zeros, not dashes', () => {
        // The wiped-trial shape from the store's own tests: completed, zero
        // points, and nothing else on the card
        const failed = summariseArchivedCycle(
            cycle({
                tiles: {
                    'combat::trial hedgehog': {
                        name: 'Trial Hedgehog',
                        kind: 'combat',
                        points: 0,
                        completed: true,
                        pointsByTier: {},
                        samples: [],
                        tiers: [],
                    },
                },
            }),
            { now, buildersHallBonus: 0.2, treasuryBonus: 0.1 }
        );

        expect(failed.combatTier).toBe(0);
        expect(failed.points).toBe(0);
        expect(failed.tokens).toBe(0);
        // …and the half that never ran says nothing, rather than zero
        expect(failed.skillingTier).toBeNull();
    });

    test('a tile with quoted points and no badge still names its tier', () => {
        const summary = summariseArchivedCycle(
            cycle({
                tiles: {
                    'skilling::milking': {
                        name: 'Milking',
                        kind: 'skilling',
                        pointsByTier: { 6: 840 },
                        samples: [],
                        tiers: [],
                    },
                },
            }),
            { now }
        );

        expect(summary.skillingTier).toBe(6);
        // The flat points field was never stated, and is not invented
        expect(summary.points).toBeNull();
    });

    test('a foreign cycle is labelled and never gets this guild’s bonuses', () => {
        const summary = summariseArchivedCycle(cycle({ reason: FOREIGN_CYCLE_REASON }), {
            now,
            buildersHallBonus: 0.2,
            treasuryBonus: 0.1,
        });

        expect(summary.foreign).toBe(true);
        expect(summary.points).toBe(1800);
        expect(summary.tokens).toBeNull();
    });

    test('an empty or malformed cycle summarises to nothing rather than throwing', () => {
        const summary = summariseArchivedCycle(null, { now });
        expect(summary).toMatchObject({ when: null, combatTier: null, skillingTier: null, points: null, tokens: null });
        // A numeric reason, as one store test writes, is not a string to print
        expect(summariseArchivedCycle({ reason: 2, tiles: {} }, { now }).reason).toBeNull();
    });
});

describe('pastWeekLine', () => {
    test('one compact line, every slot present', () => {
        const line = pastWeekLine(summariseArchivedCycle(cycle(), { now, buildersHallBonus: 0.2, treasuryBonus: 0.1 }));

        expect(line).toBe('Last week · combat T5 · skilling T6 · 1,800 pts · ~825 tokens each');
    });

    test('what is not known is a dash, never a zero', () => {
        const line = pastWeekLine({ when: null, combatTier: null, skillingTier: null, points: null, tokens: null });
        expect(line).toBe('— · combat — · skilling — · — pts · — tokens each');
        expect(line).not.toContain('0');
    });

    test('a failed week prints its zeros', () => {
        const line = pastWeekLine({ when: 'last week', combatTier: 0, skillingTier: null, points: 0, tokens: 0 });
        expect(line).toBe('Last week · combat T0 · skilling — · 0 pts · ~0 tokens each');
    });

    test('a foreign week says whose it was not', () => {
        const line = pastWeekLine({ when: '2 weeks ago', combatTier: 3, points: 1200, foreign: true });
        expect(line).toContain('another guild’s week');
        expect(line.startsWith('2 weeks ago')).toBe(true);
    });
});
