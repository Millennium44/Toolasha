/**
 * The dungeon run history's JSON backup: envelope shape, per-run sanity
 * rules, and the split between the two.
 */

import { describe, test, expect } from 'vitest';

import {
    DUNGEON_RUNS_BACKUP_FORMAT,
    DUNGEON_RUNS_BACKUP_VERSION,
    MAX_PLAUSIBLE_RUN_MS,
    buildDungeonRunsBackupEnvelope,
    parseDungeonRunsJson,
    validateDungeonRunsEnvelope,
    validateImportedRun,
    planDungeonRunImport,
} from './dungeon-tracker-run-import.js';

function run(overrides = {}) {
    return {
        teamKey: 'Aster,Briar',
        team: ['Aster', 'Briar'],
        dungeonName: 'Chimerical Den',
        tier: 1,
        duration: 300_000,
        timestamp: '2026-08-04T10:00:00.000Z',
        recordedBy: 'market123',
        ...overrides,
    };
}

describe('buildDungeonRunsBackupEnvelope', () => {
    test('wraps the runs with the format, version, character and timestamp', () => {
        const envelope = buildDungeonRunsBackupEnvelope({
            characterId: 'market123',
            runs: [run()],
            now: 1_700_000_000_000,
        });

        expect(envelope).toEqual({
            format: DUNGEON_RUNS_BACKUP_FORMAT,
            version: DUNGEON_RUNS_BACKUP_VERSION,
            characterId: 'market123',
            exportedAt: 1_700_000_000_000,
            runs: [run()],
        });
    });

    test('a non-array runs list is written out as empty rather than thrown', () => {
        const envelope = buildDungeonRunsBackupEnvelope({ characterId: null, runs: null });
        expect(envelope.runs).toEqual([]);
    });
});

describe('parseDungeonRunsJson', () => {
    test('rejects an empty string', () => {
        expect(parseDungeonRunsJson('').ok).toBe(false);
        expect(parseDungeonRunsJson('   ').ok).toBe(false);
    });

    test('rejects invalid JSON with a specific message', () => {
        const result = parseDungeonRunsJson('{not json');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not valid JSON/);
    });

    test('rejects JSON that is not an object (an array, a number, a string)', () => {
        expect(parseDungeonRunsJson('[1,2,3]').ok).toBe(false);
        expect(parseDungeonRunsJson('42').ok).toBe(false);
        expect(parseDungeonRunsJson('"hello"').ok).toBe(false);
    });

    test('a well-formed envelope parses through', () => {
        const result = parseDungeonRunsJson(JSON.stringify({ format: DUNGEON_RUNS_BACKUP_FORMAT }));
        expect(result.ok).toBe(true);
        expect(result.envelope.format).toBe(DUNGEON_RUNS_BACKUP_FORMAT);
    });
});

describe('validateDungeonRunsEnvelope', () => {
    function envelope(overrides = {}) {
        return {
            format: DUNGEON_RUNS_BACKUP_FORMAT,
            version: DUNGEON_RUNS_BACKUP_VERSION,
            characterId: 'market123',
            exportedAt: 1,
            runs: [],
            ...overrides,
        };
    }

    test('a well-formed envelope passes', () => {
        expect(validateDungeonRunsEnvelope(envelope())).toEqual({ ok: true });
    });

    test('rejects a non-object', () => {
        expect(validateDungeonRunsEnvelope(null).ok).toBe(false);
        expect(validateDungeonRunsEnvelope([1, 2]).ok).toBe(false);
    });

    test('rejects the wrong format', () => {
        const result = validateDungeonRunsEnvelope(envelope({ format: 'toolasha-alchemy-history' }));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unrecognized format/);
    });

    test('rejects a missing or non-integer version', () => {
        expect(validateDungeonRunsEnvelope(envelope({ version: undefined })).ok).toBe(false);
        expect(validateDungeonRunsEnvelope(envelope({ version: 0 })).ok).toBe(false);
        expect(validateDungeonRunsEnvelope(envelope({ version: 1.5 })).ok).toBe(false);
    });

    test('rejects a version newer than this copy of Toolasha reads', () => {
        const result = validateDungeonRunsEnvelope(envelope({ version: DUNGEON_RUNS_BACKUP_VERSION + 1 }));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/reads up to/);
    });

    test('rejects a non-array runs list', () => {
        expect(validateDungeonRunsEnvelope(envelope({ runs: 'nope' })).ok).toBe(false);
        expect(validateDungeonRunsEnvelope(envelope({ runs: {} })).ok).toBe(false);
    });
});

describe('validateImportedRun', () => {
    test('a well-formed run passes', () => {
        expect(validateImportedRun(run())).toEqual({ ok: true });
    });

    test('rejects a non-object', () => {
        expect(validateImportedRun(null).ok).toBe(false);
        expect(validateImportedRun('nope').ok).toBe(false);
    });

    test('rejects a missing or blank dungeon name', () => {
        expect(validateImportedRun(run({ dungeonName: undefined })).ok).toBe(false);
        expect(validateImportedRun(run({ dungeonName: '' })).ok).toBe(false);
        expect(validateImportedRun(run({ dungeonName: '   ' })).ok).toBe(false);
    });

    test('rejects a non-positive duration', () => {
        expect(validateImportedRun(run({ duration: 0 })).ok).toBe(false);
        expect(validateImportedRun(run({ duration: -500 })).ok).toBe(false);
        expect(validateImportedRun(run({ duration: NaN })).ok).toBe(false);
    });

    test('a legacy websocket run reports its duration through totalTime', () => {
        expect(validateImportedRun(run({ duration: undefined, totalTime: 120_000 })).ok).toBe(true);
    });

    test('rejects a duration past the three-hour plausibility ceiling — an absurd 1608-minute run', () => {
        const result = validateImportedRun(run({ duration: 1608 * 60 * 1000 }));
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/ceiling/);
    });

    test('a duration exactly at the ceiling still passes; one millisecond over does not', () => {
        expect(validateImportedRun(run({ duration: MAX_PLAUSIBLE_RUN_MS })).ok).toBe(true);
        expect(validateImportedRun(run({ duration: MAX_PLAUSIBLE_RUN_MS + 1 })).ok).toBe(false);
    });

    test('rejects a missing or unparsable timestamp', () => {
        expect(validateImportedRun(run({ timestamp: undefined })).ok).toBe(false);
        expect(validateImportedRun(run({ timestamp: '' })).ok).toBe(false);
        expect(validateImportedRun(run({ timestamp: 'not a date' })).ok).toBe(false);
    });
});

describe('planDungeonRunImport', () => {
    test('splits valid and rejected runs, one bad run does not sink the batch', () => {
        const good = run();
        const bad = run({ duration: -1 });
        const plan = planDungeonRunImport([good, bad]);

        expect(plan.valid).toEqual([good]);
        expect(plan.rejected).toEqual([{ run: bad, reason: 'non-positive duration' }]);
    });

    test('an empty or non-array input plans to nothing', () => {
        expect(planDungeonRunImport([])).toEqual({ valid: [], rejected: [] });
        expect(planDungeonRunImport(null)).toEqual({ valid: [], rejected: [] });
    });
});
