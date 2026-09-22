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
import process from 'node:process';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

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
 * Why a response body cannot be used as a classic script.
 *
 * Parse the whole response with the same Script grammar an `@require` uses.
 * A line regex can mistake prose inside a block comment for module syntax and
 * can miss an `export` after a long licence header; parsing also catches CDN
 * error pages and truncated bundles that happen to arrive with HTTP 200.
 *
 * @param {string} body - The fetched file
 * @returns {string|null} The parse problem, or null when it is a classic script
 */
export function classicScriptError(body) {
    if (!body.trim()) return 'response body is empty';
    try {
        new vm.Script(body, { filename: '@require response' });
        return null;
    } catch (error) {
        return `does not parse as a classic script: ${error.message}`;
    }
}

/**
 * Why a fetch response is not a complete JavaScript resource.
 * @param {Response|{status: number, headers: Headers}} response - Fetch response
 * @returns {string|null} The response problem, or null when its body should be parsed
 */
export function responseError(response) {
    if (response.status !== 200)
        return `HTTP ${response.status}${response.status === 206 ? ' (partial response)' : ''}`;
    const contentType = response.headers.get('content-type')?.toLowerCase() || '';
    if (
        contentType.includes('text/html') ||
        contentType.includes('application/xhtml+xml') ||
        contentType.includes('application/json')
    ) {
        return `unexpected content type ${contentType}`;
    }
    return null;
}

async function main() {
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
            const fetchedError = responseError(response);
            if (fetchedError) {
                failures.push(`${header}: ${url}\n    ${fetchedError}`);
                continue;
            }
            const parseError = classicScriptError(await response.text());
            if (parseError) failures.push(`${header}: ${url}\n    ${parseError}`);
        }
    }

    if (failures.length) {
        console.error('[check-require-urls] FAILED:\n' + failures.map((failure) => `  ${failure}`).join('\n'));
        process.exitCode = 1;
        return;
    }
    console.log('[check-require-urls] OK: every @require resolves and is a complete classic script.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    await main();
}
