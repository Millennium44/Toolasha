/** @vitest-environment happy-dom
 *
 * Six shared keys folded into one per-character record.
 *
 * The filters used to be a key for the battle toggle plus one for every dungeon,
 * all of them shared by the whole account — so turning the Chimerical badge off
 * on the market character turned it off on the iron cow too, and every new
 * dungeon the game adds cost another IndexedDB key. What is worth testing is the
 * fold: nobody should lose their filters to it, and only one character should
 * inherit the account's old ones.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const store = vi.hoisted(() => ({ settings: {}, networthHistory: {} }));

const mockDataManager = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
    getCurrentCharacterId: () => mockDataManager.characterId,
    getCurrentCharacterGameMode: () => mockDataManager.gameMode,
    on: () => {},
    off: () => {},
}));

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, onSettingChange: () => {}, offSettingChange: () => {} },
}));
vi.mock('../../core/data-manager.js', () => ({ default: mockDataManager }));
vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(true),
        get: async (key, name = 'settings', fallback = null) => store[name]?.[key] ?? fallback,
        set: async (key, value, name = 'settings') => {
            store[name][key] = value;
            return true;
        },
        delete: async (key, name = 'settings') => {
            delete store[name][key];
            return true;
        },
        getAllKeys: async (name = 'settings') => Object.keys(store[name] || {}),
    },
}));
vi.mock('../../utils/asset-manifest.js', () => ({ default: { fetchManifest: async () => ({}) } }));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

const { default: taskIconFilters } = await import('./task-icon-filters.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

const DUNGEON_KEY = 'taskIconsFilterDungeon:chimerical_den';

/** Forget what the singleton loaded for the last test. */
function reload() {
    taskIconFilters.stateLoadPromise = null;
    taskIconFilters.stateLoadKey = null;
    taskIconFilters.isStateLoaded = false;
    taskIconFilters.state = { battle: true, dungeons: {} };
}

beforeEach(() => {
    store.settings = {};
    store.networthHistory = {};
    mockDataManager.characterId = 'market123';
    mockDataManager.gameMode = 'standard';
    localStorage.clear();
    _resetAdoptionCache();
    reload();
});

describe('folding the old keys into one', () => {
    const legacyKeys = () => {
        store.settings.taskIconsFiltersMigratedV1 = true;
        store.settings.taskIconsFilterBattle = false;
        store.settings[DUNGEON_KEY] = true;
    };

    test('the main character inherits what the account had', async () => {
        legacyKeys();

        await taskIconFilters.loadState();

        expect(taskIconFilters.getBattleFilterEnabled()).toBe(false);
        expect(taskIconFilters.getDungeonFilterEnabled('/actions/combat/chimerical_den')).toBe(true);
        expect(store.settings.taskIconFilters_market123).toEqual({
            battle: false,
            dungeons: {
                chimerical_den: true,
                sinister_circus: false,
                enchanted_fortress: false,
                pirate_cove: false,
            },
        });
    });

    test('and the one-key-per-dungeon spread is gone', async () => {
        legacyKeys();

        await taskIconFilters.loadState();

        expect(store.settings.taskIconsFilterBattle).toBeUndefined();
        expect(store.settings[DUNGEON_KEY]).toBeUndefined();
        expect(store.settings.taskIconFilters).toBeUndefined();
    });

    test('the iron cow starts on the defaults instead', async () => {
        legacyKeys();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';

        await taskIconFilters.loadState();

        expect(taskIconFilters.getBattleFilterEnabled()).toBe(true);
        expect(taskIconFilters.getDungeonFilterEnabled('/actions/combat/chimerical_den')).toBe(false);
        expect(store.settings.taskIconFilters_iron456).toBeUndefined();
    });

    test('and leaves the old filters for the main character to claim', async () => {
        legacyKeys();
        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';
        await taskIconFilters.loadState();

        mockDataManager.characterId = 'market123';
        mockDataManager.gameMode = 'standard';
        reload();
        await taskIconFilters.loadState();

        expect(taskIconFilters.getDungeonFilterEnabled('/actions/combat/chimerical_den')).toBe(true);
    });

    test('the older localStorage filters fold in the same way', async () => {
        // The pre-IndexedDB path is still the one a long-dormant install takes
        localStorage.setItem('mwi-taskIconsFilterBattle', 'false');
        localStorage.setItem('mwi-taskIconsFilter-pirate_cove', 'true');

        await taskIconFilters.loadState();

        expect(taskIconFilters.getBattleFilterEnabled()).toBe(false);
        expect(taskIconFilters.getDungeonFilterEnabled('/actions/combat/pirate_cove')).toBe(true);
        expect(store.settings.taskIconsFiltersMigratedV1).toBe(true);
        expect(localStorage.getItem('mwi-taskIconsFilterBattle')).toBeNull();
    });

    test('nothing stored anywhere is not a migration', async () => {
        await taskIconFilters.loadState();

        expect(taskIconFilters.getBattleFilterEnabled()).toBe(true);
        expect(store.settings.taskIconFilters).toBeUndefined();
        expect(store.settings.taskIconFilters_market123).toBeUndefined();
    });
});

describe('after the fold', () => {
    test('a toggle is written under this character alone', async () => {
        await taskIconFilters.loadState();

        taskIconFilters.handleFilterClick('battle');
        await Promise.resolve();

        expect(store.settings.taskIconFilters_market123).toEqual({ battle: false, dungeons: {} });
        expect(store.settings.taskIconFilters).toBeUndefined();
    });

    test('switching character reloads rather than reusing the last one', async () => {
        // Nothing calls cleanup() on a switch — the filter bar is redrawn on
        // demand — so the memo has to notice the character changed by itself
        store.settings.taskIconFilters_market123 = { battle: false, dungeons: {} };
        store.settings.taskIconFilters_iron456 = { battle: true, dungeons: { pirate_cove: true } };
        await taskIconFilters.loadState();
        expect(taskIconFilters.getBattleFilterEnabled()).toBe(false);

        mockDataManager.characterId = 'iron456';
        mockDataManager.gameMode = 'ironcow';
        await taskIconFilters.loadState();

        expect(taskIconFilters.getBattleFilterEnabled()).toBe(true);
        expect(taskIconFilters.getDungeonFilterEnabled('/actions/combat/pirate_cove')).toBe(true);
    });
});
