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

/** Scoped storage, as a map, since the target is one character's */
const store = vi.hoisted(() => ({ data: new Map(), fail: false }));
vi.mock('../../utils/character-key.js', () => ({
    readScoped: async (base, _store, fallback) => (store.data.has(base) ? store.data.get(base) : fallback),
    writeScoped: async (base, value) => {
        if (store.fail) throw new Error('disk full');
        store.data.set(base, value);
        return true;
    },
}));

import {
    recorder,
    recordControlState,
    recordTarget,
    loadRecordTarget,
    setRecordTarget,
    resetRecordTargetCache,
    toggleRecording,
} from './combat-record-control.js';

/** A recorder that behaves like the real one: one recording, and one target, at a time */
function fakeRecorder() {
    const fake = {
        recording: false,
        ticks: 0,
        fights: 0,
        seconds: 0,
        target: null,
        targetMet: false,
        downloads: 0,
        isRecording: () => fake.recording,
        recordingStatus: () => ({
            ticks: fake.ticks,
            fights: fake.fights,
            seconds: fake.seconds,
            full: false,
            target: fake.target,
            targetMet: fake.targetMet,
        }),
        // The real normalizer, near enough: a positive number and a known unit
        normalizeTarget: (raw) =>
            Number(raw?.value) > 0 && ['fights', 'minutes'].includes(raw?.unit)
                ? { value: Number(raw.value), unit: raw.unit }
                : null,
        setRecordTarget: vi.fn((next) => {
            fake.target = fake.normalizeTarget(next);
            return fake.target;
        }),
        recordTarget: () => fake.target,
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

/** Let the fire-and-forget load inside `recordControlState` settle */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    store.data.clear();
    store.fail = false;
    resetRecordTargetCache();
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

    test('once a fight has finished, the label counts fights and not ticks', () => {
        // The recorder banks a segment and empties the buffer when it fills, so
        // a label reading ticks counts to four thousand, drops to zero and
        // starts again on a recording that never stopped
        shared.recording = true;
        shared.ticks = 120;
        shared.fights = 37;

        expect(recordControlState()).toMatchObject({ recording: true, fights: 37, label: 'Recording 37 fights…' });
    });

    test('one fight is one fight', () => {
        shared.recording = true;
        shared.fights = 1;
        expect(recordControlState().label).toBe('Recording 1 fight…');
    });

    test('a long recording says what it kept, not what is left in the buffer', () => {
        shared.ticks = 812;
        shared.fights = 240;
        expect(recordControlState().label).toBe('Record (240 fights kept)');
    });

    test('no recorder means no button', () => {
        globalThis.window = { Toolasha: { Combat: { combatRecorder: {} } } };
        bundled.current = null;
        expect(recordControlState()).toBeNull();
        expect(toggleRecording()).toBeNull();
    });
});

describe('recording for a target', () => {
    test('no target is the label it has always had', async () => {
        shared.recording = true;
        shared.fights = 37;

        expect(recordControlState().label).toBe('Recording 37 fights…');
        await settle();
    });

    test('a fight target counts towards it', () => {
        shared.recording = true;
        shared.fights = 37;
        shared.target = { value: 100, unit: 'fights' };

        expect(recordControlState().label).toBe('Recording 37/100 fights…');
    });

    test('a minutes target counts the minutes', () => {
        shared.recording = true;
        shared.seconds = 12 * 60 + 40;
        shared.target = { value: 30, unit: 'minutes' };

        // Whole minutes: a label ticking through 12.67m would redraw every
        // two seconds saying nothing new
        expect(recordControlState().label).toBe('Recording 12m of 30m…');
    });

    test('reaching it says Done, since nobody was watching when it stopped', () => {
        // Back to "Record (100 fights kept)" is indistinguishable from a
        // recording that was never started
        shared.fights = 100;
        shared.targetMet = true;
        shared.target = { value: 100, unit: 'fights' };

        const state = recordControlState();
        expect(state).toMatchObject({ recording: false, done: true, label: 'Done — 100 fights' });
    });

    test('a target reached with nothing caught is not a Done', () => {
        shared.targetMet = true;
        shared.fights = 0;

        expect(recordControlState()).toMatchObject({ done: false, label: 'Record' });
    });

    test('an idle button with a target says what pressing it will do', () => {
        shared.target = { value: 45, unit: 'minutes' };

        expect(recordControlState().title).toContain('45 minutes');
    });

    test('the state carries the target so a panel can draw the box from it', () => {
        shared.target = { value: 100, unit: 'fights' };
        expect(recordControlState().target).toEqual({ value: 100, unit: 'fights' });
    });
});

describe('remembering the target', () => {
    test('setting one puts it on the shared recorder and in storage', async () => {
        await setRecordTarget({ value: 100, unit: 'fights' });

        expect(shared.target).toEqual({ value: 100, unit: 'fights' });
        expect(store.data.get('combatRecordControl_target')).toEqual({ value: 100, unit: 'fights' });
    });

    test('and it comes back on the next session', async () => {
        store.data.set('combatRecordControl_target', { value: 45, unit: 'minutes' });

        await loadRecordTarget();

        expect(recordTarget()).toEqual({ value: 45, unit: 'minutes' });
    });

    test('nothing stored is unlimited, which is what it has always done', async () => {
        await loadRecordTarget();

        expect(recordTarget()).toBe(null);
        expect(recordControlState().label).toBe('Record');
    });

    test('clearing it is stored as clearing it, not left as the old number', async () => {
        await setRecordTarget({ value: 100, unit: 'fights' });
        await setRecordTarget(null);

        expect(shared.target).toBe(null);
        expect(store.data.get('combatRecordControl_target')).toBe(null);
    });

    test('the read happens once, however many times the panels redraw', async () => {
        store.data.set('combatRecordControl_target', { value: 12, unit: 'fights' });

        recordControlState();
        recordControlState();
        await settle();
        recordControlState();
        await settle();

        expect(shared.setRecordTarget).toHaveBeenCalledTimes(1);
    });

    test('a target set by hand is not overwritten by a load landing after it', async () => {
        store.data.set('combatRecordControl_target', { value: 12, unit: 'fights' });

        await setRecordTarget({ value: 200, unit: 'fights' });
        await loadRecordTarget();

        expect(recordTarget()).toEqual({ value: 200, unit: 'fights' });
    });

    test('nor by one that was already in the air when it was set', async () => {
        // The load is fired off from the panel's redraw and lands whenever
        // storage gets round to it, which is easily after somebody has typed a
        // target into the box. Putting the old value back a moment later reads
        // as the box refusing what was typed into it.
        store.data.set('combatRecordControl_target', { value: 12, unit: 'fights' });

        const inFlight = loadRecordTarget();
        await setRecordTarget({ value: 200, unit: 'fights' });
        await inFlight;

        expect(recordTarget()).toEqual({ value: 200, unit: 'fights' });
    });

    test('and a load for the character just left does not land on the new one', async () => {
        store.data.set('combatRecordControl_target', { value: 12, unit: 'fights' });

        const inFlight = loadRecordTarget();
        resetRecordTargetCache();
        await setRecordTarget({ value: 500, unit: 'fights' });
        await inFlight;

        expect(recordTarget()).toEqual({ value: 500, unit: 'fights' });
    });

    test('a switch of character forgets whose target it was', async () => {
        store.data.set('combatRecordControl_target', { value: 12, unit: 'fights' });
        await loadRecordTarget();

        resetRecordTargetCache();
        store.data.set('combatRecordControl_target', { value: 500, unit: 'fights' });
        await loadRecordTarget();

        expect(recordTarget()).toEqual({ value: 500, unit: 'fights' });
    });

    test('a failed write still sets the target, since the recording is what matters', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        store.fail = true;

        await setRecordTarget({ value: 100, unit: 'fights' });

        expect(shared.target).toEqual({ value: 100, unit: 'fights' });
        error.mockRestore();
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
