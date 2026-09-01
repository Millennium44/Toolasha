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
    poolHygiene,
    nearMissRemainder,
    simDamageTally,
} from './labyrinth-replay-check.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

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
        fingerprintVersion: FINGERPRINT_VERSION,
        ...overrides,
    };
}

/** The same fight as the recorder stored it before fingerprints had versions */
function legacyFingerprintAttempt(overrides = {}) {
    const stored = attempt(overrides);
    delete stored.fingerprintVersion;
    return stored;
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
        // 10 × 100 + 5 × 400 over the 15 that landed
        expect(predicted.dmgPerHit).toBeCloseTo(3000 / 15, 5);
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

        // The Pyre Hunter case (room levels 226-239, Aug 2026): damage per hit
        // came in 6.26% under prediction while the crit rate came in 11.97%
        // under with a 15.2% binomial band — "consistent" only because the band
        // is wider than the gap. The diagnosis used to read that as a positive
        // result and print "your crit rate matches, which rules the crit roll
        // out", which is a claim the sample cannot support.
        test('a crit rate that only just fits its band does not rule the crit roll out', () => {
            // 15 fights x 40 hits = 600 hits at 22.5%, against a predicted
            // 25.56% — a 12% shortfall inside a ~15% band
            const wideBandLosses = Array.from({ length: 15 }, () =>
                attempt({
                    monsterMaxHp: 100000,
                    monsterHpEnd: 92000,
                    seconds: 50,
                    playerHits: 40,
                    playerMisses: 10,
                    playerCrits: 9,
                })
            );
            const result = compareLab(
                deriveObserved(wideBandLosses)[0],
                predictedLike({ dps: 200, dmgPerHit: 260, critRate: 0.2556 })
            );
            const crit = result.metrics.find((m) => m.key === 'critRate');
            expect(crit.verdict).toBe('consistent');
            expect(Math.abs(crit.deviationPct)).toBeGreaterThan(crit.marginPct / 2);
            expect(result.diagnosis).not.toMatch(/rules the crit roll out/i);
            expect(result.diagnosis).toMatch(/not ruled out/i);
        });

        test('a soft-hit gap names the mitigation and where to settle it, not the mix', () => {
            const result = compareLab(
                deriveObserved(critLosses())[0],
                predictedLike({ dps: 200, dmgPerHit: 260, critRate: 0.25 })
            );
            expect(result.diagnosis).toMatch(/monster stat check/i);
            expect(result.diagnosis).toMatch(/mitigation/i);
            // The mix was one of this row's two candidate mechanisms only while
            // both sides counted DoT ticks as landed hits. They no longer do.
            expect(result.diagnosis).not.toMatch(/damage-over-time/i);
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

describe('the fingerprint version boundary', () => {
    test('a pre-migration fight is dropped from a rate rather than pooled into it', () => {
        // Both fights are the same monster at the same level, so a
        // version-blind pool would fold them into one group and one dps
        const groups = deriveObserved([attempt(), legacyFingerprintAttempt()]);
        expect(groups).toHaveLength(1);
        expect(groups[0].fights).toBe(1);
        expect(groups.droppedLegacyFingerprint).toBe(1);
    });

    test('the level-up case: the same gear, a different character, two pools', () => {
        // Eight fights before a combat level-up and eight after. Under the
        // gear-only fingerprint these shared one value and were compared
        // against one sim of the levelled character — which is what made the
        // replay report "the sim over-credits your damage" for a level-up.
        const before = Array.from({ length: 8 }, () =>
            legacyFingerprintAttempt({ seconds: 100, monsterHpEnd: 600, fingerprint: 'gearA' })
        );
        const after = Array.from({ length: 8 }, () =>
            attempt({ seconds: 50, monsterHpEnd: 600, fingerprint: 'v2:gearA' })
        );

        const groups = deriveObserved([...before, ...after]);
        expect(groups).toHaveLength(1);
        expect(groups[0].fights).toBe(8);
        // The rate is the levelled character's alone: 400 damage over 50s
        expect(groups[0].dps).toBeCloseTo(8, 5);
        expect(groups.droppedLegacyFingerprint).toBe(8);
    });

    test('a pre-migration fight is still in the pool the browse view shows', () => {
        // Dropped from a reading, never from the record
        const [group] = summarizePool([attempt(), legacyFingerprintAttempt()]);
        expect(group.fights).toBe(2);
        expect(group.legacyFingerprintFights).toBe(1);
        expect(group.attempts).toHaveLength(2);
    });

    test('a pool with nothing pre-migration says so with a zero, not a null', () => {
        const [group] = summarizePool([attempt(), attempt()]);
        expect(group.legacyFingerprintFights).toBe(0);
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

/**
 * The hit MIX — damage-over-time ticks per landed swing — is the measurement
 * that decides a soft-hit gap. A DoT tick lands for a fraction of the blow that
 * applied it, so a sim that ticks more or less often than you moves damage per
 * hit with the monster's armour untouched.
 */
describe('simDamageTally', () => {
    const tallySim = () => ({
        simulatedTime: 100e9,
        labyAttemptCount: 1,
        encounters: 1,
        totalDamageDealt: { player1: 5200, '/monsters/pyre_hunter': 0 },
        attacks: {
            player1: {
                '/monsters/pyre_hunter': {
                    autoAttack: { miss: 5, 200: 10 },
                    '/abilities/maim': { 400: 5 },
                    damageOverTime: { 80: 5, 100: 5 },
                },
            },
        },
    });

    test('splits the sim damage by what dealt it, with counts, totals and means', () => {
        const tally = simDamageTally(tallySim(), {
            playerHrid: 'player1',
            monsterHrid: '/monsters/pyre_hunter',
        });
        // Biggest damage source first
        expect(tally.sources.map((s) => s.source)).toEqual(['autoAttack', '/abilities/maim', 'damageOverTime']);

        const dot = tally.sources.find((s) => s.source === 'damageOverTime');
        expect(dot.landedHits).toBe(10);
        expect(dot.misses).toBe(0);
        expect(dot.totalDamage).toBe(900);
        expect(dot.meanDamage).toBeCloseTo(90, 5);
        expect(dot.shareOfLandedHits).toBeCloseTo(10 / 25, 5);

        const auto = tally.sources.find((s) => s.source === 'autoAttack');
        expect(auto.misses).toBe(5);
        expect(auto.meanDamage).toBeCloseTo(200, 5);

        expect(tally.landedHits).toBe(25);
        expect(tally.misses).toBe(5);
        expect(tally.totalDamage).toBe(2000 + 2000 + 900);
    });

    test('names the deciding ratio: DoT ticks per landed swing', () => {
        const tally = simDamageTally(tallySim(), {
            playerHrid: 'player1',
            monsterHrid: '/monsters/pyre_hunter',
        });
        expect(tally.swings).toBe(15);
        expect(tally.dotTicks).toBe(10);
        expect(tally.dotPerSwing).toBeCloseTo(10 / 15, 5);
    });

    test('a sim that never ticked reads zero ticks, not "no data"', () => {
        const tally = simDamageTally(
            {
                attacks: { p: { '/m': { autoAttack: { 100: 4 } } } },
            },
            { playerHrid: 'p', monsterHrid: '/m' }
        );
        expect(tally.dotTicks).toBe(0);
        expect(tally.dotPerSwing).toBe(0);
    });

    test('no tally at all is null, not a fabricated zero', () => {
        expect(simDamageTally({}, { playerHrid: 'p', monsterHrid: '/m' })).toBeNull();
        expect(simDamageTally(null, {})).toBeNull();
    });

    test('the prediction carries the tally through for the export', () => {
        const predicted = predictedFromSim(tallySim(), {
            playerHrid: 'player1',
            monsterHrid: '/monsters/pyre_hunter',
        });
        expect(predicted.tally.dotTicks).toBe(10);
        expect(predicted.dotPerSwing).toBeCloseTo(10 / 15, 5);
        // The hit rate counts the swings alone — 15 landed against 5 missed.
        // Folding the 10 DoT ticks in as landed hits read it 25/30 and flattered
        // the sim by eight points against a counter that never saw them.
        expect(predicted.hitRate).toBeCloseTo(15 / 20, 5);
    });
});

/**
 * The two sides of hit-rate and damage-per-hit have to divide by the same thing.
 *
 * The observed counts come off the monster's damage counter: a swing that landed,
 * a swing that missed, and — separately — health that fell with no counter behind
 * it (a bleed, a thorns reflect). The sim's tally has to be read the same way, or
 * the comparison silently pits "every entry the engine filed" against "the swings
 * the game counted".
 */
describe('the two sides divide by the same thing', () => {
    const dotSim = () => ({
        simulatedTime: 100e9,
        labyAttemptCount: 1,
        encounters: 1,
        totalDamageDealt: { player1: 2900, '/monsters/pyre_hunter': 0 },
        crits: { player1: 3 },
        attacks: {
            player1: {
                '/monsters/pyre_hunter': {
                    autoAttack: { miss: 5, 200: 10 },
                    // Uncounted health loss: neither rings the monster's hit counter
                    damageOverTime: { 80: 5, 100: 5 },
                    physicalThorns: { 25: 4 },
                },
            },
        },
    });

    test('the sim hit rate counts swings, not damage-over-time ticks', () => {
        const predicted = predictedFromSim(dotSim(), {
            playerHrid: 'player1',
            monsterHrid: '/monsters/pyre_hunter',
        });
        // 10 landed swings against 5 missed swings — the 14 uncounted ticks are
        // not attempts and must not inflate the rate towards 24/29
        expect(predicted.hitRate).toBeCloseTo(10 / 15, 5);
    });

    test('the sim damage-per-hit divides swing damage by swing hits', () => {
        const predicted = predictedFromSim(dotSim(), {
            playerHrid: 'player1',
            monsterHrid: '/monsters/pyre_hunter',
        });
        // 2000 from swings over 10 of them — not 2900 (with DoT and thorns) over 24
        expect(predicted.dmgPerHit).toBeCloseTo(200, 5);
        // The mixed figure stays available for a pool that can only be read mixed
        expect(predicted.dmgPerHitAllSources).toBeCloseTo(2900 / 24, 5);
    });

    test('the sim crit rate divides by swings too', () => {
        const predicted = predictedFromSim(dotSim(), {
            playerHrid: 'player1',
            monsterHrid: '/monsters/pyre_hunter',
        });
        expect(predicted.critRate).toBeCloseTo(3 / 10, 5);
    });

    test('thorns are uncounted health loss, so they tick rather than swing', () => {
        const tally = simDamageTally(dotSim(), {
            playerHrid: 'player1',
            monsterHrid: '/monsters/pyre_hunter',
        });
        expect(tally.swings).toBe(10);
        expect(tally.swingDamage).toBe(2000);
        expect(tally.dotTicks).toBe(14);
        expect(tally.dotDamage).toBe(900 + 100);
        expect(tally.dotPerSwing).toBeCloseTo(14 / 10, 5);
    });

    test('an observed fight subtracts its DoT damage before dividing by swings', () => {
        // 8000 dealt over 40 landed swings, of which 800 was DoT: 180 per swing
        const [g] = deriveObserved([
            attempt({
                monsterMaxHp: 100000,
                monsterHpEnd: 92000,
                seconds: 50,
                playerHits: 40,
                playerMisses: 10,
                playerDotTicks: 10,
                playerDotDamage: 800,
            }),
        ]);
        expect(g.dmgPerHit).toBeCloseTo(180, 5);
        expect(g.dmgPerHitIncludesDot).toBe(false);
        expect(g.dmgPerHitFights).toBe(1);
    });

    test('a fight recorded before DoT damage was split keeps the mixed figure, marked', () => {
        const [g] = deriveObserved([
            attempt({
                monsterMaxHp: 100000,
                monsterHpEnd: 92000,
                seconds: 50,
                playerHits: 40,
                playerMisses: 10,
            }),
        ]);
        expect(g.dmgPerHit).toBeCloseTo(200, 5);
        expect(g.dmgPerHitIncludesDot).toBe(true);
    });

    test('the two pools never mix: a split fight is not averaged with a legacy one', () => {
        const [g] = deriveObserved([
            attempt({
                monsterMaxHp: 100000,
                monsterHpEnd: 92000,
                seconds: 50,
                playerHits: 40,
                playerMisses: 10,
                playerDotDamage: 800,
            }),
            attempt({ monsterMaxHp: 100000, monsterHpEnd: 92000, seconds: 50, playerHits: 40, playerMisses: 10 }),
        ]);
        expect(g.dmgPerHit).toBeCloseTo(180, 5);
        expect(g.dmgPerHitFights).toBe(1);
        expect(g.dmgPerHitIncludesDot).toBe(false);
    });

    test('a mixed observed pool is compared against the mixed prediction, and says so', () => {
        const legacy = Array.from({ length: 6 }, () =>
            attempt({ monsterMaxHp: 100000, monsterHpEnd: 92000, seconds: 50, playerHits: 40, playerMisses: 10 })
        );
        const result = compareLab(deriveObserved(legacy)[0], {
            dps: 160,
            takenPerSecond: 10,
            clearRate: 0.2,
            secondsPerFight: 50,
            hitRate: 0.8,
            dmgPerHit: 150,
            dmgPerHitAllSources: 200,
        });
        const dph = result.metrics.find((m) => m.key === 'dmgPerHit');
        expect(dph.predicted).toBe(200);
        expect(dph.label).toMatch(/incl\. DoT/);
        expect(dph.verdict).toBe('consistent');
    });
});

describe('the observed hit mix', () => {
    const mixAttempt = (overrides = {}) =>
        attempt({
            monsterMaxHp: 100000,
            monsterHpEnd: 92000,
            seconds: 50,
            playerHits: 40,
            playerMisses: 10,
            playerDotTicks: 10,
            ...overrides,
        });

    test('DoT ticks per swing pool over the fights that recorded them', () => {
        const [group] = deriveObserved([mixAttempt(), mixAttempt({ playerDotTicks: 30 })]);
        expect(group.dotDataFights).toBe(2);
        expect(group.dotPerSwing).toBeCloseTo(40 / 80, 5);
    });

    test('an attempt recorded before DoT ticks were counted contributes none', () => {
        const [group] = deriveObserved([mixAttempt(), mixAttempt({ playerDotTicks: null })]);
        expect(group.dotDataFights).toBe(1);
        expect(group.dotPerSwing).toBeCloseTo(10 / 40, 5);
    });

    test('no fight carried DoT counts, so the mix is unknown rather than zero', () => {
        const [group] = deriveObserved([mixAttempt({ playerDotTicks: null })]);
        expect(group.dotPerSwing).toBeNull();
        expect(group.dotDataFights).toBe(0);
    });
});

describe('the mix decides a soft-hit gap', () => {
    /** Six fights: 40 swings / 10 misses, 10 DoT ticks, 8000 damage each */
    const mixLosses = (dotTicks) =>
        Array.from({ length: 6 }, () =>
            attempt({
                monsterMaxHp: 100000,
                monsterHpEnd: 92000,
                seconds: 50,
                playerHits: 40,
                playerMisses: 10,
                playerDotTicks: dotTicks,
            })
        );
    /** Predicted: damage per hit 10% over what was observed, everything else level */
    const softPrediction = (dotPerSwing) => ({
        dps: 200,
        takenPerSecond: 10,
        clearRate: 0.2,
        secondsPerFight: 50,
        hitRate: 0.8,
        dmgPerHit: 220,
        critRate: null,
        dotPerSwing,
        tally: { sources: [], swings: 100, dotTicks: Math.round(100 * dotPerSwing), dotPerSwing },
    });

    test('the mix rides in as its own metric row', () => {
        const result = compareLab(deriveObserved(mixLosses(10))[0], softPrediction(0.25));
        const mix = result.metrics.find((m) => m.key === 'dotPerSwing');
        expect(mix.observed).toBeCloseTo(0.25, 5);
        expect(mix.predicted).toBeCloseTo(0.25, 5);
        expect(mix.verdict).toBe('consistent');
        expect(result.simTally).toEqual(softPrediction(0.25).tally);
    });

    test('a matching mix adds nothing: the mix cannot move a swing-only row', () => {
        const result = compareLab(deriveObserved(mixLosses(10))[0], softPrediction(0.25));
        expect(result.diagnosis).toContain('Both sides count swings only');
        expect(result.diagnosis).toContain('mitigation');
        expect(result.diagnosis).not.toContain('off as well');
    });

    test('a mix that is off is reported as its own finding, not as the soft hits', () => {
        const result = compareLab(deriveObserved(mixLosses(40))[0], softPrediction(0.1));
        const mix = result.metrics.find((m) => m.key === 'dotPerSwing');
        expect(mix.verdict).toBe('above');
        expect(result.diagnosis).toMatch(/1\.00 DoT ticks per swing against the sim’s 0\.10/);
        expect(result.diagnosis).toContain('off as well');
        // It moves damage per second, not the row it sits under
        expect(result.diagnosis).toMatch(/damage per second rather than this row/);
        // And it never claims the mitigation question is settled
        expect(result.diagnosis).toContain('monster stat check');
    });

    test('without an observed mix the soft-hit sentence is unchanged', () => {
        const result = compareLab(deriveObserved(mixLosses(null))[0], softPrediction(0.25));
        expect(result.metrics.find((m) => m.key === 'dotPerSwing')).toBeUndefined();
        expect(result.diagnosis).toContain('Both sides count swings only');
        expect(result.diagnosis).not.toContain('off as well');
    });
});

describe('poolHygiene', () => {
    /**
     * Recorded fights, all alike.
     * @param {number} count - How many
     * @param {Object} fields - The two fields the count reads
     * @returns {Array<Object>}
     */
    const fights = (count, fields) => Array.from({ length: count }, () => ({ ...fields }));

    test('counts the complete fraction and what closed the rest', () => {
        const hygiene = poolHygiene([
            ...fights(412, { complete: true, resolveReason: 'new_battle' }),
            ...fights(61, { complete: false, resolveReason: 'stale' }),
            ...fights(27, { complete: false, resolveReason: 'room_switch' }),
        ]);

        expect(hygiene.total).toBe(500);
        expect(hygiene.complete).toBe(412);
        expect(hygiene.measured).toBe(500);
        expect(hygiene.completeFraction).toBeCloseTo(0.824);
        expect(hygiene.text).toContain('412 of 500 complete');
        expect(hygiene.text).toContain('61 stale');
        expect(hygiene.text).toContain('27 room-switch');
    });

    test('a fight recorded before the fields existed is not an incomplete fight', () => {
        // No `complete` flag at all. Reading the absence as false would invent 10
        // partials and understate the fraction of a pool that was measured whole.
        const hygiene = poolHygiene([...fights(10, {}), ...fights(10, { complete: true, resolveReason: 'new_fight' })]);

        expect(hygiene.total).toBe(20);
        expect(hygiene.incomplete).toBe(0);
        expect(hygiene.unknownComplete).toBe(10);
        expect(hygiene.measured).toBe(10);
        expect(hygiene.completeFraction).toBe(1);
        expect(hygiene.text).toContain('10 of 10 complete');
        expect(hygiene.text).toContain('10 before the field existed');
    });

    test('a missing resolve reason is its own bucket, never attributed to the commonest', () => {
        const hygiene = poolHygiene([
            ...fights(6, { complete: true, resolveReason: 'new_battle' }),
            ...fights(3, { complete: true, resolveReason: null }),
            ...fights(1, { complete: true }),
        ]);

        const byReason = Object.fromEntries(hygiene.reasons.map((r) => [r.reason, r.count]));
        expect(byReason).toEqual({ new_battle: 6, unknown: 4 });
        expect(hygiene.text).toContain('4 unknown');
    });

    test('the histogram is ordered by count, and underscores are not shown to a reader', () => {
        const hygiene = poolHygiene([
            ...fights(2, { complete: false, resolveReason: 'left_labyrinth' }),
            ...fights(9, { complete: false, resolveReason: 'feature_disabled' }),
            ...fights(5, { complete: true, resolveReason: 'new_battle' }),
        ]);

        expect(hygiene.reasons.map((r) => r.label)).toEqual(['feature-disabled', 'new-battle', 'left-labyrinth']);
    });

    test('an empty pool says so rather than dividing by nothing', () => {
        for (const empty of [[], null, undefined]) {
            const hygiene = poolHygiene(empty);
            expect(hygiene.total).toBe(0);
            expect(hygiene.completeFraction).toBeNull();
            expect(hygiene.reasons).toEqual([]);
            expect(hygiene.text).toBe('no fights recorded');
        }
    });

    test('a pool of nothing but holes is still counted honestly', () => {
        const hygiene = poolHygiene([null, undefined, { complete: false, resolveReason: 'stale' }]);
        expect(hygiene.total).toBe(1);
        expect(hygiene.completeFraction).toBe(0);
        expect(hygiene.text).toContain('0 of 1 complete');
    });
});

describe('nearMissRemainder', () => {
    /** A complete loss ending with `end` of the monster's 1000 HP still standing */
    const loss = (end, overrides = {}) => attempt({ complete: true, monsterHpEnd: end, ...overrides });

    test('the median is normalised against the monster maximum each record carries', () => {
        // Same 40% remainder on two very differently sized monsters
        const near = nearMissRemainder([
            ...Array.from({ length: 3 }, () => loss(400)),
            ...Array.from({ length: 2 }, () => loss(4, { monsterMaxHp: 10 })),
        ]);
        expect(near.n).toBe(5);
        expect(near.median).toBeCloseTo(0.4, 5);
        expect(near.text).toBe('losses end with the monster at 40% median (n=5)');
    });

    test("a record carrying classifyFight's own fraction is used as it stands", () => {
        const near = nearMissRemainder(
            Array.from({ length: 5 }, () => ({
                outcome: 'timeout',
                cleared: false,
                complete: true,
                monsterHpLeft: 0.08,
            }))
        );
        expect(near.n).toBe(5);
        expect(near.median).toBeCloseTo(0.08, 5);
        expect(near.text).toContain('8.0% median');
    });

    test('an even count averages the two middles rather than rounding them away', () => {
        const near = nearMissRemainder([loss(100), loss(200), loss(300), loss(400), loss(500), loss(600)], 6);
        expect(near.median).toBeCloseTo(0.35, 5);
    });

    test('wins are not losses, whichever way the record says so', () => {
        const near = nearMissRemainder([
            ...Array.from({ length: 5 }, () => loss(300)),
            attempt({ complete: true, outcome: 'clear', cleared: true, monsterHpEnd: 0 }),
            attempt({ complete: true, outcome: 'death', cleared: true, monsterHpEnd: 0 }),
            attempt({ complete: true, outcome: 'unknown', monsterHpEnd: 900 }),
        ]);
        expect(near.losses).toBe(5);
        expect(near.n).toBe(5);
        expect(near.median).toBeCloseTo(0.3, 5);
    });

    test('an incomplete attempt is counted as a loss and excluded from the median', () => {
        const near = nearMissRemainder([
            ...Array.from({ length: 5 }, () => loss(300)),
            ...Array.from({ length: 4 }, () => attempt({ complete: false, monsterHpEnd: 950 })),
            attempt({ monsterHpEnd: 950 }), // recorded before the field existed
        ]);
        expect(near.losses).toBe(10);
        expect(near.n).toBe(5);
        expect(near.excluded).toBe(5);
        expect(near.median).toBeCloseTo(0.3, 5);
        expect(near.text).toContain('(n=5)');
    });

    test('a loss with no maximum to normalise against is excluded, and n says so', () => {
        const near = nearMissRemainder([
            ...Array.from({ length: 5 }, () => loss(300)),
            loss(300, { monsterMaxHp: 0 }),
            loss(300, { monsterMaxHp: null }),
        ]);
        expect(near.losses).toBe(7);
        expect(near.n).toBe(5);
        expect(near.excluded).toBe(2);
    });

    test('a zero remainder on a loss is an unmeasured endpoint, not a fight won by a hair', () => {
        const near = nearMissRemainder([
            ...Array.from({ length: 5 }, () => loss(300)),
            ...Array.from({ length: 3 }, () => loss(0)),
        ]);
        expect(near.n).toBe(5);
        expect(near.median).toBeCloseTo(0.3, 5);
    });

    test('a loss with neither endpoint nor fraction is excluded', () => {
        const near = nearMissRemainder(
            Array.from({ length: 6 }, () => ({ outcome: 'death', cleared: false, complete: true }))
        );
        expect(near.losses).toBe(6);
        expect(near.n).toBe(0);
        expect(near.median).toBeNull();
        expect(near.text).toBeNull();
    });

    test('below the minimum there is no reading at all, only the counts', () => {
        const near = nearMissRemainder(Array.from({ length: 4 }, () => loss(300)));
        expect(near.losses).toBe(4);
        expect(near.n).toBe(4);
        expect(near.median).toBeNull();
        expect(near.text).toBeNull();
        // And the fifth usable loss is what unlocks it
        expect(nearMissRemainder(Array.from({ length: 5 }, () => loss(300))).text).not.toBeNull();
    });

    test('an empty or holed pool divides by nothing', () => {
        for (const empty of [[], null, undefined, [null, undefined]]) {
            const near = nearMissRemainder(empty);
            expect(near).toEqual({ losses: 0, n: 0, excluded: 0, median: null, text: null });
        }
    });

    test('tenths near the bottom, whole percents further out', () => {
        const near = (end) => nearMissRemainder(Array.from({ length: 5 }, () => loss(end))).text;
        expect(near(30)).toContain('at 3.0% median');
        expect(near(99)).toContain('at 9.9% median');
        expect(near(100)).toContain('at 10% median');
        expect(near(600)).toContain('at 60% median');
    });

    test('a remainder above the maximum is clamped rather than reported as over-full', () => {
        const near = nearMissRemainder(Array.from({ length: 5 }, () => loss(1500)));
        expect(near.median).toBe(1);
        expect(near.text).toContain('at 100% median');
    });
});
