import { describe, test, expect, beforeEach, vi } from 'vitest';

// `unavailable` stands in for a dropped IndexedDB connection: `tryGet` then
// says the read could not be made, which is not the same as "nothing there"
const storageMock = vi.hoisted(() => {
    const store = new Map();
    return {
        store,
        unavailable: false,
        tryGet: vi.fn(async (key) => {
            if (storageMock.unavailable) return null;
            return store.has(key)
                ? { found: true, value: structuredClone(store.get(key)) }
                : { found: false, value: null };
        }),
        get: vi.fn(async (key, _store, fallback = null) => (store.has(key) ? store.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            store.set(key, structuredClone(value));
            return true;
        }),
    };
});
vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
const dataManagerMock = vi.hoisted(() => ({
    on: () => {},
    off: () => {},
    characterData: null,
    initClientData: null,
    getInitClientData: () => dataManagerMock.initClientData,
}));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../utils/performance-monitor.js', () => ({ default: { startSpan: () => () => {} } }));

import {
    pushXP,
    dropFlatRepeats,
    calcStats,
    guildLevelFromXP,
    pruneDepartedMembers,
    mergeXPHistories,
    guildXPTracker,
    calcTimeToLevel,
    calcNextMemberSlotLevel,
    calcXPRemainingForLevel,
    calcStableRate,
    resolveStableRate,
    calcNextMemberSlotETA,
} from './guild-xp-tracker.js';

const MIN = 60 * 1000;

describe('pushXP', () => {
    test('a reading that repeats the last one carries nothing and is dropped', () => {
        // The guild leaderboard refreshes every 20 minutes, so opening the panel
        // three times in a row hands back the same snapshot three times
        const history = [];
        pushXP(history, { t: 0, xp: 1000 });
        pushXP(history, { t: 2 * MIN, xp: 1000 });
        pushXP(history, { t: 4 * MIN, xp: 1000 });
        expect(history).toHaveLength(1);
    });

    test('a flat reading is kept once the refresh window has passed', () => {
        // Then it means the guild really did earn nothing, which is a fact
        const history = [];
        pushXP(history, { t: 0, xp: 1000 });
        pushXP(history, { t: 25 * MIN, xp: 1000 });
        expect(history).toHaveLength(2);
    });

    test('real progress is always recorded', () => {
        const history = [];
        pushXP(history, { t: 0, xp: 1000 });
        pushXP(history, { t: 1 * MIN, xp: 1200 });
        expect(history).toHaveLength(2);
    });

    test('experience never goes backwards', () => {
        const history = [{ t: 0, xp: 1000 }];
        pushXP(history, { t: MIN, xp: 900 });
        expect(history).toHaveLength(1);
    });
});

describe('the blank-column bug', () => {
    test('repeat readings used to bury the rate, and no longer do', () => {
        // A day of real progress, then the panel opened twice in quick
        // succession — which is what every guild's history looked like
        const poisoned = [
            { t: 0, xp: 1_000_000 },
            { t: 12 * 60 * MIN, xp: 2_000_000 },
            { t: 12 * 60 * MIN + MIN, xp: 2_000_000 },
            { t: 12 * 60 * MIN + 2 * MIN, xp: 2_000_000 },
        ];
        // The last two readings are identical, so the rate between them is zero
        expect(calcStats(poisoned).lastXPH).toBe(0);

        // Healed, the newest pair spans real progress again
        const healed = dropFlatRepeats(poisoned);
        expect(healed).toHaveLength(2);
        expect(calcStats(healed).lastXPH).toBeCloseTo(1_000_000 / 12, 6);
    });

    test('healing leaves a genuinely idle stretch alone', () => {
        const idle = [
            { t: 0, xp: 1_000_000 },
            { t: 60 * MIN, xp: 1_000_000 },
        ];
        expect(dropFlatRepeats(idle)).toHaveLength(2);
        expect(calcStats(idle).lastXPH).toBe(0);
    });

    test('a history too short to rate says zero rather than guessing', () => {
        expect(calcStats([{ t: 0, xp: 5 }]).lastXPH).toBe(0);
        expect(calcStats([]).lastXPH).toBe(0);
        expect(calcStats(null).lastXPH).toBe(0);
    });
});

describe('guildLevelFromXP', () => {
    // The table is indexed from level 1 at zero XP, so an off-by-one here shows
    // up as a guild being told it is a level above or below the one the game
    // shows it — the kind of wrong that is noticed immediately and trusted never
    // again.
    test('a guild with no experience is level 1', () => {
        expect(guildLevelFromXP(0)).toMatchObject({ level: 1, nextLevelXP: 33, xpToNext: 33 });
    });

    test('crossing a threshold is the level', () => {
        expect(guildLevelFromXP(33).level).toBe(2);
        expect(guildLevelFromXP(75).level).toBe(2);
        expect(guildLevelFromXP(76).level).toBe(3);
    });

    test('past the end of the table there is nothing left to work towards', () => {
        const maxed = guildLevelFromXP(200_000_000_000);
        expect(maxed.nextLevelXP).toBeNull();
        expect(maxed.xpToNext).toBeNull();
    });

    test('a missing total is level 1 rather than a crash', () => {
        expect(guildLevelFromXP(undefined).level).toBe(1);
    });
});

describe('pruneDepartedMembers', () => {
    // The member history map never forgets, so somebody who left the guild kept
    // their weekly rate and sat in the roster's "Gone quiet" list permanently
    test('drops whoever the roster no longer lists, and says who', () => {
        const history = { 101: [{ t: 1, xp: 5 }], 9349: [{ t: 1, xp: 9000 }] };

        expect(pruneDepartedMembers(history, ['101'])).toEqual(['9349']);
        expect(Object.keys(history)).toEqual(['101']);
    });

    test('ids compare as strings, whichever way they arrived', () => {
        const history = { 101: [{ t: 1, xp: 5 }] };
        expect(pruneDepartedMembers(history, [101])).toEqual([]);
        expect(Object.keys(history)).toEqual(['101']);
    });

    test('an empty roster is not knowledge, and empties nothing', () => {
        // A message that arrived early, or one this script could not read, must
        // not be allowed to delete the guild
        const history = { 101: [{ t: 1, xp: 5 }] };
        expect(pruneDepartedMembers(history, [])).toEqual([]);
        expect(pruneDepartedMembers(history, null)).toEqual([]);
        expect(Object.keys(history)).toEqual(['101']);
    });

    test('nothing stored is nothing to drop', () => {
        expect(pruneDepartedMembers(null, ['1'])).toEqual([]);
        expect(pruneDepartedMembers({}, ['1'])).toEqual([]);
    });
});

describe('mergeXPHistories', () => {
    test('series are unioned by sample time, memory winning the same instant', () => {
        const stored = {
            Milky: [
                { t: 1, xp: 10 },
                { t: 2, xp: 20 },
            ],
            Other: [{ t: 5, xp: 1 }],
        };
        const memory = {
            Milky: [
                { t: 2, xp: 21 },
                { t: 3, xp: 30 },
            ],
            Third: [{ t: 9, xp: 9 }],
        };

        const merged = mergeXPHistories(stored, memory);
        expect(merged.Milky).toEqual([
            { t: 1, xp: 10 },
            { t: 2, xp: 21 },
            { t: 3, xp: 30 },
        ]);
        // Series only one side knows are kept, not overwritten
        expect(merged.Other).toEqual([{ t: 5, xp: 1 }]);
        expect(merged.Third).toEqual([{ t: 9, xp: 9 }]);
    });

    test('garbage on either side is not a crash', () => {
        expect(mergeXPHistories(null, { a: [{ t: 1, xp: 1 }] })).toEqual({ a: [{ t: 1, xp: 1 }] });
        expect(mergeXPHistories({ a: 'nope' }, { a: [{ t: 1, xp: 1 }] })).toEqual({ a: [{ t: 1, xp: 1 }] });
    });
});

describe('the XP history cannot be wiped by a failed read or a stale copy', () => {
    const GUILD_KEY = 'guildXP_Milky';
    const MEMBER_KEY = 'memberXP_g1';
    const stored = (key) => storageMock.store.get(key);
    /** A login snapshot, as the tracker sees it */
    const initData = (xp = 1000) => ({
        guild: { name: 'Milky', experience: xp, createdAt: 0 },
        guildCharacterMap: { 101: { guildID: 'g1', guildExperience: 5 } },
        guildSharableCharacterMap: { 101: { name: 'Ada' } },
    });

    beforeEach(() => {
        storageMock.store.clear();
        storageMock.unavailable = false;
        storageMock.set.mockClear();
        guildXPTracker.disable();
        guildXPTracker.ownGuildName = null;
        guildXPTracker.ownGuildID = null;
    });

    test('a load while storage is unavailable keeps the in-memory history rather than blanking it', async () => {
        guildXPTracker.ownGuildName = 'Milky';
        guildXPTracker.ownGuildID = 'g1';
        guildXPTracker.guildXPHistory = { Milky: [{ t: 1, xp: 1 }] };
        guildXPTracker.memberXPHistory = { 101: [{ t: 1, xp: 1 }] };
        storageMock.unavailable = true;

        await guildXPTracker._onCharacterInit(initData());

        expect(guildXPTracker.guildXPHistory.Milky.map((s) => s.t)).toEqual([1, expect.any(Number)]);
        expect(guildXPTracker.memberXPHistory[101].map((s) => s.t)).toEqual([1, expect.any(Number)]);
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored history', async () => {
        storageMock.store.set(GUILD_KEY, {
            Milky: [
                { t: 1, xp: 1 },
                { t: 2, xp: 2 },
            ],
        });
        // The failure mode that used to wipe histories: memory emptied by a
        // failed load, then an update saves that emptiness back
        guildXPTracker.guildXPHistory = {};
        storageMock.unavailable = true;

        await guildXPTracker._onGuildUpdated({ guild: { name: 'Milky', experience: 3 } });
        await guildXPTracker._saveChains.get(GUILD_KEY);

        expect(stored(GUILD_KEY).Milky.map((s) => s.t)).toEqual([1, 2]);
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('a save merges what is stored under what is in memory, so another tab\u2019s samples survive', async () => {
        storageMock.store.set(GUILD_KEY, { Milky: [{ t: 1, xp: 1 }], Other: [{ t: 1, xp: 1 }] });
        guildXPTracker.guildXPHistory = { Milky: [{ t: 2, xp: 2 }] };

        await guildXPTracker._onGuildUpdated({ guild: { name: 'Milky', experience: 3 } });
        await guildXPTracker._saveChains.get(GUILD_KEY);

        expect(stored(GUILD_KEY).Milky.map((s) => s.t)).toEqual([1, 2, expect.any(Number)]);
        expect(stored(GUILD_KEY).Other).toEqual([{ t: 1, xp: 1 }]);
        // And memory has learned it, in place
        expect(guildXPTracker.guildXPHistory.Other).toEqual([{ t: 1, xp: 1 }]);
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        storageMock.store.set(MEMBER_KEY, { 101: [{ t: 1, xp: 1 }] });
        guildXPTracker.ownGuildID = 'g1';
        guildXPTracker.memberXPHistory = {};
        storageMock.unavailable = true;
        // Two readings at two distinct instants, whatever the machine's clock does
        const base = Date.now();
        vi.useFakeTimers();
        try {
            vi.setSystemTime(base);
            await guildXPTracker._onMembersUpdated({
                guildCharacterMap: { 101: { guildID: 'g1', guildExperience: 2 } },
            });
            await guildXPTracker._saveChains.get(MEMBER_KEY);
            expect(stored(MEMBER_KEY)[101].map((s) => s.t)).toEqual([1]);

            storageMock.unavailable = false;
            vi.setSystemTime(base + 60_000);
            await guildXPTracker._onMembersUpdated({
                guildCharacterMap: { 101: { guildID: 'g1', guildExperience: 3 } },
            });
            await guildXPTracker._saveChains.get(MEMBER_KEY);

            expect(stored(MEMBER_KEY)[101].map((s) => s.xp)).toEqual([1, 2, 3]);
        } finally {
            vi.useRealTimers();
        }
    });

    test('switching guild loads that guild\u2019s record; a failed read starts it empty, not with the old guild', async () => {
        guildXPTracker.ownGuildID = 'g1';
        guildXPTracker.memberXPHistory = { 101: [{ t: 1, xp: 1 }] };
        storageMock.store.set('memberXP_g2', { 202: [{ t: 1, xp: 7 }] });

        await guildXPTracker._onMembersUpdated({ guildCharacterMap: { 202: { guildID: 'g2', guildExperience: 8 } } });
        await guildXPTracker._saveChains.get('memberXP_g2');
        expect(Object.keys(guildXPTracker.memberXPHistory)).toEqual(['202']);
        expect(stored('memberXP_g2')[202].map((s) => s.xp)).toEqual([7, 8]);

        storageMock.unavailable = true;
        await guildXPTracker._onMembersUpdated({ guildCharacterMap: { 303: { guildID: 'g3', guildExperience: 9 } } });
        await guildXPTracker._saveChains.get('memberXP_g3');
        expect(Object.keys(guildXPTracker.memberXPHistory)).toEqual(['303']);
        expect(stored('memberXP_g3')).toBeUndefined(); // refused, not written blind
    });

    test('changing guild reads the new guild’s record instead of copying the old one across', async () => {
        // `_persist` writes the whole `guildName → series` map under the key
        // of whichever guild is current, so the map in hand has to be the
        // arriving guild's before the write
        guildXPTracker.ownGuildName = 'Testmaxxing';
        guildXPTracker.guildXPHistory = { Testmaxxing: [{ t: 1, xp: 100 }] };
        storageMock.store.set('guildXP_SuperMoo', { SuperMoo: [{ t: 1, xp: 5 }] });

        await guildXPTracker._onGuildUpdated({ guild: { name: 'SuperMoo', experience: 6 } });
        await guildXPTracker._saveChains.get('guildXP_SuperMoo');

        expect(Object.keys(guildXPTracker.guildXPHistory)).toEqual(['SuperMoo']);
        expect(stored('guildXP_SuperMoo').Testmaxxing).toBeUndefined();
        expect(stored('guildXP_SuperMoo').SuperMoo.map((s) => s.xp)).toEqual([5, 6]);
        // The guild they left keeps its own, for if they go back
        expect(stored('guildXP_Testmaxxing')).toBeUndefined();
    });

    test('resetMemberData is an intentional clear and writes as-is', async () => {
        storageMock.store.set(MEMBER_KEY, { 101: [{ t: 1, xp: 1 }] });
        guildXPTracker.ownGuildID = 'g1';
        guildXPTracker.memberXPHistory = { 101: [{ t: 1, xp: 1 }] };

        await guildXPTracker.resetMemberData();
        expect(stored(MEMBER_KEY)).toEqual({});
    });
});

const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('calcTimeToLevel - exact-threshold boundary', () => {
    test('does not return null when currentXP lands exactly on a level threshold', () => {
        // 76 is a real threshold in LEVEL_EXPERIENCE_TABLE (level 3). Landing exactly on it
        // means "just reached this level" - there must still be a well-defined ETA to the
        // level after it, not a bogus null.
        const result = calcTimeToLevel(76, 100);
        expect(result).not.toBeNull();
        // Next threshold after 76 is 132: (132-76)/100 * 3600000
        expect(result).toBeCloseTo(((132 - 76) / 100) * 3600000, 0);
    });

    test('still returns the correct ETA for an ordinary in-between XP value', () => {
        const result = calcTimeToLevel(100, 100);
        expect(result).toBeCloseTo(((132 - 100) / 100) * 3600000, 0);
    });

    test('returns null when the rate is zero or negative', () => {
        expect(calcTimeToLevel(100, 0)).toBeNull();
        expect(calcTimeToLevel(100, -5)).toBeNull();
    });
});

describe('calcNextMemberSlotLevel', () => {
    test.each([
        [1, 3],
        [2, 3],
        [3, 6],
        [4, 6],
        [44, 45],
        [45, 48],
        [46, 48],
        [47, 48],
        [48, 51],
    ])('guild level %i targets level %i', (level, expected) => {
        expect(calcNextMemberSlotLevel(level)).toBe(expected);
    });
});

describe('calcXPRemainingForLevel', () => {
    // Native shape: indexed by level, index 0 unused
    const table = [0, 0, 33, 76, 132, 202];

    test('returns native-table XP remaining for a target level', () => {
        expect(calcXPRemainingForLevel(10, 3, table)).toBe(76 - 10);
    });

    test('exact current-XP-at-threshold does not return a negative or incorrect value', () => {
        expect(calcXPRemainingForLevel(76, 3, table)).toBe(0);
    });

    test('clamps to 0 rather than negative when currentXP already exceeds targetXP', () => {
        expect(calcXPRemainingForLevel(500, 3, table)).toBe(0);
    });

    test('returns null when the table has no entry for targetLevel (index out of range)', () => {
        expect(calcXPRemainingForLevel(10, 999, table)).toBeNull();
    });

    test('returns null when no table is supplied', () => {
        expect(calcXPRemainingForLevel(10, 3, undefined)).toBeNull();
    });
});

describe('calcStableRate', () => {
    test('is null with fewer than 2 points in the window', () => {
        expect(calcStableRate([{ t: Date.now(), xp: 100 }], DAY)).toBeNull();
    });

    test('is null when the two points span too little of the window (noisy sample)', () => {
        const now = Date.now();
        const arr = [
            { t: now - 2 * MIN, xp: 100 },
            { t: now, xp: 200 },
        ];
        // 2 minutes span inside a 24h window is far short of the 25% (6h) requirement.
        expect(calcStableRate(arr, DAY)).toBeNull();
    });

    test('computes a real rate when the span covers a meaningful fraction of the window', () => {
        const now = Date.now();
        const arr = [
            { t: now - 20 * HOUR, xp: 0 },
            { t: now, xp: 1000 },
        ];
        expect(calcStableRate(arr, DAY)).toBeCloseTo(50, 0); // 1000 xp / 20h = 50 xp/h
    });
});

describe('resolveStableRate', () => {
    test('prefers a stable 24h rate over a stable 1h rate', () => {
        const now = Date.now();
        const arr = [
            { t: now - 20 * HOUR, xp: 0 },
            { t: now - 40 * MIN, xp: 1000 },
            { t: now, xp: 1100 },
        ];
        const result = resolveStableRate(arr);
        expect(result.basis).toBe('24h');
    });

    test('falls back to a stable 1h rate when the 24h window is not stable', () => {
        const now = Date.now();
        const arr = [
            { t: now - 40 * MIN, xp: 0 },
            { t: now, xp: 100 },
        ];
        const result = resolveStableRate(arr);
        expect(result.basis).toBe('1h');
    });

    test('is null when neither window has a stable sample (collecting data)', () => {
        const now = Date.now();
        const arr = [
            { t: now - 2 * MIN, xp: 0 },
            { t: now, xp: 10 },
        ];
        expect(resolveStableRate(arr)).toBeNull();
    });

    test('a stable rate of exactly zero is still resolved (not treated as unstable)', () => {
        const now = Date.now();
        const arr = [
            { t: now - 20 * HOUR, xp: 500 },
            { t: now, xp: 500 },
        ];
        const result = resolveStableRate(arr);
        expect(result).not.toBeNull();
        expect(result.rate).toBe(0);
        expect(result.basis).toBe('24h');
    });
});

describe('calcNextMemberSlotETA', () => {
    const table = [0, 0, 33, 76, 132, 202, 286, 386, 503, 637, 791, 964, 1159, 1377, 1620, 1891];

    test('returns an ok ETA when a stable rate exists', () => {
        const now = Date.now();
        const history = [
            { t: now - 20 * HOUR, xp: 10 },
            { t: now, xp: 50 },
        ];
        const result = calcNextMemberSlotETA(2, 50, history, table);
        expect(result.status).toBe('ok');
        expect(result.targetLevel).toBe(3);
        expect(result.xpRemaining).toBe(table[3] - 50);
        expect(result.rateBasis).toBe('24h');
        expect(result.etaMs).toBeGreaterThan(0);
    });

    test('returns collecting-data status when no stable sample exists yet', () => {
        const now = Date.now();
        const history = [{ t: now - MIN, xp: 10 }];
        const result = calcNextMemberSlotETA(2, 10, history, table);
        expect(result.status).toBe('collecting-data');
        expect(result.targetLevel).toBe(3);
        expect(result).not.toHaveProperty('etaMs');
    });

    test('returns zero-rate status instead of a fake infinite ETA when the stable rate is 0', () => {
        const now = Date.now();
        const history = [
            { t: now - 20 * HOUR, xp: 10 },
            { t: now, xp: 10 },
        ];
        const result = calcNextMemberSlotETA(2, 10, history, table);
        expect(result.status).toBe('zero-rate');
        expect(result).not.toHaveProperty('etaMs');
    });

    test('a guild level already on a slot boundary targets the next boundary, not itself', () => {
        const result = calcNextMemberSlotETA(3, 0, [], table);
        expect(result.targetLevel).toBe(6);
    });

    test('Guild Hall / building levels play no role - only guild level feeds the target', () => {
        // No building-level parameter exists on this function at all; this is a documentation
        // test that the signature never grows one accidentally.
        expect(calcNextMemberSlotETA.length).toBe(4);
    });

    test('returns null when the level table has no entry for the target level', () => {
        const result = calcNextMemberSlotETA(2, 10, [], [0, 0, 33]);
        expect(result).toBeNull();
    });

    test('returns null when guildLevel is not a number', () => {
        expect(calcNextMemberSlotETA(null, 10, [], table)).toBeNull();
    });
});

describe('getNextMemberSlotETA', () => {
    beforeEach(() => {
        guildXPTracker.ownGuildName = 'Milky Way';
        guildXPTracker.ownGuildLevel = null;
        guildXPTracker.guildXPHistory = {};
        dataManagerMock.initClientData = null;
    });

    test('only answers for the player’s own guild', () => {
        guildXPTracker.guildXPHistory = { Other: [{ t: Date.now(), xp: 50 }] };
        expect(guildXPTracker.getNextMemberSlotETA('Other')).toBeNull();
    });

    test('without a native table or a reported level it reads both off the local XP curve', () => {
        // 50 XP is level 2 (crossed 33, not yet 76); the next slot level is 3 at 76 XP
        guildXPTracker.guildXPHistory = { 'Milky Way': [{ t: Date.now(), xp: 50 }] };
        const result = guildXPTracker.getNextMemberSlotETA('Milky Way');
        expect(result.targetLevel).toBe(3);
        expect(result.xpRemaining).toBe(76 - 50);
        expect(result.status).toBe('collecting-data');
    });

    test('a level reported by the game wins over the one derived from XP', () => {
        guildXPTracker.ownGuildLevel = 3;
        guildXPTracker.guildXPHistory = { 'Milky Way': [{ t: Date.now(), xp: 50 }] };
        expect(guildXPTracker.getNextMemberSlotETA('Milky Way').targetLevel).toBe(6);
    });

    test('the native level table is preferred when initClientData has one', () => {
        dataManagerMock.initClientData = { levelExperienceTable: [0, 0, 40, 90, 150] };
        guildXPTracker.guildXPHistory = { 'Milky Way': [{ t: Date.now(), xp: 50 }] };
        expect(guildXPTracker.getNextMemberSlotETA('Milky Way').xpRemaining).toBe(90 - 50);
    });
});
