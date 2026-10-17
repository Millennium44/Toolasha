/**
 * Mock factories carry every export a shared module gained.
 *
 * A `vi.mock` factory is the whole module as far as the tested code is concerned, and a missing export
 * is invisible when the reader sits behind a catch (the cost memos read the custom-price version
 * through one, and treat a throw as "no custom prices"). So the modules that grew exports for the
 * shared enhancement input rule are checked here, by reading the suites' own factories.
 */

import { describe, test, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(dir) {
    const found = [];
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) found.push(...testFiles(path));
        else if (name.endsWith('.test.js')) found.push(path);
    }
    return found;
}

/** Factories of `vi.mock('<...moduleFile>', ...)`, as the source text up to where the next top-level statement starts */
function factoriesFor(moduleFile) {
    const out = [];
    const escaped = moduleFile.replace('.', String.raw`\.`);
    const pattern = new RegExp(String.raw`vi\.mock\(\s*'[^']*${escaped}'`, 'g');
    for (const file of testFiles(SRC)) {
        if (file.endsWith('mock-factory-exports.test.js')) continue;
        const text = readFileSync(file, 'utf-8');
        for (const match of text.matchAll(pattern)) {
            const rest = text.slice(match.index);
            const end = rest.search(/\n\}\)\);|\}\)\);\n|\}\)\);$/);
            out.push({ file: file.slice(SRC.length + 1), factory: rest.slice(0, end === -1 ? 800 : end) });
        }
    }
    return out;
}

describe('mock factories of the modules the shared input rule extended', () => {
    test('every custom-price-overrides factory exposes getCustomPriceVersion (or spreads the original)', () => {
        const factories = factoriesFor('custom-price-overrides.js');
        expect(factories.length).toBeGreaterThan(10);
        const missing = factories
            .filter(({ factory }) => !factory.includes('getCustomPriceVersion') && !factory.includes('importOriginal'))
            .map(({ file }) => file);
        expect(missing).toEqual([]);
    });

    test('every networth-cache factory that serves reads also serves isPartial', () => {
        const missing = factoriesFor('networth-cache.js')
            .filter(({ factory }) => /\bget:/.test(factory) && !factory.includes('isPartial'))
            .map(({ file }) => file);
        expect(missing).toEqual([]);
    });
});
