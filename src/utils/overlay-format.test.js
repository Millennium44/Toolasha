/** @vitest-environment happy-dom */

import { describe, test, expect } from 'vitest';
import { signedPercent, shortDuration, drawLine, rows, ROW_COLORS } from './overlay-format.js';

describe('signedPercent', () => {
    test('signs both directions', () => {
        expect(signedPercent(12.34).text).toBe('+12.3%');
        expect(signedPercent(-12.34).text).toBe('-12.3%');
    });

    test('a couple of percent either way is not news', () => {
        // Everything sits slightly off whatever it is compared with; colouring
        // that makes a row into a light that is always on
        expect(signedPercent(2).color).toBe(ROW_COLORS.dim);
        expect(signedPercent(-2).color).toBe(ROW_COLORS.dim);
        expect(signedPercent(20).color).toBe(ROW_COLORS.good);
        expect(signedPercent(-20).color).toBe(ROW_COLORS.bad);
    });

    test('the band can be widened for a noisier figure', () => {
        expect(signedPercent(8, 10).color).toBe(ROW_COLORS.dim);
    });
});

describe('shortDuration', () => {
    test('never uses more than two units', () => {
        // "71 days 9h 55m" pushed the label beside it down to a single letter
        expect(shortDuration(45)).toBe('45s');
        expect(shortDuration(12 * 60)).toBe('12m');
        expect(shortDuration(3 * 3600 + 20 * 60)).toBe('3h 20m');
        expect(shortDuration(4 * 86400 + 16 * 3600)).toBe('4d 16h');
    });

    test('drops the small unit once it is noise', () => {
        expect(shortDuration(71 * 86400 + 9 * 3600)).toBe('71d');
        expect(shortDuration(2 * 3600)).toBe('2h');
        expect(shortDuration(5 * 86400)).toBe('5d');
    });

    test('nothing measurable says so rather than showing zero', () => {
        expect(shortDuration(Infinity)).toBe('—');
        expect(shortDuration(NaN)).toBe('—');
        expect(shortDuration(-5)).toBe('—');
    });
});

describe('drawLine', () => {
    test('skips nulls so a segment can be conditional', () => {
        const host = document.createElement('div');
        drawLine(host, [{ text: 'a' }, null, { text: 'b' }]);
        expect(host.children).toHaveLength(2);
    });

    test('an icon segment draws an element rather than its hrid as text', () => {
        const host = document.createElement('div');
        drawLine(host, [{ icon: '/items/smack_book', size: 18 }, { text: '43' }]);

        // Without the game's sprite sheet loaded this is a spacer, but the point
        // stands either way: the hrid must never end up as visible text
        expect(host.children).toHaveLength(2);
        expect(host.textContent).toBe('43');
    });

    test('a line with an icon centres, and one without keeps its baseline', () => {
        // An icon is a box with no baseline. Against baselined text it sits low
        // and the phrase reads as two things at different heights.
        const withIcon = document.createElement('div');
        drawLine(withIcon, [{ icon: '/items/smack_book' }, { text: '43' }]);
        expect(withIcon.style.alignItems).toBe('center');

        const textOnly = document.createElement('div');
        drawLine(textOnly, [{ text: '43' }, { text: 'books' }]);
        expect(textOnly.style.alignItems).toBe('baseline');
    });

    test('only the ellipsis segment is allowed to shrink', () => {
        // A truncated number is not a smaller number, it is a wrong one
        const host = document.createElement('div');
        drawLine(host, [{ text: 'Penetrating Strike', ellipsis: true }, { text: '12.0M' }]);

        expect(host.children[0].style.textOverflow).toBe('ellipsis');
        expect(host.children[1].style.flex).toBe('0 0 auto');
    });
});

describe('aligned rows', () => {
    /**
     * @param {Array} lines - Segment arrays
     * @param {Object} [options] - Passed through
     * @returns {HTMLElement}
     */
    const build = (lines, options) => {
        const container = document.createElement('div');
        rows(container, lines, options);
        return container;
    };

    test('the lines share columns, so a short line still lines up', () => {
        // A player row carries three figures and the total carries two; the
        // total belongs under the figure it totals, not at the far edge
        const container = build(
            [
                [{ text: 'You' }, { text: '539.5' }, { text: '96.8%' }],
                [{ text: 'Total' }, { text: '539.5' }],
            ],
            { align: true }
        );

        expect(container.style.display).toBe('grid');
        // Three columns, six cells: the short line is padded rather than ragged
        expect(container.children).toHaveLength(6);
        expect(container.children[4].textContent).toBe('539.5');
        expect(container.children[5].textContent).toBe('');
    });

    test('the first column takes the slack and the figures sit right', () => {
        const container = build([[{ text: 'You' }, { text: '1' }]], { align: true });

        expect(container.style.gridTemplateColumns).toContain('minmax(0, 1fr)');
        expect(container.children[0].style.textAlign).toBe('left');
        expect(container.children[1].style.textAlign).toBe('right');
    });

    test('only the name may be cut, never a figure', () => {
        // "1.2…" reads as a number rather than as a truncation
        const container = build([[{ text: 'A very long name indeed' }, { text: '539.5' }]], { align: true });

        expect(container.children[0].style.textOverflow).toBe('ellipsis');
        expect(container.children[1].style.textOverflow).toBe('clip');
    });

    test('the lines start at the top rather than centred', () => {
        // These tiles sit beside each other with different numbers of lines;
        // centring puts the one line of a Luck tile halfway down the two lines
        // of the DPS tile next to it
        expect(build([[{ text: 'a' }, { text: '1' }]], { align: true }).style.alignContent).toBe('start');
    });

    test('digits are one width, so a column does not shift as it counts', () => {
        expect(build([[{ text: 'a' }, { text: '1' }]], { align: true }).style.fontVariantNumeric).toBe('tabular-nums');
    });

    test('a tile with an icon keeps the independent layout', () => {
        // An icon has no width until it loads, so it cannot size a column
        const container = build([[{ icon: '/items/coin' }, { text: '5' }], [{ text: 'x' }]], { align: true });

        expect(container.style.display).toBe('flex');
    });

    test('without the option nothing changes', () => {
        const container = build([[{ text: 'a' }], [{ text: 'b' }]]);

        expect(container.style.display).toBe('flex');
        expect(container.children).toHaveLength(2);
    });
});
