/** @vitest-environment happy-dom
 *
 * Results as a CSV file.
 *
 * The DOM environment is here for `downloadCsv` alone — the rest is string
 * handling, and the parts worth testing are the ones a spreadsheet is fussy
 * about: quoting, formulas, and numbers arriving as numbers.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { csvCell, toCsv, csvFilename, downloadCsv } from './csv-export.js';

describe('one cell at a time', () => {
    test('plain text needs no quoting', () => {
        expect(csvCell('Fine Sword')).toBe('Fine Sword');
    });

    test('a comma does', () => {
        expect(csvCell('Sword, Fine')).toBe('"Sword, Fine"');
    });

    test('and a quote is doubled inside the quoting', () => {
        expect(csvCell('the "best" sword')).toBe('"the ""best"" sword"');
    });

    test('a newline keeps the row from breaking in two', () => {
        expect(csvCell('two\nlines')).toBe('"two\nlines"');
    });

    test('numbers go out bare, so they arrive as numbers', () => {
        expect(csvCell(1_200_000_000)).toBe('1200000000');
        expect(csvCell(-0.0032)).toBe('-0.0032');
    });

    test('an infinity is blank rather than the word', () => {
        // "Infinity" in a numeric column makes the whole column text
        expect(csvCell(Infinity)).toBe('');
    });

    test('nothing is empty rather than "undefined"', () => {
        expect(csvCell(undefined)).toBe('');
        expect(csvCell(null)).toBe('');
    });

    test('text that starts like a formula is defused', () => {
        // A cell beginning `=` is executed on open by every major spreadsheet
        expect(csvCell('=1+1')).toBe("'=1+1");
        expect(csvCell('@SUM(A1)')).toBe("'@SUM(A1)");
    });

    test('text starting with + or - is also a formula opener and gets defused', () => {
        // Excel and Google Sheets treat +, -, and @ the same as = at the start of a
        // cell — all four are documented CSV-injection vectors (OWASP). A text field
        // is never a number just because it starts with a sign, so this has to be
        // escaped the same way `=`/`@` are, above.
        // The inner comma also triggers the normal CSV quoting, same as any other cell
        expect(csvCell('+SUM(1,1)')).toBe('"\'+SUM(1,1)"');
        expect(csvCell('-2+3+cmd|/C calc!A0')).toBe("'-2+3+cmd|/C calc!A0");
    });

    test('but a signed number is a number, not a formula', () => {
        expect(csvCell(-5)).toBe('-5');
    });
});

describe('the whole document', () => {
    const columns = [
        { key: 'name', label: 'Upgrade' },
        { key: 'cost', label: 'Cost' },
    ];

    test('headers first, then a row each', () => {
        const csv = toCsv([{ name: 'Sword', cost: 100 }], columns);

        expect(csv).toBe('Upgrade,Cost\r\nSword,100');
    });

    test('a missing field is an empty cell, not a shifted row', () => {
        const csv = toCsv([{ name: 'Sword' }], columns);

        expect(csv).toBe('Upgrade,Cost\r\nSword,');
    });

    test('no rows is still a usable file with its headers', () => {
        expect(toCsv([], columns)).toBe('Upgrade,Cost');
        expect(toCsv(null, columns)).toBe('Upgrade,Cost');
    });
});

describe('what it is called', () => {
    test('the moment is in the name, since the same table is exported twice', () => {
        const name = csvFilename('labsim-upgrades', new Date(2026, 7, 3, 22, 14));

        expect(name).toBe('toolasha-labsim-upgrades-20260803-2214.csv');
    });

    test('single digits are padded, so names sort in time order', () => {
        expect(csvFilename('x', new Date(2026, 0, 5, 9, 7))).toBe('toolasha-x-20260105-0907.csv');
    });
});

describe('handing it to the browser', () => {
    let clicked;

    beforeEach(() => {
        clicked = null;
        globalThis.URL.createObjectURL = vi.fn(() => 'blob:test');
        globalThis.URL.revokeObjectURL = vi.fn();
        // happy-dom does not navigate on a download click; catching it here is
        // what proves the anchor was actually clicked
        HTMLAnchorElement.prototype.click = function () {
            clicked = this;
        };
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    test('a click on an anchor carrying the filename', () => {
        expect(downloadCsv('out.csv', 'a,b')).toBe(true);
        expect(clicked.download).toBe('out.csv');
        expect(clicked.href).toBe('blob:test');
    });

    test('and the anchor does not stay in the page', () => {
        downloadCsv('out.csv', 'a,b');

        expect(document.querySelectorAll('a[download]').length).toBe(0);
    });

    test('a browser that refuses says so rather than throwing at the caller', () => {
        globalThis.URL.createObjectURL = vi.fn(() => {
            throw new Error('nope');
        });
        vi.spyOn(console, 'error').mockImplementation(() => {});

        expect(downloadCsv('out.csv', 'a,b')).toBe(false);
    });

    test('no document at all is a false, not a crash', () => {
        expect(downloadCsv('out.csv', 'a,b', null)).toBe(false);
    });
});
