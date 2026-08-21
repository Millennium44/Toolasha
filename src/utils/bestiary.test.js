import { describe, test, expect } from 'vitest';
import {
    pointsFromCount,
    nextPointCount,
    monsterKillsPerHour,
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
    test('kills per hour come from the simulator’s monster deaths, never the players’', () => {
        const sim = { deaths: { '/monsters/fly': 120, '/monsters/rat': 60, player1: 2 } };
        expect(monsterKillsPerHour(sim, 2)).toEqual({ '/monsters/fly': 60, '/monsters/rat': 30 });
        expect(monsterKillsPerHour(sim, 0)).toEqual({});
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

    test('points over the horizon, and how soon the first one lands', () => {
        // Fly at 12 kills, 60/hr: reaches 100 in ~1.47 h (+3), 1,000 in ~16.5 h (+4)
        // Rat never met, 30/hr: first kill in 2 minutes (+1), 10 in 20 min (+2), 100 in 3.3 h (+3)
        const outlook = zoneBestiaryOutlook({
            killsPerHour: { '/monsters/fly': 60, '/monsters/rat': 30 },
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
        expect(zoneBestiaryOutlook({ killsPerHour: {}, counts: {} })).toMatchObject({
            pointsGained: 0,
            firstPointHours: null,
            monsters: [],
        });
    });
});
