/** @vitest-environment happy-dom */
import { afterEach, describe, expect, test } from 'vitest';
import { ensureMarketMobileStyles, removeMobileListingNotes, syncMobileListingNotes } from './market-mobile-layout.js';

afterEach(() => {
    document.body.innerHTML = '';
    document.getElementById('mwi-market-mobile-layout')?.remove();
});

function makeTable() {
    const table = document.createElement('table');
    table.innerHTML = `<thead><tr><th>Quantity</th><th>Price</th><th class="mwi-enh-profit-header">Profit/h</th><th>Action</th><th class="mwi-estimated-age-header">~Age</th></tr></thead><tbody>
        <tr><td>3</td><td><span class="MarketplacePanel_price__x">17.7M</span></td><td class="mwi-enh-profit-cell" title="Exact profit">45.77K</td><td><button>Buy</button></td><td class="mwi-estimated-age-cell">~14h 8m</td></tr>
        <tr class="MarketplacePanel_outsideRangeSeparator__x"><td colspan="3">Outside range</td><td class="mwi-enh-profit-cell"></td><td class="mwi-estimated-age-cell"></td></tr>
    </tbody>`;
    document.body.append(table);
    return table;
}

describe('mobile order book annotations', () => {
    test('keeps the native numeric text and action handler unchanged while retaining both extra values', () => {
        const table = makeTable();
        const price = table.querySelector('[class*="MarketplacePanel_price"]').parentElement;
        const button = table.querySelector('button');
        let clicks = 0;
        button.addEventListener('click', () => clicks++);
        syncMobileListingNotes(table, 'mwi-enh-profit-cell', 'Profit/h');
        syncMobileListingNotes(table, 'mwi-estimated-age-cell', 'Age');
        expect(price.textContent).toBe('17.7M');
        expect([...price.querySelectorAll('.mwi-market-mobile-note')].map((note) => note.dataset.value)).toEqual([
            '45.77K',
            '~14h 8m',
        ]);
        expect(price.querySelector('[role="note"]').getAttribute('aria-label')).toBe('Profit/h: 45.77K');
        expect(table.querySelector('[class*="outsideRangeSeparator"] .mwi-market-mobile-note')).toBeNull();
        button.click();
        expect(clicks).toBe(1);
    });

    test('rerender replaces notes, cleanup removes only the owning column and the last owner releases CSS', () => {
        const table = makeTable();
        syncMobileListingNotes(table, 'mwi-enh-profit-cell', 'Profit/h');
        syncMobileListingNotes(table, 'mwi-estimated-age-cell', 'Age');
        table.querySelector('.mwi-enh-profit-cell').textContent = 'Unknown';
        syncMobileListingNotes(table, 'mwi-enh-profit-cell', 'Profit/h');
        expect(table.querySelectorAll('[data-mwi-mobile-column="mwi-enh-profit-cell"]')).toHaveLength(1);
        expect(table.querySelector('[data-mwi-mobile-column="mwi-enh-profit-cell"]').dataset.value).toBe('Unknown');
        removeMobileListingNotes(table, 'mwi-enh-profit-cell');
        expect(table.hasAttribute('data-mwi-mobile-mwi-enh-profit-cell')).toBe(false);
        expect(table.querySelectorAll('.mwi-market-mobile-note')).toHaveLength(1);
        expect(document.getElementById('mwi-market-mobile-layout')).not.toBeNull();
        removeMobileListingNotes(table, 'mwi-estimated-age-cell');
        expect(document.getElementById('mwi-market-mobile-layout')).toBeNull();
    });

    test('missing native price cells retain the original column rather than hiding its information', () => {
        const table = makeTable();
        table.querySelector('[class*="MarketplacePanel_price"]').remove();
        syncMobileListingNotes(table, 'mwi-enh-profit-cell', 'Profit/h');
        expect(table.hasAttribute('data-mwi-mobile-mwi-enh-profit-cell')).toBe(false);
        expect(table.querySelector('.mwi-enh-profit-cell').textContent).toBe('45.77K');
    });

    test('rules only collapse columns in the phone media query and install once', () => {
        ensureMarketMobileStyles();
        ensureMarketMobileStyles();
        expect(document.querySelectorAll('#mwi-market-mobile-layout')).toHaveLength(1);
        const rules = document.getElementById('mwi-market-mobile-layout').textContent;
        expect(rules.indexOf('@media (max-width: 768px)')).toBeLessThan(rules.indexOf('table[data-mwi-mobile-'));
        expect(rules).toContain('overflow-x: auto');
    });
});
