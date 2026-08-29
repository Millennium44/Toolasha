/**
 * Where feature teardown lands relative to the character pointer moving.
 *
 * Data-manager emits `character_switching` *before* `currentCharacterId` moves,
 * and awaits it, precisely so a feature's `disable()` can persist the departing
 * character's state under the departing character's key. Feature-registry is the
 * listener that runs those `disable()` calls — but it runs them on its own
 * serialized lifecycle chain, and if it does not hand that chain's promise back
 * to the emitter, the await has nothing to wait on. Data-manager then moves the
 * pointer and clears character state while the teardown is still queued, and
 * every `characterKey()` the teardown reaches writes under the *arriving*
 * character's id.
 *
 * These tests drive a real switch through the real data-manager and the real
 * feature-registry, with one fake feature whose `disable()` writes a scoped key,
 * and assert whose key it landed under.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

let webSocketHandlers = new Map();

vi.mock('./websocket.js', () => {
    webSocketHandlers = new Map();
    return {
        default: {
            on: vi.fn((event, handler) => {
                webSocketHandlers.set(event, handler);
            }),
            off: vi.fn(),
            onSocketEvent: vi.fn(),
            offSocketEvent: vi.fn(),
        },
    };
});

const storageMock = vi.hoisted(() => ({ data: new Map(), writes: [] }));

vi.mock('./storage.js', () => ({
    default: {
        get: vi.fn(async (key, storeName = 'settings', fallback = null) => {
            const k = `${storeName}::${key}`;
            return storageMock.data.has(k) ? storageMock.data.get(k) : fallback;
        }),
        set: vi.fn(async (key, value, storeName = 'settings') => {
            storageMock.data.set(`${storeName}::${key}`, value);
            storageMock.writes.push(key);
            return true;
        }),
        delete: vi.fn(async () => true),
        getJSON: vi.fn(async (_key, _storeName, fallback) => fallback),
        setJSON: vi.fn(async () => true),
        getAllKeys: vi.fn(async () => []),
        flushAll: vi.fn(async () => {}),
    },
}));

const configMock = vi.hoisted(() => ({ loadSettings: 0 }));

vi.mock('./config.js', () => ({
    default: {
        isFeatureEnabled: () => true,
        clearSettingsCache: vi.fn(),
        loadSettings: vi.fn(async () => {
            configMock.loadSettings += 1;
        }),
        applyColorSettings: vi.fn(),
    },
}));

vi.mock('../utils/performance-monitor.js', () => ({
    default: { mark: vi.fn(), sinceBoot: () => 0, snapshot: vi.fn(), enabled: false },
}));

const { default: dataManager } = await import('./data-manager.js');
const { default: featureRegistry } = await import('./feature-registry.js');
const { characterKey } = await import('../utils/character-key.js');
const storage = (await import('./storage.js')).default;

/** A minimal init_character_data payload. */
const initPayload = (id, name) => ({
    character: { id, name },
    characterSkills: [],
    characterItems: [],
    characterActions: [],
    characterQuests: [],
});

beforeEach(() => {
    storageMock.data = new Map();
    storageMock.writes = [];
    dataManager.currentCharacterId = null;
    dataManager.currentCharacterName = null;
    dataManager.lastCharacterSwitchTime = 0;
    dataManager.isCharacterSwitching = false;
    // Each test installs its own switch handler on the singleton; without this
    // the previous test's handler (and its lifecycle chain) is still listening.
    dataManager.eventListeners.clear();
    featureRegistry.replaceFeatures([]);
});

describe('teardown ordering against the character pointer', () => {
    test('a disable() that persists through characterKey() writes under the departing character', async () => {
        // The exact shape of the bug: the feature saves its session state on the
        // way out, expecting `characterKey()` to still name the character it was
        // running as. Read-modify-write is what a scoped persist actually looks
        // like (readScoped/writeScoped, or getMany then set), and the read is
        // the await that loses the race — disable() is *called* while the
        // pointer is still on the departing character, but it resumes after
        // data-manager has moved on, and `characterKey()` is evaluated on
        // resume. The departing character's session is then filed under the
        // arriving character's key, silently overwriting what was there.
        const disable = vi.fn(async () => {
            const previous = await storage.get(characterKey('sessionState'), 'settings', null);
            await storage.set(characterKey('sessionState'), previous ?? 'from-char-1', 'settings');
        });
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize: vi.fn(), disable }]);
        featureRegistry.setupCharacterSwitchHandler();

        const init = webSocketHandlers.get('init_character_data');
        await init(initPayload('char-1', 'One'));
        await init(initPayload('char-2', 'Two'));

        expect(disable).toHaveBeenCalledTimes(1);
        expect(storageMock.writes).toContain('sessionState_char-1');
        expect(storageMock.writes).not.toContain('sessionState_char-2');
        expect(storageMock.data.get('settings::sessionState_char-1')).toBe('from-char-1');
    });

    test('a teardown still running mid-switch sees the departing character id', async () => {
        // disable() also commonly reads live character data on the way out
        // (the last action queue, the equipped set). Data-manager nulls all of
        // it immediately after the awaited emit returns, so a teardown the emit
        // did not actually wait for reads nulls.
        let seenId = 'unread';
        const disable = vi.fn(async () => {
            // Two hops, the shape of "read my record, then read a second one" —
            // far inside the window the awaited emit is supposed to cover.
            await storage.get('a', 'settings', null);
            await storage.get('b', 'settings', null);
            seenId = dataManager.getCurrentCharacterId();
        });
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize: vi.fn(), disable }]);
        featureRegistry.setupCharacterSwitchHandler();

        const init = webSocketHandlers.get('init_character_data');
        await init(initPayload('char-1', 'One'));
        await init(initPayload('char-2', 'Two'));

        expect(seenId).toBe('char-1');
    });

    test('a rapid burst still coalesces: one teardown, one re-init, and the burst is not blocked behind it', async () => {
        // The regression risk in making the emit actually wait. The teardown
        // runs on a chain that a *superseded* re-initialization may already be
        // sitting in front of — and that re-init costs a settle delay plus a
        // hundred feature initializers. If the switch that overtook it had to
        // queue behind all that, the arriving character's data update would be
        // held up by work done for a character nobody is looking at any more.
        const disable = vi.fn(async () => {
            await storage.get('x', 'settings', null);
        });
        const initialize = vi.fn(async () => {});
        featureRegistry.replaceFeatures([{ key: 'x', name: 'X', initialize, disable }]);
        featureRegistry.setupCharacterSwitchHandler();

        const init = webSocketHandlers.get('init_character_data');
        await init(initPayload('char-1', 'One'));
        configMock.loadSettings = 0;
        // A real flush reaches IndexedDB and costs a macrotask, which is long
        // enough for the deferred `character_switched` for the *superseded*
        // character to reach the lifecycle chain ahead of the next teardown.
        // That is the arrangement in which making the emit wait could have made
        // the burst wait too.
        storage.flushAll.mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 0)));
        // Not awaited individually: two switches in flight at once, which is
        // what clicking through three characters produces.
        await Promise.all([init(initPayload('char-2', 'Two')), init(initPayload('char-3', 'Three'))]);

        expect(dataManager.getCurrentCharacterId()).toBe('char-3');
        // Let the deferred character_switched events and the settle delay run out
        await new Promise((resolve) => setTimeout(resolve, 120));

        expect(disable).toHaveBeenCalledTimes(1);
        expect(initialize).toHaveBeenCalledTimes(1);
        // And the superseded re-init did no work at all — not even the settings
        // reload, which is the half that would have sat in front of the next
        // teardown and, through it, in front of char-3's data update.
        expect(configMock.loadSettings).toBe(1);
    });
});
