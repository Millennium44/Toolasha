/**
 * Attribution with five people fighting.
 *
 * Two characters was enough to show that `pMap` is a delta and that the old
 * mana rule was not, in fact, losing anything. Five is enough to show what it
 * *was* losing, which two could not: with one person tanking and four hitting,
 * the character the tick is about is very often the one being hit.
 *
 * Two minutes, seven battles, four hundred and forty ticks that dealt damage.
 * The names are replaced with Player One through Player Five.
 *
 * ## What it caught
 *
 * The bottom rung used to be "only one character in this tick, so it was them".
 * On eighty-two of those four hundred and forty ticks the single character in
 * the tick was there because their **own** health and damage counter had moved —
 * they had been hit. They had not attacked, and crediting them handed eight and
 * a half thousand points of somebody else's damage to whoever was tanking.
 *
 * The rung is now "the last character to swing". Of those eighty-two ticks,
 * seventy-six had a swing by somebody else two ticks earlier — and two ticks is
 * one tick, because **every payload arrives twice**: 757 of the 1,465
 * `battle_updated` messages here are byte-identical to the one before. A swing
 * and the damage it does are simply not always in the same tick.
 */

import { describe, test, expect } from 'vitest';
import { newAttributionState, noteActions, attributeTick, foldEvents } from './damage-attribution.js';
import recording from './__fixtures__/combat-five.json';

/**
 * The run, as the tracker would tally it.
 *
 * @param {boolean} creditWhoeverIsAlone - Whether to use the old bottom rung,
 *   which credited the only character in the tick
 * @returns {{dealt: Object, names: Object, dropped: number, seen: number}}
 */
function replay(creditWhoeverIsAlone = false) {
    const state = newAttributionState();
    const dealt = {};
    const names = {};
    let monsters = {};
    let dropped = 0;
    let seen = 0;

    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') {
            noteActions(state, tick.payload.players);
            tick.payload.players.forEach((player, index) => (names[index] = player.name));
            monsters = Object.fromEntries(tick.payload.monsters.map((monster, index) => [index, monster.name]));

            state.monstersHP = {};
            state.dmgCounter = {};
            state.critCounter = {};
            continue;
        }

        const battle = { ...monsters };
        const before = { ...state.playersAtk };
        const events = attributeTick(tick.payload, state);

        // The old rung, reconstructed: nobody named, one character in the tick
        const alone = Object.keys(tick.payload.pMap || {});
        const nobodySwung = alone.every((index) => tick.payload.pMap[index]?.atkCounter === before[index]);

        for (const event of events) {
            if (event.isKill || event.isMiss || event.isHeal) continue;
            seen += event.amount || 0;

            if (event.playerIndex !== null && event.playerIndex !== undefined) continue;
            if (creditWhoeverIsAlone && alone.length === 1 && nobodySwung) continue;
            dropped += event.amount || 0;
        }

        foldEvents(dealt, events, { filterNonDamaging: true, nameOf: (index) => battle[index] || null });
        noteActions(state, tick.payload.pMap);
    }

    return { dealt, names, dropped, seen };
}

const { dealt, names, dropped, seen } = replay();

describe('five people fighting', () => {
    test('the recording really is a party of five, and all of them fought', () => {
        expect(Object.values(names)).toHaveLength(5);
        expect(Object.keys(dealt)).toHaveLength(5);

        for (const player of Object.values(dealt)) expect(player.damage).toBeGreaterThan(0);
    });

    test('every point of damage is credited to somebody', () => {
        expect(seen).toBeGreaterThan(100_000);
        expect(dropped).toBe(0);
    });

    test('no single character is credited with most of the party', () => {
        // The shape of the bug that was here: whoever tanks collects everybody
        // else's damage, because they are the one the tick keeps being about
        const total = Object.values(dealt).reduce((sum, player) => sum + player.damage, 0);
        const biggest = Math.max(...Object.values(dealt).map((player) => player.damage));

        expect(biggest / total).toBeLessThan(0.5);
    });
});

describe('the tick a swing lands on', () => {
    test('every payload arrives twice', () => {
        // Which is why the swing that caused a hit is "two ticks" earlier: two
        // recorded ticks are one real one
        const ticks = recording.ticks.filter((tick) => tick.type !== 'new_battle');
        const duplicates = ticks.filter(
            (tick, index) => index > 0 && JSON.stringify(tick.payload) === JSON.stringify(ticks[index - 1].payload)
        );

        expect(duplicates.length).toBeGreaterThan(ticks.length / 3);
    });

    test('two characters rarely swing on the same tick, but it happens', () => {
        // Three times in fourteen hundred ticks, and one of those three also
        // dealt damage. Rare enough that the counter is a usable identifier and
        // not so rare that the ambiguous case can be pretended away — it falls
        // to mana, and failing that to whoever swung last.
        const state = newAttributionState();
        let both = 0;

        for (const tick of recording.ticks) {
            if (tick.type === 'new_battle') continue;

            const before = { ...state.playersAtk };
            const rose = Object.entries(tick.payload.pMap || {}).filter(
                ([index, player]) => before[index] !== undefined && player.atkCounter > before[index]
            );
            if (rose.length > 1) both += 1;
            attributeTick(tick.payload, state);
        }

        const ticks = recording.ticks.filter((tick) => tick.type !== 'new_battle').length;
        expect(both).toBeGreaterThan(0);
        expect(both / ticks).toBeLessThan(0.01);
    });

    test('the counter is in the fixture, so this is testing the counter', () => {
        const players = recording.ticks
            .filter((tick) => tick.type !== 'new_battle')
            .flatMap((tick) => Object.values(tick.payload.pMap || {}));

        expect(players.every((player) => Number.isFinite(player.atkCounter))).toBe(true);
    });
});
