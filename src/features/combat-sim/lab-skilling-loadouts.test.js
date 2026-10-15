/**
 * The Lab Sim's per-skill loadout assignments take a sync pull without a reload.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

let db = new Map();

vi.mock('../../core/storage.js', () => ({
    default: {
        listStores: () => Promise.resolve(Array.from(db.keys())),
        getAll: (storeName) => Promise.resolve(Object.fromEntries(db.get(storeName) || new Map())),
        beginRestore: vi.fn(() => Promise.resolve()),
        finishRestore: vi.fn(),
        endRestore: () => Promise.resolve(),
        putAll: (storeName, entries) => {
            const store = db.get(storeName) || new Map();
            for (const [key, value] of Object.entries(entries || {})) store.set(key, value);
            db.set(storeName, store);
            return Promise.resolve(Object.keys(entries || {}).length);
        },
    },
}));

const { mergeSkillingLoadouts } = await import('./lab-skilling-loadouts.js');
const { isLiveSafeKey, mergeForKey } = await import('../../utils/sync-merge-registry.js');
const { exportEverything, importEverything } = await import('../../utils/full-backup.js');
const storageMock = (await import('../../core/storage.js')).default;

describe('labSimSkillingLoadouts and the sync pull', () => {
    beforeEach(() => {
        db = new Map([['settings', new Map()]]);
        storageMock.finishRestore.mockClear();
    });

    test('is registered live-safe, scoped and bare alike', () => {
        expect(isLiveSafeKey('settings', 'labSimSkillingLoadouts_123')).toBe(true);
        expect(isLiveSafeKey('settings', 'labSimSkillingLoadouts')).toBe(true);
        expect(mergeForKey('settings', 'labSimSkillingLoadouts_123')?.label).toBe('Lab Sim skill loadouts');
    });

    test('a pull of it latches nothing, so no reload is advised', async () => {
        const payload = await exportEverything();
        payload.stores = { settings: { labSimSkillingLoadouts_123: { '/skills/woodcutting': 'Main WC' } } };

        const result = await importEverything(payload, { liveSafeMerge: true });

        expect(db.get('settings').get('labSimSkillingLoadouts_123')).toEqual({ '/skills/woodcutting': 'Main WC' });
        expect(result.latched).toBe(0);
        expect(storageMock.finishRestore).not.toHaveBeenCalled();
    });
});

describe('mergeSkillingLoadouts', () => {
    test('keeps skills only one side assigned and lets the incoming choice win a shared one', () => {
        const merged = mergeSkillingLoadouts(
            { '/skills/woodcutting': 'Old WC', '/skills/foraging': 'Forage' },
            { '/skills/woodcutting': 'New WC', '/skills/milking': 'Milk' }
        );
        expect(merged).toEqual({
            '/skills/woodcutting': 'New WC',
            '/skills/foraging': 'Forage',
            '/skills/milking': 'Milk',
        });
    });

    test('falls back to whichever side is a usable map', () => {
        const map = { '/skills/woodcutting': 'WC' };
        expect(mergeSkillingLoadouts(null, map)).toBe(map);
        expect(mergeSkillingLoadouts(map, null)).toBe(map);
        expect(mergeSkillingLoadouts(map, [])).toBe(map);
    });
});
