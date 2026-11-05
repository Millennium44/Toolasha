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
const { default: syncManager } = await import('./sync-manager.js');

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
    syncManager.owedAfterReload = { push: false, pull: null };

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

describe('an automatic push asked for during the window', () => {
    test('stands down quietly and runs after the switch with the real settings', async () => {
        const window = await enterWindow();

        const outcome = await syncManager.push({ silent: true, unattended: true });
        expect(outcome).toMatchObject({ skipped: true, reason: 'settings-reloading' });
        expect(github.writes).toEqual([]);
        expect(toasts).toEqual([]);

        await leaveWindow(window);
        expect(scheduled).toHaveLength(1);
        await runOwed();

        expect(toasts).toEqual([]);
        expect(github.writes).toHaveLength(1);
        expect(github.writes[0].token).toBe('ghp_real');
        expect(github.writes[0].manifest.scope).toBe('everything');
        expect(github.writes[0].manifest.encrypted).toBeTruthy();
    });

    test('an automatic pull is owed too, and keeps its page-load flag', async () => {
        const window = await enterWindow();
        const pull = vi.spyOn(syncManager, '_doPull').mockResolvedValue({ ok: true });

        await syncManager.pull({ silent: true, startup: true });
        expect(pull).not.toHaveBeenCalled();

        await leaveWindow(window);
        await runOwed();
        expect(pull).toHaveBeenCalledTimes(1);
        expect(pull.mock.calls[0][2]).toBe(true);
    });

    test('sync turned off while it waits does not run', async () => {
        const window = await enterWindow();
        await syncManager.push({ silent: true, unattended: true });
        await leaveWindow(window);

        config.setSetting('sync_enabled', false);
        await runOwed();

        expect(github.writes).toEqual([]);
        expect(toasts).toEqual([]);
    });

    test('a sync still running when it comes due leaves it owed, not dropped', async () => {
        const window = await enterWindow();
        await syncManager.push({ silent: true, unattended: true });
        await leaveWindow(window);

        syncManager.busy = 999;
        syncManager.busySince = Date.now();
        await runOwed();
        expect(github.writes).toEqual([]);
        expect(scheduled).toHaveLength(1);

        syncManager.busy = false;
        await runOwed();
        expect(github.writes).toHaveLength(1);
    });
});

describe('two quick switches', () => {
    test('the settings read true throughout, and the push waits for the last one', async () => {
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
        expect(github.writes).toEqual([]);

        releaseCara();
        await second;
        await waitFor(() => config.settingsOwner === CARA, "Cara's settings to land");
        expect(dataManager.getCurrentCharacterId()).toBe(CARA);

        await runOwed();
        expect(github.writes).toHaveLength(1);
        expect(github.writes[0].manifest.scope).toBe('everything');
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

describe('a pressed push during the window', () => {
    test('runs on the real settings and does not claim sync is off', async () => {
        const window = await enterWindow();
        const outcome = await syncManager.push();

        expect(outcome.ok).toBe(true);
        expect(github.writes[0].token).toBe('ghp_real');
        expect(github.writes[0].manifest.scope).toBe('everything');
        expect(toasts.map(({ message }) => message).join()).not.toContain('turned off');

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

    test('the sync setup copy finds the entries it says it has', async () => {
        const window = await enterWindow();
        const { syncSetupEntries } = await import('./sync-setup-copy.js');
        expect(syncSetupEntries().sync_token?.value).toBe('ghp_real');
        await leaveWindow(window);
    });

    test('a change written during the window answers at once', async () => {
        const window = await enterWindow();
        config.setSettingValue('color_profit', '#abcdef');
        expect(config.getSettingValue('color_profit', 'fallback')).toBe('#abcdef');
        await leaveWindow(window);
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

        config.setSettingValue('sync_scope', 'settings');
        expect(config.getSetting('sync_scope', 'x')).toBe('settings');

        db.unreadable.clear();
        await config.loadSettings();
        expect(config._heldSharedSettings).toBeNull();
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

        // The next good load runs what the automatic one owed
        db.unreadable.clear();
        await config.loadSettings();
        await runOwed();
        expect(github.writes).toHaveLength(1);
        expect(github.writes[0].token).toBe('ghp_real');
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
