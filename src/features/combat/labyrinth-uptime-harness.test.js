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

    test('an attack with no health drop is a miss', () => {
        const ticks = [
            tick(0, 0, '/abilities/fireball', 1000),
            tick(100, 1, '/abilities/fireball', 1000), // attacked, no damage → miss
        ];
        const { byAbility } = extractMonsterAttacks(ticks);
        expect(byAbility['/abilities/fireball']).toMatchObject({ casts: 1, hits: 0, misses: 1 });
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
});
