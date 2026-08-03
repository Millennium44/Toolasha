/**
 * Incoming damage, from a payload that attributes nothing.
 *
 * The cases worth a test are the ones a health diff gets wrong: regeneration is
 * not a negative hit, a miss is a hit for nothing rather than a non-event, the
 * first sight of a player is not a full-health blow, and which monster did it is
 * a ladder of decreasing confidence that has to fall off the end into "unknown"
 * rather than into whichever monster happened to be first.
 */

import { describe, test, expect } from 'vitest';
import {
    newTakenState,
    findAttacker,
    attributeIncoming,
    foldTaken,
    foldTakenByEnemy,
    waveKey,
} from './damage-taken.js';

/**
 * A tick, from the parts that matter.
 * @param {Object} players - Index → {hp, dmg}
 * @param {Object} monsters - Index → {mp, dmg}
 * @returns {Object}
 */
function tick(players, monsters = {}) {
    const pMap = {};
    for (const [index, p] of Object.entries(players)) pMap[index] = { cHP: p.hp, dmgCounter: p.dmg ?? 0 };

    const mMap = {};
    for (const [index, m] of Object.entries(monsters)) mMap[index] = { cMP: m.mp ?? 100, dmgCounter: m.dmg ?? 0 };

    return { pMap, mMap };
}

describe('what counts as being hit', () => {
    test('the first sight of a player produces nothing', () => {
        // There is no previous reading to diff against, and treating full health
        // as the baseline would invent one enormous blow per battle
        const state = newTakenState();
        expect(attributeIncoming(tick({ 0: { hp: 500, dmg: 3 } }), state)).toEqual([]);
    });

    test('health falling with the counter up is a hit', () => {
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 500, dmg: 3 } }), state);
        const events = attributeIncoming(tick({ 0: { hp: 420, dmg: 4 } }), state);

        expect(events).toEqual([{ playerIndex: '0', monsterIndex: null, damage: 80, isMiss: false }]);
    });

    test('the counter up with health unchanged is a miss', () => {
        // The one event a health diff cannot express, and the reason the counter
        // is what a hit is measured by
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 500, dmg: 3 } }), state);
        const events = attributeIncoming(tick({ 0: { hp: 500, dmg: 4 } }), state);

        expect(events[0].isMiss).toBe(true);
    });

    test('health falling with the counter still is not a hit', () => {
        // A bleed, and crediting it to whatever monster is standing there would
        // make a wave look more dangerous than it is
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 500, dmg: 3 } }), state);

        expect(attributeIncoming(tick({ 0: { hp: 480, dmg: 3 } }), state)).toEqual([]);
    });

    test('health rising is regeneration, not a negative hit', () => {
        // "Took 3,400 and healed 3,600" is what says whether a zone is
        // survivable; a net figure of −200 says nothing at all
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 400, dmg: 3 } }), state);
        const events = attributeIncoming(tick({ 0: { hp: 460, dmg: 3 } }), state);

        expect(events).toEqual([{ playerIndex: '0', damage: 60, isRegen: true }]);
    });

    test('crossing to zero is a death, whatever caused it', () => {
        // Its own event rather than a field on a hit, so a death from a bleed
        // still counts — the counter does not rise for one
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 40, dmg: 3 } }), state);
        const events = attributeIncoming(tick({ 0: { hp: 0, dmg: 3 } }), state);

        expect(events).toEqual([{ playerIndex: '0', isDeath: true }]);
    });

    test('staying dead is not another death', () => {
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 40, dmg: 3 } }), state);
        attributeIncoming(tick({ 0: { hp: 0, dmg: 3 } }), state);

        expect(attributeIncoming(tick({ 0: { hp: 0, dmg: 3 } }), state)).toEqual([]);
    });
});

describe('which monster did it', () => {
    test('a monster whose mana fell cast, and is the attacker', () => {
        const state = newTakenState();
        findAttacker({ 0: { cMP: 100, dmgCounter: 0 }, 1: { cMP: 100, dmgCounter: 0 } }, state);

        expect(findAttacker({ 0: { cMP: 100, dmgCounter: 0 }, 1: { cMP: 60, dmgCounter: 0 } }, state)).toBe('1');
    });

    test('one monster needs no working out', () => {
        // Which is the case that matters: an auto-attack spends no mana, and
        // most of what hits you is auto-attacks
        const state = newTakenState();
        findAttacker({ 0: { cMP: 100, dmgCounter: 0 } }, state);

        expect(findAttacker({ 0: { cMP: 100, dmgCounter: 0 } }, state)).toBe('0');
    });

    test('failing that, the monster that was itself hit', () => {
        // A proxy, and a weak one — being hit is not attacking. Kept because it
        // is the rung IHurt uses, and a panel modelled on it should agree.
        const state = newTakenState();
        findAttacker({ 0: { cMP: 100, dmgCounter: 5 }, 1: { cMP: 100, dmgCounter: 5 } }, state);

        expect(findAttacker({ 0: { cMP: 100, dmgCounter: 5 }, 1: { cMP: 100, dmgCounter: 6 } }, state)).toBe('1');
    });

    test('a cast outranks having been hit', () => {
        const state = newTakenState();
        findAttacker({ 0: { cMP: 100, dmgCounter: 5 }, 1: { cMP: 100, dmgCounter: 5 } }, state);

        expect(findAttacker({ 0: { cMP: 40, dmgCounter: 5 }, 1: { cMP: 100, dmgCounter: 6 } }, state)).toBe('0');
    });

    test('nothing identifying one credits nobody', () => {
        // Rather than the first monster in the list, which would be a claim
        const state = newTakenState();
        findAttacker({ 0: { cMP: 100, dmgCounter: 5 }, 1: { cMP: 100, dmgCounter: 5 } }, state);

        expect(findAttacker({ 0: { cMP: 100, dmgCounter: 5 }, 1: { cMP: 100, dmgCounter: 5 } }, state)).toBeNull();
    });
});

describe('folding a run together', () => {
    test('hits, misses, regen and deaths are kept apart', () => {
        const tally = {};
        foldTaken(tally, [
            { playerIndex: '0', damage: 80, isMiss: false },
            { playerIndex: '0', damage: 0, isMiss: true },
            { playerIndex: '0', damage: 60, isRegen: true },
            { playerIndex: '0', isDeath: true },
        ]);

        expect(tally['0']).toEqual({ damage: 80, regen: 60, hits: 1, misses: 1, deaths: 1 });
    });

    test('an enemy carries the range of what it hits for', () => {
        // An average of forty with a maximum of two hundred is a zone that kills
        // you, and the average alone says it is comfortable
        const tally = {};
        foldTakenByEnemy(
            tally,
            [
                { playerIndex: '0', monsterIndex: '0', damage: 66 },
                { playerIndex: '0', monsterIndex: '0', damage: 88 },
            ],
            () => 'Veyes'
        );

        expect(tally.Veyes).toMatchObject({ damage: 154, hits: 2, min: 66, max: 88 });
    });

    test('and the same range per player', () => {
        const tally = {};
        foldTakenByEnemy(
            tally,
            [
                { playerIndex: '0', monsterIndex: '0', damage: 66 },
                { playerIndex: '1', monsterIndex: '0', damage: 12 },
            ],
            () => 'Veyes'
        );

        expect(tally.Veyes.byPlayer['1']).toMatchObject({ damage: 12, min: 12, max: 12 });
    });

    test('an unidentified attacker is named as unknown, not dropped', () => {
        // Dropping it would make the enemy totals disagree with the party total
        const tally = {};
        foldTakenByEnemy(tally, [{ playerIndex: '0', monsterIndex: null, damage: 8 }], () => null);

        expect(tally['Unknown Enemy'].damage).toBe(8);
    });

    test('a monster index the battle no longer knows is unknown too', () => {
        const tally = {};
        foldTakenByEnemy(tally, [{ playerIndex: '0', monsterIndex: '7', damage: 8 }], () => null);

        expect(tally['Unknown Enemy'].damage).toBe(8);
    });

    test('misses and regen never reach the enemy tally', () => {
        const tally = {};
        foldTakenByEnemy(
            tally,
            [
                { playerIndex: '0', monsterIndex: '0', damage: 0, isMiss: true },
                { playerIndex: '0', damage: 60, isRegen: true },
            ],
            () => 'Veyes'
        );

        expect(tally).toEqual({});
    });
});

describe('naming a wave', () => {
    test('the same monsters in a different order are the same wave', () => {
        // The game hands them over in whatever order it likes, and a key that
        // followed it would file one wave under six names and never average
        const nameOf = (m) => m.name;
        const a = waveKey([{ name: 'Eye' }, { name: 'Veyes' }, { name: 'Eye' }], nameOf);
        const b = waveKey([{ name: 'Veyes' }, { name: 'Eye' }, { name: 'Eye' }], nameOf);

        expect(a).toBe(b);
        expect(a).toBe('Eye x2 + Veyes');
    });

    test('one of a kind is not counted', () => {
        expect(waveKey([{ name: 'Veyes' }], (m) => m.name)).toBe('Veyes');
    });

    test('a monster with no name still makes a key', () => {
        expect(waveKey([{}], () => null)).toBe('Unknown');
    });
});
