/**
 * The loot log's cap stays applied across sync.
 *
 * The cap keeps the newest MAX_ENTRIES entries across every hour chunk, so which chunks it evicts cannot be read
 * off key names. The store writes the cut down as a floor marker; these run the registration through the real
 * upload merge and the registry calls a pull makes.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({ stores: {} }));

vi.mock('../core/storage.js', () => {
    const storeFor = (name) => (db.stores[name] ||= {});
    return {
        default: {
            get: async (key, name, fallback = null) => storeFor(name)[key] ?? fallback,
            set: async (key, value, name) => {
                storeFor(name)[key] = value;
                return true;
            },
            delete: async (key, name) => {
                delete storeFor(name)[key];
                return true;
            },
            tryGet: async (key, name) =>
                Object.hasOwn(storeFor(name), key)
                    ? { found: true, value: storeFor(name)[key] }
                    : { found: false, value: null },
            getAll: async (name) => ({ ...storeFor(name) }),
            getAllKeys: async (name) => Object.keys(storeFor(name)),
            tryGetAllKeys: async (name) => Object.keys(storeFor(name)),
            listStores: async () => Object.keys(db.stores),
            putAll: async (name, entries) => {
                Object.assign(storeFor(name), entries);
                return Object.keys(entries).length;
            },
            onBeforeTeardown: () => () => {},
            isQuotaExceeded: () => false,
        },
    };
});
vi.mock('../core/settings-storage.js', () => ({ default: { reconcileKeyMigrationState: async () => {} } }));
vi.mock('./full-backup.js', () => ({
    tombstoneCompanionKey: () => null,
    importEverything: async () => ({ restored: {}, failed: [], complete: true }),
    stripExcludedKeys: (storeName, entries) => entries,
}));
vi.mock('../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'c1',
        getCurrentCharacterGameMode: () => 'standard',
        getInitClientData: () => null,
        getMarketListings: () => [],
        characterQuests: [],
        on: () => {},
        off: () => {},
    },
}));
vi.mock('../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (key, fallback) => fallback,
        onSettingChange: () => {},
        offSettingChange: () => {},
        onSettingsLoaded: () => () => {},
    },
}));
vi.mock('../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../core/websocket.js', () => ({ default: { on: () => {}, off: () => {} } }));
vi.mock('../api/marketplace.js', () => ({ default: { updatePrice: () => {}, updatePrices: () => {} } }));
vi.mock('./adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'c1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

// Imported for its registration, as a page load makes it
const { floorKey, parseLootLogRetentionKey } = await import('../features/actions/loot-log-history.js');
const { mergeForKey, retentionDrops } = await import('./sync-merge-registry.js');
const { mergeForUpload } = await import('../features/sync/sync-payload.js');

const STORE = 'lootLogHistory';
const hour = (chunk) => `lootLogRec_c1_${chunk}`;
const row = (id, startTime) => ({
    characterActionId: id,
    actionHrid: '/actions/milking/cow',
    startTime,
    endTime: startTime,
    actionCount: 1,
    drops: {},
    xpGains: {},
});

/** A payload as `buildPayloadJSON` writes it, one store */
const payload = (entries) =>
    JSON.stringify({ formatVersion: 1, syncScope: 'everything', stores: { [STORE]: entries } });
const storeOf = (text) => JSON.parse(text).stores[STORE] || {};

/** What a pull of `remote` would leave of it, over this device's `local` */
const pull = (local, remote) => {
    const drops = retentionDrops(STORE, [...Object.keys(remote), ...Object.keys(local)]);
    const out = {};
    for (const [key, value] of Object.entries(remote)) {
        if (drops.has(key)) continue;
        const registration = mergeForKey(STORE, key);
        out[key] = registration && Object.hasOwn(local, key) ? registration.mergeForPull(local[key], value) : value;
    }
    return out;
};

const h1 = { [hour('2026-01-01T01')]: [row(1, '2026-01-01T01:10:00Z')] };
/** This device after the cap evicted 2026-01-01T01: the floor marker and the hours it keeps */
const local = {
    [floorKey('c1', '2026-01-01T02')]: { floor: '2026-01-01T02' },
    [hour('2026-01-01T02')]: [row(2, '2026-01-01T02:10:00Z')],
    [hour('2026-01-01T03')]: [row(3, '2026-01-01T03:10:00Z')],
};
/** The gist, from before: every hour this device ever wrote, and no marker */
const remote = { ...h1, ...local };
delete remote[floorKey('c1', '2026-01-01T02')];

beforeEach(() => {
    db.stores = {};
});

describe('loot log hour chunks', () => {
    test('a chunk the cap evicted is not applied back by a pull', () => {
        const applied = pull(local, remote);

        expect(Object.keys(applied)).not.toContain(hour('2026-01-01T01'));
        expect(Object.keys(applied)).toContain(hour('2026-01-01T02'));
    });

    test('once evicted, a merged upload reports no news and carries the floor up instead of the chunk', () => {
        const merged = mergeForUpload(payload(local), payload(remote), null);

        expect(merged.remoteAdds).toBe(false);
        expect(merged.dropsFromRemote).toBe(true);
        expect(Object.keys(storeOf(merged.text)).sort()).toEqual(Object.keys(local).sort());
    });

    test("another character's chunks are not cut by this one's floor", () => {
        const other = { 'lootLogRec_c2_2026-01-01T00': [row(9, '2026-01-01T00:10:00Z')] };

        expect(Object.keys(pull(local, { ...remote, ...other }))).toContain('lootLogRec_c2_2026-01-01T00');
    });

    test('chunks the cap keeps travel both ways', () => {
        const theirs = { [hour('2026-01-01T04')]: [row(4, '2026-01-01T04:10:00Z')] };
        const mine = { [hour('2026-01-01T05')]: [row(5, '2026-01-01T05:10:00Z')] };

        const merged = mergeForUpload(payload({ ...local, ...mine }), payload({ ...remote, ...theirs }), null);

        expect(merged.remoteAdds).toBe(true);
        expect(Object.keys(storeOf(merged.text))).toEqual(
            expect.arrayContaining([hour('2026-01-01T04'), hour('2026-01-01T05')])
        );
        expect(Object.keys(pull(local, { ...remote, ...theirs }))).toContain(hour('2026-01-01T04'));
    });

    test('the retention reading declines deletions and the legacy key, and reads the hour', () => {
        expect(parseLootLogRetentionKey('lootLogRecTomb_c1')).toBeNull();
        expect(parseLootLogRetentionKey('lootLogRec_c1')).toBeNull();
        expect(parseLootLogRetentionKey(hour('2026-01-01T01'))).toEqual({
            group: 'c1',
            order: Date.UTC(2026, 0, 1, 1) / 3600000,
        });
        expect(parseLootLogRetentionKey(floorKey('c1', '2026-01-01T02'))).toEqual({
            group: 'c1',
            floor: Date.UTC(2026, 0, 1, 2) / 3600000,
        });
    });
});
