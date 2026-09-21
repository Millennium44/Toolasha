/**
 * Every `@require` must be a classic script, and must actually exist.
 *
 * A userscript's `@require` is evaluated as a classic script. Hand it an ES
 * module and the engine refuses the whole file with "import declarations may
 * only appear at top level of a module" — which aborts the *userscript*, not
 * just the library, so nothing loads and the only clue is a parse error with
 * no mention of the script that caused it.
 *
 * This is not hypothetical. Chart.js 4 renamed its UMD build: `dist/chart.js`
 * became ESM and the classic build moved to `dist/chart.umd.js`. Bumping the
 * pin from 3.7.0 to 4.5.1 kept the old `dist/chart.min.js` path, which still
 * answered 200 — jsDelivr happily minifies the ESM file under that name — so
 * a URL check that only looked at the status code passed, and 3.57.0 shipped
 * dead to every user. Checking the status code is not checking the file.
 */

import fs from 'node:fs';

/** The files that carry the `@require` lines users actually load. */
const HEADERS = ['userscript-header.txt', 'library-headers/entrypoint.txt'];

/** Only remote libraries are fetched; the build rewrites this placeholder itself. */
const SKIP = 'https://UPDATE-THIS-URL/';

/**
 * The `@require` URLs declared in a header file.
 * @param {string} path - Header file to read
 * @returns {Array<string>} Absolute URLs, in declaration order
 */
function requireUrls(path) {
    const text = fs.readFileSync(path, 'utf8');
    return [...text.matchAll(/^\/\/\s*@require\s+(\S+)/gm)].map((m) => m[1]).filter((url) => !url.startsWith(SKIP));
}

/**
 * Whether a body is an ES module rather than a classic script.
 *
 * Deliberately crude: a top-level `import`/`export` at the start of a line is
 * what the engine refuses, and a minified bundle puts its first statement
 * there. Substring matches inside code (`.import(`, `"export"`) are not.
 *
 * @param {string} body - The fetched file
 * @returns {string|null} The offending line, or null when it is a classic script
 */
function moduleSyntax(body) {
    for (const line of body.split('\n', 40)) {
        if (/^\s*(import[\s{'"*]|export[\s{*])/.test(line)) return line.slice(0, 80);
    }
    return null;
}

const failures = [];
for (const header of HEADERS) {
    for (const url of requireUrls(header)) {
        let response;
        try {
            response = await fetch(url);
        } catch (error) {
            failures.push(`${header}: ${url}\n    could not be fetched: ${error.message}`);
            continue;
        }
        if (!response.ok) {
            failures.push(`${header}: ${url}\n    HTTP ${response.status}`);
            continue;
        }
        const offending = moduleSyntax(await response.text());
        if (offending) {
            failures.push(
                `${header}: ${url}\n    is an ES module, not a classic script — a @require of this aborts the whole userscript` +
                    `\n    first module statement: ${offending}`
            );
        }
    }
}

if (failures.length) {
    console.error('[check-require-urls] FAILED:\n' + failures.map((f) => `  ${f}`).join('\n'));
    process.exit(1);
}
console.log('[check-require-urls] OK: every @require resolves and is a classic script.');
