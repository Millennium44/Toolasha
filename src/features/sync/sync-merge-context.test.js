/**
 * A registered merge sees a fold context only when it asked for one, through the real upload path.
 *
 * Upload paths hand `registration.merge` a third argument. Two merges read a third argument of their own, a
 * clock: `mergeBoards(base, incoming, now)` capped every board to `Math.min(at, {forUpload: true})`, which is
 * NaN, so every board reached the gist stamped `at: null`; `mergeAverageBaselines(local, incoming, now)` got a
 * NaN horizon, which switches its future-stamp guard off. These run the real registrations through
 * `mergeForUpload`, `addsToRemote` and the pull fold, the way two devices exchange them.
 */
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { addsToRemote, exchangeBaseline, mergeForUpload, trimmedRegisteredKeys } from './sync-payload.js';
import config from '../../core/config.js';
import { mergeForKey } from '../../utils/sync-merge-registry.js';
import { boardKey, buildNameIndex, mergeBoards } from '../../utils/rank-badge-data.js';
import { BASELINE_FUTURE_TOLERANCE_MS, mergeAverageBaselines } from '../combat/dungeon-tracker-storage.js';

await import('../leaderboard/leaderboard-rank-badges.js');
await import('../combat/labyrinth-room-logs.js');
await import('../market/estimated-listing-age.js');
await import('../networth/item-flow-recorder.js');

const NOW = Date.UTC(2026, 10, 3, 12);
const DAY = 24 * 60 * 60 * 1000;

const TOTAL = boardKey('standard', 'total_level');
const MILKING = boardKey('standard', 'milking');
const FORAGING = boardKey('standard', 'foraging');

const payload = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: 'x', syncScope: 'everything', stores });
const boardsPayload = (boards) => payload({ leaderboardHistory: { rankBoards: boards } });
const boardsIn = (text) => JSON.parse(text).stores.leaderboardHistory.rankBoards;
const board = (name, at, source = 'local') => ({ at, source, rows: [[name, 7]] });
const stamps = (boards) => Object.values(boards).map((entry) => entry.at);
const namesIn = (boards) => Object.values(boards).flatMap((entry) => entry.rows.map(([name]) => name));

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
});

afterEach(() => {
    vi.useRealTimers();
});

describe('leaderboard rank boards through the upload', () => {
    const deviceA = {
        [TOTAL]: board('Older', NOW - 2 * DAY),
        [MILKING]: board('OnlyA', NOW - 2 * DAY),
    };
    const deviceB = {
        [TOTAL]: board('Newer', NOW - DAY),
        [FORAGING]: board('OnlyB', NOW - DAY),
    };

    test('every board keeps its capture time, so the gist is readable', () => {
        const uploaded = boardsIn(mergeForUpload(boardsPayload(deviceA), boardsPayload(deviceB), null).text);

        expect(Object.keys(uploaded).sort()).toEqual([FORAGING, MILKING, TOTAL].sort());
        expect(stamps(uploaded).every((at) => Number.isFinite(at) && at > 0)).toBe(true);
    });

    test('the newer board of two wins on upload, as it does on a pull', () => {
        const uploaded = boardsIn(mergeForUpload(boardsPayload(deviceA), boardsPayload(deviceB), null).text);

        expect(uploaded[TOTAL].rows).toEqual([['Newer', 7]]);
        expect(uploaded[TOTAL].at).toBe(NOW - DAY);
    });

    test('another device reads what was uploaded, whether or not it held boards already', () => {
        const uploaded = boardsIn(mergeForUpload(boardsPayload(deviceB), boardsPayload(deviceB), null).text);
        const fold = mergeForKey('leaderboardHistory', 'rankBoards').mergeForPull;

        expect(namesIn(fold(deviceA, uploaded)).sort()).toEqual(['Newer', 'OnlyA', 'OnlyB']);
        // A device with no copy takes the download whole, and the record's load folds it through the same sanitizer
        expect(namesIn(mergeBoards(uploaded, {})).sort()).toEqual(['Newer', 'OnlyB']);
        expect(buildNameIndex(mergeBoards(uploaded, {})).get('newer')?.[0].at).toBe(NOW - DAY);
    });

    test("two devices pushing in turn keep each other's boards in the gist", () => {
        const afterA = mergeForUpload(boardsPayload(deviceA), boardsPayload(deviceB), null).text;
        const afterB = mergeForUpload(boardsPayload(deviceB), afterA, null).text;

        expect(namesIn(boardsIn(afterB)).sort()).toEqual(['Newer', 'OnlyA', 'OnlyB']);
    });

    test('two devices with different boards settle, so neither owes the other a push after every pull', () => {
        const afterA = mergeForUpload(boardsPayload(deviceA), boardsPayload(deviceB), null).text;
        const afterB = mergeForUpload(boardsPayload(deviceB), afterA, null).text;
        // Each has now taken the other's boards, the way a pull folds them
        const fold = mergeForKey('leaderboardHistory', 'rankBoards').mergeForPull;
        const pulledByA = fold(deviceA, boardsIn(afterB));
        const pulledByB = fold(deviceB, boardsIn(afterB));

        expect(addsToRemote(boardsPayload(pulledByA), afterB)).toBe(false);
        expect(addsToRemote(boardsPayload(pulledByB), afterB)).toBe(false);
    });

    test('a push that adds nothing is not a change, so the gist is not rewritten', () => {
        const first = mergeForUpload(boardsPayload(deviceB), boardsPayload(deviceB), null);
        const again = mergeForUpload(boardsPayload(deviceB), first.text, null);

        expect(addsToRemote(again.text, first.text)).toBe(false);
        expect(again.remoteAdds).toBe(false);
    });

    test('with only this device moved, its side is the incoming one and the times still hold', () => {
        // The last exchange settled on device A's copy; the gist has not moved since and this device has
        const gist = boardsPayload(deviceA);
        const baseline = exchangeBaseline(gist, gist);
        const uploaded = boardsIn(mergeForUpload(boardsPayload(deviceB), gist, baseline).text);

        expect(stamps(uploaded).every((at) => Number.isFinite(at) && at > 0)).toBe(true);
        expect(uploaded[TOTAL].rows).toEqual([['Newer', 7]]);
        expect(namesIn(uploaded).sort()).toEqual(['Newer', 'OnlyA', 'OnlyB']);
    });

    test('with only this device moved, a tie between two boards goes to the game rows', () => {
        const gist = boardsPayload({ [TOTAL]: board('Server', NOW - DAY, 'server') });
        const baseline = exchangeBaseline(gist, gist);
        const mine = boardsPayload({ [TOTAL]: board('Game', NOW - DAY, 'local') });

        expect(boardsIn(mergeForUpload(mine, gist, baseline).text)[TOTAL].rows).toEqual([['Game', 7]]);
    });

    describe('a gist an affected build already wrote', () => {
        const corrupted = {
            [TOTAL]: board('Stale', null),
            [MILKING]: board('GistOnly', null),
        };

        test('stored as JSON it reads back as null stamps, which no reader takes', () => {
            const fold = mergeForKey('leaderboardHistory', 'rankBoards').mergeForPull;

            expect(fold(deviceB, corrupted)).toEqual(deviceB);
            expect(mergeBoards(corrupted, {})).toEqual({});
        });

        test('the first upload from a fixed build puts good stamps back', () => {
            const uploaded = boardsIn(mergeForUpload(boardsPayload(deviceB), boardsPayload(corrupted), null).text);

            expect(uploaded).toEqual(deviceB);
        });

        test('a device holding good boards owes that upload, and once it lands owes nothing', () => {
            const gist = boardsPayload(corrupted);
            expect(addsToRemote(boardsPayload(deviceB), gist)).toBe(true);

            const healed = mergeForUpload(boardsPayload(deviceB), gist, null).text;
            expect(addsToRemote(boardsPayload(deviceB), healed)).toBe(false);
        });

        test('a device whose own copy is also all null stamps settles on an empty record', () => {
            const once = mergeForUpload(boardsPayload(corrupted), boardsPayload(corrupted), null).text;

            expect(boardsIn(once)).toEqual({});
            expect(addsToRemote(boardsPayload({}), once)).toBe(false);
        });

        test('a device with no copy leaves the key alone, and the next device with boards replaces it', () => {
            const untouched = mergeForUpload(payload({ leaderboardHistory: {} }), boardsPayload(corrupted), null).text;
            expect(boardsIn(untouched)).toEqual(corrupted);

            expect(boardsIn(mergeForUpload(boardsPayload(deviceA), untouched, null).text)).toEqual(deviceA);
        });
    });

    test('a board stamped ahead of the clock is capped to now, not to NaN', () => {
        const fast = { [TOTAL]: board('Fast', NOW + 30 * DAY) };
        const uploaded = boardsIn(mergeForUpload(boardsPayload(fast), boardsPayload(deviceB), null).text);

        expect(uploaded[TOTAL].at).toBe(NOW);
    });

    test('empty and missing inputs leave nothing behind', () => {
        expect(boardsIn(mergeForUpload(boardsPayload({}), boardsPayload({}), null).text)).toEqual({});
        expect(boardsIn(mergeForUpload(boardsPayload(null), boardsPayload(deviceA), null).text)).toEqual(deviceA);
    });
});

describe('dungeon average baselines through the upload', () => {
    const baselinesPayload = (map) => payload({ unifiedRuns: { dungeonAverageBaselines: map } });
    const baselinesIn = (text) => JSON.parse(text).stores.unifiedRuns.dungeonAverageBaselines;
    const FAR_AHEAD = NOW + 365 * DAY;
    const TEAM_DUNGEON = '/players/1|/players/2::Chimerical Den';

    test('a stamp from a clock far ahead does not ride an upload back into the gist', () => {
        const uploaded = baselinesIn(
            mergeForUpload(
                baselinesPayload({ [TEAM_DUNGEON]: NOW - DAY }),
                baselinesPayload({ [TEAM_DUNGEON]: NOW - 2 * DAY, poison: FAR_AHEAD }),
                null
            ).text
        );

        expect(uploaded).toEqual({ [TEAM_DUNGEON]: NOW - DAY });
    });

    test('the marker cannot blank a dungeon by outranking the real one for that key', () => {
        const uploaded = baselinesIn(
            mergeForUpload(
                baselinesPayload({ [TEAM_DUNGEON]: NOW - DAY }),
                baselinesPayload({ [TEAM_DUNGEON]: FAR_AHEAD }),
                null
            ).text
        );

        expect(uploaded[TEAM_DUNGEON]).toBe(NOW - DAY);
    });

    test('a device holding good markers owes the upload that sheds one, and owes nothing afterward', () => {
        const mine = baselinesPayload({ [TEAM_DUNGEON]: NOW - DAY });
        const gist = baselinesPayload({ [TEAM_DUNGEON]: NOW - DAY, poison: FAR_AHEAD });
        expect(addsToRemote(mine, gist)).toBe(true);

        const healed = mergeForUpload(mine, gist, null).text;
        expect(addsToRemote(mine, healed)).toBe(false);
    });

    test("skew inside the tolerance still syncs, and two devices' dungeons both stay", () => {
        const skewed = NOW + BASELINE_FUTURE_TOLERANCE_MS - 1;
        const uploaded = baselinesIn(
            mergeForUpload(baselinesPayload({ a: NOW - DAY, b: skewed }), baselinesPayload({ c: NOW - 2 * DAY }), null)
                .text
        );

        expect(uploaded).toEqual({ a: NOW - DAY, b: skewed, c: NOW - 2 * DAY });
    });

    test('the reader strips a stamp already stored, as it always did', () => {
        expect(mergeAverageBaselines({ poison: FAR_AHEAD, a: NOW - DAY }, null)).toEqual({ a: NOW - DAY });
    });

    test('empty and wrong-shaped sides drop out', () => {
        expect(baselinesIn(mergeForUpload(baselinesPayload({}), baselinesPayload({}), null).text)).toEqual({});
        expect(
            baselinesIn(mergeForUpload(baselinesPayload([NOW]), baselinesPayload({ a: NOW - DAY }), null).text)
        ).toEqual({ a: NOW - DAY });
    });
});

/*
 * The other half of the same line: a merge that does read the context must still get it on every upload. Lose
 * the opt-in and the fold quietly trims to this device's own retention, and the upload deletes from the gist
 * history another device keeps, which is the worst thing this code can do.
 */
describe('a merge that asked for the context still gets it through the upload', () => {
    test('the room log: a device keeping the default 120 sessions uploads all 500 either side holds', () => {
        const sessions = (from, count) =>
            Array.from({ length: count }, (_, index) => ({ runKey: 'run', startedAt: from + index }));
        const wrap = (log) => payload({ settings: { labyrinthRoomLogs_c1: log } });
        const mine = { sessions: sessions(1, 20) };
        const gist = { sessions: sessions(1000, 480) };

        const uploaded = JSON.parse(mergeForUpload(wrap(mine), wrap(gist), null).text);

        expect(uploaded.stores.settings.labyrinthRoomLogs_c1.sessions).toHaveLength(500);
        // With this character's settings in hand: a cap not yet known cuts nothing
        config.characterSettingsLoaded = true;
        try {
            expect(mergeForKey('settings', 'labyrinthRoomLogs_c1').mergeForPull(mine, gist).sessions).toHaveLength(120);
        } finally {
            config.characterSettingsLoaded = false;
        }
    });

    test('a chunked history: an upload offers everything, a pull leaves out what the owner would prune', () => {
        const key = 'itemFlowRec_c1_2026-11-03';
        const registration = mergeForKey('networthHistory', key);
        const old = { d: '2026-01-05', drinks: { '/items/milking_tea': 2 } };
        const recent = { d: '2026-11-02', drinks: { '/items/milking_tea': 3 } };
        const wrap = (rows) => payload({ networthHistory: { [key]: rows } });

        const uploaded = JSON.parse(mergeForUpload(wrap([recent]), wrap([old]), null).text);

        expect(uploaded.stores.networthHistory[key].map((row) => row.d)).toEqual([old.d, recent.d]);
        expect(registration.mergeForPull([recent], [old]).map((row) => row.d)).toEqual([recent.d]);
    });

    test("the market listing log: an upload sheds what both sides retired, this device's side included", () => {
        const row = (id, timestamp) => ({
            id,
            timestamp,
            createdTimestamp: new Date(timestamp).toISOString(),
            itemHrid: '/items/holy_sword',
            enhancementLevel: 3,
            price: 5000000,
            orderQuantity: 1,
            filledQuantity: 1,
            isSell: true,
            status: 'filled',
        });
        const recent = row(190000001, NOW - DAY);
        const mine = [row(124101352, NOW - 400 * DAY), recent];
        const gist = [row(126848436, NOW - 400 * DAY), recent];
        const wrap = (log) => payload({ marketListings: { marketListingTimestamps: log } });

        const uploaded = JSON.parse(mergeForUpload(wrap(mine), wrap(gist), null).text);

        expect(uploaded.stores.marketListings.marketListingTimestamps.map((entry) => entry.id)).toEqual([recent.id]);
    });

    test('a pressed push still reports a trim only for a registration that caps by a setting', () => {
        const wrap = (boards) => boardsPayload(boards);
        const mine = { [TOTAL]: board('Mine', NOW - DAY) };
        const theirs = { [TOTAL]: board('Theirs', NOW - 2 * DAY), [MILKING]: board('Other', NOW - DAY) };

        expect(trimmedRegisteredKeys(wrap(mine), wrap(theirs))).toEqual([]);
    });
});
