import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const root = new URL('../', import.meta.url);
const devHeader = readFileSync(new URL('userscript-header.txt', root), 'utf8');
const productionHeader = readFileSync(new URL('library-headers/entrypoint.txt', root), 'utf8');

function metadataLines(text) {
    return text
        .split('\n')
        .filter((line) => /^\/\/\s+@/.test(line))
        .filter((line) => !line.includes('https://UPDATE-THIS-URL/'));
}

function placeholderLibraries(text) {
    return [...text.matchAll(/^\/\/\s+@require\s+https:\/\/UPDATE-THIS-URL\/toolasha-(\S+)\.js$/gm)].map(
        (match) => match[1]
    );
}

describe('userscript headers', () => {
    test('keeps production metadata and external dependencies identical to the standalone build', () => {
        expect(metadataLines(productionHeader)).toEqual(metadataLines(devHeader));
    });

    test('requires exactly one production bundle for every library header', () => {
        const headerDirectory = new URL('library-headers/', root);
        const libraryNames = readdirSync(headerDirectory)
            .filter((file) => file !== 'entrypoint.txt' && file.endsWith('.txt'))
            .map((file) => file.replace(/\.txt$/, ''))
            .sort();
        const requiredLibraries = placeholderLibraries(productionHeader).sort();

        expect(requiredLibraries).toEqual(libraryNames);

        const rollup = readFileSync(new URL('rollup.config.js', root), 'utf8');
        for (const library of requiredLibraries) {
            expect(rollup).toContain(join('dist', 'libraries', `toolasha-${library}.js`).replaceAll('\\', '/'));
        }
    });
});
