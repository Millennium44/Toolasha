/**
 * @vitest-environment happy-dom
 *
 * Cross-character-switch contamination of the custom inventory tabs.
 *
 * The data manager skips `character_switching`, `character_switched` and with
 * them the whole feature disable()/initialize() cycle when two switches arrive
 * inside its rapid-switch window. The tabs UI loads `this._config` once in
 * `initialize()` but used to read `getCurrentCharacterId()` fresh on every
 * `_save()`, so after such a switch it wrote the DEPARTED character's tabs under
 * the ARRIVED character's key — where `saveConfig` folds them into what is
 * stored, unioning one character's tabs into the other's list and letting a
 * tombstone written by one delete a same-id tab (Export/Import legitimately
 * shares ids across characters) the other still has.
 *
 * The switch is simulated the way `isRapidSwitch` leaves it: the mock's current
 * character id changes and NO lifecycle event is emitted.
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
        reset() {
            stores.clear();
        },
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

/** The bits of the data manager the tabs UI actually touches, plus a tiny emitter */
const dm = vi.hoisted(() => {
    const listeners = new Map();
    return {
        charId: null,
        characterName: null,
        gameMode: 'standard',
        characterItems: [],
        getCurrentCharacterId: () => dm.charId,
        getCurrentCharacterName: () => dm.characterName,
        getCurrentCharacterGameMode: () => dm.gameMode,
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

const loadoutSnapshotMock = vi.hoisted(() => ({
    snapshots: {},
    onUpdate: vi.fn(),
    offUpdate: vi.fn(),
    updateEnhancementLevel: vi.fn(),
}));

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
    default: { currentInventoryElem: null, renderAllBadges: vi.fn(async () => {}) },
}));
vi.mock('../../combat/loadout-snapshot.js', () => ({ default: loadoutSnapshotMock }));
vi.mock('../../../utils/bundle-bridge.js', () => ({ loadoutSnapshot: () => null }));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async (id) => id,
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const { default: CustomTabsUI } = await import('./custom-tabs-ui.js');
const { addItem, removeTab, flushConfigWrites, saveConfig } = await import('./custom-tabs-data.js');

const KEY = (charId) => `${charId}_inventoryTabs_config`;

/** A stored config with the given tabs, stamped as freshly touched */
function config(tabs) {
    return {
        version: 1,
        selectedTabId: null,
        tabs: tabs.map((t) => ({ children: [], items: [], updatedAt: Date.now(), ...t })),
    };
}

/** Put a config in storage under a character's key, as a previous session would have */
function store(charId, cfg) {
    storageMock.storeFor('settings').set(KEY(charId), structuredClone(cfg));
}

/** Read back what is stored for a character */
function stored(charId) {
    return storageMock.storeFor('settings').get(KEY(charId));
}

/** Every tab id in a stored config, nested children included */
function tabIds(cfg) {
    const out = [];
    const walk = (tabs) => {
        for (const tab of tabs || []) {
            out.push(tab.id);
            walk(tab.children);
        }
    };
    walk(cfg?.tabs);
    return out;
}

let ui;

beforeEach(async () => {
    storageMock.reset();
    dm.listeners.clear();
    dm.charId = 'ironChar';
    dm.characterName = null;
    dm.gameMode = 'standard';
    dm.characterItems = [];
});

afterEach(() => {
    ui?.cleanup();
    ui = null;
});

/** Build and initialize a UI for whoever is current */
async function startUI() {
    ui = new CustomTabsUI();
    await ui.initialize();
    return ui;
}

describe('rapid character switch (no lifecycle events emitted)', () => {
    test('an edit after the switch does not write the departed character mixed into the arrival', async () => {
        store('ironChar', config([{ id: 'ic-tab', name: 'Ironman Gear' }]));
        store('mainChar', config([{ id: 'mc-tab', name: 'Main Gear' }]));

        await startUI();
        expect(tabIds(ui._config)).toEqual(['ic-tab']);

        // The rapid switch: current character changes, nothing is emitted, the
        // feature registry never tears the UI down.
        dm.charId = 'mainChar';

        // …and then any edit at all. This is the exact shape of every handler in
        // the UI: mutate `_config`, then `_save()`.
        ui._config = addItem(ui._config, 'ic-tab', '/items/cheese');
        await ui._save();
        await flushConfigWrites();

        // The arriving character's config is untouched — no ironman tab folded in.
        expect(tabIds(stored('mainChar'))).toEqual(['mc-tab']);
        // And the departing character's stored config was not rewritten either.
        expect(tabIds(stored('ironChar'))).toEqual(['ic-tab']);
    });

    test('the fold this prevents is real: saving the same config under the arrival contaminates it', async () => {
        // The pre-fix `_save()` verbatim — `saveConfig(getCurrentCharacterId(), this._config)`.
        // Without the guard this is what every post-switch edit did, and it is
        // why the reports read "every update reorganizes my tabs".
        store('mainChar', config([{ id: 'mc-tab', name: 'Main Gear' }]));
        const departed = config([{ id: 'ic-tab', name: 'Ironman Gear' }]);

        dm.charId = 'mainChar';
        await saveConfig(dm.getCurrentCharacterId(), departed);
        await flushConfigWrites();

        expect(tabIds(stored('mainChar')).sort()).toEqual(['ic-tab', 'mc-tab']);
    });

    test("a tombstone from the departed character cannot delete the arrival's same-id tab", async () => {
        // Export/Import is how two characters legitimately end up holding the
        // same tab id, which is what turned "reorganized" into "it deleted a
        // whole tab" for one reporter.
        const shared = { id: 'shared-tab', name: 'Shared' };
        store('ironChar', config([shared, { id: 'ic-only', name: 'Ironman Only' }]));
        store('mainChar', config([shared, { id: 'mc-only', name: 'Main Only' }]));

        await startUI();

        // The ironman deletes the shared tab — a tombstone, correctly, for them.
        ui._config = removeTab(ui._config, 'shared-tab');

        dm.charId = 'mainChar';
        await ui._save();
        await flushConfigWrites();

        expect(tabIds(stored('mainChar')).sort()).toEqual(['mc-only', 'shared-tab']);
    });

    test('a deferred layout pass across the switch neither renders nor rewrites the wrong character', async () => {
        // A tab bound to a loadout, and a snapshot that has moved on from what
        // the binding holds — so the sync paths have something to change, and
        // would save it, if they ran.
        store(
            'ironChar',
            config([
                {
                    id: 'ic-tab',
                    name: 'Ironman Gear',
                    items: ['/items/sword'],
                    loadoutBindings: { Boss: ['/items/sword'] },
                },
            ])
        );
        store('mainChar', config([{ id: 'mc-tab', name: 'Main Gear' }]));
        loadoutSnapshotMock.snapshots = {
            s1: { name: 'Boss', equipment: [{ itemHrid: '/items/sword', enhancementLevel: 9 }] },
        };

        const invContainer = document.createElement('div');
        invContainer.className = 'Inventory_items__abc';
        document.body.appendChild(invContainer);

        await startUI();
        const before = structuredClone(stored('mainChar'));

        dm.charId = 'mainChar';
        // The arriving character's inventory is already in the data manager while
        // `_config` still holds the departing character's tabs — the window the
        // rAF-deferred `_applyLayout` and the binding syncs used to run inside.
        dm.characterItems = [{ itemHrid: '/items/sword', count: 1, enhancementLevel: 9 }];

        ui._isActive = true;
        await ui._applyLayout();
        ui._checkBindingEnhancements({ endCharacterItems: dm.characterItems });
        ui._onLoadoutSnapshotUpdate();
        await flushConfigWrites();

        expect(stored('mainChar')).toEqual(before);
        // And nothing was drawn against the mismatched pair.
        expect(invContainer.querySelector('.toolasha-ct-section-header')).toBeNull();
        expect(invContainer.classList.contains('toolasha-ct-active')).toBe(false);

        invContainer.remove();
        loadoutSnapshotMock.snapshots = {};
    });
});

describe('self-sufficient reload', () => {
    test('character_initialized reloads the arriving character without the feature registry', async () => {
        store('ironChar', config([{ id: 'ic-tab', name: 'Ironman Gear' }]));
        store('mainChar', config([{ id: 'mc-tab', name: 'Main Gear' }]));

        await startUI();
        expect(ui._configCharId).toBe('ironChar');

        dm.charId = 'mainChar';
        // Emitted on every init, rapid switch included — initialize() is NOT called.
        await dm.emit('character_initialized', { _isCharacterSwitch: true });
        await flushConfigWrites();

        expect(ui._configCharId).toBe('mainChar');
        expect(tabIds(ui._config)).toEqual(['mc-tab']);

        // And saves work again, against the right character.
        ui._config = addItem(ui._config, 'mc-tab', '/items/cheese');
        await ui._save();
        await flushConfigWrites();

        expect(tabIds(stored('mainChar'))).toEqual(['mc-tab']);
        expect(tabIds(stored('ironChar'))).toEqual(['ic-tab']);
        expect(stored('mainChar').tabs[0].items).toContain('/items/cheese');
    });

    test('the reload is a no-op when the character has not actually changed', async () => {
        store('ironChar', config([{ id: 'ic-tab', name: 'Ironman Gear' }]));
        await startUI();
        const held = ui._config;

        await dm.emit('character_initialized', { _isCharacterSwitch: false });

        expect(ui._config).toBe(held);
        expect(ui._configCharId).toBe('ironChar');
    });

    test('cleanup removes the listener', async () => {
        await startUI();
        ui.cleanup();
        expect(dm.listeners.get('character_initialized')?.size ?? 0).toBe(0);
        ui = null;
    });

    test('the loadout-binding cache is rebuilt for the arriving character', async () => {
        // `_boundBaseHrids` is baseHrid → Map<loadoutName, level>, derived from
        // `_config`'s loadoutBindings and rebuilt only when it is null. The reload
        // swaps `_config` out from under it, so a cache built for the departing
        // character kept deciding which items `_checkBindingEnhancements` even
        // looks at — and the arriving character's bindings, whose bases are not in
        // that cache, never synced again for the rest of the session.
        store(
            'ironChar',
            config([
                {
                    id: 'ic-tab',
                    name: 'Ironman Gear',
                    items: ['/items/sword+5'],
                    loadoutBindings: { Boss: ['/items/sword+5'] },
                },
            ])
        );
        store(
            'mainChar',
            config([
                {
                    id: 'mc-tab',
                    name: 'Main Gear',
                    items: ['/items/axe+1'],
                    loadoutBindings: { Boss: ['/items/axe+1'] },
                },
            ])
        );
        loadoutSnapshotMock.snapshots = {
            s1: { name: 'Boss', useExactEnhancement: false, equipment: [] },
        };

        await startUI();
        // Prime the cache the way an ordinary items_updated tick does, while the
        // ironman's config is the one in hand.
        dm.characterItems = [{ itemHrid: '/items/sword', enhancementLevel: 5, count: 1 }];
        ui._checkBindingEnhancements({ endCharacterItems: [{ itemHrid: '/items/sword' }] });

        dm.charId = 'mainChar';
        await dm.emit('character_initialized', { _isCharacterSwitch: true });
        expect(ui._configCharId).toBe('mainChar');

        // The main's axe has been enhanced past what its binding holds.
        dm.characterItems = [{ itemHrid: '/items/axe', enhancementLevel: 4, count: 1 }];
        ui._checkBindingEnhancements({ endCharacterItems: [{ itemHrid: '/items/axe' }] });
        await flushConfigWrites();

        expect(ui._config.tabs[0].loadoutBindings.Boss).toEqual(['/items/axe+4']);
        expect(ui._config.tabs[0].items).toEqual(['/items/axe+4']);

        loadoutSnapshotMock.snapshots = {};
    });
});

describe('Export / Import across characters', () => {
    test('an import re-ids every tab, so two characters never share one', async () => {
        store('ironChar', config([{ id: 'shared-tab', name: 'Shared', items: ['/items/cheese'] }]));
        store('mainChar', config([{ id: 'mc-tab', name: 'Main Gear' }]));

        await startUI();
        ui._exportLayout();
        const exported = JSON.stringify({ _toolasha: 'tabs-v1', ...ui._config });

        // Switch, properly this time, and import onto the second character
        dm.charId = 'mainChar';
        await dm.emit('character_initialized', { _isCharacterSwitch: true });

        await ui._handleImportFile(new File([exported], 'toolasha-tabs.json', { type: 'application/json' }));
        await flushConfigWrites();

        const imported = stored('mainChar').tabs.find((t) => t.name === 'Shared');
        expect(imported).toBeDefined();
        expect(imported.items).toContain('/items/cheese');
        // The whole cross-character shared-id problem, ended at the source
        expect(tabIds(stored('mainChar'))).not.toContain('shared-tab');
        expect(imported.updatedAt).toBeGreaterThan(0);

        // Editing it lands on the importing character only
        ui._config = addItem(ui._config, imported.id, '/items/sword');
        await ui._save();
        await flushConfigWrites();

        expect(stored('mainChar').tabs.find((t) => t.id === imported.id).items).toContain('/items/sword');
        expect(stored('ironChar').tabs.find((t) => t.id === 'shared-tab').items).not.toContain('/items/sword');
    });

    test('an exported file carries no tombstone map and no order stamp', async () => {
        store(
            'ironChar',
            config([
                { id: 'a', name: 'A' },
                { id: 'b', name: 'B' },
            ])
        );
        await startUI();
        ui._config = removeTab(ui._config, 'b');
        ui._config.orderUpdatedAt = Date.now();
        expect(ui._config.removed).toBeDefined();

        let payload = null;
        const originalBlob = globalThis.Blob;
        globalThis.Blob = class {
            constructor(parts) {
                payload = JSON.parse(parts[0]);
            }
        };
        globalThis.URL.createObjectURL = () => 'blob:test';
        globalThis.URL.revokeObjectURL = () => {};
        try {
            ui._exportLayout();
        } finally {
            globalThis.Blob = originalBlob;
        }

        expect(payload._toolasha).toBe('tabs-v1');
        expect(payload.removed).toBeUndefined();
        expect(payload.orderUpdatedAt).toBeUndefined();
        expect(payload.tabs.map((t) => t.id)).toEqual(['a']);
    });

    test('a file WITH a tombstone map and unstamped tabs survives the next load intact', async () => {
        store('mainChar', config([{ id: 'mc-tab', name: 'Main Gear' }]));
        dm.charId = 'mainChar';
        await startUI();

        // A file written by an older build: verbatim config, tombstones included
        const hostile = JSON.stringify({
            _toolasha: 'tabs-v1',
            version: 1,
            selectedTabId: 'ores',
            removed: { ores: Date.now(), gear: Date.now() },
            tabs: [
                { id: 'ores', name: 'Ores', items: ['/items/iron_ore'], children: [] },
                { id: 'gear', name: 'Gear', items: [], children: [] },
            ],
        });

        await ui._handleImportFile(new File([hostile], 'toolasha-tabs.json', { type: 'application/json' }));
        await flushConfigWrites();

        // The next page load — where the old code's imported tabs deleted themselves
        dm.charId = 'otherChar';
        await dm.emit('character_initialized', { _isCharacterSwitch: true });
        dm.charId = 'mainChar';
        await dm.emit('character_initialized', { _isCharacterSwitch: true });
        await flushConfigWrites();

        expect(ui._config.tabs.map((t) => t.name)).toEqual(['Ores', 'Gear']);
        expect(ui._config.removed).toBeUndefined();
    });
});

describe('export filename', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date(2026, 7, 27, 12, 0, 0));
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    test('carries the character, mode tag and date', async () => {
        dm.characterName = 'Millennium44';
        dm.gameMode = 'ironcow';
        await startUI();
        expect(ui._exportFileName()).toBe('toolasha-tabs-Millennium44-IC-2026-08-27.json');
    });

    test('standard mode reads MC, and an hrid-shaped mode still maps', async () => {
        dm.characterName = 'Steez';
        dm.gameMode = '/game_modes/standard';
        await startUI();
        expect(ui._exportFileName()).toBe('toolasha-tabs-Steez-MC-2026-08-27.json');
    });

    test('unknown halves are left off rather than guessed', async () => {
        dm.characterName = null;
        dm.gameMode = 'some_future_mode';
        await startUI();
        expect(ui._exportFileName()).toBe('toolasha-tabs-2026-08-27.json');
    });

    test('a name with filesystem-hostile characters is sanitized', async () => {
        dm.characterName = 'We/ird:Na*me';
        dm.gameMode = 'standard';
        await startUI();
        expect(ui._exportFileName()).toBe('toolasha-tabs-WeirdName-MC-2026-08-27.json');
    });
});
