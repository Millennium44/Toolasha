/** @vitest-environment happy-dom */

import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../core/data-manager.js', () => ({
    default: { on: () => {}, off: () => {}, getMarketListings: () => [] },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));

const { default: marketOrderTotals } = await import('./market-order-totals.js');

afterEach(() => {
    marketOrderTotals.clearDisplay();
    document.body.innerHTML = '';
});

describe('market order totals - narrow header', () => {
    test('wraps within its header column instead of spilling over the game queue box', () => {
        document.body.innerHTML = '<div class="Header_totalLevel__x">Total level 1</div>';
        marketOrderTotals.injectDisplay(document.querySelector('[class*="Header_totalLevel"]'));

        const el = document.querySelector('.mwi-market-order-totals');
        expect(el.style.flexWrap).toBe('wrap');
        expect(el.style.whiteSpace).toBe('nowrap');
        expect(el.style.gap).toBe('2px 12px');
    });
});
