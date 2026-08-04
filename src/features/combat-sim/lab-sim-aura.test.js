/** @vitest-environment happy-dom
 *
 * Simulating a fight with the Critical Aura up.
 *
 * It is an ability, not a trinket — a special-slot cast that buffs the party's
 * critical rate and damage. A labyrinth fight is short enough to be decided by
 * a crit, so what an upgrade is worth can change with the aura running, and
 * re-slotting abilities to find out is a lot of clicking for a question the
 * simulator can answer.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ abilities: {}, learned: [] }));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (_k, d) => d, setSetting: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: game.abilities }),
        characterItems: [],
        characterEquipment: new Map(),
        get characterData() {
            return { characterAbilities: game.learned };
        },
    },
}));

vi.mock('./combat-sim-ui.js', () => ({
    default: {
        upgradeRowPurchase: () => null,
        upgradeRowActionsHtml: () => '',
        wireUpgradeRowActions: () => {},
    },
}));

const { criticalAuraAbility, criticalAuraCandidate } = await import('./lab-sim-ui.js');

const CRIT = '/abilities/critical_aura';

beforeEach(() => {
    game.abilities = {
        [CRIT]: { name: 'Critical Aura', isSpecialAbility: true },
        '/abilities/fierce_aura': { name: 'Fierce Aura', isSpecialAbility: true },
        '/abilities/precision': { name: 'Precision', isSpecialAbility: true },
        '/abilities/smack': { name: 'Smack', isSpecialAbility: false },
    };
    game.learned = [];
});

describe('which aura the simulation casts', () => {
    test('the one you have learned, at the level you have it', () => {
        game.learned = [{ abilityHrid: CRIT, level: 20 }];

        expect(criticalAuraAbility()).toMatchObject({ hrid: CRIT, level: 20, learned: true });
    });

    test('and not having learned it still answers the question, at level 1', () => {
        // The commonest reason to ask what a fight looks like with the aura up
        // is that you are deciding whether to buy the book
        expect(criticalAuraAbility()).toMatchObject({ level: 1, learned: false });
    });

    test('it is found by name rather than a hardcoded hrid', () => {
        game.abilities = { '/abilities/renamed_thing': { name: 'Critical Aura', isSpecialAbility: true } };

        expect(criticalAuraAbility().hrid).toBe('/abilities/renamed_thing');
    });

    test('another aura is never mistaken for it', () => {
        game.learned = [{ abilityHrid: '/abilities/fierce_aura', level: 40 }];

        expect(criticalAuraAbility()).toMatchObject({ hrid: CRIT, level: 1 });
    });

    test('a game with no such ability is null rather than a guess', () => {
        game.abilities = { '/abilities/smack': { name: 'Smack' } };

        expect(criticalAuraAbility()).toBeNull();
    });
});

describe('offering it as one upgrade among the others', () => {
    const bar = (special, ...rest) => ({
        hrid: '/players/me',
        abilities: [special, ...rest, null, null, null].slice(0, 5),
    });
    const ability = (hrid, level = 10) => ({ hrid, level, triggers: [] });
    const aura = { hrid: CRIT, level: 20, special: true, learned: true };

    test('a special ability is offered for the special slot, which is where an aura lives', () => {
        const candidate = criticalAuraCandidate(
            bar(ability('/abilities/fierce_aura'), ability('/abilities/smack')),
            aura
        );

        expect(candidate).toMatchObject({
            slot: 'ability_0',
            upgradeHrid: CRIT,
            upgradeLevel: 20,
            type: 'ability_swap',
        });
    });

    test('and says what it would replace', () => {
        const candidate = criticalAuraCandidate(bar(ability('/abilities/fierce_aura')), aura);

        expect(candidate.description).toContain('Fierce Aura');
        expect(candidate.description).toContain('Critical Aura');
    });

    test('an empty special slot is an offer too', () => {
        const candidate = criticalAuraCandidate(bar(null, ability('/abilities/smack')), aura);

        expect(candidate).toMatchObject({ slot: 'ability_0', upgradeHrid: CRIT });
    });

    test('already running it at that level is not an upgrade', () => {
        // There is nothing to measure, and a candidate worth nothing at the top
        // of a ranked list is noise
        expect(criticalAuraCandidate(bar(ability(CRIT, 20)), aura)).toBeNull();
    });

    test('but running it at a lower level is', () => {
        expect(criticalAuraCandidate(bar(ability(CRIT, 5)), aura)).toMatchObject({ upgradeLevel: 20 });
    });

    test('a non-special one takes a free slot rather than the special one', () => {
        const normal = { ...aura, special: false };
        const candidate = criticalAuraCandidate(
            bar(ability('/abilities/precision'), ability('/abilities/smack')),
            normal
        );

        expect(candidate.slot).toBe('ability_2');
    });

    test('and a full bar is no offer at all, rather than one that drops an ability', () => {
        const normal = { ...aura, special: false };
        const full = {
            hrid: '/players/me',
            abilities: ['a', 'b', 'c', 'd', 'e'].map((n) => ability(`/abilities/${n}`)),
        };

        expect(criticalAuraCandidate(full, normal)).toBeNull();
    });

    test('the bar the panel is showing is never touched', () => {
        // A candidate is a description of a change, not the change itself
        const original = bar(ability('/abilities/fierce_aura'));
        criticalAuraCandidate(original, aura);

        expect(original.abilities[0].hrid).toBe('/abilities/fierce_aura');
    });

    test('no aura, no offer', () => {
        expect(criticalAuraCandidate(bar(ability('/abilities/fierce_aura')), null)).toBeNull();
    });
});
