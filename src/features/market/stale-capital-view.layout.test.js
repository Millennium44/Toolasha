/**
 * @vitest-environment happy-dom
 *
 * Stale Capital View — the dialog fits a phone-width screen.
 *
 * Same shell as the Ledger dialog, and the same bug: `min-width: 640px` beats
 * `max-width: 95%`, so on a ~390px phone the dialog was 682px wide and the
 * overlay's `align-items: center` hung it off both edges, the title clipped at
 * the left and the close button off-screen right. happy-dom does no layout, so
 * these pin the declarations; the fit was measured in Firefox, Chromium and
 * WebKit at 360 and 390px wide, and 1280px unchanged.
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
    default: { getItemDetails: () => ({ name: 'Holy Cheese' }), getMarketListings: () => [] },
}));
vi.mock('../../api/marketplace.js', () => ({ default: { getPrice: () => null } }));
vi.mock('./mooket/market-price-store.js', () => ({ default: { get: () => null } }));
vi.mock('../../utils/panel-geometry.js', () => ({
    saveCollapsed: () => {},
    wasCollapsed: async () => false,
    savedSize: async () => null,
}));
vi.mock('../../utils/stale-capital.js', () => {
    const row = {
        itemHrid: '/items/holy_cheese',
        enhancementLevel: 0,
        quantity: 100,
        price: 1000,
        coinsTiedUp: 100_000,
        ageMs: 86_400_000,
        priceComparison: 'above',
        isSell: true,
    };
    return {
        buildStaleCapital: () => ({
            sellRows: [row],
            buyRows: [{ ...row, isSell: false }],
            sellTotal: 100_000,
            buyTotal: 100_000,
        }),
    };
});

const { default: staleCapitalView } = await import('./stale-capital-view.js');

function open() {
    staleCapitalView.openModal();
    return staleCapitalView.modal.querySelector('.mwi-stale-capital-content');
}

describe('the stale capital dialog fits a phone-width screen', () => {
    afterEach(() => {
        staleCapitalView.disable();
        document.body.innerHTML = '';
    });

    test('no fixed min-width wider than a phone; both bounds leave room for padding', () => {
        const content = open();
        // 640px stays the floor on a desktop, but only while the screen has room for it.
        expect(content.style.minWidth).toBe('min(640px, calc(100% - 58px))');
        expect(content.style.maxWidth).toBe('min(95%, calc(100% - 58px))');
    });

    test('each side table scrolls sideways inside its own box', () => {
        const content = open();
        for (const side of ['sell', 'buy']) {
            const container = content.querySelector(`.mwi-stale-capital-${side}`);
            expect(container.querySelector('table')).not.toBeNull();
            expect(container.style.overflowX).toBe('auto');
        }
    });
});
