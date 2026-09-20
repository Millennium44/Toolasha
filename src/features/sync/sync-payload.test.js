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
        // The real one flushes every debounced write before a restore
        // overwrites what it was going to land on. Reads (`tryGet`) go straight
        // to IndexedDB and never see a queued write, so *when* this runs decides
        // whether a merge base includes the last few seconds of recording.
        beginRestore: async () => {
            flushLog.push('beginRestore');
            if (storeState.flushError) throw storeState.flushError;
            for (const [name, entries] of Object.entries(storeState.pending || {})) {
                storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
            }
            storeState.pending = {};
        },
        endRestore: async () => {
            flushLog.push('endRestore');
        },
    },
}));

// settings-storage.js's own key-migration bookkeeping is exercised by its own
// tests; here applyPayload's wiring to it is what matters, so it is mocked
// down to a spy rather than let through to the (also mocked) storage module,
// which does not stub the methods that bookkeeping needs.
const reconcileKeyMigrationState = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../../core/settings-storage.js', () => ({
    default: { reconcileKeyMigrationState },
}));

const importedPayloads = vi.hoisted(() => []);
const importOutcome = vi.hoisted(() => ({ failed: [], complete: true }));
/** What `beginRestore()` landed, in call order, so a test can see when it ran */
const flushLog = vi.hoisted(() => []);
// A real (not stubbed) filter, so the sync-payload tests below prove the
// wiring actually calls it rather than asserting a mock echoed its input back
const EXCLUDED_STORE_KEY_PREFIXES = vi.hoisted(() => ({
    guildHistory: ['trialTraceManifest', 'trialTraceChunk_'],
}));
vi.mock('../../utils/full-backup.js', () => ({
    importEverything: async (payload) => {
        // The real `importEverything` quiesces live writers first
        flushLog.push('importEverything.beginRestore');
        for (const [name, entries] of Object.entries(storeState.pending || {})) {
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
        }
        storeState.pending = {};
        importedPayloads.push(payload);
        return {
            restored: { settings: Object.keys(payload.stores?.settings || {}).length },
            failed: importOutcome.failed,
            complete: importOutcome.complete,
        };
    },
    stripExcludedKeys: (storeName, entries) => {
        const prefixes = EXCLUDED_STORE_KEY_PREFIXES[storeName];
        if (!prefixes) return entries;
        const kept = {};
        for (const [key, value] of Object.entries(entries || {})) {
            if (prefixes.some((prefix) => key.startsWith(prefix))) continue;
            kept[key] = value;
        }
        return kept;
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
    importOutcome.failed = [];
    importOutcome.complete = true;
    storeState.unreadable = false;
    storeState.pending = {};
    storeState.flushError = null;
    flushLog.length = 0;
    reconcileKeyMigrationState.mockClear();
    storeState.stores = {
        settings: {
            script_settingsMap_abc: { sync_token: { value: 'ghp_secret' }, chatCommands: { isTrue: true } },
            toolasha_sync_gistId: 'deadbeef',
            toolasha_sync_lastSyncedSeq: 4,
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
        // The ordering counter is one device's clock, not the account's: sent
        // up, every device would adopt every other device's position and the
        // counter would stop ordering anything
        expect(safe.toolasha_sync_lastSyncedSeq).toBeUndefined();
        expect(safe.some_other_key).toBe(42);
    });

    test('strips the cached update-check answer and the presence heartbeat, not the settings that pace them', () => {
        storeState.stores.settings.updateCheckState = { checkedAt: 1700000000000, latestVersion: '3.17.0' };
        storeState.stores.settings.sessionBriefingLastAlive_603281 = 1700000000000;
        storeState.stores.settings.script_settingsMap_shared = {
            updateCheck: { isTrue: true },
            updateCheckHours: { value: 24 },
        };

        const safe = redactSettingsStore(storeState.stores.settings);

        // This device's last poll and this tab's liveness stamp are device
        // bookkeeping, same as the sync sequence number above
        expect(safe.updateCheckState).toBeUndefined();
        expect(safe.sessionBriefingLastAlive_603281).toBeUndefined();
        // The preferences that control them are the player's choice and still travel
        expect(safe.script_settingsMap_shared.updateCheck).toEqual({ isTrue: true });
        expect(safe.script_settingsMap_shared.updateCheckHours).toEqual({ value: 24 });
    });

    test('strips the market price cache, which every device refetches for itself', () => {
        storeState.stores.settings.Toolasha_marketAPI_json = { marketData: { '/items/cheese': {} }, timestamp: 1 };
        storeState.stores.settings.Toolasha_marketAPI_timestamp = 1700000000000;
        storeState.stores.settings.Toolasha_marketAPI_patches = { '/items/cheese:0': { a: 5, b: 4, timestamp: 1 } };
        storeState.stores.settings.Toolasha_marketAPI_migration_version = 1;

        const safe = redactSettingsStore(storeState.stores.settings);

        // Not wrong elsewhere — prices are global — but ~114 KB of snapshot on
        // every push and pull, for a cache the receiver refetches within the
        // quarter hour. The stamp, the order-book patches and the patch
        // migration version are the same cache's bookkeeping and go with it.
        expect(safe.Toolasha_marketAPI_json).toBeUndefined();
        expect(safe.Toolasha_marketAPI_timestamp).toBeUndefined();
        expect(safe.Toolasha_marketAPI_patches).toBeUndefined();
        expect(safe.Toolasha_marketAPI_migration_version).toBeUndefined();
        // Ordinary settings alongside it are untouched
        expect(safe.some_other_key).toBe(42);
        expect(safe.script_settingsMap_abc.chatCommands).toEqual({ isTrue: true });
    });

    test('does not mutate the caller’s live storage read', () => {
        redactSettingsStore(storeState.stores.settings);
        expect(storeState.stores.settings.script_settingsMap_abc.sync_token).toEqual({ value: 'ghp_secret' });
    });

    test('strips the thread settings, which are the machine’s rather than the account’s', () => {
        storeState.stores.settings.script_settingsMap_abc.combatSim_maxThreads = { value: 12 };
        storeState.stores.settings.script_settingsMap_abc.combatSim_uncapThreads = { isTrue: true };
        storeState.stores.settings.script_settingsMap_shared = {
            combatSim_maxThreads: { value: 12 },
            color_profit: { value: '#123456' },
            updateCheckHours: { value: 24 },
        };

        const safe = redactSettingsStore(storeState.stores.settings);

        expect(safe.script_settingsMap_abc.combatSim_maxThreads).toBeUndefined();
        expect(safe.script_settingsMap_abc.combatSim_uncapThreads).toBeUndefined();
        // The account-wide map shares the prefix, so it is cleaned as well
        expect(safe.script_settingsMap_shared.combatSim_maxThreads).toBeUndefined();
        // ...while a setting that is shared but not device-local still travels
        expect(safe.script_settingsMap_shared.color_profit).toEqual({ value: '#123456' });
        expect(safe.script_settingsMap_shared.updateCheckHours).toEqual({ value: 24 });
    });

    test('strips the persistence-attempt stamp, which is one browser’s history and not the account’s', () => {
        storeState.stores.settings.toolasha_local_persistStorageAttemptedAt = 1700000000000;

        const safe = redactSettingsStore(storeState.stores.settings);

        // A sync pull carrying this in would suppress this device's own
        // persist() ask for up to a day, on account of a different device's
        // history — see storage-persistence.js.
        expect(safe.toolasha_local_persistStorageAttemptedAt).toBeUndefined();
        expect(safe.some_other_key).toBe(42);
    });

    test('handles a settings map stored as a JSON string', () => {
        const safe = redactSettingsStore({
            script_settingsMap_abc: JSON.stringify({ sync_token: { value: 'x' }, a: 1 }),
        });
        expect(JSON.parse(safe.script_settingsMap_abc)).toEqual({ a: 1 });
    });

    test('omits an unreadable settings map rather than uploading unredacted credentials', () => {
        const malformed = '{"sync_token":{"value":"ghp_secret"}';
        const safe = redactSettingsStore({ script_settingsMap_abc: malformed, ordinary: 1 });

        expect(safe.script_settingsMap_abc).toBeUndefined();
        expect(safe.ordinary).toBe(1);
        expect(JSON.stringify(safe)).not.toContain('ghp_secret');
    });

    test('omits settings-map values that are not keyed objects', () => {
        const safe = redactSettingsStore({
            script_settingsMap_null: null,
            script_settingsMap_number: 42,
            script_settingsMap_array: [{ sync_token: { value: 'ghp_secret' } }],
        });

        expect(safe).toEqual({});
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

    test('never carries a trial trace, gzipped-10MB opt-in diagnostic that it is', async () => {
        storeState.stores.guildHistory = {
            trialTraceManifest_603281: { chunks: [0] },
            trialTraceChunk_0_603281: { data: 'x'.repeat(1000) },
            guildTrials_MilkMaxxing: { real: 'data' },
        };

        const parsed = JSON.parse(await buildPayloadJSON('everything'));

        expect(Object.keys(parsed.stores.guildHistory)).toEqual(['guildTrials_MilkMaxxing']);
    });
});

describe('applyPayload', () => {
    test('releases the restore hold if its initial flush fails', async () => {
        storeState.flushError = new Error('flush failed');

        await expect(applyPayload(JSON.stringify({ formatVersion: 1, stores: {} }))).rejects.toThrow('flush failed');

        expect(importedPayloads).toHaveLength(0);
        expect(flushLog).toEqual(['beginRestore', 'endRestore']);
    });

    test('releases the restore hold if settings reconciliation fails before import', async () => {
        reconcileKeyMigrationState.mockRejectedValueOnce(new Error('reconciliation failed'));
        const json = JSON.stringify({
            formatVersion: 1,
            stores: { settings: { script_settingsMap_abc: { chatCommands: { isTrue: false } } } },
        });

        await expect(applyPayload(json)).rejects.toThrow('reconciliation failed');

        expect(importedPayloads).toHaveLength(0);
        expect(flushLog).toEqual(['beginRestore', 'endRestore']);
    });

    test('preserves queued device settings and entries absent from the incoming map', async () => {
        storeState.pending = {
            settings: {
                script_settingsMap_abc: {
                    sync_token: { value: 'ghp_replacement' },
                    sync_passphrase: { value: 'new-passphrase' },
                    combatSim_maxThreads: { value: 2 },
                    recentLocalChoice: { isTrue: false },
                },
            },
        };
        const json = JSON.stringify({
            formatVersion: 1,
            stores: { settings: { script_settingsMap_abc: { chatCommands: { isTrue: false } } } },
        });

        await applyPayload(json);

        expect(importedPayloads[0].stores.settings.script_settingsMap_abc).toEqual({
            sync_token: { value: 'ghp_replacement' },
            sync_passphrase: { value: 'new-passphrase' },
            combatSim_maxThreads: { value: 2 },
            recentLocalChoice: { isTrue: false },
            chatCommands: { isTrue: false },
        });
    });

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

    test('keeps settings the incoming map has never heard of', async () => {
        // The settings map is a per-setting structure, and the two devices are
        // routinely on different builds — the older one's saved map simply has
        // no entry for a setting the newer one added. Taking the incoming map
        // whole erased those, and the next load handed the player the shipped
        // default back, so a setting they had turned off turned itself on.
        storeState.stores.settings.script_settingsMap_abc = {
            sync_token: { value: 'ghp_secret' },
            chatCommands: { isTrue: true },
            onlyOnThisBuild: { isTrue: false },
        };
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { script_settingsMap_abc: { chatCommands: { isTrue: false } } } },
        });

        await applyPayload(json);

        const written = importedPayloads[0].stores.settings.script_settingsMap_abc;
        // The setting the payload spoke about still takes the incoming value
        expect(written.chatCommands).toEqual({ isTrue: false });
        // The one it said nothing about survives instead of reverting
        expect(written.onlyOnThisBuild).toEqual({ isTrue: false });
    });

    test('keeps a string-encoded map’s local-only settings too', async () => {
        storeState.stores.settings.script_settingsMap_abc = JSON.stringify({
            chatCommands: { isTrue: true },
            onlyOnThisBuild: { value: 'kept' },
        });
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { script_settingsMap_abc: JSON.stringify({ chatCommands: { isTrue: false } }) } },
        });

        await applyPayload(json);

        const written = JSON.parse(importedPayloads[0].stores.settings.script_settingsMap_abc);
        expect(written).toEqual({ chatCommands: { isTrue: false }, onlyOnThisBuild: { value: 'kept' } });
    });

    test('keeps this machine’s thread count when the payload says nothing about it', async () => {
        storeState.stores.settings.script_settingsMap_abc.combatSim_maxThreads = { value: 2 };
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { script_settingsMap_abc: { chatCommands: { isTrue: false } } } },
        });

        await applyPayload(json);

        const written = importedPayloads[0].stores.settings.script_settingsMap_abc;
        expect(written.combatSim_maxThreads).toEqual({ value: 2 });
    });

    test('never takes another machine’s thread count, even from a payload that carries one', async () => {
        // A payload written by a build older than the carve-out, or by a device
        // that had one stored under a key this build no longer uploads
        storeState.stores.settings.script_settingsMap_abc.combatSim_maxThreads = { value: 2 };
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: {
                settings: {
                    script_settingsMap_abc: {
                        combatSim_maxThreads: { value: 16 },
                        combatSim_uncapThreads: { isTrue: true },
                        color_profit: { value: '#123456' },
                    },
                },
            },
        });

        await applyPayload(json);

        const written = importedPayloads[0].stores.settings.script_settingsMap_abc;
        expect(written.combatSim_maxThreads).toEqual({ value: 2 });
        // Nothing stored locally, so the incoming one is dropped rather than planted
        expect(written.combatSim_uncapThreads).toBeUndefined();
        // A shared setting that is not carved out still arrives
        expect(written.color_profit).toEqual({ value: '#123456' });
    });

    test('never takes another device’s token from a payload that carries one', async () => {
        storeState.stores.settings.script_settingsMap_abc = { chatCommands: { isTrue: true } };
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: {
                settings: { script_settingsMap_abc: { sync_token: { value: 'ghp_someone_else' } } },
            },
        });

        await applyPayload(json);

        expect(importedPayloads[0].stores.settings.script_settingsMap_abc.sync_token).toBeUndefined();
    });

    test('never restores sync bookkeeping from a payload', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { toolasha_sync_gistId: 'someone-elses-gist', panelGeometry: 1 } },
        });

        await applyPayload(json);

        expect(importedPayloads[0].stores.settings.toolasha_sync_gistId).toBeUndefined();
        expect(importedPayloads[0].stores.settings.panelGeometry).toBe(1);
    });

    test('never plants another device’s update-check cache or presence heartbeat', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: {
                settings: {
                    updateCheckState: { checkedAt: Date.now(), latestVersion: '99.0.0' },
                    sessionBriefingLastAlive_603281: Date.now(),
                    script_settingsMap_shared: { updateCheckHours: { value: 1 } },
                    panelGeometry: 1,
                },
            },
        });

        await applyPayload(json);

        const writtenSettings = importedPayloads[0].stores.settings;
        expect(writtenSettings.updateCheckState).toBeUndefined();
        expect(writtenSettings.sessionBriefingLastAlive_603281).toBeUndefined();
        // The setting that paces the check still lands normally
        expect(writtenSettings.script_settingsMap_shared.updateCheckHours).toEqual({ value: 1 });
        expect(writtenSettings.panelGeometry).toBe(1);
    });

    test('never plants another device’s market price cache', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: {
                settings: {
                    Toolasha_marketAPI_json: { marketData: {}, timestamp: 1 },
                    Toolasha_marketAPI_timestamp: 1700000000000,
                    Toolasha_marketAPI_patches: { '/items/cheese:0': { a: 5, b: 4, timestamp: 1 } },
                    Toolasha_marketAPI_migration_version: 1,
                    panelGeometry: 1,
                },
            },
        });

        await applyPayload(json);

        // A payload written by a build from before the exclusion still carries
        // the cache; a stale snapshot stamped with a foreign clock must not be
        // planted here either
        const writtenSettings = importedPayloads[0].stores.settings;
        expect(writtenSettings.Toolasha_marketAPI_json).toBeUndefined();
        expect(writtenSettings.Toolasha_marketAPI_timestamp).toBeUndefined();
        expect(writtenSettings.Toolasha_marketAPI_patches).toBeUndefined();
        expect(writtenSettings.Toolasha_marketAPI_migration_version).toBeUndefined();
        expect(writtenSettings.panelGeometry).toBe(1);
    });
});

describe('applyPayload and the key-migration carry', () => {
    // Same gap c886834a2 closed for copySettingsFromCharacter and
    // importSettings: a settings map landed from a payload is not this
    // profile's own save-in-place, it is a map from somewhere else — an older
    // build's gist, or a device that has not run the merge yet — arriving
    // under this profile's key-migration record. That record must be forgotten
    // for exactly the maps that did not bring their own, so the next load
    // reconciles what actually landed instead of trusting a record that
    // describes a map that is no longer there.
    test('a settings map lands and its key-migration record is handed to settingsStorage to reconcile', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: {
                settings: {
                    script_settingsMap_abc: { chatCommands: { isTrue: false } },
                    panelSizeMemory: 1,
                },
            },
        });

        await applyPayload(json);

        expect(reconcileKeyMigrationState).toHaveBeenCalledTimes(1);
        const keys = reconcileKeyMigrationState.mock.calls[0][0];
        expect([...keys]).toEqual(['script_settingsMap_abc', 'panelSizeMemory']);
    });

    test('a payload with no settings store never calls it', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { dungeonRuns: { run1: { kills: 1 } } },
        });

        await applyPayload(json);

        expect(reconcileKeyMigrationState).not.toHaveBeenCalled();
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

    test('a write still sitting in the debounce queue is part of the merge base', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: (local, incoming) => [...new Set([...local, ...incoming])],
            label: 'fake',
        });
        // What IndexedDB holds, and what this session recorded seconds ago and
        // has not flushed yet — `storage.set` debounces for three seconds
        storeState.stores.dungeonRuns = { run_char: ['old'] };
        storeState.pending = { dungeonRuns: { run_char: ['old', 'just-recorded'] } };

        try {
            await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

            // The queue is flushed before the import writes, so a merge base read
            // before that flush is stale — and the import then puts the stale union
            // straight back on top of the entry that just landed
            expect(importedPayloads[0].stores.dungeonRuns.run_char).toEqual(['old', 'just-recorded', 'remote']);
        } finally {
            off();
        }
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

    test('a local value that cannot be read holds the download back instead of overwriting it', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: () => ['should not run'],
            label: 'fake',
        });
        // `tryGet` answers null: the read failed, which says nothing about
        // whether this device holds entries under that key. Writing the
        // download over an unreadable base destroys exactly the entries the
        // failure hid, so the key must not reach the import at all.
        storeState.unreadable = true;

        const result = await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

        expect(importedPayloads[0].stores.dungeonRuns).not.toHaveProperty('run_char');
        expect(result.merged).toEqual([]);
        off();
    });

    test('a held-back record is reported, because the download did not land for it', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: () => ['should not run'],
            label: 'fake',
        });
        storeState.unreadable = true;

        const result = await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

        // Silence here is the whole bug: a pull that says nothing reads as
        // "combined", and the player never learns the record is still waiting
        expect(result.mergeHeld).toEqual([{ store: 'dungeonRuns', key: 'run_char', label: 'fake' }]);
        expect(result.mergeFailed).toEqual([]);
        off();
    });

    test('a held-back record makes the applied text describe what was written', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: () => ['should not run'],
            label: 'fake',
        });
        storeState.unreadable = true;

        const json = payloadWith('dungeonRuns', 'run_char', ['remote']);
        const result = await applyPayload(json);

        // The stamp remembered after a pull is a hash of `applied`. Handing
        // back the raw download, which still carries a key that was never
        // written, makes every later rebuild compare unequal — the permanent
        // conflict `contentHash` exists to avoid
        expect(result.applied).not.toBe(json);
        expect(JSON.parse(result.applied).stores.dungeonRuns).not.toHaveProperty('run_char');
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

    test('a merge that throws is reported, because this device’s copy of that record is gone', async () => {
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

        // Saying nothing would report a pull that overwrote a history as one
        // that combined it
        expect(result.mergeFailed).toEqual([{ store: 'dungeonRuns', key: 'run_char', label: 'fake' }]);
        off();
    });

    test('nothing is reported as failed when every fold worked', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: (local, incoming) => [...local, ...incoming],
            label: 'fake',
        });
        storeState.stores.dungeonRuns = { run_char: ['local'] };

        const result = await applyPayload(payloadWith('dungeonRuns', 'run_char', ['remote']));

        expect(result.mergeFailed).toEqual([]);
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

    test('personal trade price conflicts keep the newest observation instead of the pulling device', async () => {
        storeState.stores.settings.tradeHistory_char = {
            '/items/coin:0': { buy: 100, buyAt: 300, sell: 200, sellAt: 100 },
        };

        await applyPayload(
            payloadWith('settings', 'tradeHistory_char', {
                '/items/coin:0': { buy: 90, buyAt: 200, sell: 220, sellAt: 400 },
            })
        );

        expect(importedPayloads[0].stores.settings.tradeHistory_char['/items/coin:0']).toEqual({
            buy: 100,
            buyAt: 300,
            sell: 220,
            sellAt: 400,
        });
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

describe('what applyPayload reports as applied', () => {
    const payloadWith = (store, key, value) =>
        JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { [store]: { [key]: value } },
        });

    test('a merging pull reports the merged payload, not the raw download', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: (local, incoming) => [...local, ...incoming],
            label: 'fake',
        });
        storeState.stores.dungeonRuns = { run_char: ['local'] };

        const json = payloadWith('dungeonRuns', 'run_char', ['remote']);
        const result = await applyPayload(json);

        // The stamp that says "this is what this device now holds" has to be of
        // what was written; the download describes something never stored
        expect(result.applied).not.toBe(json);
        expect(JSON.parse(result.applied).stores.dungeonRuns.run_char).toEqual(['local', 'remote']);
        off();
    });

    test('a pull with nothing to rewrite hands back the text it was given', async () => {
        const json = payloadWith('dungeonRuns', 'unmergeable_key', ['remote']);

        const result = await applyPayload(json);

        expect(result.applied).toBe(json);
    });

    test('a shortfall from the import is carried through, so the caller can refuse to record it', async () => {
        importOutcome.complete = false;
        importOutcome.failed = [{ store: 'dungeonRuns', expected: 1, written: 0 }];

        const result = await applyPayload(payloadWith('dungeonRuns', 'unmergeable_key', ['remote']));

        expect(result.complete).toBe(false);
        expect(result.failed).toEqual([{ store: 'dungeonRuns', expected: 1, written: 0 }]);
    });
});

describe('what belongs to this script', () => {
    /**
     * The database is shared with other userscripts. Before the ownership
     * registry the payload was built by walking `listStores()` and uploading
     * whatever was there — another script's whole object store included, and its
     * keys inside `settings` beside ours. Measured live, two foreign keys came
     * to about 600 KB of every push and every pull.
     *
     * The restore is the half that matters more: a foreign key must not be
     * written back, and must not be *deleted* either. Leaving it exactly as it
     * is is the only correct answer for a record this script does not own.
     */
    beforeEach(() => {
        storeState.stores = {
            settings: {
                script_settingsMap_abc: { chatCommands: { isTrue: true } },
                panelGeometry: { left: 10 },
                'tradeLedgerRec_603281_2026-09-16': [{ id: 1 }],
                someOtherScriptsRecord: 'x'.repeat(2000),
            },
            dungeonRuns: { run1: { kills: 3 } },
            openableAnalytics: { chest_history: "another script's data" },
        };
    });

    test("another script's store never reaches the payload", async () => {
        const payload = JSON.parse(await buildPayloadJSON('everything'));

        expect(Object.keys(payload.stores)).toContain('dungeonRuns');
        expect(Object.keys(payload.stores)).not.toContain('openableAnalytics');
    });

    test("another script's key in the settings store is not uploaded", async () => {
        const payload = JSON.parse(await buildPayloadJSON('everything'));

        expect(payload.stores.settings.someOtherScriptsRecord).toBeUndefined();
    });

    test('every kind of key this script owns still travels', async () => {
        const payload = JSON.parse(await buildPayloadJSON('everything'));

        // A settings map, a scoped history record, a plain global flag and a
        // store of our own — the shapes a mistake here would break one at a time
        expect(payload.stores.settings.script_settingsMap_abc).toEqual({ chatCommands: { isTrue: true } });
        expect(payload.stores.settings['tradeLedgerRec_603281_2026-09-16']).toEqual([{ id: 1 }]);
        expect(payload.stores.settings.panelGeometry).toEqual({ left: 10 });
        expect(payload.stores.dungeonRuns).toEqual({ run1: { kills: 3 } });
    });

    test('a pull neither plants a foreign key nor disturbs the one already here', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-09-16T00:00:00.000Z',
            stores: {
                settings: { panelGeometry: { left: 99 }, someOtherScriptsRecord: 'from another device' },
                openableAnalytics: { chest_history: 'from another device' },
            },
        });

        await applyPayload(json);

        const written = importedPayloads[0].stores;
        expect(written.settings.panelGeometry).toEqual({ left: 99 });
        expect(written.settings.someOtherScriptsRecord).toBeUndefined();
        expect(written.openableAnalytics).toBeUndefined();
        // Not written back, and not deleted: what this device holds stands
        expect(storeState.stores.settings.someOtherScriptsRecord).toBe('x'.repeat(2000));
        expect(storeState.stores.openableAnalytics.chest_history).toBe("another script's data");
    });

    test('a gist written before any of this imports without complaint', async () => {
        // Every existing gist is one of these: foreign stores, foreign keys, and
        // no idea that either was a category
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: {
                settings: { someOtherScriptsRecord: 'old', panelGeometry: { left: 1 } },
                openableAnalytics: { chest_history: 'old' },
                aStoreThatNoLongerExists: { whatever: 1 },
            },
        });

        const result = await applyPayload(json);

        expect(result.complete).toBe(true);
        expect(Object.keys(importedPayloads[0].stores)).toEqual(['settings']);
        // What is remembered as "the state of this device" has to describe what
        // was applied, not what was downloaded
        expect(result.applied).not.toBe(json);
    });
});
