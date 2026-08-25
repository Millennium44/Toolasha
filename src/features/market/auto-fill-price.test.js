/**
 * @vitest-environment happy-dom
 *
 * Filling a listing price the market will actually admit. The failure that
 * matters: the best standing offer sits outside the game's daily tradable
 * band (a stale order from before the band moved), and matching it fills a
 * price nobody can trade against.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

vi.mock('../../core/config.js', () => ({
    default: { getSetting: () => true, getSettingValue: (_key, fallback) => fallback },
}));
vi.mock('../../core/dom-observer.js', () => ({ default: { onClass: () => () => {} } }));

import autoFillPrice, { tradableRangeFrom, clampToRange } from './auto-fill-price.js';

describe('reading the tradable range off the modal', () => {
    test('suffixed bounds parse to real numbers', () => {
        expect(tradableRangeFrom('Tradable range: 307M – 375M')).toEqual({ min: 307_000_000, max: 375_000_000 });
        expect(tradableRangeFrom('Tradable range: 1.5K – 2K')).toEqual({ min: 1500, max: 2000 });
    });

    test('plain and separator-formatted bounds parse too', () => {
        expect(tradableRangeFrom('Tradable range: 1,200 – 1,800')).toEqual({ min: 1200, max: 1800 });
    });

    test('a hyphen instead of an en-dash still reads', () => {
        expect(tradableRangeFrom('Tradable range: 100 - 200')).toEqual({ min: 100, max: 200 });
    });

    test('a modal stating no range yields null rather than a guess', () => {
        expect(tradableRangeFrom('Price (Best Buy Offer: 300,000,000)')).toBeNull();
        expect(tradableRangeFrom('')).toBeNull();
        expect(tradableRangeFrom(null)).toBeNull();
    });

    test('an inverted band is treated as unreadable', () => {
        expect(tradableRangeFrom('Tradable range: 400M – 300M')).toBeNull();
    });
});

describe('clamping the filled price', () => {
    const range = { min: 307_000_000, max: 375_000_000 };

    test('a stale best offer under the floor lands on the floor', () => {
        // The reported case: best buy offer 300M against a 307M–375M band
        expect(clampToRange(300_000_000, range)).toBe(307_000_000);
    });

    test('a price over the ceiling lands on the ceiling', () => {
        expect(clampToRange(400_000_000, range)).toBe(375_000_000);
    });

    test('a price inside the band is left exactly as filled', () => {
        expect(clampToRange(310_000_000, range)).toBe(310_000_000);
        expect(clampToRange(307_000_000, range)).toBe(307_000_000);
        expect(clampToRange(375_000_000, range)).toBe(375_000_000);
    });
});

describe('the one-shot is spent on work done, not on a modal being seen', () => {
    /**
     * A Sell Listing modal. `withControls` false is the half-committed shell the
     * observer can catch: header present, price controls not yet rendered.
     * @param {boolean} withControls - Whether the Best Price label exists yet
     * @returns {{modal: HTMLElement, clicks: string[]}}
     */
    const orderModal = (withControls) => {
        const modal = document.createElement('div');
        modal.innerHTML = `
            <div class="MarketplacePanel_header__yahJo">Sell Listing</div>
            ${withControls ? '<span class="MarketplacePanel_bestPrice__1qP2x">Best Sell: 994,000</span>' : ''}`;
        const clicks = [];
        const label = modal.querySelector('span[class*="MarketplacePanel_bestPrice"]');
        if (label) label.addEventListener('click', () => clicks.push('best-price'));
        return { modal, clicks };
    };

    beforeEach(() => {
        autoFillPrice.processedModals = new WeakSet();
        autoFillPrice.timerRegistry.clearAll();
    });

    test('a fire before the price controls exist does not burn the one chance', () => {
        const early = orderModal(false);
        autoFillPrice.handleOrderModal(early.modal);
        expect(autoFillPrice.processedModals.has(early.modal)).toBe(false);

        // The same modal, now fully committed
        const label = document.createElement('span');
        label.className = 'MarketplacePanel_bestPrice__1qP2x';
        label.textContent = 'Best Sell: 994,000';
        let clicked = 0;
        label.addEventListener('click', () => (clicked += 1));
        early.modal.appendChild(label);

        autoFillPrice.handleOrderModal(early.modal);
        expect(clicked).toBe(1);

        // And not again
        autoFillPrice.handleOrderModal(early.modal);
        expect(clicked).toBe(1);
    });
});
