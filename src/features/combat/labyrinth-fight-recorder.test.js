/**
 * The recorder keeps per-attempt endpoints only while armed, and drops the reads
 * that cannot support a rate — an abandon, a bad tick, a fight with no scale.
 * These pin that gating and the bounded buffer.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import recorder from './labyrinth-fight-recorder.js';

/** A clean, recordable attempt; override the field under test */
function attempt(overrides = {}) {
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
        ...overrides,
    };
}

beforeEach(() => {
    recorder.stopRecording();
    recorder.clearRecording();
});

describe('labyrinth fight recorder', () => {
    test('nothing is kept while disarmed', () => {
        recorder.noteAttempt(attempt());
        expect(recorder.recordingStatus().attempts).toBe(0);
    });

    test('an armed recording keeps clean attempts', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt());
        recorder.noteAttempt(attempt({ outcome: 'clear', cleared: true, monsterHpEnd: 0, playerHpEnd: 120 }));
        expect(recorder.recordingStatus().attempts).toBe(2);
        expect(recorder.recordingStatus().monsters).toBe(1);
    });

    test('starting again drops the previous sitting', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt());
        recorder.startRecording();
        expect(recorder.recordingStatus().attempts).toBe(0);
    });

    test('an abandon too short to have a rate is dropped', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt({ seconds: 1 }));
        expect(recorder.recordingStatus().attempts).toBe(0);
    });

    test('an unknown outcome is dropped', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt({ outcome: 'unknown' }));
        expect(recorder.recordingStatus().attempts).toBe(0);
    });

    test('a fight with no monster scale is dropped', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt({ monsterMaxHp: 0 }));
        expect(recorder.recordingStatus().attempts).toBe(0);
    });

    test('gross damage figures are kept when measured', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt({ monsterDamage: 5000, playerDamageTaken: 2600 }));
        const a = recorder.recordedAttempts()[0];
        expect(a.monsterDamage).toBe(5000);
        expect(a.playerDamageTaken).toBe(2600);
    });

    test('gross damage is null when a caller could not measure it', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt());
        expect(recorder.recordedAttempts()[0].monsterDamage).toBeNull();
        expect(recorder.recordedAttempts()[0].playerDamageTaken).toBeNull();
    });

    test('recordedAttempts hands back a copy, not the buffer', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt());
        const first = recorder.recordedAttempts();
        first[0].seconds = 999;
        expect(recorder.recordedAttempts()[0].seconds).toBe(40);
    });

    test('the file carries the format tag and the attempts', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt());
        const file = recorder.recordingFile();
        expect(file.format).toBe('toolasha-labyrinth-recording');
        expect(file.attempts).toHaveLength(1);
        expect(file.attempts[0].monsterHrid).toBe('/monsters/cyclops');
    });

    test('a replay comparison embeds beside the attempts without clobbering the format', () => {
        recorder.startRecording();
        recorder.noteAttempt(attempt());
        const replay = { groups: [{ monsterHrid: '/monsters/cyclops', diagnosis: 'x' }], recordedAt: 1 };
        const file = recorder.recordingFile({ replay, format: 'sneaky' });
        // The fixed identity fields win over anything the caller passed
        expect(file.format).toBe('toolasha-labyrinth-recording');
        expect(file.attempts).toHaveLength(1);
        expect(file.replay.groups).toHaveLength(1);
        expect(file.replay.groups[0].monsterHrid).toBe('/monsters/cyclops');
    });

    test('the buffer is bounded and says when it overflowed', () => {
        recorder.startRecording();
        for (let i = 0; i < 450; i++) recorder.noteAttempt(attempt());
        const status = recorder.recordingStatus();
        expect(status.attempts).toBe(400);
        expect(status.truncated).toBe(true);
    });
});
