/**
 * @vitest-environment happy-dom
 *
 * Trade Ledger View — the dialog fits a phone-width screen.
 *
 * It was `min-width: 640px` under `max-width: 95%`; a min-width beats a
 * max-width, so on a ~390px phone the dialog was 682px wide and the overlay's
 * `align-items: center` hung it off both edges: the title clipped at the left,
 * where nothing can scroll to it, and the close button off-screen right.
 * happy-dom does no layout, so these pin the declarations; the fit was measured
 * in Firefox, Chromium and WebKit at 360 and 390px wide, and 1280px unchanged.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';

const artwork = vi.hoisted(() => ({ navigate: vi.fn(), csv: vi.fn() }));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    visibleTabsContainer: () => null,
    insertTabInOrder: () => {},
    navigateToMarketplace: artwork.navigate,
}));
vi.mock('../../utils/csv-export.js', async () => ({
    ...(await vi.importActual('../../utils/csv-export.js')),
    downloadCsv: artwork.csv,
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: () => true,
        getSettingValue: (_key, fallback) => fallback,
        onSettingChange: () => () => {},
        Z_MODAL: 10000,
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getItemDetails: () => ({ name: 'Holy Cheese' }) },
}));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
}));
vi.mock('./trade-ledger-store.js', () => ({ default: { getRecords: () => [] } }));
vi.mock('./estimated-listing-age.js', () => ({
    default: { personalListings: async () => [], cachedTopOfBook: () => null },
}));
vi.mock('./mooket/market-price-store.js', () => ({ default: { get: () => null } }));
vi.mock('../../utils/trade-ledger.js', () => ({
    aggregateLedger: () => ({
        weeks: [],
        items: [
            {
                itemHrid: '/items/holy_cheese',
                enhancementLevel: 0,
                boughtQty: 10,
                boughtCoins: 1000,
                avgBuyPrice: 100,
                soldQty: 5,
                soldCoinsNet: 600,
                avgSellNet: 120,
                realizedProfit: 100,
                unmatchedRevenue: 0,
                lastActivity: Date.UTC(2026, 8, 26),
            },
        ],
    }),
}));

const { default: tradeLedgerView } = await import('./trade-ledger-view.js');

function open() {
    tradeLedgerView.openModal();
    return tradeLedgerView.modal.querySelector('.mwi-trade-ledger-content');
}

describe('the ledger dialog fits a phone-width screen', () => {
    beforeEach(() => {
        resetSpriteSheetCache();
        tradeLedgerView.filterText = '';
        artwork.navigate.mockClear();
        artwork.csv.mockClear();
    });
    afterEach(() => {
        tradeLedgerView.disable();
        document.body.innerHTML = '';
        resetSpriteSheetCache();
    });

    test('no fixed min-width wider than a phone; both bounds leave room for padding', () => {
        const content = open();
        // 640px stays the floor on a desktop, but only while the screen has room for it.
        expect(content.style.minWidth).toBe('min(640px, calc(100% - 58px))');
        expect(content.style.maxWidth).toBe('min(95%, calc(100% - 58px))');
    });

    test('the header wraps its buttons under the title rather than past the right edge', () => {
        const content = open();
        const header = content.firstElementChild;
        expect(header.querySelector('h2').textContent).toBe('Trade Ledger');
        expect(header.style.flexWrap).toBe('wrap');
    });

    test('the item table scrolls sideways inside its own box', () => {
        const content = open();
        const tableContainer = content.querySelector('.mwi-trade-ledger-table-container');
        expect(tableContainer.querySelector('table')).not.toBeNull();
        expect(tableContainer.style.overflowX).toBe('auto');
    });

    test('item artwork uses identities, retains enhancement navigation and leaves CSV names plain', () => {
        document.body.innerHTML = '<svg><use xlink:href="/static/media/items_sprite.current.svg#coin"></use></svg>';
        const content = open();
        const original = tradeLedgerView.aggregates.items[0];
        tradeLedgerView.aggregates.items = [original, { ...original, itemHrid: '/items/milk', enhancementLevel: 7 }];
        tradeLedgerView.renderItemTable();
        const rows = [...content.querySelectorAll('.mwi-trade-ledger-table-container tbody tr')];
        expect(rows.map((tr) => tr.cells[0].textContent)).toEqual(['Holy Cheese', 'Holy Cheese']);
        expect(rows.map((tr) => tr.querySelector('use').getAttribute('href'))).toEqual([
            '/static/media/items_sprite.current.svg#holy_cheese',
            '/static/media/items_sprite.current.svg#milk',
        ]);
        expect(rows[1].cells[1].textContent).toBe('+7');
        rows[1].querySelector('use').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(artwork.navigate).toHaveBeenCalledExactlyOnceWith('/items/milk', 7);
        tradeLedgerView.exportCSV();
        expect(artwork.csv).toHaveBeenCalledTimes(1);
        const csv = artwork.csv.mock.calls[0][1];
        expect(csv).toContain('Holy Cheese');
        expect(csv).not.toMatch(/<svg|toolasha-item-label|items_sprite/);
    });

    test('redraw picks up a late sprite without duplicates, and an empty filter draws no icons', () => {
        const content = open();
        expect(content.querySelector('.toolasha-item-label svg')).toBeNull();
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<svg><use href="/static/media/items_sprite.current.svg#coin"></use></svg>'
        );
        tradeLedgerView.renderItemTable();
        tradeLedgerView.renderItemTable();
        expect(content.querySelectorAll('.toolasha-item-label svg')).toHaveLength(1);
        tradeLedgerView.filterText = 'no matching item';
        tradeLedgerView.renderItemTable();
        expect(content.querySelectorAll('.toolasha-item-label')).toHaveLength(0);
        expect(content.textContent).toContain('No item names match');
    });
});
