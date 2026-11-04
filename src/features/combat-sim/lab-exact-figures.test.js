// @vitest-environment happy-dom
import { describe, test, expect } from 'vitest';
import { shortFigure, isLargeFigure, exactFiguresHtml, wireExactRows } from './lab-exact-figures.js';

describe('lab exact figures', () => {
    test('the short form is the one Combat Sim uses for Cost and per-gold columns', () => {
        expect(shortFigure(715_000_000)).toBe('715.0M');
        expect(shortFigure(5_190_259_500)).toBe('5.2B');
        expect(shortFigure(139_763_077)).toBe('139.8M');
        expect(shortFigure(950)).toBe('950');
    });

    test('only a large, known figure gets an exact line', () => {
        expect(isLargeFigure(999)).toBe(false);
        expect(isLargeFigure(1000)).toBe(true);
        expect(isLargeFigure(null)).toBe(false);
        expect(isLargeFigure(Infinity)).toBe(false);
        expect(
            exactFiguresHtml([
                { label: 'Cost', value: null },
                { label: 'Gold/1%', value: Infinity },
            ])
        ).toBe('');
        expect(exactFiguresHtml([{ label: 'Cost', value: 12 }])).toBe('');
        const html = exactFiguresHtml([{ label: 'Cost', value: 715_000_000, unit: 'coins' }]);
        expect(html).toContain('Cost <b style="color:#e0e0e0;">715,000,000</b> coins');
    });

    test('rows open their detail, and wiring twice does not toggle twice', () => {
        const root = document.createElement('div');
        root.innerHTML =
            '<table><tr data-exact-row="a"><td>x</td></tr><tr data-exact-detail="a" style="display:none;"><td>y</td></tr></table>';
        wireExactRows(root);
        wireExactRows(root);
        const detail = root.querySelector('[data-exact-detail]');
        root.querySelector('[data-exact-row]').click();
        expect(detail.style.display).toBe('table-row');
        root.querySelector('[data-exact-row]').click();
        expect(detail.style.display).toBe('none');
    });
});
