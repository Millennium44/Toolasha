/**
 * @vitest-environment happy-dom
 *
 * `_configCharId` — the latch every render and every save is checked against.
 *
 * The 3.23.0 self-sufficient reload nulls it for the duration of a load, and
 * two exits used to leave it null forever: the mid-load "a second switch
 * happened" bail, and a rejected `loadConfig`. While null, nothing renders and
 * nothing saves, so the panel shows NO tabs at all — data intact, but
 * indistinguishable from total loss — until the page is reloaded.
 *
 * `loadConfig` is the seam: the real one swallows storage failures by design
 * (that is what keeps a failed read from blanking the config), so a rejection
 * has to be injected here rather than provoked through storage.
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
vi.mock('../../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../inventory-sort.js', () => ({ default: { onModeChange: () => () => {} } }));
vi.mock('../inventory-badge-manager.js', () => ({
    default: { currentInventoryElem: null, renderAllBadges: vi.fn(async () => {}) },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({
    default: { snapshots: {}, onUpdate: vi.fn(), offUpdate: vi.fn(), updateEnhancementLevel: vi.fn() },
}));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
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

const KEY = (charId) => `${charId}_inventoryTabs_config`;

function store(charId, tabs) {
    storageMock.storeFor('settings').set(KEY(charId), {
        version: 1,
        selectedTabId: null,
        tabs: tabs.map((t) => ({ children: [], items: [], updatedAt: Date.now(), ...t })),
    });
}

let ui;

beforeEach(() => {
    storageMock.reset();
    storageMock.tryGet.mockClear();
    dm.listeners.clear();
    dm.charId = 'ironChar';
    loader.impl = null;
});

afterEach(() => {
    ui?.cleanup();
    ui = null;
    loader.impl = null;
});

async function startUI() {
    ui = new CustomTabsUI();
    await ui.initialize();
    return ui;
}

describe('the character latch after an interleaved double switch', () => {
    test('the newest reload completes and sets the latch, even when it finishes second', async () => {
        store('ironChar', [{ id: 'ic-tab', name: 'Ironman Gear' }]);
        store('mainChar', [{ id: 'mc-tab', name: 'Main Gear' }]);
        store('thirdChar', [{ id: 'tc-tab', name: 'Third Gear' }]);

        await startUI();
        expect(ui._configCharId).toBe('ironChar');

        const gates = new Map();
        loader.impl = async (charId) => {
            await new Promise((resolve) => gates.set(charId, resolve));
            return loader.real(charId);
        };

        // Switch to main, then to third before main's load has come back
        dm.charId = 'mainChar';
        const first = ui._reloadForCurrentCharacter();
        await Promise.resolve();
        dm.charId = 'thirdChar';
        const second = ui._reloadForCurrentCharacter();
        await Promise.resolve();

        // The newer load lands FIRST, the older one second — the ordering that
        // used to leave both reloads bailing and the latch null forever
        gates.get('thirdChar')();
        await new Promise((resolve) => setTimeout(resolve, 0));
        gates.get('mainChar')();
        await Promise.all([first, second]);
        await flushConfigWrites();

        expect(ui._configCharId).toBe('thirdChar');
        expect(ui._config.tabs.map((t) => t.id)).toEqual(['tc-tab']);
        expect(ui._isConfigForCurrentCharacter()).toBe(true);
    });
});

describe('the character latch after a failing load', () => {
    test('a rejecting load is retried, and the retry sets the latch', async () => {
        store('ironChar', [{ id: 'ic-tab', name: 'Ironman Gear' }]);
        store('mainChar', [{ id: 'mc-tab', name: 'Main Gear' }]);
        await startUI();

        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        let calls = 0;
        loader.impl = async (charId) => {
            calls += 1;
            if (calls === 1) throw new Error('IndexedDB went away');
            return loader.real(charId);
        };

        dm.charId = 'mainChar';
        await ui._reloadForCurrentCharacter();
        error.mockRestore();

        expect(calls).toBe(2);
        expect(ui._configCharId).toBe('mainChar');
        expect(ui._config.tabs.map((t) => t.id)).toEqual(['mc-tab']);
        expect(ui._isConfigForCurrentCharacter()).toBe(true);
    });

    test('a load that fails twice hands the latch back rather than leaving the panel dead', async () => {
        store('ironChar', [{ id: 'ic-tab', name: 'Ironman Gear' }]);
        await startUI();
        const held = ui._config;

        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        loader.impl = async () => {
            throw new Error('IndexedDB went away');
        };

        dm.charId = 'mainChar';
        await ui._reloadForCurrentCharacter();
        error.mockRestore();

        // Not null: the panel keeps drawing the config it has instead of nothing
        expect(ui._configCharId).toBe('ironChar');
        expect(ui._config).toBe(held);
    });

    test('the failure path does not steal the latch from a newer reload', async () => {
        store('ironChar', [{ id: 'ic-tab', name: 'Ironman Gear' }]);
        store('mainChar', [{ id: 'mc-tab', name: 'Main Gear' }]);
        store('thirdChar', [{ id: 'tc-tab', name: 'Third Gear' }]);
        await startUI();

        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        loader.impl = async (charId) => {
            if (charId === 'mainChar') throw new Error('IndexedDB went away');
            return loader.real(charId);
        };

        dm.charId = 'mainChar';
        const failing = ui._reloadForCurrentCharacter();
        await Promise.resolve();
        dm.charId = 'thirdChar';
        const winning = ui._reloadForCurrentCharacter();
        await Promise.all([failing, winning]);
        error.mockRestore();

        expect(ui._configCharId).toBe('thirdChar');
        expect(ui._config.tabs.map((t) => t.id)).toEqual(['tc-tab']);
    });
});
