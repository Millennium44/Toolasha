/**
 * The accuracy export is the bug-report attachment, and the sanitized twin is
 * the one safe to post publicly. These pin the name hash (stable, short,
 * collision-shy over a realistic fixture set), the identity stripping, and the
 * file's provenance fields.
 */

import { describe, test, expect } from 'vitest';
import { exportMeta, hashPlayerName, sanitizeExport, buildAccuracyExport } from './labyrinth-accuracy-export.js';

describe('hashPlayerName', () => {
    test('is stable: the same name always hashes the same', () => {
        expect(hashPlayerName('MilkMan')).toBe(hashPlayerName('MilkMan'));
    });

    test("reads as 'p' plus eight hex characters", () => {
        expect(hashPlayerName('MilkMan')).toMatch(/^p[0-9a-f]{8}$/);
        expect(hashPlayerName('')).toMatch(/^p[0-9a-f]{8}$/);
    });

    test('a small fixture set of names produces no collisions', () => {
        const names = ['MilkMan', 'milkman', 'MilkMan ', 'Toolasha', 'A', 'B', 'CowTipper', 'cow_tipper', '牛乳'];
        const hashes = new Set(names.map(hashPlayerName));
        expect(hashes.size).toBe(names.length);
    });
});

describe('sanitizeExport', () => {
    const file = () => ({
        format: 'toolasha-labyrinth-accuracy',
        characterId: 'char-123',
        characterName: 'MilkMan',
        rows: [{ monsterName: 'Cyclops', predicted: 0.421337 }],
        nested: { character_id: 'char-123', character_name: 'MilkMan', keep: 1 },
    });

    test('strips character ids at any depth', () => {
        const clean = sanitizeExport(file());
        expect(clean).not.toHaveProperty('characterId');
        expect(clean.nested).not.toHaveProperty('character_id');
        expect(clean.nested.keep).toBe(1);
    });

    test('hashes character names to the stable stand-in', () => {
        const clean = sanitizeExport(file());
        expect(clean.characterName).toBe(hashPlayerName('MilkMan'));
        expect(clean.nested.character_name).toBe(hashPlayerName('MilkMan'));
        expect(clean.characterName).not.toContain('MilkMan');
    });

    test('monster names and the raw probabilities pass through untouched', () => {
        const clean = sanitizeExport(file());
        expect(clean.rows[0].monsterName).toBe('Cyclops');
        expect(clean.rows[0].predicted).toBe(0.421337);
    });

    test('never mutates the input', () => {
        const original = file();
        sanitizeExport(original);
        expect(original.characterId).toBe('char-123');
        expect(original.characterName).toBe('MilkMan');
    });

    test('passes primitives and arrays through', () => {
        expect(sanitizeExport(null)).toBeNull();
        expect(sanitizeExport(3)).toBe(3);
        expect(sanitizeExport([1, 'a'])).toEqual([1, 'a']);
    });
});

describe('buildAccuracyExport', () => {
    const marked = (predicted, cleared) => ({ predicted, cleared, model: { fullKit: true, version: '4.0.0' } });

    test('carries provenance, identity and the unrounded snapshot', () => {
        const file = buildAccuracyExport({
            snapshot: { rows: [{ predicted: 0.421337, observed: 0.4 }], summary: { attempts: 5 }, bySubject: [] },
            attempts: [],
            character: { characterId: 'char-1', characterName: 'MilkMan' },
        });
        expect(file.format).toBe('toolasha-labyrinth-accuracy');
        expect(file.fullKit).toBe(true);
        expect(file).toHaveProperty('toolashaVersion');
        expect(file).toHaveProperty('isTestServer');
        expect(file.characterName).toBe('MilkMan');
        // The per-result probabilities go out unrounded, unlike the text report
        expect(file.rows[0].predicted).toBe(0.421337);
    });

    test('the reliability block covers the current cohort and counts the legacy one', () => {
        const file = buildAccuracyExport({
            attempts: [marked(0.5, true), marked(0.5, false), { predicted: 0.9, cleared: true }],
        });
        expect(file.reliability.count).toBe(2);
        expect(file.reliability.expected).toBeCloseTo(1, 10);
        expect(file.reliability.legacyExcluded).toBe(1);
    });

    test('exportMeta says which sim model this build runs', () => {
        expect(exportMeta().fullKit).toBe(true);
    });
});
