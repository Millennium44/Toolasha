/**
 * Tests for ability reconciliation.
 *
 * The shapes here are the ones the server actually sends: `abilities_updated`
 * carries an `endCharacterAbilities` array of changed rows only, where
 * `slotNumber > 0` is "equipped in that slot" and 0 is "no longer equipped".
 * Everything that can go stale in the equipped kit goes stale because one of
 * those two facts was mishandled, so each is checked directly.
 */

import { describe, test, expect } from 'vitest';

import {
    mergeOwnedAbilities,
    reconcileEquippedAbilities,
    applyAbilityProgress,
    equippedAbilitiesFromBattle,
    abilityKitsDiffer,
} from './character-abilities.js';

const kit = (...entries) => entries.map(([abilityHrid, slotNumber, level = 1]) => ({ abilityHrid, slotNumber, level }));

describe('the learned ability list', () => {
    test('upserts by hrid and keeps fields the update does not mention', () => {
        const owned = [{ abilityHrid: '/abilities/cleave', level: 5, experience: 1234 }];
        const merged = mergeOwnedAbilities(owned, [{ abilityHrid: '/abilities/cleave', level: 6 }]);

        expect(merged).toHaveLength(1);
        expect(merged[0]).toEqual({ abilityHrid: '/abilities/cleave', level: 6, experience: 1234 });
        // The caller's array is theirs
        expect(owned[0].level).toBe(5);
    });

    test('an ability learned mid-session is added', () => {
        const merged = mergeOwnedAbilities([], [{ abilityHrid: '/abilities/berserk', level: 1 }]);
        expect(merged).toHaveLength(1);
    });

    test('survives being handed nothing', () => {
        expect(mergeOwnedAbilities(null, null)).toEqual([]);
        expect(mergeOwnedAbilities(undefined, [{ level: 3 }])).toEqual([]);
    });
});

describe('the equipped kit', () => {
    test('a slotNumber of 0 unequips rather than being ignored', () => {
        const current = kit(['/abilities/cleave', 1], ['/abilities/toughness', 2]);
        const next = reconcileEquippedAbilities(current, [{ abilityHrid: '/abilities/cleave', slotNumber: 0 }]);

        expect(next.map((a) => a.abilityHrid)).toEqual(['/abilities/toughness']);
    });

    test('an ability moving into an occupied slot displaces what was there', () => {
        const current = kit(['/abilities/cleave', 1], ['/abilities/toughness', 2]);
        const next = reconcileEquippedAbilities(current, [
            { abilityHrid: '/abilities/smack', slotNumber: 2, level: 4 },
        ]);

        expect(next.map((a) => a.abilityHrid)).toEqual(['/abilities/cleave', '/abilities/smack']);
    });

    test('an ability already equipped is updated in place, not duplicated', () => {
        const current = kit(['/abilities/cleave', 1, 3]);
        const next = reconcileEquippedAbilities(current, [
            { abilityHrid: '/abilities/cleave', slotNumber: 1, level: 9 },
        ]);

        expect(next).toHaveLength(1);
        expect(next[0].level).toBe(9);
    });

    test('a row with no slot number never equips anything new', () => {
        const next = reconcileEquippedAbilities(kit(['/abilities/cleave', 1]), [
            { abilityHrid: '/abilities/fireball', experience: 500 },
        ]);

        expect(next.map((a) => a.abilityHrid)).toEqual(['/abilities/cleave']);
    });

    test('a fully numbered kit comes back in slot order', () => {
        const next = reconcileEquippedAbilities(
            [],
            [
                { abilityHrid: '/abilities/c', slotNumber: 3 },
                { abilityHrid: '/abilities/a', slotNumber: 1 },
                { abilityHrid: '/abilities/b', slotNumber: 2 },
            ]
        );

        expect(next.map((a) => a.abilityHrid)).toEqual(['/abilities/a', '/abilities/b', '/abilities/c']);
    });

    test('an unnumbered login kit keeps its order rather than being renumbered', () => {
        // init_character_data may not number the slots; inventing numbers for it
        // would risk the special ability being displaced by a normal one
        const current = [{ abilityHrid: '/abilities/aura' }, { abilityHrid: '/abilities/cleave' }];
        const next = reconcileEquippedAbilities(current, [
            { abilityHrid: '/abilities/cleave', slotNumber: 2, level: 7 },
        ]);

        expect(next.map((a) => a.abilityHrid)).toEqual(['/abilities/aura', '/abilities/cleave']);
        expect(next[1].level).toBe(7);
    });
});

describe('experience ticks', () => {
    test('update level and experience without touching the kit', () => {
        const current = kit(['/abilities/cleave', 1, 3], ['/abilities/toughness', 2, 3]);
        const next = applyAbilityProgress(current, [
            { abilityHrid: '/abilities/cleave', slotNumber: 0, level: 4, experience: 99 },
        ]);

        expect(next.map((a) => a.abilityHrid)).toEqual(['/abilities/cleave', '/abilities/toughness']);
        expect(next[0].level).toBe(4);
        expect(next[0].experience).toBe(99);
    });

    test('an ability not in the kit is ignored', () => {
        const next = applyAbilityProgress(kit(['/abilities/cleave', 1]), [
            { abilityHrid: '/abilities/fireball', level: 2 },
        ]);
        expect(next).toHaveLength(1);
    });
});

describe('the kit a battle reports', () => {
    const battle = {
        players: [
            { character: { id: 1, name: 'Me' }, combatDetails: { combatAbilities: kit(['/abilities/cleave', 1]) } },
            { character: { id: 2, name: 'Them' }, combatDetails: { combatAbilities: kit(['/abilities/smack', 1]) } },
        ],
    };

    test('is found by character id', () => {
        expect(equippedAbilitiesFromBattle(battle, { characterId: 2 })[0].abilityHrid).toBe('/abilities/smack');
    });

    test('is found by name when the id is not known', () => {
        expect(equippedAbilitiesFromBattle(battle, { characterName: 'Me' })[0].abilityHrid).toBe('/abilities/cleave');
    });

    test('is null when the battle is about somebody else', () => {
        expect(equippedAbilitiesFromBattle(battle, { characterId: 99 })).toBeNull();
        expect(equippedAbilitiesFromBattle({}, { characterId: 1 })).toBeNull();
    });
});

describe('telling two kits apart', () => {
    test('order is not a difference, membership and level are', () => {
        expect(abilityKitsDiffer(kit(['/abilities/a', 1]), kit(['/abilities/a', 2]))).toBe(false);
        expect(abilityKitsDiffer(kit(['/abilities/a', 1, 1]), kit(['/abilities/a', 1, 2]))).toBe(true);
        expect(abilityKitsDiffer(kit(['/abilities/a', 1]), kit(['/abilities/b', 1]))).toBe(true);
    });
});
