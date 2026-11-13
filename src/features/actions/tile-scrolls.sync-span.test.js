/**
 * The tiles arm the scroll simulation for the span of one synchronous call (`runWithTileScrolls`) and rely on
 * the profit and XP calculators finishing their arithmetic before their first await: an await inside them would
 * let the span end (restoring "no scrolls") while the figure is still being computed, and the tile would show a
 * real figure labeled as simulated. This pins that assumption where it lives, so adding an await to one of the
 * calculators fails here rather than silently on the page.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (relative) => readFileSync(new URL(relative, import.meta.url), 'utf8');

/** The text from `start` to the next marker (or the end), comments removed */
function body(source, start, endMarker) {
    const from = source.indexOf(start);
    expect(from, `${start} not found`).toBeGreaterThanOrEqual(0);
    const to = endMarker ? source.indexOf(endMarker, from + start.length) : -1;
    const text = source.slice(from, to === -1 ? undefined : to);
    return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('the calculators the tiles arm around', () => {
    test('calculateGatheringProfit has no await', () => {
        const text = body(read('./gathering-profit.js'), 'export async function calculateGatheringProfit', '\nexport ');
        expect(text).not.toMatch(/\bawait\b/);
    });

    test('calculateProductionProfit awaits only the profit calculator call itself', () => {
        const text = body(
            read('./production-profit.js'),
            'export async function calculateProductionProfit',
            '\nexport '
        );
        const awaits = text.match(/\bawait\b[^\n]*/g) ?? [];
        expect(awaits).toHaveLength(1);
        expect(awaits[0]).toContain('profitCalculator.calculateProfit(');
    });

    test('the profit calculator method it awaits has no await of its own', () => {
        const text = body(read('../market/profit-calculator.js'), '    async calculateProfit(', '\n    /**');
        expect(text).not.toMatch(/\bawait\b/);
    });

    test('calculateExpPerHour is synchronous', () => {
        const text = body(
            read('../../utils/experience-calculator.js'),
            'export function calculateExpPerHour',
            '\nexport '
        );
        expect(text).not.toMatch(/\basync\b|\bawait\b/);
    });
});
