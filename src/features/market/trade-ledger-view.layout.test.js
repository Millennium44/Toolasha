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

import { describe, test, expect, vi, afterEach } from 'vitest';

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
    afterEach(() => {
        tradeLedgerView.disable();
        document.body.innerHTML = '';
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
});
