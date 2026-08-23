/**
 * The error log keeps what this script's own code reports and nothing else.
 *
 * The filter is the whole test: a log that also captured the game's errors
 * would be noise in the Diagnostics section, and one that missed a `[Module]`
 * line would be silence where there should be a count.
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { install, uninstall, getEntries, clear, subscribe, isInstalled, ERROR_LOG_CAP } from './error-log.js';

/** A stand-in console that remembers every call */
function fakeConsole() {
    const calls = [];
    return {
        calls,
        error(...args) {
            calls.push(args);
        },
    };
}

/** A stand-in window with an EventTarget's API */
function fakeTarget() {
    const target = new EventTarget();
    target.fire = (type, props) => {
        const event = new Event(type);
        Object.assign(event, props);
        target.dispatchEvent(event);
    };
    return target;
}

let con;
let target;

beforeEach(() => {
    clear();
    con = fakeConsole();
    target = fakeTarget();
    install({ console: con, target });
});

afterEach(() => {
    uninstall();
    clear();
});

describe('console.error capture', () => {
    test('keeps a [Module] line and still calls the real console', () => {
        con.error('[Networth] Recompute failed:', new Error('boom'));
        expect(con.calls).toHaveLength(1);
        const entries = getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'console', module: 'Networth', count: 1 });
        expect(entries[0].message).toContain('[Networth] Recompute failed:');
        expect(entries[0].message).toContain('Error: boom');
        expect(entries[0].stack).toContain('boom');
    });

    test('ignores errors without a module prefix', () => {
        con.error('Uncaught TypeError: the game did a thing');
        con.error(new Error('from somewhere else'));
        con.error({ not: 'ours' });
        expect(getEntries()).toEqual([]);
        expect(con.calls).toHaveLength(3);
    });

    test('collapses consecutive identical messages into a count', () => {
        con.error('[Tooltips] draw failed');
        con.error('[Tooltips] draw failed');
        con.error('[Tooltips] draw failed');
        con.error('[Tooltips] other failure');
        const entries = getEntries();
        expect(entries).toHaveLength(2);
        expect(entries[1]).toMatchObject({ message: '[Tooltips] draw failed', count: 3 });
        expect(entries[0]).toMatchObject({ message: '[Tooltips] other failure', count: 1 });
    });

    test('returns newest first and never grows past the cap', () => {
        for (let i = 0; i < ERROR_LOG_CAP + 25; i++) con.error(`[Cap] failure ${i}`);
        const entries = getEntries();
        expect(entries).toHaveLength(ERROR_LOG_CAP);
        expect(entries[0].message).toBe(`[Cap] failure ${ERROR_LOG_CAP + 24}`);
        expect(entries[entries.length - 1].message).toBe('[Cap] failure 25');
    });

    test('truncates very long messages', () => {
        con.error(`[Long] ${'x'.repeat(2000)}`);
        expect(getEntries()[0].message.length).toBeLessThanOrEqual(500);
    });

    test('a listener that throws does not break capture, and neither does a re-entrant error', async () => {
        const unsubscribe = subscribe(() => {
            con.error('[Listener] re-entrant');
            throw new Error('listener blew up');
        });
        expect(() => con.error('[Outer] first')).not.toThrow();
        // Notifications are coalesced onto a microtask
        await Promise.resolve();
        unsubscribe();
        const entries = getEntries();
        expect(entries.some((entry) => entry.message === '[Outer] first')).toBe(true);
        expect(entries.some((entry) => entry.message === '[Listener] re-entrant')).toBe(false);
    });
});

describe('window events', () => {
    test('keeps an error event whose filename names the script', () => {
        target.fire('error', {
            message: 'Cannot read properties of undefined',
            filename: 'http://127.0.0.1:8765/Toolasha-dev.user.js',
            error: new Error('Cannot read properties of undefined'),
        });
        const entries = getEntries();
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ kind: 'error', module: null });
        expect(entries[0].message).toContain('Cannot read properties of undefined');
    });

    test('keeps an error event whose stack names a production bundle', () => {
        const error = new Error('x is not a function');
        error.stack = 'TypeError: x is not a function\n    at draw (https://cdn.example/toolasha-ui.js:10:5)';
        target.fire('error', { message: error.message, filename: '', error });
        expect(getEntries()).toHaveLength(1);
    });

    test('ignores an error event from the game', () => {
        const error = new Error('game broke');
        error.stack = 'Error: game broke\n    at https://www.milkywayidle.com/static/js/main.js:1:1';
        target.fire('error', {
            message: 'game broke',
            filename: 'https://www.milkywayidle.com/static/js/main.js',
            error,
        });
        expect(getEntries()).toEqual([]);
    });

    test('keeps a rejection with a module prefix or our stack, ignores the rest', () => {
        const prefixed = new Error('[Sync] push failed');
        prefixed.stack = 'Error: [Sync] push failed\n    at push (https://cdn.example/other.js:1:1)';
        target.fire('unhandledrejection', { reason: prefixed });
        const ours = new Error('late');
        ours.stack = 'Error: late\n    at https://cdn.example/toolasha-core.js:3:3';
        target.fire('unhandledrejection', { reason: ours });
        // The Chrome-extension noise every page sees: no prefix, a stack that
        // is not ours (set explicitly — a test file's own path names the repo)
        const noise = new Error(
            'A listener indicated an asynchronous response by returning true, but the message channel closed'
        );
        noise.stack = 'Error: A listener indicated…\n    at chrome-extension://abcdef/content.js:1:1';
        target.fire('unhandledrejection', { reason: noise });
        target.fire('unhandledrejection', { reason: 'plain string rejection' });
        const entries = getEntries();
        expect(entries).toHaveLength(2);
        expect(entries[1]).toMatchObject({ kind: 'rejection', module: 'Sync' });
        expect(entries[0]).toMatchObject({ kind: 'rejection', module: null, message: 'Error: late' });
    });
});

describe('lifecycle', () => {
    test('uninstall restores console.error and stops listening', () => {
        const wrapped = con.error;
        expect(wrapped.name).toBe('toolashaConsoleError');
        uninstall();
        expect(isInstalled()).toBe(false);
        expect(con.error).not.toBe(wrapped);
        con.error('[After] should not be kept');
        target.fire('error', { message: 'x', filename: 'toolasha-core.js', error: new Error('x') });
        expect(getEntries()).toEqual([]);
        expect(con.calls).toHaveLength(1);
    });

    test('install twice is a no-op', () => {
        expect(install({ console: con, target })).toBe(false);
        con.error('[Once] hello');
        expect(getEntries()).toHaveLength(1);
    });

    test('subscribe hears the settled state once per burst, and clear empties the log', async () => {
        const seen = [];
        const unsubscribe = subscribe((entries) => seen.push(entries.length));

        con.error('[Sub] one');
        await Promise.resolve();
        expect(seen).toEqual([1]);

        // A burst inside one turn is one notification carrying the end state,
        // not one per failure
        con.error('[Sub] two');
        con.error('[Sub] three');
        con.error('[Sub] four');
        await Promise.resolve();
        expect(seen).toEqual([1, 4]);

        clear();
        await Promise.resolve();
        expect(seen).toEqual([1, 4, 0]);

        unsubscribe();
        con.error('[Sub] five');
        await Promise.resolve();
        expect(seen).toEqual([1, 4, 0]);
        expect(getEntries()).toHaveLength(1);
    });
});
