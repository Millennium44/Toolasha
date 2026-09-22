/** @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const game = vi.hoisted(() => ({
    characterId: '30404',
    listings: [],
    stored: [],
    settingEnabled: true,
    settingChange: null,
    set: vi.fn(async () => true),
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => game.settingEnabled,
        onSettingChange: (key, callback) => {
            if (key === 'market_listingDragOrder') game.settingChange = callback;
            return () => {};
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => game.characterId,
        getMarketListings: () => game.listings,
    },
}));
vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn(() => () => {}),
        onReady: vi.fn((name, callback) => {
            callback();
            return () => {};
        }),
    },
}));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: vi.fn(async () => game.stored),
        set: (...args) => game.set(...args),
    },
}));
vi.mock('../../utils/dom.js', () => ({ addStyles: vi.fn(), removeStyles: vi.fn() }));
vi.mock('./listing-price-display.js', () => ({
    default: {
        extractRowInfo: (row) => JSON.parse(row.dataset.rowInfo || '{}'),
    },
}));

const { default: listingDragOrder } = await import('./listing-drag-order.js');

function buildTable(ids, header = 'Status') {
    const table = document.createElement('table');
    table.className = 'MarketplacePanel_myListingsTable_xyz';
    table.innerHTML = `<thead><tr><th>${header}</th></tr></thead><tbody></tbody>`;
    const tbody = table.querySelector('tbody');
    for (const id of ids) {
        const row = document.createElement('tr');
        row.dataset.listingId = String(id);
        row.innerHTML = '<td>Active</td><td>Sell</td>';
        tbody.appendChild(row);
    }
    document.body.appendChild(table);
    return table;
}

const rowIds = (table) => Array.from(table.querySelectorAll('tbody tr'), (row) => row.dataset.listingId);

beforeEach(() => {
    document.body.innerHTML = '';
    game.characterId = '30404';
    game.listings = [];
    game.stored = [];
    game.settingEnabled = true;
    game.set.mockClear();
});

afterEach(() => listingDragOrder.cleanup());

describe('saved manual order', () => {
    test('applies the saved IDs and marks the table so collectable-first sorting yields', () => {
        const table = buildTable([1, 2, 3]);
        listingDragOrder.savedOrder = ['3', '1', '2'];

        listingDragOrder._decorate(table);

        expect(rowIds(table)).toEqual(['3', '1', '2']);
        expect(table.dataset.mwiManualListingOrder).toBe('true');
        expect(table.querySelectorAll('.mwi-listing-drag-handle')).toHaveLength(3);
    });

    test('leaves a column-sorted table alone until that sort is cleared', () => {
        const table = buildTable([1, 2, 3], 'Status ▲');
        listingDragOrder.savedOrder = ['3', '1', '2'];

        listingDragOrder._decorate(table);

        expect(rowIds(table)).toEqual(['1', '2', '3']);
        expect(table.dataset.mwiManualListingOrder).toBeUndefined();

        table.querySelector('th').textContent = 'Status';
        listingDragOrder._applySavedOrder(table);
        expect(rowIds(table)).toEqual(['3', '1', '2']);
    });

    test('keeps new listings after the known manual order', () => {
        const table = buildTable([4, 2, 1, 3]);
        listingDragOrder.savedOrder = ['3', '1', '2'];

        listingDragOrder._applySavedOrder(table);

        expect(rowIds(table)).toEqual(['3', '1', '2', '4']);
    });
});

describe('reordering controls', () => {
    test('keeps the moved row in place when decoration runs during an active saved-order drag', () => {
        const table = buildTable([1, 2, 3]);
        listingDragOrder.savedOrder = ['1', '2', '3'];
        listingDragOrder._decorate(table);
        const first = table.querySelector('tbody tr');
        const last = table.querySelector('tbody tr:last-child');

        listingDragOrder._startDrag({ dataTransfer: null }, first, table);
        listingDragOrder._moveRow(first, last, true);
        listingDragOrder._decorate(table);

        expect(rowIds(table)).toEqual(['2', '3', '1']);
        listingDragOrder._finishDrag(table);
    });

    test('claims manual ordering as soon as the first drag starts', () => {
        const table = buildTable([1, 2, 3]);
        listingDragOrder._decorate(table);
        const first = table.querySelector('tbody tr');

        listingDragOrder._startDrag({ dataTransfer: null }, first, table);

        expect(table.dataset.mwiManualListingOrder).toBe('true');
        listingDragOrder._finishDrag(table);
    });

    test('ArrowDown moves a row and persists the new per-character order', async () => {
        const table = buildTable([1, 2, 3]);
        listingDragOrder.storageKey = 'marketListingDragOrder_30404';
        listingDragOrder._watchTable(table);
        const firstHandle = table.querySelector('.mwi-listing-drag-handle');

        firstHandle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        await Promise.resolve();

        expect(rowIds(table)).toEqual(['2', '1', '3']);
        expect(game.set).toHaveBeenCalledWith('marketListingDragOrder_30404', ['2', '1', '3'], 'settings');
    });

    test('assigns IDs itself when price columns are disabled', () => {
        const table = buildTable([]);
        const row = document.createElement('tr');
        row.dataset.rowInfo = JSON.stringify({
            itemHrid: '/items/cheese',
            enhancementLevel: 0,
            isSell: true,
            price: 100,
            filledQuantity: 0,
            orderQuantity: 50,
            filledSuffixMultiplier: 1,
            orderSuffixMultiplier: 1,
        });
        row.innerHTML = '<td>Active</td><td>Sell</td>';
        table.querySelector('tbody').appendChild(row);
        game.listings = [
            {
                id: 88,
                itemHrid: '/items/cheese',
                enhancementLevel: 0,
                isSell: true,
                price: 100,
                filledQuantity: 0,
                orderQuantity: 50,
            },
        ];

        listingDragOrder._decorate(table);

        expect(row.dataset.listingId).toBe('88');
        expect(row.querySelector('.mwi-listing-drag-handle')).not.toBeNull();
    });

    test('cleanup detaches row listeners while the native table remains mounted', () => {
        const table = buildTable([1, 2]);
        listingDragOrder._watchTable(table);
        const first = table.querySelector('tbody tr');

        listingDragOrder.cleanup();
        const drop = new Event('drop', { bubbles: true, cancelable: true });
        first.dispatchEvent(drop);

        expect(drop.defaultPrevented).toBe(false);
    });
});

describe('initialization', () => {
    test('loads the order for the active character before decorating an existing table', async () => {
        const table = buildTable([1, 2, 3]);
        game.stored = ['2', '3', '1'];

        await listingDragOrder.initialize();

        expect(rowIds(table)).toEqual(['2', '3', '1']);
        expect(listingDragOrder.storageKey).toBe('marketListingDragOrder_30404');
    });

    test('the feature checkbox enables and disables the controls without a reload', async () => {
        const table = buildTable([1, 2, 3]);
        await listingDragOrder.initialize();
        expect(table.querySelectorAll('.mwi-listing-drag-handle')).toHaveLength(3);

        game.settingEnabled = false;
        await game.settingChange(false);
        expect(table.querySelector('.mwi-listing-drag-handle')).toBeNull();
        expect(listingDragOrder.isInitialized).toBe(false);

        game.settingEnabled = true;
        await game.settingChange(true);
        expect(table.querySelectorAll('.mwi-listing-drag-handle')).toHaveLength(3);
        expect(listingDragOrder.isInitialized).toBe(true);
    });
});
