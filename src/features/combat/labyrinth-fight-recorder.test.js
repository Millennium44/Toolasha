/**
 * The recorder is passive and persistent: it keeps every fight without arming,
 * tags each with the gear it was fought in, and pools by that gear so a change
 * of loadout starts fresh. These pin the gating, the fingerprint filter, and the
 * bounded, persisted store.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const storageMock = vi.hoisted(() => {
    const stores = new Map();
    const storeFor = (name) => {
        if (!stores.has(name)) stores.set(name, new Map());
        return stores.get(name);
    };
    return {
        stores,
        storeFor,
        unavailable: false,
        reset() {
            stores.clear();
            storageMock.unavailable = false;
        },
        get: async (key, store = 'settings', fallback = null) => {
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null ? map.get(key) : fallback;
        },
        tryGet: async (key, store = 'settings') => {
            if (storageMock.unavailable) return null;
            const map = storeFor(store);
            return map.has(key) && map.get(key) != null
                ? { found: true, value: structuredClone(map.get(key)) }
                : { found: false, value: null };
        },
        set: async (key, value, store = 'settings') => {
            if (storageMock.unavailable) return false;
            storeFor(store).set(key, structuredClone(value));
            return true;
        },
        delete: async (key, store = 'settings') => {
            storeFor(store).delete(key);
            return true;
        },
        getAllKeys: async (store = 'settings') => Array.from(storeFor(store).keys()),
    };
});

vi.mock('../../core/storage.js', () => ({ default: storageMock }));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => 'char1', getCurrentCharacterGameMode: () => 'standard' },
}));
vi.mock('../../utils/adoption-consent.js', () => ({
    getAdoptionTargetId: async () => 'char1',
    requestAdoptionConsent: () => Promise.resolve(null),
}));

import recorder, {
    attemptIdentity,
    mergeAttempts,
    replayBuildIdFor,
    MAX_ATTEMPTS,
    MAX_REPLAY_BUILDS,
    REPLAY_BUILD_FORMAT,
} from './labyrinth-fight-recorder.js';
import { FINGERPRINT_VERSION } from './labyrinth-fingerprint.js';

/**
 * The fights as stored under this character's key.
 *
 * The stored value is `{ clearedAt, entries }` — the epoch is what makes the
 * Accuracy tab's Reset survive a sync pull; `raw()` is the whole record.
 */
const raw = () => storageMock.storeFor('labyrinth').get('labyrinthFightRecorder_char1');
const stored = () => raw()?.entries;
/** Write a pool straight into storage, as a previous session would have left it */
const seedStored = (pool) => storageMock.storeFor('labyrinth').set('labyrinthFightRecorder_char1', pool);

/**
 * An attempt as the recorder stored it before fingerprints carried a version:
 * the same shape, with no `fingerprintVersion` field.
 */
const legacyStored = (over = {}) => {
    const stored = { ...attempt(), model: { fullKit: true, version: '3.0.0' }, complete: true, ...over };
    delete stored.fingerprintVersion;
    return stored;
};

/** Let fire-and-forget writes settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function attempt(over = {}) {
    return {
        monsterHrid: '/monsters/cyclops',
        monsterName: 'Cyclops',
        roomLevel: 200,
        seconds: 40,
        outcome: 'death',
        cleared: false,
        monsterMaxHp: 1000,
        monsterHpEnd: 300,
        playerMaxHp: 500,
        playerHpStart: 500,
        playerHpEnd: 0,
        monsterDamage: 700,
        playerDamageTaken: 500,
        fingerprint: 'gearA',
        ...over,
    };
}

beforeEach(async () => {
    storageMock.reset();
    recorder.forget();
    recorder.clearRecording();
    await settle();
    storageMock.reset();
});

describe('labyrinth fight recorder', () => {
    test('persists a detached historical room build across reload', async () => {
        const replayInputs = {
            version: 1,
            playerDTO: { hrid: 'player1', attackLevel: 10 },
            crates: [],
            communityBuffs: {},
            labyrinthCombatBuffs: [],
            fullAbilities: true,
        };
        recorder.noteAttempt(attempt({ replayInputs }));
        replayInputs.playerDTO.attackLevel = 99;
        await settle();
        recorder.forget();
        await recorder.load();
        expect(recorder.recordedAttempts()[0].replayInputs.playerDTO.attackLevel).toBe(10);
    });
    test('fights are kept passively, no arming', () => {
        recorder.noteAttempt(attempt());
        recorder.noteAttempt(attempt({ outcome: 'clear', cleared: true }));
        expect(recorder.recordingStatus().attempts).toBe(2);
    });

    test('a fight is pooled under the gear it was fought in', () => {
        recorder.noteAttempt(attempt({ fingerprint: 'gearA' }));
        recorder.noteAttempt(attempt({ fingerprint: 'gearB' }));
        expect(recorder.recordingStatus('gearA').attempts).toBe(1);
        expect(recorder.recordingStatus('gearB').attempts).toBe(1);
        expect(recorder.recordedAttempts('gearA').every((a) => a.fingerprint === 'gearA')).toBe(true);
        expect(recorder.recordingStatus().total).toBe(2);
    });

    test('an abandon, an unknown outcome, and a scaleless fight are dropped', () => {
        recorder.noteAttempt(attempt({ seconds: 1 }));
        recorder.noteAttempt(attempt({ outcome: 'unknown' }));
        recorder.noteAttempt(attempt({ monsterMaxHp: 0 }));
        expect(recorder.recordingStatus().attempts).toBe(0);
    });

    test('gross damage figures are kept, and null when not measured', () => {
        recorder.noteAttempt(attempt({ monsterDamage: 5000, playerDamageTaken: 2600 }));
        recorder.noteAttempt(attempt({ monsterDamage: undefined, playerDamageTaken: undefined }));
        const [a, b] = recorder.recordedAttempts();
        expect(a.monsterDamage).toBe(5000);
        expect(a.playerDamageTaken).toBe(2600);
        expect(b.monsterDamage).toBeNull();
    });

    test('swing counts are kept, and null on recordings without them', () => {
        recorder.noteAttempt(attempt({ playerHits: 40, playerMisses: 10 }));
        recorder.noteAttempt(attempt()); // no swing counts
        const [a, b] = recorder.recordedAttempts();
        expect(a.playerHits).toBe(40);
        expect(a.playerMisses).toBe(10);
        expect(b.playerHits).toBeNull();
        expect(b.playerMisses).toBeNull();
    });

    test('crit counts are kept, and null on recordings without them', () => {
        recorder.noteAttempt(attempt({ playerHits: 40, playerCrits: 12 }));
        recorder.noteAttempt(attempt()); // no crit count
        const [a, b] = recorder.recordedAttempts();
        expect(a.playerCrits).toBe(12);
        expect(b.playerCrits).toBeNull();
    });

    test('DoT tick counts are kept, and null on recordings without them', () => {
        recorder.noteAttempt(attempt({ playerHits: 40, playerDotTicks: 10 }));
        recorder.noteAttempt(attempt({ playerHits: 40, playerDotTicks: 0 })); // a real zero
        recorder.noteAttempt(attempt()); // recorded before ticks were counted
        const [a, b, c] = recorder.recordedAttempts();
        expect(a.playerDotTicks).toBe(10);
        expect(b.playerDotTicks).toBe(0);
        expect(c.playerDotTicks).toBeNull();
    });

    test('DoT damage is kept beside the ticks, and null on recordings without it', () => {
        recorder.noteAttempt(attempt({ playerHits: 40, playerDotTicks: 10, playerDotDamage: 800 }));
        recorder.noteAttempt(attempt({ playerHits: 40, playerDotTicks: 0, playerDotDamage: 0 })); // a real zero
        recorder.noteAttempt(attempt({ playerHits: 40 })); // recorded before the split
        const [a, b, c] = recorder.recordedAttempts();
        expect(a.playerDotDamage).toBe(800);
        expect(b.playerDotDamage).toBe(0);
        expect(c.playerDotDamage).toBeNull();
    });

    test('the buffer is bounded to the newest 1000', () => {
        for (let i = 0; i < 1100; i++) recorder.noteAttempt(attempt());
        expect(recorder.recordingStatus().attempts).toBe(1000);
    });

    test('the cap is age-ordered, so pre-migration records cannot crowd out new ones', async () => {
        // A pool already full of history from before the migration
        seedStored(Array.from({ length: 1000 }, (_, i) => legacyStored({ recordId: `old-${i}` })));
        recorder.forget();
        await recorder.load();
        expect(recorder.recordingStatus().legacyFingerprint).toBe(1000);

        // Every new fight lands; an old one falls off for each
        for (let i = 0; i < 120; i++) recorder.noteAttempt(attempt());

        const status = recorder.recordingStatus();
        expect(status.total).toBe(1000);
        expect(status.legacyFingerprint).toBe(880);
        const current = recorder.recordedAttempts().filter((a) => a.fingerprintVersion === FINGERPRINT_VERSION);
        expect(current).toHaveLength(120);
    });

    test('eviction is version-blind: a mixed pool still loses its oldest first', async () => {
        // v1 (unstamped) and v2 records, oldest first, filling the cap exactly.
        // Nothing reserves space per version — the whole point of the cap is
        // that history ages out in the order it arrived.
        seedStored([
            ...Array.from({ length: 500 }, (_, i) => legacyStored({ recordId: `v1-${i}` })),
            ...Array.from({ length: 500 }, (_, i) => ({
                ...legacyStored({ recordId: `v2-${i}` }),
                fingerprintVersion: 2,
            })),
        ]);
        recorder.forget();
        await recorder.load();
        expect(recorder.recordingStatus().legacyFingerprint).toBe(1000);

        for (let i = 0; i < 600; i++) recorder.noteAttempt(attempt());

        const kept = recorder.recordedAttempts();
        expect(kept).toHaveLength(1000);
        // The 600 oldest went, and they were all v1 — the v2 half is untouched
        expect(kept.filter((a) => a.recordId?.startsWith('v1-'))).toHaveLength(0);
        expect(kept.filter((a) => a.recordId?.startsWith('v2-'))).toHaveLength(400);
        expect(kept.filter((a) => a.fingerprintVersion === FINGERPRINT_VERSION)).toHaveLength(600);
    });

    test('a v2 record is legacy under v3, kept and counted but never pooled', async () => {
        seedStored([{ ...legacyStored({ recordId: 'v2-one' }), fingerprintVersion: 2 }]);
        recorder.forget();
        await recorder.load();
        recorder.noteAttempt(attempt());

        const status = recorder.recordingStatus();
        expect(status.total).toBe(2);
        // Kept and shown, and counted apart — the v2 cohort is not deleted
        expect(status.legacyFingerprint).toBe(1);
        expect(recorder.recordedAttempts().some((a) => a.recordId === 'v2-one')).toBe(true);
    });

    test('clearing empties the pool', () => {
        recorder.noteAttempt(attempt());
        recorder.clearRecording();
        expect(recorder.recordingStatus().attempts).toBe(0);
    });

    test('recordedAttempts hands back copies, not the buffer', () => {
        recorder.noteAttempt(attempt());
        const first = recorder.recordedAttempts();
        first[0].seconds = 999;
        expect(recorder.recordedAttempts()[0].seconds).toBe(40);
    });

    test('the reconciliation and timing fields are kept, and null on legacy callers', () => {
        recorder.noteAttempt(
            attempt({
                monsterHpStart: 14_320,
                monsterHealed: 100,
                unattributedDealt: -12, // signed residual, stored as-is
                battleStartedAt: 1_000_000,
                firstUpdateAt: 1_001_000,
                lastTickAt: 1_040_000,
                resolvedAt: 1_044_000,
                resolveReason: 'stale',
                complete: true,
            })
        );
        recorder.noteAttempt(attempt()); // a caller from before the fields existed
        const [a, b] = recorder.recordedAttempts();
        expect(a).toMatchObject({
            monsterHpStart: 14_320,
            monsterHealed: 100,
            unattributedDealt: -12,
            battleStartedAt: 1_000_000,
            firstUpdateAt: 1_001_000,
            lastTickAt: 1_040_000,
            resolvedAt: 1_044_000,
            resolveReason: 'stale',
            complete: true,
        });
        expect(b).toMatchObject({
            monsterHpStart: null,
            monsterHealed: null,
            unattributedDealt: null,
            battleStartedAt: null,
            firstUpdateAt: null,
            lastTickAt: null,
            resolvedAt: null,
            resolveReason: null,
        });
        // A fight not stated to be complete is not one
        expect(b.complete).toBe(false);
    });

    test('a nonsense reconciliation field reads as unmeasured, not as a figure', () => {
        recorder.noteAttempt(attempt({ monsterHpStart: 'soon', monsterHealed: -5, complete: 'yes' }));
        const [a] = recorder.recordedAttempts();
        expect(a.monsterHpStart).toBeNull();
        expect(a.monsterHealed).toBeNull(); // healing cannot be negative
        expect(a.complete).toBe(false); // strictly boolean true, nothing truthy
    });

    test('the prediction in effect at record time is stored, and null when there was none', () => {
        recorder.noteAttempt(attempt({ predicted: 0.42 }));
        recorder.noteAttempt(attempt()); // room never simmed
        recorder.noteAttempt(attempt({ predicted: 1.7 })); // not a probability
        const [a, b, c] = recorder.recordedAttempts();
        expect(a.predicted).toBe(0.42);
        expect(b.predicted).toBeNull();
        expect(c.predicted).toBeNull();
    });

    test('every new attempt carries the sim-model marker', () => {
        // Attempts without it are the legacy cohort from before the full-kit
        // switch, which the accuracy views count but never pool
        recorder.noteAttempt(attempt());
        const [a] = recorder.recordedAttempts();
        expect(a.model.fullKit).toBe(true);
        // No userscript sandbox in tests, so the guarded version reads null
        expect(a.model.version).toBeNull();
    });

    test('the recording file says which script, server and sim model produced it', () => {
        recorder.noteAttempt(attempt());
        const file = recorder.recordingFile();
        expect(file.version).toBe(4);
        expect(file.fullKit).toBe(true);
        expect(file.fingerprintVersion).toBe(FINGERPRINT_VERSION);
        expect(file).toHaveProperty('fingerprintSpec');
        expect(file).toHaveProperty('toolashaVersion');
        expect(file).toHaveProperty('host');
        expect(file).toHaveProperty('isTestServer');
    });

    test('every fight is stamped with the fingerprint definition in force', () => {
        recorder.noteAttempt(attempt());
        const [a] = recorder.recordedAttempts();
        expect(a.fingerprintVersion).toBe(FINGERPRINT_VERSION);
    });

    test('the stamp comes from the build, not from the caller', () => {
        // A caller could otherwise label a value the current fingerprint
        // produced as one an older definition did, and the cohort split would
        // believe it
        recorder.noteAttempt(attempt({ fingerprintVersion: 1 }));
        const [a] = recorder.recordedAttempts();
        expect(a.fingerprintVersion).toBe(FINGERPRINT_VERSION);
    });

    test('records from before the stamp existed are read back whole, and counted apart', async () => {
        // What storage holds for a character who last played before the
        // migration: attempts in the same shape, with no version field
        seedStored([
            legacyStored({ recordId: 'old-1' }),
            legacyStored({ recordId: 'old-2', monsterHrid: '/monsters/imp' }),
        ]);
        recorder.forget();
        await recorder.load();

        const pool = recorder.recordedAttempts();
        expect(pool).toHaveLength(2);
        // Readable: nothing about them is dropped or rewritten on the way out
        expect(pool[0].monsterHrid).toBe('/monsters/cyclops');
        expect(pool[0].seconds).toBe(40);
        expect(pool[0].fingerprintVersion).toBeUndefined();
        // Counted apart, so a panel can say what the migration set aside
        expect(recorder.recordingStatus().legacyFingerprint).toBe(2);
    });

    test('a current-fingerprint filter never reaches a pre-migration record', async () => {
        // The value carries its version, so this holds without the filter
        // knowing anything about cohorts
        seedStored([legacyStored({ recordId: 'old-1', fingerprint: 'gearA' })]);
        recorder.forget();
        await recorder.load();
        recorder.noteAttempt(attempt({ fingerprint: 'v2:gearA' }));

        expect(recorder.recordedAttempts('v2:gearA')).toHaveLength(1);
        expect(recorder.recordedAttempts('v2:gearA')[0].fingerprintVersion).toBe(FINGERPRINT_VERSION);
        // Still in the pool, still browsable — just not in that pool
        expect(recorder.recordingStatus().total).toBe(2);
    });

    test('a replay comparison embeds beside the attempts without clobbering the format', () => {
        recorder.noteAttempt(attempt());
        const file = recorder.recordingFile({ replay: { groups: [{ monsterHrid: '/m' }] }, format: 'sneaky' });
        expect(file.format).toBe('toolasha-labyrinth-recording');
        expect(file.attempts).toHaveLength(1);
        expect(file.replay.groups).toHaveLength(1);
    });

    test('the pool is written to storage and read back on load', async () => {
        recorder.noteAttempt(attempt());
        // The persist is fire-and-forget; let it settle
        await settle();
        expect(Array.isArray(stored())).toBe(true);
        expect(stored()).toHaveLength(1);

        recorder.forget();
        expect(recorder.recordingStatus().total).toBe(0);
        await recorder.load();
        expect(recorder.recordingStatus().total).toBe(1);
    });
});

describe('the pool survives a failed read and a second tab', () => {
    test('a load that cannot read storage keeps the fights in memory', async () => {
        recorder.noteAttempt(attempt());
        await settle();
        storageMock.unavailable = true;

        await recorder.load();

        expect(recorder.recordingStatus().total).toBe(1);
    });

    test('a save while storage is unreadable is skipped and what is stored stays', async () => {
        recorder.noteAttempt(attempt());
        await settle();
        expect(stored()).toHaveLength(1);
        storageMock.unavailable = true;

        recorder.noteAttempt(attempt({ outcome: 'clear', cleared: true }));
        await settle();

        storageMock.unavailable = false;
        expect(stored()).toHaveLength(1);
        expect(recorder.recordingStatus().total).toBe(2);
    });

    test('a save folds in fights another tab stored meanwhile', async () => {
        recorder.noteAttempt(attempt());
        await settle();
        const theirs = { ...stored()[0], recordId: 'other-tab', outcome: 'clear' };
        storageMock
            .storeFor('labyrinth')
            .set('labyrinthFightRecorder_char1', { clearedAt: 0, entries: [...stored(), theirs] });

        recorder.noteAttempt(attempt({ seconds: 50 }));
        await settle();

        expect(stored()).toHaveLength(3);
        expect(recorder.recordingStatus().total).toBe(3);
    });

    test('once storage reads again the next save lands everything', async () => {
        storageMock.unavailable = true;
        recorder.noteAttempt(attempt());
        recorder.noteAttempt(attempt({ seconds: 50 }));
        await settle();
        expect(stored()).toBeUndefined();

        storageMock.unavailable = false;
        recorder.noteAttempt(attempt({ seconds: 60 }));
        await settle();

        expect(stored()).toHaveLength(3);
    });

    test('attempts recorded before ids were minted are told apart by their measurements', () => {
        const legacy = { monsterHrid: '/monsters/a', roomLevel: 1, seconds: 10, outcome: 'death' };
        expect(attemptIdentity(legacy)).toBe(attemptIdentity({ ...legacy }));
        expect(attemptIdentity(legacy)).not.toBe(attemptIdentity({ ...legacy, seconds: 11 }));
        expect(attemptIdentity({ ...legacy, recordId: 'x' })).toBe('x');
    });
});

describe('saved room builds are interned, not copied onto every fight', () => {
    /** Saved replay inputs for one build, distinguished by attack level */
    const build = (attackLevel) => ({
        version: 1,
        playerDTO: { hrid: 'player1', attackLevel, abilities: [] },
        crates: [],
        communityBuffs: {},
        labyrinthCombatBuffs: [],
        fullAbilities: true,
    });
    /** A stored attempt, identified, dated and carrying a saved build */
    const withBuild = (recordId, resolvedAt, attackLevel) => ({
        ...attempt(),
        recordId,
        resolvedAt,
        replayInputs: build(attackLevel),
    });

    test('consecutive fights on one build store that build once', async () => {
        for (let i = 0; i < 5; i++) recorder.noteAttempt(attempt({ replayInputs: build(10) }));
        await settle();
        const entries = stored();
        expect(entries).toHaveLength(5);
        // Exactly one record carries the build; the rest reference it
        expect(entries.filter((entry) => entry.replayInputs).length).toBe(1);
        expect(new Set(entries.map((entry) => entry.replayBuildId)).size).toBe(1);
        // And every fight still reads back with its build
        recorder.forget();
        await recorder.load();
        const read = recorder.recordedAttempts();
        expect(read).toHaveLength(5);
        expect(read.every((a) => a.replayInputs?.playerDTO?.attackLevel === 10)).toBe(true);
    });

    test('two builds stay two builds, and a fight never reads back the wrong one', async () => {
        recorder.noteAttempt(attempt({ replayInputs: build(10) }));
        recorder.noteAttempt(attempt({ replayInputs: build(10) }));
        recorder.noteAttempt(attempt({ replayInputs: build(11) }));
        await settle();
        expect(stored().filter((entry) => entry.replayInputs).length).toBe(2);
        recorder.forget();
        await recorder.load();
        expect(recorder.recordedAttempts().map((a) => a.replayInputs.playerDTO.attackLevel)).toEqual([10, 10, 11]);
    });

    test('a sync of two devices holding different builds keeps both', () => {
        const mine = [withBuild('mine-a', 1_000, 10), withBuild('mine-b', 2_000, 10)];
        const theirs = [withBuild('theirs-a', 3_000, 11), withBuild('theirs-b', 4_000, 11)];
        const entries = mergeAttempts(mine, theirs).entries;
        expect(entries.map((entry) => entry.recordId)).toEqual(['mine-a', 'mine-b', 'theirs-a', 'theirs-b']);
        expect(entries.filter((entry) => entry.replayInputs).length).toBe(2);
        // Every id resolves inside the merged record, and to the right build
        const byId = new Map(entries.filter((e) => e.replayInputs).map((e) => [e.replayBuildId, e.replayInputs]));
        expect(entries.map((entry) => byId.get(entry.replayBuildId)?.playerDTO.attackLevel)).toEqual([10, 10, 11, 11]);
    });

    test('eviction never leaves a fight pointing at a build that was dropped', () => {
        // The build's carrier is the OLDEST fight using it, which is exactly
        // what the ring cap drops first
        const older = Array.from({ length: MAX_ATTEMPTS }, (_, i) => withBuild(`old-${i}`, 1_000 + i, 10));
        const newer = [withBuild('new', 9_000_000, 10)];
        const entries = mergeAttempts(older, newer).entries;
        expect(entries).toHaveLength(MAX_ATTEMPTS);
        const carriers = new Set(entries.filter((entry) => entry.replayInputs).map((entry) => entry.replayBuildId));
        expect(carriers.size).toBe(1);
        for (const entry of entries) expect(carriers.has(entry.replayBuildId)).toBe(true);
    });

    test('a clear epoch dropping the oldest fights does not orphan the survivors', () => {
        const mine = [withBuild('before', 1_000, 10), withBuild('after', 5_000, 10)];
        const entries = mergeAttempts(mine, { clearedAt: 2_000, entries: [] }).entries;
        expect(entries.map((entry) => entry.recordId)).toEqual(['after']);
        expect(entries[0].replayInputs.playerDTO.attackLevel).toBe(10);
    });

    test('the build table is capped, and a fight past it reverts to the legacy path', () => {
        const many = Array.from({ length: MAX_REPLAY_BUILDS + 5 }, (_, i) => withBuild(`f-${i}`, 1_000 + i, i));
        const entries = mergeAttempts(many, []).entries;
        expect(entries.filter((entry) => entry.replayInputs).length).toBe(MAX_REPLAY_BUILDS);
        // The oldest five lost their inputs AND their id together, so nothing
        // dangles; they still carry every measurement and their fingerprint
        const dropped = entries.slice(0, 5);
        expect(dropped.every((entry) => entry.replayInputs === null && entry.replayBuildId === null)).toBe(true);
        expect(dropped.every((entry) => entry.fingerprint === 'gearA' && entry.monsterDamage === 700)).toBe(true);
    });

    test('an id is the build’s own content, so two internings of it agree', () => {
        const a = mergeAttempts([withBuild('a', 1_000, 10)], []).entries[0].replayBuildId;
        const b = mergeAttempts([withBuild('b', 2_000, 10)], []).entries[0].replayBuildId;
        const other = mergeAttempts([withBuild('c', 3_000, 11)], []).entries[0].replayBuildId;
        expect(a).toBe(b);
        expect(a).not.toBe(other);
        expect(replayBuildIdFor('some key')).toBe(replayBuildIdFor('some key'));
        expect(replayBuildIdFor('some key')).not.toBe(replayBuildIdFor('some other key'));
    });

    test('two independently interned pools, folded without expansion, never cross-bind', () => {
        // The mixed-fleet hazard: a client whose `mergeAttempts` does not expand
        // before unioning pulls one interned pool, then another from a second
        // device, and stores the two arrays concatenated. With positional ids
        // both carriers called themselves `b0`, the expansion kept whichever it
        // saw last, and a fight fought at attack 10 replayed as attack 99.
        const poolA = mergeAttempts([withBuild('a-1', 1_000, 10), withBuild('a-2', 2_000, 10)], []).entries;
        const poolB = mergeAttempts([withBuild('b-1', 3_000, 99), withBuild('b-2', 4_000, 99)], []).entries;
        const asAnOldClientLeftIt = [...poolA, ...poolB];

        const entries = mergeAttempts(asAnOldClientLeftIt, []).entries;
        const byId = new Map(entries.filter((e) => e.replayInputs).map((e) => [e.replayBuildId, e.replayInputs]));
        const resolved = entries.map((entry) => [
            entry.recordId,
            byId.get(entry.replayBuildId)?.playerDTO.attackLevel ?? null,
        ]);
        expect(resolved).toEqual([
            ['a-1', 10],
            ['a-2', 10],
            ['b-1', 99],
            ['b-2', 99],
        ]);
    });

    test('an id two different builds claim is refused, not guessed', () => {
        // What a pre-fix pool can already hold on disk. Losing the build costs
        // a fight its recorded inputs; guessing costs it a confident wrong
        // verdict, so the fight falls back rather than binding to build 99.
        const entries = mergeAttempts(
            [
                { ...withBuild('a-1', 1_000, 10), replayBuildId: 'b0' },
                { ...attempt(), recordId: 'a-2', resolvedAt: 1_500, replayBuildId: 'b0', replayInputs: null },
                { ...withBuild('b-1', 3_000, 99), replayBuildId: 'b0' },
            ],
            []
        ).entries;
        const orphan = entries.find((entry) => entry.recordId === 'a-2');
        expect(orphan.replayInputs).toBeNull();
        expect(orphan.replayBuildId).toBeNull();
        expect(orphan.monsterDamage).toBe(700);
        // The two real builds are both still there, each on its own id
        const ids = new Set(entries.filter((entry) => entry.replayInputs).map((entry) => entry.replayBuildId));
        expect(ids.size).toBe(2);
    });
});

describe('the stored pool says which interning scheme it was written under', () => {
    const build = (attackLevel) => ({
        version: 1,
        playerDTO: { hrid: 'player1', attackLevel, abilities: [] },
        crates: [],
        communityBuffs: {},
        labyrinthCombatBuffs: [],
        fullAbilities: true,
    });

    test('what is written out carries the marker', async () => {
        recorder.noteAttempt(attempt({ replayInputs: build(10) }));
        await settle();
        expect(raw().replayBuildFormat).toBe(REPLAY_BUILD_FORMAT);
        expect(mergeAttempts([], []).replayBuildFormat).toBe(REPLAY_BUILD_FORMAT);
    });

    test('a legacy pool with no marker still loads, inputs or not', async () => {
        // The shape on real disks: a bare array of verbatim records, most of
        // them carrying a fingerprint and no replayInputs at all
        seedStored([
            { ...attempt(), recordId: 'legacy-bare', resolvedAt: 1_000 },
            { ...attempt(), recordId: 'legacy-with-build', resolvedAt: 2_000, replayInputs: build(10) },
        ]);
        recorder.forget();
        await recorder.load();

        const read = recorder.recordedAttempts();
        expect(read.map((entry) => entry.recordId)).toEqual(['legacy-bare', 'legacy-with-build']);
        expect(read[0].fingerprint).toBe('gearA');
        expect(read[0].replayInputs ?? null).toBeNull();
        expect(read[1].replayInputs.playerDTO.attackLevel).toBe(10);
    });

    test('a pool written under a newer scheme is left unresolved rather than guessed at', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            seedStored({
                clearedAt: 0,
                replayBuildFormat: REPLAY_BUILD_FORMAT + 1,
                entries: [
                    {
                        ...attempt(),
                        recordId: 'carrier',
                        resolvedAt: 1_000,
                        replayBuildId: 'x',
                        replayInputs: build(7),
                    },
                    { ...attempt(), recordId: 'reference', resolvedAt: 2_000, replayBuildId: 'x', replayInputs: null },
                ],
            });
            recorder.forget();
            await recorder.load();

            const read = recorder.recordedAttempts();
            expect(read.map((entry) => entry.recordId)).toEqual(['carrier', 'reference']);
            // The referencing fight keeps every measurement it had; what it
            // does not get is a build this build cannot prove is its own
            expect(read.find((entry) => entry.recordId === 'reference').replayInputs ?? null).toBeNull();
            expect(read.find((entry) => entry.recordId === 'reference').monsterDamage).toBe(700);
            expect(warn).toHaveBeenCalled();
        } finally {
            warn.mockRestore();
        }
    });

    test('a pool written under a newer scheme is not destroyed by the next write', async () => {
        // Refusing to EXPAND made the read safe and left the write destructive:
        // the unexpanded entries still went through interning and came back
        // stamped format 1, re-interning the carrier under a content id and
        // leaving the reference pointing at nothing. One fight recorded here
        // erased the newer client's builds from disk for good.
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const newerPool = {
                clearedAt: 0,
                replayBuildFormat: REPLAY_BUILD_FORMAT + 1,
                entries: [
                    {
                        ...attempt(),
                        recordId: 'carrier',
                        resolvedAt: 1_000,
                        replayBuildId: 'x',
                        replayInputs: build(7),
                    },
                    { ...attempt(), recordId: 'reference', resolvedAt: 2_000, replayBuildId: 'x', replayInputs: null },
                ],
            };
            seedStored(newerPool);
            recorder.forget();
            await recorder.load();

            recorder.noteAttempt(attempt({ recordId: 'ours', replayInputs: build(10) }));
            await settle();

            const written = raw();
            expect(written.replayBuildFormat).toBe(REPLAY_BUILD_FORMAT + 1);
            expect(written.entries.map((entry) => entry.recordId)).toEqual(['carrier', 'reference']);
            expect(written.entries.find((entry) => entry.recordId === 'carrier').replayBuildId).toBe('x');
            expect(written.entries.find((entry) => entry.recordId === 'reference').replayBuildId).toBe('x');
        } finally {
            warn.mockRestore();
        }
    });

    test('a newer pool arriving from a peer is kept as written, not folded down', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const theirs = {
                clearedAt: 0,
                replayBuildFormat: REPLAY_BUILD_FORMAT + 1,
                entries: [{ ...attempt(), recordId: 'theirs', resolvedAt: 9_000, replayBuildId: 'x' }],
            };
            expect(mergeAttempts([{ ...attempt(), recordId: 'mine', resolvedAt: 1_000 }], theirs)).toEqual(theirs);
        } finally {
            warn.mockRestore();
        }
    });
});

describe('the ring cap drops the oldest fight, not the one that arrived last', () => {
    /** A stored attempt, identified and dated */
    const dated = (recordId, resolvedAt) => ({ ...attempt(), recordId, resolvedAt });

    test('the merged pool is ordered oldest-first however the two sides were ordered', () => {
        const mine = [dated('mine-old', 5_000), dated('mine-new', 6_000)];
        // A device that has been offline for a week: its fights are older than
        // everything stored here, and they arrive on the *new* side
        const theirs = [dated('offline', 1_000)];

        expect(mergeAttempts(mine, theirs).entries.map((entry) => entry.recordId)).toEqual([
            'offline',
            'mine-old',
            'mine-new',
        ]);
    });

    test('a full pool evicts its oldest, not whichever side the entry arrived on', () => {
        const mine = Array.from({ length: MAX_ATTEMPTS }, (_, i) => dated(`mine-${i}`, 10_000 + i));
        const theirs = [dated('offline', 1)];

        const merged = mergeAttempts(mine, theirs).entries;

        expect(merged).toHaveLength(MAX_ATTEMPTS);
        // The week-old fight is the oldest in the union, so it is the one that
        // falls off — untimed, it displaced `mine-0`, which is newer than it
        expect(merged.some((entry) => entry.recordId === 'offline')).toBe(false);
        expect(merged[0].recordId).toBe('mine-0');
    });

    test('a record carrying no timestamp sorts oldest, where an undatable record belongs', () => {
        const undated = { ...attempt(), recordId: 'undated' };
        delete undated.resolvedAt;
        delete undated.battleStartedAt;

        expect(mergeAttempts([dated('timed', 5_000)], [undated]).entries.map((entry) => entry.recordId)).toEqual([
            'undated',
            'timed',
        ]);
    });
});

describe('the Accuracy tab’s Reset survives a sync pull', () => {
    /** A stored attempt, identified and dated */
    const dated = (recordId, resolvedAt) => ({ ...attempt(), recordId, resolvedAt });
    // The stored shape gained `replayBuildFormat` when the pool started saying
    // which interning scheme it was written under; these tests are about the
    // clear epoch and compare whole records, so the helper carries it too
    const pool = (entries, clearedAt = 0) => ({ clearedAt, entries, replayBuildFormat: REPLAY_BUILD_FORMAT });

    test('the emptied pool wins the round trip a fuller peer would otherwise win', () => {
        // A clears and pushes; B pulls. The union has no way to say a fight was
        // thrown away, so without the epoch B's copy restores it - and restores
        // it to A on the next pull
        const full = [dated('old-1', 500), dated('old-2', 600)];
        const cleared = pool([], 1_000);

        const bPulled = mergeAttempts(full, cleared);
        expect(bPulled).toEqual(pool([], 1_000));
        expect(mergeAttempts(cleared, bPulled)).toEqual(pool([], 1_000));
    });

    test('fights the peer recorded after the Reset survive it', () => {
        // The ordering hazard: the epoch is compared against each fight's own
        // clock, so a fight fought after the Reset is not swept up by it
        const cleared = pool([], 1_000);
        const peer = pool([dated('before', 500), dated('after', 2_000)], 1_000);

        expect(mergeAttempts(cleared, peer).entries.map((entry) => entry.recordId)).toEqual(['after']);
    });

    test('a pool stored before the epoch existed loses to a stamped Reset', () => {
        expect(mergeAttempts([dated('legacy', 500)], pool([], 1_000)).entries).toEqual([]);
    });

    test('a pool no Reset has touched folds exactly as it did', () => {
        const merged = mergeAttempts([dated('mine', 5_000)], [dated('theirs', 6_000)]);
        expect(merged.clearedAt).toBe(0);
        expect(merged.entries.map((entry) => entry.recordId)).toEqual(['mine', 'theirs']);
    });

    test('a Reset from elsewhere that would drop more than a hundred fights is refused', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mine = Array.from({ length: 101 }, (_, i) => dated(`mine-${i}`, 100 + i));

        const merged = mergeAttempts(mine, pool([], 1_000));

        expect(merged.entries).toHaveLength(101);
        // Held back with the fights, so the next fold does not finish it quietly
        expect(merged.clearedAt).toBe(0);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });

    test('the refusal never stands in the way of a Reset this device holds', () => {
        const theirs = Array.from({ length: 101 }, (_, i) => dated(`theirs-${i}`, 100 + i));
        expect(mergeAttempts(pool([], 1_000), theirs).entries).toEqual([]);
    });

    test('a hundred at once still applies', () => {
        const mine = Array.from({ length: 100 }, (_, i) => dated(`mine-${i}`, 100 + i));
        expect(mergeAttempts(mine, pool([], 1_000)).entries).toEqual([]);
    });

    test('clearing the pool stamps what it writes', async () => {
        recorder.noteAttempt(attempt());
        await settle();
        expect(stored()).toHaveLength(1);

        recorder.clearRecording();
        await settle();

        expect(stored()).toEqual([]);
        expect(raw().clearedAt).toBeGreaterThan(0);
        // The marker too: REPLAY_BUILD_FORMAT says every write this module
        // makes carries it, and the clear used to leave the pool at format 0
        // until some later save happened to re-stamp it.
        expect(raw().replayBuildFormat).toBe(REPLAY_BUILD_FORMAT);
        expect(recorder.recordingStatus().total).toBe(0);
    });
});
