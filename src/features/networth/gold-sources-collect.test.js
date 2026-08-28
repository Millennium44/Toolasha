/**
 * The live combat session joining the archived ones.
 *
 * The attribution math is tested in `gold-sources.test.js`; what this pins is
 * the wiring bug it cannot see — a character deep in one long, never-archived
 * fight had today's whole loot in no session at all, so the combat row read 0
 * while the residual carried the day.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const game = vi.hoisted(() => ({
    archived: [],
    live: null,
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getActionDetails: () => null },
}));
vi.mock('../market/trade-ledger-store.js', () => ({
    default: { isReady: () => false, getRecords: () => [] },
}));
vi.mock('../combat-stats/combat-session-history.js', () => ({
    loadSessions: async () => game.archived,
    sessionKey: (data) =>
        data?.players?.length && data?.combatStartTime
            ? `${data.players.map((p) => p.name).join(',')}|${data.combatStartTime}`
            : null,
    MAX_SESSIONS: 20,
}));
vi.mock('../combat-stats/combat-stats-data-collector.js', () => ({
    default: { getLatestData: () => game.live },
}));
vi.mock('../enhancement/enhancement-storage.js', () => ({ loadSessions: async () => ({}) }));
vi.mock('../alchemy/alchemy-session-store.js', () => ({
    createAlchemySessionStore: () => ({ load: async () => [] }),
    NO_CHARACTER: 'none',
}));
vi.mock('../actions/loot-log-history.js', () => ({
    default: { getHistoricalEntries: async () => [] },
}));
vi.mock('./networth-history.js', () => ({ default: { getHistory: () => [] } }));
vi.mock('./production-income-recorder.js', () => ({ default: { load: async () => [] } }));
vi.mock('../../utils/market-data.js', () => ({ getItemPrice: () => 0 }));

const { collectGoldSourceInputs } = await import('./gold-sources-collect.js');

const session = (start, names = ['Me']) => ({
    key: `${names.join(',')}|${start}`,
    combatStartTime: start,
    players: names.map((name) => ({ name, isCurrentPlayer: true, loot: {} })),
});

beforeEach(() => {
    game.archived = [];
    game.live = null;
});

describe('the live combat session', () => {
    test('a run in progress counts even though nothing has archived it yet', async () => {
        game.live = {
            combatStartTime: '2026-08-28T01:00:00Z',
            players: [{ name: 'Me', isCurrentPlayer: true, loot: {} }],
        };

        const inputs = await collectGoldSourceInputs({ price: () => 0 });
        expect(inputs.combatSessions).toHaveLength(1);
        expect(inputs.combatSessions[0].combatStartTime).toBe('2026-08-28T01:00:00Z');
    });

    test('a live run the archive already holds is not counted twice', async () => {
        game.archived = [session('2026-08-28T01:00:00Z')];
        game.live = {
            combatStartTime: '2026-08-28T01:00:00Z',
            players: [{ name: 'Me', isCurrentPlayer: true, loot: {} }],
        };

        const inputs = await collectGoldSourceInputs({ price: () => 0 });
        expect(inputs.combatSessions).toHaveLength(1);
    });

    test('no live run means the archive alone, and an empty one stays out', async () => {
        game.archived = [session('2026-08-27T01:00:00Z')];
        game.live = { combatStartTime: '2026-08-28T01:00:00Z', players: [] };

        const inputs = await collectGoldSourceInputs({ price: () => 0 });
        expect(inputs.combatSessions).toHaveLength(1);
        expect(inputs.combatSessions[0].combatStartTime).toBe('2026-08-27T01:00:00Z');
    });
});
