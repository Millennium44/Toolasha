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

const { criticalAuraAbility, withCriticalAura } = await import('./lab-sim-ui.js');

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

describe('slotting it for the simulation', () => {
    const bar = (special, ...rest) => ({
        hrid: '/players/me',
        abilities: [special, ...rest, null, null, null].slice(0, 5),
    });
    const ability = (hrid, level = 10) => ({ hrid, level, triggers: [] });
    const aura = { hrid: CRIT, level: 20, special: true, learned: true };

    test('a special ability replaces the special slot, which is where an aura lives', () => {
        const swapped = withCriticalAura(bar(ability('/abilities/fierce_aura'), ability('/abilities/smack')), aura);

        expect(swapped.abilities[0]).toMatchObject({ hrid: CRIT, level: 20 });
        expect(swapped.abilities[1].hrid).toBe('/abilities/smack');
    });

    test('an empty special slot is filled rather than left', () => {
        const swapped = withCriticalAura(bar(null, ability('/abilities/smack')), aura);

        expect(swapped.abilities[0]).toMatchObject({ hrid: CRIT });
    });

    test('a bar shorter than five slots is not a reason to fail', () => {
        const swapped = withCriticalAura({ hrid: '/players/me', abilities: [] }, aura);

        expect(swapped.abilities[0]).toMatchObject({ hrid: CRIT });
        expect(swapped.abilities).toHaveLength(5);
    });

    test('a non-special one takes a free slot instead of the special one', () => {
        const normal = { ...aura, special: false };
        const swapped = withCriticalAura(bar(ability('/abilities/precision'), ability('/abilities/smack')), normal);

        expect(swapped.abilities[0].hrid).toBe('/abilities/precision');
        expect(swapped.abilities[2]).toMatchObject({ hrid: CRIT });
    });

    test('and a full bar is left alone rather than losing an ability you chose', () => {
        const normal = { ...aura, special: false };
        const full = {
            hrid: '/players/me',
            abilities: [
                ability('/abilities/precision'),
                ability('/abilities/a'),
                ability('/abilities/b'),
                ability('/abilities/c'),
                ability('/abilities/d'),
            ],
        };

        expect(withCriticalAura(full, normal)).toBe(full);
    });

    test('the bar the panel is showing is left alone', () => {
        // The editor hands out the DTOs it is still displaying, so a swap made
        // for one simulation must not become a bar the panel claims you run
        const original = bar(ability('/abilities/fierce_aura'));
        withCriticalAura(original, aura);

        expect(original.abilities[0].hrid).toBe('/abilities/fierce_aura');
    });

    test('no aura at all changes nothing', () => {
        const original = bar(ability('/abilities/fierce_aura'));

        expect(withCriticalAura(original, null)).toBe(original);
    });
});
