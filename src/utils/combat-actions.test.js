import { describe, test, expect } from 'vitest';
import { runningCombatAction } from './combat-actions.js';

describe('runningCombatAction', () => {
    test('picks the lowest-ordinal unfinished combat action, not the first in the array', () => {
        // The queue that produced the "9 to boss on a dungeon" bug: a long-run
        // repeat (Sorcerer's Tower) sits first in the array with the highest
        // ordinal, while the dungeon actually running has a lower ordinal.
        const actions = [
            { actionHrid: '/actions/combat/sorcerers_tower', isDone: false, ordinal: 8589934588, difficultyTier: 0 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 8589934587, difficultyTier: 2 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 0, difficultyTier: 2 },
        ];
        expect(runningCombatAction(actions).actionHrid).toBe('/actions/combat/chimerical_den');
    });

    test('ignores finished combat actions by default', () => {
        const actions = [
            { actionHrid: '/actions/combat/chimerical_den', isDone: true, ordinal: 0 },
            { actionHrid: '/actions/combat/sorcerers_tower', isDone: false, ordinal: 5 },
        ];
        expect(runningCombatAction(actions).actionHrid).toBe('/actions/combat/sorcerers_tower');
    });

    test('ignores non-combat actions', () => {
        const actions = [
            { actionHrid: '/actions/cheesesmithing/holy_cheese', isDone: false, ordinal: 0 },
            { actionHrid: '/actions/combat/fly', isDone: false, ordinal: 3 },
        ];
        expect(runningCombatAction(actions).actionHrid).toBe('/actions/combat/fly');
    });

    test('returns null when every combat action is finished and finished are not included', () => {
        const actions = [{ actionHrid: '/actions/combat/fly', isDone: true, ordinal: 0 }];
        expect(runningCombatAction(actions)).toBeNull();
    });

    test('falls back to the lowest-ordinal finished action when includeFinished is set', () => {
        const actions = [
            { actionHrid: '/actions/combat/fly', isDone: true, ordinal: 7 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: true, ordinal: 2 },
        ];
        expect(runningCombatAction(actions, { includeFinished: true }).actionHrid).toBe(
            '/actions/combat/chimerical_den'
        );
    });

    test('unfinished still wins over finished even when includeFinished is set', () => {
        const actions = [
            { actionHrid: '/actions/combat/chimerical_den', isDone: true, ordinal: 0 },
            { actionHrid: '/actions/combat/sorcerers_tower', isDone: false, ordinal: 9 },
        ];
        expect(runningCombatAction(actions, { includeFinished: true }).actionHrid).toBe(
            '/actions/combat/sorcerers_tower'
        );
    });

    test('returns null for empty or non-array input', () => {
        expect(runningCombatAction([])).toBeNull();
        expect(runningCombatAction(null)).toBeNull();
        expect(runningCombatAction(undefined)).toBeNull();
    });
});
