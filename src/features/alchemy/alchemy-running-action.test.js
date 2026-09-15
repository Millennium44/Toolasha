import { describe, test, expect } from 'vitest';
import { runningAlchemyAction } from './alchemy-running-action.js';

describe('runningAlchemyAction', () => {
    test('returns the running action when it matches the hrid', () => {
        const queue = [{ actionHrid: '/actions/alchemy/transmute', ordinal: 0, isDone: false }];

        expect(runningAlchemyAction(queue, '/actions/alchemy/transmute')).toBe(queue[0]);
    });

    test('returns null when a different action is the one actually running', () => {
        const queue = [
            { actionHrid: '/actions/cooking/apple_gummy', ordinal: 0, isDone: false },
            { actionHrid: '/actions/alchemy/transmute', ordinal: 1, isDone: false },
        ];

        expect(runningAlchemyAction(queue, '/actions/alchemy/transmute')).toBeNull();
    });

    test('picks the executing action by queue order, not array position', () => {
        // The array lists the queued transmute FIRST, but the running one has
        // the lower ordinal (see utils/combat-actions.js) and is what is
        // actually executing — a `.find`/`[0]` read would report the wrong item.
        const queuedTransmute = {
            actionHrid: '/actions/alchemy/transmute',
            ordinal: 5,
            isDone: false,
            primaryItemHash: 'char::/item_locations/inventory::/items/shard::0',
        };
        const runningTransmute = {
            actionHrid: '/actions/alchemy/transmute',
            ordinal: 0,
            isDone: false,
            primaryItemHash: 'char::/item_locations/inventory::/items/gem::0',
        };
        const queue = [queuedTransmute, runningTransmute];

        expect(runningAlchemyAction(queue, '/actions/alchemy/transmute')).toBe(runningTransmute);
    });

    test('returns null on an empty queue', () => {
        expect(runningAlchemyAction([], '/actions/alchemy/transmute')).toBeNull();
    });
});
