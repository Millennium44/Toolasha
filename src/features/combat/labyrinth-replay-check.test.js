/**
 * The replay turns recorded endpoints into two rates — your damage and the
 * monster's — and calls each against the sim's with a noise-aware verdict. These
 * pin the arithmetic (a fresh monster starts full; a cleared one fell all the
 * way) and the verdicts that drive the diagnosis.
 */

import { describe, test, expect } from 'vitest';
import {
    deriveObserved,
    predictedFromSim,
    compareLab,
    deviationPct,
    relMarginPct,
    binomialMarginPct,
    summarizePool,
} from './labyrinth-replay-check.js';

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

    describe('the crit tiebreaker on a soft-hit gap', () => {
        // Same six fights, with 10 of each fight's 40 hits critting (25%)
        const critLosses = () =>
            Array.from({ length: 6 }, () =>
                attempt({
                    monsterMaxHp: 100000,
                    monsterHpEnd: 92000,
                    seconds: 50,
                    playerHits: 40,
                    playerMisses: 10,
                    playerCrits: 10,
                })
            );

        test('the observed crit rate is derived from the recorded crits', () => {
            const [g] = deriveObserved(critLosses());
            expect(g.critRate).toBeCloseTo(0.25, 5);
            expect(g.critDataFights).toBe(6);
        });

        test('the sim side reads its crit counter over its landed hits', () => {
            const predicted = predictedFromSim(
                {
                    simulatedTime: 100e9,
                    labyAttemptCount: 1,
                    encounters: 1,
                    totalDamageDealt: { player1: 1500, '/monsters/cyclops': 0 },
                    attacks: { player1: { '/monsters/cyclops': { '/abilities/auto': { miss: 5, 100: 15 } } } },
                    crits: { player1: 6 },
                },
                { playerHrid: 'player1', monsterHrid: '/monsters/cyclops' }
            );
            expect(predicted.critRate).toBeCloseTo(6 / 15, 5);
        });

        test('a result from an engine without the counter skips the row, not zeroes it', () => {
            const predicted = predictedFromSim(
                {
                    simulatedTime: 100e9,
                    labyAttemptCount: 1,
                    encounters: 1,
                    totalDamageDealt: { player1: 1500, '/monsters/cyclops': 0 },
                    attacks: { player1: { '/monsters/cyclops': { '/abilities/auto': { 100: 15 } } } },
                },
                { playerHrid: 'player1', monsterHrid: '/monsters/cyclops' }
            );
            expect(predicted.critRate).toBeNull();
            const result = compareLab(deriveObserved(critLosses())[0], predictedLike());
            expect(result.metrics.find((m) => m.key === 'critRate')).toBeUndefined();
        });

        test('soft hits with fewer crits than predicted blames the crit roll, not the monster', () => {
            const result = compareLab(
                deriveObserved(critLosses())[0],
                predictedLike({ dps: 200, dmgPerHit: 260, critRate: 0.5 })
            );
            const crit = result.metrics.find((m) => m.key === 'critRate');
            expect(crit.verdict).toBe('below');
            expect(result.diagnosis).toMatch(/over-credits\s+your crits/i);
        });

        test('soft hits with a matching crit rate rules the crit roll out by name', () => {
            const result = compareLab(
                deriveObserved(critLosses())[0],
                predictedLike({ dps: 200, dmgPerHit: 260, critRate: 0.25 })
            );
            expect(result.diagnosis).toMatch(/mitigation/i);
            expect(result.diagnosis).toMatch(/rules the crit roll out/i);
        });

        test('fights recorded before crits were kept contribute no crit data', () => {
            const [g] = deriveObserved(swingLosses()); // hits, no playerCrits
            expect(g.critRate).toBeNull();
            expect(g.critDataFights).toBe(0);
        });

        test('a stored null is not a zero — the Number(null) trap', () => {
            // The recorder stores playerCrits: null on legacy fights, and
            // Number(null) is 0 — pooled in, three unmeasured fights would
            // halve a real 25% rate
            const mixed = [
                ...critLosses().slice(0, 3),
                ...Array.from({ length: 3 }, () =>
                    attempt({
                        monsterMaxHp: 100000,
                        monsterHpEnd: 92000,
                        seconds: 50,
                        playerHits: 40,
                        playerMisses: 10,
                        playerCrits: null,
                    })
                ),
            ];
            const [g] = deriveObserved(mixed);
            expect(g.hitDataFights).toBe(6);
            expect(g.critDataFights).toBe(3);
            expect(g.critRate).toBeCloseTo(0.25, 5);
        });

        test('more crits than hits is a decoder glitch, dropped from the crit pool only', () => {
            const glitch = [
                ...critLosses().slice(0, 2),
                attempt({
                    monsterMaxHp: 100000,
                    monsterHpEnd: 92000,
                    seconds: 50,
                    playerHits: 10,
                    playerMisses: 0,
                    playerCrits: 99,
                }),
            ];
            const [g] = deriveObserved(glitch);
            expect(g.critDataFights).toBe(2);
            expect(g.hitDataFights).toBe(3); // still counts for hit data
        });

        test('an engine with the counter and a run that never crit reads as a real 0%', () => {
            const predicted = predictedFromSim(
                {
                    simulatedTime: 100e9,
                    labyAttemptCount: 1,
                    encounters: 1,
                    totalDamageDealt: { player1: 1500, '/monsters/cyclops': 0 },
                    attacks: { player1: { '/monsters/cyclops': { '/abilities/auto': { 100: 15 } } } },
                    crits: {}, // the counter exists; this player never critted
                },
                { playerHrid: 'player1', monsterHrid: '/monsters/cyclops' }
            );
            expect(predicted.critRate).toBe(0);
        });

        test('the crit band is binomial over the pooled hits, and tightens with them', () => {
            expect(binomialMarginPct(0.25, 0)).toBeNull();
            expect(binomialMarginPct(0, 100)).toBeNull();
            const wide = binomialMarginPct(0.25, 40);
            const tight = binomialMarginPct(0.25, 4000);
            expect(wide).toBeGreaterThan(tight);
            expect(tight).toBeGreaterThanOrEqual(2); // never under the sim noise floor
        });
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

describe('summarizePool', () => {
    test('nothing is filtered but malformed rows — the pool shows what it holds', () => {
        const [g] = summarizePool([
            attempt({ outcome: 'clear', cleared: true, monsterHpEnd: 0 }),
            attempt({ complete: false }), // deriveObserved would drop this
            attempt({ playerHpStart: 100 }), // and this (wounded start)
            attempt({ monsterHrid: null }), // malformed: the only drop
        ]);
        expect(g.fights).toBe(3);
        expect(g.clears).toBe(1);
        expect(g.winRate).toBeCloseTo(1 / 3, 5);
    });

    test('the outcome split, the complete fraction and the gear count are stated', () => {
        const [g] = summarizePool([
            attempt({ outcome: 'clear', cleared: true, monsterHpEnd: 0, complete: true, fingerprint: 'a' }),
            attempt({ outcome: 'death', complete: true, fingerprint: 'a' }),
            attempt({ outcome: 'timeout', complete: false, fingerprint: 'b' }),
        ]);
        expect(g.outcomes).toEqual({ clear: 1, death: 1, timeout: 1 });
        expect(g.completeFraction).toBeCloseTo(2 / 3, 5);
        expect(g.gearCount).toBe(2);
    });

    test('the residual mean is over measured fights only, and stays signed', () => {
        const [g] = summarizePool([
            attempt({ unattributedDealt: 30 }),
            attempt({ unattributedDealt: -10 }),
            attempt({ unattributedDealt: null }), // unmeasured, not a zero
        ]);
        expect(g.residualFights).toBe(2);
        expect(g.residualMean).toBeCloseTo(10, 5);
    });

    test('crit pooling follows the comparison rules — raw nulls stay out', () => {
        const [g] = summarizePool([
            attempt({ playerHits: 20, playerMisses: 0, playerCrits: 5 }),
            attempt({ playerHits: 20, playerMisses: 0, playerCrits: null }),
        ]);
        expect(g.critDataFights).toBe(1);
        expect(g.critRate).toBeCloseTo(0.25, 5);
    });

    test('groups sort most-fought first and carry their level span', () => {
        const groups = summarizePool([
            attempt({ monsterHrid: '/monsters/dryad', roomLevel: 341 }),
            attempt({ roomLevel: 196 }),
            attempt({ roomLevel: 204 }),
        ]);
        expect(groups[0].monsterHrid).toBe('/monsters/cyclops');
        expect(groups[0].levelLow).toBe(196);
        expect(groups[0].levelHigh).toBe(204);
        expect(groups[1].fights).toBe(1);
    });
});
