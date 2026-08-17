/**
 * The recorder is passive and persistent: it keeps every fight without arming,
 * tags each with the gear it was fought in, and pools by that gear so a change
 * of loadout starts fresh. These pin the gating, the fingerprint filter, and the
 * bounded, persisted store.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

let store = {};
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (key) => (key in store ? store[key] : null),
    writeScoped: async (key, value) => {
        store[key] = value;
    },
}));

import recorder from './labyrinth-fight-recorder.js';

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

beforeEach(() => {
    store = {};
    recorder.clearRecording();
});

describe('labyrinth fight recorder', () => {
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

    test('the buffer is bounded to the newest 500', () => {
        for (let i = 0; i < 550; i++) recorder.noteAttempt(attempt());
        expect(recorder.recordingStatus().attempts).toBe(500);
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
        expect(file.version).toBe(3);
        expect(file.fullKit).toBe(true);
        expect(file).toHaveProperty('toolashaVersion');
        expect(file).toHaveProperty('host');
        expect(file).toHaveProperty('isTestServer');
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
        await Promise.resolve();
        expect(Array.isArray(store.labyrinthFightRecorder)).toBe(true);
        expect(store.labyrinthFightRecorder).toHaveLength(1);
    });
});
