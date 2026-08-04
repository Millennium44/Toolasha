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

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { updatePrice: vi.fn() } }));

const { default: estimatedListingAge } = await import('./estimated-listing-age.js');
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
    for (const fn of [storageMock.get, storageMock.set, storageMock.delete, storageMock.getJSON, storageMock.setJSON])
        fn.mockClear();
});

describe('parsePrice', () => {
    test('reads plain numbers and K/M/B suffixes', () => {
        expect(estimatedListingAge.parsePrice('100')).toBe(100);
        expect(estimatedListingAge.parsePrice('1.5K')).toBe(1500);
        expect(estimatedListingAge.parsePrice('12M')).toBe(12_000_000);
        expect(estimatedListingAge.parsePrice('2B')).toBe(2_000_000_000);
    });

    test('strips thousands separators before parsing', () => {
        expect(estimatedListingAge.parsePrice('12,345')).toBe(12345);
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
