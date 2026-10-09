/**
 * What three history owners prune stays pruned across sync.
 *
 * One browser, several characters, one gist: the leader's merged push used to
 * report news (`remoteAdds`) whenever the gist held something an owner had
 * pruned or deleted, because the upload starts from the gist's copy and a key
 * or row this device lacks reads as one it has yet to take. Every push re-armed
 * the note, and every reload's startup pull went to the apply step.
 *
 * Each owner here registers how it prunes, and these run its registrations
 * through the real upload merge and the registry calls a pull makes
 * (`mergeForPull` for a key both sides hold, `retentionDrops` over both sides'
 * keys for the rest):
 *
 * - the market listing log, by a fold that applies the log's own retention;
 * - the trade ledger's day records, by the cap's floor marker;
 * - the task-completion weeks, by an age rule on the week keys and the window
 *   applied to the completions a pull would add.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

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

// Imported for their registrations, as a page load makes them
await import('../features/market/estimated-listing-age.js');
const { recordKey } = await import('../features/market/trade-ledger-store.js');
/** The cap's floor marker, spelled out so the test does not lean on the module for it */
const floorKey = (charId, bucket) => `tradeLedgerRecFloor_${charId}_${bucket}`;
const { weekChunkId } = await import('../features/tasks/task-completion-tracker.js');
const { mergeForKey, retentionDrops } = await import('./sync-merge-registry.js');
const { mergeForUpload } = await import('../features/sync/sync-payload.js');

const DAY = 24 * 60 * 60 * 1000;

/** A payload as `buildPayloadJSON` writes it, one store */
const payload = (storeName, entries) =>
    JSON.stringify({ formatVersion: 1, syncScope: 'everything', stores: { [storeName]: entries } });

/** One store of a merged upload */
const storeOf = (text, storeName) => JSON.parse(text).stores[storeName] || {};

/**
 * What a pull of `remote` would leave of it, over this device's `local`: keys a retention rule drops are not
 * written, and a key both sides hold is folded with the pull's fold.
 */
const pull = (storeName, local, remote) => {
    const drops = retentionDrops(storeName, [...Object.keys(remote), ...Object.keys(local)]);
    const out = {};
    for (const [key, value] of Object.entries(remote)) {
        if (drops.has(key)) continue;
        const registration = mergeForKey(storeName, key);
        out[key] = registration && Object.hasOwn(local, key) ? registration.mergeForPull(local[key], value) : value;
    }
    return out;
};

beforeEach(() => {
    db.stores = {};
});

describe('market listing log', () => {
    const STORE = 'marketListings';
    const KEY = 'marketListingTimestamps_c1';
    const NEWEST = Date.UTC(2026, 5, 1);
    const row = (id, timestamp, status = 'filled') => ({
        id,
        timestamp,
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 10,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: true,
        status,
    });
    /** What this device keeps: everything within 90 days of its newest listing */
    const kept = [row(20, NEWEST - 10 * DAY), row(30, NEWEST)];
    /** What it let go of, which the gist still holds */
    const pruned = row(10, NEWEST - 100 * DAY);

    test('a listing retention pruned is not applied back by a pull', () => {
        const applied = pull(STORE, { [KEY]: kept }, { [KEY]: [pruned, ...kept] });

        expect(applied[KEY].map((listing) => listing.id)).toEqual([20, 30]);
    });

    test('once pruned, a merged upload reports no news and drops the listing from the gist', () => {
        const merged = mergeForUpload(
            payload(STORE, { [KEY]: kept }),
            payload(STORE, { [KEY]: [pruned, ...kept] }),
            null
        );

        expect(merged.remoteAdds).toBe(false);
        expect(storeOf(merged.text, STORE)[KEY].map((listing) => listing.id)).toEqual([20, 30]);
    });

    test('listings the log still keeps travel both ways, an old but active one included', () => {
        const active = row(5, NEWEST - 200 * DAY, 'active');
        const theirs = row(40, NEWEST - DAY);
        const mine = row(35, NEWEST - 2 * DAY);

        const merged = mergeForUpload(
            payload(STORE, { [KEY]: [active, ...kept, mine] }),
            payload(STORE, { [KEY]: [active, ...kept, theirs] }),
            null
        );

        expect(merged.remoteAdds).toBe(true);
        expect(storeOf(merged.text, STORE)[KEY].map((listing) => listing.id)).toEqual([5, 20, 30, 35, 40]);
        expect(pull(STORE, { [KEY]: [active, ...kept] }, { [KEY]: [active, ...kept, theirs] })[KEY]).toHaveLength(4);
    });
});

describe('trade ledger day records', () => {
    const STORE = 'marketListings';
    const day = (iso) => Date.parse(`${iso}T12:00:00.000Z`);
    const fill = (listingId, t) => ({ t, itemHrid: '/items/a', side: 'sell', quantity: 1, price: 10, listingId });
    const day1 = { [recordKey('c1', '2026-01-01')]: [fill(1, day('2026-01-01'))] };
    /** This device after the cap evicted 2026-01-01: the floor marker and the days it keeps */
    const local = {
        [floorKey('c1', '2026-01-02')]: { floor: '2026-01-02' },
        [recordKey('c1', '2026-01-02')]: [fill(2, day('2026-01-02'))],
        [recordKey('c1', '2026-01-03')]: [fill(3, day('2026-01-03'))],
    };
    /** The gist, from before: every day this device ever wrote, and no marker */
    const remote = { ...day1, ...local };
    delete remote[floorKey('c1', '2026-01-02')];

    test('a day record the cap evicted is not applied back by a pull', () => {
        const applied = pull(STORE, local, remote);

        expect(Object.keys(applied)).not.toContain(recordKey('c1', '2026-01-01'));
        expect(Object.keys(applied)).toContain(recordKey('c1', '2026-01-02'));
    });

    test('once evicted, a merged upload reports no news and carries the floor up instead of the day', () => {
        const merged = mergeForUpload(payload(STORE, local), payload(STORE, remote), null);

        expect(merged.remoteAdds).toBe(false);
        expect(merged.dropsFromRemote).toBe(true);
        expect(Object.keys(storeOf(merged.text, STORE)).sort()).toEqual(Object.keys(local).sort());
    });

    test("another character's days are not cut by this one's floor", () => {
        const other = { [recordKey('c2', '2026-01-01')]: [fill(9, day('2026-01-01'))] };

        expect(Object.keys(pull(STORE, local, { ...remote, ...other }))).toContain(recordKey('c2', '2026-01-01'));
    });

    test('day records the cap keeps travel both ways', () => {
        const theirs = { [recordKey('c1', '2026-01-04')]: [fill(4, day('2026-01-04'))] };
        const mine = { [recordKey('c1', '2026-01-05')]: [fill(5, day('2026-01-05'))] };

        const merged = mergeForUpload(
            payload(STORE, { ...local, ...mine }),
            payload(STORE, { ...remote, ...theirs }),
            null
        );

        expect(merged.remoteAdds).toBe(true);
        expect(Object.keys(storeOf(merged.text, STORE))).toEqual(
            expect.arrayContaining([recordKey('c1', '2026-01-04'), recordKey('c1', '2026-01-05')])
        );
        expect(Object.keys(pull(STORE, local, { ...remote, ...theirs }))).toContain(recordKey('c1', '2026-01-04'));
    });
});

describe('task-completion weeks', () => {
    const STORE = 'rerollSpending';
    /** A Wednesday noon, so the window's cut (eight weeks back) falls mid-week */
    const NOW = Date.UTC(2026, 5, 10, 12);
    const CUT = NOW - 8 * 7 * DAY;
    const key = (t) => `taskCompletionRec_c1_${weekChunkId(t)}`;
    const completion = (questId, completedAt) => ({ questId, completedAt, coins: 1, tokens: 1, items: [] });

    const old = completion(1, NOW - 10 * 7 * DAY);
    const beforeCut = completion(2, CUT - 60 * 60 * 1000);
    const afterCut = completion(3, CUT + 60 * 60 * 1000);
    const recent = completion(4, NOW - DAY);

    /** This device: the window, as the tracker's load leaves it */
    const local = { [key(afterCut.completedAt)]: [afterCut], [key(recent.completedAt)]: [recent] };
    /** The gist: everything this device ever held */
    const remote = {
        [key(old.completedAt)]: [old],
        [key(afterCut.completedAt)]: [beforeCut, afterCut],
        [key(recent.completedAt)]: [recent],
    };

    beforeEach(() => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    test('the fixture straddles the cut inside one week', () => {
        expect(key(beforeCut.completedAt)).toBe(key(afterCut.completedAt));
        expect(key(old.completedAt)).not.toBe(key(beforeCut.completedAt));
    });

    test('a week the window let go of, and completions from before the cut, are not applied back by a pull', () => {
        const applied = pull(STORE, local, remote);

        expect(Object.keys(applied)).not.toContain(key(old.completedAt));
        expect(applied[key(afterCut.completedAt)]).toEqual([afterCut]);
    });

    test('once pruned, a merged upload reports no news and drops the week from the gist', () => {
        const merged = mergeForUpload(payload(STORE, local), payload(STORE, remote), null);

        expect(merged.remoteAdds).toBe(false);
        expect(Object.keys(storeOf(merged.text, STORE))).not.toContain(key(old.completedAt));
    });

    test('completions inside the window travel both ways', () => {
        const theirs = completion(5, NOW - 2 * DAY);
        const mine = completion(6, NOW - 3 * DAY);
        const recentKey = key(recent.completedAt);
        const minePayload = { ...local, [key(mine.completedAt)]: [mine] };
        const theirPayload = { ...remote, [recentKey]: [...remote[recentKey], theirs] };

        const merged = mergeForUpload(payload(STORE, minePayload), payload(STORE, theirPayload), null);

        expect(merged.remoteAdds).toBe(true);
        const text = merged.text;
        expect(text).toContain('"questId":5');
        expect(text).toContain('"questId":6');
        expect(pull(STORE, local, theirPayload)[recentKey].map((entry) => entry.questId)).toContain(5);
    });
});
