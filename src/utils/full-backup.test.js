/**
 * Tests for full-backup.js (whole-database export/import)
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

let db = new Map(); // storeName -> Map(key -> value)

vi.mock('../core/storage.js', () => ({
    default: {
        listStores: vi.fn(() => Promise.resolve(Array.from(db.keys()))),
        getAll: vi.fn((storeName) => Promise.resolve(Object.fromEntries(db.get(storeName) || new Map()))),
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

const { listBackupStores, exportEverything, exportEverythingJSON, importEverything } = await import('./full-backup.js');

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
        await expect(importEverything(parsed)).resolves.toEqual({ restored: {} });
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
