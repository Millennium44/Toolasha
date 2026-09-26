/**
 * Dungeon Tracker UI State — filter predicate and clear behavior
 *
 * filterDungeon/filterTeam persist across sessions while their controls sit in
 * a collapsed section, so the header needs a cheap way to know "a filter is
 * narrowing what you're seeing" without reaching into the DOM. hasActiveFilters
 * and clearFilters are the pure logic behind that indicator.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

/** Who is logged in, and the per-character settings store the panel writes to */
const world = vi.hoisted(() => ({ charId: 'market' }));
const store = vi.hoisted(() => new Map());
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => world.charId },
}));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base, _store, defaultValue = null) => {
        const value = store.get(`${base}_${world.charId}`);
        return value === undefined ? defaultValue : value;
    },
    writeScoped: async (base, value) => {
        store.set(`${base}_${world.charId}`, value);
        return true;
    },
}));

const { default: dungeonTrackerUIState } = await import('./dungeon-tracker-ui-state.js');

describe('hasActiveFilters', () => {
    beforeEach(() => {
        dungeonTrackerUIState.filterDungeon = 'all';
        dungeonTrackerUIState.filterTier = 'all';
        dungeonTrackerUIState.filterTeam = 'all';
        dungeonTrackerUIState.isDungeonFilterManual = false;
        dungeonTrackerUIState.isTierFilterManual = false;
    });

    test('false when all filters are all', () => {
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(false);
    });

    test('true when the dungeon filter is set by hand', () => {
        dungeonTrackerUIState.filterDungeon = 'Chimeratos Lair';
        dungeonTrackerUIState.isDungeonFilterManual = true;
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(true);
    });

    test('true when the tier filter is set by hand', () => {
        dungeonTrackerUIState.filterTier = '2';
        dungeonTrackerUIState.isTierFilterManual = true;
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(true);
    });

    test('true when only the team filter is set', () => {
        dungeonTrackerUIState.filterTeam = 'Solo';
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(true);
    });

    test('true when both a manual dungeon and a manual team filter are set', () => {
        dungeonTrackerUIState.filterDungeon = 'Chimeratos Lair';
        dungeonTrackerUIState.isDungeonFilterManual = true;
        dungeonTrackerUIState.filterTeam = 'Solo';
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(true);
    });

    test('false for a dungeon/tier auto-scoped to the run in progress, not chosen by hand', () => {
        dungeonTrackerUIState.filterDungeon = 'Chimeratos Lair';
        dungeonTrackerUIState.filterTier = '2';
        // isDungeonFilterManual / isTierFilterManual stay false — as they do
        // after autoScopeToRun sets these fields
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(false);
    });
});

describe('clearFilters', () => {
    test('resets every filter back to all and returns Dungeon/Tier to auto mode', () => {
        dungeonTrackerUIState.filterDungeon = 'Chimeratos Lair';
        dungeonTrackerUIState.isDungeonFilterManual = true;
        dungeonTrackerUIState.filterTier = '2';
        dungeonTrackerUIState.isTierFilterManual = true;
        dungeonTrackerUIState.filterTeam = 'Solo';

        dungeonTrackerUIState.clearFilters();

        expect(dungeonTrackerUIState.filterDungeon).toBe('all');
        expect(dungeonTrackerUIState.filterTier).toBe('all');
        expect(dungeonTrackerUIState.filterTeam).toBe('all');
        expect(dungeonTrackerUIState.isDungeonFilterManual).toBe(false);
        expect(dungeonTrackerUIState.isTierFilterManual).toBe(false);
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(false);
    });

    test('is a no-op when filters are already all', () => {
        dungeonTrackerUIState.clearFilters();
        expect(dungeonTrackerUIState.filterDungeon).toBe('all');
        expect(dungeonTrackerUIState.filterTeam).toBe('all');
    });
});

describe('autoScopeToRun', () => {
    beforeEach(() => {
        dungeonTrackerUIState.filterDungeon = 'all';
        dungeonTrackerUIState.filterTier = 'all';
        dungeonTrackerUIState.isDungeonFilterManual = false;
        dungeonTrackerUIState.isTierFilterManual = false;
    });

    test('points Dungeon and Tier at the run and reports a change', () => {
        const changed = dungeonTrackerUIState.autoScopeToRun('Chimerical Den', 3);
        expect(changed).toBe(true);
        expect(dungeonTrackerUIState.filterDungeon).toBe('Chimerical Den');
        expect(dungeonTrackerUIState.filterTier).toBe('3');
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(false);
    });

    test('is idempotent: a second call for the same run reports no change', () => {
        dungeonTrackerUIState.autoScopeToRun('Chimerical Den', 3);
        const changed = dungeonTrackerUIState.autoScopeToRun('Chimerical Den', 3);
        expect(changed).toBe(false);
    });

    test('does not overwrite a manually-chosen dungeon filter', () => {
        dungeonTrackerUIState.filterDungeon = 'Pirate Cove';
        dungeonTrackerUIState.isDungeonFilterManual = true;

        const changed = dungeonTrackerUIState.autoScopeToRun('Chimerical Den', 3);

        expect(dungeonTrackerUIState.filterDungeon).toBe('Pirate Cove');
        // The tier still auto-scopes even though the dungeon filter is manual
        expect(dungeonTrackerUIState.filterTier).toBe('3');
        expect(changed).toBe(true);
    });

    test('does not overwrite a manually-chosen tier filter', () => {
        dungeonTrackerUIState.filterTier = '5';
        dungeonTrackerUIState.isTierFilterManual = true;

        dungeonTrackerUIState.autoScopeToRun('Chimerical Den', 3);

        expect(dungeonTrackerUIState.filterTier).toBe('5');
        expect(dungeonTrackerUIState.filterDungeon).toBe('Chimerical Den');
    });

    test('does nothing without a dungeon name or tier', () => {
        expect(dungeonTrackerUIState.autoScopeToRun(null, 3)).toBe(false);
        expect(dungeonTrackerUIState.autoScopeToRun('Chimerical Den', null)).toBe(false);
        expect(dungeonTrackerUIState.filterDungeon).toBe('all');
        expect(dungeonTrackerUIState.filterTier).toBe('all');
    });
});

describe('the panel’s preferences across a character switch', () => {
    beforeEach(() => {
        world.charId = 'market';
        store.clear();
    });

    test('a character who has never opened the panel gets the defaults, not the last one’s', async () => {
        store.set('dungeonTracker_uiState_market', {
            isCollapsed: true,
            position: { x: 40, y: 900 },
            groupBy: 'dungeon',
            filterDungeon: 'Chimerical Den',
            filterTeam: 'Solo',
        });
        await dungeonTrackerUIState.load();
        expect(dungeonTrackerUIState.isCollapsed).toBe(true);

        world.charId = 'iron';
        await dungeonTrackerUIState.load();

        expect(dungeonTrackerUIState.isCollapsed).toBe(false);
        expect(dungeonTrackerUIState.position).toBeNull();
        expect(dungeonTrackerUIState.groupBy).toBe('team');
        expect(dungeonTrackerUIState.filterDungeon).toBe('all');
        expect(dungeonTrackerUIState.filterTeam).toBe('all');
    });

    test('the first click after the switch does not file the departing character’s preferences', async () => {
        store.set('dungeonTracker_uiState_market', { isCollapsed: true, groupBy: 'dungeon' });
        await dungeonTrackerUIState.load();

        world.charId = 'iron';
        await dungeonTrackerUIState.save();

        expect(store.has('dungeonTracker_uiState_iron')).toBe(false);
    });

    test('a load a switch superseded is not applied to the arriving character’s panel', async () => {
        store.set('dungeonTracker_uiState_market', { isCollapsed: true, groupBy: 'dungeon' });

        const loading = dungeonTrackerUIState.load();
        world.charId = 'iron';
        await loading;

        expect(dungeonTrackerUIState.isCollapsed).toBe(false);
        expect(dungeonTrackerUIState.groupBy).toBe('team');
    });
});
