/**
 * Dungeon Tracker UI State — filter predicate and clear behavior
 *
 * filterDungeon/filterTeam persist across sessions while their controls sit in
 * a collapsed section, so the header needs a cheap way to know "a filter is
 * narrowing what you're seeing" without reaching into the DOM. hasActiveFilters
 * and clearFilters are the pure logic behind that indicator.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import dungeonTrackerUIState from './dungeon-tracker-ui-state.js';

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
