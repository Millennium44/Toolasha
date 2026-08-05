/**
 * Incoming damage against a real fight.
 *
 * The same recorded run the outgoing side replays — sixty-eight seconds on
 * Planet of the Eyes, six battles, two hundred and eighty ticks — read from the
 * other direction.
 *
 * It is worth its own replay for a reason the unit tests cannot cover: the two
 * halves are measuring opposite ends of the same ticks, and the arithmetic that
 * makes one of them right can quietly break the other.
 *
 * ## Do not derive anything from this fixture
 *
 * `combat-run.json` was **hand-trimmed to five fields per monster** when it was
 * made. That is fine for the outgoing side, which reads exactly those fields,
 * and it is a trap for the incoming one: a rung of the attacker ladder was once
 * derived from "these monsters are unchanged", which was true only because the
 * trimming had removed everything that changes. Against a real payload it fired
 * never and a whole session went to Unknown Enemy.
 *
 * `damage-taken.dungeon.test.js` replays a recording with every field intact,
 * and that is the one to reason from. This one checks the arithmetic still holds
 * on a thinner payload, which is worth knowing and is all it is worth.
 */

import { describe, test, expect } from 'vitest';
import { newTakenState, attributeIncoming, foldTaken, foldTakenByEnemy, waveKey } from './damage-taken.js';
import recording from './__fixtures__/combat-run.json';

/**
 * The run, as the tracker would tally it.
 *
 * A copy of the tracker's loop rather than an import of it: the tracker is wired
 * to a websocket, and what is under test is the arithmetic and the order it
 * happens in.
 *
 * @returns {{players: Object, enemies: Object, waves: Object}}
 */
function replay() {
    let state = newTakenState();
    const players = {};
    const enemies = {};
    const waves = {};
    let monsters = {};
    let currentWave = null;

    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') {
            // Rebuilt rather than merged: slot 0 is an Eye in one battle and an
            // Eyes in the next
            monsters = {};
            for (const [index, monster] of Object.entries(tick.payload.monsters || {})) {
                if (monster?.name) monsters[index] = monster.name;
            }
            currentWave = waveKey(tick.payload.monsters, (monster) => monster?.name);
            waves[currentWave] ||= { encounters: 0, damage: 0 };
            waves[currentWave].encounters += 1;

            state = newTakenState();
            continue;
        }

        const events = attributeIncoming(tick.payload, state);
        const thisBattle = monsters;
        foldTaken(players, events);
        foldTakenByEnemy(enemies, events, (index) => thisBattle[index] || null);

        // A recording can begin mid-battle, so there are ticks before the first
        // `new_battle` and no wave to file them under. The tracker guards the
        // same way; without it this threw on the recording's very first tick.
        const wave = currentWave === null ? null : waves[currentWave];
        if (wave) {
            for (const event of events) {
                if (!event.isDeath && !event.isRegen && !event.isMiss) wave.damage += event.damage;
            }
        }
    }

    return { players, enemies, waves };
}

describe('a recorded run, from the receiving end', () => {
    const { players, enemies, waves } = replay();
    const player = players['0'];

    test('the character who fought it is the one who was hit', () => {
        expect(Object.keys(players)).toEqual(['0']);
        expect(player.hits).toBeGreaterThan(0);
    });

    test('damage taken and healed are both real figures', () => {
        // Sixty-eight seconds of a zone being farmed comfortably: both sides
        // move, and a run where one of them is zero means a diff went missing
        expect(player.damage).toBeGreaterThan(0);
        expect(player.regen).toBeGreaterThan(0);
    });

    test('nobody died, which is what the recording shows', () => {
        expect(player.deaths).toBe(0);
    });

    test('the monsters of the zone are named', () => {
        // Not `['Unknown Enemy']`, which is what a broken monster map produces
        // and which still adds up to the right total
        expect(Object.keys(enemies).length).toBeGreaterThan(0);
        expect(Object.keys(enemies).some((name) => name !== 'Unknown Enemy')).toBe(true);
    });

    test('the enemy breakdown adds up to what was taken', () => {
        const summed = Object.values(enemies).reduce((total, enemy) => total + enemy.damage, 0);
        expect(summed).toBe(player.damage);
    });

    test('the breakdown by wave accounts for everything after the first battle began', () => {
        // The recording starts mid-fight, so its first tick lands before any
        // `new_battle` and there is no wave to file it under. Sixty-eight points
        // of the seven hundred and three, and the same sixty-eight that show up
        // as Unknown Enemy — the two gaps are one gap, which is what says the
        // shortfall is the recording's beginning rather than a lost diff.
        const summed = Object.values(waves).reduce((total, wave) => total + wave.damage, 0);

        expect(summed).toBe(player.damage - enemies['Unknown Enemy'].damage);
    });

    test('every hit sits inside the range reported for it', () => {
        for (const enemy of Object.values(enemies)) {
            expect(enemy.min).toBeLessThanOrEqual(enemy.max);
            expect(enemy.max).toBeLessThanOrEqual(player.damage);
        }
    });

    test('the waves are the compositions the zone actually spawns', () => {
        // Six battles, six different compositions of Eye, Eyes and Veyes — this
        // zone genuinely does not repeat itself in sixty-eight seconds. What is
        // checked is that every key is the sorted-and-counted form, so a
        // composition met again would land on the key already here rather than
        // on a seventh one that follows spawn order.
        const keys = Object.keys(waves);

        expect(keys).toContain('Eye x3');
        expect(keys).toContain('Eye + Eyes + Veyes');
        for (const key of keys) {
            expect(key).not.toContain('Unknown');
            expect(key.split(' + ')).toEqual([...key.split(' + ')].sort());
        }
    });
});
