/**
 * A restored custom-tab config is stamped as changed now, so the removal record a hand deletion left in the gist
 * (it deletes every older copy of the ids it names, unstamped ones included) does not undo the restore.
 */

import { describe, test, expect, vi } from 'vitest';

vi.mock('../core/storage.js', () => ({
    default: {
        get: vi.fn(async (_key, _store, fallback = null) => fallback),
        tryGet: vi.fn(async () => ({ found: false, value: null })),
        set: vi.fn(async () => true),
        delete: vi.fn(async () => true),
        getAllKeys: vi.fn(async () => []),
    },
}));

const { isTabConfigKey, restampRestoredTabConfig } = await import('./restored-tab-config.js');
const { restampRestoredSettings } = await import('../features/sync/sync-payload.js');
const { removeTab } = await import('../features/inventory/custom-tabs/custom-tabs-data.js');
const { mergeForKey } = await import('./sync-merge-registry.js');

const KEY = 'char1_inventoryTabs_config';
const T0 = Date.now() - 24 * 60 * 60 * 1000;
const ids = (config) => (config?.tabs || []).map((t) => t.id);

/** A backup taken before the deletion: A unstamped with an unstamped child, B stamped */
const backupConfig = () => ({
    version: 1,
    selectedTabId: null,
    tabs: [
        {
            id: 'a',
            name: 'Gear',
            items: ['/items/sword'],
            children: [{ id: 'a-kid', name: 'Kid', items: [], children: [] }],
        },
        { id: 'b', name: 'Bars', items: [], children: [], updatedAt: T0 },
    ],
});

describe('restoring a backup of a tab deleted since', () => {
    test('the full-backup restore keeps it past the gist’s removal record', () => {
        // The deletion: the gist now carries a removal record for A and its child
        const gist = removeTab(backupConfig(), 'a');
        expect(ids(gist)).toEqual(['b']);

        const payload = { formatVersion: 1, stores: { settings: { [KEY]: backupConfig() } } };
        restampRestoredSettings(payload);
        const restored = payload.stores.settings[KEY];

        const registration = mergeForKey('settings', KEY);
        for (const folded of [
            registration.merge(structuredClone(gist), structuredClone(restored)),
            registration.merge(structuredClone(restored), structuredClone(gist)),
            registration.foldPull(structuredClone(restored), structuredClone(gist)),
        ]) {
            expect(ids(folded).sort()).toEqual(['a', 'b']);
            expect(folded.tabs.find((t) => t.id === 'a').children.map((t) => t.id)).toEqual(['a-kid']);
        }
    });

    test('without the restamp the record takes it again (what the restore used to do)', () => {
        const gist = removeTab(backupConfig(), 'a');
        const folded = mergeForKey('settings', KEY).foldPull(backupConfig(), gist);
        expect(ids(folded)).toEqual(['b']);
    });
});

describe('restampRestoredTabConfig', () => {
    test('stamps every tab, nested ones included, and leaves everything else alone', () => {
        const now = 1_800_000_000_000;
        const out = restampRestoredTabConfig(backupConfig(), now);
        expect(out.tabs.map((t) => t.updatedAt)).toEqual([now, now]);
        expect(out.tabs[0].children[0].updatedAt).toBe(now);
        expect(out.tabs[0].items).toEqual(['/items/sword']);
    });

    test('a device clock behind the backup never lowers a tab below a record it already outlived', () => {
        const now = 1_800_000_000_000;
        const config = {
            version: 1,
            tabs: [
                { id: 'kept', name: 'Kept', items: [], children: [], updatedAt: now + 60_000 },
                { id: 'old', name: 'Old', items: [], children: [], updatedAt: now - 90_000 },
            ],
            removed: { gone: now + 10_000 },
            clearedAll: { op1: { at: now + 30_000, ids: ['kept', 'old'], prior: [] } },
        };
        const out = restampRestoredTabConfig(config, now);
        // A newer own stamp is kept; everything else lands past the newest deletion the backup carries
        expect(out.tabs[0].updatedAt).toBe(now + 60_000);
        expect(out.tabs[1].updatedAt).toBe(now + 30_001);
        const folded = mergeForKey('settings', KEY).foldPull(out, config);
        expect(ids(folded)).toEqual(['kept', 'old']);
    });

    test('a JSON string comes back a string; anything else unchanged', () => {
        const now = 1_800_000_000_000;
        expect(JSON.parse(restampRestoredTabConfig(JSON.stringify(backupConfig()), now)).tabs[1].updatedAt).toBe(now);
        expect(restampRestoredTabConfig('not json', now)).toBe('not json');
        expect(restampRestoredTabConfig(null, now)).toBe(null);
        expect(restampRestoredTabConfig({ version: 1 }, now)).toEqual({ version: 1 });
    });

    test('names the character keys and the legacy key only', () => {
        expect(isTabConfigKey(KEY)).toBe(true);
        expect(isTabConfigKey('inventoryTabs_config')).toBe(true);
        expect(isTabConfigKey('char1_bulkSell_lastTab')).toBe(false);
        expect(isTabConfigKey('inventoryTabs_config_backup')).toBe(false);
    });
});
