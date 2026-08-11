/**
 * The replay turns recorded endpoints into two rates — your damage and the
 * monster's — and calls each against the sim's with a noise-aware verdict. These
 * pin the arithmetic (a fresh monster starts full; a cleared one fell all the
 * way) and the verdicts that drive the diagnosis.
 */

import { describe, test, expect } from 'vitest';
import { deriveObserved, predictedFromSim, compareLab, deviationPct, relMarginPct } from './labyrinth-replay-check.js';

function attempt(overrides = {}) {
    return {
        monsterHrid: '/monsters/cyclops',
        roomLevel: 200,
        seconds: 50,
        outcome: 'death',
        cleared: false,
        monsterMaxHp: 1000,
        monsterHpEnd: 600,
        playerMaxHp: 500,
        playerHpStart: 500,
        playerHpEnd: 0,
        ...overrides,
    };
}

/** N identical losses: dps sample 8/s, taken 10/s, no variance */
function losses(n) {
    return Array.from({ length: n }, () => attempt());
}

describe('deriveObserved', () => {
    test('a cleared room counts the whole monster; a loss counts what fell', () => {
        const [group] = deriveObserved([
            attempt({ outcome: 'clear', cleared: true, monsterHpEnd: 0, seconds: 50, playerHpEnd: 100 }),
            attempt({ outcome: 'death', cleared: false, monsterHpEnd: 600, seconds: 50, playerHpEnd: 0 }),
        ]);
        // clear: 1000 destroyed + loss: 400 destroyed = 1400 over 100s
        expect(group.dps).toBeCloseTo(14, 5);
        // clear: 400 taken + loss: 500 taken = 900 over 100s
        expect(group.takenPerSecond).toBeCloseTo(9, 5);
        expect(group.clearRate).toBe(0.5);
        expect(group.fights).toBe(2);
    });

    test('rooms are grouped by monster and level, most-fought first', () => {
        const groups = deriveObserved([
            attempt({ monsterHrid: '/monsters/cyclops', roomLevel: 200 }),
            attempt({ monsterHrid: '/monsters/cyclops', roomLevel: 200 }),
            attempt({ monsterHrid: '/monsters/giant_shoebill', roomLevel: 180 }),
        ]);
        expect(groups).toHaveLength(2);
        expect(groups[0].monsterHrid).toBe('/monsters/cyclops');
        expect(groups[0].fights).toBe(2);
    });

    test('gross damage figures win over the endpoints, so regen is not subtracted', () => {
        // Endpoints say you took 2000 and dealt 600; gross says 2500 and 700
        // (you regenerated 500 through the fight, and the monster healed 100)
        const [g] = deriveObserved([
            attempt({
                outcome: 'death',
                cleared: false,
                monsterMaxHp: 1000,
                monsterHpEnd: 400,
                playerMaxHp: 2000,
                playerHpStart: 2000,
                playerHpEnd: 0,
                monsterDamage: 700,
                playerDamageTaken: 2500,
            }),
        ]);
        expect(g.totalPlayerTaken).toBe(2500);
        expect(g.totalMonsterDamage).toBe(700);
    });

    test('an unknown outcome and a zero-length fight are excluded', () => {
        const groups = deriveObserved([attempt({ outcome: 'unknown' }), attempt({ seconds: 0 })]);
        expect(groups).toHaveLength(0);
    });

    test('a fight the recorder joined below full health is excluded', () => {
        const groups = deriveObserved([
            attempt({ playerMaxHp: 2000, playerHpStart: 2000 }), // clean full start
            attempt({ playerMaxHp: 2000, playerHpStart: 400 }), // joined mid-fight, dropped
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].fights).toBe(1);
    });
});

describe('predictedFromSim', () => {
    test('reads dealt off the player key and taken off the monster key', () => {
        const predicted = predictedFromSim(
            {
                simulatedTime: 100e9,
                labyAttemptCount: 2,
                encounters: 1,
                totalDamageDealt: { player1: 1400, '/monsters/cyclops': 900 },
            },
            { playerHrid: 'player1', monsterHrid: '/monsters/cyclops' }
        );
        expect(predicted.dps).toBeCloseTo(14, 5);
        expect(predicted.takenPerSecond).toBeCloseTo(9, 5);
        expect(predicted.clearRate).toBe(0.5);
        expect(predicted.secondsPerFight).toBe(50);
    });

    test('a sim with no time to divide by is not a prediction', () => {
        expect(predictedFromSim({ simulatedTime: 0 }, { playerHrid: 'player1', monsterHrid: '/m' })).toBeNull();
        expect(predictedFromSim(null, {})).toBeNull();
    });
});

describe('deviationPct / relMarginPct', () => {
    test('deviation is signed against the prediction', () => {
        expect(deviationPct(8, 10)).toBeCloseTo(-20, 5);
        expect(deviationPct(12, 10)).toBeCloseTo(20, 5);
        expect(deviationPct(5, 0)).toBeNull();
    });

    test('a margin needs at least two points and a positive mean', () => {
        expect(relMarginPct([])).toBeNull();
        expect(relMarginPct([5])).toBeNull();
        expect(relMarginPct([5, 5, 5])).toBe(0);
        expect(relMarginPct([4, 6, 5, 5])).toBeGreaterThan(0);
    });
});

describe('compareLab verdicts and diagnosis', () => {
    const observed = () => deriveObserved(losses(6))[0]; // dps 8/s, taken 10/s, 6 fights

    function predictedLike(overrides = {}) {
        return { dps: 8, takenPerSecond: 10, clearRate: 0.2, secondsPerFight: 50, ...overrides };
    }

    test('matching rates read as consistent', () => {
        const result = compareLab(observed(), predictedLike());
        const dps = result.metrics.find((m) => m.key === 'dps');
        expect(dps.verdict).toBe('consistent');
    });

    test('a sim that over-credits your damage is caught, and named', () => {
        // Sim predicts you deal 10/s; you really deal 8/s → your rate falls short
        const result = compareLab(observed(), predictedLike({ dps: 10 }));
        const dps = result.metrics.find((m) => m.key === 'dps');
        expect(dps.verdict).toBe('below');
        expect(result.diagnosis).toMatch(/over-credits your damage/i);
    });

    test('a sim that under-models the monster is caught, and named', () => {
        // Sim predicts the monster deals 8/s; it really deals 10/s → its rate runs over
        const result = compareLab(observed(), predictedLike({ takenPerSecond: 8 }));
        const taken = result.metrics.find((m) => m.key === 'taken');
        expect(taken.verdict).toBe('above');
        expect(result.diagnosis).toMatch(/under-models the monster/i);
    });

    test('a sim that over-models the monster is caught, and named', () => {
        // Sim predicts the monster deals 14/s; it really deals 10/s → its rate
        // comes in under, and the sim over-modelled it. This is the case that
        // used to fall through to "within noise".
        const result = compareLab(observed(), predictedLike({ takenPerSecond: 14 }));
        const taken = result.metrics.find((m) => m.key === 'taken');
        expect(taken.verdict).toBe('below');
        expect(result.diagnosis).toMatch(/over-models the monster/i);
        expect(result.diagnosis).not.toMatch(/within noise/i);
    });

    test('too few fights is called insufficient, not consistent', () => {
        const thin = deriveObserved(losses(2))[0];
        const result = compareLab(thin, predictedLike());
        const dps = result.metrics.find((m) => m.key === 'dps');
        expect(dps.verdict).toBe('insufficient');
    });
});
