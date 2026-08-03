/**
 * The combat recorder, checked for the two things that would make a recording
 * useless: keeping the wrong fields, and never stopping.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const bus = vi.hoisted(() => ({ handlers: {} }));
const settings = vi.hoisted(() => ({ autoStart: false, seconds: 60 }));

vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key) => (key === 'combatRecorder_autoStart' ? settings.autoStart : false),
        getSettingValue: (key, fallback) => (key === 'combatRecorder_autoStartSeconds' ? settings.seconds : fallback),
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

    test('it stops itself rather than growing until the tab falls over', () => {
        recorder.startRecording();
        for (let i = 0; i < 4200; i += 1) send('battle_updated', { pMap: {}, mMap: {} });

        expect(recorder.isRecording()).toBe(false);
        expect(recorder.recordingStatus().full).toBe(true);
        expect(recorder.recordingStatus().ticks).toBeLessThanOrEqual(4000);
    });

    test('stopping keeps what was captured', () => {
        recorder.startRecording();
        send('battle_updated', { pMap: {}, mMap: {} });
        recorder.stopRecording();

        expect(recorder.isRecording()).toBe(false);
        expect(recorder.recordingStatus().ticks).toBe(1);
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
