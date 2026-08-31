/**
 * Tests for full-backup.js (whole-database export/import)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

let db = new Map(); // storeName -> Map(key -> value)

vi.mock('../core/storage.js', () => ({
    default: {
        listStores: vi.fn(() => Promise.resolve(Array.from(db.keys()))),
        getAll: vi.fn((storeName) => Promise.resolve(Object.fromEntries(db.get(storeName) || new Map()))),
        beginRestore: vi.fn(() => Promise.resolve()),
        finishRestore: vi.fn(),
        endRestore: vi.fn(() => Promise.resolve()),
        putAll: vi.fn((storeName, entries) => {
            const store = db.get(storeName) || new Map();
            for (const [key, value] of Object.entries(entries || {})) {
                store.set(key, value);
            }
            db.set(storeName, store);
            return Promise.resolve(Object.keys(entries || {}).length);
        }),
    },
}));

const { listBackupStores, exportEverything, exportEverythingJSON, importEverything, stripExcludedKeys } =
    await import('./full-backup.js');

/**
 * Reset the fake database to a fixed set of stores/keys.
 */
function seedDb() {
    db = new Map([
        ['settings', new Map([['theme', 'dark']])],
        [
            'xpHistory',
            new Map([
                ['2026-01-01', { mining: 100 }],
                ['2026-01-02', { mining: 200 }],
            ]),
        ],
        ['dungeonRuns', new Map([['run1', { boss: 'X' }]])],
    ]);
}

describe('listBackupStores', () => {
    beforeEach(seedDb);

    test('returns every store name in the database', async () => {
        expect(await listBackupStores()).toEqual(['settings', 'xpHistory', 'dungeonRuns']);
    });
});

describe('exportEverything / importEverything round-trip', () => {
    beforeEach(seedDb);

    test('exports every store and restores all of them into an empty database', async () => {
        const payload = await exportEverything();

        expect(payload.formatVersion).toBe(1);
        expect(typeof payload.exportedAt).toBe('string');
        expect(payload.stores).toEqual({
            settings: { theme: 'dark' },
            xpHistory: { '2026-01-01': { mining: 100 }, '2026-01-02': { mining: 200 } },
            dungeonRuns: { run1: { boss: 'X' } },
        });

        // Simulate a fresh database that still defines the same stores, just empty
        db = new Map([
            ['settings', new Map()],
            ['xpHistory', new Map()],
            ['dungeonRuns', new Map()],
        ]);

        const result = await importEverything(payload);

        expect(result.restored).toEqual({ settings: 1, xpHistory: 2, dungeonRuns: 1 });
        expect(Object.fromEntries(db.get('settings'))).toEqual({ theme: 'dark' });
        expect(Object.fromEntries(db.get('xpHistory'))).toEqual({
            '2026-01-01': { mining: 100 },
            '2026-01-02': { mining: 200 },
        });
        expect(Object.fromEntries(db.get('dungeonRuns'))).toEqual({ run1: { boss: 'X' } });
    });
});

describe('chunked history records', () => {
    /**
     * The recorders that used to keep a history in one key now keep it in one
     * record per month or per hour (`utils/chunked-history.js`). Backup and gist
     * sync both enumerate with `getAll()` and write with `putAll()`, so neither
     * knows or cares about key shapes — this is the test that says so, and that
     * would fail if either grew a per-key assumption.
     */
    test('round-trip through export and import unchanged, whatever their keys look like', async () => {
        db = new Map([
            [
                'networthHistory',
                new Map([
                    ['networthSeries_char-1_2026-07', [{ t: 1, total: 10 }]],
                    ['networthSeries_char-1_2026-08', [{ t: 2, total: 20 }]],
                    ['networthDetail_char-1_2', { t: 2, items: {} }],
                ]),
            ],
            ['lootLogHistory', new Map([['lootLogRec_char-1_2026-08-01T10', [{ characterActionId: 7 }]]])],
            ['alchemyHistory', new Map([['transmuteSessionsRec_char-1_2026-08-04', [{ id: 'transmute_1' }]]])],
        ]);

        const payload = await exportEverything();
        const before = structuredClone(payload.stores);

        db = new Map([
            ['networthHistory', new Map()],
            ['lootLogHistory', new Map()],
            ['alchemyHistory', new Map()],
        ]);
        const result = await importEverything(payload);

        expect(result.restored).toEqual({ networthHistory: 3, lootLogHistory: 1, alchemyHistory: 1 });
        expect((await exportEverything()).stores).toEqual(before);
    });
});

describe('exportEverythingJSON', () => {
    beforeEach(seedDb);

    test('produces the same payload as the object export, as text', async () => {
        const text = await exportEverythingJSON();
        const parsed = JSON.parse(text);

        expect(parsed.formatVersion).toBe(1);
        expect(typeof parsed.exportedAt).toBe('string');
        expect(parsed.stores).toEqual({
            settings: { theme: 'dark' },
            xpHistory: { '2026-01-01': { mining: 100 }, '2026-01-02': { mining: 200 } },
            dungeonRuns: { run1: { boss: 'X' } },
        });
    });

    test('reads one store at a time, which is the whole point of it', async () => {
        const storage = (await import('../core/storage.js')).default;
        storage.getAll.mockClear();

        await exportEverythingJSON();

        // One read per store, never a read of everything at once
        expect(storage.getAll).toHaveBeenCalledTimes(3);
        expect(storage.getAll.mock.calls.map(([name]) => name)).toEqual(['settings', 'xpHistory', 'dungeonRuns']);
    });

    test('an empty database is still a valid, restorable payload', async () => {
        db = new Map();

        const parsed = JSON.parse(await exportEverythingJSON());

        expect(parsed.stores).toEqual({});
        await expect(importEverything(parsed)).resolves.toEqual({
            restored: {},
            expected: {},
            failed: [],
            complete: true,
        });
    });

    test('round-trips through the text form back into the database', async () => {
        const parsed = JSON.parse(await exportEverythingJSON());
        db = new Map([
            ['settings', new Map()],
            ['xpHistory', new Map()],
            ['dungeonRuns', new Map()],
        ]);

        const result = await importEverything(parsed);

        expect(result.restored).toEqual({ settings: 1, xpHistory: 2, dungeonRuns: 1 });
        expect(Object.fromEntries(db.get('xpHistory'))).toEqual({
            '2026-01-01': { mining: 100 },
            '2026-01-02': { mining: 200 },
        });
    });
});

describe('stripExcludedKeys', () => {
    test('drops the trial trace manifest and chunks from guildHistory', () => {
        const kept = stripExcludedKeys('guildHistory', {
            trialTraceManifest_603281: { chunks: [1, 2] },
            trialTraceChunk_0_603281: { data: 'x'.repeat(1000) },
            trialTraceChunk_1_603281: { data: 'y' },
            guildTrials_MilkMaxxing: { real: 'data' },
        });
        expect(kept).toEqual({ guildTrials_MilkMaxxing: { real: 'data' } });
    });

    test('leaves an unlisted store untouched, same reference back', () => {
        const entries = { run1: { boss: 'X' } };
        expect(stripExcludedKeys('dungeonRuns', entries)).toBe(entries);
    });

    test('does not mutate the input it filtered', () => {
        const entries = { trialTraceManifest_1: {}, keep: 1 };
        stripExcludedKeys('guildHistory', entries);
        expect(entries).toEqual({ trialTraceManifest_1: {}, keep: 1 });
    });
});

describe('trial trace exclusion end to end', () => {
    beforeEach(() => {
        seedDb();
        db.set(
            'guildHistory',
            new Map([
                ['trialTraceManifest_603281', { chunks: [0] }],
                ['trialTraceChunk_0_603281', { data: 'a'.repeat(500) }],
                ['guildTrials_MilkMaxxing', { real: 'data' }],
            ])
        );
    });

    test('exportEverythingJSON never carries the trace', async () => {
        const parsed = JSON.parse(await exportEverythingJSON());
        expect(Object.keys(parsed.stores.guildHistory)).toEqual(['guildTrials_MilkMaxxing']);
    });

    test('exportEverything (object form) never carries the trace either', async () => {
        const payload = await exportEverything();
        expect(Object.keys(payload.stores.guildHistory)).toEqual(['guildTrials_MilkMaxxing']);
    });

    test('an old backup that does carry a trace never plants it locally — import excludes it too', async () => {
        const payload = {
            formatVersion: 1,
            stores: {
                guildHistory: {
                    trialTraceManifest_603281: { chunks: [0] },
                    guildTrials_MilkMaxxing: { real: 'data' },
                },
            },
        };
        db.set('guildHistory', new Map());
        const result = await importEverything(payload);
        // Only the real record landed — the diagnostic trace, however it got
        // into the payload, is excluded on the way in exactly as it is on the
        // way out
        expect(result.restored.guildHistory).toBe(1);
        expect(db.get('guildHistory').get('trialTraceManifest_603281')).toBeUndefined();
        expect(db.get('guildHistory').get('guildTrials_MilkMaxxing')).toEqual({ real: 'data' });
    });

    test('expected count is the post-exclusion count, not the raw payload size', async () => {
        // A shortfall is judged against what should land, and an excluded key
        // was never going to — counting it against `want` would make a clean
        // restore look like a failure
        const payload = {
            formatVersion: 1,
            stores: {
                guildHistory: {
                    trialTraceManifest_603281: { chunks: [0] },
                    trialTraceChunk_0_603281: { data: 'x' },
                    guildTrials_MilkMaxxing: { real: 'data' },
                },
            },
        };
        db.set('guildHistory', new Map());
        const result = await importEverything(payload);
        expect(result.restored.guildHistory).toBe(1);
        expect(result.expected.guildHistory).toBe(1);
        expect(result.failed).toEqual([]);
    });
});

describe('importEverything store selection', () => {
    beforeEach(seedDb);

    test('restores only the stores named in options.storeNames', async () => {
        const payload = await exportEverything();
        db = new Map([
            ['settings', new Map()],
            ['xpHistory', new Map()],
            ['dungeonRuns', new Map()],
        ]);

        const result = await importEverything(payload, { storeNames: ['settings'] });

        expect(result.restored).toEqual({ settings: 1 });
        expect(Object.fromEntries(db.get('settings'))).toEqual({ theme: 'dark' });
        expect(db.get('xpHistory').size).toBe(0);
        expect(db.get('dungeonRuns').size).toBe(0);
    });

    test('ignores a requested store name absent from the payload', async () => {
        const payload = await exportEverything();
        db = new Map([
            ['settings', new Map()],
            ['xpHistory', new Map()],
            ['dungeonRuns', new Map()],
        ]);

        const result = await importEverything(payload, { storeNames: ['settings', 'doesNotExistInPayload'] });

        expect(result.restored).toEqual({ settings: 1 });
    });
});

describe('importEverything unknown-store skip', () => {
    beforeEach(seedDb);

    test('skips a store present in the payload but absent from the current database, with a warning', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

        const payload = await exportEverything();
        payload.stores.retiredStore = { someKey: 'someValue' };

        // Current database no longer defines "retiredStore"
        db = new Map([
            ['settings', new Map()],
            ['xpHistory', new Map()],
            ['dungeonRuns', new Map()],
        ]);

        const result = await importEverything(payload);

        expect(result.restored).toEqual({ settings: 1, xpHistory: 2, dungeonRuns: 1 });
        expect(result.restored.retiredStore).toBeUndefined();
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('retiredStore'));

        warnSpy.mockRestore();
    });
});

describe('importEverything formatVersion rejection', () => {
    beforeEach(seedDb);

    test('throws when formatVersion is missing', async () => {
        await expect(importEverything({ stores: {} })).rejects.toThrow(/formatVersion/);
    });

    test('throws when formatVersion does not match the supported version', async () => {
        await expect(importEverything({ formatVersion: 2, stores: {} })).rejects.toThrow(/formatVersion/);
    });

    test('throws when payload is missing entirely', async () => {
        await expect(importEverything(undefined)).rejects.toThrow(/formatVersion/);
    });
});

describe('importEverything reports what did not land', () => {
    beforeEach(async () => {
        seedDb();
        const storage = (await import('../core/storage.js')).default;
        // mockImplementation from a previous test outlives mockClear, and these
        // tests exist to change putAll's answer — so the default is restored
        storage.putAll.mockReset();
        storage.putAll.mockImplementation((storeName, entries) => {
            const store = db.get(storeName) || new Map();
            for (const [key, value] of Object.entries(entries || {})) store.set(key, value);
            db.set(storeName, store);
            return Promise.resolve(Object.keys(entries || {}).length);
        });
        storage.beginRestore.mockClear();
        storage.finishRestore.mockClear();
        storage.endRestore.mockClear();
    });

    test('a store whose transaction wrote nothing is reported, not counted as restored', async () => {
        const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        const storage = (await import('../core/storage.js')).default;
        const payload = await exportEverything();

        // What an aborted transaction looks like from here: nothing written,
        // and no error thrown
        storage.putAll.mockImplementationOnce(() => Promise.resolve(0));

        const result = await importEverything(payload);

        expect(result.complete).toBe(false);
        expect(result.failed).toEqual([{ store: 'settings', expected: 1, written: 0 }]);
        expect(result.restored.settings).toBe(0);
        expect(result.expected.settings).toBe(1);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('settings'));

        errorSpy.mockRestore();
    });

    test('a partial write is a shortfall too, however many keys landed', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const storage = (await import('../core/storage.js')).default;
        const payload = await exportEverything();

        storage.putAll.mockImplementation((storeName, entries) =>
            Promise.resolve(storeName === 'xpHistory' ? 1 : Object.keys(entries).length)
        );

        const result = await importEverything(payload);

        expect(result.complete).toBe(false);
        expect(result.failed).toEqual([{ store: 'xpHistory', expected: 2, written: 1 }]);

        vi.restoreAllMocks();
    });

    test('flushes pending writes before the restore and latches the stores it wrote', async () => {
        seedDb();
        const storage = (await import('../core/storage.js')).default;
        const payload = await exportEverything();

        const result = await importEverything(payload);

        expect(result.complete).toBe(true);
        expect(storage.beginRestore).toHaveBeenCalled();
        // Every store took its keys, so every store is latched against
        // pre-restore writes landing on top of it
        expect(storage.finishRestore).toHaveBeenCalledWith(new Set(['settings', 'xpHistory', 'dungeonRuns']));
    });

    test('a store that wrote nothing is not latched — nothing was restored to protect', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        const storage = (await import('../core/storage.js')).default;
        const payload = await exportEverything();

        storage.putAll.mockImplementation((storeName, entries) =>
            Promise.resolve(storeName === 'settings' ? 0 : Object.keys(entries).length)
        );

        await importEverything(payload);

        expect(storage.finishRestore).toHaveBeenCalledWith(new Set(['xpHistory', 'dungeonRuns']));

        vi.restoreAllMocks();
    });

    test('the debounce hold is released after the latch goes up, in order', async () => {
        seedDb();
        const storage = (await import('../core/storage.js')).default;
        const order = [];
        storage.finishRestore.mockImplementation(() => order.push('finishRestore'));
        storage.endRestore.mockImplementation(() => {
            order.push('endRestore');
            return Promise.resolve();
        });
        const payload = await exportEverything();

        await importEverything(payload);

        // endRestore flushes what the hold kept queued, so the latch must
        // already be up when it runs — the other order writes pre-restore
        // values into restored stores
        expect(order).toEqual(['finishRestore', 'endRestore']);
    });

    test('the debounce hold is released even when a store write throws', async () => {
        seedDb();
        const storage = (await import('../core/storage.js')).default;
        const payload = await exportEverything();

        storage.putAll.mockImplementation(() => Promise.reject(new Error('disk full')));

        await expect(importEverything(payload)).rejects.toThrow('disk full');
        // Leaving the hold up would queue every debounced write in the script
        // until the unload flush
        expect(storage.endRestore).toHaveBeenCalled();
    });
});
