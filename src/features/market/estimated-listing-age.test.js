/**
 * Estimated Listing Age — the pure ID→timestamp estimation math and the
 * listing bookkeeping around it (status tracking, reconciliation, price/qty
 * text parsing). DOM injection (addAgeColumn, processOrderBook,
 * checkForExpiredListings) is not exercised here.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

/**
 * A real little store rather than a stub returning fallbacks: the listing log
 * is read through `readScoped`, which reads one key, writes another and deletes
 * a third, and a mock that answers every key the same way cannot show that the
 * legacy array was split rather than copied.
 */
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
        // A read that says whether it worked; tests flip `unavailable` to
        // stand in for a dropped IndexedDB connection
        unavailable: false,
        tryGet: vi.fn(async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        }),
        // Cloned on write, as IndexedDB does: the module hands the same array to
        // two keys in a row and a mock that stored the reference would show them
        // sharing a log they do not actually share
        set: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
        delete: vi.fn(async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        }),
        getAllKeys: vi.fn(async (store = 'settings') => Array.from(storeFor(store).keys())),
        getJSON: vi.fn(async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        }),
        setJSON: vi.fn(async (key, value, store = 'settings') => {
            storeFor(store).set(key, structuredClone(value));
            return true;
        }),
    };
});

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'market123',
    gameMode: 'standard',
    on: () => {},
    off: () => {},
    getMarketListings: () => [],
    getCurrentCharacterId: () => dataManagerMock.characterId,
    getCurrentCharacterGameMode: () => dataManagerMock.gameMode,
}));

// Adoption is consent-gated now; these suites test the data plumbing,
// so the decision is treated as already made for the main character.
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'market123',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { updatePrice: vi.fn() } }));

const { default: estimatedListingAge, ANCHOR_POOL_MAX } = await import('./estimated-listing-age.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

/** The key this character's listing log lives under */
const LOG_KEY = 'marketListingTimestamps_market123';
/** The key the old shared array lived under */
const LEGACY_KEY = 'marketListingTimestamps';
const ANCHORS_KEY = 'marketListingAnchors';

/**
 * Point the estimator at exactly these (id, timestamp) pairs and nothing else.
 *
 * Estimation reads a merged view of the log and the shared anchors, so a test
 * about the maths has to say there are no anchors as well as which listings
 * there are.
 * @param {Array} listings - The log
 */
const knownAs = (listings) => {
    estimatedListingAge.knownListings = listings;
    estimatedListingAge.anchors = [];
    estimatedListingAge.rebuildEstimationPoints();
};

beforeEach(() => {
    storageMock.reset();
    _resetAdoptionCache();
    dataManagerMock.characterId = 'market123';
    dataManagerMock.gameMode = 'standard';
    estimatedListingAge.knownListings = [];
    estimatedListingAge.anchors = [];
    estimatedListingAge.estimationPoints = [];
    estimatedListingAge.anchorsLoaded = false;
    estimatedListingAge._saveChain = null;
    storageMock.unavailable = false;
    for (const fn of [
        storageMock.get,
        storageMock.set,
        storageMock.delete,
        storageMock.getJSON,
        storageMock.setJSON,
        storageMock.tryGet,
    ])
        fn.mockClear();
});

describe('parsePrice', () => {
    test('reads plain numbers and K/M/B/T suffixes', () => {
        expect(estimatedListingAge.parsePrice('100')).toBe(100);
        expect(estimatedListingAge.parsePrice('1.5K')).toBe(1500);
        expect(estimatedListingAge.parsePrice('12M')).toBe(12_000_000);
        expect(estimatedListingAge.parsePrice('2B')).toBe(2_000_000_000);
        expect(estimatedListingAge.parsePrice('1.2T')).toBe(1_200_000_000_000);
    });

    test('strips thousands separators before parsing', () => {
        expect(estimatedListingAge.parsePrice('12,345')).toBe(12345);
    });

    test('tolerates the trailing "*" boundary marker on My Listings prices', () => {
        expect(estimatedListingAge.parsePrice('12,345*')).toBe(12345);
        expect(estimatedListingAge.parsePrice('1.5M*')).toBe(1_500_000);
    });

    test('is case-insensitive on the suffix', () => {
        expect(estimatedListingAge.parsePrice('3k')).toBe(3000);
    });

    test('returns null for empty or unparsable text', () => {
        expect(estimatedListingAge.parsePrice('')).toBeNull();
        expect(estimatedListingAge.parsePrice(null)).toBeNull();
        expect(estimatedListingAge.parsePrice('abc')).toBeNull();
    });
});

describe('parseQuantity', () => {
    test('reads plain numbers and K/M suffixes', () => {
        expect(estimatedListingAge.parseQuantity('42')).toBe(42);
        expect(estimatedListingAge.parseQuantity('3K')).toBe(3000);
        expect(estimatedListingAge.parseQuantity('2M')).toBe(2_000_000);
    });

    test('strips non-numeric characters first', () => {
        expect(estimatedListingAge.parseQuantity('x 1.5K units')).toBe(1500);
    });

    test('an empty numeric remainder is zero, not NaN', () => {
        expect(estimatedListingAge.parseQuantity('K')).toBe(0);
    });
});

describe('estimateTimestamp / linearInterpolation / linearRegression', () => {
    test('with no known listings, estimates roughly one hour ago', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        const estimate = estimatedListingAge.estimateTimestamp(12345);
        expect(estimate).toBe(Date.now() - 60 * 60 * 1000);
        vi.useRealTimers();
    });

    test('with a single known listing, every id maps to that one timestamp', () => {
        knownAs([{ id: 500, timestamp: 1_000_000 }]);
        expect(estimatedListingAge.estimateTimestamp(999)).toBe(1_000_000);
    });

    test('interpolates linearly between two bracketing known ids', () => {
        knownAs([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ]);
        expect(estimatedListingAge.estimateTimestamp(150)).toBe(1500);
    });

    test('an exact id match returns its own timestamp, not an interpolation', () => {
        knownAs([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ]);
        expect(estimatedListingAge.linearInterpolation(100)).toBe(1000);
    });

    test('extrapolates beyond the known range using regression, anchored at the nearest edge', () => {
        knownAs([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
            { id: 300, timestamp: 3000 },
        ]);
        // Perfectly linear (slope 10/id), so extrapolation beyond maxId should hit exactly
        expect(estimatedListingAge.estimateTimestamp(400)).toBe(4000);
    });

    test('never returns a timestamp in the future', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        knownAs([
            { id: 100, timestamp: Date.now() - 2000 },
            { id: 200, timestamp: Date.now() - 1000 },
        ]);
        // Far beyond the known range, regression would predict a time past "now"
        expect(estimatedListingAge.estimateTimestamp(100000)).toBe(Date.now());
        vi.useRealTimers();
    });
});

describe('getStalenessColor / getStalenessTooltip', () => {
    test('color escalates with age from fresh to very stale', () => {
        const now = Date.now();
        expect(estimatedListingAge.getStalenessColor(now)).toBe('#00AA00'); // <15min
        expect(estimatedListingAge.getStalenessColor(now - 30 * 60 * 1000)).toBe('#00FF00'); // <1hr
        expect(estimatedListingAge.getStalenessColor(now - 2 * 60 * 60 * 1000)).toBe('#FFAA00'); // <4hr
        expect(estimatedListingAge.getStalenessColor(now - 6 * 60 * 60 * 1000)).toBe('#FF6600'); // <12hr
        expect(estimatedListingAge.getStalenessColor(now - 20 * 60 * 60 * 1000)).toBe('#FF0000'); // 12hr+
    });

    test('an unknown age (falsy lastUpdated) is gray, not fresh', () => {
        expect(estimatedListingAge.getStalenessColor(0)).toBe('#999999');
        expect(estimatedListingAge.getStalenessColor(null)).toBe('#999999');
    });

    test('tooltip explains the unknown case separately from an aged one', () => {
        expect(estimatedListingAge.getStalenessTooltip(null)).toMatch(/Visit market page/);
        expect(estimatedListingAge.getStalenessTooltip(Date.now())).toMatch(/Order book data from/);
    });
});

describe('recordListing status resolution', () => {
    test('a brand new listing defaults to unknown status', () => {
        estimatedListingAge.recordListing({ id: 1, createdTimestamp: '2026-01-01T00:00:00Z', itemHrid: '/items/a' });
        expect(estimatedListingAge.knownListings[0].status).toBe('unknown');
    });

    test('an explicit _toolashaStatus overrides whatever was tracked before', () => {
        estimatedListingAge.knownListings = [{ id: 1, status: 'active', createdTimestamp: '2026-01-01T00:00:00Z' }];
        estimatedListingAge.recordListing({
            id: 1,
            createdTimestamp: '2026-01-01T00:00:00Z',
            _toolashaStatus: 'filled',
        });
        expect(estimatedListingAge.knownListings[0].status).toBe('filled');
    });

    test('re-recording without a new status preserves the previously tracked one', () => {
        estimatedListingAge.knownListings = [{ id: 1, status: 'active', createdTimestamp: '2026-01-01T00:00:00Z' }];
        estimatedListingAge.recordListing({ id: 1, createdTimestamp: '2026-01-01T00:00:00Z' });
        expect(estimatedListingAge.knownListings[0].status).toBe('active');
    });

    test('listings without a createdTimestamp are ignored entirely', () => {
        estimatedListingAge.recordListing({ id: 1 });
        expect(estimatedListingAge.knownListings).toHaveLength(0);
    });

    test('entries stay sorted by id after insertion', () => {
        estimatedListingAge.recordListing({ id: 300, createdTimestamp: '2026-01-03T00:00:00Z' });
        estimatedListingAge.recordListing({ id: 100, createdTimestamp: '2026-01-01T00:00:00Z' });
        estimatedListingAge.recordListing({ id: 200, createdTimestamp: '2026-01-02T00:00:00Z' });
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([100, 200, 300]);
    });
});

describe('deleteListing / markActiveListings / _reconcileActiveListings', () => {
    test('deleteListing re-syncs from storage before removing, so a stale copy cannot resurrect the entry', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [
            { id: 1, itemHrid: '/items/a', status: 'active' },
            { id: 2, itemHrid: '/items/b', status: 'active' },
        ]);
        estimatedListingAge.knownListings = []; // stale in-memory state

        await estimatedListingAge.deleteListing(1);

        const ids = estimatedListingAge.knownListings.map((l) => l.id);
        expect(ids).not.toContain(1);
        expect(ids).toContain(2);
        expect(storageMock.set).toHaveBeenCalled();
    });

    test('markActiveListings promotes unknown listings present in the active set to active', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [
            { id: 1, itemHrid: '/items/a', status: 'unknown' },
            { id: 2, itemHrid: '/items/b', status: 'unknown' },
        ]);
        estimatedListingAge.knownListings = [];

        await estimatedListingAge.markActiveListings(new Set([1]));

        const byId = Object.fromEntries(estimatedListingAge.knownListings.map((l) => [l.id, l.status]));
        expect(byId[1]).toBe('active');
        expect(byId[2]).toBe('unknown');
    });

    test('markActiveListings does not touch a listing that already has a resolved status', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [{ id: 1, itemHrid: '/items/a', status: 'filled' }]);
        estimatedListingAge.knownListings = [];

        await estimatedListingAge.markActiveListings(new Set([1]));

        expect(estimatedListingAge.knownListings[0].status).toBe('filled');
    });

    test('_reconcileActiveListings downgrades active listings absent from the new snapshot to unknown', () => {
        estimatedListingAge.knownListings = [
            { id: 1, status: 'active' },
            { id: 2, status: 'active' },
        ];

        estimatedListingAge._reconcileActiveListings([{ id: 1 }]);

        expect(estimatedListingAge.knownListings.find((l) => l.id === 1).status).toBe('active');
        expect(estimatedListingAge.knownListings.find((l) => l.id === 2).status).toBe('unknown');
    });

    test('_reconcileActiveListings leaves non-active statuses (filled/canceled) alone', () => {
        estimatedListingAge.knownListings = [{ id: 1, status: 'filled' }];
        estimatedListingAge._reconcileActiveListings([]);
        expect(estimatedListingAge.knownListings[0].status).toBe('filled');
    });
});

describe('splitting the old shared key', () => {
    /** A mixed legacy array: two of somebody's listings and one bare anchor */
    const legacyArray = () => [
        { id: 10, timestamp: 1000, itemHrid: '/items/a', status: 'filled' },
        { id: 20, timestamp: 2000 },
        { id: 30, timestamp: 3000, itemHrid: '/items/b', status: 'active' },
    ];

    test('the adopting character takes the listings and leaves the anchors behind', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([10, 30]);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([10, 30]);
        // Nothing without an item survives into the per-character log
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .some((l) => !l.itemHrid)
        ).toBe(false);
        // And the legacy key is gone, so it cannot be adopted twice
        expect(storageMock.storeFor('marketListings').has(LEGACY_KEY)).toBe(false);
    });

    test('the anchor half goes to the global key, seeds included', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        const anchors = storageMock.storeFor('marketListings').get(ANCHORS_KEY);
        expect(anchors.find((a) => a.id === 20)).toEqual({ id: 20, timestamp: 2000 });
        // The hardcoded baseline is in there too, so a fresh install can still estimate
        expect(anchors.find((a) => a.id === 106442952)).toBeTruthy();
        // Anchors are bare points — no item, no status, nobody's history
        expect(anchors.every((a) => Object.keys(a).sort().join() === 'id,timestamp')).toBe(true);
    });

    test('an iron cow gets the anchors but not the market character log', async () => {
        dataManagerMock.characterId = 'iron456';
        dataManagerMock.gameMode = 'ironcow';
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        expect(estimatedListingAge.knownListings).toEqual([]);
        // Left in place for the character it belongs to to claim
        expect(storageMock.storeFor('marketListings').get(LEGACY_KEY)).toHaveLength(3);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(ANCHORS_KEY)
                .find((a) => a.id === 20)
        ).toBeTruthy();
        // …and it can still date other people's listings from the shared points
        expect(estimatedListingAge.estimateTimestamp(20)).toBe(2000);
    });

    test('two characters keep separate logs', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());
        await estimatedListingAge.loadHistoricalData();

        dataManagerMock.characterId = 'iron456';
        dataManagerMock.gameMode = 'ironcow';
        estimatedListingAge.recordListing({ id: 99, createdTimestamp: '2026-01-01T00:00:00Z', itemHrid: '/items/c' });
        await estimatedListingAge.saveHistoricalData();

        expect(
            storageMock
                .storeFor('marketListings')
                .get('marketListingTimestamps_iron456')
                .map((l) => l.id)
        ).toEqual([10, 30, 99]);
        expect(
            storageMock
                .storeFor('marketListings')
                .get(LOG_KEY)
                .map((l) => l.id)
        ).toEqual([10, 30]);
    });

    test('estimation still sees both halves at once', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());

        await estimatedListingAge.loadHistoricalData();

        // id 20 is only an anchor, ids 10 and 30 only the log — all three usable
        expect(estimatedListingAge.linearInterpolation(20)).toBe(2000);
        expect(estimatedListingAge.linearInterpolation(10)).toBe(1000);
        expect(estimatedListingAge.linearInterpolation(15)).toBe(1500);
    });

    test('a second load does not re-split or re-write anything', async () => {
        storageMock.storeFor('marketListings').set(LEGACY_KEY, legacyArray());
        await estimatedListingAge.loadHistoricalData();

        storageMock.set.mockClear();
        storageMock.setJSON.mockClear();
        await estimatedListingAge.loadHistoricalData();

        expect(storageMock.set).not.toHaveBeenCalled();
        expect(storageMock.setJSON).not.toHaveBeenCalled();
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([10, 30]);
    });

    test('personalListings hands out copies, not the live log', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [{ id: 10, timestamp: 1000, itemHrid: '/items/a' }]);

        const copies = await estimatedListingAge.personalListings();
        copies[0].status = 'meddled';

        expect(estimatedListingAge.knownListings[0].status).toBeUndefined();
    });
});

describe('addAnchors — growing the shared pool', () => {
    test('appends a new {id, timestamp} pair', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 200, timestamp: 2000 }]);

        expect(estimatedListingAge.anchors).toEqual([
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ]);
    });

    test('dedupes by id, keeping the existing timestamp rather than the new one', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 100, timestamp: 9999 }]);

        expect(estimatedListingAge.anchors).toEqual([{ id: 100, timestamp: 1000 }]);
    });

    test('persists the grown pool to storage', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 200, timestamp: 2000 }]);

        expect(
            storageMock
                .storeFor('marketListings')
                .get(ANCHORS_KEY)
                .map((a) => a.id)
        ).toEqual([100, 200]);
    });

    test('does not write to storage when every candidate is already known', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([{ id: 100, timestamp: 1000 }]);

        expect(storageMock.setJSON).not.toHaveBeenCalled();
    });

    test('ignores malformed candidates (missing fields, non-numeric, NaN)', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([
            null,
            { id: 'not-a-number', timestamp: 2000 },
            { id: 200 },
            { id: NaN, timestamp: 3000 },
            { id: 300, timestamp: NaN },
        ]);

        expect(estimatedListingAge.anchors).toEqual([{ id: 100, timestamp: 1000 }]);
    });

    test('immediately improves estimation for ids the growth just covered', async () => {
        estimatedListingAge.anchors = [
            { id: 100, timestamp: 1000 },
            { id: 300, timestamp: 3000 },
        ];
        estimatedListingAge.knownListings = [];
        estimatedListingAge.rebuildEstimationPoints();
        // Before growth, 200 is a crude interpolation between the two endpoints
        expect(estimatedListingAge.estimateTimestamp(200)).toBe(2000);

        // A new, exact midpoint anchor arrives
        await estimatedListingAge.addAnchors([{ id: 200, timestamp: 2500 }]);

        // Estimation for 200 itself is now exact, and never regresses relative to before
        expect(estimatedListingAge.estimateTimestamp(200)).toBe(2500);
    });

    test('a no-op call (empty array) does not touch storage or the pool', async () => {
        estimatedListingAge.anchors = [{ id: 100, timestamp: 1000 }];

        await estimatedListingAge.addAnchors([]);

        expect(estimatedListingAge.anchors).toEqual([{ id: 100, timestamp: 1000 }]);
        expect(storageMock.setJSON).not.toHaveBeenCalled();
    });
});

describe('_evictToCapacity — bounding the anchor pool', () => {
    test('leaves a pool at or under the cap untouched', () => {
        const points = Array.from({ length: 10 }, (_, i) => ({ id: i, timestamp: i * 1000 }));
        expect(estimatedListingAge._evictToCapacity(points)).toEqual(points);
    });

    test('trims an over-cap pool down to exactly the cap', () => {
        const points = Array.from({ length: ANCHOR_POOL_MAX + 50 }, (_, i) => ({ id: i, timestamp: i * 1000 }));
        const trimmed = estimatedListingAge._evictToCapacity(points);
        expect(trimmed).toHaveLength(ANCHOR_POOL_MAX);
    });

    test('never evicts the two endpoints, preserving the id range', () => {
        const points = Array.from({ length: ANCHOR_POOL_MAX + 50 }, (_, i) => ({ id: i, timestamp: i * 1000 }));
        const trimmed = estimatedListingAge._evictToCapacity(points);
        expect(trimmed[0]).toEqual(points[0]);
        expect(trimmed[trimmed.length - 1]).toEqual(points[points.length - 1]);
    });

    test('thins the densest cluster before touching sparser, wide-coverage points', () => {
        // A handful of points spread wide, plus a tight cluster of near-duplicates
        // packed together — the cluster is the redundant part for interpolation.
        const wide = [
            { id: 0, timestamp: 0 },
            { id: 1_000_000, timestamp: 1_000_000_000 },
        ];
        const cluster = Array.from({ length: ANCHOR_POOL_MAX }, (_, i) => ({
            id: 500_000 + i,
            timestamp: 500_000_000 + i,
        }));
        const points = [...wide, ...cluster].sort((a, b) => a.id - b.id);

        const trimmed = estimatedListingAge._evictToCapacity(points);

        expect(trimmed).toHaveLength(ANCHOR_POOL_MAX);
        // Both wide endpoints survive...
        expect(trimmed.find((p) => p.id === 0)).toBeTruthy();
        expect(trimmed.find((p) => p.id === 1_000_000)).toBeTruthy();
        // ...at the cost of thinning the cluster, not the wide points around it
        expect(trimmed.filter((p) => p.id >= 500_000 && p.id < 500_000 + ANCHOR_POOL_MAX).length).toBeLessThan(
            cluster.length
        );
    });

    test('stops at 2 points rather than evicting an endpoint', () => {
        const points = [
            { id: 1, timestamp: 1 },
            { id: 2, timestamp: 2 },
        ];
        expect(estimatedListingAge._evictToCapacity(points)).toEqual(points);
    });
});

describe('recordListing grows the shared anchor pool', () => {
    test('recording an own listing appends a deduped anchor', () => {
        estimatedListingAge.anchors = [];
        estimatedListingAge.knownListings = [];

        estimatedListingAge.recordListing({
            id: 500,
            createdTimestamp: '2026-01-01T00:00:00.000Z',
            itemHrid: '/items/a',
        });

        expect(estimatedListingAge.anchors).toEqual([
            { id: 500, timestamp: new Date('2026-01-01T00:00:00.000Z').getTime() },
        ]);
    });

    test('re-recording the same id (e.g. a status update) does not duplicate the anchor', () => {
        estimatedListingAge.anchors = [];
        estimatedListingAge.knownListings = [];

        estimatedListingAge.recordListing({
            id: 500,
            createdTimestamp: '2026-01-01T00:00:00.000Z',
            itemHrid: '/items/a',
        });
        estimatedListingAge.recordListing({
            id: 500,
            createdTimestamp: '2026-01-01T00:00:00.000Z',
            itemHrid: '/items/a',
            _toolashaStatus: 'filled',
        });

        expect(estimatedListingAge.anchors).toHaveLength(1);
    });

    test('a listing with no createdTimestamp grows neither the log nor the anchor pool', () => {
        estimatedListingAge.anchors = [];
        estimatedListingAge.knownListings = [];

        estimatedListingAge.recordListing({ id: 500, itemHrid: '/items/a' });

        expect(estimatedListingAge.anchors).toEqual([]);
    });
});

describe('clearing the personal log keeps the anonymous anchor mirror', () => {
    test('clearing knownListings does not remove ids already mirrored into anchors', () => {
        estimatedListingAge.anchors = [{ id: 500, timestamp: 1000 }];
        estimatedListingAge.knownListings = [{ id: 500, timestamp: 1000, itemHrid: '/items/a', status: 'filled' }];
        estimatedListingAge.rebuildEstimationPoints();

        // Simulate clearHistory's personal-log wipe: only knownListings is cleared
        estimatedListingAge.knownListings = [];
        estimatedListingAge.rebuildEstimationPoints();

        expect(estimatedListingAge.anchors).toEqual([{ id: 500, timestamp: 1000 }]);
        expect(estimatedListingAge.estimateTimestamp(500)).toBe(1000);
    });
});

describe('the listing log cannot be wiped by a failed read or a stale copy', () => {
    const row = (id, extra = {}) => ({
        id,
        timestamp: id * 1000,
        createdTimestamp: new Date(id * 1000).toISOString(),
        itemHrid: '/items/a',
        enhancementLevel: 0,
        price: 1,
        orderQuantity: 1,
        filledQuantity: 1,
        isSell: true,
        status: 'filled',
        ...extra,
    });
    const storedLog = () => storageMock.storeFor('marketListings').get(LOG_KEY);

    test('a load while storage is unavailable keeps the in-memory log rather than blanking it', async () => {
        knownAs([row(1), row(2)]);
        storageMock.unavailable = true;

        await estimatedListingAge.loadHistoricalData();

        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([1, 2]);
    });

    test('a save while storage cannot be read is skipped, not written blind over the stored log', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2), row(3)]);
        // The failure mode that used to wipe histories: memory emptied by a
        // failed load, then a listing event saves that emptiness back
        knownAs([]);
        storageMock.unavailable = true;

        estimatedListingAge.recordListing(row(4));
        await estimatedListingAge._saveChain;

        expect(storedLog().map((l) => l.id)).toEqual([1, 2, 3]);
        expect(storageMock.set).not.toHaveBeenCalled();
    });

    test('a save merges what is stored under what is in memory, so rows from another writer survive', async () => {
        // Rows this tab has never loaded — another tab's, or an import written
        // straight to storage
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2, { status: 'unknown' })]);
        knownAs([row(2, { status: 'filled' })]);

        estimatedListingAge.recordListing(row(3));
        await estimatedListingAge._saveChain;

        expect(storedLog().map((l) => l.id)).toEqual([1, 2, 3]);
        // Memory's fresher status wins on the clash
        expect(storedLog().find((l) => l.id === 2).status).toBe('filled');
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([1, 2, 3]);
    });

    test('once storage is back, the next save lands everything recorded meanwhile', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1)]);
        knownAs([]);
        storageMock.unavailable = true;
        estimatedListingAge.recordListing(row(2));
        await estimatedListingAge._saveChain;
        expect(storedLog().map((l) => l.id)).toEqual([1]);

        storageMock.unavailable = false;
        estimatedListingAge.recordListing(row(3));
        await estimatedListingAge._saveChain;

        expect(storedLog().map((l) => l.id)).toEqual([1, 2, 3]);
    });

    test('importListings lands in memory and storage together', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1)]);
        knownAs([row(1)]);

        await estimatedListingAge.importListings([row(1), row(9)]);
        // A later listing event must not undo the import
        estimatedListingAge.recordListing(row(10));
        await estimatedListingAge._saveChain;

        expect(storedLog().map((l) => l.id)).toEqual([1, 9, 10]);
    });

    test('clearPersonalListings is the one write allowed to lose rows, and stays cleared', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2)]);
        knownAs([row(1), row(2)]);

        await estimatedListingAge.clearPersonalListings();
        expect(storedLog()).toEqual([]);

        estimatedListingAge.recordListing(row(3));
        await estimatedListingAge._saveChain;
        expect(storedLog().map((l) => l.id)).toEqual([3]);
    });

    test('deleteListing still removes the row despite merge-on-write', async () => {
        storageMock.storeFor('marketListings').set(LOG_KEY, [row(1), row(2)]);
        knownAs([row(1), row(2)]);

        await estimatedListingAge.deleteListing(1);

        expect(storedLog().map((l) => l.id)).toEqual([2]);
        expect(estimatedListingAge.knownListings.map((l) => l.id)).toEqual([2]);
    });
});
