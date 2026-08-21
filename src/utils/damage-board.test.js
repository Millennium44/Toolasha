/**
 * The ranked board both damage panels draw with.
 *
 * The arithmetic is the ranking, and it is worth testing because two panels now
 * depend on it agreeing with itself: a share the trial panel computes one way
 * and the run panel another is two boards that cannot be compared. The markup
 * is tested only where it makes a claim — an estimate must not be readable as a
 * measurement, and a name off the wire must not reach the markup.
 */

import { describe, test, expect } from 'vitest';
import { rankRows, boardRowHTML, boardTabsHTML, boardHeadHTML, boardLines, escapeText } from './damage-board.js';

describe('ranking a tab', () => {
    test('biggest first, ranked from one, shares over the rows shown', () => {
        const { rows, total, perSecond } = rankRows(
            [
                { name: 'Bob', value: 250 },
                { name: 'Alice', value: 750 },
            ],
            10
        );

        expect(rows.map((row) => row.name)).toEqual(['Alice', 'Bob']);
        expect(rows.map((row) => row.rank)).toEqual([1, 2]);
        expect(rows[0].share).toBeCloseTo(75, 9);
        expect(total).toBe(1000);
        expect(perSecond).toBe(100);
    });

    test('a row with nothing in it is dropped rather than ranked at zero', () => {
        // A healer on the damage tab is a zero-length bar and a rank nobody
        // wanted
        expect(
            rankRows(
                [
                    { name: 'Alice', value: 10 },
                    { name: 'Healer', value: 0 },
                ],
                5
            ).rows
        ).toHaveLength(1);
    });

    test('a rate the source refused to state is not invented here', () => {
        // null means "not enough of a run to divide by", which is a different
        // statement from a rate of nothing
        const { rows } = rankRows([{ name: 'Alice', value: 100, perSecond: null }], 10);
        expect(rows[0].perSecond).toBeNull();
    });

    test('a rate the source did not mention is derived from the elapsed seconds', () => {
        expect(rankRows([{ name: 'Alice', value: 100 }], 10).rows[0].perSecond).toBe(10);
    });

    test('no elapsed time dashes the rate rather than dividing by nothing', () => {
        expect(rankRows([{ name: 'Alice', value: 100 }], 0).rows[0].perSecond).toBeNull();
        expect(rankRows([{ name: 'Alice', value: 100 }], 0).perSecond).toBeNull();
    });

    test('nothing at all is an empty board, not a crash', () => {
        expect(rankRows(null).rows).toEqual([]);
        expect(rankRows([]).total).toBe(0);
    });

    test('fields the caller put on a row survive the ranking', () => {
        // The trial panel hangs `index` and `measured` off its rows and reads
        // them back after
        expect(rankRows([{ name: 'Alice', value: 1, index: '3' }], 1).rows[0].index).toBe('3');
    });
});

describe('one row', () => {
    test('a measured row states its total and its rate', () => {
        const html = boardRowHTML({ name: 'Alice', value: 12_400, perSecond: 1240, share: 22.3, rank: 1 });

        expect(html).toContain('Alice');
        expect(html).toContain('12.4K');
        expect(html).toContain('1.2K/s');
        expect(html).toContain('22.3%');
        expect(html).not.toContain('~');
    });

    test('an estimated row carries a tilde and says so', () => {
        // There is no elapsed fight to have accumulated a total, so the rate is
        // the whole figure and must not read as a measurement
        const html = boardRowHTML({ name: 'Alice', value: null, perSecond: 900, share: 50, rank: 1 });

        expect(html).toContain('~900/s');
        expect(html).toContain('estimated');
    });

    test('a row folded in beside a streamed one says it is partial', () => {
        expect(boardRowHTML({ name: 'Alice', value: 10, perSecond: 1, measured: false, rank: 1 })).toContain('partial');
    });

    test('an authoritative row shows the plugin’s own figure and the gap', () => {
        const html = boardRowHTML({
            name: 'Alice',
            value: 1000,
            perSecond: null,
            measuredValue: 800,
            measuredDeltaPct: -20,
            rank: 1,
        });

        expect(html).toContain('meas 800');
        expect(html).toContain('20%');
    });

    test('a name off the wire cannot reach the markup', () => {
        const html = boardRowHTML({ name: '<img src=x onerror=alert(1)>', value: 1, rank: 1 });

        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
    });

    test('a share of nothing dashes rather than drawing a zero bar as a figure', () => {
        expect(boardRowHTML({ name: 'Alice', value: 1, share: null, rank: 1 })).toContain('>—<');
    });
});

describe('the rest of the shell', () => {
    test('the active tab is the only one drawn in the accent', () => {
        const html = boardTabsHTML(
            [
                { key: 'damage', label: 'Damage' },
                { key: 'taken', label: 'Taken' },
            ],
            'taken'
        );

        expect(html).toContain('data-tab="damage"');
        expect(html).toContain('data-tab="taken"');
        expect(html.split('rgba(143,211,255,0.15)')).toHaveLength(2);
    });

    test('a headline with no figure dashes rather than showing a zero', () => {
        expect(boardHeadHTML({ value: null, label: 'party dps' })).toContain('>—<');
    });

    test('a headline’s right-hand side takes a count as written and a total as a figure', () => {
        // "3/5 builds" is not a quantity and rounding it would be wrong
        expect(boardHeadHTML({ value: 1, label: 'x', right: '3/5 builds' })).toContain('3/5 builds');
        expect(boardHeadHTML({ value: 1, label: 'x', right: 12_400 })).toContain('12.4K');
    });

    test('the clipboard form is the same table in one column', () => {
        const { rows } = rankRows(
            [
                { name: 'Alice', value: 750 },
                { name: 'Bob', value: 250 },
            ],
            10
        );
        const text = boardLines('Party damage', rows).split('\n');

        expect(text[0]).toBe('Party damage');
        expect(text[1]).toBe('1. Alice — 750 (75/s, 75.0%)');
        expect(text[2]).toBe('2. Bob — 250 (25/s, 25.0%)');
    });

    test('escaping covers the four characters that matter', () => {
        expect(escapeText('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
        expect(escapeText(null)).toBe('');
    });
});
