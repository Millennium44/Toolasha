/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({ handlers: {}, active: null, selfClosed: new Set() }));

vi.mock('../../core/websocket.js', () => ({
    default: {
        get activeGameSocket() {
            return state.active;
        },
        onSocketEvent: (type, cb) => (state.handlers[type] ||= []).push(cb),
        offSocketEvent: (type, cb) => {
            const l = state.handlers[type] || [];
            const i = l.indexOf(cb);
            if (i > -1) l.splice(i, 1);
        },
        wasClosedByToolasha: (s) => state.selfClosed.has(s),
    },
}));

import guard, { BODY_CLASS, GRACE_MS, isDisconnectedTitle } from './disconnect-panel-guard.js';

const fire = (type, socket) => (state.handlers[type] || []).slice().forEach((cb) => cb({}, socket));
// Mirrors the hook: a close clears the active socket if it was the active one, then emits
const close = (socket) => {
    if (state.active === socket) state.active = null;
    fire('close', socket);
};
const open = (socket) => {
    state.active = socket;
    fire('open', socket);
};
const hidden = () => document.body.classList.contains(BODY_CLASS);

describe('disconnect panel guard', () => {
    let panel;
    beforeEach(() => {
        vi.useFakeTimers();
        state.handlers = {};
        state.active = null;
        state.selfClosed = new Set();
        document.title = 'Milky Way Idle';
        document.body.className = '';
        panel = document.createElement('div');
        panel.setAttribute('data-toolasha-surface', 'panel');
        panel.style.cssText = 'position:fixed; left:123px; top:45px; width:200px;';
        panel.dataset.open = '1';
        document.body.appendChild(panel);
    });
    afterEach(() => {
        guard.disable();
        panel.remove();
        vi.useRealTimers();
    });

    test('connected: nothing hidden', () => {
        guard.initialize();
        open('a');
        vi.advanceTimersByTime(GRACE_MS * 2);
        expect(hidden()).toBe(false);
    });

    test('disconnect mid-session hides after the grace period, without touching the panel', () => {
        guard.initialize();
        open('a');
        const before = panel.outerHTML;
        close('a');
        expect(hidden()).toBe(false);
        vi.advanceTimersByTime(GRACE_MS + 1);
        expect(hidden()).toBe(true);
        expect(panel.outerHTML).toBe(before);
        expect(document.getElementById('toolasha-disconnect-panel-guard').textContent).toContain('visibility: hidden');
        expect(panel.style.display).toBe('');
    });

    test('reconnect: a socket opening restores everything', () => {
        guard.initialize();
        open('a');
        close('a');
        vi.advanceTimersByTime(GRACE_MS + 1);
        expect(hidden()).toBe(true);
        open('b');
        expect(hidden()).toBe(false);
        expect(panel.dataset.open).toBe('1');
        expect(panel.style.left).toBe('123px');
    });

    test('page loaded straight into disconnected: the title alone hides at init', () => {
        document.title = 'Disconnected - Milky Way Idle';
        guard.initialize();
        expect(hidden()).toBe(true);
    });

    test('title changing to and from Disconnected toggles the class', async () => {
        guard.initialize();
        document.title = 'Disconnected - Milky Way Idle';
        await vi.advanceTimersByTimeAsync(10);
        expect(hidden()).toBe(true);
        document.title = 'Milky Way Idle';
        await vi.advanceTimersByTimeAsync(10);
        expect(hidden()).toBe(false);
    });

    test('a second socket closing while the main one is fine hides nothing', () => {
        guard.initialize();
        open('main');
        close('second');
        vi.advanceTimersByTime(GRACE_MS * 2);
        expect(hidden()).toBe(false);
    });

    test('character switch: departing socket closing after the new one attached hides nothing', () => {
        guard.initialize();
        open('old');
        state.active = 'new'; // constructed, not yet open
        close('old');
        open('new');
        vi.advanceTimersByTime(GRACE_MS * 2);
        expect(hidden()).toBe(false);
    });

    test('character switch: old closes first, new opens inside the grace period, no flash', () => {
        guard.initialize();
        open('old');
        close('old');
        vi.advanceTimersByTime(GRACE_MS - 100);
        open('new');
        vi.advanceTimersByTime(GRACE_MS * 2);
        expect(hidden()).toBe(false);
    });

    test('a close Toolasha made itself does not hide', () => {
        guard.initialize();
        open('a');
        state.selfClosed.add('a');
        close('a');
        vi.advanceTimersByTime(GRACE_MS * 2);
        expect(hidden()).toBe(false);
    });

    test('a panel opened while disconnected is hidden by the same rule and is not rewritten', () => {
        guard.initialize();
        open('a');
        close('a');
        vi.advanceTimersByTime(GRACE_MS + 1);
        const late = document.createElement('div');
        late.setAttribute('data-toolasha-surface', 'popover');
        document.body.appendChild(late);
        expect(hidden()).toBe(true);
        expect(late.getAttribute('style')).toBeNull();
    });

    test('disable removes the class and listeners', () => {
        guard.initialize();
        open('a');
        close('a');
        vi.advanceTimersByTime(GRACE_MS + 1);
        guard.disable();
        expect(hidden()).toBe(false);
        expect((state.handlers.open || []).length + (state.handlers.close || []).length).toBe(0);
    });

    test('title matcher', () => {
        expect(isDisconnectedTitle('Disconnected - Milky Way Idle')).toBe(true);
        expect(isDisconnectedTitle('Milky Way Idle')).toBe(false);
        expect(isDisconnectedTitle('')).toBe(false);
    });
});
