#!/usr/bin/env node
/**
 * Split release build, served as the dev file.
 *
 * The released script is a header plus several `@require`d library bundles; the
 * dev build is one bundle and never exercises the wiring between them (see
 * check-bundle-load-order.mjs for a release that broke only there). This joins
 * the release into one file the dev loader can serve, so the pre-release pass
 * runs the real shape on the test server:
 *
 *   header of dist/Toolasha.user.js, minus the library @require lines,
 *     with a unique @version (<release>.<yyyymmddhhmmss>, which the dev loader
 *     reads as the build stamp)
 *   + dist/libraries/toolasha-<name>.js, in the header's @require order
 *   + the body of dist/Toolasha.user.js
 *
 * Usage (after `npm run build`):
 *   node scripts/split-build.mjs            write dist/Toolasha-dev.user.js, keeping the dev build aside
 *   node scripts/split-build.mjs --restore  put the kept dev build back (or rebuild it if none was kept)
 *
 * The split build has no `Toolasha.buildStamp`; that being undefined in the page
 * is the sign it is the one running.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const projectRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(projectRoot, 'dist');
const RELEASE_FILE = join(DIST, 'Toolasha.user.js');
const DEV_FILE = join(DIST, 'Toolasha-dev.user.js');
const KEPT_DEV_FILE = join(DIST, 'Toolasha-dev.pre-split.user.js');
const LIBRARY_DIR = join(DIST, 'libraries');

/** First line of every assembled file, so a second run never keeps a split build as "the dev build" */
export const SPLIT_MARKER = '// Toolasha split release build (scripts/split-build.mjs)';

const HEADER_END = '// ==/UserScript==';
const LIBRARY_REQUIRE = /^\/\/\s*@require\s+\S*\/toolasha-([a-z-]+)\.js\s*$/;

/**
 * Split a userscript into its metadata block and the code after it.
 * @param {string} source - Whole userscript
 * @returns {{header: string, body: string}} `header` ends with the `==/UserScript==` line
 */
export function splitUserscript(source) {
    const end = source.indexOf(HEADER_END);
    if (!source.startsWith('// ==UserScript==') || end < 0) {
        throw new Error('not a userscript: no ==UserScript== block at the top');
    }
    const cut = end + HEADER_END.length;
    return { header: source.slice(0, cut), body: source.slice(cut).replace(/^\r?\n/, '') };
}

/**
 * Library names in the release header's @require order.
 * @param {string} header - The release metadata block
 * @returns {string[]} e.g. ['core', 'utils', 'sim', …]
 */
export function libraryOrder(header) {
    const names = [];
    for (const line of header.split(/\r?\n/)) {
        const m = LIBRARY_REQUIRE.exec(line);
        if (m) names.push(m[1]);
    }
    return names;
}

/**
 * A UTC stamp of 14 digits, the shape the dev loader reads off a @version.
 * @param {Date} date - When the build was assembled
 * @returns {string} yyyymmddhhmmss
 */
export function versionStamp(date) {
    return date.toISOString().replace(/\D/g, '').slice(0, 14);
}

/**
 * Join the release into one file.
 * @param {string} release - Contents of dist/Toolasha.user.js
 * @param {(name: string) => string} readLibrary - Contents of dist/libraries/toolasha-<name>.js
 * @param {Date} [now] - Clock for the @version stamp
 * @returns {{source: string, version: string, libraries: string[]}} The assembled file
 */
export function assembleSplitBuild(release, readLibrary, now = new Date()) {
    const { header, body } = splitUserscript(release);
    const libraries = libraryOrder(header);
    if (libraries.length === 0) throw new Error('the release header @requires no toolasha-*.js libraries');

    const versionMatch = /^(\/\/\s*@version\s+)(\S+)/m.exec(header);
    if (!versionMatch) throw new Error('the release header has no @version');
    const version = `${versionMatch[2]}.${versionStamp(now)}`;

    const devHeader = header
        .split(/\r?\n/)
        .filter((line) => !LIBRARY_REQUIRE.test(line))
        .join('\n')
        .replace(/^(\/\/\s*@version\s+)\S+/m, `$1${version}`);

    const parts = [devHeader, SPLIT_MARKER];
    for (const name of libraries) {
        const code = readLibrary(name);
        if (!code || !code.trim()) throw new Error(`library toolasha-${name}.js is missing or empty`);
        parts.push(`// ---- toolasha-${name}.js ----`, code.replace(/\s+$/, ''));
    }
    parts.push('// ---- Toolasha.user.js body ----', body);
    return { source: `${parts.join('\n')}\n`, version, libraries };
}

/**
 * Whether a file is an assembled split build rather than a dev build.
 * @param {string} source - File contents
 * @returns {boolean} True when it carries the split marker
 */
export function isSplitBuild(source) {
    return source.includes(`\n${SPLIT_MARKER}\n`);
}

function assemble() {
    if (!existsSync(RELEASE_FILE)) throw new Error('dist/Toolasha.user.js is missing: run `npm run build` first');
    const release = readFileSync(RELEASE_FILE, 'utf8');
    const { source, version, libraries } = assembleSplitBuild(release, (name) => {
        const path = join(LIBRARY_DIR, `toolasha-${name}.js`);
        return existsSync(path) ? readFileSync(path, 'utf8') : '';
    });

    // Keep the dev build once; a second run must not keep a split build in its place
    if (existsSync(DEV_FILE) && !isSplitBuild(readFileSync(DEV_FILE, 'utf8'))) {
        copyFileSync(DEV_FILE, KEPT_DEV_FILE);
        console.log('Kept the dev build as dist/Toolasha-dev.pre-split.user.js');
    }
    writeFileSync(DEV_FILE, source);
    console.log(`Wrote dist/Toolasha-dev.user.js: split release ${version} (${libraries.join(', ')})`);
    console.log(
        'Reload the test tab until GM_info / the loader reports this version; Toolasha.buildStamp is undefined.'
    );
    console.log('Afterwards: node scripts/split-build.mjs --restore');
}

function restore() {
    if (existsSync(KEPT_DEV_FILE)) {
        copyFileSync(KEPT_DEV_FILE, DEV_FILE);
        rmSync(KEPT_DEV_FILE);
        console.log('Restored the kept dev build to dist/Toolasha-dev.user.js');
        return;
    }
    if (existsSync(DEV_FILE) && !isSplitBuild(readFileSync(DEV_FILE, 'utf8'))) {
        console.log('dist/Toolasha-dev.user.js is already a dev build; nothing to restore');
        return;
    }
    console.log('No kept dev build: rebuilding with `npm run build:dev`');
    execSync('npm run build:dev', { cwd: projectRoot, stdio: 'inherit' });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    try {
        if (process.argv.includes('--restore')) restore();
        else assemble();
    } catch (error) {
        console.error(`[split-build] ${error.message}`);
        process.exit(1);
    }
}
