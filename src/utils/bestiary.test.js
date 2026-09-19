import { describe, test, expect } from 'vitest';
import {
    pointsFromCount,
    nextPointCount,
    creditsPerKill,
    resolvePartySize,
    monsterCreditsPerHour,
    countsByMonster,
    zoneBestiaryOutlook,
} from './bestiary.js';

describe('the game’s point formula', () => {
    test('one point for the first kill, then +2 at ten, +3 at a hundred, +4 at a thousand', () => {
        expect(pointsFromCount(0)).toBe(0);
        expect(pointsFromCount(1)).toBe(1);
        expect(pointsFromCount(9)).toBe(1);
        expect(pointsFromCount(10)).toBe(3);
        expect(pointsFromCount(99)).toBe(3);
        expect(pointsFromCount(100)).toBe(6);
        expect(pointsFromCount(1000)).toBe(10);
        expect(pointsFromCount(10000)).toBe(15);
        // Fractions are floored; the tooltip's "Points Earned: 1" at one kill
        expect(pointsFromCount(1.7)).toBe(1);
    });

    test('the next point sits at the next power of ten', () => {
        expect(nextPointCount(0)).toBe(1);
        expect(nextPointCount(1)).toBe(10);
        expect(nextPointCount(9)).toBe(10);
        expect(nextPointCount(10)).toBe(100);
        expect(nextPointCount(150)).toBe(1000);
    });
});

describe('a zone’s outlook', () => {
    test('credits per hour come from the simulator’s monster deaths, never the players’', () => {
        const sim = { deaths: { '/monsters/fly': 120, '/monsters/rat': 60, player1: 2 } };
        expect(monsterCreditsPerHour(sim, 2)).toEqual({ '/monsters/fly': 60, '/monsters/rat': 30 });
        expect(monsterCreditsPerHour(sim, 0)).toEqual({});
    });

    test('counts read off the monsters_updated list', () => {
        expect(
            countsByMonster([
                { monsterHrid: '/monsters/fly', count: 12 },
                { monsterHrid: '', count: 3 },
            ])
        ).toEqual({
            '/monsters/fly': 12,
        });
    });

    test('a fractional credit total survives — it is not a kill count to floor', () => {
        // The live Manticore tooltip: Defeated: 496.8 | T0 Defeated: 45 | T2 Defeated: 150.6
        expect(countsByMonster([{ monsterHrid: '/monsters/manticore', count: 496.8 }])).toEqual({
            '/monsters/manticore': 496.8,
        });
    });

    test('a negative or non-finite count still clamps to 0', () => {
        expect(
            countsByMonster([
                { monsterHrid: '/monsters/fly', count: -5 },
                { monsterHrid: '/monsters/rat', count: NaN },
                { monsterHrid: '/monsters/wolf', count: Infinity },
                { monsterHrid: '/monsters/bat' /* count missing */ },
            ])
        ).toEqual({
            '/monsters/fly': 0,
            '/monsters/rat': 0,
            '/monsters/wolf': 0,
            '/monsters/bat': 0,
        });
    });

    test('points over the horizon, and how soon the first one lands', () => {
        // Fly at 12 kills, 60/hr: reaches 100 in ~1.47 h (+3), 1,000 in ~16.5 h (+4)
        // Rat never met, 30/hr: first kill in 2 minutes (+1), 10 in 20 min (+2), 100 in 3.3 h (+3)
        const outlook = zoneBestiaryOutlook({
            creditsPerHour: { '/monsters/fly': 60, '/monsters/rat': 30 },
            counts: { '/monsters/fly': 12 },
            hours: 24,
        });
        expect(outlook.pointsGained).toBe(3 + 4 + 1 + 2 + 3);
        expect(outlook.pointsPerDay).toBe(outlook.pointsGained);
        expect(outlook.firstPointHours).toBeCloseTo(1 / 30, 6);
        expect(outlook.monsters[0].monsterHrid).toBe('/monsters/rat');
        expect(outlook.monsters[1]).toMatchObject({ monsterHrid: '/monsters/fly', count: 12, nextAt: 100 });
        expect(outlook.monsters[1].hoursToNext).toBeCloseTo(88 / 60, 6);
    });

    test('a zone that kills nothing is worth nothing', () => {
        expect(zoneBestiaryOutlook({ creditsPerHour: {}, counts: {} })).toMatchObject({
            pointsGained: 0,
            firstPointHours: null,
            monsters: [],
        });
    });

    test('the fractional part of a credit count survives into the outlook', () => {
        // The live panel renders from here, so a floor in this function would
        // silently undo `countsByMonster` keeping the fraction — the reading
        // would be right at the source and wrong on screen.
        const outlook = zoneBestiaryOutlook({
            creditsPerHour: { '/monsters/fly': 1 },
            counts: { '/monsters/fly': 496.8 },
            hours: 1,
        });
        expect(outlook.monsters[0].count).toBe(496.8);
        // 503.2 credits short of 1000, not the 504 a floored 496 would claim
        expect(outlook.monsters[0].hoursToNext).toBeCloseTo(503.2, 6);
    });

    test('a count that is negative or not a number still clamps to zero', () => {
        const outlook = zoneBestiaryOutlook({
            creditsPerHour: { '/monsters/fly': 1, '/monsters/rat': 1 },
            counts: { '/monsters/fly': -5, '/monsters/rat': Number.NaN },
            hours: 1,
        });
        expect(outlook.monsters.every((m) => m.count === 0)).toBe(true);
    });

    /**
     * A guild trial monster is not tier-weighted at all — see `creditsPerKill`'s
     * doc for the measured proof, with the real Trial Hedgehog figures this test
     * reuses: `tierData` up to wave 21 summing to a plain 152, where this
     * module's `tier + 1` rule would claim 1,776 — about 12x too high.
     *
     * Neither `creditsPerKill` nor `zoneBestiaryOutlook` knows a monster is a
     * trial monster, so there is nothing to assert about how either function
     * *would* treat one directly — asserting that would just re-describe the
     * bug fact 2 warns about. What is real and testable is the actual guard:
     * `monsters_updated` lists every monster, trials included, but a trial
     * monster's kills never appear in `creditsPerHour` because no all-zones row
     * simulates a trial fight (see the module doc's `_buildBestiaryPlanZones`
     * note). `zoneBestiaryOutlook` only ever visits `creditsPerHour`'s keys, so
     * a trial monster sitting in `counts` — however large its true count is —
     * must be silently skipped, not weighted. A future change that switched
     * the loop to iterate `counts` instead, to "not miss" an unmet monster,
     * would revive exactly the 12x bug and fail this test loudly.
     */
    test('a trial monster’s Bestiary count is ignored, not tier-weighted, when it has no simulated rate', () => {
        const outlook = zoneBestiaryOutlook({
            creditsPerHour: { '/monsters/fly': 60 },
            counts: {
                '/monsters/fly': 12,
                // The real Trial Hedgehog reading: tierData {"1":10,"2":9,"3":7,
                // ...,"21":7} sums to 152 kills, no tier weighting — its "tiers"
                // are trial wave numbers, not difficulty tiers.
                '/monsters/trial_hedgehog': 152,
            },
            hours: 1,
        });

        expect(outlook.monsters).toHaveLength(1);
        expect(outlook.monsters[0].monsterHrid).toBe('/monsters/fly');
        expect(outlook.monsters.some((m) => m.monsterHrid === '/monsters/trial_hedgehog')).toBe(false);
    });
});

describe('a kill is not a credit', () => {
    test('a kill at tier N credits N+1, the way the game’s help says', () => {
        expect(creditsPerKill({ difficultyTier: 0 })).toBe(1);
        expect(creditsPerKill({ difficultyTier: 1 })).toBe(2);
        expect(creditsPerKill({ difficultyTier: 2 })).toBe(3);
        expect(creditsPerKill()).toBe(1);
    });

    test('the live Manticore tooltip reconciles exactly', () => {
        // Defeated: 496.8 | T0 Defeated: 45 | T2 Defeated: 150.6
        const total = 45 * creditsPerKill({ difficultyTier: 0 }) + 150.6 * creditsPerKill({ difficultyTier: 2 });
        expect(total).toBeCloseTo(496.8, 6);
        // ...and 496.8 has passed 1, 10 and 100, so the tooltip's "Points Earned: 6"
        expect(pointsFromCount(total)).toBe(6);
    });

    test('a party splits each kill, because the sim’s deaths are the party’s', () => {
        expect(creditsPerKill({ difficultyTier: 0, partySize: 3 })).toBeCloseTo(1 / 3, 12);
        expect(creditsPerKill({ difficultyTier: 2, partySize: 3 })).toBe(1);
        // A party of one divides by nothing
        expect(creditsPerKill({ difficultyTier: 2, partySize: 1 })).toBe(3);
        // Nonsense never multiplies the credit up
        expect(creditsPerKill({ difficultyTier: -4, partySize: 0 })).toBe(1);
    });

    test('a T0 solo run’s credit rate is its kill rate, unchanged', () => {
        const sim = { deaths: { '/monsters/fly': 120 }, numberOfPlayers: 1, difficultyTier: 0 };
        expect(monsterCreditsPerHour(sim, 2, { difficultyTier: 0, partySize: 1 })).toEqual({ '/monsters/fly': 60 });
    });

    test('a T2 solo run is worth three times its kill rate', () => {
        const sim = { deaths: { '/monsters/fly': 120 } };
        expect(monsterCreditsPerHour(sim, 2, { difficultyTier: 2, partySize: 1 })).toEqual({ '/monsters/fly': 180 });
    });

    test('a party of three at T2 nets the same as a solo T0 run at the same body count', () => {
        const sim = { deaths: { '/monsters/fly': 120 } };
        expect(monsterCreditsPerHour(sim, 2, { difficultyTier: 2, partySize: 3 })).toEqual({ '/monsters/fly': 60 });
    });

    test('the run’s own party size beats the configured fallback; the fallback only answers for a run without one', () => {
        expect(resolvePartySize(3, 5)).toBe(3);
        expect(resolvePartySize(1, 5)).toBe(1);
        expect(resolvePartySize(null, 4)).toBe(4);
        expect(resolvePartySize(undefined, 4)).toBe(4);
        expect(resolvePartySize(null, null)).toBe(1);
        expect(resolvePartySize(0, 0)).toBe(1);
    });
});
