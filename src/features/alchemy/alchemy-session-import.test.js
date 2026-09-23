import { describe, test, expect } from 'vitest';
import {
    ALCHEMY_BACKUP_FORMAT,
    ALCHEMY_BACKUP_VERSION,
    buildAlchemyBackupEnvelope,
    parseAlchemyBackupJson,
    validateAlchemyBackupEnvelope,
    validateAlchemySession,
    validateAlchemySessions,
    planAlchemyImportMerge,
} from './alchemy-session-import.js';

const INPUT_HRID = '/items/gem';

/** @returns {Object} A well-formed transmute session */
const transmuteSession = (overrides = {}) => ({
    id: 'transmute_1',
    startTime: 1000,
    lastActivityTime: 2000,
    inputItemHrid: INPUT_HRID,
    totalAttempts: 3,
    totalSuccesses: 1,
    bulkMultiplier: 1,
    results: {
        '/items/shard': { count: 1, totalValue: 700, priceEach: 700, isSelfReturn: false, unpriced: false },
    },
    catalystsUsed: { '/items/prime_catalyst': 3 },
    ...overrides,
});

describe('buildAlchemyBackupEnvelope', () => {
    test('wraps the sessions with format, kind and version', () => {
        const envelope = buildAlchemyBackupEnvelope({
            kind: 'transmute',
            characterId: 'char-1',
            sessions: [transmuteSession()],
            now: 5000,
        });
        expect(envelope).toEqual({
            format: ALCHEMY_BACKUP_FORMAT,
            kind: 'transmute',
            version: ALCHEMY_BACKUP_VERSION,
            characterId: 'char-1',
            exportedAt: 5000,
            sessions: [transmuteSession()],
        });
    });

    test('a non-array sessions argument becomes an empty array', () => {
        const envelope = buildAlchemyBackupEnvelope({ kind: 'coinify', characterId: 'c', sessions: null });
        expect(envelope.sessions).toEqual([]);
    });
});

describe('parseAlchemyBackupJson', () => {
    test('parses a well-formed JSON object', () => {
        const result = parseAlchemyBackupJson('{"a": 1}');
        expect(result).toEqual({ ok: true, envelope: { a: 1 } });
    });

    test('refuses empty text', () => {
        expect(parseAlchemyBackupJson('').ok).toBe(false);
        expect(parseAlchemyBackupJson('   ').ok).toBe(false);
    });

    test('refuses invalid JSON with a message naming the syntax error', () => {
        const result = parseAlchemyBackupJson('{not json');
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/not valid JSON/);
    });

    test('refuses a JSON array — not an envelope', () => {
        expect(parseAlchemyBackupJson('[1,2,3]').ok).toBe(false);
    });

    test('refuses a bare JSON primitive', () => {
        expect(parseAlchemyBackupJson('42').ok).toBe(false);
        expect(parseAlchemyBackupJson('null').ok).toBe(false);
    });
});

describe('validateAlchemyBackupEnvelope', () => {
    const baseEnvelope = () => buildAlchemyBackupEnvelope({ kind: 'transmute', characterId: 'char-1', sessions: [] });

    test('accepts a well-formed matching envelope', () => {
        expect(validateAlchemyBackupEnvelope(baseEnvelope(), { kind: 'transmute' })).toEqual({ ok: true });
    });

    test('refuses an unrecognized format', () => {
        const envelope = { ...baseEnvelope(), format: 'something-else' };
        const result = validateAlchemyBackupEnvelope(envelope, { kind: 'transmute' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/unrecognized format/);
    });

    test('refuses a kind mismatch, naming which window to use instead', () => {
        const envelope = buildAlchemyBackupEnvelope({ kind: 'coinify', characterId: 'c', sessions: [] });
        const result = validateAlchemyBackupEnvelope(envelope, { kind: 'transmute' });
        expect(result.ok).toBe(false);
        expect(result.error).toContain('coinify History window');
    });

    test('refuses an unsupported (future) version', () => {
        const envelope = { ...baseEnvelope(), version: ALCHEMY_BACKUP_VERSION + 1 };
        const result = validateAlchemyBackupEnvelope(envelope, { kind: 'transmute' });
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/version/i);
    });

    test('refuses a missing/non-integer version', () => {
        expect(validateAlchemyBackupEnvelope({ ...baseEnvelope(), version: 0 }, { kind: 'transmute' }).ok).toBe(false);
        expect(validateAlchemyBackupEnvelope({ ...baseEnvelope(), version: '1' }, { kind: 'transmute' }).ok).toBe(
            false
        );
    });

    test('refuses a non-array sessions field', () => {
        const envelope = { ...baseEnvelope(), sessions: 'nope' };
        expect(validateAlchemyBackupEnvelope(envelope, { kind: 'transmute' }).ok).toBe(false);
    });

    test('refuses a non-object envelope', () => {
        expect(validateAlchemyBackupEnvelope(null, { kind: 'transmute' }).ok).toBe(false);
        expect(validateAlchemyBackupEnvelope([1, 2], { kind: 'transmute' }).ok).toBe(false);
    });
});

describe('validateAlchemySession', () => {
    test('accepts a well-formed transmute session', () => {
        expect(validateAlchemySession('transmute', transmuteSession())).toEqual({ ok: true });
    });

    test('refuses a session with no id', () => {
        const result = validateAlchemySession('transmute', transmuteSession({ id: '' }));
        expect(result.ok).toBe(false);
    });

    test('refuses a session with a non-numeric startTime', () => {
        expect(validateAlchemySession('transmute', transmuteSession({ startTime: 'yesterday' })).ok).toBe(false);
    });

    test('refuses a session whose inputItemHrid is not an item hrid', () => {
        expect(validateAlchemySession('transmute', transmuteSession({ inputItemHrid: 'gem' })).ok).toBe(false);
    });

    test('refuses more successes than attempts', () => {
        const result = validateAlchemySession('transmute', transmuteSession({ totalAttempts: 3, totalSuccesses: 5 }));
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/more successes/);
    });

    test('refuses a negative totalAttempts or totalSuccesses', () => {
        expect(validateAlchemySession('transmute', transmuteSession({ totalAttempts: -1 })).ok).toBe(false);
        expect(validateAlchemySession('transmute', transmuteSession({ totalSuccesses: -1 })).ok).toBe(false);
    });

    test('refuses a lastActivityTime before startTime', () => {
        const result = validateAlchemySession(
            'transmute',
            transmuteSession({ startTime: 2000, lastActivityTime: 1000 })
        );
        expect(result.ok).toBe(false);
    });

    test('refuses a non-object results map', () => {
        expect(validateAlchemySession('transmute', transmuteSession({ results: 'nope' })).ok).toBe(false);
    });

    test('refuses a results entry with a non-numeric count', () => {
        const session = transmuteSession({ results: { '/items/shard': { count: 'lots' } } });
        expect(validateAlchemySession('transmute', session).ok).toBe(false);
    });

    test('refuses a results entry with a non-boolean isSelfReturn', () => {
        const session = transmuteSession({
            results: { '/items/shard': { count: 1, isSelfReturn: 'yes' } },
        });
        expect(validateAlchemySession('transmute', session).ok).toBe(false);
    });

    test('accepts a coinify session with coinify-specific fields', () => {
        const session = {
            id: 'coinify_1',
            startTime: 1,
            inputItemHrid: INPUT_HRID,
            enhancementLevel: 5,
            totalAttempts: 10,
            totalSuccesses: 8,
            totalCoinsEarned: 5000,
            coinsPerSuccess: 625,
            catalystOfCoinificationUsed: 8,
            primeCatalystUsed: 0,
        };
        expect(validateAlchemySession('coinify', session)).toEqual({ ok: true });
    });

    test('refuses a coinify session with a non-numeric totalCoinsEarned', () => {
        const session = {
            id: 'coinify_1',
            startTime: 1,
            inputItemHrid: INPUT_HRID,
            totalAttempts: 10,
            totalSuccesses: 8,
            totalCoinsEarned: 'lots',
        };
        expect(validateAlchemySession('coinify', session).ok).toBe(false);
    });

    test('accepts a decompose session with decompose-specific fields', () => {
        const session = {
            id: 'decompose_1',
            startTime: 1,
            inputItemHrid: INPUT_HRID,
            enhancementLevel: 3,
            totalAttempts: 10,
            totalSuccesses: 8,
            results: { '/items/shard': { count: 8, totalValue: 400, priceEach: 50 } },
            catalystOfDecompositionUsed: 8,
            primeCatalystUsed: 0,
        };
        expect(validateAlchemySession('decompose', session)).toEqual({ ok: true });
    });

    test('refuses a non-object session', () => {
        expect(validateAlchemySession('transmute', null).ok).toBe(false);
        expect(validateAlchemySession('transmute', 'nope').ok).toBe(false);
    });
});

describe('validateAlchemySessions', () => {
    test('accepts an all-valid list', () => {
        expect(validateAlchemySessions('transmute', [transmuteSession(), transmuteSession({ id: 't2' })])).toEqual({
            ok: true,
        });
    });

    test('reports the first invalid session and stops', () => {
        const result = validateAlchemySessions('transmute', [transmuteSession(), transmuteSession({ id: '' })]);
        expect(result.ok).toBe(false);
    });

    test('an empty list is valid', () => {
        expect(validateAlchemySessions('transmute', [])).toEqual({ ok: true });
    });
});

describe('planAlchemyImportMerge', () => {
    test('an imported id matching a stored one replaces it', () => {
        const stored = [transmuteSession({ id: 'a', totalSuccesses: 1 })];
        const imported = [transmuteSession({ id: 'a', totalSuccesses: 2 })];
        const plan = planAlchemyImportMerge(stored, imported);

        expect(plan.replaced).toBe(1);
        expect(plan.added).toBe(0);
        expect(plan.unchanged).toBe(0);
        expect(plan.merged).toEqual([transmuteSession({ id: 'a', totalSuccesses: 2 })]);
    });

    test('an imported id absent from storage is added', () => {
        const stored = [transmuteSession({ id: 'a' })];
        const imported = [transmuteSession({ id: 'b' })];
        const plan = planAlchemyImportMerge(stored, imported);

        expect(plan.replaced).toBe(0);
        expect(plan.added).toBe(1);
        expect(plan.unchanged).toBe(1);
        expect(plan.merged.map((s) => s.id).sort()).toEqual(['a', 'b']);
    });

    test('a stored session absent from the file is kept untouched', () => {
        const stored = [transmuteSession({ id: 'a' }), transmuteSession({ id: 'b' })];
        const imported = [transmuteSession({ id: 'a', totalSuccesses: 99 })];
        const plan = planAlchemyImportMerge(stored, imported);

        expect(plan.unchanged).toBe(1);
        const kept = plan.merged.find((s) => s.id === 'b');
        expect(kept).toEqual(transmuteSession({ id: 'b' }));
    });

    test('an empty import changes nothing', () => {
        const stored = [transmuteSession({ id: 'a' }), transmuteSession({ id: 'b' })];
        const plan = planAlchemyImportMerge(stored, []);

        expect(plan.replaced).toBe(0);
        expect(plan.added).toBe(0);
        expect(plan.unchanged).toBe(2);
        expect(plan.merged).toEqual(stored);
    });

    test('importing into empty storage adds everything', () => {
        const imported = [transmuteSession({ id: 'a' }), transmuteSession({ id: 'b' })];
        const plan = planAlchemyImportMerge([], imported);

        expect(plan.added).toBe(2);
        expect(plan.unchanged).toBe(0);
        expect(plan.merged).toEqual(imported);
    });
});
