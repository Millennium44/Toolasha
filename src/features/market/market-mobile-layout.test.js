/** @vitest-environment happy-dom */
import { afterEach, describe, expect, test } from 'vitest';
import {
    ensureMarketMobileStyles,
    releaseListingScroll,
    releaseMarketMobileStyles,
    syncListingScroll,
} from './market-mobile-layout.js';

afterEach(() => {
    document.body.innerHTML = '';
    document.getElementById('mwi-market-mobile-layout')?.remove();
});

function makeTable() {
    const host = document.createElement('div');
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>Quantity</th><th>Price</th><th class="mwi-enh-profit-header">Profit/h</th><th>Action</th><th class="mwi-estimated-age-header">~Age</th></tr></thead><tbody>
        <tr><td>3</td><td><span class="MarketplacePanel_price__x">17.7M</span></td><td class="mwi-enh-profit-cell" title="Exact profit">45.77K</td><td><button>Buy</button></td><td class="mwi-estimated-age-cell">~14h 8m</td></tr>
    </tbody>`;
    host.append(table);
    document.body.append(host);
    return { host, table };
}

const rules = () => document.getElementById('mwi-market-mobile-layout')?.textContent ?? '';

describe('phone listings scroll sideways', () => {
    test('the row stays one row with every cell, the container scrolls, and the native button is untouched', () => {
        const { host, table } = makeTable();
        const button = table.querySelector('button');
        let clicks = 0;
        button.addEventListener('click', () => clicks++);
        syncListingScroll(table);
        expect(table.querySelectorAll('tbody tr')).toHaveLength(1);
        expect(table.querySelectorAll('tbody tr > td')).toHaveLength(5);
        expect(table.querySelector('.MarketplacePanel_price__x').textContent).toBe('17.7M');
        expect(host.hasAttribute('data-mwi-listing-scroll')).toBe(true);
        expect(table.querySelector('button')).toBe(button);
        button.click();
        expect(clicks).toBe(1);
        const css = rules();
        const media = css.indexOf('@media (max-width: 768px)');
        expect(media).toBeGreaterThan(-1);
        const rule = css.indexOf('[data-mwi-listing-scroll] { overflow-x: auto; -webkit-overflow-scrolling: touch');
        expect(rule).toBeGreaterThan(media);
        expect(css).not.toContain('mwi-market-mobile-note');
    });

    test('above the phone breakpoint the scroll rules are not applied outside the media query', () => {
        const { table } = makeTable();
        syncListingScroll(table);
        const css = rules();
        expect(css.slice(0, css.indexOf('@media (max-width: 768px)'))).not.toContain('overflow-x');
    });

    test('repeated syncs write nothing once settled', () => {
        const { host, table } = makeTable();
        syncListingScroll(table);
        const observer = new MutationObserver(() => {});
        observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        syncListingScroll(table);
        expect(observer.takeRecords()).toHaveLength(0);
        observer.disconnect();
        expect(host.hasAttribute('data-mwi-listing-scroll')).toBe(true);
    });

    test('a table with no Toolasha column gets no marker and no rules', () => {
        const { host, table } = makeTable();
        table.querySelectorAll('.mwi-enh-profit-cell, .mwi-estimated-age-cell').forEach((el) => el.remove());
        syncListingScroll(table);
        expect(host.hasAttribute('data-mwi-listing-scroll')).toBe(false);
        expect(document.getElementById('mwi-market-mobile-layout')).toBeNull();
    });

    test('the marker stays while another feature still has a column, and the last owner releases the rules', () => {
        const { host, table } = makeTable();
        syncListingScroll(table);
        table.querySelector('.mwi-enh-profit-cell').remove();
        releaseListingScroll(host);
        expect(host.hasAttribute('data-mwi-listing-scroll')).toBe(true);
        expect(document.getElementById('mwi-market-mobile-layout')).not.toBeNull();
        table.querySelector('.mwi-estimated-age-cell').remove();
        releaseListingScroll(document.documentElement);
        expect(host.hasAttribute('data-mwi-listing-scroll')).toBe(false);
        expect(document.getElementById('mwi-market-mobile-layout')).toBeNull();
    });

    test('release keeps the shared rules while another owner remains', () => {
        ensureMarketMobileStyles();
        const totals = document.createElement('div');
        totals.className = 'mwi-market-order-totals';
        document.body.append(totals);
        releaseMarketMobileStyles();
        expect(document.getElementById('mwi-market-mobile-layout')).not.toBeNull();
        totals.remove();
        releaseMarketMobileStyles();
        expect(document.getElementById('mwi-market-mobile-layout')).toBeNull();
    });

    test('rules install once', () => {
        ensureMarketMobileStyles();
        ensureMarketMobileStyles();
        expect(document.querySelectorAll('#mwi-market-mobile-layout')).toHaveLength(1);
    });
});

describe('trade stats on a phone', () => {
    test('the stats host sizes to its content, not the height of the column it sits in', () => {
        ensureMarketMobileStyles();
        const css = document.getElementById('mwi-market-mobile-layout').textContent;
        const rule = css.match(/\.mwi-volume-stats-mobile-host\s*\{([^}]*)\}/)[1];
        // The game lays the listings area out as a flex column, where a 100% basis is 100% of its height
        expect(rule).not.toMatch(/flex:\s*0 0 100%/);
        expect(rule).toMatch(/flex:\s*0 0 auto/);
    });
});
