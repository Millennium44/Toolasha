/**
 * @vitest-environment happy-dom
 *
 * The combat recorder, checked for the two things that would make a recording
 * useless: keeping the wrong fields, and never stopping.
 *
 * A DOM because writing the file out is part of what it does, and the automatic
 * recording only disarms itself once a file has actually been written — which is
 * not something that can be observed without somewhere to write to.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const bus = vi.hoisted(() => ({ handlers: {} }));
const settings = vi.hoisted(() => ({ autoStart: false, seconds: 60 }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'combatRecorder_autoStart' ? settings.autoStart : false),
        getSettingValue: (key, fallback) => (key === 'combatRecorder_autoStartSeconds' ? settings.seconds : fallback),
        setSetting: (key, value) => {
            if (key === 'combatRecorder_autoStart') settings.autoStart = value;
        },
    },
}));
vi.mock('../../utils/battle-panel-monsters.js', () => ({
    describeMonsterPanel: () => ({ area: true, grid: true, tiles: [['Eyes', '2215/2215']] }),
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        on: (event, fn) => {
            bus.handlers[event] = fn;
        },
        off: (event) => {
            delete bus.handlers[event];
        },
    },
}));

const recorder = await import('./combat-recorder.js');

const send = (event, payload) => bus.handlers[event]?.(payload);

beforeEach(() => {
    bus.handlers = {};
    settings.autoStart = false;
    settings.seconds = 60;
    recorder.stopRecording();
    // The target outlives a recording on purpose — it is a preference, not a
    // property of one sitting — so a test that set one would leak into the next
    recorder.setRecordTarget(null);
});

afterEach(() => recorder.stopRecording());

describe('recording the combat feed', () => {
    test('it keeps what attribution reads and nothing else', () => {
        // A recording is meant to be handed to somebody. Anything beyond pMap
        // and mMap is neither needed nor theirs to pass on.
        recorder.startRecording();
        send('battle_updated', { pMap: { 0: { cMP: 9 } }, mMap: { 0: { cHP: 5 } }, chat: 'private', battleId: 3 });

        const [tick] = recorder.recordingFile().ticks;
        expect(tick.payload).toEqual({ pMap: { 0: { cMP: 9 } }, mMap: { 0: { cHP: 5 } } });
        expect(JSON.stringify(tick)).not.toContain('private');
    });

    test('a new battle is kept whole, since it carries the names and health bars', () => {
        recorder.startRecording();
        send('new_battle', { players: { 0: { name: 'Tester' } }, monsters: { 0: { combatMonsterHrid: '/m/rat' } } });

        expect(recorder.recordingFile().ticks[0].payload.monsters[0].combatMonsterHrid).toBe('/m/rat');
    });

    test('starting again drops the last one', () => {
        // Two sittings appended together replay as a fight that never happened
        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });
        recorder.startRecording();

        expect(recorder.recordingStatus().ticks).toBe(0);
    });

    test('stopping keeps what was captured', () => {
        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });
        recorder.stopRecording();

        expect(recorder.isRecording()).toBe(false);
        expect(recorder.recordingStatus().ticks).toBe(1);
    });
});

describe('recording for longer than the buffer holds', () => {
    /** A fight: one `new_battle` and `ticks` updates after it */
    const fight = (ticks = 1) => {
        send('new_battle', { players: { 0: {} }, monsters: { 0: { name: 'Fly' } } });
        for (let i = 0; i < ticks; i += 1) send('battle_updated', { pMap: {}, mMap: {} });
    };

    test('a full buffer banks the segment instead of ending the recording', () => {
        // The old answer to "how long can I record?" was about ten minutes and
        // then silence. Memory is still capped at one segment; the run is not.
        const banked = [];
        const detach = recorder.onRecordingComplete((file) => banked.push(file));

        recorder.startRecording();
        for (let i = 0; i < 60; i += 1) fight(100);

        expect(recorder.isRecording()).toBe(true);
        expect(banked.length).toBeGreaterThan(0);
        expect(recorder.recordingStatus().ticks).toBeLessThan(4000);
        detach();
    });

    test('and the fights keep counting up across the rotation', () => {
        // The tick count resets with the buffer, so a label reading ticks would
        // count to four thousand, drop to zero and start again on a recording
        // that never stopped
        recorder.startRecording();
        for (let i = 0; i < 60; i += 1) fight(100);

        const status = recorder.recordingStatus();
        expect(status.segments).toBeGreaterThan(1);
        expect(status.fights).toBe(59);
    });

    test('the rotation waits for a fight to end, so no fight is split in half', () => {
        // A cut mid-fight loses that fight from both sides: the old segment's
        // last battle never closes, and the new segment opens inside a battle it
        // never saw begin
        const banked = [];
        const detach = recorder.onRecordingComplete((file) => banked.push(file));

        recorder.startRecording();
        for (let i = 0; i < 60; i += 1) fight(100);
        detach();

        for (const file of banked) {
            expect(file.ticks[file.ticks.length - 1].type).toBe('new_battle');
            expect(file.truncated).toBe(false);
        }
    });

    test('the battle that ends one segment opens the next, so the fight survives', () => {
        const banked = [];
        const detach = recorder.onRecordingComplete((file) => banked.push(file));

        recorder.startRecording();
        for (let i = 0; i < 60; i += 1) fight(100);
        detach();

        // The old segment can close its last fight and the new one can open its
        // first only if both carry the boundary battle
        expect(banked[0].ticks[banked[0].ticks.length - 1].type).toBe('new_battle');
        expect(recorder.recordingFile().ticks[0].type).toBe('new_battle');
    });

    test('a fight that never ends is cut anyway, and the file says so', () => {
        // The fight-boundary rotation depends on a fight ending. One that does
        // not would grow the buffer forever, which is what the bound is for.
        const banked = [];
        const detach = recorder.onRecordingComplete((file) => banked.push(file));

        recorder.startRecording();
        send('new_battle', { players: { 0: {} }, monsters: {} });
        for (let i = 0; i < 8200; i += 1) send('battle_updated', { pMap: {}, mMap: {} });

        expect(banked).toHaveLength(1);
        expect(banked[0].truncated).toBe(true);
        expect(recorder.isRecording()).toBe(true);
        detach();
    });
});

describe('recording a set amount', () => {
    /** A fight: one `new_battle` and `ticks` updates after it */
    const fight = (ticks = 1) => {
        send('new_battle', { players: { 0: {} }, monsters: { 0: { name: 'Fly' } } });
        for (let i = 0; i < ticks; i += 1) send('battle_updated', { pMap: {}, mMap: {} });
    };

    test('with no target it records until it is stopped, as it always has', () => {
        recorder.startRecording();
        for (let i = 0; i < 20; i += 1) fight(2);

        expect(recorder.isRecording()).toBe(true);
        expect(recorder.recordingStatus().target).toBe(null);
        expect(recorder.recordingStatus().targetMet).toBe(false);
    });

    test('a fight target stops it on the fight that reaches the number', () => {
        recorder.setRecordTarget({ value: 3, unit: 'fights' });
        recorder.startRecording();

        // Four battles close three fights — the first one closes nothing,
        // since whatever was being fought when the recording began has no
        // beginning here
        for (let i = 0; i < 4; i += 1) fight(2);

        expect(recorder.isRecording()).toBe(false);
        expect(recorder.recordingStatus().fights).toBe(3);
        expect(recorder.recordingStatus().targetMet).toBe(true);
    });

    test('and stops on a boundary, so the last fight is whole rather than cut', () => {
        recorder.setRecordTarget({ value: 2, unit: 'fights' });
        const banked = [];
        const detach = recorder.onRecordingComplete((file) => banked.push(file));

        recorder.startRecording();
        for (let i = 0; i < 3; i += 1) fight(5);

        // The handed-over file ends on the battle that closed the last fight,
        // which is what lets the replay measure that fight's length at all
        expect(banked).toHaveLength(1);
        expect(banked[0].ticks[banked[0].ticks.length - 1].type).toBe('new_battle');
        expect(banked[0].truncated).toBe(false);
        detach();
    });

    test('one fight past the target does not start, so nothing is recorded that was not asked for', () => {
        recorder.setRecordTarget({ value: 2, unit: 'fights' });
        recorder.startRecording();
        for (let i = 0; i < 3; i += 1) fight(5);

        const ticksAtStop = recorder.recordingStatus().ticks;
        fight(5);

        expect(recorder.recordingStatus().ticks).toBe(ticksAtStop);
    });

    test('a minutes target overshoots by the fight it was in rather than cutting it', () => {
        // Cutting on the stroke of the clock loses that fight from both ends —
        // the replay drops a battle it never saw close — so the last minute of
        // recording would have bought nothing
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        recorder.setRecordTarget({ value: 10, unit: 'minutes' });
        recorder.startRecording();

        fight(2);
        vi.advanceTimersByTime(11 * 60_000);

        // Eleven minutes in and still going, because no fight has ended yet
        expect(recorder.isRecording()).toBe(true);
        send('battle_updated', { pMap: {}, mMap: {} });
        expect(recorder.isRecording()).toBe(true);

        // The battle that ends the overrunning fight is what stops it
        send('new_battle', { players: { 0: {} }, monsters: {} });

        expect(recorder.isRecording()).toBe(false);
        expect(recorder.recordingStatus().fights).toBe(1);
        expect(recorder.recordingStatus().targetMet).toBe(true);
        vi.useRealTimers();
    });

    test('a minutes target that has not expired keeps recording through fight boundaries', () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
        recorder.setRecordTarget({ value: 30, unit: 'minutes' });
        recorder.startRecording();

        for (let i = 0; i < 6; i += 1) {
            vi.advanceTimersByTime(60_000);
            fight(2);
        }

        expect(recorder.isRecording()).toBe(true);
        vi.useRealTimers();
    });

    test('the finished recording is handed over exactly as a stopped one is', () => {
        recorder.setRecordTarget({ value: 1, unit: 'fights' });
        const banked = [];
        const stops = [];
        const detachComplete = recorder.onRecordingComplete((file) => banked.push(file));
        const detachStop = recorder.onRecordingStopped(() => stops.push(1));

        recorder.startRecording();
        fight(2);
        fight(2);

        expect(banked).toHaveLength(1);
        expect(stops).toHaveLength(1);
        detachComplete();
        detachStop();
    });

    test('starting again clears the last run’s Done, since this one has not finished', () => {
        recorder.setRecordTarget({ value: 1, unit: 'fights' });
        recorder.startRecording();
        fight(2);
        fight(2);
        expect(recorder.recordingStatus().targetMet).toBe(true);

        recorder.startRecording();

        expect(recorder.recordingStatus().targetMet).toBe(false);
    });

    test('stopping by hand before the target is not a target reached', () => {
        recorder.setRecordTarget({ value: 50, unit: 'fights' });
        recorder.startRecording();
        fight(2);
        fight(2);
        recorder.stopRecording();

        expect(recorder.recordingStatus().targetMet).toBe(false);
    });

    test('the target survives a recording, since it is a preference and not a sitting', () => {
        recorder.setRecordTarget({ value: 5, unit: 'fights' });
        recorder.startRecording();
        recorder.stopRecording();

        expect(recorder.recordTarget()).toEqual({ value: 5, unit: 'fights' });
    });

    test('and a caller can override it for one recording', () => {
        recorder.setRecordTarget({ value: 5, unit: 'fights' });
        recorder.startRecording({ target: { value: 9, unit: 'minutes' } });

        expect(recorder.recordTarget()).toEqual({ value: 9, unit: 'minutes' });
    });

    test('nonsense is unlimited rather than an error', () => {
        // An empty box is how the control says "no target", and a recording
        // that refused to start over a malformed one would be worse than one
        // that simply runs until stopped
        for (const bad of [null, undefined, {}, { value: 0, unit: 'fights' }, { value: -3, unit: 'fights' }]) {
            expect(recorder.setRecordTarget(bad)).toBe(null);
        }
        expect(recorder.setRecordTarget({ value: 10, unit: 'hours' })).toBe(null);
        expect(recorder.setRecordTarget({ value: '25', unit: 'minutes' })).toEqual({ value: 25, unit: 'minutes' });
    });

    test('raising the target mid-recording lets it carry on', () => {
        recorder.setRecordTarget({ value: 2, unit: 'fights' });
        recorder.startRecording();
        fight(2);
        fight(2);

        recorder.setRecordTarget({ value: 4, unit: 'fights' });
        fight(2);

        expect(recorder.isRecording()).toBe(true);
        expect(recorder.recordingStatus().fights).toBe(2);
    });
});

describe('recording the first seconds of a session', () => {
    test('it does not start itself unless asked to', () => {
        recorder.default.initialize();
        expect(recorder.isRecording()).toBe(false);
    });

    test('asked to, it is already running before anything is clicked', () => {
        // The Record button cannot capture the seconds after a reload, which is
        // exactly when the client never sees what it is fighting
        settings.autoStart = true;
        recorder.default.initialize();

        expect(recorder.isRecording()).toBe(true);
    });

    test('and it stops and saves itself', () => {
        vi.useFakeTimers();
        settings.autoStart = true;
        settings.seconds = 30;
        recorder.default.initialize();
        send('battle_updated', { pMap: {}, mMap: {} });

        vi.advanceTimersByTime(30_000);
        expect(recorder.isRecording()).toBe(false);
        expect(recorder.recordingFile().ticks.length).toBe(1);
        vi.useRealTimers();
    });

    test('and then puts the switch back, so the next load is an ordinary one', () => {
        // A switch that downloads a file on every load until somebody remembers
        // it is a switch left on by accident, and collecting one recording is
        // finished the moment the file exists
        vi.useFakeTimers();
        settings.autoStart = true;
        settings.seconds = 30;
        recorder.default.initialize();
        send('battle_updated', { pMap: {}, mMap: {} });

        vi.advanceTimersByTime(30_000);
        expect(settings.autoStart).toBe(false);
        vi.useRealTimers();
    });

    test('but stays armed when there was nothing to save', () => {
        // Loading outside combat is not the recording anybody was after
        vi.useFakeTimers();
        settings.autoStart = true;
        settings.seconds = 30;
        recorder.default.initialize();

        vi.advanceTimersByTime(30_000);
        expect(settings.autoStart).toBe(true);
        vi.useRealTimers();
    });

    test('it snapshots the battle panel until the wave is announced', () => {
        // The other half of the same question: whether the names can be read off
        // the screen during the window where the payload does not carry them
        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });

        expect(recorder.recordingFile().ticks[0].panel).toEqual({
            area: true,
            grid: true,
            tiles: [['Eyes', '2215/2215']],
        });
    });

    test('and stops once the payload names the wave itself', () => {
        recorder.startRecording();
        send('new_battle', { monsters: [{ name: 'Eyes' }] });
        send('battle_updated', { pMap: {}, mMap: {} });

        const ticks = recorder.recordingFile().ticks;
        expect(ticks[ticks.length - 1].panel).toBeUndefined();
    });
});

describe('handing the finished recording on', () => {
    test('a listener is given the file the moment the recording ends', () => {
        // The only moment anything knows a recording is complete. Polling
        // `isRecording` would mean every reader owning a timer for an event that
        // happens a handful of times a session.
        const seen = [];
        const detach = recorder.onRecordingComplete((file) => seen.push(file));

        recorder.startRecording();
        send('battle_updated', { pMap: { 0: { cHP: 9 } }, mMap: {} });
        recorder.stopRecording();

        expect(seen).toHaveLength(1);
        expect(seen[0].ticks).toHaveLength(1);
        detach();
    });

    test('a recording that caught nothing has not finished anything', () => {
        const seen = [];
        const detach = recorder.onRecordingComplete((file) => seen.push(file));

        recorder.startRecording();
        recorder.stopRecording();

        expect(seen).toHaveLength(0);
        detach();
    });

    test('stopping twice does not hand the same run over twice', () => {
        // A reader that folded the run into a running tally would count every
        // fight in it once per redundant stop
        const seen = [];
        const detach = recorder.onRecordingComplete((file) => seen.push(file));

        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });
        recorder.stopRecording();
        recorder.stopRecording();

        expect(seen).toHaveLength(1);
        detach();
    });

    test('starting a new recording ends the one before it', () => {
        const seen = [];
        const detach = recorder.onRecordingComplete((file) => seen.push(file));

        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });
        recorder.startRecording();

        expect(seen).toHaveLength(1);
        detach();
    });

    test('a listener that throws does not take the recorder down with it', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const seen = [];
        const detachBad = recorder.onRecordingComplete(() => {
            throw new Error('nope');
        });
        const detachGood = recorder.onRecordingComplete((file) => seen.push(file));

        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });
        recorder.stopRecording();

        expect(seen).toHaveLength(1);
        detachBad();
        detachGood();
        error.mockRestore();
    });

    test('a detached listener hears nothing more', () => {
        const seen = [];
        const detach = recorder.onRecordingComplete((file) => seen.push(file));
        detach();

        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });
        recorder.stopRecording();

        expect(seen).toHaveLength(0);
    });
});

describe('what was worn while it was recorded', () => {
    afterEach(() => recorder.setLoadoutProvider(null));

    test('the loadout is snapshotted when the recording starts', () => {
        // Otherwise the check that reads this can only sim whoever is logged in
        // when it runs, and enhancing a weapon in between reads as a deviation
        recorder.setLoadoutProvider(() => ({ weapon: 'sword', level: 5 }));
        recorder.startRecording();

        expect(recorder.recordingFile().loadout).toEqual({ weapon: 'sword', level: 5 });
    });

    test('and again on every banked segment, since a session outlasts a loadout', () => {
        let worn = 'sword';
        recorder.setLoadoutProvider(() => ({ weapon: worn }));

        const banked = [];
        const detach = recorder.onRecordingComplete((file) => banked.push(file));

        recorder.startRecording();
        worn = 'spear';
        for (let i = 0; i < 60; i += 1) {
            send('new_battle', { players: { 0: {} }, monsters: {} });
            for (let tick = 0; tick < 100; tick += 1) send('battle_updated', { pMap: {}, mMap: {} });
        }

        expect(banked[0].loadout).toEqual({ weapon: 'sword' });
        expect(recorder.recordingFile().loadout).toEqual({ weapon: 'spear' });
        detach();
    });

    test('nothing able to take one is a recording without one, not a broken one', () => {
        recorder.startRecording();
        expect(recorder.recordingFile().loadout).toBe(null);
    });

    test('a provider that throws is a recording without one', () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        recorder.setLoadoutProvider(() => {
            throw new Error('no character yet');
        });

        recorder.startRecording();

        expect(recorder.recordingFile().loadout).toBe(null);
        expect(recorder.isRecording()).toBe(true);
        error.mockRestore();
    });
});

describe('surviving a refresh', () => {
    test('the recording so far is offered at every fight boundary', () => {
        // A recording lives in memory and a reload is the end of it, which is
        // wrong for one meant to be left running
        const checkpoints = [];
        const detach = recorder.onRecordingCheckpoint((file) => checkpoints.push(file.ticks.length));

        recorder.startRecording();
        send('new_battle', { players: {}, monsters: {} });
        send('battle_updated', { pMap: {}, mMap: {} });
        expect(checkpoints).toHaveLength(0);

        send('new_battle', { players: {}, monsters: {} });

        expect(checkpoints).toEqual([3]);
        detach();
    });

    test('never mid-fight, since there is nothing new to summarise there', () => {
        const checkpoints = [];
        const detach = recorder.onRecordingCheckpoint(() => checkpoints.push(1));

        recorder.startRecording();
        send('new_battle', { players: {}, monsters: {} });
        for (let i = 0; i < 50; i += 1) send('battle_updated', { pMap: {}, mMap: {} });

        expect(checkpoints).toHaveLength(0);
        detach();
    });

    test('a rotation offers the empty segment, so a stale checkpoint is dropped', () => {
        // The banked segment is already folded in; a checkpoint taken from it is
        // a duplicate waiting for the next reload
        const battles = [];
        const detach = recorder.onRecordingCheckpoint((file) =>
            battles.push(file.ticks.filter((tick) => tick.type === 'new_battle').length)
        );

        recorder.startRecording();
        for (let i = 0; i < 60; i += 1) {
            send('new_battle', { players: {}, monsters: {} });
            for (let tick = 0; tick < 100; tick += 1) send('battle_updated', { pMap: {}, mMap: {} });
        }

        // The rotation's own checkpoint holds one battle and so no completed
        // fight, which is what tells the reader to drop what it had
        expect(battles).toContain(1);
        detach();
    });

    test('stopping is announced even when the last segment caught nothing', () => {
        // A recording stopped just after a rotation has nothing to hand over and
        // still has a checkpoint in storage nothing else will ever clear
        const stops = [];
        const detach = recorder.onRecordingStopped(() => stops.push(1));

        recorder.startRecording();
        recorder.stopRecording();

        expect(stops).toHaveLength(1);
        detach();
    });

    test('an idle recorder stopped again announces nothing', () => {
        const stops = [];
        const detach = recorder.onRecordingStopped(() => stops.push(1));

        recorder.startRecording();
        recorder.stopRecording();
        recorder.stopRecording();

        expect(stops).toHaveLength(1);
        detach();
    });

    test('the session start is announced once the settings have loaded', () => {
        // Which is the first moment anything downstream can read its own switch,
        // and so the moment to look for last session's interrupted recording
        const starts = [];
        const detach = recorder.onSessionStart(() => starts.push(1));

        recorder.default.initialize();

        expect(starts).toHaveLength(1);
        detach();
    });
});
