import { describe, test, expect } from 'vitest';
import { computeZoneBottleneck, fightsPerHour } from './task-zone-bottleneck.js';

/** The inline algorithm task-profit-display.js carried before it was extracted, verbatim in behavior. */
function legacyZoneSummary(perMonsterMap, simResult) {
    let bottleneck = null;
    for (const [mHrid, entry] of perMonsterMap) {
        const mKillsPerHour = (simResult.deaths?.[mHrid] ?? 0) / 1;
        entry.hoursNeeded = mKillsPerHour > 0 ? entry.remaining / mKillsPerHour : Infinity;
        if (!bottleneck || entry.hoursNeeded > bottleneck.hoursNeeded) bottleneck = entry;
    }
    const totalFightsPerHour =
        (simResult.encounters ?? 0) > 0
            ? simResult.encounters / 1
            : Object.values(simResult.deaths).reduce((s, v) => s + v, 0);
    return {
        name: bottleneck.name,
        taskCount: bottleneck.taskCount,
        hoursNeeded: bottleneck.hoursNeeded,
        fightsNeeded: Math.round(totalFightsPerHour * bottleneck.hoursNeeded),
    };
}

const entry = (hrid, name, remaining, taskCount = 1) => ({ hrid, name, remaining, taskCount });

describe('computeZoneBottleneck', () => {
    test('returns null with no monsters', () => {
        expect(computeZoneBottleneck([], { deaths: {} })).toBe(null);
    });

    test('picks the monster that takes longest, by hrid', () => {
        const result = computeZoneBottleneck(
            [entry('/monsters/slime', 'Slime', 10), entry('/monsters/ooze', 'Ooze', 300)],
            { deaths: { '/monsters/slime': 100, '/monsters/ooze': 100 }, encounters: 80 }
        );
        expect(result.bottleneckHrid).toBe('/monsters/ooze');
        expect(result.hoursNeeded).toBe(3);
        expect(result.fightsNeeded).toBe(240);
    });

    test('counts encounters as fights, falling back to deaths for older sim results', () => {
        expect(fightsPerHour({ encounters: 40, deaths: { a: 100 } })).toBe(40);
        expect(fightsPerHour({ deaths: { a: 100, b: 20 } })).toBe(120);
        expect(fightsPerHour({ encounters: 0, deaths: { a: 7 } })).toBe(7);
    });

    test('a monster never killed is the bottleneck with Infinity hours and fights', () => {
        const result = computeZoneBottleneck(
            [entry('/monsters/slime', 'Slime', 10), entry('/monsters/dragon', 'Dragon', 5)],
            { deaths: { '/monsters/slime': 100 }, encounters: 50 }
        );
        expect(result.bottleneckHrid).toBe('/monsters/dragon');
        expect(result.hoursNeeded).toBe(Infinity);
        expect(result.fightsNeeded).toBe(Infinity);
    });

    test('a tie keeps the first monster, as the inline version did', () => {
        const result = computeZoneBottleneck([entry('/monsters/a', 'A', 100), entry('/monsters/b', 'B', 100)], {
            deaths: { '/monsters/a': 100, '/monsters/b': 100 },
        });
        expect(result.bottleneckHrid).toBe('/monsters/a');
    });

    test('carries the bottleneck monster task count', () => {
        const result = computeZoneBottleneck([entry('/monsters/a', 'A', 600, 3)], { deaths: { '/monsters/a': 100 } });
        expect(result.bottleneckTaskCount).toBe(3);
    });

    test.each([
        [
            [entry('/m/a', 'A', 50), entry('/m/b', 'B', 600, 2)],
            { deaths: { '/m/a': 100, '/m/b': 100 }, encounters: 40 },
        ],
        [[entry('/m/a', 'A', 1000), entry('/m/b', 'B', 5)], { deaths: { '/m/a': 97, '/m/b': 3 } }],
        [[entry('/m/a', 'A', 33, 4), entry('/m/b', 'B', 33)], { deaths: { '/m/a': 7, '/m/b': 7 }, encounters: 11 }],
        [[entry('/m/a', 'A', 0), entry('/m/b', 'B', 0)], { deaths: { '/m/a': 5, '/m/b': 5 }, encounters: 3 }],
    ])('matches the pre-extraction inline math (%#)', (entries, simResult) => {
        const legacy = legacyZoneSummary(new Map(entries.map((e) => [e.hrid, { ...e }])), simResult);
        const result = computeZoneBottleneck(entries, simResult);
        expect(result.bottleneckName).toBe(legacy.name);
        expect(result.bottleneckTaskCount).toBe(legacy.taskCount);
        expect(result.hoursNeeded).toBe(legacy.hoursNeeded);
        expect(result.fightsNeeded).toBe(legacy.fightsNeeded);
    });
});
