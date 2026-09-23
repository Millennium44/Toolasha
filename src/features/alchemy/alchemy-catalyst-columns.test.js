/** @vitest-environment happy-dom */

import { describe, it, expect, vi } from 'vitest';
import { renderCatalystColumnHeader, renderCatalystCountCell } from './alchemy-catalyst-columns.js';

describe('renderCatalystColumnHeader', () => {
    it('puts the label on title/aria-label and draws the icon', () => {
        const th = document.createElement('th');
        const labelSpan = document.createElement('span');
        th.appendChild(labelSpan);
        const appendIcon = vi.fn();

        renderCatalystColumnHeader(th, labelSpan, 'Prime Catalyst', '/items/prime_catalyst', appendIcon);

        expect(th.title).toBe('Prime Catalyst');
        expect(th.getAttribute('aria-label')).toBe('Prime Catalyst');
        expect(labelSpan.title).toBe('Prime Catalyst');
        expect(appendIcon).toHaveBeenCalledWith(labelSpan, '/items/prime_catalyst', 20);
    });
});

describe('renderCatalystCountCell', () => {
    it('renders an icon and count for a positive count', () => {
        const cell = document.createElement('td');
        const appendIcon = vi.fn();

        renderCatalystCountCell(cell, '/items/prime_catalyst', 42, appendIcon);

        expect(appendIcon).toHaveBeenCalledWith(expect.any(HTMLElement), '/items/prime_catalyst', 18);
        expect(cell.textContent).toContain('42');
        expect(cell.textContent).not.toContain('undefined');
        expect(cell.textContent).not.toContain('NaN');
    });

    it('renders a dash for a zero count', () => {
        const cell = document.createElement('td');
        const appendIcon = vi.fn();

        renderCatalystCountCell(cell, '/items/prime_catalyst', 0, appendIcon);

        expect(cell.textContent).toBe('—');
        expect(appendIcon).not.toHaveBeenCalled();
    });

    it('renders a dash with an "unknown" tooltip when unrecorded, even if a stray count is passed', () => {
        const cell = document.createElement('td');
        const appendIcon = vi.fn();

        renderCatalystCountCell(cell, '/items/prime_catalyst', 3, appendIcon, { unrecorded: true });

        expect(cell.textContent).toBe('—');
        expect(cell.querySelector('span').title).toMatch(/unknown, not zero/);
    });

    it('marks an estimated count without hiding the number', () => {
        const cell = document.createElement('td');
        const appendIcon = vi.fn();

        renderCatalystCountCell(cell, '/items/catalyst_of_transmutation', 7, appendIcon, { estimated: true });

        expect(cell.textContent).toContain('7');
        expect(cell.textContent).toContain('◇');
    });
});
