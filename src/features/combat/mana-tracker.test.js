import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    manaTracker: true,
    abilityDetailMap: {},
    handlers: {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => (key === 'manaTracker' ? game.manaTracker : false) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: () => ({ abilityDetailMap: game.abilityDetailMap }),
        getCurrentCharacterId: () => 'char1',
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.handlers[event] === handler) delete game.handlers[event];
        },
    },
}));

const manaTracker = (await import('./mana-tracker.js')).default;
const { resetManaTally, manaSpend, abilityLabel } = await import('./mana-tracker.js');

describe('mana tracker wiring', () => {
    beforeEach(() => {
        game.manaTracker = true;
        game.abilityDetailMap = {};
        game.handlers = {};
        resetManaTally();
        manaTracker.cleanup();
    });

    test('disabled by setting, initialize registers nothing', () => {
        game.manaTracker = false;
        manaTracker.initialize();

        expect(game.handlers['new_battle']).toBeUndefined();
        expect(game.handlers['battle_consumable_ability_updated']).toBeUndefined();
    });

    test('enabled, initialize subscribes to battle and ability events', () => {
        manaTracker.initialize();

        expect(typeof game.handlers['new_battle']).toBe('function');
        expect(typeof game.handlers['battle_consumable_ability_updated']).toBe('function');
    });

    test('a cast is costed from abilityDetailMap and tallied', () => {
        game.abilityDetailMap['/abilities/fireball'] = { manaCost: 15, name: 'Fireball' };
        manaTracker.initialize();

        game.handlers['new_battle']();
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });
        game.handlers['battle_consumable_ability_updated']({ ability: { abilityHrid: '/abilities/fireball' } });

        const summary = manaSpend();
        expect(summary.fights).toBe(1);
        expect(summary.mana).toBe(30);
        expect(summary.abilities[0].casts).toBe(2);
    });

    test('an ability with no stated cost still counts casts, at zero mana', () => {
        manaTracker.initialize();

        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/mystery' });

        const summary = manaSpend();
        expect(summary.abilities[0].unknownCost).toBe(true);
        expect(summary.mana).toBe(0);
    });

    test('a malformed ability payload is ignored rather than crashing', () => {
        manaTracker.initialize();

        expect(() => game.handlers['battle_consumable_ability_updated']({})).not.toThrow();
        expect(() => game.handlers['battle_consumable_ability_updated']({ ability: 42 })).not.toThrow();
        expect(manaSpend().abilities).toHaveLength(0);
    });

    test('cleanup unregisters both listeners', () => {
        manaTracker.initialize();
        manaTracker.cleanup();

        expect(game.handlers['new_battle']).toBeUndefined();
        expect(game.handlers['battle_consumable_ability_updated']).toBeUndefined();
    });

    test('resetManaTally starts the count over', () => {
        game.abilityDetailMap['/abilities/fireball'] = { manaCost: 15 };
        manaTracker.initialize();
        game.handlers['new_battle']();
        game.handlers['battle_consumable_ability_updated']({ ability: '/abilities/fireball' });

        resetManaTally();

        expect(manaSpend().fights).toBe(0);
        expect(manaSpend().mana).toBe(0);
    });
});

describe('abilityLabel', () => {
    beforeEach(() => {
        game.abilityDetailMap = {};
    });

    test('uses the game-supplied name when the ability is known', () => {
        game.abilityDetailMap['/abilities/fireball'] = { name: 'Fireball' };
        expect(abilityLabel('/abilities/fireball')).toBe('Fireball');
    });

    test('falls back to a de-slugged hrid tail for an unknown ability', () => {
        expect(abilityLabel('/abilities/arcane_burst')).toBe('arcane burst');
    });

    test('an empty hrid does not throw', () => {
        expect(abilityLabel('')).toBe('');
        expect(abilityLabel(undefined)).toBe('');
    });
});
