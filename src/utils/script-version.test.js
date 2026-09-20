import { describe, test, expect, afterEach } from 'vitest';
import { scriptVersion, fromCurrentBuild, currentBuildEntries } from './script-version.js';

afterEach(() => {
    delete globalThis.GM_info;
});

describe('scriptVersion', () => {
    test('is null outside the userscript sandbox', () => {
        expect(scriptVersion()).toBe(null);
    });

    test('reads the running build out of GM_info', () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        expect(scriptVersion()).toBe('9.9.9');
    });
});

describe('fromCurrentBuild', () => {
    test('keeps a record stamped with the running build', () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        expect(fromCurrentBuild({ scriptVersion: '9.9.9' })).toBe(true);
    });

    test('refuses a record stamped with an older build', () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        expect(fromCurrentBuild({ scriptVersion: '9.9.8' })).toBe(false);
    });

    test('refuses an unstamped record, which predates the stamping', () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        expect(fromCurrentBuild({ perHour: { food: 1 } })).toBe(false);
    });

    test('refuses nothing at all rather than throwing', () => {
        expect(fromCurrentBuild(null)).toBe(false);
        expect(fromCurrentBuild(undefined)).toBe(false);
        expect(fromCurrentBuild('a string')).toBe(false);
    });
});

describe('currentBuildEntries', () => {
    test('keeps only the entries this build wrote', () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        const kept = currentBuildEntries({
            current: { scriptVersion: '9.9.9', perHour: { a: 1 } },
            older: { scriptVersion: '9.9.8', perHour: { b: 2 } },
            unstamped: { perHour: { c: 3 } },
        });
        expect(Object.keys(kept)).toEqual(['current']);
    });

    test('does not mutate the map it was given', () => {
        globalThis.GM_info = { script: { version: '9.9.9' } };
        const stored = { older: { scriptVersion: '9.9.8' } };
        expect(currentBuildEntries(stored)).toEqual({});
        expect(Object.keys(stored)).toEqual(['older']);
    });

    test('answers an empty map for anything that is not one', () => {
        expect(currentBuildEntries(null)).toEqual({});
        expect(currentBuildEntries('nope')).toEqual({});
    });
});
