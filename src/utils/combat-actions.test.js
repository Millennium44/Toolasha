import { describe, test, expect } from 'vitest';
import { runningAction, runningCombatAction } from './combat-actions.js';

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

describe('runningAction', () => {
    test('with no predicate it is the front of the whole queue, not queue[0]', () => {
        // A repeating action requeued to the front of the array with the
        // highest ordinal is exactly what queue[0] mistook for "active".
        const actions = [
            { actionHrid: '/actions/cheesesmithing/holy_cheese', isDone: false, ordinal: 8589934588 },
            { actionHrid: '/actions/combat/chimerical_den', isDone: false, ordinal: 0 },
        ];
        expect(runningAction(actions).actionHrid).toBe('/actions/combat/chimerical_den');
    });

    test('a predicate narrows to a kind of action and still picks the running one among them', () => {
        // Two enhancing actions queued for different items: array order has the
        // queued one first, execution order has the running one first.
        const enhance = (a) => a.actionHrid === '/actions/enhancing/enhance';
        const actions = [
            { actionHrid: '/actions/enhancing/enhance', primaryItemHash: 'queued::5', isDone: false, ordinal: 9 },
            { actionHrid: '/actions/combat/fly', isDone: false, ordinal: 1 },
            { actionHrid: '/actions/enhancing/enhance', primaryItemHash: 'running::7', isDone: false, ordinal: 3 },
        ];
        expect(runningAction(actions, enhance).primaryItemHash).toBe('running::7');
    });

    test('no action matching the predicate is null, even when the queue is not empty', () => {
        const actions = [{ actionHrid: '/actions/combat/fly', isDone: false, ordinal: 0 }];
        expect(runningAction(actions, (a) => a.actionHrid.startsWith('/actions/alchemy/'))).toBeNull();
    });

    test('finished matches are ignored unless includeFinished asks for them as a fallback', () => {
        const alchemy = (a) => a.actionHrid.startsWith('/actions/alchemy/');
        const finished = [{ actionHrid: '/actions/alchemy/coinify', isDone: true, ordinal: 0 }];
        expect(runningAction(finished, alchemy)).toBeNull();
        expect(runningAction(finished, alchemy, { includeFinished: true }).actionHrid).toBe('/actions/alchemy/coinify');
    });

    test('returns null for empty or non-array input', () => {
        expect(runningAction([])).toBeNull();
        expect(runningAction(null)).toBeNull();
        expect(runningAction(undefined)).toBeNull();
    });
});
