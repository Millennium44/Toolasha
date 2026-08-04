/**
 * Results as a CSV file.
 *
 * A ranked table in a panel is read once and closed. The same numbers in a
 * spreadsheet can be sorted three other ways, kept next to last week's run, and
 * shown to somebody else — which is most of what people do with an analysis that
 * took minutes to produce.
 *
 * ## Two values per column, not one
 *
 * The panel shows `1.2B` and `+0.32%`; a spreadsheet needs `1200000000` and
 * `0.0032` or it cannot sort, sum or chart them. So the row objects handed here
 * carry raw numbers and the formatting stays in the panel. A CSV of display
 * strings is a screenshot with extra steps.
 */

/** Leading characters a spreadsheet will treat as the start of a formula */
const FORMULA_START = /^[=@\t\r]/;

/**
 * One cell, quoted only where it has to be.
 *
 * Numbers go out bare so they arrive as numbers. Text that starts like a formula
 * is prefixed with an apostrophe: a cell reading `=cmd|…` is a real attack on
 * whoever opens the file, and no upgrade description needs to be evaluated.
 *
 * @param {*} value - Whatever the row holds
 * @returns {string} CSV-safe cell
 */
export function csvCell(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';

    let text = String(value);
    if (FORMULA_START.test(text)) text = `'${text}`;
    if (/[",\n\r]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
    return text;
}

/**
 * Rows and columns as one CSV document.
 *
 * @param {Array<Object>} rows - The data
 * @param {Array<{key: string, label: string}>} columns - Which fields, in order, and their headings
 * @returns {string} CSV text, CRLF-delimited as the format specifies
 */
export function toCsv(rows, columns) {
    const lines = [columns.map((column) => csvCell(column.label)).join(',')];
    for (const row of rows || []) {
        lines.push(columns.map((column) => csvCell(row?.[column.key])).join(','));
    }
    return lines.join('\r\n');
}

/**
 * A filename with the moment in it.
 *
 * Two exports of the same table on the same day is the normal case — before and
 * after buying something — and `results.csv` and `results (1).csv` do not say
 * which is which.
 *
 * @param {string} stem - e.g. `labsim-upgrades`
 * @param {Date} [now] - Injectable for tests
 * @returns {string} e.g. `toolasha-labsim-upgrades-20260803-2214.csv`
 */
export function csvFilename(stem, now = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    const stamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
        `-${pad(now.getHours())}${pad(now.getMinutes())}`;
    return `toolasha-${stem}-${stamp}.csv`;
}

/**
 * Save a CSV to the user's downloads.
 *
 * A BOM in front, because Excel reads a UTF-8 file without one as the local
 * ANSI codepage and turns every `→` and `−` in a description into mojibake.
 *
 * @param {string} filename - From `csvFilename`
 * @param {string} csv - From `toCsv`
 * @param {Document} [doc] - Injectable for tests
 * @returns {boolean} False when the browser would not take it
 */
export function downloadCsv(filename, csv, doc = typeof document !== 'undefined' ? document : null) {
    // The BOM is for Excel, which reads a UTF-8 file without one as the local
    // ANSI codepage and turns every arrow in a description into mojibake
    return downloadFile(filename, '\ufeff' + csv, 'text/csv;charset=utf-8;', doc);
}

/**
 * Save any text to the user's downloads.
 *
 * The same anchor trick as the CSV export, without the spreadsheet's opinions
 * about encoding — a performance trace is read by a person or a parser, neither
 * of which wants a byte-order mark in front of it.
 *
 * @param {string} filename - What to call it
 * @param {string} text - The contents
 * @param {string} [mime] - Content type
 * @param {Document} [doc] - Injectable for tests
 * @returns {boolean} False when the browser would not take it
 */
export function downloadFile(
    filename,
    text,
    mime = 'text/plain;charset=utf-8;',
    doc = typeof document !== 'undefined' ? document : null
) {
    if (!doc) return false;
    try {
        const blob = new Blob([text], { type: mime });
        const url = URL.createObjectURL(blob);
        const link = doc.createElement('a');
        link.href = url;
        link.download = filename;
        link.style.display = 'none';
        doc.body.appendChild(link);
        link.click();
        link.remove();
        // Revoking immediately can beat the download in some browsers
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        return true;
    } catch (error) {
        console.error('[CsvExport] Saving the file failed:', error);
        return false;
    }
}
