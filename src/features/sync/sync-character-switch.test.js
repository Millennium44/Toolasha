/**
 * Sync across an in-page character switch, through the real data-manager, feature-registry, config,
 * settings-storage, sync-manager and sync-payload. Only IndexedDB, the socket, GitHub and the toast are fakes.
 *
 * A switch empties config's settings map until the arriving character's load lands, and sync's settings
 * belong to the device, not the character. Worst failure first: a push or pull acting on a default it misread
 * (the "settings" scope for "everything", no passphrase), then a false "no token" toast. A skipped automatic
 * push that runs after the switch is mild.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const db = vi.hoisted(() => ({
    stores: new Map(),
    /** key -> promise a read of it waits on */
    gates: new Map(),
    /** Keys whose probe answers "could not be read" */
    unreadable: new Set(),
}));

vi.mock('../../core/storage.js', () => {
    const area = (name) => {
        if (!db.stores.has(name)) db.stores.set(name, new Map());
        return db.stores.get(name);
    };
    const gate = async (key) => {
        if (db.gates.has(key)) await db.gates.get(key);
    };
    return {
        default: {
            get: async (key, name = 'settings', fallback = null) => {
                await gate(key);
                return area(name).has(key) ? area(name).get(key) : fallback;
            },
            set: async (key, value, name = 'settings') => {
                area(name).set(key, value);
                return true;
            },
            setMany: async (entries, name = 'settings') => {
                for (const [key, value] of Object.entries(entries)) area(name).set(key, value);
                return true;
            },
            putAll: async (name, entries) => {
                for (const [key, value] of Object.entries(entries)) area(name).set(key, value);
                return Object.keys(entries).length;
            },
            delete: async (key, name = 'settings') => area(name).delete(key),
            getJSON: async (key, name = 'settings', fallback = null) => {
                await gate(key);
                return area(name).has(key) ? area(name).get(key) : fallback;
            },
            setJSON: async (key, value, name = 'settings') => {
                area(name).set(key, value);
                return true;
            },
            tryGet: async (key, name = 'settings') => {
                await gate(key);
                if (db.unreadable.has(key)) return null;
                return area(name).has(key)
                    ? { found: true, value: area(name).get(key) }
                    : { found: false, value: null };
            },
            parseJSON: (raw, _key, fallback) => raw ?? fallback,
            listStores: async () => ['settings'],
            getAll: async (name) => Object.fromEntries(area(name)),
            getAllKeys: async (name = 'settings') => [...area(name).keys()],
            tryGetAllKeys: async (name = 'settings') => [...area(name).keys()],
            flushAll: async () => {},
            isRestorePending: () => false,
        },
    };
});

const socket = vi.hoisted(() => ({ handlers: new Map() }));
vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, handler) => socket.handlers.set(event, handler),
        off: () => {},
        onSocketEvent: () => {},
        offSocketEvent: () => {},
    },
}));

vi.mock('../../utils/performance-monitor.js', () => ({
    default: { mark: () => {}, sinceBoot: () => 0, snapshot: () => {}, enabled: false },
}));

// Counted, passed through, and a place to act from inside a yield
const yields = vi.hoisted(() => ({ count: 0, onYield: null }));
vi.mock('../../utils/yield-to-browser.js', () => ({
    yieldToBrowser: () => {
        yields.count += 1;
        yields.onYield?.();
        return new Promise((resolve) => setTimeout(resolve, 0));
    },
}));

const toasts = vi.hoisted(() => []);
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.push({ message, ...options });
        return null;
    },
}));

vi.mock('../../utils/full-backup.js', () => ({
    tombstoneCompanionKey: () => null,
    importEverything: async () => ({}),
    stripExcludedKeys: (_storeName, entries) => entries,
}));

const github = vi.hoisted(() => ({ writes: [], reads: [] }));
vi.mock('./gist-client.js', async (importOriginal) => {
    const real = await importOriginal();
    const { GistError } = real;
    // The real client's refusal, which is where the false toast came from
    const refuseEmptyToken = (token) => {
        if (!token) throw new GistError('auth', 'No GitHub token is set. Add one in Settings → Cross-Device Sync.');
    };
    return {
        ...real,
        findSyncGist: async (token) => {
            refuseEmptyToken(token);
            return 'gist-1';
        },
        readSyncGist: async (token) => {
            refuseEmptyToken(token);
            github.reads.push({ token });
            return { notModified: true };
        },
        writeSyncGist: async (token, gistId, manifest, chunks) => {
            refuseEmptyToken(token);
            github.writes.push({ token, gistId, manifest, body: chunks.join('') });
            return { id: gistId, etag: 'etag', files: {}, syncSeq: manifest.syncSeq, version: 'v', intervening: [] };
        },
    };
});

const { default: storage } = await import('../../core/storage.js');
const { default: dataManager } = await import('../../core/data-manager.js');
const { default: featureRegistry } = await import('../../core/feature-registry.js');
const { default: config } = await import('../../core/config.js');
const { default: domObserver } = await import('../../core/dom-observer.js');
const { default: connectionState } = await import('../../core/connection-state.js');
const { default: syncManager } = await import('./sync-manager.js');
const { rememberPullSummary, lastPullSummary } = await import('./pull-summary.js');

const ALICE = 32030;
const BOB = 32031;
const CARA = 32032;

const settingsArea = () => db.stores.get('settings');

const entry = (value) => (typeof value === 'boolean' ? { isTrue: value } : { value });

function sharedMap({ token = 'ghp_real', scope = 'everything', passphrase = 'hunter2', enabled = true } = {}) {
    return {
        sync_enabled: entry(enabled),
        sync_token: entry(token),
        sync_scope: entry(scope),
        sync_passphrase: entry(passphrase),
        sync_auto: entry(false),
        color_profit: entry('#123456'),
        formatting_useKMBFormat: entry('full'),
    };
}

/** init_character_data as the game sends it, down to the fields data-manager reads */
const initCharacter = (id, name) => ({
    type: 'init_character_data',
    character: { id, name, gameMode: 'standard' },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
    characterHouseRoomMap: {},
    actionTypeDrinkSlotsMap: {},
});

/** Hold every read of a key until the returned function is called */
function holdReads(key) {
    let release;
    db.gates.set(
        key,
        new Promise((resolve) => {
            release = resolve;
        })
    );
    return () => {
        db.gates.delete(key);
        release();
    };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(condition, what) {
    for (let turn = 0; turn < 400; turn += 1) {
        if (condition()) return;
        await settle();
    }
    throw new Error(`Timed out waiting for ${what}`);
}

const mapEmpty = () => Object.keys(config.settingsMap).length === 0;

const send = (id, name) => socket.handlers.get('init_character_data')(initCharacter(id, name), {});

/** Run what the schedule owes at once rather than after the real few seconds */
let scheduled;

beforeEach(async () => {
    db.stores = new Map([['settings', new Map()]]);
    db.gates = new Map();
    db.unreadable = new Set();
    github.writes = [];
    github.reads = [];
    toasts.length = 0;

    const area = settingsArea();
    area.set('settings_shared_scope_v3', true);
    area.set('script_settingsMap_shared', sharedMap());
    area.set('toolasha_sync_gistId', 'gist-1');
    area.set('toolasha_sync_lastSyncedAt', '2026-11-01T00:00:00.000Z');

    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.lastCharacterSwitchTime = 0;
    dataManager.isCharacterSwitching = false;
    dataManager.eventListeners.clear();
    featureRegistry.replaceFeatures([]);
    featureRegistry.setupCharacterSwitchHandler();

    config.settingsMap = {};
    config.characterSettingsLoaded = false;
    config.settingsOwner = null;
    config._heldSharedSettings = null;
    config._sharedSettingsKnown = false;
    config._pendingWrites = [];
    config._pendingValues = Object.create(null);
    config.settingsLoadedCallbacks = [];

    syncManager.cleanup();
    syncManager.busy = false;
    syncManager.lastCancelledToken = 0;
    syncManager.startupPullOwed = false;
    syncManager.handoffPushed = false;

    await send(ALICE, 'Alice');
    await config.loadSettings();
    await syncManager.initialize();

    scheduled = [];
    vi.spyOn(syncManager.timers, 'scheduleTimeout').mockImplementation((fn) => {
        scheduled.push(fn);
        return scheduled.length;
    });
});

afterEach(async () => {
    for (const key of [...db.gates.keys()]) db.gates.delete(key);
    vi.restoreAllMocks();
    syncManager.cleanup();
    clearTimeout(config._reloadWatchdog);
    await settle();
});

/** Start a switch and stop it with the arriving character's settings still unread: the window */
async function enterWindow(id = BOB, name = 'Bob') {
    const release = holdReads(`script_settingsMap_${id}`);
    const switched = send(id, name);
    await waitFor(mapEmpty, 'the settings map to empty');
    return { release, switched };
}

async function leaveWindow({ release, switched }) {
    release();
    await switched;
    await waitFor(() => !mapEmpty(), 'the settings to load');
}

const runOwed = async () => {
    const owed = scheduled.splice(0);
    for (const fn of owed) await fn();
};

describe('a push already running when the switch empties the settings', () => {
    test('finishes with the real token, scope and passphrase, and says nothing', async () => {
        const releasePush = holdReads('toolasha_sync_mergeHeld');
        const push = syncManager.push({ silent: true, unattended: true });
        await settle();

        const window = await enterWindow();
        releasePush();
        const outcome = await push;

        expect(toasts).toEqual([]);
        expect(outcome.ok).toBe(true);
        expect(github.writes).toHaveLength(1);
        const [write] = github.writes;
        expect(write.token).toBe('ghp_real');
        expect(write.manifest.scope).toBe('everything');
        expect(write.manifest.encrypted).toBeTruthy();
        expect(write.body).not.toContain('script_settingsMap');

        await leaveWindow(window);
    });

    test('one that has to merge reads the token after a long wait, and gets the real one', async () => {
        // The history-diverged road: the token is read again in _mergeIntoUpload, well after the build
        settingsArea().set('toolasha_sync_unapplied', { since: 'x' });
        const releaseUnapplied = holdReads('toolasha_sync_unapplied');
        const push = syncManager.push({ silent: true, unattended: true });
        await waitFor(() => db.gates.has('toolasha_sync_unapplied'), 'the gate');
        await settle();

        const window = await enterWindow();
        releaseUnapplied();
        await push;

        expect(toasts).toEqual([]);
        expect(github.reads.every((read) => read.token === 'ghp_real')).toBe(true);
        expect(github.reads.length).toBeGreaterThan(0);

        await leaveWindow(window);
    });
});

describe('an automatic sync asked for during the window', () => {
    test('a push stands down quietly, is not run after the load, and the next interval carries it', async () => {
        const window = await enterWindow();

        const outcome = await syncManager.push({ silent: true, unattended: true });
        expect(outcome).toMatchObject({ skipped: true, reason: 'settings-reloading' });
        expect(github.writes).toEqual([]);
        expect(toasts).toEqual([]);

        await leaveWindow(window);
        expect(scheduled).toEqual([]);
        expect(github.writes).toEqual([]);

        // The next tick of the interval
        await syncManager.push({ silent: true, unattended: true });
        expect(toasts).toEqual([]);
        expect(github.writes).toHaveLength(1);
        expect(github.writes[0].token).toBe('ghp_real');
        expect(github.writes[0].manifest.scope).toBe('everything');
        expect(github.writes[0].manifest.encrypted).toBeTruthy();
    });

    test('a page-load pull is owed and keeps its flag; an interval pull waits for the next interval', async () => {
        settingsArea().set('script_settingsMap_shared', { ...sharedMap(), sync_auto: entry(true) });
        const window = await enterWindow();
        const pull = vi.spyOn(syncManager, '_doPull').mockResolvedValue({ ok: true });

        await syncManager.pull({ silent: true });
        await leaveWindow(window);
        expect(scheduled).toEqual([]);

        const second = await enterWindow(CARA, 'Cara');
        await syncManager.pull({ silent: true, startup: true });
        expect(pull).not.toHaveBeenCalled();
        await leaveWindow(second);

        await runOwed();
        expect(pull).toHaveBeenCalledTimes(1);
        expect(pull.mock.calls[0][2]).toBe(true);
    });

    test('automatic sync turned off while a pull is owed ends it', async () => {
        settingsArea().set('script_settingsMap_shared', { ...sharedMap(), sync_auto: entry(true) });
        const window = await enterWindow();
        const pull = vi.spyOn(syncManager, '_doPull').mockResolvedValue({ ok: true });
        await syncManager.pull({ silent: true, startup: true });
        await leaveWindow(window);

        config.setSetting('sync_auto', false);
        await runOwed();

        expect(pull).not.toHaveBeenCalled();
        expect(syncManager.startupPullOwed).toBe(false);
    });

    test('sync turned off while a pull is owed ends it', async () => {
        settingsArea().set('script_settingsMap_shared', { ...sharedMap(), sync_auto: entry(true) });
        const window = await enterWindow();
        const pull = vi.spyOn(syncManager, '_doPull').mockResolvedValue({ ok: true });
        await syncManager.pull({ silent: true, startup: true });
        await leaveWindow(window);

        config.setSetting('sync_enabled', false);
        await runOwed();

        expect(pull).not.toHaveBeenCalled();
        expect(toasts).toEqual([]);
    });

    test('a sync still running when the pull comes due leaves it owed, not dropped', async () => {
        settingsArea().set('script_settingsMap_shared', { ...sharedMap(), sync_auto: entry(true) });
        const window = await enterWindow();
        const pull = vi.spyOn(syncManager, '_doPull').mockResolvedValue({ ok: true });
        await syncManager.pull({ silent: true, startup: true });
        await leaveWindow(window);

        syncManager.busy = 999;
        syncManager.busySince = Date.now();
        await runOwed();
        expect(pull).not.toHaveBeenCalled();
        expect(scheduled).toHaveLength(1);

        syncManager.busy = false;
        await runOwed();
        expect(pull).toHaveBeenCalledTimes(1);
    });

    test('what is owed survives a teardown and re-initialise, should sync ever be stopped by the switch', async () => {
        settingsArea().set('script_settingsMap_shared', { ...sharedMap(), sync_auto: entry(true) });
        const window = await enterWindow();
        const pull = vi.spyOn(syncManager, '_doPull').mockResolvedValue({ ok: true });
        await syncManager.pull({ silent: true, startup: true });
        syncManager.cleanup();
        await leaveWindow(window);
        expect(scheduled).toEqual([]);

        await syncManager.initialize();
        expect(syncManager.startupPullOwed).toBe(true);
        expect(syncManager.owedTimer).not.toBeNull();
        await runOwed();
        expect(pull).toHaveBeenCalled();
    });
});

describe('a switch landing during a yield', () => {
    test('the push finishes on the real settings, and nothing reads a default', async () => {
        for (let index = 0; index < 200; index += 1)
            settingsArea().set(`script_settingsMap_${90000 + index}`, { itemTooltip_prices: { isTrue: false } });
        let now = 0;
        const clock = vi.spyOn(performance, 'now').mockImplementation(() => (now += 1));
        let release = null;
        let switched = null;
        yields.onYield = () => {
            yields.onYield = null;
            release = holdReads(`script_settingsMap_${BOB}`);
            switched = send(BOB, 'Bob');
        };
        try {
            yields.count = 0;
            await syncManager.push({ silent: true, unattended: true });

            expect(yields.count).toBeGreaterThan(0);
            expect(release).not.toBeNull();
            expect(toasts).toEqual([]);
            expect(github.writes).toHaveLength(1);
            expect(github.writes[0].token).toBe('ghp_real');
            expect(github.writes[0].manifest.scope).toBe('everything');
            expect(github.writes[0].manifest.encrypted).toBeTruthy();
        } finally {
            yields.onYield = null;
            clock.mockRestore();
            release?.();
            await switched;
        }
    });
});

describe('two quick switches', () => {
    test('the settings read true throughout, and no push starts', async () => {
        const first = await enterWindow(BOB, 'Bob');
        await syncManager.push({ silent: true, unattended: true });
        expect(config.getSetting('sync_scope', 'settings')).toBe('everything');

        const releaseCara = holdReads(`script_settingsMap_${CARA}`);
        const second = send(CARA, 'Cara');
        first.release();
        await first.switched;

        expect(config.getSetting('sync_token', '')).toBe('ghp_real');
        expect(config.getSetting('sync_scope', 'settings')).toBe('everything');
        expect(config.getSetting('sync_passphrase', '')).toBe('hunter2');

        releaseCara();
        await second;
        await waitFor(() => config.settingsOwner === CARA, "Cara's settings to land");
        expect(dataManager.getCurrentCharacterId()).toBe(CARA);

        expect(scheduled).toEqual([]);
        expect(github.writes).toEqual([]);
        expect(toasts).toEqual([]);
    });
});

describe('a token that really is missing', () => {
    beforeEach(async () => {
        settingsArea().set('script_settingsMap_shared', sharedMap({ token: '' }));
        await config.loadSettings();
    });

    test('a pressed push still says so', async () => {
        const outcome = await syncManager.push();
        expect(outcome.reason).toBe('no-token');
        expect(toasts.map(({ message }) => message).join()).toContain('Add a GitHub token');
    });

    test('and says so during the window too', async () => {
        const window = await enterWindow();
        const outcome = await syncManager.push();
        expect(outcome.reason).toBe('no-token');
        expect(toasts.map(({ message }) => message).join()).toContain('Add a GitHub token');
        await leaveWindow(window);
    });

    test('an automatic push stays quiet', async () => {
        const outcome = await syncManager.push({ silent: true, unattended: true });
        expect(outcome.reason).toBe('no-token');
        expect(toasts).toEqual([]);
    });
});

describe('a pressed sync during the window', () => {
    test('a push is told to try again, and does not claim sync is off', async () => {
        const window = await enterWindow();
        const outcome = await syncManager.push();

        expect(outcome.reason).toBe('settings-reloading');
        expect(github.writes).toEqual([]);
        const said = toasts.map(({ message }) => message).join();
        expect(said).toContain('Switching characters');
        expect(said).not.toContain('turned off');

        await leaveWindow(window);
    });

    test('a pull never reaches its folds', async () => {
        const window = await enterWindow();
        const pull = vi.spyOn(syncManager, '_doPull').mockResolvedValue({ ok: true });

        const outcome = await syncManager.pull();

        expect(pull).not.toHaveBeenCalled();
        expect(outcome.reason).toBe('settings-reloading');
        expect(toasts[0].message).toContain('Switching characters');
        await leaveWindow(window);

        await syncManager.pull();
        expect(pull).toHaveBeenCalledTimes(1);
    });
});

describe('a fold that runs in the window', () => {
    test("a cap read as its default does not trim this device's room logs", async () => {
        await import('../combat/labyrinth-room-logs.js');
        const { mergeForKey } = await import('../../utils/sync-merge-registry.js');
        settingsArea().set(`script_settingsMap_${ALICE}`, { labyrinthRoomLogSize: { value: 500 } });
        await config.loadSettings();
        const rooms = Array.from({ length: 200 }, (_, index) => ({
            startedAt: 1_000_000 + index * 60_000,
            endedAt: 1_000_000 + index * 60_000 + 30_000,
            runKey: `run${index}`,
            roomKey: `room${index}`,
        }));
        const fold = mergeForKey('settings', 'labyrinthRoomLogs');

        const window = await enterWindow();
        const folded = fold.foldPull({ sessions: rooms }, { sessions: rooms.slice(0, 1) }, { download: {} });
        expect(folded.sessions).toHaveLength(200);
        await leaveWindow(window);
    });
});

describe('the device-wide settings across the window', () => {
    test('colors, formatting and sync keep their values; a per-character setting does not carry over', async () => {
        settingsArea().set(`script_settingsMap_${ALICE}`, { itemTooltip_prices: { isTrue: false } });
        await config.loadSettings();
        expect(config.getSetting('itemTooltip_prices')).toBe(false);

        const window = await enterWindow();

        expect(config.getSettingValue('color_profit', 'fallback')).toBe('#123456');
        expect(config.getSetting('color_profit')).toBe('#123456');
        expect(config.getSettingValue('formatting_useKMBFormat', 'fallback')).toBe('full');
        expect(config.getSetting('sync_enabled', false)).toBe(true);
        config.applyColorSettings();
        expect(config.COLOR_PROFIT).toBe('#123456');
        // Belongs to the departing character, so it is not what the arriving one should read
        expect(config.getSetting('itemTooltip_prices')).toBe(true);

        await leaveWindow(window);
    });

    test('a value changed in storage during the window, as a pull does, is what the load gives', async () => {
        const window = await enterWindow();
        settingsArea().set('script_settingsMap_shared', sharedMap({ scope: 'settings', token: 'ghp_new' }));
        expect(config.getSetting('sync_token', '')).toBe('ghp_real');

        await leaveWindow(window);

        expect(config._heldSharedSettings).toBeNull();
        expect(config.getSetting('sync_token', '')).toBe('ghp_new');
        expect(config.getSetting('sync_scope', 'x')).toBe('settings');
    });

    test('a hold is never written back: the setup copy refuses in the window, with a reason', async () => {
        const { copySyncSetupToOtherCharacters } = await import('./sync-setup-copy.js');
        const window = await enterWindow();
        // Another tab saves a newer token while this one holds the old
        settingsArea().set('script_settingsMap_shared', sharedMap({ token: 'ghp_newer' }));

        const outcome = await copySyncSetupToOtherCharacters();

        expect(outcome.ok).toBe(false);
        expect(outcome.message).toContain('still loading');
        expect(settingsArea().get('script_settingsMap_shared').sync_token.value).toBe('ghp_newer');

        const copied = await config.syncSettingsToAllCharacters([ALICE]);
        expect(copied.success).toBe(false);

        await leaveWindow(window);
        expect(config.getSetting('sync_token', '')).toBe('ghp_newer');
    });

    test('Reset in the window clears the settings, and the hold cannot bring them back', async () => {
        const window = await enterWindow();
        await config.resetToDefaults();

        expect(config._heldSharedSettings).toBeNull();
        expect(config.getSetting('sync_token', 'x')).toBe('');
        expect(settingsArea().get('script_settingsMap_shared').sync_token.value).toBe('');

        await leaveWindow(window);
        expect(config.getSetting('sync_token', 'x')).toBe('');
    });

    test('a shared setting written before the pointer moves is kept; a per-character one still is not', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        dataManager.on('character_switching', () => {
            config.setSettingValue('sync_passphrase', 'new-pass');
            config.setSetting('itemTooltip_prices', false);
        });
        await send(BOB, 'Bob');
        await waitFor(() => config.settingsOwner === BOB, "Bob's settings");
        await settle();

        expect(config.getSetting('sync_passphrase', '')).toBe('new-pass');
        expect(settingsArea().get('script_settingsMap_shared').sync_passphrase.value).toBe('new-pass');
        expect(config.getSetting('itemTooltip_prices')).toBe(true);
        expect(warn.mock.calls.some(([line]) => String(line).includes("'itemTooltip_prices' dropped"))).toBe(true);
    });
});

describe('when the device-wide map cannot be read', () => {
    test('during a switch, what was read last goes on answering, and a later write is not shadowed', async () => {
        db.unreadable.add('script_settingsMap_shared');
        const window = await enterWindow();
        await leaveWindow(window);

        expect(config.getSetting('sync_token', '')).toBe('ghp_real');
        expect(config.getSetting('sync_scope', 'settings')).toBe('everything');
        expect(config.areSharedSettingsKnown()).toBe(true);
        // What a panel or a bulk snapshot reads agrees with what sync runs on
        expect(config.getSettingEntry('sync_token').value).toBe('ghp_real');

        config.setSettingValue('sync_scope', 'settings');
        expect(config.getSetting('sync_scope', 'x')).toBe('settings');

        db.unreadable.clear();
        await config.loadSettings();
        expect(config._heldSharedSettings).toBeNull();
    });

    test('an unrelated save leaves the shared map alone, and a shared save is refused, not destructive', async () => {
        db.unreadable.add('script_settingsMap_shared');
        const before = JSON.stringify(settingsArea().get('script_settingsMap_shared'));

        config.setSetting('itemTooltip_prices', false);
        config.setSettingValue('color_profit', '#abcdef');
        await settle();
        await settle();

        expect(JSON.stringify(settingsArea().get('script_settingsMap_shared'))).toBe(before);
        expect(settingsArea().get('script_settingsMap_shared').sync_passphrase.value).toBe('hunter2');
    });

    test('overlapping loads: the older one reading fine does not vouch for the newer one that could not', async () => {
        config.clearSettingsCache();
        settingsArea().set(`script_settingsMap_${ALICE}`, {
            sync_enabled: { isTrue: true },
            sync_token: { value: 'ghp_stale' },
            sync_scope: { value: 'settings' },
        });
        const realTryGet = storage.tryGet;
        let sharedReads = 0;
        let releaseOlder;
        const older = new Promise((resolve) => {
            releaseOlder = resolve;
        });
        let releaseNewer;
        const newer = new Promise((resolve) => {
            releaseNewer = resolve;
        });
        vi.spyOn(storage, 'tryGet').mockImplementation(async (key, name) => {
            if (key === 'script_settingsMap_shared') {
                sharedReads += 1;
                if (sharedReads === 1) {
                    await older;
                    return realTryGet(key, name);
                }
                return null;
            }
            // The live-prices read that follows each load, where the newer one waits for the older to pass
            if (key === 'Toolasha_marketAPI_livePrices') await newer;
            return realTryGet(key, name);
        });

        const first = config.loadSettings();
        await waitFor(() => sharedReads === 1, 'the older load');
        const second = config.loadSettings();
        await waitFor(() => sharedReads === 2, 'the newer load');
        releaseOlder();
        await settle();
        await settle();
        releaseNewer();
        await Promise.all([first, second]);

        expect(config.getSetting('sync_scope', 'x')).toBe('everything');
        expect(config.getSetting('sync_token', '')).toBe('ghp_real');
        expect(config.isHoldingSharedSettings()).toBe(true);
    });

    test('with nothing read before, sync does not run on a stale per-character copy', async () => {
        config._sharedSettingsKnown = false;
        config._heldSharedSettings = null;
        db.unreadable.add('script_settingsMap_shared');
        // An old build's token and no passphrase, left in the character's own map
        settingsArea().set(`script_settingsMap_${ALICE}`, {
            sync_enabled: { isTrue: true },
            sync_token: { value: 'ghp_stale' },
            sync_scope: { value: 'settings' },
        });
        await config.loadSettings();
        expect(config.areSharedSettingsKnown()).toBe(false);

        const automatic = await syncManager.push({ silent: true, unattended: true });
        expect(automatic.skipped).toBe(true);
        expect(github.writes).toEqual([]);
        expect(toasts).toEqual([]);

        const pressed = await syncManager.push();
        expect(pressed.reason).toBe('settings-unread');
        expect(toasts[0].message).toContain('could not be read');
        expect(toasts[0].message).not.toContain('token');
        expect(github.writes).toEqual([]);

        // The next good load, and the next interval carries it
        db.unreadable.clear();
        await config.loadSettings();
        await syncManager.push({ silent: true, unattended: true });
        expect(github.writes).toHaveLength(1);
        expect(github.writes[0].token).toBe('ghp_real');
    });
});

describe('the connection banner', () => {
    let banner;
    let fire;

    /** Start the watcher with the banner's observer in the test's hands */
    async function watch() {
        settingsArea().set('script_settingsMap_shared', { ...sharedMap(), sync_onSwitch: entry(true) });
        await config.loadSettings();
        banner = false;
        vi.stubGlobal('document', { querySelector: () => (banner ? {} : null) });
        vi.stubGlobal('location', { pathname: '/game', search: `?characterId=${ALICE}` });
        vi.spyOn(domObserver, 'onClass').mockImplementation((_name, _className, callback) => {
            fire = callback;
            return () => {};
        });
        syncManager.handoffUnregister?.();
        syncManager._watchHandoff();
    }

    /** The game's takeover: banner up, this socket closed, nothing reopening */
    function takeover() {
        connectionState.setDisconnected('socket_close', { code: 1005, wasClean: true }, null);
        banner = true;
        fire();
    }

    afterEach(() => {
        vi.unstubAllGlobals();
        connectionState.state = 'connected';
    });

    test('a takeover pushes, once, without waiting on anything but its settle', async () => {
        await watch();
        const push = vi.spyOn(syncManager, 'push').mockResolvedValue({ ok: true });
        takeover();
        fire();

        expect(push).not.toHaveBeenCalled();
        expect(scheduled).toHaveLength(1);
        await runOwed();

        expect(push).toHaveBeenCalledTimes(1);
        expect(push).toHaveBeenCalledWith({ silent: true, unattended: true });
    });

    test.each([
        [
            'the URL already names the next character',
            () => vi.stubGlobal('location', { pathname: '/game', search: `?characterId=${BOB}` }),
        ],
        ['the character select page', () => vi.stubGlobal('location', { pathname: '/characterSelect', search: '' })],
        ['a new socket opening', () => connectionState.updateState('reconnecting', { reason: 'socket_open' })],
    ])('on a switch (%s) it starts no push, and a banner that goes away owes nothing', async (_name, arrange) => {
        await watch();
        const push = vi.spyOn(syncManager, 'push').mockResolvedValue({ ok: true });
        banner = true;
        arrange();
        fire();

        await runOwed();
        expect(push).not.toHaveBeenCalled();
        expect(scheduled).toHaveLength(1);

        banner = false;
        await runOwed();
        expect(push).not.toHaveBeenCalled();
        expect(scheduled).toEqual([]);
    });

    test('through the window it holds off, and a takeover still there afterwards still pushes', async () => {
        await watch();
        const push = vi.spyOn(syncManager, 'push').mockResolvedValue({ ok: true });
        const window = await enterWindow();
        takeover();

        await runOwed();
        expect(push).not.toHaveBeenCalled();
        expect(scheduled).toHaveLength(1);

        await leaveWindow(window);
        vi.stubGlobal('location', { pathname: '/game', search: `?characterId=${BOB}` });
        connectionState.setDisconnected('socket_close', { code: 1005, wasClean: true }, null);
        await runOwed();

        expect(push).toHaveBeenCalledTimes(1);
    });

    test('the setting turned off before it decides stops it', async () => {
        await watch();
        const push = vi.spyOn(syncManager, 'push').mockResolvedValue({ ok: true });
        takeover();
        config.setSetting('sync_onSwitch', false);
        await runOwed();
        expect(push).not.toHaveBeenCalled();
    });

    test('it gives up on a banner that never settles rather than look for ever', async () => {
        await watch();
        const push = vi.spyOn(syncManager, 'push').mockResolvedValue({ ok: true });
        banner = true;
        vi.stubGlobal('location', { pathname: '/characterSelect', search: '' });
        fire();
        for (let look = 0; look < 30 && scheduled.length; look += 1) await runOwed();
        expect(scheduled).toEqual([]);
        expect(push).not.toHaveBeenCalled();
    });
});

describe('with sync off', () => {
    test('no schedule, no build and no owed run, on a switch or after it', async () => {
        syncManager.cleanup();
        settingsArea().set('script_settingsMap_shared', sharedMap({ enabled: false, token: '' }));
        await config.loadSettings();
        const getAll = vi.spyOn(storage, 'getAll');
        await syncManager.initialize();

        const window = await enterWindow();
        await leaveWindow(window);
        await settle();

        expect(scheduled).toEqual([]);
        expect(getAll).not.toHaveBeenCalled();
        expect(github.writes).toEqual([]);
    });
});

describe('the last pull summary across a switch', () => {
    // The manager is never torn down on a switch, so the arriving character's settings load is what clears it
    const summary = { at: 'alice-pull' };

    test('a switch to another character clears it', async () => {
        rememberPullSummary(summary);
        const window = await enterWindow();
        await leaveWindow(window);
        expect(lastPullSummary()).toBeNull();
    });

    test('a settings reload of the same character keeps it', async () => {
        rememberPullSummary(summary);
        await config.loadSettings();
        expect(lastPullSummary()).toBe(summary);
    });

    test('a quick switch back clears the one recorded on the other character', async () => {
        const first = await enterWindow();
        await leaveWindow(first);
        const bobs = { at: 'bob-pull' };
        rememberPullSummary(bobs);
        const back = await enterWindow(ALICE, 'Alice');
        await leaveWindow(back);
        expect(lastPullSummary()).toBeNull();
    });

    test('a pull finishing inside the switch window is cleared by the arriving load', async () => {
        const window = await enterWindow();
        rememberPullSummary(summary);
        await leaveWindow(window);
        expect(lastPullSummary()).toBeNull();
    });

    test('a pull finishing after the arriving load keeps its summary there', async () => {
        const window = await enterWindow();
        await leaveWindow(window);
        rememberPullSummary(summary);
        await settle();
        expect(lastPullSummary()).toBe(summary);
    });

    test('with sync off it is still cleared', async () => {
        syncManager.cleanup();
        settingsArea().set('script_settingsMap_shared', sharedMap({ enabled: false, token: '' }));
        await config.loadSettings();
        await syncManager.initialize();
        rememberPullSummary(summary);
        const window = await enterWindow();
        await leaveWindow(window);
        expect(lastPullSummary()).toBeNull();
    });
});
