import { describe, test, expect } from 'vitest';
import {
    extractMonsterAttacks,
    extractPlayerAttacks,
    summarizeSimAttacks,
    compareIncoming,
    describeFights,
    MIN_REAL_CASTS,
    MEAN_PER_CAST_TOLERANCE_PCT,
} from './labyrinth-uptime-harness.js';

/** A tick payload for the monster (index 0) attacking the player (index 0). */
function tick(at, atk, ability, playerHP) {
    return {
        at,
        payload: {
            mMap: { 0: { atkCounter: atk, abilityHrid: ability } },
            pMap: { 0: { cHP: playerHP } },
        },
    };
}

describe('extractMonsterAttacks', () => {
    test('labels each landed attack by the ability prepared before it', () => {
        const ticks = [
            tick(0, 0, '/abilities/firestorm', 1000),
            tick(100, 1, '/abilities/fireball', 900), // firestorm landed for 100
            tick(200, 2, '/abilities/fireball', 850), // fireball landed for 50
            tick(300, 2, '/abilities/fireball', 830), // no attack, HP fell 20 → DoT
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/firestorm']).toMatchObject({ casts: 1, hits: 1, damage: 100 });
        expect(byAbility['/abilities/fireball']).toMatchObject({ casts: 1, hits: 1, damage: 50 });
        expect(byAbility.damageOverTime).toMatchObject({ hits: 1, damage: 20 });
    });

    test('a counter drop is a new fight, not a burst of attacks', () => {
        const ticks = [
            tick(0, 5, '/abilities/fireball', 1000),
            tick(100, 6, '/abilities/fireball', 950), // fireball 50
            tick(200, 0, '/abilities/fireball', 1000), // respawn — counter reset, no attack credited
            tick(300, 1, '/abilities/fireball', 940), // fireball 60
        ];
        const { byAbility, fights } = extractMonsterAttacks(ticks);
        // two 50/60 hits, and the reset must not manufacture a 0→? burst
        expect(byAbility['/abilities/fireball'].hits).toBe(2);
        expect(byAbility['/abilities/fireball'].damage).toBe(110);
        expect(fights).toBeGreaterThanOrEqual(2);
    });

    test('an auto-attack after a special is autoAttack, not the lingering special', () => {
        // Real ticks carry isAutoAtk on ordinary swings and name a special in
        // abilityHrid only on its cast tick (never persisted). The label must
        // fall back to autoAttack, or every auto after a special inherits it —
        // reporting a special cast-share the cooldowns could never produce.
        const auto = (at, atk, hp) => ({
            at,
            payload: { mMap: { 0: { atkCounter: atk, isAutoAtk: true } }, pMap: { 0: { cHP: hp } } },
        });
        const ticks = [
            tick(0, 0, '/abilities/sweep', 1000), // preparing sweep
            auto(100, 1, 900), // sweep landed (100); now auto-attacking
            auto(200, 2, 850), // auto landed (50)
            auto(300, 3, 800), // auto landed (50)
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/sweep']).toMatchObject({ casts: 1, hits: 1, damage: 100 });
        expect(byAbility.autoAttack).toMatchObject({ casts: 2, hits: 2, damage: 100 });
    });

    test('a non-damaging buff cast never absorbs a later hit', () => {
        // The monster casts a self-buff (toughness, no damage), then auto-attacks
        // for 100. Without the guard, the buff's queued slot swallows the auto's
        // damage — crediting incoming damage to an ability that deals none.
        const mk = (at, matk, mFields, cHP, pdmg) => ({
            at,
            payload: { mMap: { 0: { atkCounter: matk, ...mFields } }, pMap: { 0: { cHP, dmgCounter: pdmg } } },
        });
        const ticks = [
            mk(0, 0, { abilityHrid: '/abilities/toughness' }, 1000, 0), // preparing toughness
            mk(100, 1, { isAutoAtk: true }, 1000, 0), // toughness registered (no damage), now auto-ing
            mk(200, 2, { isAutoAtk: true }, 900, 1), // auto lands for 100
        ];
        const { byAbility } = extractMonsterAttacks(ticks, { nonDamaging: new Set(['/abilities/toughness']) });
        expect(byAbility['/abilities/toughness']).toMatchObject({ casts: 1, damage: 0 });
        expect(byAbility.autoAttack).toMatchObject({ hits: 1, damage: 100 });
    });

    test('an attack with no health drop is a miss', () => {
        const ticks = [
            tick(0, 0, '/abilities/fireball', 1000),
            tick(100, 1, '/abilities/fireball', 1000), // attacked, no damage → miss
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/fireball']).toMatchObject({ casts: 1, hits: 0, misses: 1 });
    });
});

/** A dmgCounter-carrying tick: monster (atk/ability) vs player (HP + damage-taken counter). */
function dtick(at, matk, ability, playerHP, pdmg) {
    return {
        at,
        payload: {
            mMap: { 0: { atkCounter: matk, abilityHrid: ability } },
            pMap: { 0: { cHP: playerHP, dmgCounter: pdmg } },
        },
    };
}

describe('extractMonsterAttacks — damage-counter path', () => {
    test('credits a cast-ability hit that lands a tick after the swing', () => {
        // firestorm swings at tick 1 (atk rises, damage not yet applied), and its
        // hit resolves at tick 2 (dmgCounter rises, HP falls). The health-only
        // path would call tick 1 a miss and tick 2 a DoT; the counter pairs them.
        const ticks = [
            dtick(0, 0, '/abilities/firestorm', 1000, 0),
            dtick(100, 1, '/abilities/smoke_burst', 1000, 0), // firestorm swing registered, no damage yet
            dtick(200, 1, '/abilities/smoke_burst', 900, 1), // firestorm resolves for 100
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/firestorm']).toMatchObject({ casts: 1, hits: 1, damage: 100 });
        expect(byAbility.damageOverTime).toBeUndefined();
    });

    test('a damage-counter rise with no pending swing is damage-over-time', () => {
        const ticks = [
            dtick(0, 5, '/abilities/fireball', 1000, 10),
            dtick(100, 5, '/abilities/fireball', 940, 11), // no swing, counter rose → DoT 60
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility.damageOverTime).toMatchObject({ hits: 1, damage: 60 });
    });

    test('a damage-counter rise with health flat is a miss', () => {
        const ticks = [
            dtick(0, 0, '/abilities/fireball', 1000, 0),
            dtick(100, 1, '/abilities/fireball', 1000, 0), // swing
            dtick(200, 1, '/abilities/fireball', 1000, 1), // resolves, no HP change → miss
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/fireball']).toMatchObject({ casts: 1, hits: 0, misses: 1 });
    });

    test('a monster-gone gap does not inflate the next hit off a stale baseline', () => {
        // The HP reading snaps to max (1000) while the monster is gone; the next
        // real hit must be measured from the re-seeded baseline, not that spike.
        const ticks = [
            dtick(0, 3, '/abilities/fireball', 600, 5),
            { at: 100, payload: { mMap: {}, pMap: { 0: { cHP: 1000, dmgCounter: 5 } } } }, // gone, HP snaps up
            dtick(200, 3, '/abilities/fireball', 1000, 5), // re-seed baseline at 1000
            dtick(300, 4, '/abilities/fireball', 1000, 5), // swing
            dtick(400, 4, '/abilities/fireball', 940, 6), // resolves for 60, not 60+400
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/fireball'].damage).toBe(60);
    });

    test('two attacks resolving on one merged tick split the drop', () => {
        const ticks = [
            dtick(0, 0, '/abilities/fireball', 1000, 0),
            dtick(100, 2, '/abilities/fireball', 1000, 0), // two swings registered
            dtick(200, 2, '/abilities/fireball', 800, 2), // both resolve, 200 over 2 = 100 each
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/fireball']).toMatchObject({ casts: 2, hits: 2, damage: 200 });
    });
});

describe('summarizeSimAttacks', () => {
    test('folds a damage histogram into hits, misses and total damage', () => {
        const { byAbility } = summarizeSimAttacks({
            '/abilities/firestorm': { 100: 3, 50: 2, miss: 1 },
        });
        expect(byAbility['/abilities/firestorm']).toEqual({ casts: 6, hits: 5, misses: 1, damage: 400 });
    });
});

describe('compareIncoming', () => {
    test('flags an ability the sim under-weights in incoming damage', () => {
        const real = {
            byAbility: {
                '/abilities/firestorm': { casts: 5, hits: 5, misses: 0, damage: 500, samples: [] },
                '/abilities/fireball': { casts: 5, hits: 5, misses: 0, damage: 100, samples: [] },
            },
        };
        const sim = summarizeSimAttacks({
            '/abilities/firestorm': { 20: 5 }, // sim: firestorm only 100 total → under-weighted
            '/abilities/fireball': { 20: 5 },
        });
        const { rows } = compareIncoming(real, sim);
        const fire = rows.find((r) => r.ability === 'firestorm');
        // real firestorm is 83% of incoming damage; sim has it at 50% → sim-under
        expect(fire.verdict).toBe('sim-under');
        expect(fire.dmgShareGap).toBeLessThan(0);
        // ordered by real damage share — firestorm (the big one) leads
        expect(rows[0].ability).toBe('firestorm');
    });

    test('matching shares read as ok', () => {
        const real = {
            byAbility: { '/abilities/fireball': { casts: 10, hits: 10, misses: 0, damage: 1000, samples: [] } },
        };
        const sim = summarizeSimAttacks({ '/abilities/fireball': { 100: 10 } });
        const { rows } = compareIncoming(real, sim);
        expect(rows[0].verdict).toBe('ok');
    });

    test('an ability the sim never produces is sim-missing', () => {
        const real = {
            byAbility: { '/abilities/firestorm': { casts: 3, hits: 3, misses: 0, damage: 300, samples: [] } },
        };
        const { rows } = compareIncoming(real, summarizeSimAttacks({}));
        expect(rows[0].verdict).toBe('sim-missing');
    });

    test('a non-damaging self-buff the sim omits is a buff, not sim-missing', () => {
        // Precision / a fierce aura casts but deals no damage, so the sim's
        // attack tally correctly omits it — that is not a missing damage source.
        const real = {
            byAbility: { '/abilities/precision': { casts: 7, hits: 0, misses: 0, damage: 0, samples: [] } },
        };
        const { rows } = compareIncoming(real, summarizeSimAttacks({}));
        expect(rows[0].verdict).toBe('buff');
    });

    test('rows carry the real cast count as samples, and per-hit means', () => {
        const real = {
            byAbility: { '/abilities/fireball': { casts: 10, hits: 8, misses: 2, damage: 800, samples: [] } },
        };
        const sim = summarizeSimAttacks({ '/abilities/fireball': { 100: 8, miss: 2 } });
        const { rows } = compareIncoming(real, sim);
        expect(rows[0].samples).toBe(10);
        expect(rows[0].real.meanDmgPerCast).toBeCloseTo(80, 5);
        expect(rows[0].real.meanDmgPerHit).toBeCloseTo(100, 5);
        expect(rows[0].sim.meanDmgPerHit).toBeCloseTo(100, 5);
    });

    test('a row with too few real casts is inconclusive, whatever its share gap says', () => {
        // Two abilities so the shares can gape; the thin one must not read as a
        // finding off two casts.
        const real = {
            byAbility: {
                '/abilities/fireball': { casts: 20, hits: 20, misses: 0, damage: 2000, samples: [] },
                '/abilities/nova': { casts: MIN_REAL_CASTS - 1, hits: 4, misses: 0, damage: 40, samples: [] },
            },
        };
        const sim = summarizeSimAttacks({
            '/abilities/fireball': { 100: 20 },
            '/abilities/nova': { 100: 20 }, // sim gives nova a huge share — still not gradable
        });
        const { rows } = compareIncoming(real, sim);
        const nova = rows.find((r) => r.ability === 'nova');
        expect(nova.verdict).toBe('inconclusive');
    });

    test('shares can pass while the per-cast mean gives the verdict away', () => {
        // One ability on each side: both shares are 100% by construction, so
        // only the mean can catch the sim landing every cast for half as much.
        const real = {
            byAbility: { '/abilities/fireball': { casts: 10, hits: 10, misses: 0, damage: 1000, samples: [] } },
        };
        const under = compareIncoming(real, summarizeSimAttacks({ '/abilities/fireball': { 50: 10 } }));
        expect(under.rows[0].verdict).toBe('sim-under');
        expect(under.rows[0].meanPerCastGapPct).toBeCloseTo(-50, 5);

        const over = compareIncoming(real, summarizeSimAttacks({ '/abilities/fireball': { 200: 10 } }));
        expect(over.rows[0].verdict).toBe('sim-over');

        // Within the tolerance the row stays ok
        const near = compareIncoming(real, summarizeSimAttacks({ '/abilities/fireball': { 110: 10 } }));
        expect(Math.abs(near.rows[0].meanPerCastGapPct)).toBeLessThan(MEAN_PER_CAST_TOLERANCE_PCT);
        expect(near.rows[0].verdict).toBe('ok');
    });
});

describe('compareIncoming — damage-over-time rows', () => {
    // Both sides record DoT at tick level under 'damageOverTime' (the sim files
    // each 3-second DamageOverTimeEvent tick there), so the row compares
    // directly — but its ticks are not casts, and must not enter cast shares.
    const real = {
        byAbility: {
            '/abilities/fireball': { casts: 10, hits: 10, misses: 0, damage: 1000, samples: [] },
            damageOverTime: { casts: 0, hits: 6, misses: 0, damage: 300, samples: [] },
        },
    };

    test('per-tick means compare and ticks stand in as the sample count', () => {
        const sim = summarizeSimAttacks({
            '/abilities/fireball': { 100: 10 },
            damageOverTime: { 50: 6 },
        });
        const { rows } = compareIncoming(real, sim);
        const dot = rows.find((r) => r.ability === 'damageOverTime');
        expect(dot.samples).toBe(6);
        expect(dot.real.meanDmgPerCast).toBeCloseTo(50, 5);
        expect(dot.sim.meanDmgPerCast).toBeCloseTo(50, 5);
        expect(dot.verdict).toBe('ok');
    });

    test('DoT ticks stay out of the cast-share denominators on both sides', () => {
        const sim = summarizeSimAttacks({
            '/abilities/fireball': { 100: 10 },
            damageOverTime: { 50: 6 }, // 6 sim ticks that must not dilute fireball's cast share
        });
        const { rows } = compareIncoming(real, sim);
        const fireball = rows.find((r) => r.ability === 'fireball');
        expect(fireball.real.castSharePct).toBeCloseTo(100, 5);
        expect(fireball.sim.castSharePct).toBeCloseTo(100, 5);
        const dot = rows.find((r) => r.ability === 'damageOverTime');
        expect(dot.real.castSharePct).toBeNull();
        expect(dot.sim.castSharePct).toBeNull();
        expect(dot.castShareGap).toBeNull();
    });

    test('a DoT row with too few real ticks is inconclusive', () => {
        const thin = {
            byAbility: {
                '/abilities/fireball': { casts: 10, hits: 10, misses: 0, damage: 1000, samples: [] },
                damageOverTime: { casts: 0, hits: 2, misses: 0, damage: 100, samples: [] },
            },
        };
        const sim = summarizeSimAttacks({
            '/abilities/fireball': { 100: 10 },
            damageOverTime: { 10: 2 },
        });
        const { rows } = compareIncoming(thin, sim);
        expect(rows.find((r) => r.ability === 'damageOverTime').verdict).toBe('inconclusive');
    });
});

/**
 * A tick for the OUTGOING direction: the player (index 0) swinging at the
 * monster (index 0). `p` carries the player's attack counter and label fields,
 * `m` the monster's health and damage-taken counter.
 */
function ptick(at, p, m) {
    return {
        at,
        payload: {
            pMap: { 0: { ...p } },
            mMap: { 0: { ...m } },
        },
    };
}

describe('extractPlayerAttacks', () => {
    test('labels the player’s swings by ability and pays them off from the monster’s dmgCounter', () => {
        // The two-direction fixture: the same ladder as incoming, roles swapped.
        // A cast ability swings at one tick and resolves on the next (the
        // monster's dmgCounter rises, its HP falls).
        const ticks = [
            ptick(0, { atkCounter: 0, abilityHrid: '/abilities/fireball' }, { cHP: 1000, dmgCounter: 0 }),
            ptick(100, { atkCounter: 1, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }), // fireball swing, not landed yet
            ptick(200, { atkCounter: 1, isAutoAtk: true }, { cHP: 850, dmgCounter: 1 }), // fireball resolves for 150
            ptick(300, { atkCounter: 2, isAutoAtk: true }, { cHP: 800, dmgCounter: 2 }), // auto lands for 50
        ];
        const { byAbility } = extractPlayerAttacks(ticks);
        expect(byAbility['/abilities/fireball']).toMatchObject({ casts: 1, hits: 1, damage: 150 });
        expect(byAbility.autoAttack).toMatchObject({ casts: 1, hits: 1, damage: 50 });
        expect(byAbility.damageOverTime).toBeUndefined();
    });

    test('the same ticks decompose both directions independently', () => {
        // One fixture carrying both sides' counters: the incoming read must not
        // disturb the outgoing one, and vice versa.
        const both = (at, p, m) => ({ at, payload: { pMap: { 0: { ...p } }, mMap: { 0: { ...m } } } });
        const ticks = [
            both(
                0,
                { atkCounter: 0, abilityHrid: '/abilities/smash', cHP: 500, dmgCounter: 0 },
                { atkCounter: 0, abilityHrid: '/abilities/bite', cHP: 1000, dmgCounter: 0 }
            ),
            both(
                100,
                { atkCounter: 1, isAutoAtk: true, cHP: 440, dmgCounter: 1 }, // took the bite for 60
                { atkCounter: 1, isAutoAtk: true, cHP: 900, dmgCounter: 1 } // took the smash for 100
            ),
        ];
        expect(extractPlayerAttacks(ticks).byAbility['/abilities/smash']).toMatchObject({
            casts: 1,
            hits: 1,
            damage: 100,
        });
        expect(extractMonsterAttacks(ticks).byAbility['/abilities/bite']).toMatchObject({
            casts: 1,
            hits: 1,
            damage: 60,
        });
    });

    test('a heal or self-buff is a cast that never joins the payoff queue', () => {
        // The player casts Rejuvenate (a heal — no monster dmgCounter rise),
        // then autos for 100. Without the guard, the heal's queued slot would
        // swallow the auto's damage.
        const ticks = [
            ptick(0, { atkCounter: 0, abilityHrid: '/abilities/rejuvenate' }, { cHP: 1000, dmgCounter: 0 }),
            ptick(100, { atkCounter: 1, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }), // heal cast, no hit rings
            ptick(200, { atkCounter: 2, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }), // auto swing
            ptick(300, { atkCounter: 2, isAutoAtk: true }, { cHP: 900, dmgCounter: 1 }), // auto resolves for 100
        ];
        const { byAbility } = extractPlayerAttacks(ticks, {
            nonDamaging: new Set(['/abilities/rejuvenate']),
        });
        expect(byAbility['/abilities/rejuvenate']).toMatchObject({ casts: 1, hits: 0, damage: 0 });
        expect(byAbility.autoAttack).toMatchObject({ casts: 1, hits: 1, damage: 100 });
    });

    test('an auto after a special is autoAttack, not the lingering special', () => {
        const ticks = [
            ptick(0, { atkCounter: 0, abilityHrid: '/abilities/cleave' }, { cHP: 1000, dmgCounter: 0 }),
            ptick(100, { atkCounter: 1, isAutoAtk: true }, { cHP: 880, dmgCounter: 1 }), // cleave landed (120)
            ptick(200, { atkCounter: 2, isAutoAtk: true }, { cHP: 830, dmgCounter: 2 }), // auto (50)
            ptick(300, { atkCounter: 3, isAutoAtk: true }, { cHP: 780, dmgCounter: 3 }), // auto (50)
        ];
        const { byAbility } = extractPlayerAttacks(ticks);
        expect(byAbility['/abilities/cleave']).toMatchObject({ casts: 1, hits: 1, damage: 120 });
        expect(byAbility.autoAttack).toMatchObject({ casts: 2, hits: 2, damage: 100 });
    });

    test('a monster dmgCounter rise with no swing pending is the player’s DoT', () => {
        const ticks = [
            ptick(0, { atkCounter: 5, isAutoAtk: true }, { cHP: 1000, dmgCounter: 10 }),
            ptick(100, { atkCounter: 5, isAutoAtk: true }, { cHP: 940, dmgCounter: 11 }), // bleed tick, 60
        ];
        const { byAbility } = extractPlayerAttacks(ticks);
        expect(byAbility.damageOverTime).toMatchObject({ hits: 1, damage: 60 });
    });

    test('a resolution with the monster’s health flat is a miss', () => {
        const ticks = [
            ptick(0, { atkCounter: 0, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }),
            ptick(100, { atkCounter: 1, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }), // swing
            ptick(200, { atkCounter: 1, isAutoAtk: true }, { cHP: 1000, dmgCounter: 1 }), // resolves, HP flat
        ];
        const { byAbility } = extractPlayerAttacks(ticks);
        expect(byAbility.autoAttack).toMatchObject({ casts: 1, hits: 0, misses: 1 });
    });

    test('the opening swing after a new_battle is measured, not spent as a baseline', () => {
        const start = (at) => ({
            at,
            type: 'new_battle',
            payload: {
                battleId: 1,
                players: [
                    {
                        attackAttemptCounter: 1,
                        damageSplatCounter: 0,
                        currentHitpoints: 500,
                        isPreparingAutoAttack: true,
                    },
                ],
                monsters: [{ attackAttemptCounter: 1, damageSplatCounter: 3, currentHitpoints: 1000 }],
            },
        });
        const ticks = [
            // Leading partial: a fight already in progress, excluded from the aggregate
            ptick(0, { atkCounter: 8, isAutoAtk: true, cHP: 300 }, { cHP: 400, dmgCounter: 20 }),
            ptick(100, { atkCounter: 9, isAutoAtk: true, cHP: 300 }, { cHP: 300, dmgCounter: 21 }),
            start(10_000),
            // The FIRST compact tick already carries the opening swing and its
            // 80-damage hit relative to the start snapshot
            ptick(10_500, { atkCounter: 2, isAutoAtk: true, cHP: 500 }, { cHP: 920, dmgCounter: 4 }),
            ptick(11_000, { atkCounter: 3, isAutoAtk: true, cHP: 500 }, { cHP: 0, dmgCounter: 5 }), // killing blow, 920
        ];
        const out = extractPlayerAttacks(ticks);
        expect(out.fights).toBe(1);
        expect(out.partialFights).toBe(1);
        expect(out.captureStartedMidFight).toBe(true);
        expect(out.attempts.map((a) => a.outcome)).toEqual(['unknown', 'win']);
        expect(out.byAbility.autoAttack).toMatchObject({ casts: 2, hits: 2 });
        expect(out.byAbility.autoAttack.damage).toBeCloseTo(80 + 920, 5);
    });

    test('a player counter drop with no start message is a new fight, not a burst', () => {
        const ticks = [
            ptick(0, { atkCounter: 5, isAutoAtk: true }, { cHP: 1000, dmgCounter: 10 }),
            ptick(100, { atkCounter: 6, isAutoAtk: true }, { cHP: 950, dmgCounter: 11 }), // 50
            ptick(200, { atkCounter: 0, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }), // respawn — reset
            ptick(300, { atkCounter: 1, isAutoAtk: true }, { cHP: 940, dmgCounter: 1 }), // 60
        ];
        const { byAbility, fights } = extractPlayerAttacks(ticks);
        expect(byAbility.autoAttack.hits).toBe(2);
        expect(byAbility.autoAttack.damage).toBe(110);
        expect(fights).toBeGreaterThanOrEqual(2);
    });

    test('a monster-gone gap resets the baselines rather than crediting a spike', () => {
        // Between fights the monster entry vanishes and its HP snaps back to max
        // on respawn; the next hit must be measured from the re-seeded baseline.
        const ticks = [
            ptick(0, { atkCounter: 3, isAutoAtk: true }, { cHP: 200, dmgCounter: 5 }),
            { at: 100, payload: { pMap: { 0: { atkCounter: 3, isAutoAtk: true } }, mMap: {} } }, // monster gone
            ptick(200, { atkCounter: 3, isAutoAtk: true }, { cHP: 1000, dmgCounter: 5 }), // re-seed at full HP
            ptick(300, { atkCounter: 4, isAutoAtk: true }, { cHP: 1000, dmgCounter: 5 }), // swing
            ptick(400, { atkCounter: 4, isAutoAtk: true }, { cHP: 930, dmgCounter: 6 }), // resolves for 70, not 70+800
        ];
        const { byAbility } = extractPlayerAttacks(ticks);
        expect(byAbility.autoAttack.damage).toBe(70);
    });

    test('two resolutions on one merged tick split the monster’s drop evenly', () => {
        const ticks = [
            ptick(0, { atkCounter: 0, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }),
            ptick(100, { atkCounter: 2, isAutoAtk: true }, { cHP: 1000, dmgCounter: 0 }), // two swings queued
            ptick(200, { atkCounter: 2, isAutoAtk: true }, { cHP: 800, dmgCounter: 2 }), // both land, 100 each
        ];
        const { byAbility } = extractPlayerAttacks(ticks);
        expect(byAbility.autoAttack).toMatchObject({ casts: 2, hits: 2, damage: 200 });
        expect(byAbility.autoAttack.samples).toEqual([100, 100]);
    });

    test('compareIncoming grades the outgoing direction unchanged', () => {
        // The comparison is direction-agnostic given byAbility maps: feed it the
        // player's real decomposition against the sim's player→monster tally.
        const ticks = [];
        let atk = 0;
        let dmg = 0;
        let hp = 10000;
        ticks.push(ptick(0, { atkCounter: 0, isAutoAtk: true }, { cHP: hp, dmgCounter: 0 }));
        for (let n = 0; n < 6; n++) {
            atk += 1;
            dmg += 1;
            hp -= 100;
            ticks.push(ptick(100 * (n + 1), { atkCounter: atk, isAutoAtk: true }, { cHP: hp, dmgCounter: dmg }));
        }
        const real = extractPlayerAttacks(ticks);
        // The sim lands every auto for half as much → sim-under on the mean.
        const sim = summarizeSimAttacks({ autoAttack: { 50: 6 } });
        const { rows } = compareIncoming(real, sim);
        expect(rows[0].ability).toBe('autoAttack');
        expect(rows[0].verdict).toBe('sim-under');
    });
});

describe('describeFights', () => {
    test('counts fights, names excluded partials, and flags a mid-fight start', () => {
        expect(describeFights({ fights: 3, partialFights: 0, captureStartedMidFight: false })).toBe('3 fights');
        expect(describeFights({ fights: 1, partialFights: 0, captureStartedMidFight: false })).toBe('1 fight');
        expect(describeFights({ fights: 2, partialFights: 1, captureStartedMidFight: true })).toBe(
            '2 fights (+1 partial excluded) — capture started mid-fight'
        );
        expect(describeFights(null)).toBe('');
    });
});

describe('attempt segmentation on new_battle', () => {
    /** A capture-shaped start message with full unit snapshots */
    const start = (at, { mHp, pHp, matk = 1, pdmg = 0 }) => ({
        at,
        type: 'new_battle',
        payload: {
            battleId: 1, // the server reuses ids — segmentation must not rely on them
            players: [{ attackAttemptCounter: 1, damageSplatCounter: pdmg, currentHitpoints: pHp }],
            monsters: [{ attackAttemptCounter: matk, currentHitpoints: mHp, isPreparingAutoAttack: true }],
        },
    });
    /** A compact battle tick */
    const tick = (at, { mHp, mAtk, pHp, pDmg, auto = true }) => ({
        at,
        type: 'battle_updated',
        payload: {
            mMap: { 0: { cHP: mHp, atkCounter: mAtk, isAutoAtk: auto } },
            pMap: { 0: { cHP: pHp, dmgCounter: pDmg } },
        },
    });

    // Mirrors the real Frost Sniper capture's structure: a fight already in
    // progress when recording began, then three seen-from-the-start retries —
    // two losses and a win — with the server reusing battle id 1 throughout.
    const CAPTURE = [
        // Leading partial: no new_battle seen, ends in a death
        tick(0, { mHp: 900, mAtk: 5, pHp: 200, pDmg: 10 }),
        tick(500, { mHp: 900, mAtk: 6, pHp: 100, pDmg: 11 }),
        tick(1000, { mHp: 900, mAtk: 7, pHp: 0, pDmg: 12 }),
        // Attempt 1 (complete): the FIRST compact tick already carries a swing
        // and its 50-damage hit relative to the start snapshot — the case the
        // unseeded baseline silently swallowed
        start(10_000, { mHp: 1000, pHp: 500 }),
        tick(10_500, { mHp: 1000, mAtk: 2, pHp: 450, pDmg: 1 }),
        tick(11_000, { mHp: 1000, mAtk: 3, pHp: 0, pDmg: 2 }),
        // Attempt 2 (complete): a win
        start(20_000, { mHp: 1000, pHp: 500 }),
        tick(20_500, { mHp: 600, mAtk: 2, pHp: 460, pDmg: 1 }),
        tick(21_000, { mHp: 0, mAtk: 2, pHp: 460, pDmg: 1 }),
    ];

    test('the capture reads as its attempts, not one long fight', () => {
        const out = extractMonsterAttacks(CAPTURE);

        expect(out.fights).toBe(2);
        expect(out.partialFights).toBe(1);
        expect(out.captureStartedMidFight).toBe(true);
        expect(out.attempts.map((a) => a.complete)).toEqual([false, true, true]);
        expect(out.attempts.map((a) => a.outcome)).toEqual(['loss', 'loss', 'win']);
    });

    test('the first tick after a start is measured, not spent as a baseline', () => {
        const out = extractMonsterAttacks(CAPTURE);

        // Attempt 1's opening swing: counter 1→2 with a 500→450 drop. The old
        // extractor seeded on this tick and the 50 damage vanished.
        const auto = out.attempts[1].byAbility.autoAttack;
        expect(auto.casts).toBeGreaterThanOrEqual(1);
        expect(auto.damage).toBeCloseTo(50 + 450, 5); // opening hit + killing blow
    });

    test('the leading partial stays out of the aggregate', () => {
        const out = extractMonsterAttacks(CAPTURE);

        // The partial dealt 100+100 into pHp drops; the aggregate carries only
        // the complete attempts' totals
        const total = Object.values(out.byAbility).reduce((sum, r) => sum + r.damage, 0);
        const partialTotal = Object.values(out.attempts[0].byAbility).reduce((sum, r) => sum + r.damage, 0);
        expect(partialTotal).toBeGreaterThan(0);
        expect(total).toBeCloseTo(50 + 450 + 40, 5); // both complete attempts, nothing from the partial
    });

    test('a capture with no start messages keeps the legacy reading', () => {
        const legacy = [
            tick(0, { mHp: 900, mAtk: 1, pHp: 500, pDmg: 0 }),
            tick(500, { mHp: 900, mAtk: 2, pHp: 450, pDmg: 1 }),
            tick(1000, { mHp: 900, mAtk: 3, pHp: 400, pDmg: 2 }),
        ];
        const out = extractMonsterAttacks(legacy);
        expect(out.fights).toBe(1);
        expect(out.partialFights).toBe(0);
        expect(out.captureStartedMidFight).toBe(false);
    });
});
