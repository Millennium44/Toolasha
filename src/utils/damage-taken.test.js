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
    findAttackers,
    attributeIncoming,
    foldTaken,
    foldTakenByEnemy,
    resolveName,
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

        expect(events).toEqual([{ playerIndex: '0', monsters: [], damage: 80, isMiss: false }]);
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

    test('a hit landing the same tick as a larger heal is a hit, not a miss, and the heal still counts', () => {
        // The counter rose, so it was not a miss — a miss is health unchanged
        // with the counter up, not health unchanged (or up) for any reason. The
        // health delta cannot say how much of the swing landed once a bigger
        // heal is folded into the same tick, so the hit is filed at zero
        // damage rather than invented, and the net rise is still banked as
        // regen so total sustain (taken vs. healed) stays honest.
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 400, dmg: 3 } }), state);
        const events = attributeIncoming(tick({ 0: { hp: 460, dmg: 4 } }), state);

        expect(events).toEqual([
            { playerIndex: '0', monsters: [], damage: 0, isMiss: false },
            { playerIndex: '0', damage: 60, isRegen: true },
        ]);
    });

    test('staying dead is not another death', () => {
        const state = newTakenState();
        attributeIncoming(tick({ 0: { hp: 40, dmg: 3 } }), state);
        attributeIncoming(tick({ 0: { hp: 0, dmg: 3 } }), state);

        expect(attributeIncoming(tick({ 0: { hp: 0, dmg: 3 } }), state)).toEqual([]);
    });
});

describe('which monster did it', () => {
    /**
     * Show a monster to the state so later ticks have something to compare with.
     * @param {Object} state - From `newTakenState`
     * @param {Object} mMap - Monsters
     */
    function seed(state, mMap) {
        findAttackers(mMap, state);
    }

    test('a monster in the delta with nothing changed is the one that swung', () => {
        // The finding that rebuilt this: `mMap` carries the units the server
        // touched, and across a recorded run every single tick the character was
        // hit held exactly one monster whose fields had not moved at all
        const state = newTakenState();
        seed(state, { 0: { cHP: 500, cMP: 100, dmgCounter: 5 }, 1: { cHP: 400, cMP: 100, dmgCounter: 5 } });

        expect(findAttackers({ 1: { cHP: 400, cMP: 100, dmgCounter: 5 } }, state)).toEqual(['1']);
    });

    test('a monster whose mana fell cast, and outranks the rest', () => {
        const state = newTakenState();
        seed(state, { 0: { cHP: 500, cMP: 100, dmgCounter: 5 }, 1: { cHP: 400, cMP: 100, dmgCounter: 5 } });

        const attackers = findAttackers(
            { 0: { cHP: 500, cMP: 60, dmgCounter: 5 }, 1: { cHP: 400, cMP: 100, dmgCounter: 5 } },
            state
        );
        expect(attackers).toEqual(['0']);
    });

    test('two that both swung are both candidates', () => {
        // Rather than one of them arbitrarily: their names may agree, and if
        // they do the ambiguity is not one a reader cares about
        const state = newTakenState();
        seed(state, { 0: { cHP: 500, cMP: 100, dmgCounter: 5 }, 1: { cHP: 400, cMP: 100, dmgCounter: 5 } });

        const attackers = findAttackers(
            { 0: { cHP: 500, cMP: 100, dmgCounter: 5 }, 1: { cHP: 400, cMP: 100, dmgCounter: 5 } },
            state
        );
        expect(attackers).toEqual(['0', '1']);
    });

    test('the monster you hit is not the monster that hit you', () => {
        // Its `dmgCounter` rose, which says it took a hit. That is evidence
        // about your target and not about theirs, so it ranks below everything.
        const state = newTakenState();
        seed(state, { 0: { cHP: 500, cMP: 100, dmgCounter: 5 }, 1: { cHP: 400, cMP: 100, dmgCounter: 5 } });

        const attackers = findAttackers(
            { 0: { cHP: 300, cMP: 100, dmgCounter: 6 }, 1: { cHP: 400, cMP: 100, dmgCounter: 5 } },
            state
        );
        expect(attackers).toEqual(['1']);
    });

    test('failing everything else, the monster that was itself hit', () => {
        // MCS's proxy, kept as the last rung so a wave still attributes rather
        // than filing everything under Unknown
        const state = newTakenState();
        seed(state, { 0: { cHP: 500, cMP: 100, dmgCounter: 5 } });

        expect(findAttackers({ 0: { cHP: 300, cMP: 100, dmgCounter: 6 } }, state)).toEqual(['0']);
    });

    test('an empty delta names nobody', () => {
        // Nothing acted that the server saw fit to mention
        expect(findAttackers({}, newTakenState())).toEqual([]);
    });

    test('an attack counter that rose outranks everything else', () => {
        // What the name says: it goes up when that monster attacks. On a
        // recorded dungeon it identified the attacker on thirty-two of the
        // thirty-eight ticks the character was hit.
        const state = newTakenState();
        seed(state, {
            0: { cHP: 500, cMP: 100, atkCounter: 4, dmgCounter: 5 },
            1: { cHP: 400, cMP: 100, atkCounter: 9, dmgCounter: 5 },
        });

        const attackers = findAttackers(
            {
                0: { cHP: 300, cMP: 60, atkCounter: 4, dmgCounter: 6 },
                1: { cHP: 400, cMP: 100, atkCounter: 10, dmgCounter: 5 },
            },
            state
        );
        expect(attackers).toEqual(['1']);
    });

    test("a monster's first appearance counts only when it is the whole tick", () => {
        // There is no baseline to compare against, so all that is known is that
        // the server mentioned it — worth something only if it mentioned nothing
        // else, which is what the other six of those thirty-eight ticks were
        expect(findAttackers({ 0: { cHP: 500, cMP: 100, atkCounter: 4 } }, newTakenState())).toEqual(['0']);
    });

    test('and not when something else in the tick has a better claim', () => {
        const state = newTakenState();
        seed(state, { 0: { cHP: 500, cMP: 100, atkCounter: 4 } });

        const attackers = findAttackers(
            { 0: { cHP: 500, cMP: 100, atkCounter: 5 }, 1: { cHP: 400, cMP: 100, atkCounter: 2 } },
            state
        );
        expect(attackers).toEqual(['0']);
    });
});

describe('naming a hit from its candidates', () => {
    test('one candidate is its name', () => {
        expect(resolveName(['0'], () => 'Veyes')).toBe('Veyes');
    });

    test('two of the same kind are not ambiguous', () => {
        // "An Eyes hit you for 41" is true whichever of the two it was
        expect(resolveName(['0', '1'], () => 'Eyes')).toBe('Eyes');
    });

    test('candidates that disagree are unknown', () => {
        // A wrong name here would move damage from one monster of a wave onto
        // another and then be read as evidence about which is dangerous
        expect(resolveName(['0', '1'], (index) => (index === '0' ? 'Eye' : 'Eyes'))).toBe('Unknown Enemy');
    });

    test('a candidate the battle cannot name makes the whole hit unknown', () => {
        expect(resolveName(['0', '1'], (index) => (index === '0' ? 'Eye' : null))).toBe('Unknown Enemy');
    });

    test('no candidates at all is unknown', () => {
        expect(resolveName([], () => 'Eye')).toBe('Unknown Enemy');
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
                { playerIndex: '0', monsters: ['0'], damage: 66 },
                { playerIndex: '0', monsters: ['0'], damage: 88 },
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
                { playerIndex: '0', monsters: ['0'], damage: 66 },
                { playerIndex: '1', monsters: ['0'], damage: 12 },
            ],
            () => 'Veyes'
        );

        expect(tally.Veyes.byPlayer['1']).toMatchObject({ damage: 12, min: 12, max: 12 });
    });

    test('an unidentified attacker is named as unknown, not dropped', () => {
        // Dropping it would make the enemy totals disagree with the party total
        const tally = {};
        foldTakenByEnemy(tally, [{ playerIndex: '0', monsters: [], damage: 8 }], () => null);

        expect(tally['Unknown Enemy'].damage).toBe(8);
    });

    test('a monster index the battle no longer knows is unknown too', () => {
        const tally = {};
        foldTakenByEnemy(tally, [{ playerIndex: '0', monsters: ['7'], damage: 8 }], () => null);

        expect(tally['Unknown Enemy'].damage).toBe(8);
    });

    test('misses and regen never reach the enemy tally', () => {
        const tally = {};
        foldTakenByEnemy(
            tally,
            [
                { playerIndex: '0', monsters: ['0'], damage: 0, isMiss: true },
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
