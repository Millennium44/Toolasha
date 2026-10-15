/**
 * @vitest-environment happy-dom
 *
 * A sync pull of `<characterId>_inventoryTabs_config` replaces the panel's held config without a reload, redraws
 * only when it changed, waits out a drag, and a later save keeps the pulled tabs.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        reset: () => stores.clear(),
        get: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        tryGet: vi.fn(async (key, store = 'settings') => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
});

const dm = vi.hoisted(() => {
    const listeners = new Map();
    return {
        charId: null,
        characterItems: [],
        getCurrentCharacterId: () => dm.charId,
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => ({}),
        on: (event, fn) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event).add(fn);
        },
        off: (event, fn) => listeners.get(event)?.delete(fn),
        emit: async (event, data) => {
            for (const fn of listeners.get(event) || []) await fn(data);
        },
        listeners,
    };
});

/**
 * Swappable `loadConfig`, so a load can be made slow or made to reject.
 * `real` is the unmocked one, for a test that wants a genuine load behind a gate.
 */
const loader = vi.hoisted(() => ({ impl: null, real: null }));

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({ default: dm }));
vi.mock('../../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../../core/dom-observer.js', () => ({
    default: {
        onClass: () => () => {},
        // Mirrors the real DOMObserver.onReady in its already-attached steady state
        onReady: (name, callback) => {
            callback();
            return () => {};
        },
    },
}));
vi.mock('../inventory-sort.js', () => ({ default: { onModeChange: () => () => {} } }));
vi.mock('../inventory-badge-manager.js', () => ({
    default: { currentInventoryElem: null, onRepriced: () => () => {}, renderAllBadges: vi.fn(async () => {}) },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({
    default: { snapshots: {}, onUpdate: vi.fn(), offUpdate: vi.fn(), updateEnhancementLevel: vi.fn() },
}));
vi.mock('../../../utils/bundle-bridge.js', () => ({
    marketUndercutAlerts: () => null,
    guildMemberSkills: () => null,
    loadoutSnapshot: () => null,
}));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async (id) => id,
    requestAdoptionConsent: () => Promise.resolve(null),
}));
vi.mock('./custom-tabs-data.js', async (importOriginal) => {
    const actual = await importOriginal();
    loader.real = actual.loadConfig;
    return {
        ...actual,
        loadConfig: (...args) => (loader.impl ?? actual.loadConfig)(...args),
    };
});

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');
const { flushConfigWrites } = await import('./custom-tabs-data.js');
const { announceSyncPullApplied } = await import('../../../utils/sync-merge-registry.js');

const KEY = (charId) => `${charId}_inventoryTabs_config`;

function store(charId, tabs) {
    storageMock.storeFor('settings').set(KEY(charId), {
        version: 1,
        selectedTabId: null,
        tabs: tabs.map((t) => ({ children: [], items: [], updatedAt: Date.now(), ...t })),
    });
}

const pull = (charId) => announceSyncPullApplied({ settings: [KEY(charId)] });

let ui;

beforeEach(() => {
    storageMock.reset();
    dm.listeners.clear();
    dm.charId = 'ironChar';
    loader.impl = null;
});

afterEach(() => {
    ui?.cleanup();
    ui = null;
});

async function startUI() {
    ui = new CustomTabsUI();
    await ui.initialize();
    ui._isActive = true;
    ui._applyLayout = vi.fn(async () => {});
    ui._removeInjectedEls = vi.fn();
    return ui;
}

describe('a sync pull of the tab config', () => {
    test('replaces the held config and redraws', async () => {
        store('ironChar', [{ id: 'a', name: 'Old' }]);
        await startUI();
        store('ironChar', [
            { id: 'a', name: 'Old' },
            { id: 'b', name: 'Pulled' },
        ]);

        pull('ironChar');
        await vi.waitFor(() => expect(ui._config.tabs.map((t) => t.id)).toEqual(['a', 'b']));

        expect(ui._applyLayout).toHaveBeenCalledTimes(1);
    });

    test('does not redraw when the config did not change', async () => {
        store('ironChar', [{ id: 'a', name: 'Same' }]);
        await startUI();

        pull('ironChar');
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(ui._applyLayout).not.toHaveBeenCalled();
    });

    test('ignores a pull of another key or another character', async () => {
        store('ironChar', [{ id: 'a', name: 'Old' }]);
        await startUI();
        store('ironChar', [
            { id: 'a', name: 'Old' },
            { id: 'b', name: 'Pulled' },
        ]);

        announceSyncPullApplied({ settings: ['otherKey', KEY('mainChar')] });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(ui._config.tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('takes the config in at once but waits for a drag to end before redrawing', async () => {
        store('ironChar', [{ id: 'a', name: 'Old' }]);
        await startUI();
        ui._dragInProgress = true;
        store('ironChar', [
            { id: 'a', name: 'Old' },
            { id: 'b', name: 'Pulled' },
        ]);

        pull('ironChar');
        await vi.waitFor(() => expect(ui._config.tabs.length).toBe(2));
        expect(ui._applyLayout).not.toHaveBeenCalled();

        ui._dragInProgress = false;
        ui._flushPullRelayout();
        expect(ui._applyLayout).toHaveBeenCalledTimes(1);
    });

    test('a save after the pull keeps the pulled tabs', async () => {
        store('ironChar', [{ id: 'a', name: 'Old' }]);
        await startUI();
        store('ironChar', [
            { id: 'a', name: 'Old' },
            { id: 'b', name: 'Pulled' },
        ]);
        pull('ironChar');
        await vi.waitFor(() => expect(ui._config.tabs.length).toBe(2));

        await ui._save();
        await flushConfigWrites();

        const savedIds = storageMock
            .storeFor('settings')
            .get(KEY('ironChar'))
            .tabs.map((t) => t.id);
        expect(savedIds).toEqual(['a', 'b']);
    });

    test('a failed first read is retried and the retry adopts the pulled config', async () => {
        store('ironChar', [{ id: 'a', name: 'Old' }]);
        await startUI();
        store('ironChar', [
            { id: 'a', name: 'Old' },
            { id: 'b', name: 'Pulled' },
        ]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        // An unreadable store: the probe answers null, which `load()` reports as false
        storageMock.tryGet.mockImplementationOnce(async () => null);

        pull('ironChar');
        await vi.waitFor(() => expect(ui._config.tabs.map((t) => t.id)).toEqual(['a', 'b']), { timeout: 3000 });
        warn.mockRestore();

        expect(ui._applyLayout).toHaveBeenCalledTimes(1);
    });
});
