/**
 * A page refreshed in the middle of a fight.
 *
 * The one case no other recording covers, and the one that kept producing
 * "Unknown Enemy". Reload mid-battle and the client never receives the message
 * that names what it is fighting, so the names have to come off the screen —
 * and this recording carries the screen with it. The recorder snapshots the
 * battle panel on every tick until the first `new_battle`, so the replay below
 * feeds it exactly what the browser had.
 *
 * Sixty seconds, thirty-eight ticks before the first battle is announced, one
 * hit taken in that window.
 *
 * ## What it caught
 *
 * `mMap` is a delta, so a wave of two arrives across several ticks — monster 0
 * on the first, monster 1 two ticks later. The recovery only ran while the
 * monster map was empty, which meant the first monster to report got a name and
 * the second never did. One hit landed on the second, and that hit was the
 * Unknown Enemy in the panel.
 */

import { describe, test, expect } from 'vitest';
import { newTakenState, attributeIncoming, foldTaken, foldTakenByEnemy } from './damage-taken.js';
import { parseUnitTexts, matchMonsterNames } from './battle-panel-monsters.js';
import recording from './__fixtures__/combat-refresh.json';

/**
 * The run, as the tracker would tally it.
 *
 * @param {boolean} untilAnnounced - Whether to keep reading the panel until a
 *   battle is announced, or stop as soon as the map holds anything
 * @returns {{players: Object, enemies: Object, beforeAnnounced: number}}
 */
function replay(untilAnnounced) {
    let state = newTakenState();
    const players = {};
    const enemies = {};
    let monsters = {};
    let announced = false;
    let beforeAnnounced = 0;

    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') {
            announced = true;
            monsters = {};
            for (const [index, monster] of Object.entries(tick.payload.monsters || {})) {
                if (monster?.name) monsters[index] = monster.name;
            }
            state = newTakenState();
            continue;
        }
        if (!announced) beforeAnnounced += 1;

        const open = untilAnnounced ? !announced : !Object.keys(monsters).length;
        if (open && tick.panel?.tiles) {
            const units = tick.panel.tiles.map(parseUnitTexts).filter(Boolean);
            for (const [index, name] of Object.entries(matchMonsterNames(units, tick.payload.mMap))) {
                if (!monsters[index]) monsters[index] = name;
            }
        }

        const battle = monsters;
        const events = attributeIncoming(tick.payload, state);
        foldTaken(players, events);
        foldTakenByEnemy(enemies, events, (index) => battle[index] || null);
    }

    return { players, enemies, beforeAnnounced };
}

describe('a session that began mid-fight', () => {
    const { players, enemies, beforeAnnounced } = replay(true);

    test('the recording really does start before any battle is announced', () => {
        // Otherwise everything below would be testing the ordinary path
        expect(beforeAnnounced).toBeGreaterThan(30);
    });

    test('the battle panel is where the names come from, and it was readable', () => {
        // Selectors against the game's DOM are not a contract, and this is the
        // only evidence available that they still match
        const snapshot = recording.ticks.find((tick) => tick.panel)?.panel;

        expect(snapshot.area).toBe(true);
        expect(snapshot.grid).toBe(true);
        expect(parseUnitTexts(snapshot.tiles[0])).toMatchObject({ name: expect.any(String), hp: expect.any(Number) });
    });

    test('nothing is left as Unknown Enemy', () => {
        expect(enemies['Unknown Enemy']).toBeUndefined();
        expect(Object.keys(enemies).length).toBeGreaterThan(1);
    });

    test('the enemy breakdown adds up to what was taken', () => {
        const summed = Object.values(enemies).reduce((total, enemy) => total + enemy.damage, 0);
        expect(summed).toBe(players['0'].damage);
    });

    test('stopping the recovery once the map has anything in it loses a monster', () => {
        // `mMap` is a delta: the second monster of the wave does not appear for
        // another two ticks, and it is the one that landed the hit
        const early = replay(false);

        expect(early.enemies['Unknown Enemy']?.damage).toBe(19);
        expect(enemies.Eye.damage).toBe(early.enemies.Eye.damage + 19);
    });
});
