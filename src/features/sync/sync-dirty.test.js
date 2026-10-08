/**
 * The automatic push skips building its payload when nothing synced was
 * written since a build last proved this device matched the stored fingerprint
 * — and builds whenever that cannot be proved. See `sync-dirty.js`.
 *
 * Driven through `SyncManager.push`, with storage replaced by a fake whose
 * `onWrite` the test plays: this tab's writes, another tab's committed writes,
 * and the page coming back from the bfcache.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({ values: {} }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => settings.values[key] ?? fallback,
        onSettingChange: () => {},
        offSettingChange: () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char-A' },
}));

const stored = vi.hoisted(() => ({ map: {}, listeners: new Set(), crossTab: true, queued: [] }));
const calls = vi.hoisted(() => []);
vi.mock('../../core/storage.js', () => {
    const emit = (storeName, keys, origin = 'local') => {
        for (const listener of stored.listeners) listener({ storeName, keys, origin });
    };
    return {
        default: {
            // Lands what `queue()` left waiting, and reports each commit as the real one does
            flushAll: async () => {
                calls.push('flushAll');
                for (const [storeName, keys] of stored.queued.splice(0)) emit(storeName, keys, 'commit');
            },
            get: async (key, _store, fallback = null) => stored.map[key] ?? fallback,
            set: async (key, value, storeName = 'settings') => {
                emit(storeName, [key]);
                stored.map[key] = value;
            },
            // The sync bookkeeping goes down this path, reported as the real one reports it
            putAll: async (storeName, entries) => {
                emit(storeName, Object.keys(entries));
                for (const [key, value] of Object.entries(entries)) stored.map[key] = value;
                return Object.keys(entries).length;
            },
            onWrite: (listener) => {
                stored.listeners.add(listener);
                return () => stored.listeners.delete(listener);
            },
            crossTabWritesVisible: () => stored.crossTab,
        },
    };
});

vi.mock('../../utils/persisted-record.js', () => ({
    flushPersistedRecords: async () => calls.push('flushPersistedRecords'),
}));
vi.mock('../../utils/toast.js', () => ({ showToast: () => null }));
vi.mock('../../utils/choice-dialog.js', () => ({ askChoice: async () => null }));
vi.mock('./pull-summary-panel.js', () => ({ openPullSummaryPanel: () => {} }));

const payload = vi.hoisted(() => ({ text: '{"local":1}', buildWait: null }));
vi.mock('./sync-payload.js', async (importOriginal) => ({
    // The real filter: which keys can change a payload is what these tests are about
    payloadCarriesKey: (await importOriginal()).payloadCarriesKey,
    buildPayloadJSON: async () => {
        calls.push('buildPayloadJSON');
        if (payload.buildWait) await payload.buildWait();
        return payload.text;
    },
    applyPayload: async () => ({ complete: true, failed: [], merged: [], mergeFailed: [], mergeHeld: [] }),
    contentHash: (text) => `h:${String(text).replace(/"exportedAt":"[^"]*",/, '')}`,
    addsToRemote: (local, remote) => local !== remote,
    mergeForUpload: (local, remote) => ({ text: `${remote}+${local}`, remoteAdds: local !== remote }),
    restampRestoredSettings: () => {},
    RESTORED_BASELINE: '\u0000restoredAt',
    exchangeBaseline: (uploaded, local) => ({ uploaded, local }),
    registeredKeysDiverge: () => false,
    pushTrimsRegisteredKeys: () => false,
    trimmedRegisteredKeys: () => [],
    wholeKeyHashes: (text) => ({ of: text }),
    hashPayload: (text) => `raw:${text}`,
}));

const gist = vi.hoisted(() => ({ writes: [] }));
vi.mock('./gist-client.js', () => ({
    GistError: class extends Error {},
    chunkPayload: (text) => [text],
    readSyncGistRevision: async () => {
        throw new Error('no revisions in this fake');
    },
    findSyncGist: async () => null,
    readSyncGist: async () => null,
    writeSyncGist: async (_token, id, manifest) => {
        gist.writes.push({ id, manifest });
        return { id: id ?? 'gist-1', updatedAt: 'now', syncSeq: manifest.syncSeq };
    },
}));

/** A write the fake storage reports to the tracker, as `storage.onWrite` would */
function write(storeName, keys, origin = 'local') {
    for (const listener of stored.listeners) listener({ storeName, keys, origin });
}

/** A debounced write in this tab: reported now, committed by the push's flush */
function queue(storeName, keys) {
    write(storeName, keys, 'local');
    stored.queued.push([storeName, keys]);
}

const builds = () => calls.filter((call) => call === 'buildPayloadJSON').length;
const autoPush = () => syncManager.push({ silent: true, unattended: true });

let syncManager;

beforeEach(async () => {
    // A fresh page each time: the write counter is module state, as on a page load
    vi.resetModules();
    settings.values = { sync_enabled: true, sync_token: 'ghp_secret', sync_scope: 'everything', sync_auto: false };
    stored.map = {};
    stored.listeners.clear();
    stored.crossTab = true;
    stored.queued = [];
    calls.length = 0;
    payload.text = '{"local":1}';
    payload.buildWait = null;
    gist.writes = [];
    ({ default: syncManager } = await import('./sync-manager.js'));
    syncManager.busy = false;

    // A pressed Push: creates the gist and stores this payload's fingerprint
    expect((await syncManager.push()).ok).toBe(true);
    calls.length = 0;
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('automatic push with nothing written', () => {
    test('skips building after a push stored the fingerprint of what it built', async () => {
        const result = await autoPush();
        expect(result).toEqual({ ok: true, skipped: true, reason: 'unchanged' });
        expect(builds()).toBe(0);
        expect(gist.writes).toHaveLength(1);
    });

    test('still lands records held in memory before deciding', async () => {
        await autoPush();
        expect(calls).toContain('flushPersistedRecords');
    });

    test('skips building once a build has found the payload unchanged', async () => {
        write('xpHistory', ['char-A_xp']);
        // The value went back to what it was: the build finds the same fingerprint
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(1);
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(1);
    });

    test('ignores the sync bookkeeping and stores the sync does not carry', async () => {
        write('settings', ['toolasha_sync_gistVersion', 'toolasha_sync_lastHash']);
        write('openableAnalytics', ['anything']);
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(0);
    });
});

describe('writes no payload carries', () => {
    test.each([
        ['the session briefing heartbeat', 'sessionBriefingLastAlive_603281'],
        ['a device-local record', 'toolasha_local_liveGraph_603281'],
        ['a network tally', 'waveGapTally'],
        ["another script's key", 'otherScriptStats'],
        ['the market API cache', 'Toolasha_marketAPI_cache'],
    ])('%s does not make the push build', async (_label, key) => {
        write('settings', [key], 'remote');
        write('settings', [key]);
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(0);
    });

    test('a store the backup strips a key from does not count that key', async () => {
        write('labyrinth', ['labyrinthTickCaptureAutosave_603281']);
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(0);
    });

    test('a real setting does', async () => {
        write('settings', ['script_settingsMap_603281'], 'remote');
        await autoPush();
        expect(builds()).toBe(1);
    });
});

describe('automatic push after a write', () => {
    test('a write the push flush lands itself does not make the following push build again', async () => {
        queue('xpHistory', ['char-A_xp']);
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(1);
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(1);
    });

    test('a write still queued after the flush counts against the next push', async () => {
        write('xpHistory', ['char-A_xp']);
        // The flush could not land this one (it failed and was requeued): it commits after the build
        payload.buildWait = async () => write('xpHistory', ['char-A_late'], 'commit');
        expect((await autoPush()).reason).toBe('unchanged');
        payload.buildWait = null;
        payload.text = '{"local":5}';
        await autoPush();
        expect(builds()).toBe(2);
        expect(gist.writes).toHaveLength(2);
    });

    test('a write to a synced store in this tab makes the next push build', async () => {
        write('xpHistory', ['char-A_xp']);
        payload.text = '{"local":2}';
        const result = await autoPush();
        expect(result.ok).toBe(true);
        expect(result.skipped).toBeUndefined();
        expect(builds()).toBe(1);
        expect(gist.writes).toHaveLength(2);
    });

    test('a setting written beside the bookkeeping counts', async () => {
        write('settings', ['toolasha_sync_lastHash', 'script_settingsMap_603281']);
        await autoPush();
        expect(builds()).toBe(1);
    });

    test("another tab's committed write makes the next push build", async () => {
        write('marketListings', ['char-B_listings'], 'remote');
        payload.text = '{"local":3}';
        await autoPush();
        expect(builds()).toBe(1);
        expect(gist.writes).toHaveLength(2);
    });

    test('a bulk write whose keys were not listed counts', async () => {
        write('settings', null, 'remote');
        await autoPush();
        expect(builds()).toBe(1);
    });

    test('a page back from the bfcache builds, having maybe missed other tabs', async () => {
        write(null, null, 'resumed');
        await autoPush();
        expect(builds()).toBe(1);
    });

    test('a write that lands while the payload is being built is not absorbed into it', async () => {
        write('xpHistory', ['char-A_xp']);
        // The build read the stores before this write landed in another tab
        payload.buildWait = async () => write('xpHistory', ['char-B_xp'], 'remote');
        expect((await autoPush()).reason).toBe('unchanged');
        payload.buildWait = null;
        expect(builds()).toBe(1);
        // So the next push must build again rather than trust that fingerprint
        payload.text = '{"local":4}';
        await autoPush();
        expect(builds()).toBe(2);
        expect(gist.writes).toHaveLength(2);
    });
});

describe('when the counter cannot vouch for the database', () => {
    test('a pressed Push always builds', async () => {
        const result = await syncManager.push();
        expect(result.ok).toBe(true);
        expect(builds()).toBe(1);
    });

    test('without cross-tab write announcements every automatic push builds', async () => {
        stored.crossTab = false;
        await autoPush();
        await autoPush();
        expect(builds()).toBe(2);
    });

    test('a stored fingerprint another tab changed sends the push back to building', async () => {
        // Another tab pulled: what is stored is no longer what this tab proved clean
        stored.map.toolasha_sync_lastHash = 'h:something-else';
        const result = await autoPush();
        expect(builds()).toBe(1);
        expect(result.skipped).toBeUndefined();
    });

    test('a changed scope builds', async () => {
        settings.values.sync_scope = 'settings';
        await autoPush();
        expect(builds()).toBe(1);
    });

    test('the clean point expires after an hour', async () => {
        const start = Date.now();
        vi.spyOn(Date, 'now').mockReturnValue(start + 59 * 60 * 1000);
        await autoPush();
        expect(builds()).toBe(0);
        Date.now.mockReturnValue(start + 61 * 60 * 1000);
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(1);
    });

    test('the first automatic push of a page load builds', async () => {
        vi.resetModules();
        stored.listeners.clear();
        ({ default: syncManager } = await import('./sync-manager.js'));
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(1);
    });
});

describe('the count follows what the scope carries', () => {
    /** Re-prove this page clean for a settings-only payload */
    async function settingsScope() {
        settings.values.sync_scope = 'settings';
        expect((await syncManager.push()).ok).toBe(true);
        calls.length = 0;
    }

    test('a settings-only push ignores writes to stores only a full sync carries', async () => {
        await settingsScope();
        write('actionProgress', ['char-A_progress'], 'remote');
        write('xpHistory', ['char-A_xp']);
        // A bulk write whose keys are not listed, outside the scope, too
        write('marketListings', null, 'remote');
        expect((await autoPush()).reason).toBe('unchanged');
        expect(builds()).toBe(0);
    });

    test('a full-sync push counts them', async () => {
        write('actionProgress', ['char-A_progress'], 'remote');
        await autoPush();
        expect(builds()).toBe(1);
    });

    test('a settings-only push still counts a setting', async () => {
        await settingsScope();
        write('settings', ['script_settingsMap_603281'], 'remote');
        await autoPush();
        expect(builds()).toBe(1);
    });

    test.each(['settings', 'everything'])('a write to an unknown store dirties the %s scope', async (scope) => {
        if (scope === 'settings') await settingsScope();
        write(null, null, 'resumed');
        await autoPush();
        expect(builds()).toBe(1);
    });
});
