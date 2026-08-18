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

    test('the reconciled endpoint wins over a tick sum that missed the opening hit', () => {
        // A recorder that caught the start knows the true figure: start − end
        // + healed. The 3 Hz tick sum runs a few percent low when hits merge
        // into one frame — here it missed 296 — and the endpoint recovers it.
        const [g] = deriveObserved([
            attempt({
                monsterMaxHp: 14_320,
                monsterHpStart: 14_320,
                monsterHpEnd: 8_943,
                monsterHealed: 0,
                monsterDamage: 5_081,
                playerDamageTaken: 500,
                complete: true,
            }),
        ]);
        expect(g.totalMonsterDamage).toBe(5_377);
        // Player healing is not tracked, so the taken side has no endpoint to
        // reconcile against and stays the tick-summed figure
        expect(g.totalPlayerTaken).toBe(500);
    });

    test('monster healing raises the reconciled endpoint, cleared or not', () => {
        const [lost] = deriveObserved([
            attempt({
                monsterMaxHp: 1_000,
                monsterHpStart: 1_000,
                monsterHpEnd: 400,
                monsterHealed: 150,
                monsterDamage: 700,
                playerDamageTaken: 500,
                complete: true,
            }),
        ]);
        expect(lost.totalMonsterDamage).toBe(750); // 1000 − 400 + 150

        const [won] = deriveObserved([
            attempt({
                outcome: 'clear',
                cleared: true,
                monsterMaxHp: 1_000,
                monsterHpStart: 1_000,
                monsterHpEnd: 120, // killing-blow tick never arrived
                monsterHealed: 150,
                monsterDamage: 900,
                playerDamageTaken: 500,
                complete: true,
            }),
        ]);
        expect(won.totalMonsterDamage).toBe(1_150); // the whole bar plus what it healed back
    });

    test('incomplete new-format attempts are dropped and counted; legacy attempts stay eligible', () => {
        const groups = deriveObserved([
            attempt({ complete: true }),
            attempt(), // legacy recording: no flag, judged under the old rules
            attempt({ complete: false }), // joined mid-fight, not measured whole
            attempt({ outcome: 'unknown' }),
            attempt({ playerMaxHp: 2_000, playerHpStart: 400 }), // wounded start
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0].fights).toBe(2);
        expect(groups.droppedIncomplete).toBe(1);
        expect(groups.droppedUnknownOutcome).toBe(1);
        expect(groups.droppedNotCleanStart).toBe(1);
    });

    test('nearby levels pool into one bucket, re-simmed at the median', () => {
        // Random labyrinth levels rarely repeat exactly, so a 10-wide band pools
        const [g] = deriveObserved([
            attempt({ roomLevel: 245 }),
            attempt({ roomLevel: 250 }),
            attempt({ roomLevel: 254 }),
        ]);
        expect(g.fights).toBe(3);
        expect(g.roomLevel).toBe(250); // median, what the group re-sims at
        expect(g.levelLow).toBe(245);
        expect(g.levelHigh).toBe(254);
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
    test('reads dealt off the player key and taken off the monster key, over in-fight seconds', () => {
        const predicted = predictedFromSim(
            {
                simulatedTime: 100e9,
                labyAttemptCount: 2,
                encounters: 1,
                totalDamageDealt: { player1: 1400, '/monsters/cyclops': 900 },
            },
            { playerHrid: 'player1', monsterHrid: '/monsters/cyclops' }
        );
        // Labyrinth restarts are instant, so all 100 s of wall-clock is fight
        // time — no per-attempt restart idle to subtract. (Subtracting one, as
        // an earlier version did, read the sim's rates a few percent high.)
        expect(predicted.dps).toBeCloseTo(1400 / 100, 5);
        expect(predicted.takenPerSecond).toBeCloseTo(900 / 100, 5);
        expect(predicted.clearRate).toBe(0.5);
        expect(predicted.secondsPerFight).toBe(50);
    });

    test('a sim with no time to divide by is not a prediction', () => {
        expect(predictedFromSim({ simulatedTime: 0 }, { playerHrid: 'player1', monsterHrid: '/m' })).toBeNull();
        expect(predictedFromSim(null, {})).toBeNull();
    });

    test('hit rate and damage-per-hit come off the sim attack tally', () => {
        const predicted = predictedFromSim(
            {
                simulatedTime: 100e9,
                labyAttemptCount: 1,
                encounters: 1,
                totalDamageDealt: { player1: 1500, '/monsters/cyclops': 0 },
                // 15 landing swings (5 crit / 10 normal) and 5 misses across abilities
                attacks: {
                    player1: {
                        '/monsters/cyclops': {
                            '/abilities/auto': { miss: 5, 100: 10 },
                            '/abilities/smash': { 400: 5 },
                        },
                    },
                },
            },
            { playerHrid: 'player1', monsterHrid: '/monsters/cyclops' }
        );
        expect(predicted.hitRate).toBeCloseTo(15 / 20, 5);
        expect(predicted.dmgPerHit).toBeCloseTo(1500 / 15, 5);
    });

    test("the sim run's own counters ride through for the export", () => {
        const predicted = predictedFromSim(
            {
                simulatedTime: 100e9,
                labyAttemptCount: 4,
                encounters: 1,
                labyUnfinishedAttempts: 1,
                labyStoppedOnPrecision: true,
                totalDamageDealt: { player1: 1400, '/monsters/cyclops': 900 },
            },
            { playerHrid: 'player1', monsterHrid: '/monsters/cyclops' }
        );
        expect(predicted.unfinishedAttempts).toBe(1);
        expect(predicted.stoppedOnPrecision).toBe(true);

        const result = compareLab(deriveObserved(losses(6))[0], predicted);
        expect(result.sim).toMatchObject({
            attempts: 4,
            wins: 1,
            unfinishedAttempts: 1,
            stoppedOnPrecision: true,
        });
    });

    test('no attack tally leaves hit rate and damage-per-hit null', () => {
        const predicted = predictedFromSim(
            { simulatedTime: 100e9, labyAttemptCount: 1, encounters: 0, totalDamageDealt: { p: 100 } },
            { playerHrid: 'p', monsterHrid: '/m' }
        );
        expect(predicted.hitRate).toBeNull();
        expect(predicted.dmgPerHit).toBeNull();
    });
});

describe('the damage gap decomposes into accuracy and mitigation', () => {
    // Six fights, each 40 hits / 10 misses (80% hit rate), 200 damage per hit
    const swingLosses = () =>
        Array.from({ length: 6 }, () =>
            attempt({ monsterMaxHp: 100000, monsterHpEnd: 92000, seconds: 50, playerHits: 40, playerMisses: 10 })
        );
    const predictedLike = (overrides = {}) => ({
        dps: 160,
        takenPerSecond: 10,
        clearRate: 0.2,
        secondsPerFight: 50,
        hitRate: 0.8,
        dmgPerHit: 200,
        ...overrides,
    });

    test('observed hit rate and damage-per-hit are derived from the swing counts', () => {
        const [g] = deriveObserved(swingLosses());
        expect(g.hitRate).toBeCloseTo(0.8, 5);
        expect(g.dmgPerHit).toBeCloseTo(200, 5); // 8000 dealt / 40 hits
        expect(g.hitDataFights).toBe(6);
    });

    test('fewer hits than the sim expects reads as an accuracy gap', () => {
        // Sim thinks you hit 95% while you really hit 80% → hit rate falls short
        const result = compareLab(deriveObserved(swingLosses())[0], predictedLike({ dps: 200, hitRate: 0.95 }));
        const hit = result.metrics.find((m) => m.key === 'hitRate');
        expect(hit.verdict).toBe('below');
        expect(result.diagnosis).toMatch(/land fewer hits/i);
        expect(result.diagnosis).toMatch(/evasion/i);
    });

    test('softer hits than the sim expects reads as a mitigation gap', () => {
        // Sim thinks each hit does 260 while yours do 200 → damage-per-hit short
        const result = compareLab(deriveObserved(swingLosses())[0], predictedLike({ dps: 200, dmgPerHit: 260 }));
        const dph = result.metrics.find((m) => m.key === 'dmgPerHit');
        expect(dph.verdict).toBe('below');
        expect(result.diagnosis).toMatch(/each hit lands softer/i);
        expect(result.diagnosis).toMatch(/mitigation|resistance|armour/i);
    });

    test('recordings without swing counts skip the two rows entirely', () => {
        const [g] = deriveObserved(losses(6)); // no playerHits/playerMisses
        expect(g.hitRate).toBeNull();
        const result = compareLab(g, predictedLike());
        expect(result.metrics.find((m) => m.key === 'hitRate')).toBeUndefined();
        expect(result.metrics.find((m) => m.key === 'dmgPerHit')).toBeUndefined();
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

    test('a hand-built prediction without run counters leaves the sim block null, not undefined', () => {
        const result = compareLab(observed(), predictedLike());
        expect(result.sim.unfinishedAttempts).toBeNull();
        expect(result.sim.stoppedOnPrecision).toBeNull();
    });

    test('too few fights is called insufficient, not consistent', () => {
        const thin = deriveObserved(losses(2))[0];
        const result = compareLab(thin, predictedLike());
        const dps = result.metrics.find((m) => m.key === 'dps');
        expect(dps.verdict).toBe('insufficient');
    });

    test('the taken metric tolerates the tick-summed undercount before crying "below"', () => {
        // Observed taken is 10/s; the sim predicts 10.4/s — a ~3.8% shortfall that
        // is within the damage-taken figure's known low bias, so it must read as
        // consistent rather than "sim over-models the monster". (Your own damage,
        // which carries no such bias, would flag the same gap.)
        const result = compareLab(observed(), predictedLike({ takenPerSecond: 10.4 }));
        const taken = result.metrics.find((m) => m.key === 'taken');
        expect(taken.verdict).toBe('consistent');
        // The shown deviation is still the honest raw figure, not bias-adjusted.
        expect(taken.deviationPct).toBeCloseTo(-3.846, 2);
    });
});
