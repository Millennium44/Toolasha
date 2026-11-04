import { describe, test, expect } from 'vitest';
import {
    labCardEntries,
    dashToUnknown,
    isWorstFirst,
    singleFightHeaderSort,
    SINGLE_FIGHT_BEST_DIR,
} from './lab-upgrade-cards.js';

describe('lab upgrade cards, the pure half', () => {
    test('a dash reads unknown; a figure, free and a credit are left alone', () => {
        expect(dashToUnknown('—')).toBe('unknown');
        expect(dashToUnknown('')).toBe('unknown');
        expect(dashToUnknown(undefined)).toBe('unknown');
        expect(dashToUnknown('free')).toBe('free');
        expect(dashToUnknown('0')).toBe('0');
        expect(dashToUnknown('+17.7M back')).toBe('+17.7M back');
    });

    test('entries keep the table order, lead with the sorted column and print the table text', () => {
        const rows = [
            { desc: 'B', costStr: '2.0M', deltaStr: '+2.00%' },
            { desc: 'A', costStr: '1.0M', deltaStr: '+5.00%' },
        ];
        const columns = [
            { key: 'cost', label: 'Cost', band: 'face', html: (r) => r.costStr },
            { key: 'deltaVal', label: 'Delta', band: 'delta', html: (r) => r.deltaStr },
        ];
        const entries = labCardEntries({
            rows,
            columns,
            headKey: 'deltaVal',
            fallbackHead: 'deltaVal',
            nameOf: (r) => r.desc,
            keyOf: (r) => r.desc,
        });
        expect(entries.map((e) => e.name)).toEqual(['B', 'A']);
        expect(entries[0].row).toBe(rows[0]);
        expect(entries[0].headline.html).toBe('+2.00%');
        expect(entries[0].lines[0].map((f) => f.html)).toEqual(['2.0M']);
        // The head is not repeated
        expect(entries[0].lines[1]).toEqual([]);
        // Ordered by name there is no figure to lead with: the fallback does
        const byName = labCardEntries({
            rows,
            columns,
            headKey: 'desc',
            fallbackHead: 'cost',
            nameOf: (r) => r.desc,
            keyOf: (r) => r.desc,
        });
        expect(byName[0].headline.html).toBe('2.0M');
    });

    test('a figure a row does not have is left out, and a function label can depend on the row', () => {
        const entries = labCardEntries({
            rows: [{ n: 'x', clear: true }],
            columns: [
                { key: 'a', label: (r) => (r.clear ? 'Clear rate' : 'Win rate'), band: 'face', html: () => '42%' },
                { key: 'b', label: 'Hidden', band: 'face', html: () => '1', show: () => false },
            ],
            headKey: 'zzz',
            fallbackHead: 'zzz',
            nameOf: (r) => r.n,
            keyOf: (r) => r.n,
        });
        expect(entries[0].lines[0].map((f) => f.label)).toEqual(['Clear rate']);
        expect(entries[0].headline).toBeNull();
    });

    test('a header click starts a new column descending and the name ascending; worst first is judged against the good end', () => {
        expect(singleFightHeaderSort('cost')).toEqual({ key: 'cost', dir: 'desc' });
        expect(singleFightHeaderSort('desc')).toEqual({ key: 'desc', dir: 'asc' });
        expect(isWorstFirst({ key: 'cost', dir: 'desc' }, SINGLE_FIGHT_BEST_DIR)).toBe(true);
        expect(isWorstFirst({ key: 'cost', dir: 'asc' }, SINGLE_FIGHT_BEST_DIR)).toBe(false);
        expect(isWorstFirst({ key: 'deltaVal', dir: 'desc' }, SINGLE_FIGHT_BEST_DIR)).toBe(false);
        // A column with no stated good end is never called worst-first
        expect(isWorstFirst({ key: 'nope', dir: 'asc' }, SINGLE_FIGHT_BEST_DIR)).toBe(false);
        expect(isWorstFirst(null, SINGLE_FIGHT_BEST_DIR)).toBe(false);
    });
});
