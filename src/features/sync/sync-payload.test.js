import { describe, test, expect, beforeEach, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: {} }));

vi.mock('../../core/storage.js', () => ({
    default: {
        listStores: async () => Object.keys(storeState.stores),
        getAll: async (name) => ({ ...(storeState.stores[name] || {}) }),
        tryGet: async (key, name) => {
            if (storeState.unreadable) return null;
            const store = storeState.stores[name] || {};
            return Object.prototype.hasOwnProperty.call(store, key)
                ? { found: true, value: store[key] }
                : { found: false, value: null };
        },
    },
}));

const importedPayloads = vi.hoisted(() => []);
vi.mock('../../utils/full-backup.js', () => ({
    importEverything: async (payload) => {
        importedPayloads.push(payload);
        return { restored: { settings: Object.keys(payload.stores?.settings || {}).length } };
    },
}));

const { registerSyncMerge, mergeForKey } = await import('../../utils/sync-merge-registry.js');

// Imported for their side effect: each registers its own merges at import
// time, which is exactly how a real page assembles the registry
await import('../../utils/chest-tally.js');
await import('../market/trade-history.js');

const { buildPayloadJSON, applyPayload, hashPayload, readExportedAt, redactSettingsStore } =
    await import('./sync-payload.js');

beforeEach(() => {
    importedPayloads.length = 0;
    storeState.unreadable = false;
    storeState.stores = {
        settings: {
            script_settingsMap_abc: { sync_token: { value: 'ghp_secret' }, chatCommands: { isTrue: true } },
            toolasha_sync_gistId: 'deadbeef',
            some_other_key: 42,
        },
        dungeonRuns: { run1: { kills: 3 } },
    };
});

describe('redaction', () => {
    test('strips the GitHub token out of the settings map', () => {
        const safe = redactSettingsStore(storeState.stores.settings);
        expect(safe.script_settingsMap_abc.sync_token).toBeUndefined();
        expect(safe.script_settingsMap_abc.chatCommands).toEqual({ isTrue: true });
    });

    test('strips device-local sync bookkeeping', () => {
        const safe = redactSettingsStore(storeState.stores.settings);
        expect(safe.toolasha_sync_gistId).toBeUndefined();
        expect(safe.some_other_key).toBe(42);
    });

    test('does not mutate the caller’s live storage read', () => {
        redactSettingsStore(storeState.stores.settings);
        expect(storeState.stores.settings.script_settingsMap_abc.sync_token).toEqual({ value: 'ghp_secret' });
    });

    test('handles a settings map stored as a JSON string', () => {
        const safe = redactSettingsStore({
            script_settingsMap_abc: JSON.stringify({ sync_token: { value: 'x' }, a: 1 }),
        });
        expect(JSON.parse(safe.script_settingsMap_abc)).toEqual({ a: 1 });
    });
});

describe('buildPayloadJSON', () => {
    test('settings scope carries only the settings store', async () => {
        const json = await buildPayloadJSON('settings');
        const parsed = JSON.parse(json);
        expect(Object.keys(parsed.stores)).toEqual(['settings']);
        expect(parsed.syncScope).toBe('settings');
        expect(json).not.toContain('ghp_secret');
    });

    test('everything scope carries every store, still without the token', async () => {
        const json = await buildPayloadJSON('everything');
        const parsed = JSON.parse(json);
        expect(Object.keys(parsed.stores).sort()).toEqual(['dungeonRuns', 'settings']);
        expect(parsed.stores.dungeonRuns.run1).toEqual({ kills: 3 });
        expect(json).not.toContain('ghp_secret');
    });

    test('is readable by the full-backup importer', async () => {
        const parsed = JSON.parse(await buildPayloadJSON('everything'));
        expect(parsed.formatVersion).toBe(1);
        expect(typeof parsed.exportedAt).toBe('string');
    });
});

describe('applyPayload', () => {
    test('keeps this device’s token when the incoming map has none', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { script_settingsMap_abc: { chatCommands: { isTrue: false } } } },
        });

        await applyPayload(json);

        const written = importedPayloads[0].stores.settings.script_settingsMap_abc;
        expect(written.sync_token).toEqual({ value: 'ghp_secret' });
        expect(written.chatCommands).toEqual({ isTrue: false });
    });

    test('never restores sync bookkeeping from a payload', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { toolasha_sync_gistId: 'someone-elses-gist', keep: 1 } },
        });

        await applyPayload(json);

        expect(importedPayloads[0].stores.settings.toolasha_sync_gistId).toBeUndefined();
        expect(importedPayloads[0].stores.settings.keep).toBe(1);
    });
});

describe('hashPayload', () => {
    test('is stable and distinguishes different payloads', () => {
        expect(hashPayload('abc')).toBe(hashPayload('abc'));
        expect(hashPayload('abc')).not.toBe(hashPayload('abd'));
    });

    test('produces a fixed-width hex digest', () => {
        expect(hashPayload('')).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('readExportedAt', () => {
    test('finds the timestamp without parsing the payload', async () => {
        const json = await buildPayloadJSON('everything');
        expect(readExportedAt(json)).toBe(JSON.parse(json).exportedAt);
    });

    test('returns null when there is none', () => {
        expect(readExportedAt('{"stores":{}}')).toBeNull();
    });
});

describe('applyPayload merges additive records', () => {
    /**
     * A payload carrying one key in one store.
     * @param {string} store - Store name
     * @param {string} key - Storage key
     * @param {*} value - Incoming value
     * @returns {string} Payload text
     */
    const payloadWith = (store, key, value) =>
        JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { [store]: { [key]: value } },
        });

    test('a registered merge replaces the incoming value with the union', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: (local, incoming) => [...local, ...incoming],
            label: 'fake',
        });
        storeState.stores.dungeonRuns = { run_char: ['local'] };

        const result = await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

        expect(importedPayloads[0].stores.dungeonRuns.run_char).toEqual(['local', 'remote']);
        expect(result.merged).toEqual([{ store: 'dungeonRuns', key: 'run_char', label: 'fake' }]);
        off();
    });

    test('a key this device has never stored comes down whole', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: () => ['should not run'],
            label: 'fake',
        });
        storeState.stores.dungeonRuns = {};

        const result = await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

        expect(importedPayloads[0].stores.dungeonRuns.run_char).toEqual(['remote']);
        expect(result.merged).toEqual([]);
        off();
    });

    test('a local value that cannot be read is not guessed at', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: () => ['should not run'],
            label: 'fake',
        });
        storeState.unreadable = true;

        const result = await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

        expect(importedPayloads[0].stores.dungeonRuns.run_char).toEqual(['remote']);
        expect(result.merged).toEqual([]);
        off();
    });

    test('a merge that throws falls back to the remote copy rather than failing the pull', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: () => {
                throw new Error('bad fold');
            },
            label: 'fake',
        });
        storeState.stores.dungeonRuns = { run_char: ['local'] };

        const result = await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

        expect(importedPayloads[0].stores.dungeonRuns.run_char).toEqual(['remote']);
        expect(result.merged).toEqual([]);
        off();
    });

    test('the treasure tally takes the larger count of each side, not the remote one', async () => {
        storeState.stores.settings.treasureTally_char = {
            '/items/purples_gift': { opened: 40, loot: { '/items/x': 10, '/items/local_only': 3 } },
        };

        await applyPayload(
            payloadWith('settings', 'treasureTally_char', {
                '/items/purples_gift': { opened: 25, loot: { '/items/x': 4, '/items/remote_only': 7 } },
                '/items/blue_gift': { opened: 5, loot: {} },
            })
        );

        const tally = importedPayloads[0].stores.settings.treasureTally_char;
        expect(tally['/items/purples_gift'].opened).toBe(40);
        expect(tally['/items/purples_gift'].loot).toEqual({
            '/items/x': 10,
            '/items/local_only': 3,
            '/items/remote_only': 7,
        });
        // A chest only the remote device ever opened still arrives
        expect(tally['/items/blue_gift'].opened).toBe(5);
    });

    test('personal trade prices are the union of both devices, side by side', async () => {
        storeState.stores.settings.tradeHistory_char = {
            '/items/coin:0': { buy: 100 },
            '/items/local_only:0': { sell: 5 },
        };

        await applyPayload(
            payloadWith('settings', 'tradeHistory_char', {
                '/items/coin:0': { sell: 200 },
                '/items/remote_only:0': { buy: 9 },
            })
        );

        const history = importedPayloads[0].stores.settings.tradeHistory_char;
        expect(history['/items/coin:0']).toEqual({ buy: 100, sell: 200 });
        expect(history['/items/local_only:0']).toEqual({ sell: 5 });
        expect(history['/items/remote_only:0']).toEqual({ buy: 9 });
    });

    test('curated and settings keys are never merged — a union would resurrect deletions', async () => {
        storeState.stores.settings.watchlist = ['kept', 'deliberately removed'];
        storeState.stores.settings.script_settingsMap_abc = { a: 1 };

        await applyPayload(
            JSON.stringify({
                formatVersion: 1,
                exportedAt: '2026-01-01T00:00:00.000Z',
                stores: { settings: { watchlist: ['kept'] } },
            })
        );

        expect(importedPayloads[0].stores.settings.watchlist).toEqual(['kept']);
    });

    test('every merge the shipped modules register is reachable by its real key', () => {
        expect(mergeForKey('settings', 'treasureTally_char-A')?.label).toBe('Treasure tally');
        expect(mergeForKey('settings', 'tradeHistory_char-A')?.label).toBe('Personal trade prices');
    });
});
