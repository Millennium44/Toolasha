/**
 * Incoming damage against an untrimmed recording.
 *
 * There is a second replay, and it exists because the first one lied.
 *
 * `combat-run.json` was hand-trimmed to five fields per monster when it was made
 * into a fixture, and a rung of this module's ladder was then derived from it:
 * "a monster in the delta with nothing changed is the one that swung" held on
 * thirty-seven of its forty-two hits. It held because the trimming had removed
 * everything that changes. Against a real payload that rung fires never, and
 * every hit of a session went to "Unknown Enemy".
 *
 * `combat-dungeon.json` keeps each tick exactly as it arrived. That is the whole
 * point of it, and it is why `atkCounter` — a counter that goes up when a
 * monster attacks — was visible at all.
 *
 * Five battles on Planet of the Eyes, thirteen hits taken across waves of two
 * and three, so unlike the first recording this one actually exercises the case
 * where several monsters are alive and one of them hits you.
 */

import { describe, test, expect } from 'vitest';
import { newTakenState, attributeIncoming, foldTaken, foldTakenByEnemy } from './damage-taken.js';
import recording from './__fixtures__/combat-dungeon.json';

/**
 * The run, as the tracker would tally it.
 * @returns {{players: Object, enemies: Object, rosters: Array<Object>}}
 */
function replay() {
    let state = newTakenState();
    const players = {};
    const enemies = {};
    const rosters = [];
    let monsters = {};

    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') {
            monsters = {};
            for (const [index, monster] of Object.entries(tick.payload.monsters || {})) {
                if (monster?.name) monsters[index] = monster.name;
            }
            rosters.push({ ...monsters });
            state = newTakenState();
            continue;
        }

        const battle = monsters;
        const events = attributeIncoming(tick.payload, state);
        foldTaken(players, events);
        foldTakenByEnemy(enemies, events, (index) => battle[index] || null);
    }

    return { players, enemies, rosters };
}

describe('a recorded dungeon, every field kept', () => {
    const { players, enemies, rosters } = replay();
    const player = players['0'];

    test('the waves really were several monsters at once', () => {
        // Which the first recording never was, so it could not have caught this
        expect(rosters.length).toBe(5);
        expect(Math.max(...rosters.map((roster) => Object.keys(roster).length))).toBeGreaterThan(1);
    });

    test('every hit is attributed to a named monster', () => {
        // This is the assertion the module exists to satisfy, and the one that
        // was failing on a real session while both other replays passed
        expect(enemies['Unknown Enemy']).toBeUndefined();
        expect(Object.keys(enemies).sort()).toEqual(['Eye', 'Eyes', 'Veyes']);
    });

    test('the enemy breakdown adds up to what was taken', () => {
        const summed = Object.values(enemies).reduce((total, enemy) => total + enemy.damage, 0);
        expect(summed).toBe(player.damage);
    });

    test('damage taken and healed are both real figures', () => {
        expect(player.damage).toBeGreaterThan(0);
        expect(player.regen).toBeGreaterThan(0);
    });

    test('nobody died', () => {
        expect(player.deaths).toBe(0);
    });

    test('every hit sits inside the range reported for it', () => {
        for (const enemy of Object.values(enemies)) {
            expect(enemy.min).toBeLessThanOrEqual(enemy.max);
            expect(enemy.max).toBeLessThanOrEqual(player.damage);
        }
    });

    test('the ticks carry the counter the attribution turns on', () => {
        // A guard on the fixture rather than on the code: trimmed away, this
        // recording would go on passing every test above by falling through to a
        // weaker rung, which is exactly how the first one went wrong
        const monsterStates = recording.ticks
            .filter((tick) => tick.type !== 'new_battle')
            .flatMap((tick) => Object.values(tick.payload.mMap || {}));

        expect(monsterStates.some((monster) => 'atkCounter' in monster)).toBe(true);
    });
});
