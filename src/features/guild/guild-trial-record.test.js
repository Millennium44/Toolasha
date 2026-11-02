/**
 * What a trial leaves besides its tier: packed clear stamps, how it ended, who signed up.
 *
 * Fixtures use the game's shapes: full trial hrids, nonzero tiers, character ids
 * as the wire keys them. Stamps are a synthesized run shaped like a stored
 * test-server skilling hour; names and ids are made up.
 */

import { describe, expect, test, vi } from 'vitest';

vi.mock('../../utils/game-server.js', async (importOriginal) => ({
    ...(await importOriginal()),
    isTestServer: () => false,
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (_key, _store, fallback) => fallback,
        tryGet: async () => ({ found: false, value: null }),
        set: async () => true,
        delete: async () => true,
        getAllKeys: async () => [],
    },
}));
vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => null } }));

import {
    MAX_SIGNUP_LEVELS,
    boundSignupLevels,
    decodeClears,
    encodeClears,
    mergeClears,
    mergeResults,
    mergeTrialFacts,
    resultsFromCycle,
    resultsFromHistory,
} from './guild-trial-results.js';
import {
    archiveCycle,
    archiveEarlierCycles,
    mergeTrialRecords,
    recordServerTiers,
    recordTileSample,
    rollRecordToWeek,
} from './guild-trials-store.js';
import { trialWeekStart } from './guild-trials-math.js';

const WEEK = trialWeekStart(Date.UTC(2026, 9, 14));
const NEXT_WEEK = trialWeekStart(WEEK + 8 * 86_400_000);

/** A synthesized hour: T1 banked at the start, each later tier a little slower than the one before */
const STAMPS = (() => {
    const seen = { 1: WEEK + 5 * 3_600_000 };
    const seconds = [35, 38, 40, 44, 47, 52, 57, 64, 75, 90, 110, 140];
    seconds.forEach((s, i) => {
        seen[i + 2] = seen[i + 1] + s * 1000;
    });
    return seen;
})();

const finished = (extra = {}) => ({
    name: 'Milking',
    kind: 'skilling',
    level: 170,
    tier: 13,
    points: 1500,
    pointsByTier: { 13: 1500 },
    completed: true,
    samples: [],
    tiers: [],
    tierSeenAt: STAMPS,
    ...extra,
});
const KEY = 'skilling::milking';

describe('packed clear stamps', () => {
    test('round trip, in tier order, with offsets from the earliest', () => {
        const packed = encodeClears(STAMPS);
        expect(packed.from).toBe(STAMPS[1]);
        expect(packed.t[1]).toBe(0);
        expect(packed.t[13]).toBe(STAMPS[13] - STAMPS[1]);
        expect(decodeClears(packed)).toEqual(Object.fromEntries(Object.entries(STAMPS).map(([t, a]) => [t, a])));
    });

    test('nothing usable packs to null, and junk reads back empty', () => {
        expect(encodeClears(null)).toBeNull();
        expect(encodeClears({})).toBeNull();
        expect(encodeClears({ 0: 5, x: 5, 3: 'soon' })).toBeNull();
        expect(decodeClears(null)).toEqual({});
        expect(decodeClears({ from: 'x', t: {} })).toEqual({});
    });

    test('two copies fold to every tier either holds, the earlier sighting of a shared one', () => {
        const a = encodeClears({ 1: 1000, 2: 2000, 3: 3500 });
        const b = encodeClears({ 3: 3000, 4: 4000 });
        expect(decodeClears(mergeClears(a, b))).toEqual({ 1: 1000, 2: 2000, 3: 3000, 4: 4000 });
        expect(mergeClears(null, null)).toBeNull();
        expect(decodeClears(mergeClears(a, null))).toEqual({ 1: 1000, 2: 2000, 3: 3500 });
    });
});

describe('facts merged from two copies', () => {
    test('the earlier end wins, with its own reason; a missing side adds nothing', () => {
        const merged = mergeTrialFacts({ endedAt: 500, endReason: 'early' }, { endedAt: 300, endReason: 'clock' });
        expect(merged).toEqual({ endedAt: 300, endReason: 'clock' });
        expect(mergeTrialFacts({ endedAt: 500 }, {})).toEqual({ endedAt: 500 });
        expect(mergeTrialFacts({}, { endedAt: 500, endReason: 'wiped out' })).toEqual({ endedAt: 500 });
        expect(mergeTrialFacts({}, {})).toEqual({});
    });

    test('unknown is told apart from empty: a map stated empty yields to a non-empty one, never the reverse', () => {
        const empty = { signupLevels: {}, signupLevelsAt: 10 };
        const full = { signupLevels: { 1001: 150 }, signupLevelsAt: 90 };
        expect(mergeTrialFacts(empty, full)).toEqual(full);
        expect(mergeTrialFacts(full, empty)).toEqual(full);
        expect(mergeTrialFacts(empty, {})).toEqual(empty);
        expect(mergeTrialFacts({}, {})).not.toHaveProperty('signupLevels');
    });

    test('the levels are bounded and made of whole in-range numbers', () => {
        const many = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [String(1000 + i), 100 + (i % 50)]));
        expect(Object.keys(boundSignupLevels(many))).toHaveLength(MAX_SIGNUP_LEVELS);
        expect(boundSignupLevels({ 1: 0, 2: 5000, 3: 'x', 4: 120 })).toEqual({ 4: 120 });
        expect(boundSignupLevels(null)).toEqual({});
    });
});

describe('recordServerTiers writes the facts onto the tile', () => {
    const tile = () => ({
        name: 'Milking',
        kind: 'skilling',
        samples: [],
        tiers: [],
        pointsByTier: {},
        tierSeenAt: {},
    });
    const record = (over = {}) => ({ weekStart: WEEK, tiles: { [KEY]: { ...tile(), ...over } } });

    test('the sign-up levels are written once, with when they were read', () => {
        const next = recordServerTiers(record(), KEY, {
            bankedTier: 4,
            at: 5000,
            seenAt: 6000,
            signupLevels: { 1001: 150, 1004: 99 },
        });
        expect(next.tiles[KEY]).toMatchObject({ signupLevels: { 1001: 150, 1004: 99 }, signupLevelsAt: 6000 });
        const again = recordServerTiers(next, KEY, {
            bankedTier: 4,
            at: 5000,
            seenAt: 7000,
            signupLevels: { 1001: 151 },
        });
        expect(again).toBe(next);
    });

    test('null levels (not loaded) write nothing and leave the record untouched', () => {
        const held = record({ serverTier: 4, serverTierAt: 5000, serverDone: false });
        expect(recordServerTiers(held, KEY, { bankedTier: 4, at: 5000, seenAt: 6000, signupLevels: null })).toBe(held);
    });

    test('a finished ladder is the ladder, and states its end without having watched it', () => {
        const next = recordServerTiers(record(), KEY, { bankedTier: 21, done: true, at: 9000, seenAt: 9500 });
        expect(next.tiles[KEY]).toMatchObject({ endedAt: 9000, endReason: 'ladder' });
    });

    test('a failed or cancelled write leaves the record as it was: the function returns a new object, never edits', () => {
        const held = record({ serverTier: 5, serverTierAt: 4000, serverDone: false });
        const snapshot = JSON.stringify(held);
        recordServerTiers(held, KEY, {
            bankedTier: 6,
            done: true,
            at: 5000,
            seenAt: 5100,
            deadlineAt: 5100,
            signupLevels: { 1: 100 },
        });
        expect(JSON.stringify(held)).toBe(snapshot);
    });

    test('a party that was done and a running one: only the transition is an end', () => {
        const running = recordServerTiers(record(), KEY, {
            bankedTier: 5,
            at: 4000,
            seenAt: 4100,
            deadlineAt: 900_000,
        });
        expect(running.tiles[KEY].endedAt).toBeUndefined();
        const done = recordServerTiers(running, KEY, {
            bankedTier: 5,
            done: true,
            at: 4000,
            seenAt: 800_000,
            deadlineAt: 900_000,
        });
        expect(done.tiles[KEY]).toMatchObject({ endedAt: 800_000, endReason: 'early' });
    });
});

describe('the facts survive every rebuild of a tile', () => {
    const facts = {
        endedAt: STAMPS[13] + 60_000,
        endReason: 'clock',
        signupLevels: { 1001: 150, 1002: 98 },
        signupLevelsAt: STAMPS[1] - 60_000,
    };

    test('a card sample carries them through', () => {
        const record = { weekStart: WEEK, tiles: { [KEY]: finished(facts) } };
        const next = recordTileSample(record, { name: 'Milking', kind: 'skilling', readings: [] }, STAMPS[13] + 5000);
        expect(next.tiles[KEY]).toMatchObject(facts);
    });

    test('a merge keeps what only one side saw, and the earlier end when both did', () => {
        const a = { weekStart: WEEK, tiles: { [KEY]: finished({ endedAt: 900, endReason: 'early' }) } };
        const b = {
            weekStart: WEEK,
            tiles: {
                [KEY]: finished({ endedAt: 700, endReason: 'clock', signupLevels: { 1001: 150 }, signupLevelsAt: 5 }),
            },
        };
        const merged = mergeTrialRecords(a, b).tiles[KEY];
        expect(merged).toMatchObject({ endedAt: 700, endReason: 'clock', signupLevels: { 1001: 150 } });
        // …in either order
        expect(mergeTrialRecords(b, a).tiles[KEY]).toMatchObject({ endedAt: 700, signupLevels: { 1001: 150 } });
    });

    test('two copies of one archived cycle: the one kept whole takes the end and levels only the other has', () => {
        const withTiles = (tileExtra, extraTile = {}) => ({
            weekStart: WEEK,
            tiles: {},
            history: [
                {
                    archivedAt: NEXT_WEEK,
                    reason: 'the week rolled over',
                    weekStart: WEEK,
                    tiles: { [KEY]: finished(tileExtra), ...extraTile },
                },
            ],
        });
        const fuller = withTiles({ points: 3000, pointsByTier: { 13: 3000 } });
        const other = withTiles(facts);
        const merged = mergeTrialRecords(fuller, other);
        expect(merged.history[0].tiles[KEY]).toMatchObject(facts);
        expect(merged.trialResults.find((r) => r.trial === 'milking')).toMatchObject({
            endedAt: facts.endedAt,
            endReason: 'clock',
            signupLevels: facts.signupLevels,
        });
    });

    test('a cycle cut splits the facts by the moment they were stamped', () => {
        const hour = 3_600_000;
        const cycle1 = {
            weekStart: WEEK,
            tiles: {
                [KEY]: finished({
                    endedAt: WEEK + 10 * hour,
                    endReason: 'clock',
                    signupLevels: { 1: 100 },
                    signupLevelsAt: WEEK + 9 * hour,
                }),
            },
        };
        // A later skilling hour is in progress; its start is the cut
        const start = WEEK + 24 * hour;
        const cut = archiveEarlierCycles(
            cycle1,
            {
                skilling: {
                    inProgress: true,
                    trials: {
                        '/guild_skilling/milking': {
                            tierStartedAtMs: start + hour - 100,
                            budgetRemainingMs: 100,
                            highestTier: 1,
                        },
                    },
                },
            },
            { offset: 0, at: start + 1000 }
        );
        const archived = cut.history.flatMap((cycle) => Object.values(cycle.tiles)).find((t) => t.endedAt);
        expect(archived).toMatchObject({ endedAt: WEEK + 10 * hour, signupLevels: { 1: 100 } });
        // Nothing of the old hour is on the new one
        expect(cut.tiles[KEY]?.endedAt).toBeUndefined();
        expect(cut.tiles[KEY]?.signupLevels).toBeUndefined();
    });
});

describe('results keep the facts after the archive is gone', () => {
    const cycleOf = (tileExtra) => ({
        archivedAt: NEXT_WEEK,
        reason: 'the week rolled over',
        weekStart: WEEK,
        tiles: { [KEY]: finished(tileExtra) },
    });

    test('a result carries packed clears, the end and the levels', () => {
        const [result] = resultsFromCycle(
            cycleOf({ endedAt: 42, endReason: 'clock', signupLevels: { 1001: 150 }, signupLevelsAt: 7 })
        );
        expect(decodeClears(result.clears)).toEqual(STAMPS);
        expect(result).toMatchObject({
            endedAt: 42,
            endReason: 'clock',
            signupLevels: { 1001: 150 },
            signupLevelsAt: 7,
        });
    });

    test('a tile from before these existed gives a result with none of them beyond the stamps it had', () => {
        const [result] = resultsFromCycle(cycleOf({ tierSeenAt: undefined }));
        expect(result).not.toHaveProperty('endedAt');
        expect(result).not.toHaveProperty('signupLevels');
        expect(result).not.toHaveProperty('clears');
        expect(result.cardTier).toBe(13);
    });

    test('two copies of one result fold: stamps unioned, end and levels from whichever has them', () => {
        const first = resultsFromCycle(cycleOf({ tierSeenAt: { 1: STAMPS[1], 2: STAMPS[2] } }))[0];
        const second = resultsFromCycle(
            cycleOf({ tierSeenAt: { 2: STAMPS[2] + 500, 3: STAMPS[3] }, endedAt: 42, endReason: 'early' })
        )[0];
        const [folded] = mergeResults([first], [second]);
        expect(decodeClears(folded.clears)).toEqual({ 1: STAMPS[1], 2: STAMPS[2], 3: STAMPS[3] });
        expect(folded).toMatchObject({ endedAt: 42, endReason: 'early' });
    });

    test('a record rolled to a new week keeps the facts in its results when the cycle is later capped away', () => {
        const record = { weekStart: WEEK, tiles: { [KEY]: finished({ endedAt: 42, endReason: 'clock' }) } };
        const rolled = rollRecordToWeek(record, NEXT_WEEK);
        const dropped = { ...rolled, history: [] };
        const kept = mergeResults(dropped.trialResults, resultsFromHistory(dropped.history));
        expect(kept[0]).toMatchObject({ endedAt: 42, endReason: 'clock' });
        expect(decodeClears(kept[0].clears)).toEqual(STAMPS);
    });

    test('an older build’s reader ignores the new fields: a result is still a result without them', () => {
        const [result] = resultsFromCycle(cycleOf({ endedAt: 42, endReason: 'clock' }));
        const { clears: _clears, endedAt: _e, endReason: _r, ...old } = result;
        const [merged] = mergeResults([old], [result]);
        expect(merged).toMatchObject({ trial: 'milking', cardTier: 13, endedAt: 42 });
        // …and a newer build reads the old shape as it always did
        expect(mergeResults([old])[0]).toEqual(old);
    });

    test('a cycle archived off another guild’s record files no facts', () => {
        const archived = archiveCycle(
            { weekStart: WEEK, tiles: { [KEY]: finished({ endedAt: 42 }) } },
            'belongs to another guild'
        );
        expect(archived.trialResults).toEqual([]);
    });
});
