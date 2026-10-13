/** @vitest-environment happy-dom */

/**
 * `getSuccessRate`, the alchemy success-rate reader `output-totals.js` uses to
 * scale expected output totals by the panel's own stated rate.
 */

import { describe, test, expect, afterEach } from 'vitest';
import outputTotals from './output-totals.js';
import { _resetGameNumberSeparators } from '../../utils/number-parser.js';

/**
 * A detail panel carrying the success-rate row the game draws.
 * @param {string} rateText - The value text, e.g. "72.5%"
 * @returns {HTMLElement} The panel
 */
function panel(rateText) {
    const root = document.createElement('div');
    root.innerHTML =
        '<div class="SkillActionDetail_successRate__x">' +
        `<div class="SkillActionDetail_value__y">${rateText}</div>` +
        '</div>';
    return root;
}

describe('processChildElement in a comma-decimal locale', () => {
    afterEach(() => {
        localStorage.removeItem('i18nextLng');
        _resetGameNumberSeparators();
    });

    /** A drop row: an output span then a rate span, as the game draws it. */
    function drop(outputText, rateText) {
        const row = document.createElement('div');
        row.innerHTML = `<span>${outputText}</span> <span>${rateText}</span>`;
        document.body.appendChild(row);
        return row;
    }

    test('reads a "7,29%" drop rate and a "1,5" count whole', () => {
        localStorage.setItem('i18nextLng', 'de-DE');
        _resetGameNumberSeparators();
        const clone = outputTotals.processChildElement(drop('1,5', '7,29%'), 100, false, '0.0');
        // 1.5 * 100 * 0.0729 = 10.935
        expect(clone.innerText.replace(/\s/g, '')).toMatch(/^10[.,]9/);
    });

    test('reads a "1,3 - 3,9" range', () => {
        localStorage.setItem('i18nextLng', 'de-DE');
        _resetGameNumberSeparators();
        const clone = outputTotals.processChildElement(drop('1,3 - 3,9', ''), 100, false, '0.0');
        expect(clone.innerText).toMatch(/^130[.,]0 - 390[.,]0/);
    });
});

describe('getSuccessRate', () => {
    test('no success-rate row at all is a rate of 1 (non-alchemy action)', () => {
        expect(outputTotals.getSuccessRate(document.createElement('div'))).toBe(1);
    });

    describe('locale-grouped rates', () => {
        const asLocale = (value) => {
            localStorage.setItem('i18nextLng', value);
            _resetGameNumberSeparators();
        };

        afterEach(() => {
            localStorage.removeItem('i18nextLng');
            _resetGameNumberSeparators();
        });

        test('en-US period decimal', () => {
            asLocale('en-US');
            expect(outputTotals.getSuccessRate(panel('72.5%'))).toBeCloseTo(0.725);
        });

        test('de-DE comma decimal — the bug this replaces', () => {
            // An unconditional `.replace(',', '.')` happened to get this one
            // right by luck; a locale-derived read is not luck.
            asLocale('de-DE');
            expect(outputTotals.getSuccessRate(panel('72,5%'))).toBeCloseTo(0.725);
        });
    });
});
