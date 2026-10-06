/**
 * Automatic sync merges before it pushes: two devices, end to end.
 *
 * The real manager, payload builder, settings fold, merge registry and
 * full-backup importer run against a fake database per device and a fake
 * gist that keeps `writeSyncGist`'s contract (listing, 304s against a
 * remembered version, the encryption refusal, the "ahead" stop and the counter
 * raise — each unit-tested against the real client in gist-client.test.js).
 *
 * The scenario these exist for: device B changes a setting and pushes; device
 * A, open the whole time and recording history of its own, auto-syncs. A's
 * automatic push used to overwrite B's push, and B's next pull then reverted
 * the setting on B too.
 *
 * The automatic paths must also never apply to a device that is in use: an
 * apply latches every store it touches until a reload (`finishRestore`) and
 * puts "Reload now" on screen. Those are counted here, per device.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

/** The device at the keyboard: its database, its settings */
const world = vi.hoisted(() => ({ device: null, gzip: false }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => world.device.settings[key] ?? fallback,
        onSettingChange: () => {},
        offSettingChange: () => {},
    },
}));

vi.mock('../../core/data-manager.js', () => ({ default: { getCurrentCharacterId: () => 'c1' } }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

vi.mock('../../core/storage.js', () => {
    const db = () => world.device.db;
    const store = (name) => {
        db()[name] = db()[name] || {};
        return db()[name];
    };
    return {
        default: {
            flushAll: async () => {},
            beginRestore: async () => {},
            endRestore: async () => {},
            finishRestore: () => {
                world.device.latches += 1;
            },
            listStores: async () => Object.keys(db()).sort(),
            get: async (key, name = 'settings', fallback = null) => store(name)[key] ?? fallback,
            set: async (key, value, name = 'settings') => {
                store(name)[key] = value;
                return true;
            },
            getAll: async (name) => structuredClone(store(name)),
            tryGet: async (key, name) =>
                Object.hasOwn(store(name), key)
                    ? { found: true, value: structuredClone(store(name)[key]) }
                    : { found: false, value: null },
            putAll: async (name, entries) => {
                Object.assign(store(name), structuredClone(entries));
                return Object.keys(entries).length;
            },
        },
    };
});

vi.mock('../../core/settings-storage.js', () => ({ default: { reconcileKeyMigrationState: async () => {} } }));
vi.mock('../../utils/persisted-record.js', () => ({ flushPersistedRecords: async () => {} }));

const toasts = vi.hoisted(() => []);
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.push({ message, ...options });
        return null;
    },
}));

const dialog = vi.hoisted(() => ({ calls: 0, answer: null }));
vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async () => {
        dialog.calls += 1;
        return dialog.answer;
    },
}));

vi.mock('./pull-summary-panel.js', () => ({ openPullSummaryPanel: () => {} }));
// In the clear unless a test turns the real gzip on (`world.gzip`)
vi.mock('./sync-compress.js', async (importOriginal) => {
    const real = await importOriginal();
    return {
        compressionAvailable: () => Boolean(world.gzip) && real.compressionAvailable(),
        gzipText: real.gzipText,
        gunzipToText: real.gunzipToText,
    };
});

/** The one gist both devices share */
const gist = vi.hoisted(() => ({ state: null, etag: 0, writes: 0 }));

vi.mock('./gist-client.js', async () => {
    class GistError extends Error {
        constructor(kind, message) {
            super(message);
            this.kind = kind;
        }
    }
    const files = () => ({ 'toolasha-sync.json': 100, 'toolasha-data-000.json': gist.state.payload.length });
    return {
        GistError,
        chunkPayload: (text) => [text],
        findSyncGist: async () => (gist.state ? 'g1' : null),
        readSyncGist: async (_token, _id, { etag } = {}) => {
            if (!gist.state) throw new GistError('not-found', 'no gist');
            const current = `W/"${gist.etag}"`;
            if (etag && etag === current) return { notModified: true, etag };
            return { manifest: gist.state.manifest, payload: gist.state.payload, etag: current, files: files() };
        },
        writeSyncGist: async (_token, id, manifest, chunks, _prev, known, options = {}) => {
            const { unattended = false, confirmPlaintext = null, isAhead = null } = options;
            const current = `W/"${gist.etag}"`;
            let listing = null;
            if (gist.state) {
                listing =
                    known && known.etag === current
                        ? { syncSeq: known.syncSeq, encrypted: known.encrypted, exportedAt: null, fresh: false }
                        : {
                              syncSeq: gist.state.manifest.syncSeq ?? null,
                              encrypted: Boolean(gist.state.manifest.encrypted),
                              exportedAt: gist.state.manifest.exportedAt,
                              fresh: true,
                          };
            }
            if (listing?.encrypted && !manifest.encrypted) {
                if (unattended) throw new GistError('passphrase', 'encrypted gist');
                if (confirmPlaintext && !(await confirmPlaintext())) throw new GistError('cancelled', 'cancelled');
            }
            if (isAhead && listing?.fresh && isAhead(listing)) throw new GistError('behind', 'ahead');
            const syncSeq =
                listing?.syncSeq != null && listing.syncSeq >= manifest.syncSeq
                    ? listing.syncSeq + 1
                    : manifest.syncSeq;
            gist.state = { manifest: { ...manifest, syncSeq }, payload: chunks.join('') };
            gist.etag += 1;
            gist.writes += 1;
            return { id: id ?? 'g1', updatedAt: 'now', etag: `W/"${gist.etag}"`, files: files(), syncSeq };
        },
    };
});

const { default: syncManager } = await import('./sync-manager.js');
const { registerSyncMerge } = await import('../../utils/sync-merge-registry.js');
// A real fold with a scalar it cannot combine (`sortBy`), registered the way a page load does
await import('../../utils/watchlist.js');

// A history with its own fold, the shape every registered one has: a union
registerSyncMerge({
    store: 'xpHistory',
    base: 'testHistory',
    merge: (local, incoming) => [...new Set([...(local || []), ...(incoming || [])])],
    label: 'Test history',
});

const MAP = 'script_settingsMap_c1';
const STAMPS = `settings_changedAt_${MAP}`;
const BASE_MS = Date.parse('2026-05-01T00:00:00.000Z');
let elapsed = 0;

/**
 * One device.
 * @param {string} name - Its name
 * @param {Object} [settings] - Its sync settings
 * @returns {Object} Device
 */
function makeDevice(name, settings = {}) {
    return {
        name,
        settings: { sync_enabled: true, sync_token: 'ghp_x', sync_scope: 'everything', ...settings },
        db: { settings: {}, xpHistory: {} },
        latches: 0,
    };
}

/**
 * Act as `device`, a minute after the last action.
 * @param {Object} device - From makeDevice
 * @param {Function} run - What it does
 * @returns {Promise<*>} The result
 */
async function as(device, run) {
    elapsed += 60 * 1000;
    world.device = device;
    vi.setSystemTime(new Date(BASE_MS + elapsed));
    try {
        return await run();
    } finally {
        syncManager.busy = false;
    }
}

/**
 * Change one setting the way the settings panel does: the map entry and its stamp.
 * @param {Object} device - Device
 * @param {string} id - Setting id
 * @param {boolean} on - New value
 */
function changeSetting(device, id, on) {
    const settings = device.db.settings;
    settings[MAP] = { ...(settings[MAP] || {}), [id]: { id, isTrue: on } };
    const seq = settings.toolasha_sync_lastSyncedSeq ?? null;
    settings[STAMPS] = { ...(settings[STAMPS] || {}), [id]: { at: BASE_MS + elapsed, seq } };
}

const auto = {
    push: () => syncManager.push({ silent: true, unattended: true }),
    pull: () => syncManager.pull({ silent: true }),
    startup: () => syncManager.pull({ silent: true, startup: true }),
};

/**
 * One automatic tick on a device that is in use: it records history, then its
 * interval pull and push run.
 * @param {Object} device - Device
 * @param {string} sample - The history entry it records this tick
 */
async function activeTick(device, sample) {
    await as(device, async () => {
        device.db.xpHistory.testHistory_c1 = [...(device.db.xpHistory.testHistory_c1 || []), sample];
        await auto.pull();
        await auto.push();
    });
}

/** What the gist holds, parsed */
const gistStores = () => JSON.parse(gist.state.payload).stores;

/**
 * Two devices that have synced once: A pushed, B pulled.
 * @returns {Promise<{a: Object, b: Object}>} Devices
 */
async function syncedPair(settingsA = {}, settingsB = {}) {
    const a = makeDevice('A', settingsA);
    const b = makeDevice('B', settingsB);
    a.db.settings[MAP] = { X: { id: 'X', isTrue: false }, Y: { id: 'Y', isTrue: false } };
    a.db.xpHistory.testHistory_c1 = ['s1'];
    await as(a, () => syncManager.push());
    await as(b, () => syncManager.pull());
    return { a, b };
}

beforeEach(() => {
    world.gzip = false;
    vi.useFakeTimers();
    gist.state = null;
    gist.etag = 0;
    gist.writes = 0;
    toasts.length = 0;
    dialog.calls = 0;
    dialog.answer = null;
    elapsed = 0;
    syncManager.busy = false;
});

afterEach(() => {
    vi.useRealTimers();
});

describe('an automatic push merges a gist that moved past it', () => {
    test("B's setting and A's history both survive on the gist, and reach both devices at their startup pull", async () => {
        const { a, b } = await syncedPair();
        a.latches = 0;
        b.latches = 0;
        toasts.length = 0;

        // B changes X and its interval pushes
        await as(b, async () => {
            changeSetting(b, 'X', true);
            expect((await auto.push()).ok).toBe(true);
        });

        // A, open throughout, recorded history of its own and never pulled
        a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        expect((await as(a, auto.push)).ok).toBe(true);

        // The gist carries both, and nothing was applied to either device
        expect(gistStores().settings[MAP].X.isTrue).toBe(true);
        expect(gistStores().xpHistory.testHistory_c1).toEqual(['s1', 'a-sample']);
        expect(a.db.settings[MAP].X.isTrue).toBe(false);
        expect(a.latches + b.latches).toBe(0);
        expect(toasts).toHaveLength(0);

        // Each takes the other's at its next page load
        await as(a, auto.startup);
        await as(b, auto.startup);
        expect(a.db.settings[MAP].X.isTrue).toBe(true);
        expect(b.db.settings[MAP].X.isTrue).toBe(true);
        expect(b.db.xpHistory.testHistory_c1).toEqual(['s1', 'a-sample']);
        expect(dialog.calls).toBe(0);
    });

    test('two devices in use over many ticks: no reload asked, nothing lost, both converge after a reload', async () => {
        const { a, b } = await syncedPair();
        a.latches = 0;
        b.latches = 0;
        toasts.length = 0;

        await as(a, () => changeSetting(a, 'X', true));
        await as(b, () => changeSetting(b, 'Y', true));
        for (let tick = 0; tick < 6; tick += 1) {
            await activeTick(a, `a${tick}`);
            await activeTick(b, `b${tick}`);
        }

        expect(a.latches + b.latches).toBe(0);
        expect(toasts.filter((toast) => /Reload/.test(toast.message))).toHaveLength(0);

        const onGist = gistStores();
        expect(onGist.settings[MAP]).toMatchObject({ X: { isTrue: true }, Y: { isTrue: true } });
        for (let tick = 0; tick < 6; tick += 1) {
            expect(onGist.xpHistory.testHistory_c1).toContain(`a${tick}`);
            expect(onGist.xpHistory.testHistory_c1).toContain(`b${tick}`);
        }

        await as(a, auto.startup);
        await as(b, auto.startup);
        for (const device of [a, b]) {
            expect(device.db.settings[MAP]).toMatchObject({ X: { isTrue: true }, Y: { isTrue: true } });
            expect(new Set(device.db.xpHistory.testHistory_c1)).toEqual(new Set(onGist.xpHistory.testHistory_c1));
        }
    });

    test('the loop settles: once the gist holds everything, nothing more is sent', async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            changeSetting(b, 'X', true);
            b.db.xpHistory.testHistory_c1 = ['s1', 'b-sample'];
            await auto.push();
        });
        a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        await as(a, auto.push);
        await as(b, auto.startup);
        await as(a, auto.startup);

        const writes = gist.writes;
        for (let round = 0; round < 3; round += 1) {
            await as(a, auto.pull);
            await as(a, auto.push);
            await as(b, auto.pull);
            await as(b, auto.push);
        }
        expect(gist.writes).toBe(writes);
    });

    test('a merge that would add nothing sends nothing, though the gist is ahead', async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        const writes = gist.writes;
        // A's only change is one the gist already has: its history, re-recorded
        a.db.xpHistory.testHistory_c1 = ['s1'];
        a.db.settings.panelGeometry = { x: 1 };
        await as(b, () => {
            b.db.settings.panelGeometry = { x: 1 };
        });
        await as(b, auto.push);
        const afterB = gist.writes;
        expect(afterB).toBeGreaterThan(writes);
        expect((await as(a, auto.push)).reason).toBe('gist-has-it');
        expect(gist.writes).toBe(afterB);
    });

    test('two devices whose folds disagree on a scalar settle instead of trading it every interval', async () => {
        const { a, b } = await syncedPair();
        const list = (sortBy, hrid) => ({
            entries: [{ hrid, name: hrid }],
            zones: {},
            chests: {},
            sortBy,
            direction: 'asc',
        });
        await as(a, () => {
            a.db.settings.watchlist_c1 = list('name', '/items/a');
        });
        await as(b, () => {
            b.db.settings.watchlist_c1 = list('price', '/items/b');
        });

        // Both in use: each records history every tick, so each pushes every
        // tick, and each push folds the other's watchlist into the upload
        const sortOnGist = [];
        for (let tick = 0; tick < 6; tick += 1) {
            await activeTick(a, `a${tick}`);
            sortOnGist.push(gistStores().settings.watchlist_c1.sortBy);
            await activeTick(b, `b${tick}`);
            sortOnGist.push(gistStores().settings.watchlist_c1.sortBy);
        }

        // Settled after the first exchange, not flipping with every upload
        expect(new Set(sortOnGist.slice(2)).size).toBe(1);
        const onGist = gistStores().settings.watchlist_c1;
        expect(onGist.entries.map((entry) => entry.hrid).sort()).toEqual(['/items/a', '/items/b']);

        // Once neither records anything, neither uploads
        const settled = gist.writes;
        for (let tick = 0; tick < 3; tick += 1) {
            await as(a, auto.pull);
            await as(a, auto.push);
            await as(b, auto.pull);
            await as(b, auto.push);
        }
        expect(gist.writes).toBe(settled);
    });

    test('a concurrent edit of one setting goes to the later wall-clock change', async () => {
        const { a, b } = await syncedPair();
        // A changes Y at minute 1, B changes it back at minute 2, neither synced between
        await as(a, () => changeSetting(a, 'Y', true));
        await as(b, () => changeSetting(b, 'Y', false));
        b.db.settings[STAMPS].Y.seq = 0; // a lower counter does not save the earlier change
        await as(a, auto.push);
        await as(b, auto.push);
        expect(gistStores().settings[MAP].Y.isTrue).toBe(false);

        // And the other way round: the later change is the one that was pushed
        // first, and the earlier one arrives after it. (A still holds Y on.)
        await as(b, () => changeSetting(b, 'Y', true));
        await as(a, () => changeSetting(a, 'Y', false));
        await as(a, auto.push);
        await as(b, auto.push);
        expect(gistStores().settings[MAP].Y.isTrue).toBe(false);
    });

    test("an import on A survives B's next automatic push", async () => {
        const { a, b } = await syncedPair();
        // B changed X a while ago and has not synced since
        await as(b, () => changeSetting(b, 'X', false));
        // A imports a settings file: every imported id stamped now (see settings-storage)
        await as(a, () => {
            a.db.settings[MAP] = { X: { id: 'X', isTrue: true }, Y: { id: 'Y', isTrue: true } };
            a.db.settings[STAMPS] = {
                X: { at: BASE_MS + elapsed, seq: null },
                Y: { at: BASE_MS + elapsed, seq: null },
            };
        });
        await as(a, auto.push);
        b.db.xpHistory.testHistory_c1 = ['s1', 'b-sample'];
        await as(b, auto.push);

        expect(gistStores().settings[MAP]).toMatchObject({ X: { isTrue: true }, Y: { isTrue: true } });
        expect(gistStores().xpHistory.testHistory_c1).toEqual(['s1', 'b-sample']);
    });

    test("a full-backup restore on A is not undone by the gist's newer copies at A's next push", async () => {
        const { importEverything } = await import('../../utils/full-backup.js');
        const { a, b } = await syncedPair();
        // A backup taken now, with an old stamp on X
        const backup = {
            formatVersion: 1,
            exportedAt: 'x',
            stores: {
                settings: {
                    [MAP]: { X: { id: 'X', isTrue: false }, Y: { id: 'Y', isTrue: true } },
                    [STAMPS]: { X: { at: 1, seq: null } },
                    panelGeometry: { from: 'backup' },
                },
            },
        };
        // B changes X and a panel position, and pushes, after the backup was taken
        await as(b, async () => {
            changeSetting(b, 'X', true);
            b.db.settings.panelGeometry = { from: 'b' };
            await auto.push();
        });

        await as(a, async () => {
            syncManager.prepareFullRestore(backup);
            const result = await importEverything(backup);
            expect(result.complete).toBe(true);
            await syncManager.noteFullRestore(Object.keys(result.restored));
        });
        await as(a, auto.push);

        const onGist = gistStores().settings;
        expect(onGist[MAP]).toMatchObject({ X: { isTrue: false }, Y: { isTrue: true } });
        expect(onGist.panelGeometry).toEqual({ from: 'backup' });
        // Histories still fold: nothing the other device recorded is dropped
        expect(onGist.xpHistory).toBeUndefined();
        expect(gistStores().xpHistory.testHistory_c1).toEqual(['s1']);
    });

    test('an edit made after a merge the gist won is not lost at the next push, and a reload keeps it', async () => {
        const { a, b } = await syncedPair();
        // Both move the panel position between the same two syncs; B pushes first
        await as(b, async () => {
            b.db.settings.panelGeometry = { from: 'b' };
            await auto.push();
        });
        await as(a, async () => {
            a.db.settings.panelGeometry = { from: 'a1' };
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
            await auto.push();
        });
        // Both moved it: the gist's copy stands
        expect(gistStores().settings.panelGeometry).toEqual({ from: 'b' });

        // A moves it again before reloading: that is a change made after the
        // merge, against a gist that has not moved since
        await as(a, async () => {
            a.db.settings.panelGeometry = { from: 'a2' };
            await auto.push();
        });
        expect(gistStores().settings.panelGeometry).toEqual({ from: 'a2' });

        await as(a, auto.startup);
        expect(a.db.settings.panelGeometry).toEqual({ from: 'a2' });
    });

    test("a reload after a merge the gist won takes the gist's value when nothing was edited here since", async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            b.db.settings.panelGeometry = { from: 'b' };
            await auto.push();
        });
        await as(a, async () => {
            a.db.settings.panelGeometry = { from: 'a1' };
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
            await auto.push();
        });

        await as(a, auto.startup);
        expect(a.db.settings.panelGeometry).toEqual({ from: 'b' });
    });

    test('a merge this device won outright leaves nothing for its next reload to apply', async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        // A changes X later, and has nothing else the gist lacks or holds
        await as(a, async () => {
            changeSetting(a, 'X', false);
            await auto.push();
        });
        expect(gistStores().settings[MAP].X.isTrue).toBe(false);
        expect(a.db.settings.toolasha_sync_unapplied ?? null).toBeNull();

        a.latches = 0;
        toasts.length = 0;
        await as(a, auto.startup);
        expect(a.latches).toBe(0);
        expect(toasts).toHaveLength(0);
    });

    test('a partial restore still protects the stores that landed, and only those', async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            b.db.settings.panelGeometry = { from: 'b' };
            b.db.xpHistory.otherKey = 'b';
            await auto.push();
        });
        // The settings store landed; xpHistory's transaction did not
        await as(a, async () => {
            a.db.settings.panelGeometry = { from: 'backup' };
            await syncManager.noteFullRestore(['settings']);
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
            a.db.xpHistory.otherKey = 'stale-local';
        });
        await as(a, auto.push);

        expect(gistStores().settings.panelGeometry).toEqual({ from: 'backup' });
        // Not restored, so not protected: both moved it, and the gist's stands
        expect(gistStores().xpHistory.otherKey).toBe('b');
    });

    test('a device switched to Settings only does not carry the gist history stores in its merged upload', async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            changeSetting(b, 'X', true);
            b.db.xpHistory.testHistory_c1 = ['s1', 'b-sample'];
            await auto.push();
        });
        a.settings.sync_scope = 'settings';
        await as(a, async () => {
            changeSetting(a, 'Y', true);
            await auto.push();
        });

        const merged = JSON.parse(gist.state.payload);
        expect(Object.keys(merged.stores)).toEqual(['settings']);
        expect(merged.syncScope).toBe('settings');
        expect(merged.stores.settings[MAP]).toMatchObject({ X: { isTrue: true }, Y: { isTrue: true } });
    });

    test('a newer push identical in content settles quietly: no note, and no reload at the next startup', async () => {
        const { a, b } = await syncedPair();
        // B re-pushes the same data under a newer counter
        await as(b, () => syncManager.push());
        a.db.settings.panelSizeMemory = 1;
        b.db.settings.panelSizeMemory = 1;
        await as(b, auto.push);

        // A recorded the same thing, so its merge adds nothing either way
        expect((await as(a, auto.push)).reason).toBe('in-step');
        expect(a.db.settings.toolasha_sync_unapplied ?? null).toBeNull();

        a.latches = 0;
        toasts.length = 0;
        await as(a, auto.startup);
        await as(a, auto.pull);
        expect(a.latches).toBe(0);
        expect(toasts).toHaveLength(0);
    });

    test('a pressed Push still means this device, and overwrites', async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        await as(a, () => syncManager.push());
        expect(gistStores().settings[MAP].X.isTrue).toBe(false);
    });
});

describe('mixed versions', () => {
    test("an older build's payload, with no stamps and no counter, merges by the rule that a stamp wins", async () => {
        const { a } = await syncedPair();
        await as(a, () => changeSetting(a, 'X', true));
        a.latches = 0;

        // An older build pushes: whole map, no stamps key, no counter
        const old = JSON.parse(gist.state.payload);
        old.exportedAt = new Date(BASE_MS + elapsed + 60 * 1000).toISOString();
        old.stores.settings[MAP] = { X: { id: 'X', isTrue: false }, Y: { id: 'Y', isTrue: true }, Z: { id: 'Z' } };
        delete old.stores.settings[STAMPS];
        const text = JSON.stringify(old);
        gist.state = { manifest: { toolashaSync: 1, exportedAt: old.exportedAt, chunks: 1 }, payload: text };
        gist.etag += 1;

        await as(a, auto.push);
        // X: A's stamped change beats the unstamped one; Y and Z: only the old build said anything
        expect(gistStores().settings[MAP]).toEqual({
            X: { id: 'X', isTrue: true },
            Y: { id: 'Y', isTrue: true },
            Z: { id: 'Z' },
        });
        expect(a.latches).toBe(0);

        // A's startup pull takes Y and Z and keeps its own X
        await as(a, auto.startup);
        expect(a.db.settings[MAP].X.isTrue).toBe(true);
        expect(a.db.settings[MAP].Y.isTrue).toBe(true);
        expect(a.db.settings[MAP].Z).toEqual({ id: 'Z' });
    });

    test('the payload this build writes keeps the map in the shape an older build reads', async () => {
        const { a } = await syncedPair();
        await as(a, async () => {
            changeSetting(a, 'X', true);
            await auto.push();
        });
        const stores = gistStores();
        expect(JSON.parse(gist.state.payload).formatVersion).toBe(1);
        // Stamps sit beside the map, never inside an entry an older build reads
        expect(stores.settings[MAP].X).toEqual({ id: 'X', isTrue: true });
        expect(stores.settings[STAMPS].X.at).toBeTypeOf('number');
    });
});

describe('an encrypted gist and a device without the passphrase', () => {
    test('the automatic push neither writes nor merges, and says nothing on screen', async () => {
        const a = makeDevice('A', { sync_passphrase: 'pw' });
        a.db.settings[MAP] = { X: { id: 'X', isTrue: false } };
        await as(a, () => syncManager.push());
        expect(gist.state.manifest.encrypted).toBeTruthy();

        const b = makeDevice('B');
        b.db.settings.toolasha_sync_lastSyncedAt = '2026-01-01T00:00:00.000Z';
        b.db.settings[MAP] = { X: { id: 'X', isTrue: true } };
        const writes = gist.writes;
        toasts.length = 0;
        const result = await as(b, auto.push);

        expect(result).toEqual({ ok: false, reason: 'passphrase' });
        expect(gist.writes).toBe(writes);
        expect(gist.state.manifest.encrypted).toBeTruthy();
        expect(toasts).toHaveLength(0);
    });
});

describe('the merge path through gzip and encryption', () => {
    test('an encrypted, compressed gist is read, merged and sent back sealed the same way', async () => {
        // The real gzip and WebCrypto; fake timers would starve their promises
        vi.useRealTimers();
        world.gzip = true;
        const { a, b } = await syncedPair({ sync_passphrase: 'pw' }, { sync_passphrase: 'pw' });
        expect(gist.state.manifest.encrypted).toBeTruthy();
        expect(gist.state.manifest.compressed).toBe('gzip');

        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        expect((await as(a, auto.push)).ok).toBe(true);

        // Still sealed, and nothing readable in the gist
        expect(gist.state.manifest.encrypted).toBeTruthy();
        expect(gist.state.manifest.compressed).toBe('gzip');
        expect(gist.state.payload).not.toContain('a-sample');

        // ...and it holds both sides: B's startup pull decrypts it and takes A's history
        await as(b, auto.startup);
        expect(b.db.xpHistory.testHistory_c1).toEqual(['s1', 'a-sample']);
        expect(b.db.settings[MAP].X.isTrue).toBe(true);
        expect(a.latches).toBe(0);
    });
});
