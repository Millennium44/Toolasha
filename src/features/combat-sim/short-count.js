/**
 * Short counts for Combat Sim's results panel.
 *
 * Encounters/hr, DPS, XP/hr and per-item counts printed in full (`1,234,567`) push the results columns wider than
 * the panel. These read the short form the upgrade tables use (`formatKMB`) from 1,000 up and keep the exact figure
 * on a `title` hover. Under 1,000 the number is printed whole, and an unknown value reads as an em dash, never 0.
 * Sorting, CSV and Copy never read these strings.
 */

import { shortFigure } from './lab-exact-figures.js';
import { formatWithSeparator } from '../../utils/formatters.js';

/**
 * A count rounded to a whole number, short from 1,000 up.
 * @param {*} value - A figure
 * @returns {string} e.g. "12.3K", "999", "-1.5K"; "—" when the value is not a finite number
 */
export function shortCount(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
    return shortFigure(Math.round(value));
}

/**
 * A ` title="..."` attribute carrying the exact whole figure, only where the short form hides digits.
 * @param {*} value - A figure
 * @returns {string} e.g. ` title="12,345"`, or '' under 1,000 and for an unknown value
 */
export function exactTitleAttr(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return '';
    const rounded = Math.round(value);
    return Math.abs(rounded) >= 1000 ? ` title="${formatWithSeparator(rounded)}"` : '';
}
