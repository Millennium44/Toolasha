/** @vitest-environment happy-dom */

import { describe, test, expect } from 'vitest';
import { signedPercent, shortDuration, drawLine, ROW_COLORS } from './overlay-format.js';

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
