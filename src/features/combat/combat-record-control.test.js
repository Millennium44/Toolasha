/**
 * One Record button, two panels.
 *
 * Sim Accuracy used to have no way to start a recording and could only tell you
 * to press Record on the other panel. The point of moving the decision here is
 * that both buttons now read the same recorder, so a recording started anywhere
 * — including by the auto-record setting, which nobody pressed — shows as
 * running on both. That is what these tests pin: the state is read live rather
 * than remembered, and the toggle drives the shared recorder rather than a copy.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { recorder, recordControlState, toggleRecording } from './combat-record-control.js';

/** A recorder that behaves like the real one: one recording, at a time */
function fakeRecorder() {
    const fake = {
        recording: false,
        ticks: 0,
        downloads: 0,
        isRecording: () => fake.recording,
        recordingStatus: () => ({ ticks: fake.ticks, seconds: 0, full: false }),
        startRecording: vi.fn(() => {
            fake.recording = true;
            fake.ticks = 0;
        }),
        stopRecording: vi.fn(() => {
            fake.recording = false;
        }),
        downloadRecording: vi.fn(() => {
            fake.downloads += 1;
            return true;
        }),
    };
    return fake;
}

const bundled = vi.hoisted(() => ({ current: null }));
vi.mock('./combat-recorder.js', () => ({
    default: new Proxy(
        {},
        {
            get: (_target, key) => bundled.current?.[key],
        }
    ),
}));

let shared;

const hadWindow = 'window' in globalThis;
const originalWindow = globalThis.window;

beforeEach(() => {
    shared = fakeRecorder();
    bundled.current = fakeRecorder();
    globalThis.window = { Toolasha: { Combat: { combatRecorder: shared } } };
});

afterEach(() => {
    if (hadWindow) globalThis.window = originalWindow;
    else delete globalThis.window;
});

describe('which recorder is driven', () => {
    test('the shared one, not this bundle’s copy', () => {
        // Each library carries its own copy of the module; starting a recording
        // in the UI bundle's copy would record into something nothing reads
        expect(recorder()).toBe(shared);

        toggleRecording();

        expect(shared.startRecording).toHaveBeenCalledTimes(1);
        expect(bundled.current.startRecording).not.toHaveBeenCalled();
    });

    test('falling back to the import when there is no shared one', () => {
        globalThis.window = {};
        expect(recorder()).not.toBe(shared);

        toggleRecording();

        expect(bundled.current.startRecording).toHaveBeenCalledTimes(1);
    });
});

describe('what the button says', () => {
    test('idle, with nothing kept', () => {
        expect(recordControlState()).toMatchObject({ recording: false, ticks: 0, label: 'Record' });
    });

    test('idle, with a previous recording still in the recorder', () => {
        shared.ticks = 812;
        expect(recordControlState().label).toBe('Record (812 kept)');
    });

    test('running, and how much it has caught', () => {
        // A recording started outside combat sits at zero, and "Recording…"
        // alone cannot be told apart from one that is working
        shared.recording = true;
        shared.ticks = 240;

        const state = recordControlState();
        expect(state).toMatchObject({ recording: true, ticks: 240, label: 'Recording 240…' });
        expect(state.title).toMatch(/stop/i);
    });

    test('the label follows a recording nobody pressed a button to start', () => {
        // Auto-record on load starts one on its own
        expect(recordControlState().recording).toBe(false);
        shared.recording = true;
        shared.ticks = 4;
        expect(recordControlState().recording).toBe(true);
        expect(recordControlState().label).toBe('Recording 4…');
    });

    test('no recorder means no button', () => {
        globalThis.window = { Toolasha: { Combat: { combatRecorder: {} } } };
        bundled.current = null;
        expect(recordControlState()).toBeNull();
        expect(toggleRecording()).toBeNull();
    });
});

describe('the toggle', () => {
    test('starts a recording that was not running', () => {
        expect(toggleRecording()).toBe(true);
        expect(shared.startRecording).toHaveBeenCalledTimes(1);
        expect(recordControlState().recording).toBe(true);
    });

    test('stops one that was, and writes nothing by default', () => {
        shared.recording = true;

        expect(toggleRecording()).toBe(false);

        expect(shared.stopRecording).toHaveBeenCalledTimes(1);
        expect(shared.downloadRecording).not.toHaveBeenCalled();
    });

    test('writes the file out when the caller wants it handed over', () => {
        shared.recording = true;

        toggleRecording({ download: true });

        expect(shared.stopRecording).toHaveBeenCalledTimes(1);
        expect(shared.downloadRecording).toHaveBeenCalledTimes(1);
    });

    test('stopping from one panel is stopping for the other', () => {
        toggleRecording({ download: true });
        expect(recordControlState().recording).toBe(true);

        toggleRecording();

        expect(recordControlState().recording).toBe(false);
        expect(shared.startRecording).toHaveBeenCalledTimes(1);
        expect(shared.stopRecording).toHaveBeenCalledTimes(1);
    });
});
