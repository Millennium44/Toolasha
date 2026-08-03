/**
 * Attribution with two people fighting.
 *
 * Every other recording is solo, and solo cannot exercise the question this
 * module exists to answer: when a monster loses health, which of the party did
 * it. `combat-party.json` is two minutes of two characters, twelve battles,
 * a hundred and thirty-seven ticks that dealt damage. The names in it are
 * replaced with Player One and Player Two.
 *
 * ## It corrected a claim rather than confirming one
 *
 * Before this recording existed, the party case was tested by splicing a second
 * player into every tick of a solo recording. That made `pMap` two entries wide
 * on every tick, and on that basis the old mana-only rule looked catastrophic —
 * four fifths of the run credited to nobody and dropped.
 *
 * A real party does not look like that. `pMap` is a delta, exactly as `mMap` is:
 * a player who did nothing is simply not in the tick. Across these hundred and
 * thirty-seven ticks, only eight carried both players, and the old rule and the
 * new one picked **the same** character on every single one of them.
 *
 * So `atkCounter` is not a rescue. It is a better-founded answer to the same
 * question: the actor is named because a counter of attacks went up, rather than
 * inferred from being the only one the server mentioned. That inference happens
 * to be right here, and nothing guarantees it stays right.
 */

import { describe, test, expect } from 'vitest';
import { newAttributionState, noteActions, attributeTick, foldEvents, findCaster } from './damage-attribution.js';
import { newTakenState, attributeIncoming, foldTaken, foldTakenByEnemy } from './damage-taken.js';
import recording from './__fixtures__/combat-party.json';

/**
 * The run, both directions at once, as the two trackers would tally it.
 * @returns {Object} What each side made of it
 */
function replay() {
    const outState = newAttributionState();
    let inState = newTakenState();
    const dealt = {};
    const taken = {};
    const enemies = {};
    const names = {};
    let monsters = {};

    for (const tick of recording.ticks) {
        if (tick.type === 'new_battle') {
            noteActions(outState, tick.payload.players);
            tick.payload.players.forEach((player, index) => (names[index] = player.name));

            // Rebuilt rather than emptied in place, since an index is a slot in
            // this battle and last battle's slot 0 was a different monster
            monsters = Object.fromEntries(tick.payload.monsters.map((monster, index) => [index, monster.name]));

            outState.monstersHP = {};
            outState.dmgCounter = {};
            outState.critCounter = {};
            inState = newTakenState();
            continue;
        }

        // Captured per tick: an index is a slot in this battle, so a closure over
        // the mutable map would name last battle's monsters
        const battle = { ...monsters };
        const nameOf = (index) => battle[index] || null;

        foldEvents(dealt, attributeTick(tick.payload, outState), { filterNonDamaging: true, nameOf });
        noteActions(outState, tick.payload.pMap);

        const incoming = attributeIncoming(tick.payload, inState);
        foldTaken(taken, incoming);
        foldTakenByEnemy(enemies, incoming, nameOf);
    }

    return { dealt, taken, enemies, names };
}

const { dealt, taken, enemies, names } = replay();

describe('two people fighting', () => {
    test('the recording really is a party, and both of them fought', () => {
        expect(Object.values(names)).toEqual(['Player One', 'Player Two']);
        expect(Object.keys(dealt).sort()).toEqual(['0', '1']);

        for (const player of Object.values(dealt)) expect(player.damage).toBeGreaterThan(0);
    });

    test('damage dealt is split between them rather than piled on one', () => {
        // Which is the failure a solo recording can never show: a rule that
        // always names the same person passes every solo test there is
        const [first, second] = Object.values(dealt).map((player) => player.damage);
        const share = Math.min(first, second) / (first + second);

        expect(share).toBeGreaterThan(0.2);
    });

    test('both of them are hit, and each keeps their own figures', () => {
        expect(Object.keys(taken).sort()).toEqual(['0', '1']);

        for (const player of Object.values(taken)) {
            expect(player.damage).toBeGreaterThan(0);
            expect(player.regen).toBeGreaterThan(0);
        }
    });

    test('every hit taken is attributed to a named monster', () => {
        expect(enemies['Unknown Enemy']).toBeUndefined();
        expect(Object.keys(enemies).length).toBeGreaterThan(5);
    });

    test('and the enemy breakdown adds up to what the party took', () => {
        const party = Object.values(taken).reduce((total, player) => total + player.damage, 0);
        const summed = Object.values(enemies).reduce((total, enemy) => total + enemy.damage, 0);

        expect(summed).toBe(party);
    });

    test('a monster that hit both of them says so', () => {
        // The per-player split inside an enemy card, which solo cannot produce
        const shared = Object.values(enemies).filter((enemy) => Object.keys(enemy.byPlayer).length > 1);
        expect(shared.length).toBeGreaterThan(0);
    });
});

describe('naming the character who acted', () => {
    test('the tick names one of them, not both', () => {
        // `pMap` is a delta like `mMap`: a player who did nothing is not in the
        // tick at all. Only eight of the hundred and thirty-seven damage ticks
        // carried both characters.
        const state = newAttributionState();
        const widths = { 1: 0, 2: 0 };

        for (const tick of recording.ticks) {
            if (tick.type === 'new_battle') continue;

            const width = Object.keys(tick.payload.pMap || {}).length;
            if (widths[width] !== undefined) widths[width] += 1;
            findCaster(tick.payload.pMap, state);
        }

        expect(widths[1]).toBeGreaterThan(widths[2] * 4);
    });

    test('the attack counter is there to name them with', () => {
        // A guard on the fixture. Trimmed away, every test above would still
        // pass by falling through to the weaker rule — which is exactly how an
        // earlier fixture misled this module.
        const players = recording.ticks
            .filter((tick) => tick.type !== 'new_battle')
            .flatMap((tick) => Object.values(tick.payload.pMap || {}));

        expect(players.every((player) => Number.isFinite(player.atkCounter))).toBe(true);
    });
});
