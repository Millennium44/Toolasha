import { describe, test, expect } from 'vitest';
import { newManaTally, recordCast, recordFight, manaSummary } from './mana-spend.js';

describe('recording casts', () => {
    test('counts casts and multiplies out the mana', () => {
        const tally = newManaTally();
        recordCast(tally, '/abilities/poke', 30);
        recordCast(tally, '/abilities/poke', 30);

        expect(tally.byAbility['/abilities/poke']).toEqual({
            abilityHrid: '/abilities/poke',
            casts: 2,
            mana: 60,
            unknownCost: false,
        });
    });

    test('a cast with no known cost is still a cast, and says so', () => {
        // A total quietly missing an ability reads as a measurement rather than
        // as a gap
        const tally = newManaTally();
        recordCast(tally, '/abilities/mystery', null);

        expect(tally.byAbility['/abilities/mystery'].casts).toBe(1);
        expect(tally.byAbility['/abilities/mystery'].mana).toBe(0);
        expect(manaSummary(tally).incomplete).toBe(true);
    });

    test('a cast with no ability is not a cast', () => {
        expect(newManaTally()).toEqual(recordCast(newManaTally(), null, 30));
    });
});

describe('manaSummary', () => {
    function session() {
        const tally = newManaTally();
        recordFight(tally);
        recordCast(tally, '/abilities/poke', 30);
        recordCast(tally, '/abilities/smack', 100);
        recordFight(tally);
        recordCast(tally, '/abilities/poke', 30);
        return tally;
    }

    test('per fight is the comparable figure', () => {
        // A total only says how long you have been playing
        const summary = manaSummary(session());
        expect(summary.fights).toBe(2);
        expect(summary.mana).toBe(160);
        expect(summary.manaPerFight).toBe(80);
        expect(summary.castsPerFight).toBe(1.5);
    });

    test('with no fights there is no per-fight rate, rather than the total', () => {
        const tally = newManaTally();
        recordCast(tally, '/abilities/poke', 30);

        const summary = manaSummary(tally);
        expect(summary.mana).toBe(30);
        expect(summary.manaPerFight).toBeNull();
    });

    test('the biggest spender comes first', () => {
        expect(manaSummary(session()).abilities[0].abilityHrid).toBe('/abilities/smack');
    });

    test('a complete tally does not claim to be incomplete', () => {
        expect(manaSummary(session()).incomplete).toBe(false);
    });

    test('an empty tally is zeroes rather than nothing', () => {
        expect(manaSummary(newManaTally())).toEqual({
            fights: 0,
            casts: 0,
            mana: 0,
            manaPerFight: null,
            castsPerFight: null,
            incomplete: false,
            abilities: [],
        });
    });
});
