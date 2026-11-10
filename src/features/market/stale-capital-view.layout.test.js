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

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { resetSpriteSheetCache } from '../../utils/overlay-format.js';

const artwork = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('../../utils/marketplace-tabs.js', () => ({
    visibleTabsContainer: () => null,
    insertTabInOrder: () => {},
    navigateToMarketplace: artwork.navigate,
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
    beforeEach(() => {
        resetSpriteSheetCache();
        artwork.navigate.mockClear();
    });
    afterEach(() => {
        staleCapitalView.disable();
        document.body.innerHTML = '';
        resetSpriteSheetCache();
    });

    test('no fixed min-width wider than a phone; both bounds leave room for padding', () => {
        const content = open();
        // 640px stays the floor on a desktop, but only while the screen has room for it.
        expect(content.style.minWidth).toBe('min(640px, calc(100% - 58px))');
        expect(content.style.maxWidth).toBe('min(95%, calc(100% - 58px))');
    });

    test('minimize sits in the same right-hand group as close, not mid-header', () => {
        const content = open();
        const minimize = content.querySelector('.toolasha-minimize-btn');
        const group = minimize.parentElement;
        expect(group.querySelectorAll('button')).toHaveLength(2);
        expect(group.lastElementChild.textContent).toBe('✕');
        // The header's own children are just the title and that group
        expect(group.parentElement.children).toHaveLength(2);
    });

    test('each side table scrolls sideways inside its own box', () => {
        const content = open();
        for (const side of ['sell', 'buy']) {
            const container = content.querySelector(`.mwi-stale-capital-${side}`);
            expect(container.querySelector('table')).not.toBeNull();
            expect(container.style.overflowX).toBe('auto');
        }
    });

    test('both sides show native artwork and keep unknown prices and enhancement navigation', () => {
        document.body.innerHTML = '<svg><use xlink:href="/static/media/items_sprite.current.svg#coin"></use></svg>';
        const content = open();
        for (const side of ['sell', 'buy']) {
            const row = { ...staleCapitalView.result[`${side}Rows`][0], enhancementLevel: 7, priceComparison: null };
            staleCapitalView.renderSide(side, side, [row, { ...row, itemHrid: '/items/milk' }], 200_000);
            const rows = [...content.querySelectorAll(`.mwi-stale-capital-${side} tbody tr`)];
            expect(rows.map((tr) => tr.querySelector('use').getAttribute('href'))).toEqual([
                '/static/media/items_sprite.current.svg#holy_cheese',
                '/static/media/items_sprite.current.svg#milk',
            ]);
            expect(rows[1].cells[0].textContent).toBe('Holy Cheese');
            expect(rows[1].cells[1].textContent).toBe('+7');
            expect(rows[1].textContent).toContain('unknown');
            rows[1].querySelector('use').dispatchEvent(new MouseEvent('click', { bubbles: true }));
        }
        expect(artwork.navigate.mock.calls).toEqual([
            ['/items/milk', 7],
            ['/items/milk', 7],
        ]);
    });

    test('late sprites appear on redraw and empty sides retain their empty messages', () => {
        const content = open();
        expect(content.querySelector('.toolasha-item-label svg')).toBeNull();
        document.body.insertAdjacentHTML(
            'afterbegin',
            '<svg><use href="/static/media/items_sprite.current.svg#coin"></use></svg>'
        );
        staleCapitalView.renderContent();
        staleCapitalView.renderContent();
        expect(content.querySelectorAll('.toolasha-item-label svg')).toHaveLength(2);
        for (const side of ['sell', 'buy']) staleCapitalView.renderSide(side, side, [], 0);
        expect(content.querySelectorAll('.toolasha-item-label')).toHaveLength(0);
        expect(content.textContent).toContain('No open sell listings.');
        expect(content.textContent).toContain('No open buy orders.');
    });
});
