import { describe, test, expect } from 'vitest';
import { extractMonsterAttacks, summarizeSimAttacks, compareIncoming } from './labyrinth-uptime-harness.js';

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
});
