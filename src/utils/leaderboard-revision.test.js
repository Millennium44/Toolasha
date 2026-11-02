import { describe, expect, test } from 'vitest';
import { createRevisionGate, leaderboardRevisionKey } from './leaderboard-revision.js';

const board = (extra = {}) => ({
    leaderboardType: 'standard',
    leaderboardCategory: 'total_level',
    leaderboardRevision: 5,
    ...extra,
});

describe('createRevisionGate', () => {
    test('an older board than the last seen for the same board is stale', () => {
        const gate = createRevisionGate();
        expect(gate.isStale(board({ leaderboardRevision: 5 }))).toBe(false);
        expect(gate.isStale(board({ leaderboardRevision: 4 }))).toBe(true);
    });

    test('an equal or newer revision is accepted, and a stale one does not lower the mark', () => {
        const gate = createRevisionGate();
        gate.isStale(board({ leaderboardRevision: 5 }));
        expect(gate.isStale(board({ leaderboardRevision: 5 }))).toBe(false);
        expect(gate.isStale(board({ leaderboardRevision: 7 }))).toBe(false);
        expect(gate.isStale(board({ leaderboardRevision: 6 }))).toBe(true);
    });

    test('boards are independent by type, category and every filter', () => {
        const gate = createRevisionGate();
        gate.isStale(board({ leaderboardRevision: 9 }));
        expect(gate.isStale(board({ leaderboardType: 'ironcow', leaderboardRevision: 1 }))).toBe(false);
        expect(gate.isStale(board({ leaderboardCategory: 'milking', leaderboardRevision: 1 }))).toBe(false);
        expect(gate.isStale(board({ gameModeFilter: 'ironcow', leaderboardRevision: 1 }))).toBe(false);
        expect(gate.isStale(board({ trialFilter: 'x', leaderboardRevision: 1 }))).toBe(false);
    });

    test('a message with no revision counts as 0, like the game, and reset forgets', () => {
        const gate = createRevisionGate();
        expect(gate.isStale({ leaderboardCategory: 'a' })).toBe(false);
        gate.isStale(board({ leaderboardRevision: 3 }));
        expect(gate.isStale(board({ leaderboardRevision: undefined }))).toBe(true);
        gate.reset();
        expect(gate.isStale(board({ leaderboardRevision: undefined }))).toBe(false);
    });

    test('an absent filter and an explicit "all" are the same board', () => {
        expect(leaderboardRevisionKey(board())).toBe(leaderboardRevisionKey(board({ gameModeFilter: 'all' })));
    });
});
