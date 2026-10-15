/**
 * The Combat Sim and Lab Sim panels' remembered choices and results take a sync pull without a reload.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
        get: (key, storeName, fallback) => {
            const store = db.get(storeName);
            return Promise.resolve(store?.has(key) ? store.get(key) : fallback);
        },
    },
}));

vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_123`,
    readScoped: async () => null,
    writeScoped: async () => true,
}));

const { incomingWins, laterSavedAtWins, mergeFieldRecord, StoredValueMemo, pulledNames } =
    await import('./sim-sync-keys.js');
const { mergeLabComparison, LabComparisonStore } = await import('./lab-sim-comparison.js');
await import('./trigger-result-cache.js');
await import('./lab-skilling-loadouts.js');
const { mergeZoneSimRates } = await import('../../utils/all-zones-snapshot.js');
const { isLiveSafeKey } = await import('../../utils/sync-merge-registry.js');
const { exportEverything, importEverything } = await import('../../utils/full-backup.js');
const storageMock = (await import('../../core/storage.js')).default;

/** Every simulator key a pull may write, by store */
const KEYS = [
    // Lab Sim, per character
    ['settings', 'labSimUpgradeDimensions'],
    ['settings', 'labSimUpgradeScope'],
    ['settings', 'labSimUpgradeLevelSource'],
    ['settings', 'labSimSwapAuraOnly'],
    ['settings', 'labSimShrineCapToGuild'],
    ['settings', 'labSimUpgradeRoomLevels'],
    ['settings', 'labSimUpgradeTargetFloor'],
    ['settings', 'labSimUpgradeMode'],
    ['settings', 'labSimSkillingRoomLevels'],
    ['settings', 'labSimSkillingTargetClear'],
    ['settings', 'labSimSkillingTargetFloor'],
    ['settings', 'labSimTokenBuffLevels'],
    ['settings', 'labSimCheckedSwaps'],
    ['settings', 'labSimSkillingLoadouts'],
    ['settings', 'labSimComparisonRuns'],
    ['settings', 'labSimComparisonBaseline'],
    ['combatExport', 'labSimUpgradeResults-fullkit'],
    // Combat Sim
    ['settings', 'combatSimUpgradeModes'],
    ['settings', 'combatSimTriggerChoices'],
    ['settings', 'combatSimSwapAuraOnly'],
    ['settings', 'combatSimShrineCapToGuild'],
    ['settings', 'combatSimUpgradeColumns'],
    ['settings', 'combatSimTriggerLastResult'],
    ['settings', 'combatSimAllZonesMaxTierFood'],
    ['settings', 'combatSimAllZonesScoreScale'],
    ['settings', 'combatSimAllZonesIncludeDungeons'],
    ['settings', 'combatSimBestiaryPlanHours'],
    ['settings', 'combatSimBestiaryPlanMode'],
    ['settings', 'combatSimBestiaryPlanPoints'],
    ['settings', 'combatSimBestiaryPlanTotal'],
    ['settings', 'combatSimBestiaryPlanTolerance'],
    ['settings', 'simEditorLoadoutName'],
    ['combatExport', 'combatSimUpgradeResults'],
    ['combatExport', 'zoneSimRates'],
];

describe('every simulator key a pull writes is live-safe', () => {
    test.each(KEYS)('%s / %s, bare and scoped', (store, base) => {
        expect(isLiveSafeKey(store, base)).toBe(true);
        expect(isLiveSafeKey(store, `${base}_123`)).toBe(true);
    });

    test('every storage key constant the two panels declare is in the table', () => {
        const here = dirname(fileURLToPath(import.meta.url));
        // Panel geometry lives in `panelGeometry` / `panelOpenState`, under these names only as ids
        const notStorageKeys = new Set(['labSimPanel', 'combatSimPanel']);
        const listed = new Set(KEYS.map(([, base]) => base));
        const declared = [];
        for (const file of ['lab-sim-ui.js', 'combat-sim-ui.js', 'sim-editor.js']) {
            const text = readFileSync(join(here, file), 'utf8');
            for (const match of text.matchAll(/^const \w+ = '((?:labSim|combatSim|simEditor)[\w-]*)';/gm)) {
                if (!notStorageKeys.has(match[1])) declared.push(match[1]);
            }
        }
        expect(declared.length).toBeGreaterThan(20);
        expect(declared.filter((base) => !listed.has(base))).toEqual([]);
    });
});

describe('a pull of the simulator keys', () => {
    beforeEach(() => {
        db = new Map([
            ['settings', new Map()],
            ['combatExport', new Map()],
        ]);
        storageMock.finishRestore.mockClear();
    });

    test('latches nothing, so no reload is advised', async () => {
        const payload = await exportEverything();
        payload.stores = {
            settings: {
                labSimUpgradeScope_123: { mode: 'all', monsters: [] },
                labSimSkillingTargetClear_123: 80,
                labSimComparisonRuns_123: [{ id: 'a', timestamp: 1 }],
                combatSimUpgradeModes_123: ['equipment'],
                combatSimBestiaryPlanHours: 12,
                combatSimTriggerLastResult_123: { signature: 's', savedAt: 5, result: {} },
                simEditorLoadoutName_123: 'Tank',
            },
            combatExport: {
                zoneSimRates_123: { version: 1, rates: {} },
                'labSimUpgradeResults-fullkit_123': { savedAt: 2, data: { results: [] } },
            },
        };

        const result = await importEverything(payload, { liveSafeMerge: true });

        expect(db.get('settings').get('combatSimBestiaryPlanHours')).toBe(12);
        expect(db.get('combatExport').get('zoneSimRates_123')).toEqual({ version: 1, rates: {} });
        expect(result.latched).toBe(0);
        expect(storageMock.finishRestore).not.toHaveBeenCalled();
    });

    test('a comparison store takes the pulled runs on reload', async () => {
        const comparison = new LabComparisonStore();
        await comparison.load();
        expect(comparison.runs).toEqual([]);

        db.get('settings').set('labSimComparisonRuns_123', [
            { id: 'a', timestamp: 1, settings: {}, metrics: { winRate: 0.5 } },
            { id: 'b', timestamp: 2, settings: {}, metrics: { winRate: 0.6 } },
        ]);
        db.get('settings').set('labSimComparisonBaseline_123', 'b');
        await comparison.reload();

        expect(comparison.runs.map((run) => run.id)).toEqual(['a', 'b']);
        expect(comparison.baselineId).toBe('b');
    });
});

describe('the folds', () => {
    test('a single choice takes the incoming value', () => {
        expect(incomingWins('a', 'b')).toBe('b');
        expect(incomingWins({ x: 1 }, null)).toBe(null);
    });

    test('the trigger choices keep both sides’ fields, the incoming one winning a shared field', () => {
        expect(mergeFieldRecord({ scope: 'me', precision: 'fast' }, { scope: 'party', objective: 'xp' })).toEqual({
            scope: 'party',
            precision: 'fast',
            objective: 'xp',
        });
        expect(mergeFieldRecord({ scope: 'me' }, null)).toEqual({ scope: 'me' });
    });

    test('a saved result: the later save wins, and a clear travels', () => {
        const older = { savedAt: 1, data: 'old' };
        const newer = { savedAt: 2, data: 'new' };
        expect(laterSavedAtWins(newer, older)).toBe(newer);
        expect(laterSavedAtWins(older, newer)).toBe(newer);
        expect(laterSavedAtWins(newer, { savedAt: 2, data: 'tie' }).data).toBe('tie');
        // Clear writes null, and a pull of it (or an upload of it) clears the other side
        expect(laterSavedAtWins(newer, null)).toBe(null);
        expect(laterSavedAtWins(null, older)).toBe(older);
    });

    test('the comparison runs are taken whole, so a removed run stays removed', () => {
        const kept = [{ id: 'b', timestamp: 2 }];
        // This device removed run a and only it moved; the sync then folds with this device as the incoming side
        expect(mergeLabComparison([{ id: 'a', timestamp: 1 }, ...kept], kept)).toBe(kept);
    });

    test('single-zone rates are joined by zone, the later save winning one both have', () => {
        const local = {
            version: 1,
            rates: { 'z1|0|0': { savedAt: 5, encountersPerHour: 10 }, 'z2|0|0': { savedAt: 1, encountersPerHour: 1 } },
        };
        const incoming = JSON.stringify({
            version: 1,
            rates: { 'z1|0|0': { savedAt: 3, encountersPerHour: 7 }, 'z3|0|0': { savedAt: 4, encountersPerHour: 3 } },
        });
        const merged = mergeZoneSimRates(local, incoming);
        expect(merged.rates['z1|0|0'].encountersPerHour).toBe(10);
        expect(Object.keys(merged.rates).sort()).toEqual(['z1|0|0', 'z2|0|0', 'z3|0|0']);
        expect(mergeZoneSimRates(local, 'not json')).toBe(local);
    });

    test('single-zone rates keep the newest hundred', () => {
        const rates = (from, count) =>
            Object.fromEntries(Array.from({ length: count }, (_, i) => [`z${from + i}|0|0`, { savedAt: from + i }]));
        const merged = mergeZoneSimRates({ version: 1, rates: rates(0, 80) }, { version: 1, rates: rates(80, 40) });
        expect(Object.keys(merged.rates)).toHaveLength(100);
        expect(merged.rates['z0|0|0']).toBeUndefined();
        expect(merged.rates['z119|0|0']).toBeDefined();
    });
});

describe('the grouped-save memo', () => {
    test('a key is written only when its value moved from what was last seen stored', () => {
        const memo = new StoredValueMemo();
        expect(memo.differs('k', 1)).toBe(true);
        memo.remember('k', { b: 1, a: 2 });
        expect(memo.differs('k', { a: 2, b: 1 })).toBe(false);
        expect(memo.differs('k', { a: 3, b: 1 })).toBe(true);
        memo.clear();
        expect(memo.differs('k', { a: 2, b: 1 })).toBe(true);
    });

    test('pulledNames picks the panel’s keys out of what a pull wrote', () => {
        const names = pulledNames({ settings: ['a_1', 'b_2'] }, 'settings', { a: 'a_1', b: 'b_1', c: null });
        expect([...names]).toEqual(['a']);
    });
});
