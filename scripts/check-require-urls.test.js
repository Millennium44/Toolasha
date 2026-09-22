import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { classicScriptError, responseError } from './check-require-urls.mjs';

describe('classicScriptError', () => {
    test('accepts minified UMD and comment prose that mentions exports', () => {
        const umd = `/*
export the factory for package users
*/
!function(root,factory){root.Example=factory()}(this,function(){return {ok:true}});`;

        expect(classicScriptError(umd)).toBeNull();
    });

    test('accepts the exact installed UMD dependencies shipped by the headers', () => {
        const files = [
            '../node_modules/chart.js/dist/chart.umd.js',
            '../node_modules/chartjs-plugin-datalabels/dist/chartjs-plugin-datalabels.min.js',
        ];

        for (const file of files) {
            expect(classicScriptError(readFileSync(new URL(file, import.meta.url), 'utf8')), file).toBeNull();
        }
    });

    test('rejects module syntax even after the first forty lines', () => {
        const body = `${Array.from({ length: 45 }, (_, index) => `// line ${index}`).join('\n')}\nexport default {};`;

        expect(classicScriptError(body)).toMatch(/classic script/i);
    });

    test('rejects HTML and truncated JavaScript bodies', () => {
        expect(classicScriptError('<!doctype html><title>CDN error</title>')).toMatch(/classic script/i);
        expect(classicScriptError('!function () {')).toMatch(/classic script/i);
    });

    test('rejects an empty response body', () => {
        expect(classicScriptError('   \n')).toMatch(/empty/i);
    });
});

describe('responseError', () => {
    test('rejects a partial response even though fetch calls it ok', () => {
        expect(responseError({ ok: true, status: 206, headers: new Headers() })).toMatch(/HTTP 206/);
    });

    test('rejects an HTML response before treating its body as JavaScript', () => {
        const headers = new Headers({ 'content-type': 'text/html; charset=utf-8' });

        expect(responseError({ ok: true, status: 200, headers })).toMatch(/text\/html/);
    });

    test('rejects a JSON error response that could otherwise parse as JavaScript', () => {
        const headers = new Headers({ 'content-type': 'application/json' });

        expect(responseError({ ok: true, status: 200, headers })).toMatch(/application\/json/);
    });

    test('accepts ordinary JavaScript and text content types', () => {
        for (const contentType of ['application/javascript', 'text/javascript; charset=utf-8', 'text/plain', null]) {
            const headers = new Headers(contentType ? { 'content-type': contentType } : {});
            expect(responseError({ ok: true, status: 200, headers })).toBeNull();
        }
    });
});
