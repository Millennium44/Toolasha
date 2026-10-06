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
        putAll: async (name, entries, options) => {
            storeState.putAllCalls.push({ name, entries, options });
            // An aborted transaction: putAll says so with a short count, not a throw
            if (storeState.shortWrites > 0) {
                storeState.shortWrites -= 1;
                return 0;
            }
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
            return Object.keys(entries).length;
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
        if (importOutcome.throws) throw importOutcome.throws;
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

const {
    buildPayloadJSON,
    applyPayload,
    hashPayload,
    readExportedAt,
    redactSettingsStore,
    localStampWins,
    addsToRemote,
    mergeForUpload,
    wholeKeyHashes,
    SETTING_STAMPS_PREFIX,
    RESTORED_BASELINE,
} = await import('./sync-payload.js');

beforeEach(() => {
    importedPayloads.length = 0;
    importOutcome.failed = [];
    importOutcome.complete = true;
    importOutcome.throws = null;
    storeState.unreadable = false;
    storeState.pending = {};
    storeState.flushError = null;
    storeState.putAllCalls = [];
    storeState.shortWrites = 0;
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

    // The import refuses these before its first write; applyPayload used to
    // forget the migration records first, so a refused pull still cost the
    // maps their records and the next load replayed reconciling migrations
    test.each([
        ['a newer format', { formatVersion: 2, stores: { settings: { script_settingsMap_abc: {} } } }],
        ['no format at all', { stores: { settings: { script_settingsMap_abc: {} } } }],
        [
            'a store that is not a keyed object',
            { formatVersion: 1, stores: { settings: { script_settingsMap_abc: {} }, dungeonRuns: [1, 2] } },
        ],
        ['a settings store that is a string', { formatVersion: 1, stores: { settings: 'script_settingsMap_abc' } }],
    ])('a payload with %s is refused before any record is forgotten or written', async (_label, body) => {
        await expect(applyPayload(JSON.stringify(body))).rejects.toThrow();

        expect(reconcileKeyMigrationState).not.toHaveBeenCalled();
        expect(importedPayloads).toHaveLength(0);
        expect(flushLog).not.toContain('beginRestore');
    });

    describe('records forgotten for maps that then did not land are put back', () => {
        const RECORD = 'settings_key_migrations_applied_script_settingsMap_abc';
        const body = JSON.stringify({
            formatVersion: 1,
            stores: { settings: { script_settingsMap_abc: { chatCommands: { isTrue: false } } } },
        });

        beforeEach(() => {
            storeState.stores.settings[RECORD] = ['actionBarTimeDisplay'];
            storeState.stores.settings.settings_key_migrations_v2 = true;
            // The real reconcile deletes the record of every map that landed without one
            reconcileKeyMigrationState.mockImplementationOnce(async () => {
                delete storeState.stores.settings[RECORD];
                delete storeState.stores.settings.settings_key_migrations_v2;
            });
        });

        test('when the import throws', async () => {
            importOutcome.throws = new Error('listStores failed');
            await expect(applyPayload(body)).rejects.toThrow('listStores failed');

            expect(storeState.stores.settings[RECORD]).toEqual(['actionBarTimeDisplay']);
            expect(storeState.stores.settings.settings_key_migrations_v2).toBe(true);
            expect(storeState.putAllCalls[0].options).toEqual({ bypassRestoreLatch: true });
        });

        test('when the settings store did not write', async () => {
            importOutcome.complete = false;
            importOutcome.failed = [{ store: 'settings', expected: 1, written: 0 }];
            await applyPayload(body);

            expect(storeState.stores.settings[RECORD]).toEqual(['actionBarTimeDisplay']);
        });

        test('a restore write that comes back short is retried', async () => {
            importOutcome.throws = new Error('listStores failed');
            storeState.shortWrites = 1;
            await expect(applyPayload(body)).rejects.toThrow('listStores failed');

            expect(storeState.putAllCalls).toHaveLength(2);
            expect(storeState.stores.settings[RECORD]).toEqual(['actionBarTimeDisplay']);
        });

        test('but not when the maps landed', async () => {
            await applyPayload(body);

            expect(storeState.stores.settings[RECORD]).toBeUndefined();
            expect(storeState.putAllCalls).toHaveLength(0);
        });
    });

    test("another script's malformed store does not stop the pull", async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            stores: { settings: { script_settingsMap_abc: {} }, someoneElsesStore: 'not a map' },
        });

        await applyPayload(json);

        expect(importedPayloads).toHaveLength(1);
        expect(importedPayloads[0].stores.someoneElsesStore).toBeUndefined();
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

describe('settings change stamps', () => {
    const MAP = 'script_settingsMap_abc';
    const STAMPS = `settings_changedAt_${MAP}`;
    const pull = (stores, mode) =>
        applyPayload(JSON.stringify({ formatVersion: 1, exportedAt: 'x', stores }), mode ? { mode } : undefined);
    const landed = () => importedPayloads.at(-1).stores.settings;

    test('the prefix matches the one core/settings-storage.js writes', () => {
        expect(SETTING_STAMPS_PREFIX).toBe('settings_changedAt_');
    });

    test.each([
        ['the later change wins, whatever the counters say', { at: 9, seq: 1 }, { at: 1, seq: 5 }, true],
        ['the earlier change loses, whatever the counters say', { at: 1, seq: 5 }, { at: 9, seq: 1 }, false],
        ['an exact tie of clocks goes to the higher counter', { at: 5, seq: 4 }, { at: 5, seq: 3 }, true],
        ['a system stamp loses to any change a person made', { at: 0, system: true }, { at: 1, seq: null }, false],
        ['a system stamp still beats no stamp', { at: 0, system: true }, undefined, true],
        ['a stamp beats no stamp', { at: 1, seq: null }, undefined, true],
        ['no stamp loses to a stamp', undefined, { at: 1, seq: null }, false],
        ['neither stamped: the download', undefined, undefined, false],
        ['an exact tie: the download', { at: 5, seq: 2 }, { at: 5, seq: 2 }, false],
        ['a stamp that is not one counts as none', { at: 'soon' }, { at: 1, seq: 0 }, false],
    ])('%s', (_label, local, incoming, localWins) => {
        expect(localStampWins(local, incoming)).toBe(localWins);
    });

    test('an automatic merge keeps the newer change of a setting both sides have', async () => {
        storeState.stores.settings[MAP] = { A: { isTrue: true }, B: { isTrue: true }, localOnly: { isTrue: true } };
        storeState.stores.settings[STAMPS] = { A: { at: 100, seq: 1 }, B: { at: 10, seq: 9 } };

        await pull(
            {
                settings: {
                    [MAP]: { A: { isTrue: false }, B: { isTrue: false }, remoteOnly: { isTrue: true } },
                    [STAMPS]: { A: { at: 99, seq: 2 }, B: { at: 11, seq: 2 } },
                },
            },
            'merge'
        );

        const map = landed()[MAP];
        expect(map.A).toEqual({ isTrue: true });
        expect(map.B).toEqual({ isTrue: false });
        expect(map.localOnly).toEqual({ isTrue: true });
        expect(map.remoteOnly).toEqual({ isTrue: true });
        // Each value keeps the stamp of the side it came from
        expect(landed()[STAMPS]).toEqual({ A: { at: 100, seq: 1 }, B: { at: 11, seq: 2 } });
    });

    test('a pull someone asked for still takes the download for every setting it names', async () => {
        storeState.stores.settings[MAP] = { A: { isTrue: true }, localOnly: { isTrue: true } };
        storeState.stores.settings[STAMPS] = { A: { at: 10, seq: 9 }, localOnly: { at: 3, seq: 1 } };

        await pull({ settings: { [MAP]: { A: { isTrue: false } } } });

        expect(landed()[MAP]).toMatchObject({ A: { isTrue: false }, localOnly: { isTrue: true } });
        // The download's A carried no stamp, so A has none now; localOnly keeps its own
        expect(landed()[STAMPS]).toEqual({ localOnly: { at: 3, seq: 1 } });
    });

    test('stamps for a map the payload does not carry are not taken', async () => {
        storeState.stores.settings[STAMPS] = { A: { at: 1, seq: 1 } };
        await pull({ settings: { [STAMPS]: { A: { at: 99, seq: 99 } } } }, 'merge');
        expect(landed()[STAMPS]).toBeUndefined();
    });

    test('the token and the thread count keep this device value and carry no stamp either way', async () => {
        storeState.stores.settings[MAP] = { sync_token: { value: 'ghp_mine' } };
        storeState.stores.settings[STAMPS] = { sync_token: { at: 1, seq: 1 } };

        await pull(
            {
                settings: {
                    [MAP]: { sync_token: { value: 'ghp_theirs' }, combatSim_maxThreads: { value: 8 } },
                    [STAMPS]: { sync_token: { at: 9, seq: 9 }, combatSim_maxThreads: { at: 9, seq: 9 } },
                },
            },
            'merge'
        );

        expect(landed()[MAP]).toEqual({ sync_token: { value: 'ghp_mine' } });
        expect(landed()[STAMPS]).toEqual({});
    });

    test('stamps travel, without the stamps of the settings that do not', () => {
        const safe = redactSettingsStore({
            [STAMPS]: { chatCommands: { at: 1, seq: 1 }, sync_token: { at: 2, seq: 2 } },
        });
        expect(safe[STAMPS]).toEqual({ chatCommands: { at: 1, seq: 1 } });
    });
});

describe('addsToRemote, the automatic merge loop guard', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: 'x', stores });

    test('the same data in another order adds nothing', () => {
        expect(
            addsToRemote(
                payloadOf({ settings: { a: { x: 1, y: 2 }, b: 1 } }),
                payloadOf({ settings: { b: 1, a: { y: 2, x: 1 } } })
            )
        ).toBe(false);
    });

    test('a key the gist lacks, or a value it does not have, is news', () => {
        expect(addsToRemote(payloadOf({ settings: { a: 1, b: 2 } }), payloadOf({ settings: { a: 1 } }))).toBe(true);
        expect(addsToRemote(payloadOf({ settings: { a: 1 } }), payloadOf({ settings: { a: 2 } }))).toBe(true);
    });

    test('a key only the gist has is not news from this device', () => {
        expect(addsToRemote(payloadOf({ settings: { a: 1 } }), payloadOf({ settings: { a: 1, b: 2 } }))).toBe(false);
    });

    test('a merged record is folded into the gist copy, so a union in another order adds nothing', () => {
        const unregister = registerSyncMerge({
            store: 'xpHistory',
            base: 'loopGuardTest',
            merge: (local, incoming) => [...new Set([...(local || []), ...(incoming || [])])],
        });
        try {
            const remote = payloadOf({ xpHistory: { loopGuardTest_1: ['a', 'b'] } });
            expect(addsToRemote(payloadOf({ xpHistory: { loopGuardTest_1: ['b', 'a'] } }), remote)).toBe(false);
            expect(addsToRemote(payloadOf({ xpHistory: { loopGuardTest_1: ['b', 'a', 'c'] } }), remote)).toBe(true);
        } finally {
            unregister();
        }
    });

    test('a newer stamp is news even with the value unchanged, since it decides a later merge', () => {
        const stamps = `${SETTING_STAMPS_PREFIX}m`;
        expect(
            addsToRemote(
                payloadOf({ settings: { [stamps]: { a: { at: 9 } }, m: { a: 1 } } }),
                payloadOf({ settings: { [stamps]: { a: { at: 1 } }, m: { a: 1 } } })
            )
        ).toBe(true);
        expect(
            addsToRemote(
                payloadOf({ settings: { [stamps]: { a: { at: 9 } }, m: { a: 1 } } }),
                payloadOf({ settings: { [stamps]: { a: { at: 9 } }, m: { a: 1 } } })
            )
        ).toBe(false);
    });
});

describe('the whole-value baseline', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: 'x', stores });

    test('fingerprints every key but the settings maps and their stamps', () => {
        const hashes = wholeKeyHashes(
            payloadOf({
                settings: {
                    panelGeometry: { x: 1 },
                    script_settingsMap_abc: {},
                    settings_changedAt_script_settingsMap_abc: {},
                    treasureTally_abc: {},
                },
            })
        );
        expect(Object.keys(hashes).sort()).toEqual(['settings\u0000panelGeometry', 'settings\u0000treasureTally_abc']);
    });

    test('ignores the order an object was written in', () => {
        const a = wholeKeyHashes(payloadOf({ settings: { k: { x: 1, y: 2 } } }));
        const b = wholeKeyHashes(payloadOf({ settings: { k: { y: 2, x: 1 } } }));
        expect(a).toEqual(b);
    });

    test('a startup merge keeps a value this device moved while the gist did not', async () => {
        const baseline = wholeKeyHashes(payloadOf({ settings: { panelGeometry: { x: 1 }, panelSizeMemory: 1 } }));
        storeState.stores.settings.panelGeometry = { x: 2 }; // moved here
        storeState.stores.settings.panelSizeMemory = 1; // not moved here

        await applyPayload(payloadOf({ settings: { panelGeometry: { x: 1 }, panelSizeMemory: 7 } }), {
            mode: 'merge',
            baseline,
        });

        const landedSettings = importedPayloads.at(-1).stores.settings;
        // Not in the import, so the newer local value stays where it is
        expect(Object.hasOwn(landedSettings, 'panelGeometry')).toBe(false);
        expect(landedSettings.panelSizeMemory).toBe(7);
    });

    test('with both sides moved, or no baseline, the download is written as a pull always did', async () => {
        storeState.stores.settings.panelGeometry = { x: 2 };
        const both = wholeKeyHashes(payloadOf({ settings: { panelGeometry: { x: 1 } } }));
        await applyPayload(payloadOf({ settings: { panelGeometry: { x: 3 } } }), { mode: 'merge', baseline: both });
        expect(importedPayloads.at(-1).stores.settings.panelGeometry).toEqual({ x: 3 });

        await applyPayload(payloadOf({ settings: { panelGeometry: { x: 1 } } }), { mode: 'merge', baseline: null });
        expect(importedPayloads.at(-1).stores.settings.panelGeometry).toEqual({ x: 1 });
    });

    test('a pull someone asked for ignores the baseline', async () => {
        const baseline = wholeKeyHashes(payloadOf({ settings: { panelGeometry: { x: 1 } } }));
        storeState.stores.settings.panelGeometry = { x: 2 };
        await applyPayload(payloadOf({ settings: { panelGeometry: { x: 1 } } }), { baseline });
        expect(importedPayloads.at(-1).stores.settings.panelGeometry).toEqual({ x: 1 });
    });
});

describe('mergeForUpload, which writes nothing local', () => {
    const MAP = 'script_settingsMap_abc';
    const STAMPS = `settings_changedAt_${MAP}`;
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: 'x', syncScope: 'settings', stores });

    test('takes the later change of each setting, each with its own stamp', () => {
        const local = payloadOf({
            settings: { [MAP]: { A: { v: 'mine' }, B: { v: 'mine' } }, [STAMPS]: { A: { at: 20 }, B: { at: 5 } } },
        });
        const remote = payloadOf({
            settings: { [MAP]: { A: { v: 'theirs' }, B: { v: 'theirs' } }, [STAMPS]: { A: { at: 10 }, B: { at: 30 } } },
        });

        const { text } = mergeForUpload(local, remote, null);
        const merged = JSON.parse(text).stores.settings;

        expect(merged[MAP]).toEqual({ A: { v: 'mine' }, B: { v: 'theirs' } });
        expect(merged[STAMPS]).toEqual({ A: { at: 20 }, B: { at: 30 } });
    });

    test('folds a registered history with its merge, and keeps keys either side alone has', () => {
        const local = payloadOf({ settings: { treasureTally_abc: { chests: { a: 3 } }, panelGeometry: 1 } });
        const remote = payloadOf({ settings: { treasureTally_abc: { chests: { a: 1, b: 2 } }, panelSizeMemory: 2 } });

        const merged = JSON.parse(mergeForUpload(local, remote, null).text).stores.settings;

        expect(merged.panelGeometry).toBe(1);
        expect(merged.panelSizeMemory).toBe(2);
        expect(merged.treasureTally_abc).toBeDefined();
    });

    test("a whole-value key keeps this device's value only when the gist's is still the one last exchanged", () => {
        // panelGeometry moved here, panelSizeMemory moved there, panelOpenState
        // moved on both, whatsNew_state has no baseline at all
        const baseline = wholeKeyHashes(
            payloadOf({ settings: { panelGeometry: 1, panelSizeMemory: 1, panelOpenState: 1 } })
        );
        const local = payloadOf({
            settings: { panelGeometry: 2, panelSizeMemory: 1, panelOpenState: 2, whatsNew_state: 'mine' },
        });
        const remote = payloadOf({
            settings: { panelGeometry: 1, panelSizeMemory: 3, panelOpenState: 3, whatsNew_state: 'theirs' },
        });

        const merged = JSON.parse(mergeForUpload(local, remote, baseline).text).stores.settings;

        expect(merged).toMatchObject({
            panelGeometry: 2,
            panelSizeMemory: 3,
            panelOpenState: 3,
            whatsNew_state: 'theirs',
        });
    });

    test("never uploads another device's token or another script's keys from the gist", () => {
        const local = payloadOf({ settings: { [MAP]: { A: { v: 1 } } } });
        const remote = payloadOf({
            settings: { [MAP]: { A: { v: 1 }, sync_token: { value: 'ghp_old' } }, toolasha_sync_gistId: 'x' },
            someoneElsesStore: { k: 1 },
        });

        const merged = JSON.parse(mergeForUpload(local, remote, null).text);

        expect(merged.stores.settings[MAP].sync_token).toBeUndefined();
        expect(merged.stores.settings.toolasha_sync_gistId).toBeUndefined();
        expect(merged.stores.someoneElsesStore).toBeUndefined();
    });

    test('refuses a gist in a format this build does not read', () => {
        expect(() =>
            mergeForUpload(payloadOf({ settings: {} }), JSON.stringify({ formatVersion: 2, stores: {} }), null)
        ).toThrow();
    });

    test('a restore marker gives precedence to the keys it lists; an older marker shape to none', () => {
        const local = payloadOf({ settings: { panelGeometry: 'restored', panelSizeMemory: 'stale' } });
        const remote = payloadOf({ settings: { panelGeometry: 'theirs', panelSizeMemory: 'theirs' } });
        const merge = (marker) =>
            JSON.parse(mergeForUpload(local, remote, { [RESTORED_BASELINE]: marker }).text).stores.settings;

        expect(merge({ at: 1, keys: { settings: ['panelGeometry'] } })).toMatchObject({
            panelGeometry: 'restored',
            panelSizeMemory: 'theirs',
        });
        for (const old of [123, { at: 1, stores: ['settings'] }]) {
            expect(merge(old)).toMatchObject({ panelGeometry: 'theirs', panelSizeMemory: 'theirs' });
        }
    });

    test('says whether the gist held anything this device lacks', () => {
        const local = payloadOf({ settings: { panelGeometry: 1 } });
        expect(mergeForUpload(local, payloadOf({ settings: { panelGeometry: 1 } }), null).remoteAdds).toBe(false);
        expect(
            mergeForUpload(local, payloadOf({ settings: { panelGeometry: 1, panelSizeMemory: 2 } }), null).remoteAdds
        ).toBe(true);
    });

    test('a gist that differs only where this device won the merge holds nothing for it', () => {
        // The gist's X is older than this device's, and its panel position is
        // the one this device last exchanged: this device wins both, so a
        // startup pull of the result would change nothing here
        const baseline = wholeKeyHashes(payloadOf({ settings: { panelGeometry: { x: 1 } } }));
        const local = payloadOf({
            settings: { [MAP]: { X: { v: 'new' } }, [STAMPS]: { X: { at: 20 } }, panelGeometry: { x: 2 } },
        });
        const remote = payloadOf({
            settings: { [MAP]: { X: { v: 'old' } }, [STAMPS]: { X: { at: 10 } }, panelGeometry: { x: 1 } },
        });

        expect(mergeForUpload(local, remote, baseline).remoteAdds).toBe(false);
    });

    test('the result is a payload an older build restores: format 1, stamps beside the map', () => {
        const local = payloadOf({ settings: { [MAP]: { A: { isTrue: true } }, [STAMPS]: { A: { at: 1 } } } });
        const merged = JSON.parse(mergeForUpload(local, payloadOf({ settings: {} }), null).text);
        expect(merged.formatVersion).toBe(1);
        expect(merged.stores.settings[MAP].A).toEqual({ isTrue: true });
    });
});
