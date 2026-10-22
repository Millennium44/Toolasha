/** @vitest-environment happy-dom */
import { afterEach, expect, test, vi } from 'vitest';
vi.mock('../../core/data-manager.js', () => ({
    default: { getMarketListings: () => [{ coinsAvailable: 40_000_000 }] },
}));
vi.mock('../../core/config.js', () => ({ default: { getSetting: () => true } }));
vi.mock('../../core/dom-observer.js', () => ({ default: {} }));
import totals from './market-order-totals.js';

afterEach(() => {
    totals.clearDisplay();
    document.body.innerHTML = '';
});

test('measures the native header without our totals, refreshes on resize, and cleans up', () => {
    const level = document.createElement('div');
    level.className = 'Header_totalLevel__x';
    level.textContent = 'Total Level: 1927';
    document.body.append(level);
    let width = 124;
    level.getBoundingClientRect = () => {
        expect(totals.displayElement?.style.display).toBe('none');
        return { width };
    };
    totals.injectDisplay(level);
    expect(totals.displayElement.style.getPropertyValue('--mwi-market-header-width')).toBe('124px');
    expect(totals.displayElement.textContent).toContain('40.0M');
    width = 100;
    window.dispatchEvent(new Event('resize'));
    expect(totals.displayElement.style.getPropertyValue('--mwi-market-header-width')).toBe('100px');
    totals.clearDisplay();
    expect(document.querySelector('.mwi-market-order-totals')).toBeNull();
    expect(totals.resizeHandler).toBeNull();
    expect(document.getElementById('mwi-market-mobile-layout')).toBeNull();
});
