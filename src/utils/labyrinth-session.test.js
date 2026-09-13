/**
 * Holding a labyrinth run as one session — see the module note for why the
 * roster-based session key breaks per room.
 */

import { describe, test, expect } from 'vitest';
import { newLabyrinthSessionState, noteLabyrinthUpdate, labyrinthSessionKey } from './labyrinth-session.js';

describe('tracking whether a run is active', () => {
    test('not in a labyrinth falls back to the roster-based key', () => {
        const state = newLabyrinthSessionState();
        expect(labyrinthSessionKey(state, 'roster|123')).toBe('roster|123');
    });

    test('an active run overrides the roster-based key', () => {
        const state = newLabyrinthSessionState();
        noteLabyrinthUpdate(state, { labyrinth: { isActive: true, startedAt: 't1' } });

        expect(labyrinthSessionKey(state, 'roster|123')).toBe('labyrinth|t1');
    });

    test('the key stays the same across every room of the run', () => {
        const state = newLabyrinthSessionState();
        noteLabyrinthUpdate(state, { labyrinth: { isActive: true, startedAt: 't1', currentFloor: 1 } });
        const first = labyrinthSessionKey(state, 'roster|123');

        noteLabyrinthUpdate(state, { labyrinth: { isActive: true, startedAt: 't1', currentFloor: 2 } });
        expect(labyrinthSessionKey(state, 'roster|456')).toBe(first);
    });

    test('isActive going false ends the run and returns to the roster-based key', () => {
        const state = newLabyrinthSessionState();
        noteLabyrinthUpdate(state, { labyrinth: { isActive: true, startedAt: 't1' } });
        noteLabyrinthUpdate(state, { labyrinth: { isActive: false } });

        expect(labyrinthSessionKey(state, 'roster|123')).toBe('roster|123');
    });

    test('a message naming no labyrinth at all also ends the run', () => {
        const state = newLabyrinthSessionState();
        noteLabyrinthUpdate(state, { labyrinth: { isActive: true, startedAt: 't1' } });
        noteLabyrinthUpdate(state, {});

        expect(labyrinthSessionKey(state, 'roster|123')).toBe('roster|123');
    });

    test('a second run gets a different key than the first', () => {
        const state = newLabyrinthSessionState();
        noteLabyrinthUpdate(state, { labyrinth: { isActive: true, startedAt: 't1' } });
        const first = labyrinthSessionKey(state, null);
        noteLabyrinthUpdate(state, { labyrinth: { isActive: false } });

        noteLabyrinthUpdate(state, { labyrinth: { isActive: true, startedAt: 't2' } });
        expect(labyrinthSessionKey(state, null)).not.toBe(first);
    });
});
