/**
 * The accuracy export is the bug-report attachment, and the sanitized twin is
 * the one safe to post publicly. These pin the name hash (stable, short,
 * collision-shy over a realistic fixture set), the identity stripping, and the
 * file's provenance fields.
 */

import { describe, test, expect, afterEach, vi } from 'vitest';

/** What the mocked tick capture reports as its last saved file; set per test */
const tick = vi.hoisted(() => ({ ref: null }));
vi.mock('./labyrinth-tick-capture.js', () => ({
    default: { lastCaptureRef: () => tick.ref },
}));

import {
    exportMeta,
    hashPlayerName,
    sanitizeExport,
    buildAccuracyExport,
    setSimConfigSource,
} from './labyrinth-accuracy-export.js';
import { FINGERPRINT_SPEC } from './labyrinth-recommendation.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

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
    const marked = (predicted, cleared) => ({
        predicted,
        cleared,
        model: { fullKit: true, version: '4.0.0' },
        fingerprintVersion: FINGERPRINT_VERSION,
    });

    /** Current sim model, but recorded under the gear-only fingerprint */
    const oldFingerprint = (predicted, cleared) => ({
        predicted,
        cleared,
        model: { fullKit: true, version: '4.0.0' },
    });

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
        expect(file.reliability.legacyModelExcluded).toBe(1);
        expect(file.reliability.legacyFingerprintExcluded).toBe(0);
    });

    test('an attempt from an older fingerprint is counted under its own heading', () => {
        const file = buildAccuracyExport({
            attempts: [marked(0.5, true), oldFingerprint(0.5, false)],
        });
        expect(file.reliability.count).toBe(1);
        expect(file.reliability.legacyFingerprintExcluded).toBe(1);
        expect(file.reliability.legacyModelExcluded).toBe(0);
    });

    test('the file names the fingerprint definition its values were computed under', () => {
        const file = buildAccuracyExport({ attempts: [] });
        expect(file.fingerprintVersion).toBe(FINGERPRINT_VERSION);
        expect(file.fingerprintSpec).toBe(FINGERPRINT_SPEC);
    });

    test('exportMeta says which sim model this build runs', () => {
        expect(exportMeta().fullKit).toBe(true);
    });

    test('exportMeta names the seed policy and the fingerprint spec', () => {
        const meta = exportMeta();
        expect(meta.seedPolicy).toBe('unseeded');
        expect(meta.fingerprintSpec).toBe(FINGERPRINT_SPEC);
        expect(FINGERPRINT_SPEC).toContain('djb2');
    });
});

describe('pairing an export with its tick capture and sim config', () => {
    afterEach(() => {
        tick.ref = null;
        setSimConfigSource(null);
    });

    test('with no saved capture and no sim module loaded, both stamps are null', () => {
        const file = buildAccuracyExport({});
        expect(file.capture).toBeNull();
        expect(file.simConfig).toBeNull();
    });

    test('the last saved tick capture is stamped, so the two files can be paired', () => {
        tick.ref = { captureId: 'abc-1', savedAt: 123, monsterHrid: '/monsters/cyclops', roomLevel: 206 };
        expect(buildAccuracyExport({}).capture).toEqual(tick.ref);
    });

    test('the registered sim config rides along, read at export time', () => {
        setSimConfigSource(() => ({
            stopRule: { targetHalfWidth: 0.01, minTrials: 100, maxTrials: 20000 },
            hours: 3,
        }));
        const file = buildAccuracyExport({});
        expect(file.simConfig).toEqual({
            stopRule: { targetHalfWidth: 0.01, minTrials: 100, maxTrials: 20000 },
            hours: 3,
        });
    });

    test('a sim-config source that throws leaves the stamp null rather than the export unbuilt', () => {
        const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
        setSimConfigSource(() => {
            throw new Error('settings unavailable');
        });
        expect(buildAccuracyExport({}).simConfig).toBeNull();
        quiet.mockRestore();
    });
});
