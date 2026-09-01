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
        dungeonTrackerUIState.filterTeam = 'all';
    });

    test('false when both filters are all', () => {
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(false);
    });

    test('true when only the dungeon filter is set', () => {
        dungeonTrackerUIState.filterDungeon = 'Chimeratos Lair';
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(true);
    });

    test('true when only the team filter is set', () => {
        dungeonTrackerUIState.filterTeam = 'Solo';
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(true);
    });

    test('true when both filters are set', () => {
        dungeonTrackerUIState.filterDungeon = 'Chimeratos Lair';
        dungeonTrackerUIState.filterTeam = 'Solo';
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(true);
    });
});

describe('clearFilters', () => {
    test('resets both filters back to all', () => {
        dungeonTrackerUIState.filterDungeon = 'Chimeratos Lair';
        dungeonTrackerUIState.filterTeam = 'Solo';

        dungeonTrackerUIState.clearFilters();

        expect(dungeonTrackerUIState.filterDungeon).toBe('all');
        expect(dungeonTrackerUIState.filterTeam).toBe('all');
        expect(dungeonTrackerUIState.hasActiveFilters()).toBe(false);
    });

    test('is a no-op when filters are already all', () => {
        dungeonTrackerUIState.clearFilters();
        expect(dungeonTrackerUIState.filterDungeon).toBe('all');
        expect(dungeonTrackerUIState.filterTeam).toBe('all');
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
