/**
 * @vitest-environment happy-dom
 *
 * Market History Viewer — the "Clear History" and CSV/Edible-Tools import
 * write paths, specifically how they interact with the shared anchor pool.
 *
 * Importing or clearing your own listing log is a write path for exact
 * {id, timestamp} pairs, same as live WebSocket recording — so it should grow
 * or preserve the anonymous anchors the age estimator leans on for every other
 * character. `estimated-listing-age.js` is mocked here: its own growth/dedupe/
 * eviction behavior is covered in `estimated-listing-age.test.js`. This file
 * is only about whether `market-history-viewer.js` calls into it correctly.
 *
 * The full modal/table rendering is not exercised — `renderTable` and
 * `loadListings` are stubbed so these tests drive `clearHistory` / `importCSV`
 * / `importEdibleToolsData` directly without needing a real DOM table.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

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
    getCurrentCharacterId: () => dataManagerMock.characterId,
    getCurrentCharacterGameMode: () => 'standard',
    getMarketListings: () => [],
    getInitClientData: () => ({ itemDetailMap: {} }),
}));

/** Only the surface market-history-viewer.js actually calls */
const estimatedListingAgeMock = vi.hoisted(() => ({
    personalListings: vi.fn(async () => []),
    addAnchors: vi.fn(async () => {}),
    loadHistoricalData: vi.fn(async () => {}),
    markActiveListings: vi.fn(async () => {}),
    deleteListing: vi.fn(async () => {}),
    clearPersonalListings: vi.fn(async () => {}),
    importListings: vi.fn(async () => {}),
}));

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({ default: dataManagerMock }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => false,
        getSettingValue: (key, fallback) => fallback,
        Z_MODAL: 1000,
    },
}));
vi.mock('./estimated-listing-age.js', () => ({ default: estimatedListingAgeMock }));
// Tab-bar wiring and DOM-observer plumbing — not what these tests are about,
// and both pull in core/websocket.js if left real.
vi.mock('../../utils/marketplace-tabs.js', () => ({
    navigateToMarketplace: vi.fn(),
    visibleTabsContainer: vi.fn(() => null),
}));
vi.mock('../../utils/dom-observer-helpers.js', () => ({ createMutationWatcher: () => () => {} }));

const { default: marketHistoryViewer } = await import('./market-history-viewer.js');
const { _resetAdoptionCache } = await import('../../utils/character-key.js');

/** The scoped key this character's personal log lives under */
const LOG_KEY = 'marketListingTimestamps_market123';

/** The confirm() stub, re-created fresh each test by vi.stubGlobal below */
let confirmMock;

beforeEach(() => {
    storageMock.reset();
    _resetAdoptionCache();
    dataManagerMock.characterId = 'market123';
    dataManagerMock.getInitClientData = () => ({ itemDetailMap: {} });

    for (const fn of [storageMock.get, storageMock.set, storageMock.delete, storageMock.getJSON, storageMock.setJSON])
        fn.mockClear();
    for (const fn of Object.values(estimatedListingAgeMock)) fn.mockClear();
    estimatedListingAgeMock.personalListings.mockResolvedValue([]);

    marketHistoryViewer.listings = [];
    marketHistoryViewer.filteredListings = [];
    // Table/control rendering is not what these tests are about, and needs a
    // real modal in the DOM to not throw.
    marketHistoryViewer.loadListings = vi.fn(async () => {});
    marketHistoryViewer.renderTable = vi.fn();

    confirmMock = vi.fn(() => true);
    vi.stubGlobal('confirm', confirmMock);
    vi.stubGlobal('alert', vi.fn());
});

describe('a character switch inside the saved-filter read', () => {
    test("the departing character's selections are not adopted into the arriving one", async () => {
        marketHistoryViewer.filters = {
            dateFrom: null,
            dateTo: null,
            selectedItems: [],
            selectedEnhLevels: [],
            selectedTypes: [],
        };
        // The read was issued under market123 and answers with their filters,
        // but the player is on the alt by the time it lands
        storageMock.get.mockImplementationOnce(async () => {
            dataManagerMock.characterId = 'alt456';
            return {
                dateFrom: '2026-01-01T00:00:00.000Z',
                dateTo: null,
                selectedItems: ['/items/a'],
                selectedEnhLevels: [3],
                selectedTypes: ['sell'],
            };
        });

        await marketHistoryViewer.loadFilters();

        // Adopting them would show the alt an empty table filtered by items
        // they never listed — and write those selections under the alt's key
        // the moment they touched any filter
        expect(marketHistoryViewer.filters.selectedItems).toEqual([]);
        expect(marketHistoryViewer.filters.selectedEnhLevels).toEqual([]);
        expect(marketHistoryViewer.filters.selectedTypes).toEqual([]);
        expect(marketHistoryViewer.filters.dateFrom).toBeNull();
    });
});

describe('clearHistory', () => {
    test('mirrors listings into anchors before wiping the personal log', async () => {
        marketHistoryViewer.listings = [
            { id: 1, timestamp: 1000, itemHrid: '/items/a' },
            { id: 2, timestamp: 2000, itemHrid: '/items/b' },
        ];

        await marketHistoryViewer.clearHistory();

        expect(estimatedListingAgeMock.addAnchors).toHaveBeenCalledWith([
            { id: 1, timestamp: 1000 },
            { id: 2, timestamp: 2000 },
        ]);
    });

    test('backfills anchors before the personal log is actually cleared', async () => {
        marketHistoryViewer.listings = [{ id: 1, timestamp: 1000, itemHrid: '/items/a' }];

        await marketHistoryViewer.clearHistory();

        const addOrder = estimatedListingAgeMock.addAnchors.mock.invocationCallOrder[0];
        const clearOrder = estimatedListingAgeMock.clearPersonalListings.mock.invocationCallOrder[0];
        expect(addOrder).toBeLessThan(clearOrder);
    });

    test('clears through the log owner, and never writes the log or anchor keys itself', async () => {
        marketHistoryViewer.listings = [{ id: 1, timestamp: 1000, itemHrid: '/items/a' }];

        await marketHistoryViewer.clearHistory();

        // The owner's saves merge stored under memory; a bare empty write from
        // here would be refilled on the next listing event, so the clear has to
        // be the owner's own
        expect(estimatedListingAgeMock.clearPersonalListings).toHaveBeenCalled();
        expect(storageMock.storeFor('marketListings').has(LOG_KEY)).toBe(false);
        // The anchor pool itself is estimatedListingAge's to manage — this module
        // never writes marketListingAnchors directly.
        expect(storageMock.storeFor('marketListings').has('marketListingAnchors')).toBe(false);
    });

    test('confirmation dialog tells the user anonymous anchors are kept', async () => {
        marketHistoryViewer.listings = [];

        await marketHistoryViewer.clearHistory();

        expect(confirmMock).toHaveBeenCalledWith(expect.stringMatching(/anonymous age anchors are kept/i));
    });

    test('a cancelled confirmation touches neither anchors nor the stored log', async () => {
        confirmMock.mockReturnValueOnce(false);
        marketHistoryViewer.listings = [{ id: 1, timestamp: 1000, itemHrid: '/items/a' }];

        await marketHistoryViewer.clearHistory();

        expect(estimatedListingAgeMock.addAnchors).not.toHaveBeenCalled();
        expect(storageMock.set).not.toHaveBeenCalled();
    });
});

describe('importCSV grows the anchor pool', () => {
    test('newly imported rows are mirrored into anchors as bare id/timestamp pairs', async () => {
        dataManagerMock.getInitClientData = () => ({ itemDetailMap: { '/items/a': { name: 'Widget' } } });

        const csv = [
            'Date,Item,Enhancement,Type,Status,Price,Quantity,Filled,Total,ID',
            '2026-01-01T00:00:00.000Z,Widget,0,Sell,filled,100,1,1,100,555',
        ].join('\n');

        await marketHistoryViewer.importCSV(csv);

        expect(estimatedListingAgeMock.addAnchors).toHaveBeenCalledWith([
            { id: 555, timestamp: new Date('2026-01-01T00:00:00.000Z').getTime() },
        ]);
    });

    test('rows skipped as duplicates are not sent to addAnchors', async () => {
        estimatedListingAgeMock.personalListings.mockResolvedValue([{ id: 555, itemHrid: '/items/a' }]);
        dataManagerMock.getInitClientData = () => ({ itemDetailMap: { '/items/a': { name: 'Widget' } } });

        const csv = [
            'Date,Item,Enhancement,Type,Status,Price,Quantity,Filled,Total,ID',
            '2026-01-01T00:00:00.000Z,Widget,0,Sell,filled,100,1,1,100,555',
        ].join('\n');

        await marketHistoryViewer.importCSV(csv);

        expect(estimatedListingAgeMock.addAnchors).toHaveBeenCalledWith([]);
    });
});

describe('importEdibleToolsData grows the anchor pool', () => {
    test('newly imported rows are mirrored into anchors as bare id/timestamp pairs', async () => {
        const payload = JSON.stringify([
            {
                id: 777,
                createdTimestamp: '2026-02-01T00:00:00.000Z',
                itemHrid: '/items/a',
                enhancementLevel: 0,
                price: 100,
                orderQuantity: 1,
                filledQuantity: 1,
                isSell: true,
            },
        ]);

        await marketHistoryViewer.importEdibleToolsData(payload);

        expect(estimatedListingAgeMock.addAnchors).toHaveBeenCalledWith([
            { id: 777, timestamp: new Date('2026-02-01T00:00:00.000Z').getTime() },
        ]);
    });
});

describe('rows an import cannot use', () => {
    test('an Edible Tools row with an unparseable date is skipped, not stored as NaN', async () => {
        const payload = JSON.stringify([
            { id: 1, createdTimestamp: 'not a date', itemHrid: '/items/a', price: 1 },
            { id: 2, createdTimestamp: '2026-02-01T00:00:00.000Z', itemHrid: '/items/a', price: 1 },
        ]);

        await marketHistoryViewer.importEdibleToolsData(payload);

        // A NaN timestamp is dropped by addAnchors and drawn as "Invalid Date"
        // for ever, so the row must not reach storage in the first place
        const stored = estimatedListingAgeMock.importListings.mock.calls[0][0];
        expect(stored.map((listing) => listing.id)).toEqual([2]);
        expect(estimatedListingAgeMock.addAnchors).toHaveBeenCalledWith([
            { id: 2, timestamp: new Date('2026-02-01T00:00:00.000Z').getTime() },
        ]);
    });

    test('an Edible Tools row with no item is skipped — it could never be drawn', async () => {
        const payload = JSON.stringify([{ id: 3, createdTimestamp: '2026-02-01T00:00:00.000Z' }]);

        await marketHistoryViewer.importEdibleToolsData(payload);

        expect(estimatedListingAgeMock.importListings.mock.calls[0][0]).toEqual([]);
        expect(estimatedListingAgeMock.addAnchors).toHaveBeenCalledWith([]);
    });

    test('a CSV row with an unparseable date is skipped, the way an invalid price already was', async () => {
        dataManagerMock.getInitClientData = () => ({ itemDetailMap: { '/items/a': { name: 'Widget' } } });

        const csv = [
            'Date,Item,Enhancement,Type,Status,Price,Quantity,Filled,Total,ID',
            ',Widget,0,Sell,filled,100,1,1,100,555',
            '2026-01-01T00:00:00.000Z,Widget,0,Sell,filled,100,1,1,100,556',
        ].join('\n');

        await marketHistoryViewer.importCSV(csv);

        const stored = estimatedListingAgeMock.importListings.mock.calls[0][0];
        expect(stored.map((listing) => listing.id)).toEqual([556]);
    });
});

describe('the date column sorts by the date it shows', () => {
    beforeEach(() => {
        marketHistoryViewer.filters = {
            dateFrom: null,
            dateTo: null,
            selectedItems: [],
            selectedEnhLevels: [],
            selectedTypes: [],
        };
        marketHistoryViewer.searchTerm = '';
        marketHistoryViewer.typeFilter = 'all';
        marketHistoryViewer.statusFilter = 'all';
        marketHistoryViewer.sortColumn = 'createdTimestamp';
        marketHistoryViewer.sortDirection = 'desc';
    });

    test('a row whose stored timestamp is NaN lands by its shown date, not at random', () => {
        // What an import written before the date was validated left behind
        marketHistoryViewer.listings = [
            { id: 1, itemHrid: '/items/a', createdTimestamp: '2026-01-01T00:00:00.000Z', timestamp: NaN },
            { id: 2, itemHrid: '/items/a', createdTimestamp: '2026-03-01T00:00:00.000Z', timestamp: NaN },
            { id: 3, itemHrid: '/items/a', createdTimestamp: '2026-02-01T00:00:00.000Z', timestamp: NaN },
        ];

        marketHistoryViewer.applyFilters();

        expect(marketHistoryViewer.filteredListings.map((listing) => listing.id)).toEqual([2, 3, 1]);
    });

    test('a row with no createdTimestamp still sorts by the numeric timestamp the column falls back to', () => {
        marketHistoryViewer.listings = [
            { id: 1, itemHrid: '/items/a', timestamp: 1000 },
            { id: 2, itemHrid: '/items/a', timestamp: 3000 },
            { id: 3, itemHrid: '/items/a', timestamp: 2000 },
        ];

        marketHistoryViewer.applyFilters();

        expect(marketHistoryViewer.filteredListings.map((listing) => listing.id)).toEqual([2, 3, 1]);
    });
});
