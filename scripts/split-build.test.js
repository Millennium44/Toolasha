import { describe, expect, test } from 'vitest';
import {
    SPLIT_MARKER,
    assembleSplitBuild,
    isSplitBuild,
    libraryOrder,
    splitUserscript,
    versionStamp,
} from './split-build.mjs';

const RELEASE = [
    '// ==UserScript==',
    '// @name         Toolasha (Millennium44)',
    '// @version      3.84.0',
    '// @grant        GM_getValue',
    '// @require      https://cdn.jsdelivr.net/npm/chart.js@4.6.1/dist/chart.umd.js',
    '// @require      https://UPDATE-THIS-URL/toolasha-core.js',
    '// @require      https://UPDATE-THIS-URL/toolasha-utils.js',
    '// @require      https://cdn.jsdelivr.net/gh/x/y@abc/dist/libraries/toolasha-ui.js',
    '// ==/UserScript==',
    '',
    '(function(){ entry(); })();',
    '',
].join('\n');

const LIBS = { core: 'core();', utils: 'utils();\n\n', ui: 'ui();' };

describe('split build', () => {
    test('reads the library order from the @require lines, CDN or placeholder', () => {
        expect(libraryOrder(splitUserscript(RELEASE).header)).toEqual(['core', 'utils', 'ui']);
    });

    test('joins header, libraries in order, then the release body', () => {
        const { source, version } = assembleSplitBuild(RELEASE, (n) => LIBS[n], new Date('2026-11-11T18:04:45Z'));
        expect(version).toBe('3.84.0.20261111180445');
        expect(source).toMatch(/^\/\/ @version\s+3\.84\.0\.20261111180445$/m);
        expect(source).not.toMatch(/@require\s+\S*toolasha-/);
        // Third-party @requires stay
        expect(source).toContain('chart.umd.js');
        const order = ['core();', 'utils();', 'ui();', 'entry();'].map((s) => source.indexOf(s));
        expect(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1]))).toBe(true);
        expect(source.indexOf('// ==/UserScript==')).toBeLessThan(source.indexOf(SPLIT_MARKER));
        expect(isSplitBuild(source)).toBe(true);
    });

    test('a dev build is not mistaken for a split build', () => {
        expect(isSplitBuild(RELEASE)).toBe(false);
    });

    test('refuses a missing library rather than writing a script that dies on load', () => {
        expect(() => assembleSplitBuild(RELEASE, (n) => (n === 'utils' ? '' : LIBS[n]))).toThrow(/toolasha-utils/);
    });

    test('refuses a file with no userscript header or no libraries', () => {
        expect(() => assembleSplitBuild('code();', () => '')).toThrow(/not a userscript/);
        const bare = RELEASE.replace(/^\/\/ @require\s+\S*toolasha-.*$/gm, '');
        expect(() => assembleSplitBuild(bare, () => 'x')).toThrow(/no toolasha/);
    });

    test('the stamp is 14 UTC digits, the shape the dev loader reads', () => {
        expect(versionStamp(new Date('2026-01-02T03:04:05.678Z'))).toBe('20260102030405');
    });
});
