/**
 * Session history.
 *
 * A run is archived when a *different* one starts, because that is the first
 * moment it is knowable to be over — nothing on the wire announces an ending.
 * The consequences of that choice are what these test: a session seen twice must
 * not appear twice, and a combined view must merge on the item rather than on
 * the game's per-session slot key.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: { getJSON: async (_k, _s, fallback) => fallback, setJSON: async () => true },
}));

const { sessionKey, withSession, combineSessions, describeSession, MAX_SESSIONS } =
    await import('./combat-session-history.js');

const session = (start, names = ['Millennium44'], loot = {}) => ({
    combatStartTime: start,
    durationSeconds: 600,
    players: names.map((name) => ({ name, loot })),
});

describe('naming a session', () => {
    test('the roster and the start time together', () => {
        expect(sessionKey(session('2026-08-03T01:00:00Z'))).toBe(sessionKey(session('2026-08-03T01:00:00Z')));
        expect(sessionKey(session('2026-08-03T01:00:00Z'))).not.toBe(sessionKey(session('2026-08-03T02:00:00Z')));
    });

    test('the same zone with somebody gone is a different session', () => {
        const party = sessionKey(session('2026-08-03T01:00:00Z', ['A', 'B']));
        const alone = sessionKey(session('2026-08-03T01:00:00Z', ['A']));

        expect(alone).not.toBe(party);
    });

    test('a snapshot that cannot say is not named', () => {
        expect(sessionKey({ players: [] })).toBeNull();
        expect(sessionKey({ players: [{ name: 'A' }] })).toBeNull();
        expect(sessionKey(null)).toBeNull();
    });
});

describe('adding a run to the list', () => {
    test('newest first', () => {
        let history = withSession([], session('2026-08-03T01:00:00Z'));
        history = withSession(history, session('2026-08-03T02:00:00Z'));

        expect(history[0].combatStartTime).toBe('2026-08-03T02:00:00Z');
        expect(history).toHaveLength(2);
    });

    test('the same session twice replaces rather than repeats', () => {
        // The later snapshot is the more complete one — loot totals only grow —
        // so it wins, and the run appears once
        const first = session('2026-08-03T01:00:00Z');
        const later = { ...first, durationSeconds: 1200 };

        const history = withSession(withSession([], first), later);

        expect(history).toHaveLength(1);
        expect(history[0].durationSeconds).toBe(1200);
    });

    test('the list does not grow forever', () => {
        let history = [];
        for (let i = 0; i < MAX_SESSIONS + 5; i++) {
            history = withSession(history, session(`2026-08-03T${String(i).padStart(2, '0')}:00:00Z`));
        }

        expect(history).toHaveLength(MAX_SESSIONS);
    });

    test('a snapshot with no key is ignored rather than stored under one', () => {
        expect(withSession([], { players: [] })).toEqual([]);
    });
});

describe('several runs as one', () => {
    const withLoot = (start, count) => session(start, ['Millennium44'], { 7: { itemHrid: '/items/coin', count } });

    test('loot is merged on the item, not on the game’s slot key', () => {
        // Two sessions number their slots independently, so merging on the raw
        // key would put the same item in two rows
        const combined = combineSessions([
            { ...withLoot('2026-08-03T01:00:00Z', 100) },
            { ...session('2026-08-03T02:00:00Z', ['Millennium44'], { 3: { itemHrid: '/items/coin', count: 50 } }) },
        ]);

        const loot = Object.values(combined.players[0].loot);
        expect(loot).toHaveLength(1);
        expect(loot[0].count).toBe(150);
    });

    test('a character is followed by name across sessions', () => {
        // Position means nothing between runs — the same person is slot 0 in one
        // and slot 3 in the next
        const combined = combineSessions([
            session('2026-08-03T01:00:00Z', ['A', 'B']),
            session('2026-08-03T02:00:00Z', ['B', 'A']),
        ]);

        expect(combined.players.map((player) => player.name).sort()).toEqual(['A', 'B']);
    });

    test('durations add, which is what makes a rate over the lot mean anything', () => {
        const combined = combineSessions([session('2026-08-03T01:00:00Z'), session('2026-08-03T02:00:00Z')]);

        expect(combined.durationSeconds).toBe(1200);
        expect(combined.sessionCount).toBe(2);
    });

    test('nothing to combine is null rather than an empty run', () => {
        expect(combineSessions([])).toBeNull();
        expect(combineSessions([{ players: [] }])).toBeNull();
        expect(combineSessions(null)).toBeNull();
    });
});

describe('describing one in a picker', () => {
    test('the time it started and how long it ran', () => {
        const line = describeSession(session('2026-08-03T01:00:00Z'), (s) => `${s}s`);

        expect(line).toContain('600s');
    });

    test('a session with no start time still gets a line', () => {
        expect(describeSession({ durationSeconds: 0 })).toContain('Unknown time');
    });
});
