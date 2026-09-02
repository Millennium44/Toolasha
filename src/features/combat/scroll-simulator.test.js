import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: 'char1',
    saved: {},
    simulateScrollEffects: true,
    snapshotName: null,
    switchHandlers: [],
    hold: null,
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
        getJSON: async (key, storeName, defaultValue) => {
            // A read left open, so a test can land a character switch inside one
            if (game.hold) await game.hold;
            return game.saved[key] ?? defaultValue;
        },
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
        game.hold = null;
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.initialized = false;
        scrollSimulator.switchHandler = null;
        scrollSimulator.owner = null;
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

    test("a load in flight across the switch does not add its selections to the new character's", async () => {
        // `character_switched` is deferred, so the handler's own reload is not
        // ordered against a load already running. The stale one used to land
        // last and assign straight into the map the reload had just filled.
        game.saved['scroll_simulation_char1'] = { Fishing: ['char1_scroll'] };
        game.saved['scroll_simulation_char2'] = { __default__: ['char2_scroll'] };
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.owner = null;
        scrollSimulator.initialized = false;

        let release;
        game.hold = new Promise((resolve) => {
            release = resolve;
        });
        const stale = scrollSimulator.initialize();

        game.characterId = 'char2';
        game.hold = null;
        await game.switchHandlers[0]();
        release();
        await stale;

        expect(scrollSimulator.getScrollsForLoadout('Fishing')).toEqual(new Set());
        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['char2_scroll']));

        // and the next save writes only the arriving character's selections
        await scrollSimulator.saveScrollsForLoadout('Mining', ['char2_mining']);
        expect(game.saved['scroll_simulation_char2']).toEqual({
            __default__: ['char2_scroll'],
            Mining: ['char2_mining'],
        });
        expect(game.saved['scroll_simulation_char1']).toEqual({ Fishing: ['char1_scroll'] });
    });

    test('a boot read the character moved under still ends up loaded and saving', async () => {
        // `initialize()` is called once, at boot, and only the switch handler
        // ever calls it again. A refused read that returned before registering
        // that handler left the module dead for the session: `owner` null, so
        // every scroll selection the player ticked was refused with nothing but
        // a console line, and nothing simulated any scroll at all.
        game.saved['scroll_simulation_char2'] = { __default__: ['char2_scroll'] };
        scrollSimulator.scrollsByLoadout = {};
        scrollSimulator.owner = null;
        scrollSimulator.initialized = false;
        scrollSimulator.switchHandler = null;
        game.switchHandlers = [];

        let release;
        game.hold = new Promise((resolve) => {
            release = resolve;
        });
        const boot = scrollSimulator.initialize();
        // The id moves with no `character_switched` behind it, so nothing else
        // is coming to make the read again
        game.characterId = 'char2';
        game.hold = null;
        release();
        await boot;

        expect(scrollSimulator.owner).toBe('char2');
        expect(scrollSimulator.getScrollsForLoadout(null)).toEqual(new Set(['char2_scroll']));
        expect(game.switchHandlers).toHaveLength(1);

        await scrollSimulator.saveScrollsForLoadout('Mining', ['char2_mining']);
        expect(game.saved['scroll_simulation_char2']).toEqual({
            __default__: ['char2_scroll'],
            Mining: ['char2_mining'],
        });
    });

    test('a save is refused when the selections in memory are not this character’s', async () => {
        await scrollSimulator.saveScrollsForLoadout(null, ['char1_scroll']);
        game.characterId = 'char2';

        const warned = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            await scrollSimulator.saveScrollsForLoadout('Fishing', ['leaked']);
        } finally {
            warned.mockRestore();
        }

        expect(game.saved['scroll_simulation_char2']).toBeUndefined();
    });
});
