/**
 * Short and exact figures for the Lab Sim's tables.
 *
 * A column of coin costs and coins-per-point printed in full (`5,190,259,500`) is wider than the panel at
 * phone width. The tables print the short form Combat Sim's Cost and per-gold columns use (`formatKMB`, one
 * decimal) and keep the exact number one tap away in the row's expanded detail. Sorting and the CSV export
 * read the raw values, never these strings.
 */

import { formatKMB, formatWithSeparator } from '../../utils/formatters.js';

/** Below this the short form is the whole number, so there is nothing more to show */
const SHORT_FROM = 1000;

/**
 * The short form of a large figure, the formatter Combat Sim's Cost and per-gold columns use.
 * @param {number} value - A finite figure
 * @returns {string} e.g. "715.0M"
 */
export function shortFigure(value) {
    // Under 1,000 the short form is the number itself; formatKMB would round 0.4 to "0"
    return Math.abs(value) < SHORT_FROM ? formatWithSeparator(value) : formatKMB(value);
}

/**
 * Whether a figure is large enough that its short form hides digits.
 * @param {*} value - Any value
 * @returns {boolean}
 */
export function isLargeFigure(value) {
    return Number.isFinite(value) && Math.abs(value) >= SHORT_FROM;
}

/**
 * The exact figures of a row for its expanded detail. Figures that are not large are left out (their cell
 * already says the whole number), and so is anything unknown: an unpriced row has no exact cost to give.
 * @param {Array<{label: string, value: *, unit?: string}>} items - Labelled raw figures
 * @returns {string} HTML, empty when no figure is large
 */
export function exactFiguresHtml(items) {
    const parts = (items || [])
        .filter((item) => isLargeFigure(item.value))
        .map(
            (item) =>
                `<span data-exact-figure>${item.label} <b style="color:#e0e0e0;">${formatWithSeparator(item.value)}</b>` +
                `${item.unit ? ` ${item.unit}` : ''}</span>`
        );
    if (!parts.length) return '';
    return (
        `<div data-exact-figures style="color:#aaa; font-size:11px; margin-bottom:4px;">` +
        `Exact: ${parts.join(' · ')}</div>`
    );
}

/**
 * Make the rows of a block that carry `data-exact-row="id"` open their `data-exact-detail="id"` row on a click.
 * One delegated listener per block, however many times its contents are redrawn.
 * @param {Element} root - The block the rows are in
 */
export function wireExactRows(root) {
    if (root.dataset.exactRowsWired) return;
    root.dataset.exactRowsWired = '1';
    root.addEventListener('click', (event) => {
        const row = event.target.closest?.('tr[data-exact-row]');
        if (!row) return;
        const id = row.getAttribute('data-exact-row');
        const detail = [...root.querySelectorAll('tr[data-exact-detail]')].find(
            (el) => el.getAttribute('data-exact-detail') === id
        );
        if (detail) detail.style.display = detail.style.display === 'none' ? 'table-row' : 'none';
    });
}
