/**
 * Learn any ability / any special ability: the books to buy, skipping abilities already learned.
 */

import { describe, test, expect } from 'vitest';

import { resolveAchievement, readiness } from './achievement-finisher-resolve.js';
import { ABILITY_ACHIEVEMENTS as A, ABILITY_DATA as D } from './__fixtures__/achievement-finisher-abilities.js';

const any = A['/achievements/learn_ability'];
const special = A['/achievements/learn_special_ability'];
const levels = (map) => new Map(Object.entries(map).map(([skill, level]) => [`/skills/${skill}`, level]));
const PRICES = {
    '/items/poke': 9000,
    '/items/scratch': 4000,
    '/items/fireball': 1000,
    '/items/mystic_aura': 50_000_000,
    '/items/speed_aura': 20_000_000,
};
const ctx = (over = {}) => ({
    skillLevels: levels({ melee: 10, magic: 10, ranged: 60 }),
    combatLevel: 30,
    inventory: [],
    ironCow: false,
    buyPrice: (hrid) => PRICES[hrid] ?? null,
    learnedAbilities: new Set(['/abilities/poke']),
    ...over,
});
const inv = (itemHrid, count = 1, extra = {}) => ({
    itemHrid,
    count,
    itemLocationHrid: '/item_locations/inventory',
    enhancementLevel: 0,
    ...extra,
});

describe('learn an ability', () => {
    test('any ability: every book; special: only special abilities that have a book (no Promote)', () => {
        expect(resolveAchievement(any, D).candidates.map((c) => c.itemHrid)).toEqual([
            '/items/fireball',
            '/items/mystic_aura',
            '/items/poke',
            '/items/revive',
            '/items/scratch',
            '/items/speed_aura',
        ]);
        const res = resolveAchievement(special, D);
        expect(res).toMatchObject({ kind: 'ability', special: true });
        expect(res.candidates.map((c) => c.abilityHrid)).toEqual([
            '/abilities/mystic_aura',
            '/abilities/revive',
            '/abilities/speed_aura',
        ]);
    });

    test('special with no ability map cannot tell special from not: unresolved', () => {
        expect(resolveAchievement(special, { itemDetailMap: D.itemDetailMap })).toBeNull();
    });

    test('a learned ability is skipped; a level-met book beats a cheaper one whose level is not met', () => {
        const ready = readiness(resolveAchievement(any, D), ctx());
        // Fireball is cheapest but needs Magic 30; Poke is learned; Scratch is the cheapest met
        expect(ready).toMatchObject({ owned: false, buyHrid: '/items/scratch', cost: 4000, levelMet: true });
    });

    test('nothing met: the cheapest book is offered with its gate shown', () => {
        const ready = readiness(
            resolveAchievement(special, D),
            ctx({ skillLevels: levels({ magic: 1, ranged: 1 }), learnedAbilities: new Set(['/abilities/revive']) })
        );
        expect(ready).toMatchObject({ buyHrid: '/items/speed_aura', cost: 20_000_000, levelMet: false });
        expect(ready.level).toMatchObject({ skillHrid: '/skills/ranged', need: 50, have: 1 });
    });

    test('a book with no level requirement is met', () => {
        const ready = readiness(resolveAchievement(special, D), ctx());
        // Revive has no requirement and no price; Speed Aura is met and priced
        expect(ready.buyHrid).toBe('/items/speed_aura');
        const res = { ...resolveAchievement(special, D) };
        res.candidates = res.candidates.filter((c) => c.itemHrid === '/items/revive');
        expect(readiness(res, ctx({ inventory: [inv('/items/revive')] }))).toMatchObject({
            owned: true,
            ownedHrid: '/items/revive',
            levelMet: true,
        });
    });

    test('an owned book of an unlearned ability: owned, nothing to buy; a book of a learned one does not count', () => {
        const res = resolveAchievement(any, D);
        const owned = readiness(res, ctx({ inventory: [inv('/items/fireball', 3), inv('/items/poke')] }));
        expect(owned).toMatchObject({ owned: true, ownedHrid: '/items/fireball', buyHrid: null, levelMet: false });
        // A held met book wins over a held unmet one
        const both = readiness(res, ctx({ inventory: [inv('/items/fireball'), inv('/items/scratch')] }));
        expect(both.ownedHrid).toBe('/items/scratch');
        // Only Poke (learned) in the bag: buy something else
        expect(readiness(res, ctx({ inventory: [inv('/items/poke')] })).buyHrid).toBe('/items/scratch');
        // A copy outside the inventory is not a book to read
        const elsewhere = readiness(
            res,
            ctx({ inventory: [inv('/items/scratch', 1, { itemLocationHrid: '/item_locations/market' })] })
        );
        expect(elsewhere.owned).toBe(false);
    });

    test('every ability learned: done, nothing to buy', () => {
        const all = new Set(Object.keys(D.abilityDetailMap));
        expect(readiness(resolveAchievement(special, D), ctx({ learnedAbilities: all }))).toMatchObject({
            allLearned: true,
            owned: true,
            buyHrid: null,
        });
    });

    test('not loaded, unpriced and Iron Cow endings', () => {
        const res = resolveAchievement(any, D);
        expect(readiness(res, ctx({ learnedAbilities: null }))).toMatchObject({ abilitiesUnknown: true, owned: null });
        expect(readiness(res, ctx({ inventory: null }))).toMatchObject({ owned: null, buyHrid: null });
        const unpriced = readiness(res, ctx({ buyPrice: () => null }));
        expect(unpriced.buyHrid).toBeNull();
        expect(unpriced.cost).toBeNull();
        expect(unpriced.unpriced).toHaveLength(5);
        const cow = readiness(res, ctx({ ironCow: true }));
        expect(cow).toMatchObject({ owned: false, buyHrid: null, cost: null });
    });
});
