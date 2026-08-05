import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const game = vi.hoisted(() => ({ setting: true, saved: {}, handlers: {} }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => {
            game.handlers[event] = handler;
        },
        off: (event, handler) => {
            if (game.handlers[event] === handler) delete game.handlers[event];
        },
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, storeName, defaultValue) => game.saved[key] ?? defaultValue,
        set: async (key, value) => {
            game.saved[key] = value;
        },
    },
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));

const { leaderboardXPTracker } = await import('./leaderboard-xp-tracker.js');

describe('leaderboard XP tracker', () => {
    beforeEach(async () => {
        game.setting = true;
        game.saved = {};
        game.handlers = {};
        leaderboardXPTracker.disable();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        await leaderboardXPTracker.initialize();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('the guild category is not recorded here — it has its own tracker', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'guild',
            leaderboard: { rows: [{ name: 'Someone', value2: 1000 }] },
        });

        expect(leaderboardXPTracker.getPlayerStats('Someone', 'guild')).toEqual({
            lastXPH: 0,
            lastHourXPH: 0,
            lastDayXPH: 0,
        });
    });

    test('a single reading is not enough for a rate', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'Millennium44', value2: 5000 }] },
        });

        expect(leaderboardXPTracker.getPlayerStats('Millennium44', 'foraging').lastXPH).toBe(0);
    });

    test('two readings an hour apart give an exact XP/hr', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'Millennium44', value2: 1000 }] },
        });

        vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'Millennium44', value2: 3000 }] },
        });

        const stats = leaderboardXPTracker.getPlayerStats('Millennium44', 'foraging');
        expect(stats.lastXPH).toBe(2000);
        expect(stats.lastHourXPH).toBe(2000);
    });

    test('a repeated identical XP reading does not extend the window or reset the rate', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'Millennium44', value2: 1000 }] },
        });
        vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'Millennium44', value2: 3000 }] },
        });
        // A navigation that reports the same XP again, moments later
        vi.setSystemTime(new Date('2026-01-01T00:31:00Z'));
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'Millennium44', value2: 3000 }] },
        });

        // Rate is still computed from the two genuine readings (30 minutes, +2000xp = 4000/hr)
        expect(leaderboardXPTracker.getPlayerStats('Millennium44', 'foraging').lastXPH).toBe(4000);
    });

    test('players and categories are tracked independently', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: {
                rows: [
                    { name: 'A', value2: 1000 },
                    { name: 'B', value2: 500 },
                ],
            },
        });
        vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: {
                rows: [
                    { name: 'A', value2: 2000 },
                    { name: 'B', value2: 4500 },
                ],
            },
        });

        expect(leaderboardXPTracker.getPlayerStats('A', 'foraging').lastXPH).toBe(1000);
        expect(leaderboardXPTracker.getPlayerStats('B', 'foraging').lastXPH).toBe(4000);
    });

    test('a row missing a name or value is skipped, not recorded as zero', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: null, value2: 1000 }, { name: 'A' }] },
        });

        expect(leaderboardXPTracker.getPlayerStats('A', 'foraging')).toEqual({
            lastXPH: 0,
            lastHourXPH: 0,
            lastDayXPH: 0,
        });
    });

    test('an empty rows array does not throw and records nothing', () => {
        expect(() =>
            game.handlers.leaderboard_updated({ leaderboardCategory: 'foraging', leaderboard: { rows: [] } })
        ).not.toThrow();
    });

    test('remembers the most recently seen category', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'enhancing',
            leaderboard: { rows: [{ name: 'A', value2: 1 }] },
        });

        expect(leaderboardXPTracker.getLastLeaderboardCategory()).toBe('enhancing');
    });

    test('the last-hour rate only spans readings within the last hour', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'A', value2: 0 }] },
        });
        // Old reading, outside the 1h window by the time of the last one
        vi.setSystemTime(new Date('2026-01-01T00:30:00Z'));
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'A', value2: 3000 }] },
        });
        vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'A', value2: 4000 }] },
        });

        const stats = leaderboardXPTracker.getPlayerStats('A', 'foraging');
        // lastXPH is just the final two readings: +1000 xp over 1.5h = 666.67/hr
        expect(stats.lastXPH).toBeCloseTo(666.67, 1);
        // lastHourXPH excludes the reading from 2 hours before the last one
        expect(stats.lastHourXPH).toBe(0);
    });

    test('changed history is persisted; an unchanged batch is not', async () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'A', value2: 1000 }] },
        });
        expect(game.saved.playerXP).toBeDefined();

        game.saved.playerXP = undefined;
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'A', value2: 1000 }] },
        });
        expect(game.saved.playerXP).toBeUndefined();
    });

    test('disabled by setting, initialize does not subscribe', async () => {
        leaderboardXPTracker.disable();
        game.setting = false;

        await leaderboardXPTracker.initialize();

        expect(game.handlers.leaderboard_updated).toBeUndefined();
    });

    test('disable clears history and the last category', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'A', value2: 1000 }] },
        });

        leaderboardXPTracker.disable();

        expect(leaderboardXPTracker.getLastLeaderboardCategory()).toBeNull();
        expect(leaderboardXPTracker.getPlayerStats('A', 'foraging').lastXPH).toBe(0);
    });
});
