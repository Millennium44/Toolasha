/**
 * Day rows rewritten in place, folded across a sync.
 *
 * The production, chest-opening and combat-loot recorders keep one row per
 * local day and update it as the day goes on; the alchemy trackers keep one
 * session per run and update that. A sync folds two copies of a chunk by
 * union, and the union used to know an entry only by its JSON — so the stale
 * copy one device pushed and the fresher copy another kept recording into were
 * two different entries, both kept, and every reader summed them.
 *
 * Driven through the real chunked store and its registered sync merge — the
 * fold an automatic upload and a pull both use — and read back through the
 * real attribution, so what is pinned is the figure the panel shows. Fixtures
 * are the shapes the recorders write.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const store = new Map();
    return {
        store,
        get: vi.fn(async (key, storeName, fallback) => (store.has(key) ? store.get(key) : fallback)),
        set: vi.fn(async (key, value) => {
            store.set(key, value);
            return true;
        }),
        delete: vi.fn(async (key) => {
            store.delete(key);
            return true;
        }),
        getMany: vi.fn(async (keys) => {
            const result = new Map();
            for (const key of keys) result.set(key, store.has(key) ? store.get(key) : null);
            return result;
        }),
        getAllKeys: vi.fn(async () => [...store.keys()]),
        tryGetAllKeys: vi.fn(async () => [...store.keys()]),
        putAll: vi.fn(async (storeName, entries) => {
            for (const [key, value] of Object.entries(entries)) store.set(key, value);
            return Object.keys(entries).length;
        }),
        isQuotaExceeded: vi.fn(() => false),
    };
});

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, getCurrentCharacterId: () => 'me', isFromActiveSocket: () => true },
}));

const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
const { timeChunkId } = await import('../../utils/chunked-history.js');
const { attributeGoldSources, dayStart } = await import('./gold-sources.js');
const { default: productionRecorder } = await import('./production-income-recorder.js');
const { default: chestRecorder } = await import('./chest-opening-recorder.js');
const { default: combatLootRecorder } = await import('./combat-loot-recorder.js');
const { createAlchemySessionStore } = await import('../alchemy/alchemy-session-store.js');

const DAY = '2026-10-07';
const from = dayStart(DAY);
const to = from + 24 * 60 * 60 * 1000 - 1;
const monthChunk = timeChunkId(from, 'month');
const dayChunk = timeChunkId(from, 'day');

/** Every item at 10, every chest at 100 */
const price = (itemHrid) => (String(itemHrid).includes('chest') ? 100 : 10);

/** The attribution's per-source totals for the day, read from these rows */
const sources = (input) => attributeGoldSources({ from, to, price, ...input }).totals.sources;

/** The fold an automatic upload makes: the gist's copy is the base, this device's comes in */
const upload = (key, gist, mine) => mergeForKey('networthHistory', key).merge(gist, mine, { forUpload: true });

/** The fold a pull makes: this device's copy is the base, the gist's comes in */
const pull = (key, mine, gist) => mergeForKey('networthHistory', key).mergeForPull(mine, gist);

beforeEach(() => {
    storageMock.store.clear();
    for (const fn of Object.values(storageMock)) fn.mockClear?.();
    productionRecorder._forget();
    chestRecorder._forget();
    combatLootRecorder._forget();
});

describe('production income', () => {
    const key = `prodIncomeRec_me_${monthChunk}`;
    /** As the gist holds it: pushed mid-morning */
    const stale = { d: DAY, outputValue: 5000, inputValue: 3000, actions: 50, offlineProfit: 0 };
    /** This device pulled that and kept crafting, then logged in after an offline stretch */
    const fresh = { d: DAY, outputValue: 9000, inputValue: 5000, actions: 90, offlineProfit: 700 };

    test('an upload folds the gist’s stale copy of today into one row with the fresher figures', () => {
        const merged = upload(key, [stale], [fresh]);
        expect(merged).toEqual([fresh]);
        expect(sources({ productionDays: merged }).production).toBe(4000);
        expect(sources({ productionDays: merged }).offline).toBe(700);
    });

    test('a pull of the stale copy leaves this device’s fresher row alone', () => {
        const merged = pull(key, [fresh], [stale]);
        expect(merged).toEqual([fresh]);
        expect(sources({ productionDays: merged }).production).toBe(4000);
    });

    test('each half is taken from the copy further along', () => {
        // One copy crafted further; the other recorded an offline session
        const crafted = { d: DAY, outputValue: 9000, inputValue: 5000, actions: 90, offlineProfit: 0 };
        const offline = { d: DAY, outputValue: 5000, inputValue: 3000, actions: 50, offlineProfit: -200 };
        const [row] = upload(key, [offline], [crafted]);
        expect(row).toMatchObject({ outputValue: 9000, inputValue: 5000, actions: 90, offlineProfit: -200 });
    });

    describe('offline sessions kept apart', () => {
        const base = { d: DAY, outputValue: 0, inputValue: 0, actions: 0 };
        const row = (sessions, offlineBase = 0) => ({
            ...base,
            offlineProfit: offlineBase + Object.values(sessions).reduce((a, b) => a + b, 0),
            offlineBase,
            offlineSessions: sessions,
        });

        test('a later session that nets toward zero is not undone by the stale copy', () => {
            const stale = row({ s1: 100 });
            const newer = row({ s1: 100, s2: -80 });
            for (const merged of [
                upload(key, [stale], [newer]),
                pull(key, [newer], [stale]),
                upload(key, [newer], [stale]),
            ]) {
                expect(merged).toHaveLength(1);
                expect(merged[0].offlineProfit).toBe(20);
                expect(sources({ productionDays: merged }).offline).toBe(20);
            }
        });

        test('two devices each adding a session give the union', () => {
            const [merged] = upload(key, [row({ s1: 100, s2: 30 })], [row({ s1: 100, s3: -80 })]);
            expect(merged.offlineSessions).toEqual({ s1: 100, s2: 30, s3: -80 });
            expect(merged.offlineProfit).toBe(50);
        });

        test('a legacy scalar copy is the base under the sessions', () => {
            const legacy = { ...base, offlineProfit: 100 };
            const [merged] = upload(key, [legacy], [row({ s2: -80 }, 100)]);
            expect(merged.offlineProfit).toBe(20);
            const [other] = upload(key, [row({ s2: -80 }, 100)], [legacy]);
            expect(other.offlineProfit).toBe(20);
        });

        test('an older build’s addition to the total alone is kept as base, not dropped', () => {
            // An older build pulled a sessions row and added a later Welcome Back to offlineProfit only
            const older = { ...row({ s1: 100 }), offlineProfit: 150 };
            for (const merged of [upload(key, [older], [row({ s1: 100 })]), upload(key, [row({ s1: 100 })], [older])]) {
                expect(merged[0].offlineProfit).toBe(150);
                expect(sources({ productionDays: merged }).offline).toBe(150);
            }
        });

        test('two legacy copies still keep the one further from zero', () => {
            const [merged] = upload(key, [{ ...base, offlineProfit: 100 }], [{ ...base, offlineProfit: -250 }]);
            expect(merged.offlineProfit).toBe(-250);
            expect(merged.offlineSessions).toBeUndefined();
        });
    });

    test('a duplicate already on disk is read as one row and written back as one', async () => {
        storageMock.store.set(key, [stale, fresh]);
        const rows = await productionRecorder.load();
        expect(rows.filter((row) => row.d === DAY)).toEqual([fresh]);
        expect(sources({ productionDays: rows }).production).toBe(4000);
        await Promise.resolve();
        expect(storageMock.store.get(key)).toEqual([fresh]);
    });
});

describe('chest openings', () => {
    const key = `chestOpenRec_me_${monthChunk}`;
    const stale = {
        d: DAY,
        openings: { '/items/purple_chest': { count: 2, gained: { '/items/star_fragment': 30 } } },
    };
    const fresh = {
        d: DAY,
        openings: {
            '/items/purple_chest': { count: 5, gained: { '/items/star_fragment': 70 } },
            '/items/large_treasure_chest': { count: 1, gained: { '/items/coin': 50 } },
        },
    };

    test('an upload folds the gist’s stale copy into one row with the fresher openings', () => {
        const merged = upload(key, [stale], [fresh]);
        expect(merged).toEqual([fresh]);
        // 5 purple: 700 - 500; 1 large: 50 - 100
        expect(sources({ chestDays: merged }).chests).toBe(200 - 50);
    });

    test('a chest only one copy opened is kept, the other taken from the copy that opened more', () => {
        const other = {
            d: DAY,
            openings: { '/items/purple_chest': { count: 6, gained: { '/items/star_fragment': 80 } } },
        };
        const [row] = upload(key, [fresh], [other]);
        expect(row.openings['/items/purple_chest']).toEqual(other.openings['/items/purple_chest']);
        expect(row.openings['/items/large_treasure_chest']).toEqual(fresh.openings['/items/large_treasure_chest']);
    });

    test('a duplicate already on disk is read as one row', async () => {
        storageMock.store.set(key, [stale, fresh]);
        const rows = await chestRecorder.load();
        expect(rows).toEqual([fresh]);
        expect(sources({ chestDays: rows }).chests).toBe(150);
    });
});

describe('combat loot', () => {
    const key = `combatLootRec_me_${dayChunk}`;
    const run = '2026-10-07T08:00:00.000Z';
    const t0 = from + 9 * 60 * 60 * 1000;
    const minute = 60 * 1000;
    const reading = (t, count) => ({ t, loot: { '/items/star_fragment': count } });
    const stale = {
        d: DAY,
        runs: { [run]: { stretches: [{ first: reading(t0, 0), last: reading(t0 + 5 * minute, 10) }] } },
    };
    const fresh = {
        d: DAY,
        runs: { [run]: { stretches: [{ first: reading(t0, 0), last: reading(t0 + 9 * minute, 25) }] } },
        offline: [[t0 - 60 * minute, t0 - 30 * minute]],
    };

    test('an upload folds the gist’s stale copy into one row, keeping the stretch that reached further', () => {
        const merged = upload(key, [stale], [fresh]);
        expect(merged).toEqual([fresh]);
        expect(sources({ combatLootDays: merged }).combat).toBe(250);
    });

    test('stretches that began apart are both kept, and offline windows are a set', () => {
        const later = {
            d: DAY,
            runs: {
                [run]: { stretches: [{ first: reading(t0 + 60 * minute, 25), last: reading(t0 + 70 * minute, 40) }] },
            },
            offline: [[t0 - 60 * minute, t0 - 30 * minute]],
        };
        const [row] = upload(key, [fresh], [later]);
        expect(row.runs[run].stretches.map((stretch) => stretch.first.t)).toEqual([t0, t0 + 60 * minute]);
        expect(row.offline).toEqual([[t0 - 60 * minute, t0 - 30 * minute]]);
        expect(sources({ combatLootDays: [row] }).combat).toBe(400);
    });

    test('a duplicate already on disk is read as one row', async () => {
        storageMock.store.set(key, [stale, fresh]);
        const rows = await combatLootRecorder.load();
        expect(rows).toEqual([fresh]);
    });
});

describe('alchemy sessions', () => {
    const store = createAlchemySessionStore('transmuteSessions', 'Test');
    const key = `transmuteSessionsRec_me_${dayChunk}`;
    const register = () => mergeForKey('alchemyHistory', key);
    const base = {
        id: `transmute_${from + 1000}`,
        startTime: from + 1000,
        inputItemHrid: '/items/holy_cheese',
        bulkMultiplier: 1,
        catalystsUsed: {},
        kind: 'transmute',
    };
    const stale = {
        ...base,
        lastActivityTime: from + 60_000,
        totalAttempts: 10,
        totalSuccesses: 6,
        results: { '/items/star_fragment': { count: 6 } },
    };
    const fresh = {
        ...base,
        lastActivityTime: from + 120_000,
        totalAttempts: 20,
        totalSuccesses: 13,
        results: { '/items/star_fragment': { count: 13 } },
    };

    test('an upload folds the gist’s stale copy of a session into the fresher one', () => {
        const merged = register().merge([stale], [fresh], { forUpload: true });
        expect(merged).toEqual([fresh]);
        // 13 out at 10, 20 in at 10
        expect(sources({ alchemySessions: merged }).alchemy).toBe(130 - 200);
    });

    test('a duplicate already on disk is read as one session', async () => {
        storageMock.store.set(key, [stale, fresh]);
        store.forget();
        const sessions = await store.load('me');
        expect(sessions).toEqual([fresh]);
    });

    test('a deletion recorded before the store named its identity still applies', async () => {
        const deleted = { ...base, id: `transmute_${from + 5000}`, startTime: from + 5000, totalAttempts: 3 };
        const tombKey = 'transmuteSessionsRecTomb_me';
        // Filed under the entry's JSON, as the old identity filed it
        storageMock.store.set(tombKey, { [JSON.stringify(deleted)]: { at: Date.now(), fp: fingerprint(deleted) } });
        storageMock.store.set(key, [fresh]);
        store.forget();
        await store.load('me');
        expect(register().merge([fresh], [deleted])).toEqual([fresh]);
    });
});

/**
 * The chunked store's content fingerprint (FNV-1a over the JSON), for a
 * tombstone written the way the store writes one.
 * @param {Object} entry
 * @returns {string}
 */
function fingerprint(entry) {
    const json = JSON.stringify(entry);
    let hash = 0x811c9dc5;
    for (let index = 0; index < json.length; index += 1) {
        hash ^= json.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16);
}
