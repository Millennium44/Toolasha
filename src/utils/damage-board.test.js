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
import {
    abilityActionLabel,
    abilityBreakdownRows,
    abilityDamageText,
    abilityLineHTML,
    abilityRateText,
    rankRows,
    boardRowHTML,
    boardTabsHTML,
    boardHeadHTML,
    boardLines,
    escapeText,
} from './damage-board.js';

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

describe('a player’s per-ability breakdown', () => {
    const abilities = [
        { action: 'auto', damage: 200_000, hits: 50, crits: 5, misses: 5 },
        { action: '/abilities/fireball', damage: 400_000, hits: 10, crits: 2, misses: 1 },
    ];

    test('ranked by damage with a rate and a share of the player’s own total', () => {
        // The shape both panels draw from — the DPS panel's expandable rows
        // and the trial scoreboard's — pinned here so neither can drift
        const rows = abilityBreakdownRows(abilities, { total: 600_000, seconds: 100 });

        expect(rows.map((row) => row.action)).toEqual(['/abilities/fireball', 'auto']);
        expect(rows.map((row) => row.rank)).toEqual([1, 2]);
        expect(rows[0]).toMatchObject({ damage: 400_000, hits: 10, crits: 2, misses: 1 });
        expect(rows[0].perSecond).toBeCloseTo(4000, 6);
        expect(rows[0].share).toBeCloseTo(66.6667, 3);
    });

    test('no window is no rate, and no total is no share — not zeroes', () => {
        const [row] = abilityBreakdownRows([{ action: 'auto', damage: 10 }], { total: 0, seconds: 0 });
        expect(row.perSecond).toBeNull();
        expect(row.share).toBeNull();
        expect(abilityRateText(row)).toBe('—');
        expect(abilityDamageText(row)).toBe('10');
    });

    test('the figures print as the DPS panel always has', () => {
        const [row] = abilityBreakdownRows([{ action: 'auto', damage: 208_400 }], { total: 587_000, seconds: 3070 });
        expect(abilityRateText(row)).toBe('67.9');
        expect(abilityDamageText(row)).toBe('208.4K (35.5%)');
    });

    test('nothing at all is an empty list, not a crash', () => {
        expect(abilityBreakdownRows(null)).toEqual([]);
        expect(abilityBreakdownRows(undefined, { total: 1, seconds: 1 })).toEqual([]);
    });

    test('a zero-damage ability keeps its row — a miss is a fact about the rotation', () => {
        const rows = abilityBreakdownRows([{ action: '/abilities/poke', damage: 0, misses: 3 }], {
            total: 100,
            seconds: 10,
        });
        expect(rows).toHaveLength(1);
        expect(rows[0].misses).toBe(3);
    });

    test('the line carries the shared figures and escapes the label', () => {
        const [row] = abilityBreakdownRows([{ action: '/abilities/fireball', damage: 208_400 }], {
            total: 587_000,
            seconds: 3070,
        });
        const html = abilityLineHTML(row, { label: 'Fireball <img>' });

        expect(html).toContain('1.');
        expect(html).toContain('Fireball &lt;img&gt;');
        expect(html).toContain('208.4K (35.5%)');
        expect(html).toContain('67.9/s');
        expect(html).not.toContain('<img');
    });

    test('with no label the raw action is shown rather than nothing', () => {
        expect(abilityLineHTML({ action: '/abilities/poke', damage: 1, rank: 1 })).toContain('/abilities/poke');
    });

    test('action names resolve through one rule: markers, game data, then slug', () => {
        expect(abilityActionLabel('auto')).toBe('Auto attack');
        expect(abilityActionLabel('idle')).toBe('No ability');
        expect(abilityActionLabel('/abilities/fireball', { '/abilities/fireball': { name: 'Fireball' } })).toBe(
            'Fireball'
        );
        expect(abilityActionLabel('/abilities/frost_surge')).toBe('frost surge');
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
