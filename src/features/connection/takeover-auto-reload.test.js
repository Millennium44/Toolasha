/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    setting: '15',
    connected: true,
    settingCallbacks: [],
    conn: {},
    socket: {},
    dm: {},
    selfClosed: new Set(),
    characterId: 'char-a',
}));

function addTo(map, event, cb) {
    (map[event] ||= []).push(cb);
}
function removeFrom(map, event, cb) {
    const list = map[event] || [];
    const i = list.indexOf(cb);
    if (i > -1) list.splice(i, 1);
}
function fire(map, event, data) {
    for (const cb of [...(map[event] || [])]) cb(data);
}

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key === 'takeoverAutoReload' ? state.setting : fallback),
        onSettingChange: (key, cb) => {
            state.settingCallbacks.push(cb);
            return () => {
                const i = state.settingCallbacks.indexOf(cb);
                if (i > -1) state.settingCallbacks.splice(i, 1);
            };
        },
    },
}));

vi.mock('../../core/connection-state.js', () => ({
    default: {
        on: (e, cb) => addTo(state.conn, e, cb),
        off: (e, cb) => removeFrom(state.conn, e, cb),
        isConnected: () => state.connected,
    },
}));

vi.mock('../../core/websocket.js', () => ({
    default: {
        onSocketEvent: (e, cb) => addTo(state.socket, e, cb),
        offSocketEvent: (e, cb) => removeFrom(state.socket, e, cb),
        wasClosedByToolasha: (socket) => !!socket && state.selfClosed.has(socket),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (e, cb) => addTo(state.dm, e, cb),
        off: (e, cb) => removeFrom(state.dm, e, cb),
        getCurrentCharacterId: () => state.characterId,
    },
}));

import takeover, { RECORD_KEY, STABLE_RESET_MS, MAX_AUTO_RELOADS } from './takeover-auto-reload.js';
import { activeToastCount, dismissAllToasts, showToast } from '../../utils/toast.js';

const MIN = 60 * 1000;
const takeoverClose = { code: 1005, wasClean: true, reason: '' };

let reloadSpy;

function listenerCount() {
    const count = (map) => Object.values(map).reduce((n, l) => n + l.length, 0);
    return count(state.conn) + count(state.socket) + count(state.dm) + state.settingCallbacks.length;
}

function showOverlay() {
    const el = document.createElement('div');
    el.className = 'GamePage_connectionMessage__abc12';
    el.textContent = 'Disconnected.';
    document.body.appendChild(el);
    return el;
}

function disconnect(event = takeoverClose, reason = 'socket_close', socket = undefined) {
    state.connected = false;
    fire(state.conn, 'disconnected', { reason, event, socket });
}

function toastText() {
    return document.getElementById('toolasha-toasts')?.textContent ?? '';
}

function readRecord() {
    return JSON.parse(window.sessionStorage.getItem(RECORD_KEY));
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-18T12:00:00Z'));
    state.setting = '15';
    state.connected = true;
    state.settingCallbacks = [];
    state.conn = {};
    state.socket = {};
    state.dm = {};
    state.selfClosed = new Set();
    state.characterId = 'char-a';
    window.sessionStorage.clear();
    document.body.innerHTML = '';
    reloadSpy = vi.spyOn(takeover, '_performReload').mockImplementation(() => {});
});

afterEach(() => {
    takeover.disable();
    dismissAllToasts();
    reloadSpy.mockRestore();
    vi.useRealTimers();
});

describe('takeover auto-reload', () => {
    test('setting Off: a takeover close does nothing', () => {
        state.setting = 'off';
        takeover.initialize();
        showOverlay();
        disconnect();
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(120 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('1005 clean close: notice with the target time, reload at the chosen delay', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        expect(activeToastCount()).toBe(1);
        expect(toastText()).toContain('opened from another device or window');
        expect(toastText()).toContain('Reload now');
        expect(toastText()).toContain('Cancel');

        vi.advanceTimersByTime(15 * MIN - 1);
        expect(reloadSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect(readRecord().count).toBe(1);
        expect(activeToastCount()).toBe(0);
    });

    test.each([
        ['network drop 1006, not clean', { code: 1006, wasClean: false }, 'socket_close'],
        ['1005 but not clean', { code: 1005, wasClean: false }, 'socket_close'],
        ['clean 1000', { code: 1000, wasClean: true }, 'socket_close'],
        ['socket error', { code: 1005, wasClean: true }, 'socket_error'],
    ])('%s: nothing', (_label, event, reason) => {
        takeover.initialize();
        showOverlay();
        disconnect(event, reason);
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(120 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test("Toolasha's own recovery close (clean 1005) is not a takeover", () => {
        const socket = {};
        state.selfClosed.add(socket);
        takeover.initialize();
        showOverlay();
        disconnect(takeoverClose, 'socket_close', socket);
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(120 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('a self-closed socket is also recognized through the event target', () => {
        const socket = {};
        state.selfClosed.add(socket);
        takeover.initialize();
        showOverlay();
        disconnect({ ...takeoverClose, target: socket });
        expect(activeToastCount()).toBe(0);
    });

    test('a 1005 from a socket Toolasha did not close still arms', () => {
        state.selfClosed.add({});
        takeover.initialize();
        showOverlay();
        disconnect(takeoverClose, 'socket_close', {});
        expect(activeToastCount()).toBe(1);
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('countdown pushed out of the toast stack: no silent reload, an offer instead', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        for (let i = 0; i < 4; i++) showToast(`other ${i}`, { duration: 0 });
        expect(document.querySelector('.toolasha-takeover-cancel')).toBeNull();

        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(toastText()).toContain('notice was no longer showing');
        vi.advanceTimersByTime(240 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('reconnect cancels the wait and the notice', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        state.connected = true;
        fire(state.conn, 'reconnected', {});
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('a new socket opening cancels', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        fire(state.socket, 'open', {});
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('character switch cancels', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        fire(state.dm, 'character_switching', {});
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('Cancel button cancels without reloading', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        document.querySelector('.toolasha-takeover-cancel').click();
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('the toast ✕ cancels too', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        document.querySelector('.toolasha-toast-dismiss').click();
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('Reload now reloads at once, without counting toward the cap', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        document.querySelector('.toolasha-toast-action').click();
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect(window.sessionStorage.getItem(RECORD_KEY)).toBeNull();
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test.each(['pointerdown', 'keydown', 'touchstart', 'wheel'])(
        'user %s during the wait: no reload, an offer instead',
        (type) => {
            takeover.initialize();
            showOverlay();
            disconnect();
            vi.advanceTimersByTime(5 * MIN);
            window.dispatchEvent(new Event(type));
            vi.advanceTimersByTime(10 * MIN);
            expect(reloadSpy).not.toHaveBeenCalled();
            expect(activeToastCount()).toBe(1);
            expect(toastText()).toContain('because you were using the page');
            expect(document.querySelector('.toolasha-takeover-cancel')).toBeNull();
            vi.advanceTimersByTime(60 * MIN);
            expect(reloadSpy).not.toHaveBeenCalled();
        }
    );

    test('interaction before the disconnect does not count', () => {
        takeover.initialize();
        showOverlay();
        window.dispatchEvent(new Event('pointerdown'));
        disconnect();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('overlay gone at fire time: no reload, notice removed', () => {
        takeover.initialize();
        const overlay = showOverlay();
        disconnect();
        overlay.remove();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(activeToastCount()).toBe(0);
    });

    test('connected again at fire time without an event: no reload', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        state.connected = true;
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('back-off doubles per consecutive reload, and the cap stops with a notice', () => {
        // Reload 1 after 15 min
        takeover.initialize();
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);

        // The "reloaded" page: a fresh init, connected, then taken again quickly
        takeover.disable();
        state.connected = true;
        takeover.initialize();
        vi.advanceTimersByTime(1 * MIN);
        disconnect();
        vi.advanceTimersByTime(30 * MIN - 1);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1);
        expect(reloadSpy).toHaveBeenCalledTimes(2);

        takeover.disable();
        state.connected = true;
        takeover.initialize();
        disconnect();
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(3);
        expect(readRecord().count).toBe(MAX_AUTO_RELOADS);

        takeover.disable();
        state.connected = true;
        takeover.initialize();
        disconnect();
        expect(toastText()).toContain('has stopped reloading by itself');
        vi.advanceTimersByTime(240 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(3);
    });

    test('the count resets only after the connection stays up for the stable window', () => {
        // Count 2 at 15 min: the window is twice the next wait (60 min), 120 min
        window.sessionStorage.setItem(RECORD_KEY, JSON.stringify({ count: 2, lastAt: Date.now() }));
        state.connected = true;
        takeover.initialize();
        vi.advanceTimersByTime(120 * MIN - 1);
        expect(readRecord().count).toBe(2);
        vi.advanceTimersByTime(1);
        expect(window.sessionStorage.getItem(RECORD_KEY)).toBeNull();

        // Back at the base delay
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('the stable window scales with the configured delay', () => {
        // 5 min, count 1: twice the next wait (10 min) is 20 min, past the 10-min floor
        state.setting = '5';
        window.sessionStorage.setItem(RECORD_KEY, JSON.stringify({ count: 1, lastAt: Date.now() }));
        takeover.initialize();
        vi.advanceTimersByTime(Math.max(STABLE_RESET_MS, 20 * MIN) - 1);
        expect(readRecord().count).toBe(1);
        vi.advanceTimersByTime(1);
        expect(window.sessionStorage.getItem(RECORD_KEY)).toBeNull();
    });

    test('two tabs on the same setting, each waiting its full delay, still reach the cap', () => {
        // This tab's view of a peer running the same feature: after each of our
        // reloads the peer (one reload behind) waits 15 x 2^(ours - 1) and takes
        // the character back
        takeover.initialize();
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);

        for (let ours = 1; ours <= MAX_AUTO_RELOADS; ours++) {
            takeover.disable();
            dismissAllToasts();
            state.connected = true;
            takeover.initialize();
            vi.advanceTimersByTime(15 * MIN * 2 ** (ours - 1));
            expect(readRecord().count).toBe(ours);
            disconnect();
            vi.advanceTimersByTime(15 * MIN * 2 ** ours);
        }

        expect(reloadSpy).toHaveBeenCalledTimes(MAX_AUTO_RELOADS);
        expect(toastText()).toContain('has stopped reloading by itself');
    });

    test('a disconnect inside the stable window keeps the count', () => {
        window.sessionStorage.setItem(RECORD_KEY, JSON.stringify({ count: 1, lastAt: Date.now() }));
        takeover.initialize();
        vi.advanceTimersByTime(STABLE_RESET_MS - MIN);
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(2 * MIN);
        expect(readRecord().count).toBe(1);
        vi.advanceTimersByTime(30 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect(readRecord().count).toBe(2);
    });

    test("another character's reloads in this tab do not count for this one", () => {
        // Character A was auto-reloaded up to the cap in this tab
        takeover.initialize();
        showOverlay();
        for (let i = 0; i < MAX_AUTO_RELOADS; i++) {
            disconnect();
            vi.advanceTimersByTime(15 * MIN * 2 ** i);
            takeover.disable();
            state.connected = true;
            takeover.initialize();
        }
        expect(reloadSpy).toHaveBeenCalledTimes(MAX_AUTO_RELOADS);
        expect(readRecord()).toMatchObject({ count: MAX_AUTO_RELOADS, characterId: 'char-a' });

        // Switch to B: its takeover uses the base delay and is not capped
        takeover.disable();
        state.characterId = 'char-b';
        state.connected = true;
        takeover.initialize();
        disconnect();
        expect(toastText()).not.toContain('has stopped reloading by itself');
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(MAX_AUTO_RELOADS + 1);
        expect(readRecord()).toMatchObject({ count: 1, characterId: 'char-b' });
    });

    test('a record still counts for the same character inside its window', () => {
        window.sessionStorage.setItem(
            RECORD_KEY,
            JSON.stringify({ count: 1, lastAt: Date.now(), characterId: 'char-a' })
        );
        takeover.initialize();
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(30 * MIN - 1);
        expect(reloadSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('a record left while the feature was off expires from its last reload', () => {
        // Count 2 at 15 min: window is 2 x 60 = 120 min from the last reload
        takeover.initialize();
        window.sessionStorage.setItem(
            RECORD_KEY,
            JSON.stringify({ count: 2, lastAt: Date.now(), characterId: 'char-a' })
        );
        takeover.disable();
        vi.advanceTimersByTime(3 * 24 * 60 * MIN);

        state.connected = true;
        takeover.initialize();
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect(readRecord().count).toBe(1);
    });

    test('a record just inside its window after a disable still counts', () => {
        window.sessionStorage.setItem(
            RECORD_KEY,
            JSON.stringify({ count: 2, lastAt: Date.now(), characterId: 'char-a' })
        );
        vi.advanceTimersByTime(120 * MIN - 2 * MIN);
        state.connected = true;
        takeover.initialize();
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('raising the delay while connected re-times the stable window', () => {
        // Count 1 at 5 min: window is 20 min. At 60 min it is 240 min.
        state.setting = '5';
        window.sessionStorage.setItem(
            RECORD_KEY,
            JSON.stringify({ count: 1, lastAt: Date.now(), characterId: 'char-a' })
        );
        takeover.initialize();
        vi.advanceTimersByTime(MIN);
        state.setting = '60';
        for (const cb of [...state.settingCallbacks]) cb('60');

        vi.advanceTimersByTime(30 * MIN);
        expect(readRecord()?.count).toBe(1);
        vi.advanceTimersByTime(240 * MIN - 31 * MIN - 1);
        expect(readRecord()?.count).toBe(1);
        vi.advanceTimersByTime(1);
        expect(window.sessionStorage.getItem(RECORD_KEY)).toBeNull();
    });

    test('lowering the delay while connected clears on the new, shorter window', () => {
        // Count 1 at 60 min (240-min window) lowered to 5 min (20-min window)
        state.setting = '60';
        window.sessionStorage.setItem(
            RECORD_KEY,
            JSON.stringify({ count: 1, lastAt: Date.now(), characterId: 'char-a' })
        );
        takeover.initialize();
        vi.advanceTimersByTime(MIN);
        state.setting = '5';
        for (const cb of [...state.settingCallbacks]) cb('5');
        vi.advanceTimersByTime(19 * MIN - 1);
        expect(readRecord()?.count).toBe(1);
        vi.advanceTimersByTime(1);
        expect(window.sessionStorage.getItem(RECORD_KEY)).toBeNull();
    });

    describe('storage failure', () => {
        let original;
        beforeEach(() => {
            original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
        });
        afterEach(() => {
            if (original) Object.defineProperty(window, 'sessionStorage', original);
        });

        test('read failure: no reload, an offer instead', () => {
            Object.defineProperty(window, 'sessionStorage', {
                configurable: true,
                get() {
                    throw new Error('blocked');
                },
            });
            takeover.initialize();
            showOverlay();
            disconnect();
            expect(toastText()).toContain('cannot keep count');
            vi.advanceTimersByTime(240 * MIN);
            expect(reloadSpy).not.toHaveBeenCalled();
        });

        test('write failure at fire time: no reload, an offer instead', () => {
            takeover.initialize();
            showOverlay();
            disconnect();
            const real = window.sessionStorage;
            Object.defineProperty(window, 'sessionStorage', {
                configurable: true,
                get: () => ({
                    getItem: (k) => real.getItem(k),
                    setItem: () => {
                        throw new Error('quota');
                    },
                    removeItem: (k) => real.removeItem(k),
                }),
            });
            vi.advanceTimersByTime(15 * MIN);
            expect(reloadSpy).not.toHaveBeenCalled();
            expect(toastText()).toContain('could not safely reload');
        });

        test('a corrupt record counts as spent', () => {
            window.sessionStorage.setItem(RECORD_KEY, '{"count":"x"}');
            takeover.initialize();
            showOverlay();
            disconnect();
            vi.advanceTimersByTime(240 * MIN);
            expect(reloadSpy).not.toHaveBeenCalled();
        });
    });

    test('setting turned Off mid-wait cancels', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        state.setting = 'off';
        for (const cb of [...state.settingCallbacks]) cb('off');
        expect(activeToastCount()).toBe(0);
        vi.advanceTimersByTime(60 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('setting Off at fire time without a change event: no reload', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        state.setting = 'off';
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(activeToastCount()).toBe(0);
    });

    test('a different delay mid-wait re-times from the disconnect', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(2 * MIN);
        state.setting = '5';
        for (const cb of [...state.settingCallbacks]) cb('5');
        vi.advanceTimersByTime(3 * MIN - 1);
        expect(reloadSpy).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('disable clears timers, listeners and the notice', () => {
        takeover.initialize();
        showOverlay();
        disconnect();
        window.dispatchEvent(new Event('keydown'));
        expect(listenerCount()).toBeGreaterThan(0);

        takeover.disable();
        expect(listenerCount()).toBe(0);
        expect(activeToastCount()).toBe(0);
        expect(vi.getTimerCount()).toBe(0);
        expect(takeover.interactionHandler).toBeNull();
        vi.advanceTimersByTime(240 * MIN);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('initialize twice registers once; re-init after disable works', () => {
        takeover.initialize();
        takeover.initialize();
        const once = listenerCount();
        takeover.disable();
        takeover.initialize();
        expect(listenerCount()).toBe(once);
        showOverlay();
        disconnect();
        vi.advanceTimersByTime(15 * MIN);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
});
