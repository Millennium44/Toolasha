import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char1',
    saved: {},
    simulateScrollEffects: true,
    snapshotName: null,
    switchHandlers: [],
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        on: (event, handler) => {
            if (event === 'character_switched') game.switchHandlers.push(handler);
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: (key) => (key === 'simulateScrollEffects' ? game.simulateScrollEffects : false) },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, storeName, defaultValue) => game.saved[key] ?? defaultValue,
        setJSON: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('./loadout-snapshot.js', () => ({
    default: { getSnapshotInfoForSkill: () => (game.snapshotName ? { name: game.snapshotName } : null) },
}));

const scrollSimulator = (await import('./scroll-simulator.js')).default;

describe('scroll simulator', () => {
    beforeEach(async () => {
        game.characterId = 'char1';
        game.saved = {};
        game.simulateScrollEffects = true;
        game.snapshotName = null;
        game.switchHandlers = [];
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.initialized = false;
        scrollSimulator.switchHandler = null;
        await scrollSimulator.initialize();
    });

    test('the master toggle off yields no scrolls, even with a default saved', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['scroll_a']);
        game.simulateScrollEffects = false;

        expect(scrollSimulator.getScrollSetForActionType('/action_types/combat')).toEqual(new Set());
    });

    test('with nothing configured, resolution falls through to an empty set', () => {
        expect(scrollSimulator.getScrollSetForActionType('/action_types/combat')).toEqual(new Set());
    });

    test('a global default applies when no loadout is active', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['scroll_a', 'scroll_b']);

        expect(scrollSimulator.getScrollSetForActionType('/action_types/combat')).toEqual(
            new Set(['scroll_a', 'scroll_b'])
        );
    });

    test('a matching loadout selection takes priority over the default', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['default_scroll']);
        await scrollSimulator.saveScrollsForLoadout('My Loadout', ['loadout_scroll']);
        game.snapshotName = 'My Loadout';

        expect(scrollSimulator.getScrollSetForActionType('/action_types/combat')).toEqual(new Set(['loadout_scroll']));
    });

    test('an active loadout with nothing saved for it falls back to the default', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['default_scroll']);
        game.snapshotName = 'Unconfigured Loadout';

        expect(scrollSimulator.getScrollSetForActionType('/action_types/combat')).toEqual(new Set(['default_scroll']));
    });

    test('getScrollsForLoadout(null) reads the global default', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['a']);

        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['a']));
        expect(scrollSimulator.getScrollsForLoadout('nonexistent')).toEqual(new Set());
    });

    test('saved selections persist to storage under the per-character key', async () => {
        await scrollSimulator.saveScrollsForLoadout('Fishing', ['scroll_x']);

        expect(game.saved['scroll_simulation_char1']).toEqual({ Fishing: ['scroll_x'] });
    });

    test('initialize hydrates from a prior save', async () => {
        game.saved['scroll_simulation_char1'] = { __default__: ['persisted_scroll'] };
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.initialized = false;

        await scrollSimulator.initialize();

        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['persisted_scroll']));
    });

    test('a non-array saved entry is skipped rather than crashing hydration', async () => {
        game.saved['scroll_simulation_char1'] = { __default__: 'not-an-array' };
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.initialized = false;

        await scrollSimulator.initialize();

        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set());
    });

    test('character switch resets in-memory selections and reloads for the new character', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['char1_scroll']);
        game.characterId = 'char2';
        game.saved['scroll_simulation_char2'] = { __default__: ['char2_scroll'] };

        await game.switchHandlers[0]();

        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['char2_scroll']));
    });
});
