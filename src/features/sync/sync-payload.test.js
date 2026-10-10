import { describe, test, expect, beforeEach, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: {} }));

vi.mock('../../core/storage.js', () => ({
    default: {
        listStores: async () => Object.keys(storeState.stores),
        getAll: async (name) => {
            if (storeState.getAllThrows === name) throw new Error('unreadable store');
            return { ...(storeState.stores[name] || {}) };
        },
        tryGet: async (key, name) => {
            // Unreadable histories, not the sync's own registry record (whose
            // failed read is its own case, in sync-external-keys.test.js)
            if (storeState.unreadable && key !== 'toolasha_sync_externalKeys') return null;
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
        delete: async (key, name, options = {}) => {
            if (storeState.deleteFails) return false;
            storeState.deleteCalls = [...(storeState.deleteCalls || []), { key, name, options }];
            if (storeState.latched?.has(name) && !options.bypassRestoreLatch) return false;
            if (storeState.deleteFails) return false;
            delete (storeState.stores[name] || {})[key];
            return true;
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
    // One pair, as the real one declares for the settings store
    tombstoneCompanionKey: (store, key, { recordOnly = false } = {}) => {
        if (store !== 'settings') return null;
        if (key === 'enhancementTracker_sessions') return 'enhancementTracker_sessionTombstones';
        return key === 'enhancementTracker_sessionTombstones' && !recordOnly ? 'enhancementTracker_sessions' : null;
    },
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
await import('../guild/guild-xp-tracker.js');
await import('../guild/guild-trials-store.js');
await import('../skills/xp-tracker.js');
// The detail snapshots' retention window, registered the way the page does
await import('../networth/networth-history.js');
// The guild trial ledger's 26-week cap, registered the way the page does
const { ledgerCycleKey, MAX_LEDGER_CYCLES } = await import('../guild/guild-trial-ledger.js');
// Task completions: a chunked history whose pull prunes the incoming side
const { weekChunkId, WINDOW_WEEKS } = await import('../tasks/task-completion-tracker.js');
// Saved meter sessions: bodies kept exactly while their index lists them
await import('../combat/meter-history.js');

const {
    payloadCarriesKey,
    buildPayloadJSON,
    resetLeftOutLogForTests,
    applyPayload,
    retryPendingDisplacedDeletes,
    hashPayload,
    readExportedAt,
    redactSettingsStore,
    localStampWins,
    addsToRemote,
    mergeForUpload,
    trimmedRegisteredKeys,
    pushTrimsRegisteredKeys,
    wholeKeyHashes,
    exchangeBaseline,
    SETTING_STAMPS_PREFIX,
    RESTORED_BASELINE,
} = await import('./sync-payload.js');

beforeEach(() => {
    resetLeftOutLogForTests();
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

    test('logs what it left out once, and again only when the summary changes', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const leftOut = () => info.mock.calls.filter((c) => String(c[0]).includes('Left out of the payload'));
        try {
            await buildPayloadJSON('everything');
            await buildPayloadJSON('everything');
            expect(leftOut()).toHaveLength(1);

            storeState.stores.settings.another_foreign_key = 7;
            await buildPayloadJSON('everything');
            await buildPayloadJSON('everything');
            expect(leftOut()).toHaveLength(2);
        } finally {
            info.mockRestore();
        }
    });

    test('logs again when left-out data returns after a build that left nothing out', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const leftOut = () => info.mock.calls.filter((c) => String(c[0]).includes('Left out of the payload'));
        try {
            storeState.stores.settings = { script_settingsMap_603281: {}, other_script_key: 1 };
            await buildPayloadJSON('settings');
            expect(leftOut()).toHaveLength(1);

            delete storeState.stores.settings.other_script_key;
            await buildPayloadJSON('settings');
            expect(leftOut()).toHaveLength(1);

            storeState.stores.settings.other_script_key = 1;
            await buildPayloadJSON('settings');
            expect(leftOut()).toHaveLength(2);
        } finally {
            info.mockRestore();
        }
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

        // The fold keeps this device's map, which then has nothing to write
        expect(importedPayloads[0].stores.settings.script_settingsMap_abc?.sync_token).toBeUndefined();
        expect(storeState.stores.settings.script_settingsMap_abc).toEqual({ chatCommands: { isTrue: true } });
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
        ['a settings store that is an array', { formatVersion: 1, stores: { settings: [{ chatCommands: {} }] } }],
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

describe('applyPayload writes only what it changes', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', stores });

    test('a download of what this device holds writes nothing, and says how much it left alone', async () => {
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: (local, incoming) => [...new Set([...local, ...incoming])],
            label: 'fake',
        });
        storeState.stores.dungeonRuns = { run_char: ['a', 'b'], plan: { b: 2, a: 1 } };

        try {
            const json = payloadOf({ dungeonRuns: { run_char: ['a', 'b'], plan: { a: 1, b: 2 } } });
            const result = await applyPayload(json);

            expect(importedPayloads[0].stores.dungeonRuns).toEqual({});
            expect(result.unchanged).toEqual({ dungeonRuns: 2 });
            // A fold that changed nothing is not reported as combined
            expect(result.merged).toEqual([]);
            // What this device holds is still the whole payload
            expect(JSON.parse(result.applied).stores.dungeonRuns).toEqual({
                run_char: ['a', 'b'],
                plan: { a: 1, b: 2 },
            });
        } finally {
            off();
        }
    });

    test('a key that moved is written and counted, beside the ones left alone', async () => {
        storeState.stores.dungeonRuns = { same: 1, moved: 1 };

        const result = await applyPayload(payloadOf({ dungeonRuns: { same: 1, moved: 2, added: 3 } }));

        expect(importedPayloads[0].stores.dungeonRuns).toEqual({ moved: 2, added: 3 });
        expect(result.unchanged).toEqual({ dungeonRuns: 1 });
    });

    test('keys the import would strip are not counted as already the same', async () => {
        storeState.stores.guildHistory = { trialTraceChunk_1: 'x', kept: 1 };

        const result = await applyPayload(payloadOf({ guildHistory: { trialTraceChunk_1: 'x', kept: 1 } }));

        // The trace chunk is not part of the pull at all; only the record that would have been written counts
        expect(result.unchanged).toEqual({ guildHistory: 1 });
    });

    test('a store that cannot be read writes all of it, as a pull always did', async () => {
        storeState.stores.dungeonRuns = { same: 1 };
        storeState.getAllThrows = 'dungeonRuns';

        try {
            const result = await applyPayload(payloadOf({ dungeonRuns: { same: 1 } }));
            expect(importedPayloads[0].stores.dungeonRuns).toEqual({ same: 1 });
            expect(result.unchanged).toEqual({});
        } finally {
            storeState.getAllThrows = null;
        }
    });

    test('a record and its tombstones are written together when either moved', async () => {
        const RECORD = 'enhancementTracker_sessions';
        const GRAVES = 'enhancementTracker_sessionTombstones';
        storeState.stores.settings[RECORD] = { s1: 1 };
        storeState.stores.settings[GRAVES] = { s0: 1 };

        await applyPayload(payloadOf({ settings: { [RECORD]: { s1: 1 }, [GRAVES]: { s0: 1, s1: 2 } } }));

        // The record did not move, but goes in with its tombstones so the restore reconciles the pair
        expect(Object.keys(importedPayloads[0].stores.settings).sort()).toEqual([GRAVES, RECORD]);
    });

    test('an unchanged record goes in when only this device holds tombstones that hide part of it', async () => {
        const RECORD = 'enhancementTracker_sessions';
        const GRAVES = 'enhancementTracker_sessionTombstones';
        storeState.stores.settings[RECORD] = { s1: 1, s2: 1 };
        storeState.stores.settings[GRAVES] = { s1: 5 };

        await applyPayload(payloadOf({ settings: { [RECORD]: { s1: 1, s2: 1 } } }));

        // The restore must see the record to clear the tombstone hiding s1
        expect(Object.keys(importedPayloads[0].stores.settings)).toContain(RECORD);
    });

    test('a merge keeps tombstones this device changed since the last exchange', async () => {
        const RECORD = 'enhancementTracker_sessions';
        const GRAVES = 'enhancementTracker_sessionTombstones';
        // s1 was deleted here after the last exchange; the gist still has the old tombstones
        storeState.stores.settings[RECORD] = { s1: 1 };
        storeState.stores.settings[GRAVES] = { s1: 5 };
        const baseline = wholeKeyHashes(payloadOf({ settings: { [RECORD]: { s1: 1 }, [GRAVES]: {} } }));

        await applyPayload(payloadOf({ settings: { [RECORD]: { s1: 1 }, [GRAVES]: {} } }), {
            mode: 'merge',
            baseline,
        });

        // Neither half is written, so the restore cannot clear the newer tombstone
        expect(importedPayloads[0].stores.settings[RECORD]).toBeUndefined();
        expect(importedPayloads[0].stores.settings[GRAVES]).toBeUndefined();
    });

    test('a merge keeps tombstones this device created after a tombstone-free exchange', async () => {
        const RECORD = 'enhancementTracker_sessions';
        const GRAVES = 'enhancementTracker_sessionTombstones';
        // No tombstones at the last exchange or in the gist; s1 was deleted here since
        storeState.stores.settings[RECORD] = { s1: 1 };
        storeState.stores.settings[GRAVES] = { s1: 5 };
        const baseline = wholeKeyHashes(payloadOf({ settings: { [RECORD]: { s1: 1 } } }));

        await applyPayload(payloadOf({ settings: { [RECORD]: { s1: 1 } } }), { mode: 'merge', baseline });

        expect(importedPayloads[0].stores.settings[RECORD]).toBeUndefined();
    });

    test('unchanged tombstones arriving without their record are not written', async () => {
        const RECORD = 'enhancementTracker_sessions';
        const GRAVES = 'enhancementTracker_sessionTombstones';
        storeState.stores.settings[RECORD] = { s1: 1 };
        storeState.stores.settings[GRAVES] = { s1: 5 };

        await applyPayload(payloadOf({ settings: { [GRAVES]: { s1: 5 }, panelSizeMemory: 1 } }));

        expect(importedPayloads[0].stores.settings[GRAVES]).toBeUndefined();
    });

    test('an unchanged record stays out when the tombstones on this device hide none of it', async () => {
        const RECORD = 'enhancementTracker_sessions';
        const GRAVES = 'enhancementTracker_sessionTombstones';
        storeState.stores.settings[RECORD] = { s1: 1 };
        storeState.stores.settings[GRAVES] = { s0: 5 };

        await applyPayload(payloadOf({ settings: { [RECORD]: { s1: 1 }, panelSizeMemory: 1 } }));

        expect(Object.keys(importedPayloads[0].stores.settings)).not.toContain(RECORD);
    });

    test('a settings map that comes down unchanged is not handed over as landing', async () => {
        storeState.stores.settings.script_settingsMap_abc = { chatCommands: { isTrue: true } };

        await applyPayload(
            payloadOf({
                settings: { script_settingsMap_abc: { chatCommands: { isTrue: true } }, panelSizeMemory: 1 },
            })
        );

        expect([...reconcileKeyMigrationState.mock.calls.at(-1)[0]]).toEqual(['panelSizeMemory']);
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

        // The map folds back to this device's own, so it is left as it is rather than written
        expect(Object.hasOwn(landed(), MAP)).toBe(false);
        expect(storeState.stores.settings[MAP]).toEqual({ sync_token: { value: 'ghp_mine' } });
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

describe('the guild trial ledger cap reaches sync', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: 'x', stores });
    const WEEK = 7 * 24 * 60 * 60 * 1000;

    test('a week past the cap that the gist still holds is not written back', async () => {
        const weeks = Array.from({ length: MAX_LEDGER_CYCLES + 1 }, (_, i) => 1_700_000_000_000 + i * WEEK);
        const record = (weekStart) => ({ weekStart, scope: 'g', trials: [], members: {}, participation: {} });
        // This device pruned its oldest week; the gist (never told) still has all 27
        storeState.stores.guildHistory = Object.fromEntries(
            weeks.slice(1).map((week) => [ledgerCycleKey('g', week), record(week)])
        );
        const gist = Object.fromEntries(weeks.map((week) => [ledgerCycleKey('g', week), record(week)]));

        await applyPayload(payloadOf({ guildHistory: gist }), { mode: 'merge', baseline: null });

        const landed = importedPayloads.at(-1).stores.guildHistory || {};
        expect(Object.hasOwn(landed, ledgerCycleKey('g', weeks[0]))).toBe(false);
        expect(Object.keys(landed).length).toBeLessThanOrEqual(MAX_LEDGER_CYCLES);
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

    test('a registered key this device alone moved is still folded: its scalar wins, the gist keeps its entries', () => {
        // A capped fold: this device keeps two, and its copy is trimmed to them
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'cappedRuns',
            merge: (base, incoming, context) => ({
                sortBy: incoming?.sortBy ?? base?.sortBy,
                runs: [...new Set([...(base?.runs || []), ...(incoming?.runs || [])])]
                    .sort((x, y) => y - x)
                    .slice(0, context?.forUpload ? Infinity : 2),
            }),
            label: 'capped',
        });
        const full = (value) =>
            JSON.stringify({
                formatVersion: 1,
                exportedAt: 'x',
                syncScope: 'everything',
                stores: { dungeonRuns: { cappedRuns_c1: value } },
            });
        const gist = { sortBy: 'old', runs: [5, 4, 3, 2, 1] };
        const local = { sortBy: 'new', runs: [6, 5] };

        const merged = JSON.parse(mergeForUpload(full(local), full(gist), wholeKeyHashes(full(gist))).text);

        expect(merged.stores.dungeonRuns.cappedRuns_c1).toEqual({ sortBy: 'new', runs: [6, 5, 4, 3, 2, 1] });
        off();
    });

    test('a legacy custom-tab edit only this device made is uploaded, and the gist is not called in step', async () => {
        // The real registration: unstamped tabs on both sides tie, and the tie
        // must go to the side the upload chose to win — this device's
        await import('../inventory/custom-tabs/custom-tabs-data.js');
        const KEY = 'c1_inventoryTabs_config';
        const config = (name, items) => ({
            version: 1,
            tabs: [{ id: 't1', name, items, children: [] }],
            selectedTabId: 't1',
        });
        const gist = payloadOf({ settings: { [KEY]: config('Ores', ['/items/copper_ore']) } });
        const local = payloadOf({ settings: { [KEY]: config('Metals', ['/items/copper_ore', '/items/iron_ore']) } });

        const result = mergeForUpload(local, gist, wholeKeyHashes(gist));
        const tab = JSON.parse(result.text).stores.settings[KEY].tabs[0];

        expect(tab.name).toBe('Metals');
        expect(tab.items).toContain('/items/iron_ore');
        // The push decision: the upload changes the gist
        expect(addsToRemote(result.text, gist)).toBe(true);
        // And a pull of what was uploaded keeps this device's tab as it is
        expect(result.remoteAdds).toBe(false);
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

    test('says whether it left out stores the gist holds that this scope does not sync', () => {
        const local = payloadOf({ settings: { panelSizeMemory: 1 } });
        const withHistory = payloadOf({ settings: { panelSizeMemory: 1 }, xpHistory: { h: [1] } });
        expect(mergeForUpload(local, withHistory, null).dropsFromRemote).toBe(true);
        expect(
            mergeForUpload(local, payloadOf({ settings: { panelSizeMemory: 1 }, xpHistory: {} }), null).dropsFromRemote
        ).toBe(false);
        expect(mergeForUpload(local, payloadOf({ settings: { panelSizeMemory: 1 } }), null).dropsFromRemote).toBe(
            false
        );
        const everything = JSON.stringify({ ...JSON.parse(local), syncScope: 'everything' });
        expect(mergeForUpload(everything, withHistory, null).dropsFromRemote).toBe(false);
    });

    test('says so when it cleans a key out of a store it keeps, so the cleaned copy is written', () => {
        // An older build uploaded a key this one keeps on the device; the
        // rest of the gist matches. The loop guard only asks about keys the
        // upload holds, so without the flag the gist kept the key for ever
        const local = payloadOf({ settings: { panelSizeMemory: 1 } });
        const remote = payloadOf({ settings: { panelSizeMemory: 1, toolasha_local_whispers: ['private'] } });
        const merged = mergeForUpload(local, remote, null);

        expect(addsToRemote(merged.text, remote)).toBe(false);
        expect(merged.dropsFromRemote).toBe(true);
        expect(JSON.parse(merged.text).stores.settings).not.toHaveProperty('toolasha_local_whispers');
        // And a gist with nothing to clean stays quiet
        expect(mergeForUpload(local, payloadOf({ settings: { panelSizeMemory: 1 } }), null).dropsFromRemote).toBe(
            false
        );
    });

    test('says so when it redacts a device-local setting out of a settings map the gist holds', () => {
        const MAP = 'script_settingsMap_abc';
        const local = payloadOf({ settings: { panelSizeMemory: 1 } });
        const remote = payloadOf({ settings: { panelSizeMemory: 1, [MAP]: { sync_token: { value: 'ghp_x' } } } });
        expect(mergeForUpload(local, remote, null).dropsFromRemote).toBe(true);
        const clean = payloadOf({ settings: { panelSizeMemory: 1, [MAP]: { other: { value: 1 } } } });
        expect(mergeForUpload(local, clean, null).dropsFromRemote).toBe(false);
        // The same map as text, in another layout, is not a removal
        const asText = payloadOf({
            settings: { panelSizeMemory: 1, [MAP]: JSON.stringify({ other: { value: 1 } }, null, 2) },
        });
        expect(mergeForUpload(local, asText, null).dropsFromRemote).toBe(false);
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

describe('trimmedRegisteredKeys, which asks only about histories a device caps', () => {
    const payloadOf = (stores) =>
        JSON.stringify({ formatVersion: 1, exportedAt: 'x', syncScope: 'everything', stores });
    const DAY = 24 * 60 * 60 * 1000;

    test('a history this device caps by its own setting reports, named by its label', () => {
        const off = registerSyncMerge({
            store: 'xpHistory',
            base: 'deviceCappedRuns',
            merge: (local, incoming, context) =>
                [...new Set([...(local || []), ...(incoming || [])])]
                    .sort((x, y) => y - x)
                    .slice(0, context?.forUpload ? Infinity : 2),
            label: 'Device capped runs',
            capsLocally: true,
        });
        try {
            const local = payloadOf({ xpHistory: { deviceCappedRuns_c1: [9, 8] } });
            const remote = payloadOf({ xpHistory: { deviceCappedRuns_c1: [9, 8, 7, 6, 5] } });
            expect(trimmedRegisteredKeys(local, remote)).toEqual([
                { store: 'xpHistory', key: 'deviceCappedRuns_c1', label: 'Device capped runs' },
            ]);
            expect(pushTrimsRegisteredKeys(local, remote)).toBe(true);
            // Nothing on the gist beyond the cap: nothing to lose
            expect(trimmedRegisteredKeys(local, payloadOf({ xpHistory: { deviceCappedRuns_c1: [9] } }))).toEqual([]);
        } finally {
            off();
        }
    });

    test('guild XP the push compacted away does not report: no cap dropped it', () => {
        const sample = (hours, xp) => ({ t: Date.parse('2026-10-01T00:00:00Z') + hours * 3600 * 1000, xp });
        // This device compacted its recent samples; the gist still holds the in-between readings
        const local = payloadOf({ guildHistory: { guildXP_Foo: { Foo: [sample(0, 1000), sample(5, 1500)] } } });
        const remote = payloadOf({
            guildHistory: {
                guildXP_Foo: { Foo: [sample(0, 1000), sample(1, 1100), sample(2, 1200), sample(5, 1500)] },
            },
        });
        expect(trimmedRegisteredKeys(local, remote)).toEqual([]);
    });

    test('member XP with a stale same-day row on the gist does not report', () => {
        const noon = Date.parse('2026-10-01T12:00:00Z');
        const local = payloadOf({ guildHistory: { memberXP_Foo: { 123: [{ t: noon + DAY, xp: 9000 }] } } });
        const remote = payloadOf({
            guildHistory: {
                memberXP_Foo: {
                    123: [
                        { t: noon, xp: 8000 },
                        { t: noon + 3600000, xp: 8100 },
                    ],
                },
            },
        });
        expect(trimmedRegisteredKeys(local, remote)).toEqual([]);
    });

    test('a guild trial record the fold normalizes does not report', () => {
        const record = (samples) => ({
            weekStart: 1790000000000,
            guildId: 7,
            guildName: 'Foo',
            history: [],
            tiles: { 'combat:1': { samples } },
        });
        const local = payloadOf({
            guildHistory: {
                guildTrials_Foo: record([
                    { t: 30, v: 3 },
                    { t: 10, v: 1 },
                ]),
            },
        });
        const remote = payloadOf({ guildHistory: { guildTrials_Foo: record([{ t: 20, v: 2 }]) } });
        expect(trimmedRegisteredKeys(local, remote)).toEqual([]);
    });

    test('rank badges with a stale gist copy do not report: the fold clamps capture times to a moving clock', async () => {
        const { mergeBoards, boardKey, RANK_BOARD_TYPES, RANK_CATEGORIES } =
            await import('../../utils/rank-badge-data.js');
        const rows = [['Alice', 1]];
        // A board captured "in the future" (fast clock) is clamped to now, and now moves between the two calls
        let tickClock = 1_000_000;
        const spy = vi.spyOn(Date, 'now').mockImplementation(() => (tickClock += 7));
        const off = registerSyncMerge({
            store: 'rankStore',
            key: 'rankBoards',
            merge: mergeBoards,
            label: 'Leaderboard rank badges',
        });
        try {
            const k = boardKey(RANK_BOARD_TYPES[0], RANK_CATEGORIES[0]);
            const local = payloadOf({
                rankStore: { rankBoards: { [k]: { at: 9_000_000_000, source: 'local', rows } } },
            });
            const remote = payloadOf({
                rankStore: { rankBoards: { [k]: { at: 9_000_000_500, source: 'server', rows } } },
            });
            expect(trimmedRegisteredKeys(local, remote)).toEqual([]);
        } finally {
            off();
            spy.mockRestore();
        }
    });

    test('a registration that does not opt in never reports, even when its fold mutates its input', () => {
        const off = registerSyncMerge({
            store: 'xpHistory',
            base: 'mutatingFold',
            merge: (local, incoming, context) => {
                const list = local || [];
                list.push(...(incoming || []));
                return context?.forUpload ? list : list.slice(0, 1);
            },
            label: 'Mutating fold',
        });
        try {
            const local = payloadOf({ xpHistory: { mutatingFold_c1: [1] } });
            const remote = payloadOf({ xpHistory: { mutatingFold_c1: [2, 3] } });
            expect(trimmedRegisteredKeys(local, remote)).toEqual([]);
        } finally {
            off();
        }
    });

    test('a device-capped history identical on both sides does not report: the push loses nothing', () => {
        const off = registerSyncMerge({
            store: 'xpHistory',
            base: 'sameBothSides',
            merge: (local, incoming, context) =>
                [...new Set([...(local || []), ...(incoming || [])])]
                    .sort((x, y) => y - x)
                    .slice(0, context?.forUpload ? Infinity : 20),
            label: 'Same both sides',
            capsLocally: true,
        });
        try {
            const sessions = Array.from({ length: 500 }, (_, i) => 1000 - i);
            const both = payloadOf({ xpHistory: { sameBothSides_c1: sessions } });
            expect(trimmedRegisteredKeys(both, both)).toEqual([]);
        } finally {
            off();
        }
    });

    test('a key this device does not carry reports only when it caps one', () => {
        const local = payloadOf({ guildHistory: {} });
        const remote = payloadOf({ guildHistory: { guildXP_Foo: { Foo: [{ t: 1, xp: 1 }] } } });
        expect(trimmedRegisteredKeys(local, remote)).toEqual([]);
    });
});

describe('payloadCarriesKey', () => {
    test('a setting this script owns travels', () => {
        expect(payloadCarriesKey('settings', 'script_settingsMap_603281')).toBe(true);
        expect(payloadCarriesKey('xpHistory', 'anything')).toBe(true);
    });

    test.each([
        ['settings', 'sessionBriefingLastAlive_603281'],
        ['settings', 'toolasha_local_liveGraph_603281'],
        ['settings', 'toolasha_sync_lastHash'],
        ['settings', 'waveGapTally'],
        ['settings', 'otherScriptStats'],
        ['guildHistory', 'trialTraceChunk_7'],
        ['openableAnalytics', 'anything'],
    ])('%s/%s never reaches a payload', (storeName, key) => {
        expect(payloadCarriesKey(storeName, key)).toBe(false);
    });
});

describe('keys a retention rule drops are neither uploaded nor written back', () => {
    const DAY = 'networthHistory';
    const payloadOf = (stores) =>
        JSON.stringify({ formatVersion: 1, exportedAt: '2026-10-08T00:00:00.000Z', syncScope: 'everything', stores });
    /** `networthDetail_<char>_<t>` snapshots, one an hour from `from` */
    const snapshots = (charId, from, count) => {
        const out = {};
        for (let i = 0; i < count; i++) {
            const t = from + i * 3_600_000;
            out[`networthDetail_${charId}_${t}`] = { t, items: { gold: { count: 1, value: t % 1000 } } };
        }
        return out;
    };
    const T0 = 1_790_000_000_000;

    test('a pull does not write back snapshots older than the 25 this device keeps per character', async () => {
        // The gist still holds the 10 oldest; this device pruned them
        const gist = snapshots('32030', T0, 35);
        const local = snapshots('32030', T0 + 10 * 3_600_000, 25);
        storeState.stores[DAY] = { ...local };

        const result = await applyPayload(payloadOf({ [DAY]: gist }), { mode: 'merge', baseline: {} });

        expect(importedPayloads[0].stores[DAY]).toEqual({});
        expect(result.unchanged[DAY]).toBe(25);
        // What landed is what this device holds: the pruned ten are not described as applied
        expect(Object.keys(JSON.parse(result.applied).stores[DAY])).toHaveLength(25);
    });

    test("the window is per character, and the newest of both sides' snapshots win", async () => {
        // The other device took the four newest; this device's four oldest fall out
        const gist = { ...snapshots('32030', T0 + 4 * 3_600_000, 25), ...snapshots('32325', T0, 3) };
        storeState.stores[DAY] = { ...snapshots('32030', T0, 25), ...snapshots('32325', T0, 3) };

        await applyPayload(payloadOf({ [DAY]: gist }), { mode: 'merge', baseline: {} });

        expect(Object.keys(importedPayloads[0].stores[DAY]).sort()).toEqual(
            Object.keys(snapshots('32030', T0 + 25 * 3_600_000, 4)).sort()
        );
    });

    test("this device's snapshots pushed out of the window by newer ones from the gist are deleted", async () => {
        storeState.stores[DAY] = { ...snapshots('32030', T0, 25) };
        const gist = snapshots('32030', T0 + 20 * 3_600_000, 10);

        await applyPayload(payloadOf({ [DAY]: gist }), { mode: 'merge', baseline: {} });

        // Hours 0-4 fall out; with the five newest imported, the store holds 25
        expect(Object.keys(storeState.stores[DAY])).toHaveLength(20);
        expect(Object.keys(importedPayloads[0].stores[DAY])).toHaveLength(5);
    });

    test('displaced snapshots are deleted past a latch an earlier pull left on the store', async () => {
        storeState.stores[DAY] = { ...snapshots('32030', T0, 25) };
        storeState.latched = new Set([DAY]);
        try {
            await applyPayload(payloadOf({ [DAY]: snapshots('32030', T0 + 20 * 3_600_000, 10) }), {
                mode: 'merge',
                baseline: {},
            });
            expect(Object.keys(storeState.stores[DAY])).toHaveLength(20);
        } finally {
            storeState.latched = null;
        }
    });

    test('displaced snapshots stay when the snapshots that displace them did not land', async () => {
        storeState.stores[DAY] = { ...snapshots('32030', T0, 25) };
        importOutcome.failed = [{ store: DAY, expected: 5, written: 0 }];
        importOutcome.complete = false;
        try {
            await applyPayload(payloadOf({ [DAY]: snapshots('32030', T0 + 20 * 3_600_000, 10) }), {
                mode: 'merge',
                baseline: {},
            });
        } catch {
            // An incomplete apply may be reported either way; the store is what matters
        } finally {
            importOutcome.failed = [];
            importOutcome.complete = true;
        }
        expect(Object.keys(storeState.stores[DAY])).toHaveLength(25);
    });

    test('a displaced delete that does not land makes the pull incomplete, so it is retried', async () => {
        storeState.stores[DAY] = { ...snapshots('32030', T0, 25) };
        storeState.deleteFails = true;
        try {
            const result = await applyPayload(payloadOf({ [DAY]: snapshots('32030', T0 + 20 * 3_600_000, 10) }), {
                mode: 'merge',
                baseline: {},
            });
            expect(result.complete).toBe(false);
            expect(result.failed.map((entry) => entry.store)).toContain(DAY);
        } finally {
            storeState.deleteFails = false;
        }
    });

    test('a displaced delete that failed is retried by the next pull', async () => {
        storeState.stores[DAY] = { ...snapshots('32030', T0, 25) };
        storeState.deleteFails = true;
        let first;
        try {
            first = await applyPayload(payloadOf({ [DAY]: snapshots('32030', T0 + 20 * 3_600_000, 10) }), {
                mode: 'merge',
                baseline: {},
            });
        } finally {
            storeState.deleteFails = false;
        }
        expect(first.complete).toBe(false);
        // The five landed; the old ones are now this device's own drops, never displaced again
        storeState.stores[DAY] = { ...snapshots('32030', T0, 30) };

        await applyPayload(payloadOf({ [DAY]: snapshots('32030', T0 + 20 * 3_600_000, 10) }), {
            mode: 'merge',
            baseline: {},
        });

        expect(Object.keys(storeState.stores[DAY])).toHaveLength(25);
    });

    test('a settled pull retries a failed displaced delete without applying anything', async () => {
        storeState.stores[DAY] = { ...snapshots('32030', T0, 25) };
        storeState.deleteFails = true;
        try {
            await applyPayload(payloadOf({ [DAY]: snapshots('32030', T0 + 20 * 3_600_000, 10) }), {
                mode: 'merge',
                baseline: {},
            });
            expect(await retryPendingDisplacedDeletes()).toBeGreaterThan(0);
        } finally {
            storeState.deleteFails = false;
        }
        const before = Object.keys(storeState.stores[DAY]).length;

        expect(await retryPendingDisplacedDeletes()).toBe(0);

        expect(Object.keys(storeState.stores[DAY]).length).toBeLessThan(before);
    });

    test('snapshots this device would drop by itself are left to its own pruning', async () => {
        storeState.stores[DAY] = { ...snapshots('32030', T0, 30) };

        await applyPayload(payloadOf({ [DAY]: snapshots('32030', T0, 30) }), { mode: 'merge', baseline: {} });

        expect(Object.keys(storeState.stores[DAY])).toHaveLength(30);
    });

    test('the pre-split detail key, which carries no time, is left to the usual rules', async () => {
        storeState.stores[DAY] = snapshots('32030', T0, 25);
        const gist = { networthDetail_32030: [{ t: 1 }] };

        await applyPayload(payloadOf({ [DAY]: gist }), { mode: 'merge', baseline: {} });

        expect(importedPayloads[0].stores[DAY]).toEqual(gist);
    });

    test('a merged upload leaves out the snapshots outside the window, and says it sheds them', () => {
        const local = payloadOf({ [DAY]: snapshots('32030', T0 + 10 * 3_600_000, 25) });
        const remote = payloadOf({ [DAY]: snapshots('32030', T0, 35) });

        const merged = mergeForUpload(local, remote, null);

        expect(Object.keys(JSON.parse(merged.text).stores[DAY]).sort()).toEqual(
            Object.keys(snapshots('32030', T0 + 10 * 3_600_000, 25)).sort()
        );
        expect(merged.dropsFromRemote).toBe(true);
        // ...and a pull here of that result has nothing to take
        expect(merged.remoteAdds).toBe(false);
    });

    test('a snapshot outside the window is not news in either direction', () => {
        const local = payloadOf({ [DAY]: snapshots('32030', T0 + 10 * 3_600_000, 25) });
        const remote = payloadOf({ [DAY]: snapshots('32030', T0, 35) });

        expect(addsToRemote(remote, local, { forUpload: false })).toBe(false);
        expect(addsToRemote(local, remote)).toBe(false);
        // A snapshot newer than the gist's still is
        const newer = payloadOf({ [DAY]: snapshots('32030', T0 + 11 * 3_600_000, 25) });
        expect(addsToRemote(newer, remote)).toBe(true);
    });
});

describe('a pull of XP series this device has since thinned changes nothing', () => {
    const MIN = 60_000;
    const payloadOf = (stores) =>
        JSON.stringify({ formatVersion: 1, exportedAt: '2026-10-08T00:00:00.000Z', syncScope: 'everything', stores });
    const T0 = 1_790_000_000_000;
    const at = (minutes, xp) => ({ t: T0 + minutes * MIN, xp });

    test('skill XP: samples thinned since the upload are not put back', async () => {
        // Uploaded with 18:4 as the newest; 22:5 then thinned 18 away, and 26:5 thinned 22
        const gist = { xpHistory_32030: { milking: [at(3, 1), at(12, 3), at(18, 4)] } };
        const local = { xpHistory_32030: { milking: [at(3, 1), at(12, 3), at(26, 5), at(35, 8)] } };
        storeState.stores.xpHistory = structuredClone(local);

        const result = await applyPayload(payloadOf({ xpHistory: gist }), { mode: 'merge', baseline: {} });

        expect(importedPayloads[0].stores.xpHistory).toEqual({});
        expect(result.merged).toEqual([]);
    });

    test('guild XP: samples a week old and departed members are not put back', async () => {
        const week = 7 * 24 * 60;
        const gist = {
            guildXP_Chat: { Chat: [at(0, 10), at(5, 20), at(week + 30, 90)] },
            memberXP_1493: { 111: [at(0, 1), at(week + 30, 9)], 222: [at(0, 5), at(30, 6)] },
        };
        const local = {
            guildXP_Chat: { Chat: [at(week + 30, 90), at(week + 60, 95)] },
            // 222 left the guild; this device's login dropped them
            memberXP_1493: { 111: [at(week + 30, 9), at(week + 60, 12)] },
        };
        storeState.stores.guildHistory = structuredClone(local);

        const result = await applyPayload(payloadOf({ guildHistory: gist }), { mode: 'merge', baseline: {} });

        expect(importedPayloads[0].stores.guildHistory).toEqual({});
        expect(result.merged).toEqual([]);
    });

    test('a sample another device took after this one is still combined in', async () => {
        const gist = { xpHistory_32030: { milking: [at(3, 1), at(40, 9)] } };
        storeState.stores.xpHistory = { xpHistory_32030: { milking: [at(3, 1), at(35, 8)] } };

        const result = await applyPayload(payloadOf({ xpHistory: gist }), { mode: 'merge', baseline: {} });

        expect(importedPayloads[0].stores.xpHistory.xpHistory_32030.milking).toEqual([at(3, 1), at(35, 8), at(40, 9)]);
        expect(result.merged.map((entry) => entry.key)).toEqual(['xpHistory_32030']);
    });
});

describe('a fold that adds nothing is not written over a newer save from another tab', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', stores });

    test("the other tab's save survives, and the record counts as unchanged", async () => {
        storeState.stores.dungeonRuns = { run_char: ['a', 'b'] };
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: (local, incoming) => {
                // Another tab of this browser saves the record after the fold's read
                storeState.stores.dungeonRuns = { run_char: ['a', 'b', 'c'] };
                return [...new Set([...local, ...incoming])];
            },
            label: 'fake',
        });

        try {
            // The gist holds only what this device had when it pushed
            const result = await applyPayload(payloadOf({ dungeonRuns: { run_char: ['a'] } }), {
                mode: 'merge',
                baseline: {},
            });

            expect(importedPayloads[0].stores.dungeonRuns).toEqual({});
            expect(storeState.stores.dungeonRuns.run_char).toEqual(['a', 'b', 'c']);
            expect(result.unchanged).toEqual({ dungeonRuns: 1 });
            expect(result.merged).toEqual([]);
        } finally {
            off();
        }
    });

    test('a fold that adds something is still written', async () => {
        storeState.stores.dungeonRuns = { run_char: ['a'] };
        const off = registerSyncMerge({
            store: 'dungeonRuns',
            base: 'run',
            merge: (local, incoming) => [...new Set([...local, ...incoming])],
            label: 'fake',
        });

        try {
            const result = await applyPayload(payloadOf({ dungeonRuns: { run_char: ['a', 'z'] } }), {
                mode: 'merge',
                baseline: {},
            });

            expect(importedPayloads[0].stores.dungeonRuns).toEqual({ run_char: ['a', 'z'] });
            expect(result.merged.map((entry) => entry.key)).toEqual(['run_char']);
        } finally {
            off();
        }
    });
});

describe('a pull folds by which side moved since the last exchange', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', stores });
    /** A fold like the listing log's and the reroll history's: by id, the second side winning a tie */
    const byId = (first, second) => {
        const out = new Map();
        for (const entry of [...(first || []), ...(second || [])]) out.set(entry.id, entry);
        return [...out.values()].sort((a, b) => a.id - b.id);
    };
    let offs = [];
    const register = () => {
        offs = [
            registerSyncMerge({ store: 'marketListings', base: 'listingLog', merge: byId, label: 'listings' }),
            registerSyncMerge({ store: 'rerollSpending', base: 'rerollHist', merge: byId, label: 'rerolls' }),
        ];
    };
    const unregister = () => {
        for (const off of offs) off();
        offs = [];
    };

    test('a self-pull of the push this browser made writes nothing over an entry updated since', async () => {
        register();
        try {
            const pushed = { marketListings: { listingLog_a: [{ id: 1, status: 'active' }] } };
            // The push settled: the gist and this device held the same copy
            const baseline = wholeKeyHashes(payloadOf(pushed));
            // A sibling tab filled the listing after the push
            storeState.stores.marketListings = { listingLog_a: [{ id: 1, status: 'filled' }] };

            const result = await applyPayload(payloadOf(pushed), { mode: 'merge', baseline });

            expect(importedPayloads[0].stores.marketListings).toEqual({});
            expect(storeState.stores.marketListings.listingLog_a).toEqual([{ id: 1, status: 'filled' }]);
            expect(result.unchanged).toEqual({ marketListings: 1 });
            expect(result.merged).toEqual([]);
        } finally {
            unregister();
        }
    });

    test('a four-tab self-pull with this browser ahead writes nothing to either store', async () => {
        register();
        try {
            const pushed = {
                marketListings: {
                    listingLog_c1: [{ id: 1, status: 'active' }],
                    listingLog_c2: [{ id: 2, status: 'active' }],
                    listingLog_c3: [{ id: 3, status: 'active' }],
                    listingLog_c4: [{ id: 4, status: 'active' }],
                    // Whole keys another script and the price cache rewrite all the time
                    companionPositions: { open: 1 },
                    priceCache: { a: 1 },
                },
                rerollSpending: {
                    rerollData_c1: { t1: { coins: 1 } },
                    rerollData_c2: { t2: { coins: 1 } },
                    rerollHist_c1: [{ id: 10, spent: 1 }],
                    rerollHist_c2: [{ id: 20, spent: 1 }],
                },
            };
            const baseline = wholeKeyHashes(payloadOf(pushed));
            // Three sibling tabs, one per character, moved on after the push
            storeState.stores.marketListings = {
                ...pushed.marketListings,
                listingLog_c1: [{ id: 1, status: 'filled' }],
                listingLog_c2: [
                    { id: 2, status: 'active' },
                    { id: 5, status: 'active' },
                ],
                listingLog_c3: [{ id: 3, status: 'cancelled' }],
                companionPositions: { open: 2 },
                priceCache: { a: 2 },
            };
            storeState.stores.rerollSpending = {
                rerollData_c1: { t1: { coins: 2 } },
                rerollData_c2: { t2: { coins: 1 } },
                rerollHist_c1: [{ id: 10, spent: 2 }],
                rerollHist_c2: [
                    { id: 20, spent: 1 },
                    { id: 21, spent: 1 },
                ],
            };
            const before = JSON.parse(JSON.stringify(storeState.stores));

            const result = await applyPayload(payloadOf(pushed), { mode: 'merge', baseline });

            expect(importedPayloads[0].stores.marketListings).toEqual({});
            expect(importedPayloads[0].stores.rerollSpending).toEqual({});
            expect(storeState.stores.marketListings).toEqual(before.marketListings);
            expect(storeState.stores.rerollSpending).toEqual(before.rerollSpending);
            expect(result.merged).toEqual([]);
        } finally {
            unregister();
        }
    });

    test('whole keys a sibling tab rewrote keep this device copy under a merged-upload baseline too', async () => {
        const pushed = { rerollSpending: { rerollData_c1: { t1: { coins: 1 } } } };
        // A merged upload the gist and this device agreed on for this key
        const baseline = exchangeBaseline(payloadOf(pushed), payloadOf(pushed));
        storeState.stores.rerollSpending = { rerollData_c1: { t1: { coins: 3 } } };

        await applyPayload(payloadOf(pushed), { mode: 'merge', baseline });

        expect(importedPayloads[0].stores.rerollSpending).toEqual({});
        expect(storeState.stores.rerollSpending.rerollData_c1).toEqual({ t1: { coins: 3 } });
    });

    test('a gist that moved since the exchange still lands, the download winning ties', async () => {
        register();
        try {
            const exchanged = { marketListings: { listingLog_a: [{ id: 1, status: 'active' }] } };
            const baseline = wholeKeyHashes(payloadOf(exchanged));
            storeState.stores.marketListings = { listingLog_a: [{ id: 1, status: 'active' }] };
            // Another device filled it and added a listing
            const newer = {
                marketListings: {
                    listingLog_a: [
                        { id: 1, status: 'filled' },
                        { id: 2, status: 'active' },
                    ],
                },
            };

            const result = await applyPayload(payloadOf(newer), { mode: 'merge', baseline });

            expect(importedPayloads[0].stores.marketListings.listingLog_a).toEqual(newer.marketListings.listingLog_a);
            expect(result.merged.map((entry) => entry.key)).toEqual(['listingLog_a']);
        } finally {
            unregister();
        }
    });

    test('a merged upload left the gist ahead: its additions land, this device winning what it moved since', async () => {
        register();
        try {
            const local = { marketListings: { listingLog_a: [{ id: 1, status: 'active' }] } };
            const uploaded = {
                marketListings: {
                    listingLog_a: [
                        { id: 1, status: 'active' },
                        { id: 9, status: 'active' },
                    ],
                },
            };
            const baseline = exchangeBaseline(payloadOf(uploaded), payloadOf(local));
            storeState.stores.marketListings = { listingLog_a: [{ id: 1, status: 'filled' }] };

            await applyPayload(payloadOf(uploaded), { mode: 'merge', baseline });

            expect(importedPayloads[0].stores.marketListings.listingLog_a).toEqual([
                { id: 1, status: 'filled' },
                { id: 9, status: 'active' },
            ]);
        } finally {
            unregister();
        }
    });

    test('a record an earlier pull held back, and a retry of one, take the plain fold', async () => {
        register();
        try {
            const gist = { marketListings: { listingLog_a: [{ id: 1, status: 'active' }] } };
            const id = 'marketListings\u0000listingLog_a';
            const hash = wholeKeyHashes(payloadOf(gist))[id];
            storeState.stores.marketListings = { listingLog_a: [{ id: 1, status: 'filled' }] };

            await applyPayload(payloadOf(gist), { mode: 'merge', baseline: { [id]: { gist: hash, local: null } } });
            expect(importedPayloads[0].stores.marketListings.listingLog_a).toEqual([{ id: 1, status: 'active' }]);

            storeState.stores.marketListings = { listingLog_a: [{ id: 1, status: 'filled' }] };
            await applyPayload(payloadOf(gist), {
                mode: 'merge',
                baseline: wholeKeyHashes(payloadOf(gist)),
                retryHeld: true,
            });
            expect(importedPayloads[1].stores.marketListings.listingLog_a).toEqual([{ id: 1, status: 'active' }]);
        } finally {
            unregister();
        }
    });

    test('a retry of held-back records folds only those plainly; other records keep the baseline', async () => {
        register();
        try {
            const gist = {
                marketListings: {
                    listingLog_held: [{ id: 1, status: 'active' }],
                    listingLog_other: [{ id: 2, status: 'active' }],
                },
            };
            const baseline = wholeKeyHashes(payloadOf(gist));
            storeState.stores.marketListings = {
                listingLog_held: [{ id: 1, status: 'filled' }],
                // A sibling tab updated this one before the retry
                listingLog_other: [{ id: 2, status: 'filled' }],
            };

            await applyPayload(payloadOf(gist), {
                mode: 'merge',
                baseline,
                retryHeld: true,
                heldKeys: [{ store: 'marketListings', key: 'listingLog_held' }],
            });

            expect(importedPayloads[0].stores.marketListings).toEqual({
                listingLog_held: [{ id: 1, status: 'active' }],
            });
            expect(storeState.stores.marketListings.listingLog_other).toEqual([{ id: 2, status: 'filled' }]);
        } finally {
            unregister();
        }
    });

    test('a pull someone asked for keeps the download-wins fold', async () => {
        register();
        try {
            const gist = { marketListings: { listingLog_a: [{ id: 1, status: 'active' }] } };
            storeState.stores.marketListings = { listingLog_a: [{ id: 1, status: 'filled' }] };

            await applyPayload(payloadOf(gist), { mode: 'pull', baseline: wholeKeyHashes(payloadOf(gist)) });

            expect(importedPayloads[0].stores.marketListings.listingLog_a).toEqual([{ id: 1, status: 'active' }]);
        } finally {
            unregister();
        }
    });
});

describe('the pull direction rules respect what each fold and restore needs', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', stores });
    const H = 60 * 60 * 1000;
    const T0 = Date.UTC(2026, 0, 1);

    test('a registration with its own pull fold keeps it when only this device moved', async () => {
        // The real skill XP registration: its pull fold does not take back a sample this device thinned
        const atPush = {
            s: [
                { t: T0, xp: 0 },
                { t: T0 + 2 * H, xp: 200 },
            ],
        };
        const uploaded = {
            s: [
                { t: T0, xp: 0 },
                { t: T0 + H, xp: 100 },
                { t: T0 + 2 * H, xp: 200 },
            ],
        };
        const baseline = exchangeBaseline(
            payloadOf({ xpHistory: { xpHistory_c1: uploaded } }),
            payloadOf({ xpHistory: { xpHistory_c1: atPush } })
        );
        const now = { s: [...atPush.s, { t: T0 + 3 * H, xp: 300 }] };
        storeState.stores.xpHistory = { xpHistory_c1: now };

        const result = await applyPayload(payloadOf({ xpHistory: { xpHistory_c1: uploaded } }), {
            mode: 'merge',
            baseline,
        });

        expect(importedPayloads[0].stores.xpHistory).toEqual({});
        expect(storeState.stores.xpHistory.xpHistory_c1).toEqual(now);
        expect(result.merged).toEqual([]);
    });

    test('a skipped record put back in the write by its tombstones writes this device copy', async () => {
        const off = registerSyncMerge({
            store: 'settings',
            key: 'enhancementTracker_sessions',
            merge: (local, incoming) => ({ ...local, ...incoming }),
            label: 'sessions',
        });
        try {
            const gistRecord = { s0: { v: 1 }, s1: { v: 1 } };
            const exchanged = {
                settings: { enhancementTracker_sessions: gistRecord, enhancementTracker_sessionTombstones: { s0: 1 } },
            };
            const baseline = wholeKeyHashes(payloadOf(exchanged));
            const localRecord = { s0: { v: 1 }, s1: { v: 2 }, s2: { v: 1 } };
            storeState.stores.settings = {
                ...storeState.stores.settings,
                enhancementTracker_sessions: localRecord,
                enhancementTracker_sessionTombstones: { s0: 1 },
            };

            await applyPayload(payloadOf({ settings: { enhancementTracker_sessions: gistRecord } }), {
                mode: 'merge',
                baseline,
            });

            // Put back by the tombstone rule, it lands as this device holds it
            expect(importedPayloads[0].stores.settings.enhancementTracker_sessions).toEqual(localRecord);
        } finally {
            off();
        }
    });

    test('a record a full-backup restore wrote is still folded with the gist', async () => {
        const off = registerSyncMerge({
            store: 'marketListings',
            base: 'listingLog',
            merge: (first, second) => {
                const out = new Map();
                for (const entry of [...(first || []), ...(second || [])]) out.set(entry.id, entry);
                return [...out.values()].sort((a, b) => a.id - b.id);
            },
            label: 'listings',
        });
        try {
            const gist = { marketListings: { listingLog_a: [{ id: 1 }, { id: 2 }] } };
            const baseline = {
                ...wholeKeyHashes(payloadOf(gist)),
                [RESTORED_BASELINE]: { at: 1, keys: { marketListings: ['listingLog_a'] } },
            };
            // The backup restored here predates listing 2
            storeState.stores.marketListings = { listingLog_a: [{ id: 1 }] };

            await applyPayload(payloadOf(gist), { mode: 'merge', baseline });

            expect(importedPayloads[0].stores.marketListings.listingLog_a).toEqual([{ id: 1 }, { id: 2 }]);
        } finally {
            off();
        }
    });
});

describe('a chunked history keeps its pull orientation under the direction rules', () => {
    const payloadOf = (stores) => JSON.stringify({ formatVersion: 1, exportedAt: '2026-01-01T00:00:00.000Z', stores });

    test('an expired completion the gist still holds in the boundary week is not taken back', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            // A Wednesday noon, so the cut falls mid-week
            vi.setSystemTime(Date.UTC(2026, 9, 7, 12));
            const cut = Date.now() - WINDOW_WEEKS * 7 * 24 * 60 * 60 * 1000;
            const expired = { taskId: 'old', completedAt: cut - 60 * 60 * 1000 };
            const kept = { taskId: 'kept', completedAt: cut + 60 * 60 * 1000 };
            expect(weekChunkId(expired.completedAt)).toBe(weekChunkId(kept.completedAt));
            const key = `taskCompletionRec_c1_${weekChunkId(kept.completedAt)}`;

            // A merged upload left the gist ahead of this device for the week,
            // and this device has moved since (its window let the expired row go)
            const uploaded = { rerollSpending: { [key]: [expired, kept] } };
            const baseline = exchangeBaseline(payloadOf(uploaded), payloadOf({ rerollSpending: { [key]: [expired] } }));
            storeState.stores.rerollSpending = { [key]: [kept] };

            const result = await applyPayload(payloadOf(uploaded), { mode: 'merge', baseline });

            expect(importedPayloads[0].stores.rerollSpending).toEqual({});
            expect(storeState.stores.rerollSpending[key]).toEqual([kept]);
            expect(result.merged).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('saved meter sessions travel only while their index lists them', () => {
    const STORE = 'combatExport';
    const INDEX = 'meterHistoryIndex_32030_combat';
    const body = (id) => `meterHistory_32030_combat_${id}`;
    const summary = (id, extra = {}) => ({ id, type: 'combat', endedAt: Number(id.split('_')[1]), ...extra });
    const session = (id) => ({ id, type: 'combat', dealt: { players: [] } });
    const payloadOf = (stores) =>
        JSON.stringify({ formatVersion: 1, exportedAt: '2026-10-09T00:00:00.000Z', syncScope: 'everything', stores });

    test('a pull does not write back a body the index in force no longer lists', async () => {
        storeState.stores[STORE] = {};
        // The gist still holds combat_1, which its owner's index dropped; combat_0 is an old starred one
        const gist = {
            [INDEX]: [summary('combat_3'), summary('combat_0', { favourite: true })],
            [body('combat_0')]: session('combat_0'),
            [body('combat_1')]: session('combat_1'),
            [body('combat_3')]: session('combat_3'),
        };

        await applyPayload(payloadOf({ [STORE]: gist }), { mode: 'merge', baseline: {} });

        expect(Object.keys(importedPayloads[0].stores[STORE]).sort()).toEqual(
            [INDEX, body('combat_0'), body('combat_3')].sort()
        );
    });

    test("when this device's index wins the baseline, the gist's bodies it does not list stay out", async () => {
        const gistIndex = [summary('combat_1'), summary('combat_2')];
        const baseline = wholeKeyHashes(payloadOf({ [STORE]: { [INDEX]: gistIndex } }));
        // Moved here since the exchange: combat_2 deleted, combat_4 saved
        storeState.stores[STORE] = {
            [INDEX]: [summary('combat_4'), summary('combat_1')],
            [body('combat_1')]: session('combat_1'),
            [body('combat_4')]: session('combat_4'),
        };
        const gist = {
            [INDEX]: gistIndex,
            [body('combat_1')]: session('combat_1'),
            [body('combat_2')]: session('combat_2'),
        };

        await applyPayload(payloadOf({ [STORE]: gist }), { mode: 'merge', baseline });

        const landed = importedPayloads[0].stores[STORE];
        expect(Object.hasOwn(landed, INDEX)).toBe(false);
        expect(Object.hasOwn(landed, body('combat_2'))).toBe(false);
        expect(storeState.stores[STORE][body('combat_4')]).toBeDefined();
    });

    test('a local body another tab has not listed yet is never deleted by a pull', async () => {
        // Another tab wrote combat_5's body and has not yet written its index
        storeState.stores[STORE] = {
            [INDEX]: [summary('combat_1')],
            [body('combat_1')]: session('combat_1'),
            [body('combat_5')]: session('combat_5'),
        };
        storeState.deleteCalls = [];
        const gist = {
            [INDEX]: [summary('combat_3'), summary('combat_1')],
            [body('combat_1')]: session('combat_1'),
            [body('combat_3')]: session('combat_3'),
        };

        const result = await applyPayload(payloadOf({ [STORE]: gist }), { mode: 'merge', baseline: {} });

        expect(storeState.stores[STORE][body('combat_5')]).toBeDefined();
        expect(storeState.deleteCalls.filter((call) => call.name === STORE)).toEqual([]);
        expect(result.complete).toBe(true);
    });

    test('a body with no index on either side is left alone', async () => {
        storeState.stores[STORE] = {};
        await applyPayload(payloadOf({ [STORE]: { [body('combat_1')]: session('combat_1') } }), {
            mode: 'merge',
            baseline: {},
        });
        expect(Object.hasOwn(importedPayloads[0].stores[STORE], body('combat_1'))).toBe(true);
    });

    test("an upload sheds the gist's orphans and keeps an old starred body", () => {
        const index = [summary('combat_3'), summary('combat_0', { favourite: true })];
        const local = {
            [INDEX]: index,
            [body('combat_0')]: session('combat_0'),
            [body('combat_3')]: session('combat_3'),
        };
        const gist = { ...local, [body('combat_1')]: session('combat_1'), [body('combat_2')]: session('combat_2') };

        const { text, dropsFromRemote, remoteAdds } = mergeForUpload(
            payloadOf({ [STORE]: local }),
            payloadOf({ [STORE]: gist }),
            null
        );

        expect(Object.keys(JSON.parse(text).stores[STORE]).sort()).toEqual(Object.keys(local).sort());
        expect(dropsFromRemote).toBe(true);
        expect(remoteAdds).toBe(false);
    });

    test('a gist-only body outside the index is not news to this device', () => {
        const local = { [INDEX]: [summary('combat_3')], [body('combat_3')]: session('combat_3') };
        const gist = { ...local, [body('combat_1')]: session('combat_1') };

        expect(addsToRemote(payloadOf({ [STORE]: gist }), payloadOf({ [STORE]: local }))).toBe(false);
        // Listed, the same body is news
        const listed = { ...gist, [INDEX]: [summary('combat_3'), summary('combat_1')] };
        expect(addsToRemote(payloadOf({ [STORE]: listed }), payloadOf({ [STORE]: local }))).toBe(true);
    });
});

describe('device-only records added to the local-only prefixes', () => {
    const KEYS = [
        'dungeonTracker_inProgressRun_32030',
        'dungeonTracker_inProgressRun',
        'settings_shared_scope_conflicts',
    ];

    test.each(KEYS)('%s never reaches a payload', (key) => {
        expect(payloadCarriesKey('settings', key)).toBe(false);
        expect(Object.hasOwn(redactSettingsStore({ [key]: { at: 1 } }), key)).toBe(false);
    });

    test('a payload carrying them does not write them here', async () => {
        const incoming = Object.fromEntries(KEYS.map((key) => [key, { at: 1 }]));
        await applyPayload(
            JSON.stringify({ formatVersion: 1, exportedAt: 'x', stores: { settings: { ...incoming, other_key: 1 } } })
        );
        const landed = importedPayloads.at(-1).stores.settings;
        for (const key of KEYS) expect(Object.hasOwn(landed, key)).toBe(false);
    });

    test('a built payload leaves them out', async () => {
        storeState.stores.settings.dungeonTracker_inProgressRun_32030 = { wave: 3 };
        storeState.stores.settings.settings_shared_scope_conflicts = { at: 1, conflicts: [{ id: 'x' }] };
        const built = JSON.parse(await buildPayloadJSON('settings'));
        expect(Object.hasOwn(built.stores.settings, 'dungeonTracker_inProgressRun_32030')).toBe(false);
        expect(Object.hasOwn(built.stores.settings, 'settings_shared_scope_conflicts')).toBe(false);
    });
});
