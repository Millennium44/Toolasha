/**
 * Estimated Listing Age — the pure ID→timestamp estimation math and the
 * listing bookkeeping around it (status tracking, reconciliation, price/qty
 * text parsing). DOM injection (addAgeColumn, processOrderBook,
 * checkForExpiredListings) is not exercised here.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => ({
    getJSON: vi.fn(async (key, store, fallback) => fallback),
    setJSON: vi.fn(async () => {}),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, getMarketListings: () => [] },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => false, getSettingValue: (key, fallback) => fallback },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { updatePrice: vi.fn() } }));

const { default: estimatedListingAge } = await import('./estimated-listing-age.js');

beforeEach(() => {
    estimatedListingAge.knownListings = [];
    storageMock.getJSON.mockClear();
    storageMock.setJSON.mockClear();
    storageMock.getJSON.mockImplementation(async (key, store, fallback) => fallback);
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
        estimatedListingAge.knownListings = [{ id: 500, timestamp: 1_000_000 }];
        expect(estimatedListingAge.estimateTimestamp(999)).toBe(1_000_000);
    });

    test('interpolates linearly between two bracketing known ids', () => {
        estimatedListingAge.knownListings = [
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ];
        expect(estimatedListingAge.estimateTimestamp(150)).toBe(1500);
    });

    test('an exact id match returns its own timestamp, not an interpolation', () => {
        estimatedListingAge.knownListings = [
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
        ];
        expect(estimatedListingAge.linearInterpolation(100)).toBe(1000);
    });

    test('extrapolates beyond the known range using regression, anchored at the nearest edge', () => {
        estimatedListingAge.knownListings = [
            { id: 100, timestamp: 1000 },
            { id: 200, timestamp: 2000 },
            { id: 300, timestamp: 3000 },
        ];
        // Perfectly linear (slope 10/id), so extrapolation beyond maxId should hit exactly
        expect(estimatedListingAge.estimateTimestamp(400)).toBe(4000);
    });

    test('never returns a timestamp in the future', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        estimatedListingAge.knownListings = [
            { id: 100, timestamp: Date.now() - 2000 },
            { id: 200, timestamp: Date.now() - 1000 },
        ];
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
        // loadHistoricalData also seeds a handful of hardcoded anchor listings;
        // the assertion only cares about ids 1 and 2, not the seed set.
        storageMock.getJSON.mockImplementation(async () => [
            { id: 1, status: 'active' },
            { id: 2, status: 'active' },
        ]);
        estimatedListingAge.knownListings = []; // stale in-memory state

        await estimatedListingAge.deleteListing(1);

        const ids = estimatedListingAge.knownListings.map((l) => l.id);
        expect(ids).not.toContain(1);
        expect(ids).toContain(2);
        expect(storageMock.setJSON).toHaveBeenCalled();
    });

    test('markActiveListings promotes unknown listings present in the active set to active', async () => {
        storageMock.getJSON.mockImplementation(async () => [
            { id: 1, status: 'unknown' },
            { id: 2, status: 'unknown' },
        ]);
        estimatedListingAge.knownListings = [];

        await estimatedListingAge.markActiveListings(new Set([1]));

        const byId = Object.fromEntries(estimatedListingAge.knownListings.map((l) => [l.id, l.status]));
        expect(byId[1]).toBe('active');
        expect(byId[2]).toBe('unknown');
    });

    test('markActiveListings does not touch a listing that already has a resolved status', async () => {
        storageMock.getJSON.mockImplementation(async () => [{ id: 1, status: 'filled' }]);
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
