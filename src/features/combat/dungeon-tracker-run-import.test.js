/**
 * The dungeon run history's JSON backup: envelope shape, per-run sanity
 * rules, and the split between the two.
 */

import { describe, test, expect, vi } from 'vitest';

import {
    DUNGEON_RUNS_BACKUP_FORMAT,
    DUNGEON_RUNS_BACKUP_VERSION,
    MAX_PLAUSIBLE_RUN_MS,
    MAX_IMPORT_RUNS,
    MAX_DUNGEON_NAME_CHARS,
    MAX_TEAM_KEY_CHARS,
    buildDungeonRunsBackupEnvelope,
    serializeBackupWithinLimits,
    parseDungeonRunsJson,
    validateDungeonRunsEnvelope,
    validateImportedRun,
    planDungeonRunImport,
    dungeonRunsBackupFilename,
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

    test('rejects a runs list over the cap, by length alone, before any run is looked at', () => {
        const result = validateDungeonRunsEnvelope(envelope({ runs: new Array(MAX_IMPORT_RUNS + 1).fill(null) }));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/too many runs/);
    });

    test('a runs list exactly at the cap passes', () => {
        const result = validateDungeonRunsEnvelope(envelope({ runs: new Array(MAX_IMPORT_RUNS).fill(null) }));
        expect(result.ok).toBe(true);
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

    test('rejects a dungeon name or team key past its length cap, and accepts one exactly at it', () => {
        const longName = validateImportedRun(run({ dungeonName: 'x'.repeat(MAX_DUNGEON_NAME_CHARS + 1) }));
        expect(longName.ok).toBe(false);
        expect(longName.reason).toMatch(/dungeon name longer than/);
        const longTeam = validateImportedRun(run({ teamKey: 'x'.repeat(MAX_TEAM_KEY_CHARS + 1) }));
        expect(longTeam.ok).toBe(false);
        expect(longTeam.reason).toMatch(/teamKey longer than/);
        expect(validateImportedRun(run({ dungeonName: 'x'.repeat(MAX_DUNGEON_NAME_CHARS) })).ok).toBe(true);
        expect(validateImportedRun(run({ teamKey: 'x'.repeat(MAX_TEAM_KEY_CHARS) })).ok).toBe(true);
    });

    test('rejects control characters in a dungeon name or team key', () => {
        expect(validateImportedRun(run({ teamKey: 'Aster\rBriar' })).reason).toMatch(/control characters/);
        expect(validateImportedRun(run({ teamKey: 'Aster\u0000' })).ok).toBe(false);
        expect(validateImportedRun(run({ dungeonName: 'Den\n' })).reason).toMatch(/control characters/);
    });

    test('rejects a non-positive duration', () => {
        expect(validateImportedRun(run({ duration: 0 })).ok).toBe(false);
        expect(validateImportedRun(run({ duration: -500 })).ok).toBe(false);
        expect(validateImportedRun(run({ duration: NaN })).ok).toBe(false);
    });

    test('does NOT fall back to totalTime — that is planDungeonRunImport’s job, so identity agrees', () => {
        // Passed to validateImportedRun directly (unnormalized), a totalTime-only
        // run has no usable `duration` and must be refused, not silently priced
        // off a field runIdentity never reads.
        const legacy = run({ totalTime: 120_000 });
        delete legacy.duration;
        const result = validateImportedRun(legacy);
        expect(result.ok).toBe(false);
        expect(result.reason).toMatch(/duration/);
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

    test('rejects any timestamp after "now", with no tolerance at all', () => {
        // Importing is never live recording, so a run has no clock of its own
        // that could have skewed — and any tolerance here is exactly the
        // window a backup with its timestamps nudged forward would use to
        // outrun a "delete all history" that just ran, since the clear only
        // drops what is at or before its own epoch.
        const now = Date.parse('2026-09-27T00:00:00.000Z');
        const exactlyNow = new Date(now).toISOString();
        const oneSecondAhead = new Date(now + 1000).toISOString();
        const fiveMinutesAhead = new Date(now + 5 * 60 * 1000).toISOString();

        expect(validateImportedRun(run({ timestamp: exactlyNow }), MAX_PLAUSIBLE_RUN_MS, now).ok).toBe(true);
        for (const future of [oneSecondAhead, fiveMinutesAhead]) {
            const result = validateImportedRun(run({ timestamp: future }), MAX_PLAUSIBLE_RUN_MS, now);
            expect(result.ok).toBe(false);
            expect(result.reason).toMatch(/future/);
        }
    });

    test('rejects a non-integer tier — a run’s tier reaches an HTML attribute verbatim downstream', () => {
        expect(validateImportedRun(run({ tier: '1' })).ok).toBe(false);
        expect(validateImportedRun(run({ tier: 1.5 })).ok).toBe(false);
        expect(validateImportedRun(run({ tier: '" onpointerover="alert(1)' })).ok).toBe(false);
        expect(validateImportedRun(run({ tier: {} })).ok).toBe(false);
    });

    test('an integer tier, or no tier at all, both pass', () => {
        expect(validateImportedRun(run({ tier: 0 })).ok).toBe(true);
        expect(validateImportedRun(run({ tier: 2 })).ok).toBe(true);
        expect(validateImportedRun(run({ tier: null })).ok).toBe(true);
        expect(validateImportedRun(run({ tier: undefined })).ok).toBe(true);
    });

    test('rejects a non-string or empty teamKey', () => {
        expect(validateImportedRun(run({ teamKey: 42 })).ok).toBe(false);
        expect(validateImportedRun(run({ teamKey: ['Aster', 'Briar'] })).ok).toBe(false);
        expect(validateImportedRun(run({ teamKey: {} })).ok).toBe(false);
        expect(validateImportedRun(run({ teamKey: '' })).ok).toBe(false);
        expect(validateImportedRun(run({ teamKey: '   ' })).ok).toBe(false);
    });

    test('a real teamKey, or no teamKey at all (a solo run), both pass', () => {
        expect(validateImportedRun(run({ teamKey: 'Aster,Briar' })).ok).toBe(true);
        expect(validateImportedRun(run({ teamKey: undefined })).ok).toBe(true);
        expect(validateImportedRun(run({ teamKey: null })).ok).toBe(true);
    });

    test('"__proto__" is an unusual but perfectly valid teamKey string — not rejected here', () => {
        // The structural fix (a Map, not a plain object, in groupByTeam and
        // getAllTeamStats) is what makes this safe to group by; it is not
        // this function's job to guess which strings a dictionary implementation
        // elsewhere might mishandle.
        expect(validateImportedRun(run({ teamKey: '__proto__' })).ok).toBe(true);
    });
});

describe('planDungeonRunImport', () => {
    test('splits valid and rejected runs, one bad run does not sink the batch', () => {
        const good = run();
        const bad = run({ duration: -1 });
        const plan = planDungeonRunImport([good, bad]);

        expect(plan.valid).toEqual([good]);
        expect(plan.rejected).toEqual([{ run: bad, reason: 'non-positive or missing duration' }]);
    });

    test('an empty or non-array input plans to nothing', () => {
        expect(planDungeonRunImport([])).toEqual({ valid: [], rejected: [] });
        expect(planDungeonRunImport(null)).toEqual({ valid: [], rejected: [] });
    });

    test('normalizes a legacy totalTime-only run onto duration before validating and admitting it', () => {
        const legacy = run({ totalTime: 120_000 });
        delete legacy.duration;

        const plan = planDungeonRunImport([legacy]);

        expect(plan.rejected).toEqual([]);
        expect(plan.valid).toEqual([{ ...legacy, duration: 120_000 }]);
    });

    test('a rejected run is reported as the original, unnormalized object', () => {
        const bad = run({ totalTime: -1 });
        delete bad.duration;

        const plan = planDungeonRunImport([bad]);

        expect(plan.valid).toEqual([]);
        expect(plan.rejected).toEqual([{ run: bad, reason: 'non-positive or missing duration' }]);
    });

    test('a run whose duration is already usable is passed through untouched, not copied', () => {
        const good = run();
        const plan = planDungeonRunImport([good]);
        expect(plan.valid[0]).toBe(good);
    });

    test('a numeric-string duration is converted to a real number, not kept as a string', () => {
        const stringy = run({ duration: '300000' });

        const plan = planDungeonRunImport([stringy]);

        expect(plan.rejected).toEqual([]);
        expect(plan.valid[0].duration).toBe(300_000);
        expect(typeof plan.valid[0].duration).toBe('number');
    });

    test('a numeric-string duration would otherwise concatenate in a reducer — proof the type actually matters', () => {
        const stringy = run({ duration: '300000' });
        const plan = planDungeonRunImport([stringy]);

        let total = 0;
        total += plan.valid[0].duration;
        total += 100_000;

        expect(total).toBe(400_000);
    });

    test('a timestamp with a legacy-date "timezone comment" carrying markup is canonicalized to plain ISO', () => {
        // V8's non-ISO Date parser ignores the parenthesized trailing
        // comment's content entirely (it is free-form "timezone name" text),
        // so this is a real, currently-shipping instant — 1970-01-01T00:00Z —
        // spelled with an HTML/attribute-breaking payload riding along in a
        // part of the string nothing checks.
        const malicious = run({
            timestamp: 'Thu Jan 01 1970 00:00:00 GMT+0000 ("><img src=x onerror=alert(1)>)',
        });

        const plan = planDungeonRunImport([malicious]);

        expect(plan.rejected).toEqual([]);
        expect(plan.valid[0].timestamp).toBe('1970-01-01T00:00:00.000Z');
        expect(plan.valid[0].timestamp).not.toMatch(/[<>"]/);
    });

    test('a timestamp that cannot be parsed at all is rejected, not canonicalized to garbage', () => {
        const bad = run({ timestamp: 'not a date' });
        const plan = planDungeonRunImport([bad]);

        expect(plan.valid).toEqual([]);
        expect(plan.rejected).toEqual([{ run: bad, reason: 'missing or unusable timestamp' }]);
    });
});

describe('dungeonRunsBackupFilename', () => {
    test('names the file with the format stem and a timestamp, like the CSV export', () => {
        const name = dungeonRunsBackupFilename(new Date(2026, 7, 3, 22, 14));
        expect(name).toBe('toolasha-dungeon-runs-backup-20260803-2214.json');
    });
});

describe('serializeBackupWithinLimits', () => {
    const at = (day, extra = {}) =>
        run({ timestamp: `2026-08-${String(day).padStart(2, '0')}T10:00:00.000Z`, ...extra });

    test('under both limits, writes every run in the order given with nothing omitted', () => {
        const runs = [at(2), at(5), at(1)];
        const { text, omitted } = serializeBackupWithinLimits({ characterId: 'c', runs, now: 1 });
        expect(omitted).toBe(0);
        expect(JSON.parse(text).runs).toEqual(runs);
    });

    test('over the run cap, keeps the newest runs and reports how many older ones were left out', () => {
        const runs = [at(2), at(9), at(1), at(7)];
        const { text, omitted } = serializeBackupWithinLimits({ characterId: 'c', runs, maxRuns: 2 });
        expect(omitted).toBe(2);
        expect(JSON.parse(text).runs.map((r) => r.timestamp.slice(8, 10))).toEqual(['09', '07']);
    });

    test('over the byte ceiling, trims oldest runs until the written file fits it', () => {
        const runs = Array.from({ length: 200 }, (_, i) => at(1 + (i % 28), { duration: 1000 + i }));
        const maxBytes = 20_000;
        const { text, omitted } = serializeBackupWithinLimits({ characterId: 'c', runs, maxBytes });
        expect(omitted).toBeGreaterThan(0);
        expect(new TextEncoder().encode(text).length).toBeLessThanOrEqual(maxBytes);
        expect(JSON.parse(text).runs).toHaveLength(200 - omitted);
    });

    test('unparseable timestamps sort as oldest and never disturb the order of the rest', () => {
        const runs = [at(1), { ...at(2), timestamp: 'nope' }, at(9), { ...at(3), timestamp: null }, at(5)];
        const { text } = serializeBackupWithinLimits({ characterId: 'c', runs, maxRuns: 3 });
        expect(JSON.parse(text).runs.map((r) => r.timestamp.slice(8, 10))).toEqual(['09', '05', '01']);
    });

    test('keeps the true maximum prefix when the oldest runs are the big ones', () => {
        const small = Array.from({ length: 40 }, (_, i) => at(20 + (i % 8), { duration: 1000 + i }));
        const big = Array.from({ length: 10 }, (_, i) =>
            at(1 + (i % 8), { duration: 2000 + i, note: 'x'.repeat(2000) })
        );
        const runs = [...big, ...small];
        const maxBytes = 12_000;
        const { text, omitted } = serializeBackupWithinLimits({ characterId: 'c', runs, maxBytes, now: 1 });
        const kept = JSON.parse(text).runs.length;
        expect(kept).toBe(runs.length - omitted);
        const newest = [...runs].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        const sizeOf = (n) =>
            new TextEncoder().encode(
                JSON.stringify(buildDungeonRunsBackupEnvelope({ characterId: 'c', runs: newest.slice(0, n), now: 1 }))
            ).length;
        expect(sizeOf(kept)).toBeLessThanOrEqual(maxBytes);
        expect(sizeOf(kept + 1)).toBeGreaterThan(maxBytes);
    });

    test('over the run cap, never serializes more than the cap', () => {
        const runs = Array.from({ length: 30 }, (_, i) => at(1 + (i % 28), { duration: 1000 + i }));
        const spy = vi.spyOn(JSON, 'stringify');
        try {
            const { text, omitted } = serializeBackupWithinLimits({ characterId: 'c', runs, maxRuns: 5 });
            expect(omitted).toBe(25);
            expect(JSON.parse(text).runs).toHaveLength(5);
            const largest = Math.max(...spy.mock.calls.map(([value]) => value.runs.length));
            expect(largest).toBeLessThanOrEqual(5);
        } finally {
            spy.mockRestore();
        }
    });

    test('a newest-first list over the cap is sliced, not sorted; an unordered one still yields the newest', () => {
        const ordered = Array.from({ length: 30 }, (_, i) => at(28 - (i % 28), { duration: 1000 + i }));
        ordered.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        const spy = vi.spyOn(Array.prototype, 'sort');
        try {
            const { text } = serializeBackupWithinLimits({ characterId: 'c', runs: ordered, maxRuns: 5 });
            expect(JSON.parse(text).runs).toEqual(ordered.slice(0, 5));
            expect(spy.mock.contexts.every((list) => list.length <= 5)).toBe(true);
        } finally {
            spy.mockRestore();
        }
        const shuffled = [ordered[7], ordered[0], ordered[20], ordered[1], ordered[3], ordered[29]];
        const { text } = serializeBackupWithinLimits({ characterId: 'c', runs: shuffled, maxRuns: 2 });
        expect(JSON.parse(text).runs).toEqual([ordered[0], ordered[1]]);
    });

    test('is compact: no indentation whitespace, and it parses back unchanged', () => {
        const runs = [at(1, { team: ['A', 'B'] })];
        const { text } = serializeBackupWithinLimits({ characterId: 'c', runs, now: 1 });
        expect(text).not.toContain('\n');
        expect(JSON.parse(text).runs).toEqual(runs);
    });

    test('what it writes passes the envelope check import applies', () => {
        const runs = Array.from({ length: 5 }, (_, i) => at(1 + i));
        const { text } = serializeBackupWithinLimits({ characterId: 'c', runs, maxRuns: 3 });
        expect(validateDungeonRunsEnvelope(JSON.parse(text))).toEqual({ ok: true });
    });
});
