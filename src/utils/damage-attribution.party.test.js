/**
 * Outgoing attribution with somebody else in the party.
 *
 * Every recording available is solo, and solo hides the bug this covers: when
 * there is one player, `findCaster` credits them directly whatever the payload
 * says. The moment there are two, that fallback stops applying and the caster
 * has to be identified for real.
 *
 * It used to be identified by mana — only the casting player's `cMP` falls — and
 * that is true and nearly useless, because an auto-attack costs nothing. Across
 * two recorded runs mana moved on eight of the sixty-nine ticks that dealt
 * damage. The other sixty-one named nobody, and a hit with no caster is dropped.
 *
 * So the recordings are replayed twice: once as they were, and once with a
 * second party member spliced in who never does anything. The totals have to
 * match. Anything the second player's presence costs is damage the panel would
 * have silently lost in a real party.
 */

import { describe, test, expect } from 'vitest';
import { newAttributionState, noteActions, attributeTick, foldEvents } from './damage-attribution.js';
import refresh from './__fixtures__/combat-refresh.json';
import dungeon from './__fixtures__/combat-dungeon.json';
import trimmed from './__fixtures__/combat-run.json';

/** A party member who stands there: no attacks, no mana spent, no damage taken */
const BYSTANDER = { cHP: 1000, cMP: 500, atkCounter: 7, dmgCounter: 0, critCounter: 0, isAutoAtk: true };

/**
 * What a recording attributes, optionally with a bystander in the party.
 *
 * @param {Object} recording - A fixture
 * @param {boolean} withBystander - Whether to splice in a second player
 * @returns {number} Total damage credited to somebody
 */
function attributed(recording, withBystander) {
    const state = newAttributionState();
    const tally = {};

    for (const entry of recording.ticks) {
        if (entry.type === 'new_battle') {
            noteActions(state, entry.payload.players);
            state.monstersHP = {};
            state.dmgCounter = {};
            state.critCounter = {};
            continue;
        }

        const pMap = { ...entry.payload.pMap };
        if (withBystander) pMap['1'] = BYSTANDER;

        foldEvents(tally, attributeTick({ pMap, mMap: entry.payload.mMap }, state), {
            filterNonDamaging: true,
            nameOf: () => 'monster',
        });
        noteActions(state, pMap);
    }

    return Object.values(tally).reduce((total, player) => total + player.damage, 0);
}

describe('a second person in the party', () => {
    for (const [name, recording] of [
        ['a refreshed session', refresh],
        ['a dungeon', dungeon],
    ]) {
        test(`costs nothing on ${name}`, () => {
            // The attack counter names the actor whether or not anybody else is
            // stood next to them, which is the whole point of using it
            const solo = attributed(recording, false);

            expect(solo).toBeGreaterThan(0);
            expect(attributed(recording, true)).toBe(solo);
        });
    }

    test('and would have cost almost everything on a payload with no attack counter', () => {
        // `combat-run.json` is hand-trimmed and carries no `atkCounter`, so this
        // replays the old behaviour: mana is the only signal, an auto-attack
        // spends none, and four fifths of the run belongs to nobody. That is
        // what a real party used to look like.
        const solo = attributed(trimmed, false);
        const party = attributed(trimmed, true);

        expect(party).toBeLessThan(solo / 4);
    });
});
