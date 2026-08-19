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
        tryGet: async (key) => {
            if (game.unavailable) return null;
            return key in game.saved
                ? { found: true, value: structuredClone(game.saved[key]) }
                : { found: false, value: null };
        },
        set: async (key, value) => {
            if (game.unavailable) return false;
            game.saved[key] = structuredClone(value);
            return true;
        },
    },
}));
// Reached only through the persisted-record helper's per-character key
// support, which this unscoped record never uses
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'char1' } }));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => null,
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => game.setting },
}));

const { leaderboardXPTracker } = await import('./leaderboard-xp-tracker.js');

describe('leaderboard XP tracker', () => {
    beforeEach(async () => {
        game.setting = true;
        game.saved = {};
        game.unavailable = false;
        game.handlers = {};
        leaderboardXPTracker.disable();
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        await leaderboardXPTracker.initialize();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('the guild Level board is recorded like any other, with the rank on each reading', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'guild',
            leaderboard: { rows: [{ name: 'Someone', value2: 1000, rank: 4 }] },
        });

        expect(leaderboardXPTracker.playerXPHistory['guild_Someone']).toEqual([
            { t: expect.any(Number), xp: 1000, r: 4 },
        ]);
    });

    test('a board that reset (weekly) starts its series over instead of freezing at the old high', () => {
        leaderboardXPTracker.playerXPHistory['guild_weekly_points_G'] = [
            { t: 1000, xp: 500 },
            { t: 2000, xp: 900 },
        ];
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'guild_weekly_points',
            leaderboard: { rows: [{ name: 'G', value2: 30, rank: 1 }] },
        });

        const series = leaderboardXPTracker.playerXPHistory['guild_weekly_points_G'];
        expect(series).toHaveLength(1);
        expect(series[0].xp).toBe(30);
    });

    test('a rank change with no value change updates the rank on the standing reading', () => {
        leaderboardXPTracker.playerXPHistory['foraging_P'] = [{ t: 1000, xp: 500, r: 7 }];
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'P', value2: 500, rank: 8 }] },
        });

        expect(leaderboardXPTracker.playerXPHistory['foraging_P']).toEqual([{ t: 1000, xp: 500, r: 8 }]);
    });

    test('getPreviousRank reads the reading before the latest, and is null without two ranked readings', () => {
        leaderboardXPTracker.playerXPHistory['foraging_Q'] = [
            { t: 1000, xp: 1, r: 9 },
            { t: 5000, xp: 2, r: 6 },
        ];
        expect(leaderboardXPTracker.getPreviousRank('Q', 'foraging')).toEqual({ rank: 9, at: 1000 });
        leaderboardXPTracker.playerXPHistory['foraging_R'] = [{ t: 1000, xp: 1, r: 9 }];
        expect(leaderboardXPTracker.getPreviousRank('R', 'foraging')).toBeNull();
        expect(leaderboardXPTracker.getLatestValue('Q', 'foraging')).toBe(2);
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

        expect(leaderboardXPTracker.getPlayerStats('A', 'foraging')).toMatchObject({
            lastXPH: 0,
            lastHourXPH: 0,
            lastDayXPH: 0,
            samples: 0,
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
        await leaderboardXPTracker.history.flushed();
        expect(game.saved.playerXP).toBeDefined();

        game.saved.playerXP = undefined;
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: { rows: [{ name: 'A', value2: 1000 }] },
        });
        await leaderboardXPTracker.history.flushed();
        expect(game.saved.playerXP).toBeUndefined();
    });

    describe('the stored history survives', () => {
        const reading = (name, xp) =>
            game.handlers.leaderboard_updated({
                leaderboardCategory: 'foraging',
                leaderboard: { rows: [{ name, value2: xp }] },
            });
        const storedXP = (name) => (game.saved.playerXP?.[`foraging_${name}`] || []).map((s) => s.xp);

        test('a load that cannot read storage keeps memory instead of blanking it', async () => {
            reading('A', 1000);
            await leaderboardXPTracker.history.flushed();
            expect(storedXP('A')).toEqual([1000]);

            // A re-initialise with the database gone: the handler is re-registered
            // but the samples already held stay
            leaderboardXPTracker.initialized = false;
            game.unavailable = true;
            await leaderboardXPTracker.initialize();
            expect(leaderboardXPTracker.playerXPHistory.foraging_A.map((s) => s.xp)).toEqual([1000]);
        });

        test('a save while storage is unreadable is skipped, and lands once it is back', async () => {
            reading('A', 1000);
            await leaderboardXPTracker.history.flushed();

            game.unavailable = true;
            vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
            reading('A', 2000);
            await leaderboardXPTracker.history.flushed();
            expect(storedXP('A')).toEqual([1000]);

            game.unavailable = false;
            vi.setSystemTime(new Date('2026-01-01T02:00:00Z'));
            reading('A', 3000);
            await leaderboardXPTracker.history.flushed();
            expect(storedXP('A')).toEqual([1000, 2000, 3000]);
        });

        test('a save folds in what another tab stored meanwhile', async () => {
            reading('A', 1000);
            await leaderboardXPTracker.history.flushed();

            game.saved.playerXP = {
                foraging_A: [{ t: Date.now(), xp: 1000 }],
                foraging_B: [{ t: Date.now(), xp: 50 }],
            };
            vi.setSystemTime(new Date('2026-01-01T01:00:00Z'));
            reading('A', 2000);
            await leaderboardXPTracker.history.flushed();

            expect(storedXP('A')).toEqual([1000, 2000]);
            expect(storedXP('B')).toEqual([50]);
        });
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

    test('stats carry the span of the readings they were taken over, and the reading count', () => {
        const now = Date.now();
        leaderboardXPTracker.playerXPHistory['foraging_B'] = [
            { t: now - 3 * 60 * 60 * 1000, xp: 1000 },
            { t: now - 60 * 60 * 1000, xp: 3000 },
        ];
        const stats = leaderboardXPTracker.getPlayerStats('B', 'foraging');

        expect(stats.samples).toBe(2);
        expect(stats.lastSpanMs).toBe(2 * 60 * 60 * 1000);
        expect(stats.lastSeenAt).toBe(now - 60 * 60 * 1000);
        expect(stats.dayReadings).toBe(2);
        expect(stats.daySpanMs).toBe(2 * 60 * 60 * 1000);
        // 2000 XP over two hours
        expect(stats.lastXPH).toBe(1000);
    });

    test('a single reading reports itself as one, with when it was taken', () => {
        const now = Date.now();
        leaderboardXPTracker.playerXPHistory['foraging_C'] = [{ t: now - 5 * 60 * 1000, xp: 10 }];
        const stats = leaderboardXPTracker.getPlayerStats('C', 'foraging');

        expect(stats.samples).toBe(1);
        expect(stats.lastSeenAt).toBe(now - 5 * 60 * 1000);
        expect(stats.lastXPH).toBe(0);
    });

    test('the personal row is recorded too, though it is not among the page rows', () => {
        leaderboardXPTracker._onLeaderboardUpdated({
            leaderboardCategory: 'milking',
            leaderboard: { rows: [{ name: 'Top', value2: 100 }] },
            personalRow: { name: 'Me', value2: 42, rank: 577 },
        });

        expect(leaderboardXPTracker.playerXPHistory['milking_Me']).toHaveLength(1);
        expect(leaderboardXPTracker.playerXPHistory['milking_Me'][0].xp).toBe(42);
        expect(leaderboardXPTracker.playerXPHistory['milking_Top']).toHaveLength(1);
    });

    test('a one-column board (Guild Points) is read from value1, not the absent value2', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'guild_points',
            leaderboard: {
                columnNames: ['leaderboardPanel.guildPoints'],
                rows: [{ name: 'G', value1: 286216, rank: 12 }],
            },
        });

        expect(leaderboardXPTracker.playerXPHistory['guild_points_G'][0].xp).toBe(286216);
    });

    test('a two-column board still reads the experience in value2', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'foraging',
            leaderboard: {
                columnNames: ['leaderboardPanel.level', 'leaderboardPanel.experience'],
                rows: [{ name: 'P', value1: 150, value2: 1415884350, rank: 1 }],
            },
        });

        expect(leaderboardXPTracker.playerXPHistory['foraging_P'][0].xp).toBe(1415884350);
    });

    test('level boards (Total Level, guild Level) record the level, not the experience', () => {
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'total_level',
            leaderboard: {
                columnNames: ['leaderboardPanel.level', 'leaderboardPanel.experience'],
                rows: [{ name: 'P', value1: 2762, value2: 369997765766, rank: 1 }],
            },
        });
        game.handlers.leaderboard_updated({
            leaderboardCategory: 'guild',
            leaderboard: {
                columnNames: ['leaderboardPanel.level', 'leaderboardPanel.experience'],
                rows: [{ name: 'G', value1: 195, value2: 66911513074, rank: 1 }],
            },
        });

        expect(leaderboardXPTracker.playerXPHistory['total_level_P'][0].xp).toBe(2762);
        expect(leaderboardXPTracker.playerXPHistory['guild_G'][0].xp).toBe(195);
    });

    test('stats carry the week window too', () => {
        const now = Date.now();
        const day = 24 * 60 * 60 * 1000;
        leaderboardXPTracker.playerXPHistory['total_level_W'] = [
            { t: now - 3 * day, xp: 2700 },
            { t: now - 2 * day, xp: 2701 },
            { t: now - 60 * 60 * 1000, xp: 2703 },
        ];
        const stats = leaderboardXPTracker.getPlayerStats('W', 'total_level');

        expect(stats.weekReadings).toBe(3);
        expect(stats.weekSpanMs).toBe(3 * day - 60 * 60 * 1000);
        // 3 levels over (72 − 1) hours
        expect(stats.lastWeekXPH).toBeCloseTo(3 / 71, 6);
    });
});
