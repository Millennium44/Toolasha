/**
 * A sync pull of `<charId>_inventoryTabs_config` lands under a running page without latching the key, so the
 * panel's saves keep working before it has taken the pull in. Each save decides inside its own write: a stored copy
 * still the panel's baseline is written over whole, one that moved is folded under the panel's copy with the panel's
 * own deletions taken out of it first. Nothing the pull brought may be lost, and no deletion made here may come back.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    const mock = {
        stores,
        storeFor,
        /** While set, writes wait here (as storage's debounce holds them) until `release()` */
        hold: false,
        held: [],
        reset() {
            stores.clear();
            mock.hold = false;
            mock.held = [];
        },
        land({ key, value, store, fold }) {
            const map = storeFor(store);
            const stored = map.has(key) ? structuredClone(map.get(key)) : undefined;
            map.set(key, structuredClone(fold ? fold(stored, value) : value));
        },
        /** Land the oldest held write only; later ones keep waiting */
        releaseOne() {
            const write = mock.held.shift();
            if (!write) return false;
            mock.land(write);
            write.resolve(true);
            return true;
        },
        release() {
            mock.hold = false;
            const waiting = mock.held;
            mock.held = [];
            for (const write of waiting) {
                mock.land(write);
                write.resolve(true);
            }
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
        // The fold rides with the value and runs against what is stored when the write lands, as the real one does
        set: vi.fn(async (key, value, store = 'settings', _immediate = false, options = {}) => {
            const write = { key, value: structuredClone(value), store, fold: options?.fold ?? null };
            if (mock.hold) return new Promise((resolve) => mock.held.push({ ...write, resolve }));
            mock.land(write);
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
    };
    return mock;
});

vi.mock('../../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1', getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

const {
    loadConfig,
    saveConfig,
    adoptConfigBaseline,
    flushConfigWrites,
    addTab,
    removeTab,
    moveTab,
    addItem,
    removeItem,
    _resetConfigRecords,
} = await import('./custom-tabs-data.js');
const { isLiveSafeKey } = await import('../../../utils/sync-merge-registry.js');

const KEY = 'char1_inventoryTabs_config';
const T0 = 1_700_000_000_000;

/** A tab as stored; `stamp: null` is a pre-3.22.0 tab with no `updatedAt` */
function tab(id, items = [], { stamp = T0, children = [] } = {}) {
    const out = { id, name: id.toUpperCase(), color: null, open: false, items, children };
    if (stamp !== null) out.updatedAt = stamp;
    return out;
}

const write = (config) => storageMock.storeFor('settings').set(KEY, structuredClone(config));
const stored = () => storageMock.storeFor('settings').get(KEY);
const ids = (config) => (config?.tabs || []).map((t) => t.id);
const itemsOf = (config, id) => (config?.tabs || []).find((t) => t.id === id)?.items;

/** The panel's start-up: load, then take what it read as the copy it holds */
async function panelLoads() {
    const config = await loadConfig('char1');
    adoptConfigBaseline('char1', config);
    return config;
}

/** A pull's write: the fold of the gist's copy into what is stored, landing at once */
function pullWrites(config) {
    write(config);
}

beforeEach(() => {
    storageMock.reset();
    _resetConfigRecords();
    vi.useRealTimers();
});

describe('the tab config is live-safe', () => {
    test('for every character key and the unscoped legacy key', () => {
        expect(isLiveSafeKey('settings', KEY)).toBe(true);
        expect(isLiveSafeKey('settings', 'inventoryTabs_config')).toBe(true);
        expect(isLiveSafeKey('settings', 'char1_bulkSell_lastTab')).toBe(false);
    });
});

describe('a pull the panel has not taken in yet', () => {
    test('a save in flight when the pull lands keeps both the pulled tab and the edit', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a')] });
        const held = await panelLoads();
        storageMock.hold = true;

        const edited = addTab(held, null, 'Mine').config;
        const saving = saveConfig('char1', edited);
        await Promise.resolve();
        // The pull lands while the write is held in storage's queue
        pullWrites({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b')] });
        await vi.waitFor(() => expect(storageMock.held.length).toBe(1));
        storageMock.release();
        await saving;
        await flushConfigWrites();

        expect(ids(stored())).toEqual(['a', 'b', edited.tabs[1].id]);
    });

    test('an edit right after the pull keeps the pulled tab and the pulled item', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a', ['/items/x'])] });
        const held = await panelLoads();
        pullWrites({
            version: 1,
            selectedTabId: null,
            tabs: [tab('a', ['/items/x', '/items/pulled'], { stamp: T0 + 10 }), tab('b')],
        });

        await saveConfig('char1', addItem(held, 'a', '/items/mine'));
        await flushConfigWrites();

        expect(ids(stored())).toEqual(['a', 'b']);
        expect([...itemsOf(stored(), 'a')].sort()).toEqual(['/items/mine', '/items/pulled', '/items/x']);
    });

    test('a deletion here stays deleted though the pull still carries it, unstamped tab and item included', async () => {
        write({
            version: 1,
            selectedTabId: null,
            tabs: [tab('a', ['/items/x', '/items/y'], { stamp: null }), tab('d', [], { stamp: null })],
        });
        const held = await panelLoads();
        // The gist's copy is this device's old one plus a tab from another device
        pullWrites({
            version: 1,
            selectedTabId: null,
            tabs: [tab('a', ['/items/x', '/items/y'], { stamp: null }), tab('d', [], { stamp: null }), tab('b')],
        });

        const edited = removeItem(removeTab(held, 'd'), 'a', '/items/y');
        await saveConfig('char1', edited);
        await flushConfigWrites();

        expect(ids(stored())).toEqual(['a', 'b']);
        expect(itemsOf(stored(), 'a')).toEqual(['/items/x']);
        // A second save, still before the panel took the pull in, does not bring them back
        await saveConfig('char1', edited);
        await flushConfigWrites();
        expect(ids(stored())).toEqual(['a', 'b']);
        expect(itemsOf(stored(), 'a')).toEqual(['/items/x']);
    });

    test('deleting most tabs here is not refused by the mass-delete cap when a pull made the save fold', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b'), tab('c'), tab('d')] });
        const held = await panelLoads();
        pullWrites({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b'), tab('c'), tab('d'), tab('e')] });

        const edited = removeTab(removeTab(removeTab(held, 'a'), 'b'), 'c');
        await saveConfig('char1', edited);
        await flushConfigWrites();

        expect(ids(stored())).toEqual(['d', 'e']);
    });

    test('a tab the other device edited after this deletion is not dropped silently', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b')] });
        const held = await panelLoads();
        const later = Date.now() + 60_000;
        pullWrites({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b', ['/items/new'], { stamp: later })] });

        await saveConfig('char1', removeTab(held, 'b'));
        await flushConfigWrites();

        // The rename-or-add on the other device came after the deletion here: the newer edit survives
        expect(ids(stored())).toEqual(['a', 'b']);
        expect(itemsOf(stored(), 'b')).toEqual(['/items/new']);
    });

    test('a reorder here is not undone by the fold, and the pulled tab is appended', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b'), tab('c')] });
        const held = await panelLoads();
        pullWrites({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b'), tab('c'), tab('n')] });

        await saveConfig('char1', moveTab(held, 'c', 0));
        await flushConfigWrites();

        expect(ids(stored())).toEqual(['c', 'a', 'b', 'n']);
    });

    test('a reader that loads the config for itself does not make the panel’s next save drop the pull', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a')] });
        const held = await panelLoads();
        pullWrites({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b')] });
        // The bulk-sell assistant reads the same record, without the panel taking anything in
        await loadConfig('char1');

        await saveConfig('char1', addTab(held, null, 'Mine').config);
        await flushConfigWrites();

        expect(ids(stored())).toContain('b');
        expect(ids(stored())).toHaveLength(3);
    });
});

describe('once the panel has taken the pull in', () => {
    test('saves are written whole again, so a deletion of a pulled unstamped tab stands', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a')] });
        await panelLoads();
        pullWrites({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b', [], { stamp: null })] });
        const adopted = await panelLoads();
        expect(ids(adopted)).toEqual(['a', 'b']);

        await saveConfig('char1', removeTab(adopted, 'b'));
        await flushConfigWrites();

        expect(ids(stored())).toEqual(['a']);
    });

    test('with nothing moved, a save writes the panel’s copy exactly', async () => {
        write({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b')] });
        const held = await panelLoads();
        const edited = { ...moveTab(held, 'b', 0), selectedTabId: 'a' };

        await saveConfig('char1', edited);
        await flushConfigWrites();

        expect(stored()).toEqual(edited);
    });
});

describe('rapid edits with no pull, each write held as storage debounces it', () => {
    test('a burst that adds and then removes most of what it added lands exactly as the panel holds it', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0 + 1000);
        write({ version: 1, selectedTabId: null, tabs: [tab('a'), tab('b', [], { stamp: null })] });
        let held = await panelLoads();
        storageMock.hold = true;

        held = ['/items/1', '/items/2', '/items/3', '/items/4'].reduce((c, hrid) => addItem(c, 'a', hrid), held);
        const first = saveConfig('char1', held);
        // Its write is queued before the next edit is made
        await vi.waitFor(() => expect(storageMock.held.length).toBe(1));
        vi.setSystemTime(T0 + 2000);
        held = ['/items/1', '/items/2', '/items/3'].reduce((c, hrid) => removeItem(c, 'a', hrid), held);
        const second = saveConfig('char1', held);
        vi.setSystemTime(T0 + 3000);
        held = removeTab(held, 'b');
        const third = saveConfig('char1', held);

        // Land them one at a time, each folding against what the one before it wrote
        let landed = 0;
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!storageMock.releaseOne()) break;
            landed += 1;
        }
        await Promise.all([first, second, third]);
        expect(landed).toBeGreaterThan(1);
        await flushConfigWrites();

        expect(stored()).toEqual(held);
    });

    test('a burst that adds four tabs and then removes three is not refused by the mass-delete cap', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(T0 + 1000);
        write({ version: 1, selectedTabId: null, tabs: [tab('a')] });
        let held = await panelLoads();
        storageMock.hold = true;

        const added = [];
        for (const name of ['One', 'Two', 'Three', 'Four']) {
            const result = addTab(held, null, name);
            held = result.config;
            added.push(result.tabId);
        }
        const first = saveConfig('char1', held);
        // Its write is queued before the next edit is made
        await vi.waitFor(() => expect(storageMock.held.length).toBe(1));
        vi.setSystemTime(T0 + 2000);
        for (const id of added.slice(0, 3)) held = removeTab(held, id);
        const second = saveConfig('char1', held);

        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            if (!storageMock.releaseOne()) break;
        }
        await Promise.all([first, second]);
        await flushConfigWrites();

        expect(ids(stored())).toEqual(['a', added[3]]);
        expect(stored()).toEqual(held);
    });
});
