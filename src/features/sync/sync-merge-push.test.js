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
const world = vi.hoisted(() => ({ device: null, gzip: false, listeners: {} }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback) => world.device.settings[key] ?? fallback,
        onSettingChange: (key, callback) => {
            (world.listeners[key] ||= []).push(callback);
        },
        offSettingChange: (key, callback) => {
            world.listeners[key] = (world.listeners[key] || []).filter((cb) => cb !== callback);
        },
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

const dialog = vi.hoisted(() => ({ calls: 0, answer: null, answers: [], whileOpen: null, last: null }));
vi.mock('../../utils/choice-dialog.js', () => ({
    askChoice: async (question) => {
        dialog.calls += 1;
        dialog.last = question;
        // Something that happens while the dialog sits open, such as another device pushing
        if (dialog.whileOpen) {
            const run = dialog.whileOpen;
            dialog.whileOpen = null;
            await run();
        }
        return dialog.answers.length ? dialog.answers.shift() : dialog.answer;
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
const gist = vi.hoisted(() => ({
    state: null,
    etag: 0,
    writes: 0,
    revisions: [],
    requests: 0,
    downloads: 0,
    revisionReads: [],
    betweenListAndWrite: null,
}));

vi.mock('./gist-client.js', async () => {
    class GistError extends Error {
        constructor(kind, message) {
            super(message);
            this.kind = kind;
        }
    }
    const files = () => ({ 'toolasha-sync.json': 100, 'toolasha-data-000.json': gist.state.payload.length });
    const versionOf = (etag) => `v${etag}`;
    /** Every version written, newest first, as GitHub's `history` lists them */
    const history = () => gist.revisions.map((revision) => revision.version).reverse();
    return {
        GistError,
        chunkPayload: (text) => [text],
        findSyncGist: async () => (gist.state ? 'g1' : null),
        readSyncGist: async (_token, _id, { etag } = {}) => {
            gist.requests += 1;
            if (!gist.state) throw new GistError('not-found', 'no gist');
            const current = `W/"${gist.etag}"`;
            if (etag && etag === current) return { notModified: true, etag };
            gist.downloads += 1;
            return {
                manifest: gist.state.manifest,
                payload: gist.state.payload,
                etag: current,
                files: files(),
                history: history(),
                version: versionOf(gist.etag),
            };
        },
        readSyncGistRevision: async (_token, _id, version) => {
            gist.requests += 1;
            gist.revisionReads.push(version);
            const revision = gist.revisions.find((entry) => entry.version === version);
            if (!revision) throw new GistError('not-found', 'no such revision');
            return { manifest: revision.manifest, payload: revision.payload, history: history(), version };
        },
        writeSyncGist: async (_token, id, manifest, chunks, _prev, known, options = {}) => {
            const { unattended = false, confirmPlaintext = null, isAhead = null } = options;
            const current = `W/"${gist.etag}"`;
            let listing = null;
            if (gist.state) {
                gist.requests += 1;
                listing =
                    known && known.etag === current
                        ? {
                              syncSeq: known.syncSeq,
                              encrypted: known.encrypted,
                              exportedAt: null,
                              version: known.version,
                              fresh: false,
                          }
                        : {
                              syncSeq: gist.state.manifest.syncSeq ?? null,
                              encrypted: Boolean(gist.state.manifest.encrypted),
                              exportedAt: gist.state.manifest.exportedAt,
                              // As the real listing reads it: sync data with no counter and no timestamp
                              unordered:
                                  gist.state.manifest.syncSeq == null &&
                                  !Number.isFinite(Date.parse(gist.state.manifest.exportedAt ?? '')),
                              version: versionOf(gist.etag),
                              fresh: true,
                          };
            }
            if (listing?.encrypted && !manifest.encrypted) {
                if (unattended) throw new GistError('passphrase', 'encrypted gist');
                if (confirmPlaintext && !(await confirmPlaintext())) throw new GistError('cancelled', 'cancelled');
            }
            if (isAhead && listing?.fresh && isAhead(listing)) throw new GistError('behind', 'ahead');
            // Another device's whole push, between this one's listing and its write
            if (gist.betweenListAndWrite) {
                const between = gist.betweenListAndWrite;
                gist.betweenListAndWrite = null;
                await between();
            }
            const syncSeq =
                listing?.syncSeq != null && listing.syncSeq >= manifest.syncSeq
                    ? listing.syncSeq + 1
                    : manifest.syncSeq;
            const basedOn = gist.state && listing?.version ? listing.version : null;
            gist.etag += 1;
            gist.requests += 1;
            gist.state = {
                manifest: { ...manifest, syncSeq, ...(basedOn ? { basedOn } : {}) },
                payload: chunks.join(''),
            };
            gist.revisions.push({ version: versionOf(gist.etag), ...gist.state });
            gist.writes += 1;
            // GitHub's PATCH answer carries the history: what came right before this write
            const after = history();
            const base = basedOn ? after.indexOf(basedOn) : -1;
            // As the real write reads it: the newest five, and whether older ones were left out
            const between = basedOn && base > 1 ? after.slice(1, base) : [];
            const intervening = between.slice(0, 5).reverse();
            return {
                id: id ?? 'g1',
                updatedAt: 'now',
                etag: `W/"${gist.etag}"`,
                files: files(),
                syncSeq,
                version: versionOf(gist.etag),
                basedOn,
                intervening,
                interveningTruncated: between.length > 5,
            };
        },
    };
});

const { default: syncManager, SyncManager, getSyncTrace } = await import('./sync-manager.js');
const { registerSyncMerge } = await import('../../utils/sync-merge-registry.js');
// A history capped by this device's own live setting, written the way the
// labyrinth room log registers (newest first, trimmed to the player's choice
// except when the fold builds an upload)
registerSyncMerge({
    store: 'xpHistory',
    base: 'cappedLog',
    merge: (local, incoming, context) =>
        [...new Set([...(local || []), ...(incoming || [])])]
            .sort((x, y) => y - x)
            .slice(0, context?.forUpload ? Infinity : (world.device.settings.logCap ?? Infinity)),
    label: 'Capped log',
});

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

/**
 * Arm the gist so six other pushes land between the next write's listing and its write: one more than the
 * race check reads back. Each is built on the gist as it was listed, so what only one of them holds is its own.
 * @param {Function} [shape] - Called with each push's payload and its number (1 = oldest), to change it
 */
function raceSixPushes(shape = () => {}) {
    gist.betweenListAndWrite = async () => {
        const original = gist.state.payload;
        for (let i = 1; i <= 6; i += 1) {
            const based = `v${gist.etag}`;
            const payload = JSON.parse(original);
            payload.stores.xpHistory = { ...payload.stores.xpHistory, testHistory_c1: [`other-${i}`] };
            // A scalar the watchlist fold cannot combine: the newest push's value has to be the one kept
            payload.stores.settings = {
                ...payload.stores.settings,
                watchlist_c1: { entries: [], zones: {}, chests: {}, sortBy: `sort-${i}`, direction: 'asc' },
            };
            shape(payload, i);
            gist.etag += 1;
            gist.state = {
                manifest: {
                    ...gist.state.manifest,
                    syncSeq: gist.state.manifest.syncSeq + 1,
                    exportedAt: new Date(BASE_MS + elapsed - 1000 + i).toISOString(),
                    basedOn: based,
                    hash: undefined,
                    bytes: undefined,
                },
                payload: JSON.stringify(payload),
            };
            gist.revisions.push({ version: `v${gist.etag}`, ...gist.state });
        }
    };
}

beforeEach(() => {
    world.gzip = false;
    vi.useFakeTimers();
    gist.state = null;
    gist.etag = 0;
    gist.writes = 0;
    gist.revisions = [];
    gist.requests = 0;
    gist.downloads = 0;
    gist.revisionReads = [];
    gist.betweenListAndWrite = null;
    toasts.length = 0;
    dialog.calls = 0;
    dialog.answer = null;
    dialog.answers = [];
    dialog.whileOpen = null;
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
            await syncManager.noteFullRestore(backup, Object.keys(result.restored));
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

    test("a startup pull that keeps a key this device moved leaves the next push sending this device's value", async () => {
        const { a, b } = await syncedPair();
        // The key is on the gist, and both devices hold that copy
        await as(a, async () => {
            a.db.settings.panelGeometry = { from: 'base' };
            await auto.push();
        });
        await as(b, auto.startup);
        // A moves it offline; B pushes something else, so the gist is newer but unmoved on this key
        a.db.settings.panelGeometry = { from: 'a1' };
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        await as(a, auto.startup);
        expect(a.db.settings.panelGeometry).toEqual({ from: 'a1' });

        // The next automatic push carries the edit, not the gist's older copy
        await as(a, async () => {
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
            await auto.push();
        });
        expect(gistStores().settings.panelGeometry).toEqual({ from: 'a1' });
        await as(a, auto.startup);
        expect(a.db.settings.panelGeometry).toEqual({ from: 'a1' });
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
            const backup = {
                stores: { settings: { panelGeometry: { from: 'backup' } }, xpHistory: { otherKey: 'stale-local' } },
            };
            await syncManager.noteFullRestore(backup, ['settings']);
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
            a.db.xpHistory.otherKey = 'stale-local';
        });
        await as(a, auto.push);

        expect(gistStores().settings.panelGeometry).toEqual({ from: 'backup' });
        // Not restored, so not protected: both moved it, and the gist's stands
        expect(gistStores().xpHistory.otherKey).toBe('b');
    });

    test('a key the backup did not hold is merged as usual, not given the restore precedence', async () => {
        const { importEverything } = await import('../../utils/full-backup.js');
        const { a, b } = await syncedPair();
        // Both devices hold K (panelSizeMemory) from before; the backup does not
        a.db.settings.panelSizeMemory = 'old';
        await as(a, () => syncManager.push());
        await as(b, () => syncManager.pull());
        const backup = {
            formatVersion: 1,
            exportedAt: 'x',
            stores: { settings: { panelGeometry: { from: 'backup' } } },
        };

        // The other device changes K and the panel position, and pushes
        await as(b, async () => {
            b.db.settings.panelSizeMemory = 'b-newer';
            b.db.settings.panelGeometry = { from: 'b' };
            await auto.push();
        });
        // A restores the backup and its automatic push merges
        await as(a, async () => {
            const result = await importEverything(backup);
            await syncManager.noteFullRestore(backup, Object.keys(result.restored));
        });
        await as(a, auto.push);

        expect(gistStores().settings.panelSizeMemory).toBe('b-newer');
        expect(gistStores().settings.panelGeometry).toEqual({ from: 'backup' });
    });

    test("a device keeping 20 sessions merges a gist holding 500 without cutting the other device's history", async () => {
        const { a, b } = await syncedPair();
        const range = (from, count) => Array.from({ length: count }, (_, index) => from + index);
        a.settings.logCap = 20;
        b.settings.logCap = 500;
        // B keeps 500, all newer than A's own 20
        await as(b, async () => {
            b.db.xpHistory.cappedLog_c1 = range(1000, 500);
            await auto.push();
        });
        await as(a, async () => {
            a.db.xpHistory.cappedLog_c1 = range(1, 20);
            await auto.push();
        });
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(520);

        // A's reload trims its own copy to its setting; the gist keeps them all
        await as(a, auto.startup);
        expect(a.db.xpHistory.cappedLog_c1).toHaveLength(20);

        // ...and nothing loops: no uploads, no note, no reload asked again
        const writes = gist.writes;
        for (let tick = 0; tick < 3; tick += 1) {
            await as(a, auto.pull);
            await as(a, auto.push);
            await as(b, auto.pull);
            await as(b, auto.push);
        }
        expect(gist.writes).toBe(writes);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(520);
        expect(a.db.settings.toolasha_sync_unapplied ?? null).toBeNull();
        a.latches = 0;
        await as(a, auto.startup);
        expect(a.latches).toBe(0);
    });

    test('a device keeping 20 sessions that startup-pulled a gist of 500 does not cut it on its next merge', async () => {
        const { a, b } = await syncedPair();
        const range = (from, count) => Array.from({ length: count }, (_, index) => from + index);
        a.settings.logCap = 20;
        b.settings.logCap = 500;
        a.db.xpHistory.cappedLog_c1 = range(1, 20);
        await as(b, async () => {
            b.db.xpHistory.cappedLog_c1 = range(1000, 500);
            await auto.push();
        });
        // A's startup pull records the gist's 500 as the last exchange, and keeps 20 itself
        await as(a, auto.startup);
        expect(a.db.xpHistory.cappedLog_c1).toHaveLength(20);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(500);

        // B moves the gist on (a setting, the log untouched); A records a session and its push merges
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        await as(a, async () => {
            a.db.xpHistory.cappedLog_c1 = [5000, ...a.db.xpHistory.cappedLog_c1].slice(0, 20);
            expect((await auto.push()).ok).toBe(true);
        });

        const log = gistStores().xpHistory.cappedLog_c1;
        expect(log).toContain(5000);
        expect(log).toEqual(expect.arrayContaining(range(1000, 500)));
        expect(gistStores().settings[MAP].X.isTrue).toBe(true);
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

    test('a Settings-only merge that changes nothing but drops history stores still uploads', async () => {
        const { a, b } = await syncedPair();
        await as(b, async () => {
            b.db.settings.panelSizeMemory = 1;
            b.db.xpHistory.testHistory_c1 = ['s1', 'b-sample'];
            await auto.push();
        });
        // A, now Settings only, recorded the very setting B pushed: its merge
        // adds nothing to the gist, but sheds the history stores it no longer syncs
        a.settings.sync_scope = 'settings';
        a.db.settings.panelSizeMemory = 1;
        const result = await as(a, auto.push);

        expect(result.ok).toBe(true);
        expect(result.skipped).toBeFalsy();
        expect(Object.keys(gistStores())).toEqual(['settings']);
        expect(gistStores().settings.panelSizeMemory).toBe(1);
        // ...and the next tick, with nothing changed, writes nothing
        const writes = gist.writes;
        expect((await as(a, auto.push)).reason).toBe('unchanged');
        expect(gist.writes).toBe(writes);
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

describe('an automatic push that would cut a history the gist holds merges instead', () => {
    const range = (from, count) => Array.from({ length: count }, (_, index) => from + index);

    /**
     * B keeps 500 sessions and pushed them; A keeps 20 and startup-pulled them.
     * @returns {Promise<{a: Object, b: Object}>} Devices
     */
    async function cappedAfterStartup() {
        const { a, b } = await syncedPair();
        a.settings.logCap = 20;
        b.settings.logCap = 500;
        a.db.xpHistory.cappedLog_c1 = range(1, 20);
        // Newest first, the order the log keeps
        await as(b, async () => {
            b.db.xpHistory.cappedLog_c1 = range(1000, 500).reverse();
            await auto.push();
        });
        await as(a, auto.startup);
        expect(a.db.xpHistory.cappedLog_c1).toHaveLength(20);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(500);
        return { a, b };
    }

    test('a device keeping 20 sessions records one after a startup pull of 500: the gist keeps all 500', async () => {
        const { a } = await cappedAfterStartup();
        a.latches = 0;
        toasts.length = 0;

        // Nothing moved the gist since A's startup, so this used to be a plain push of A's 20
        await as(a, async () => {
            a.db.xpHistory.cappedLog_c1 = [5000, ...a.db.xpHistory.cappedLog_c1].slice(0, 20);
            expect((await auto.push()).ok).toBe(true);
        });

        const log = gistStores().xpHistory.cappedLog_c1;
        expect(log).toContain(5000);
        expect(log).toEqual(expect.arrayContaining(range(1000, 500)));
        expect(log).toHaveLength(501);
        // The cost: one download of the gist to merge with
        expect(gist.downloads).toBeGreaterThan(0);
    });

    test('the merged automatic push writes nothing here: no latch, no "Reload now", local copy untouched', async () => {
        const { a } = await cappedAfterStartup();
        a.latches = 0;
        toasts.length = 0;
        const before = [5000, ...a.db.xpHistory.cappedLog_c1].slice(0, 20);
        await as(a, async () => {
            a.db.xpHistory.cappedLog_c1 = [...before];
            await auto.push();
        });

        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(501);
        expect(a.latches).toBe(0);
        expect(toasts.filter((toast) => /Reload/.test(toast.message))).toHaveLength(0);
        expect(toasts).toHaveLength(0);
        expect(a.db.xpHistory.cappedLog_c1).toEqual(before);
    });

    test('a later push that changes only a setting still keeps the 500', async () => {
        const { a } = await cappedAfterStartup();
        await as(a, async () => {
            a.db.xpHistory.cappedLog_c1 = [5000, ...a.db.xpHistory.cappedLog_c1].slice(0, 20);
            await auto.push();
        });
        await as(a, async () => {
            changeSetting(a, 'Y', true);
            await auto.push();
        });

        expect(gistStores().settings[MAP].Y.isTrue).toBe(true);
        expect(gistStores().xpHistory.cappedLog_c1).toEqual(expect.arrayContaining([5000, ...range(1000, 500)]));
    });

    test('a merge that settled in step records the gist it settled on, so the next plain push cannot cut it', async () => {
        const { a, b } = await cappedAfterStartup();
        // Both devices set the same whole key; A's push finds the gist ahead and the merge adds nothing
        await as(b, async () => {
            b.db.settings.panelSizeMemory = 1;
            await auto.push();
        });
        await as(a, async () => {
            a.db.settings.panelSizeMemory = 1;
            expect((await auto.push()).reason).toBe('in-step');
        });

        // A changes only a setting: nothing moved the gist, and A's log is still its 20
        await as(a, async () => {
            changeSetting(a, 'Y', true);
            await auto.push();
        });

        expect(gistStores().settings[MAP].Y.isTrue).toBe(true);
        expect(gistStores().xpHistory.cappedLog_c1).toEqual(expect.arrayContaining(range(1000, 500)));
    });

    test('a push that moved no registered history stays plain and downloads nothing', async () => {
        const { a } = await syncedPair();
        gist.downloads = 0;
        const writes = gist.writes;
        await as(a, async () => {
            changeSetting(a, 'X', true);
            expect((await auto.push()).ok).toBe(true);
        });

        expect(gist.writes).toBe(writes + 1);
        expect(gist.downloads).toBe(0);
        expect(gistStores().settings[MAP].X.isTrue).toBe(true);
        expect(gistStores().xpHistory.testHistory_c1).toEqual(['s1']);
    });

    /** The 20-session device presses Push, answering the question it is now asked */
    async function pressPush(answer) {
        const { a } = await cappedAfterStartup();
        dialog.answer = answer;
        dialog.calls = 0;
        const writes = gist.writes;
        const result = await as(a, async () => {
            changeSetting(a, 'Y', true);
            return syncManager.push();
        });
        return { a, result, wrote: gist.writes - writes };
    }

    test('a pressed Push on the 20-session device asks, and Replace anyway still overwrites', async () => {
        const { wrote } = await pressPush('replace');
        expect(dialog.calls).toBe(1);
        expect(wrote).toBe(1);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(20);
    });

    test('Merge and push keeps the entries on GitHub and still sends this device edit', async () => {
        const { wrote } = await pressPush('merge');
        expect(dialog.calls).toBe(1);
        expect(wrote).toBe(1);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(500);
        expect(gistStores().settings[MAP].Y.isTrue).toBe(true);
    });

    test('Merge and push downloads the gist once: the trim check is reused', async () => {
        const { a } = await cappedAfterStartup();
        dialog.answer = 'merge';
        gist.downloads = 0;
        await as(a, async () => {
            changeSetting(a, 'Y', true);
            await syncManager.push();
        });
        expect(gist.downloads).toBe(1);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(500);
        expect(gistStores().settings[MAP].Y.isTrue).toBe(true);
    });

    test('another device pushing while the question is open: Replace anyway does not overwrite what it never saw', async () => {
        const { a } = await cappedAfterStartup();
        dialog.calls = 0;
        dialog.answer = null;
        dialog.answers = ['replace', 'merge'];
        // Another device adds a session to the gist while the dialog is open
        dialog.whileOpen = () => {
            const payload = JSON.parse(gist.state.payload);
            payload.stores.xpHistory.cappedLog_c1 = [7000, ...payload.stores.xpHistory.cappedLog_c1];
            gist.etag += 1;
            gist.state = {
                manifest: {
                    ...gist.state.manifest,
                    syncSeq: gist.state.manifest.syncSeq + 1,
                    hash: undefined,
                    bytes: undefined,
                },
                payload: JSON.stringify(payload),
            };
            gist.revisions.push({ version: `v${gist.etag}`, ...gist.state });
        };
        await as(a, async () => {
            changeSetting(a, 'Y', true);
            await syncManager.push();
        });

        // Asked again about the version it had not seen, instead of cutting it to 20
        expect(dialog.calls).toBe(2);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(501);
        expect(gistStores().xpHistory.cappedLog_c1).toContain(7000);
    });

    test('Merge and push with another device pushing meanwhile merges again and still uploads', async () => {
        const { a } = await cappedAfterStartup();
        dialog.calls = 0;
        dialog.answer = 'merge';
        dialog.whileOpen = () => {
            const payload = JSON.parse(gist.state.payload);
            payload.stores.xpHistory.cappedLog_c1 = [7000, ...payload.stores.xpHistory.cappedLog_c1];
            gist.etag += 1;
            gist.state = {
                manifest: {
                    ...gist.state.manifest,
                    syncSeq: gist.state.manifest.syncSeq + 1,
                    hash: undefined,
                    bytes: undefined,
                },
                payload: JSON.stringify(payload),
            };
            gist.revisions.push({ version: `v${gist.etag}`, ...gist.state });
        };
        const result = await as(a, async () => {
            changeSetting(a, 'Y', true);
            return syncManager.push();
        });

        // The pressed merge is not left for an interval: it reads the new version and sends the edit
        expect(result.ok).toBe(true);
        expect(gistStores().settings[MAP].Y.isTrue).toBe(true);
        expect(gistStores().xpHistory.cappedLog_c1).toContain(7000);
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(501);
    });

    describe('remembering Merge and push', () => {
        /** A presses Push (editing a setting first), answering `answer` if asked */
        async function press(a, answer) {
            dialog.answer = answer;
            dialog.calls = 0;
            return as(a, async () => {
                changeSetting(a, `S${elapsed}`, true);
                return syncManager.push();
            });
        }

        test('asked once; the next pressed Push merges silently', async () => {
            const { a } = await cappedAfterStartup();
            await press(a, 'merge');
            expect(dialog.calls).toBe(1);

            const writes = gist.writes;
            const result = await press(a, null);
            expect(dialog.calls).toBe(0);
            expect(result.ok).toBe(true);
            expect(gist.writes).toBe(writes + 1);
            expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(500);
        });

        test('Replace anyway is not remembered, and neither is Cancel', async () => {
            const { a } = await cappedAfterStartup();
            await press(a, null);
            expect(dialog.calls).toBe(1);
            expect(a.db.settings.toolasha_sync_mergeOnTrim ?? null).toBeNull();
            await press(a, 'replace');
            expect(dialog.calls).toBe(1);
            expect(a.db.settings.toolasha_sync_mergeOnTrim ?? null).toBeNull();
        });

        test('a scope change clears it, and so does unlinking the gist', async () => {
            const { a } = await cappedAfterStartup();
            syncManager.isInitialized = false;
            await syncManager.initialize();
            try {
                await press(a, 'merge');
                expect(a.db.settings.toolasha_sync_mergeOnTrim).toBeTruthy();
                await as(a, async () => {
                    for (const callback of world.listeners.sync_scope) await callback();
                });
                expect(a.db.settings.toolasha_sync_mergeOnTrim).toBeNull();
                await press(a, 'merge');
                expect(dialog.calls).toBe(1);

                expect(a.db.settings.toolasha_sync_mergeOnTrim).toBeTruthy();
                await as(a, () => syncManager.forgetGist());
                expect(a.db.settings.toolasha_sync_mergeOnTrim).toBeNull();
            } finally {
                syncManager.cleanup();
                syncManager.isInitialized = false;
            }
        });

        test('the remembered answer is not honored under a different scope', async () => {
            const { a } = await cappedAfterStartup();
            await press(a, 'merge');
            a.db.settings.toolasha_sync_mergeOnTrim = { gistId: 'g1', scope: 'settings' };
            await press(a, 'merge');
            expect(dialog.calls).toBe(1);
        });

        test('the answer is remembered for the scope the push was built for, not one chosen mid-download', async () => {
            const { a } = await cappedAfterStartup();
            const readRemote = syncManager._readRemote;
            const spy = vi.spyOn(syncManager, '_readRemote').mockImplementation(async function (...args) {
                // The player changes "What to sync" while the gist is downloading
                a.settings.sync_scope = 'settings';
                return readRemote.apply(this, args);
            });
            try {
                await press(a, 'merge');
            } finally {
                spy.mockRestore();
            }
            expect(dialog.calls).toBe(1);
            expect(a.db.settings.toolasha_sync_mergeOnTrim).toEqual({ gistId: 'g1', scope: 'everything' });
        });
    });

    test('the dialog names what GitHub has more of, and the trace lists the keys', async () => {
        await pressPush('merge');
        expect(dialog.last.message).toContain('GitHub has more: ');
        expect(dialog.last.message).toContain('Capped log');
        const entry = getSyncTrace().findLast((item) => item.event === 'push-would-trim');
        expect(entry.keys).toEqual(['xpHistory/cappedLog_c1']);
    });

    test('Cancel writes nothing', async () => {
        const { result, wrote } = await pressPush(null);
        expect(dialog.calls).toBe(1);
        expect(wrote).toBe(0);
        expect(result.reason).toBe('cancelled');
        expect(gistStores().xpHistory.cappedLog_c1).toHaveLength(500);
    });

    test('a pressed Push that would trim nothing asks nothing', async () => {
        const { a } = await syncedPair();
        dialog.calls = 0;
        await as(a, async () => {
            changeSetting(a, 'X', true);
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
            await syncManager.push();
        });
        expect(dialog.calls).toBe(0);
        expect(gistStores().xpHistory.testHistory_c1).toEqual(['s1', 'a-sample']);
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

    test("an older build's device-local key leaves the gist though everything else already matches", async () => {
        const { a } = await syncedPair();
        // An older build pushes A's own data plus a key this build keeps on the device
        const old = JSON.parse(gist.state.payload);
        old.exportedAt = new Date(BASE_MS + elapsed + 60 * 1000).toISOString();
        old.stores.settings.panelSizeMemory = 1;
        old.stores.settings.toolasha_local_whispers = ['private'];
        gist.state = {
            manifest: { toolashaSync: 1, exportedAt: old.exportedAt, chunks: 1 },
            payload: JSON.stringify(old),
        };
        gist.etag += 1;
        // A recorded the same setting, so its merge adds nothing to the gist
        a.db.settings.panelSizeMemory = 1;
        const writes = gist.writes;

        const result = await as(a, auto.push);

        expect(result.ok).toBe(true);
        expect(gist.writes).toBe(writes + 1);
        expect(gistStores().settings).not.toHaveProperty('toolasha_local_whispers');
        expect(gistStores().settings.panelSizeMemory).toBe(1);
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

describe('a gist whose manifest lost its order', () => {
    test("an automatic push merges it rather than writing over the other device's push", async () => {
        // The real WebCrypto; fake timers would starve its promises
        vi.useRealTimers();
        const { a, b } = await syncedPair({ sync_passphrase: 'pw' }, { sync_passphrase: 'pw' });
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        // The manifest is damaged: its counter and timestamp are gone. A's
        // passphrase means the plaintext refusal does not stop its write
        const { syncSeq: _seq, exportedAt: _at, ...damaged } = gist.state.manifest;
        gist.state = { ...gist.state, manifest: damaged };
        gist.etag += 1;
        gist.revisions.push({ version: `v${gist.etag}`, ...gist.state });

        await as(a, async () => {
            changeSetting(a, 'Y', true);
            expect((await auto.push()).ok).toBe(true);
        });
        expect(gist.state.manifest.encrypted).toBeTruthy();

        // The gist holds both edits: A's startup pull takes B's
        await as(a, auto.startup);
        expect(a.db.settings[MAP].X.isTrue).toBe(true);
        expect(a.db.settings[MAP].Y.isTrue).toBe(true);
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

describe('two devices writing at the same moment', () => {
    test('GET, GET, PATCH, PATCH: the later write finds the earlier, folds it in, and both edits stay', async () => {
        const { a, b } = await syncedPair();
        // B, a separate manager, is pushing in the same instant from its own page
        const other = new SyncManager();
        await as(b, () => changeSetting(b, 'X', true));
        await as(a, () => {
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        });

        // A lists the gist; before A writes, B lists and writes too
        gist.betweenListAndWrite = async () => {
            // Another browser: its own Web Locks, so not this tab's sync lock
            world.device = b;
            vi.stubGlobal('navigator', {});
            try {
                expect((await other.push({ silent: true, unattended: true })).ok).toBe(true);
            } finally {
                vi.unstubAllGlobals();
                other.busy = false;
                world.device = a;
            }
        };
        const result = await as(a, auto.push);

        expect(result.ok).toBe(true);
        expect(gist.revisionReads).toHaveLength(1);
        expect(gistStores().settings[MAP].X.isTrue).toBe(true);
        expect(gistStores().xpHistory.testHistory_c1).toEqual(['s1', 'a-sample']);
        // A holds B's change only on the gist, so its next reload takes it
        expect(a.db.settings.toolasha_sync_unapplied).toBeTruthy();
        await as(a, auto.startup);
        expect(a.db.settings[MAP].X.isTrue).toBe(true);
    });

    test('a push raced on every rewrite gives up without recording success, so the next tick retries', async () => {
        const { a, b } = await syncedPair();
        const other = new SyncManager();
        a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        const lastHashBefore = a.db.settings.toolasha_sync_lastHash;
        let raced = 0;
        const race = async () => {
            raced += 1;
            world.device = b;
            vi.stubGlobal('navigator', {});
            try {
                b.db.xpHistory.testHistory_c1 = [...(b.db.xpHistory.testHistory_c1 || []), `b${raced}`];
                await other.push({ silent: true, unattended: true });
            } finally {
                vi.unstubAllGlobals();
                other.busy = false;
                world.device = a;
            }
            // Armed again for A's next write only, after B's own write is done
            if (raced < 4) gist.betweenListAndWrite = race;
        };
        gist.betweenListAndWrite = race;

        const result = await as(a, auto.push);

        expect(result).toEqual({ ok: false, reason: 'raced' });
        expect(a.db.settings.toolasha_sync_lastHash).toBe(lastHashBefore);
    });

    test('a write that replaced more pushes than one check reads back puts the newest back and retries', async () => {
        const { a } = await syncedPair();
        a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        // Six other pushes, each a mergeable payload of its own, land between
        // A's listing and A's write: one more than the check reads back
        let newest;
        raceSixPushes((payload) => {
            newest = JSON.stringify(payload);
        });
        const result = await as(a, auto.push);
        const aWrite = gist.revisions.find((revision) => revision.payload.includes('a-sample'));

        // Not recorded as a success, and no rewrite built from the newest five
        expect(result).toEqual({ ok: false, reason: 'raced' });
        expect(aWrite).toBeTruthy();
        expect(gist.revisions.filter((revision) => revision.payload.includes('a-sample'))).toHaveLength(1);
        // The gist is the other pushes folded together, numbered above A's write: the newest, and data only
        // an older readable one held (the 2nd of the five), without A's own sample
        expect(newest).toBeTruthy();
        expect(gist.state.payload).toContain('other-6');
        expect(gist.state.payload).toContain('other-2');
        expect(gist.state.payload).not.toContain('a-sample');
        expect(JSON.parse(gist.state.payload).stores.settings.watchlist_c1.sortBy).toBe('sort-6');
        expect(gist.state.manifest.syncSeq).toBeGreaterThan(aWrite.manifest.syncSeq);

        // ...and A's next tick merges its sample onto that revision as an ordinary push
        expect(await as(a, auto.push)).toEqual({ ok: true });
        expect(gist.state.payload).toContain('a-sample');
        expect(gist.state.payload).toContain('other-6');
        expect(
            warn.mock.calls.some(([line]) => String(line).includes('other pushes landed while this one was written'))
        ).toBe(true);
        warn.mockRestore();
        error.mockRestore();
    });

    describe('the folded restore is a fold of other pushes alone', () => {
        /**
         * A pushes over six raced pushes and returns what the gist was restored to.
         * @param {Object} a - Device A
         * @param {Function} shape - Shapes each raced push, as raceSixPushes takes it
         * @returns {Promise<Object>} The restored gist payload
         */
        const restoreAfterRace = async (a, shape) => {
            a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const error = vi.spyOn(console, 'error').mockImplementation(() => {});
            raceSixPushes((payload, i) => {
                // Only an older readable push holds this: it is in the result only if the restore folded
                if (i === 2) payload.stores.settings.panelGeometry = 'from-2';
                shape(payload, i);
            });
            expect(await as(a, auto.push)).toEqual({ ok: false, reason: 'raced' });
            warn.mockRestore();
            error.mockRestore();
            const restored = JSON.parse(gist.state.payload);
            expect(restored.stores.settings.panelGeometry).toBe('from-2');
            return restored;
        };
        const settingsOnly = (payload) => {
            payload.syncScope = 'settings';
            delete payload.stores.xpHistory;
        };

        test("older Settings-only pushes do not strip the newest push's histories", async () => {
            const { a } = await syncedPair();

            const restored = await restoreAfterRace(a, (payload, i) => i < 6 && settingsOnly(payload));

            expect(restored.syncScope).toBe('everything');
            expect(restored.stores.xpHistory.testHistory_c1).toContain('other-6');
            expect(restored.stores.settings.watchlist_c1.sortBy).toBe('sort-6');
        });

        test("a Settings-only newest push does not have older pushes' histories put back", async () => {
            const { a } = await syncedPair();

            const restored = await restoreAfterRace(a, (payload, i) => i === 6 && settingsOnly(payload));

            expect(restored.syncScope).toBe('settings');
            expect(restored.stores.xpHistory).toBeUndefined();
            expect(restored.stores.settings.watchlist_c1.sortBy).toBe('sort-6');
        });

        test("this device's baseline does not hand an older push the value the newest one set back", async () => {
            const { a } = await syncedPair();
            // A's last exchange holds the watchlist sorted 'base'...
            const watchlist = (sortBy) => ({ entries: [], zones: {}, chests: {}, sortBy, direction: 'asc' });
            a.db.settings.watchlist_c1 = watchlist('base');
            expect(await as(a, auto.push)).toEqual({ ok: true });

            // ...older pushes changed it, and the newest set it back to 'base'
            const restored = await restoreAfterRace(a, (payload, i) => {
                if (i === 6) payload.stores.settings.watchlist_c1 = watchlist('base');
            });

            expect(restored.stores.settings.watchlist_c1.sortBy).toBe('base');
        });
    });

    test('a write in the clear that replaced an encrypted push it cannot read puts that push back', async () => {
        // The real WebCrypto; fake timers would starve its promises
        vi.useRealTimers();
        const { a, b } = await syncedPair();
        expect(gist.state.manifest.encrypted).toBeFalsy();
        const other = new SyncManager();
        // B turns encryption on; A, which has no passphrase, records a sample
        b.settings.sync_passphrase = 'pw';
        await as(b, () => changeSetting(b, 'X', true));
        a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];

        // A lists the gist in the clear; B's encrypted push lands before A writes
        gist.betweenListAndWrite = async () => {
            world.device = b;
            vi.stubGlobal('navigator', {});
            try {
                expect((await other.push({ silent: true, unattended: true })).ok).toBe(true);
            } finally {
                vi.unstubAllGlobals();
                other.busy = false;
                world.device = a;
            }
        };
        const bSeq = () => b.db.settings.toolasha_sync_lastSyncedSeq;
        const result = await as(a, auto.push);

        expect(result.ok).toBe(false);
        // B's push is the gist again, sealed, and numbered above A's write
        expect(gist.state.manifest.encrypted).toBeTruthy();
        expect(gist.state.manifest.syncSeq).toBeGreaterThan(bSeq());
        expect(gist.state.payload).not.toContain('a-sample');
        // ...and A's next tick does not write in the clear over it again
        const writes = gist.writes;
        expect(await as(a, auto.push)).toEqual({ ok: false, reason: 'passphrase' });
        expect(gist.writes).toBe(writes);
        expect(gist.state.manifest.encrypted).toBeTruthy();
        expect(gist.state.manifest.encrypted).toBeTruthy();

        // B's own push, put back under a higher counter, is nothing for B to apply
        b.latches = 0;
        toasts.length = 0;
        expect((await as(b, auto.pull)).reason).toBe('in-step');
        expect(b.latches).toBe(0);
        expect(toasts).toHaveLength(0);
    });

    test.each([
        ["a newer build's format", (payload) => ({ ...payload, formatVersion: 2 })],
        [
            'a store that is not a keyed object',
            (payload) => ({ ...payload, stores: { ...payload.stores, xpHistory: [] } }),
        ],
    ])('a write that replaced a push it cannot merge (%s) puts that push back', async (_label, reshape) => {
        const { a } = await syncedPair();
        a.db.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        // A lists the gist; another device's write in a shape this build cannot
        // merge lands before A writes
        let theirs;
        gist.betweenListAndWrite = async () => {
            const based = `v${gist.etag}`;
            gist.etag += 1;
            gist.state = {
                manifest: {
                    ...gist.state.manifest,
                    syncSeq: gist.state.manifest.syncSeq + 1,
                    exportedAt: new Date(BASE_MS + elapsed - 1000).toISOString(),
                    basedOn: based,
                    hash: undefined,
                    bytes: undefined,
                },
                payload: JSON.stringify(reshape(JSON.parse(gist.state.payload))),
            };
            theirs = gist.state.payload;
            gist.revisions.push({ version: `v${gist.etag}`, ...gist.state });
        };
        const result = await as(a, auto.push);
        const aWrite = gist.revisions.find((revision) => revision.payload.includes('a-sample'));

        expect(result).toEqual({ ok: false, reason: 'unmergeable' });
        // The other device's write is the gist again, numbered above A's
        expect(aWrite).toBeTruthy();
        expect(gist.state.payload).toBe(theirs);
        expect(gist.state.manifest.syncSeq).toBeGreaterThan(aWrite.manifest.syncSeq);

        // ...and A's next tick refuses rather than writing over it again
        const writes = gist.writes;
        expect(await as(a, auto.push)).toEqual({ ok: false, reason: 'unmergeable' });
        expect(gist.writes).toBe(writes);
        expect(gist.state.payload).toBe(theirs);
        // The hold names its cause once, not every interval, and a newer
        // format's says what to do about it
        const held = warn.mock.calls.filter(([line]) => String(line).includes('Automatic pushes are held'));
        expect(held).toHaveLength(1);
        if (JSON.parse(theirs).formatVersion !== 1) expect(held[0][1].message).toContain('Update Toolasha');
        // A's interval pull stands down on its unsent sample rather than applying it
        a.latches = 0;
        expect((await as(a, auto.pull)).reason).toBe('conflict');
        expect(a.latches).toBe(0);
        expect(a.db.xpHistory.testHistory_c1).toEqual(['s1', 'a-sample']);
        expect(gist.state.payload).toBe(theirs);
        warn.mockRestore();
        error.mockRestore();
    });

    test('a replacement at the same counter with an earlier stamp is not taken as old news', async () => {
        const { b } = await syncedPair();
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        // A listed before B wrote and wrote after it, at the same counter (it saw
        // the one under B's) and with the stamp its payload was built at, before
        // B's — as a write whose re-merge gave up leaves it
        const replacing = JSON.parse(gist.state.payload);
        // A never changed X: its old value, and no stamp for it
        replacing.stores.settings[MAP].X = { id: 'X', isTrue: false };
        delete replacing.stores.settings[STAMPS]?.X;
        replacing.stores.xpHistory.testHistory_c1 = ['s1', 'a-sample'];
        gist.etag += 1;
        gist.state = {
            manifest: {
                ...gist.state.manifest,
                exportedAt: new Date(Date.parse(gist.state.manifest.exportedAt) - 30_000).toISOString(),
                basedOn: gist.revisions.at(-2).version,
                hash: undefined,
                bytes: undefined,
            },
            payload: JSON.stringify(replacing),
        };
        gist.revisions.push({ version: `v${gist.etag}`, ...gist.state });

        b.latches = 0;
        expect((await as(b, auto.pull)).reason).toBe('conflict');
        expect(b.db.settings[MAP].X.isTrue).toBe(true);
        expect(b.latches).toBe(0);

        // B's next automatic push merges A's write rather than replacing it
        await as(b, async () => {
            b.db.xpHistory.testHistory_c1 = ['s1', 'b-sample'];
            expect((await auto.push()).ok).toBe(true);
        });
        expect(gistStores().xpHistory.testHistory_c1).toEqual(expect.arrayContaining(['a-sample', 'b-sample']));
        expect(gistStores().settings[MAP].X.isTrue).toBe(true);
    });

    test('a push nobody raced makes no extra request', async () => {
        const { a } = await syncedPair();
        // A setting, not a history: a moved history costs a download to merge with (see above)
        await as(a, () => changeSetting(a, 'X', true));
        const before = gist.requests;

        expect((await as(a, auto.push)).ok).toBe(true);

        // One listing and one write; no revision read, no second write
        expect(gist.requests - before).toBe(2);
        expect(gist.revisionReads).toHaveLength(0);
    });

    test('a device whose push was replaced unseen can tell, and does not fast-forward over it', async () => {
        const { b } = await syncedPair();
        // B writes X; then A, which listed before B wrote, writes without seeing it —
        // as a write that gave up re-merging would leave it
        await as(b, async () => {
            changeSetting(b, 'X', true);
            await auto.push();
        });
        const bVersion = b.db.settings.toolasha_sync_lastPushedVersion;
        expect(bVersion).toBeTruthy();
        const replacing = JSON.parse(gist.state.payload);
        replacing.stores.settings[MAP].X = { id: 'X', isTrue: false };
        gist.etag += 1;
        gist.state = {
            manifest: {
                ...gist.state.manifest,
                exportedAt: new Date(Date.now() + 60_000).toISOString(),
                syncSeq: gist.state.manifest.syncSeq + 1,
                basedOn: gist.revisions.at(-2).version,
                hash: undefined,
                bytes: undefined,
            },
            payload: JSON.stringify(replacing),
        };
        gist.revisions.push({ version: `v${gist.etag}`, ...gist.state });

        // B's interval pull must not take the gist as a clean fast-forward
        b.latches = 0;
        const pulled = await as(b, auto.pull);
        expect(pulled.reason).toBe('conflict');
        expect(b.db.settings[MAP].X.isTrue).toBe(true);
        expect(b.latches).toBe(0);
    });
});

describe("a Settings-only device's pull of a gist that holds histories", () => {
    test('owes the trimmed upload once, after which the next tick is unchanged', async () => {
        const { a } = await syncedPair();
        expect(gistStores().xpHistory.testHistory_c1).toEqual(['s1']);

        const c = makeDevice('C', { sync_scope: 'settings' });
        await as(c, auto.startup);

        const first = await as(c, auto.push);
        expect(first.ok).toBe(true);
        expect(first.skipped).toBeUndefined();
        expect(gistStores().xpHistory ?? {}).toEqual({});

        const second = await as(c, auto.push);
        expect(second.reason).toBe('unchanged');
        const writes = gist.writes;
        await as(c, auto.push);
        expect(gist.writes).toBe(writes);
        expect(a.db.xpHistory.testHistory_c1).toEqual(['s1']);
    });
});
