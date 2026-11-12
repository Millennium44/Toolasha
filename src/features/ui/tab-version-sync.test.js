/**
 * @vitest-environment happy-dom
 *
 * Tabs following a newer Toolasha. The failures that matter: a tab reloading
 * while in use, two tabs reloading each other, a reload that never upgrades
 * repeating, and a reload before saves are written.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

const reloadPrompts = vi.hoisted(() => []);
vi.mock('../../core/reload-log.js', () => ({
    recordReloadPrompt: (prompt) => {
        const entry = { ...prompt, outcome: 'unknown' };
        reloadPrompts.push(entry);
        return { settle: (outcome) => (entry.outcome = outcome) };
    },
}));

const state = vi.hoisted(() => ({
    settings: {},
    version: '3.16.0',
    root: {},
    connected: true,
    flush: async () => {},
    flushes: 0,
    pending: 0,
    toasts: [],
    channels: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => state.settings[key] ?? fallback,
        onSettingChange: () => () => {},
    },
}));
vi.mock('../../core/connection-state.js', () => ({ default: { isConnected: () => state.connected } }));
vi.mock('../../core/storage.js', () => ({
    default: {
        flushAll: async () => {
            state.flushes += 1;
            return state.flush();
        },
        pendingWriteCount: () => state.pending,
        isRestoreInProgress: () => state.restoring === true,
    },
}));
vi.mock('../../utils/script-version.js', () => ({ scriptVersion: () => state.version }));
vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    toolashaRoot: () => state.root,
}));
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        const toast = { message, options, dismissed: false };
        toast.dismiss = () => {
            toast.dismissed = true;
        };
        state.toasts.push(toast);
        return toast;
    },
}));

class FakeChannel {
    constructor(name) {
        this.name = name;
        this.posted = [];
        this.closed = false;
        this.onmessage = null;
        state.channels.push(this);
    }
    postMessage(data) {
        this.posted.push(data);
    }
    close() {
        this.closed = true;
    }
}

const {
    default: feature,
    tabVersionSync,
    describeBuild,
    isStrictlyNewer,
    HIDDEN_RELOAD_DELAY_MS,
    ALWAYS_RELOAD_DELAY_MS,
    RECORD_KEY,
} = await import('./tab-version-sync.js');

let reload;
let visibility;

function hear(version, buildStamp = null) {
    const channel = state.channels.at(-1);
    channel.onmessage({ data: { type: 'version', version, buildStamp } });
}

/** Run past the hidden-tab delay and let the flush settle */
async function settle() {
    await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS + 100);
}

function setVisibility(value) {
    visibility = value;
    document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(async () => {
    reloadPrompts.length = 0;
    vi.useFakeTimers();
    vi.stubGlobal('BroadcastChannel', FakeChannel);
    // The endings below are about background reloading, which is opt-in; the default is pinned separately
    state.settings = { tabVersionSync: 'auto' };
    state.version = '3.16.0';
    state.root = {};
    state.connected = true;
    state.flush = async () => {};
    state.flushes = 0;
    state.pending = 0;
    state.restoring = false;
    state.toasts = [];
    state.channels = [];
    window.sessionStorage.clear();
    visibility = 'hidden';
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
    reload = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { reload } });
    await feature.initialize();
});

afterEach(() => {
    feature.cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('comparison', () => {
    test('releases compare numerically, dev builds by stamp, never across kinds', () => {
        const rel = (v) => describeBuild(v, null);
        expect(isStrictlyNewer(rel('3.9.0'), rel('3.10.0'))).toBe(true);
        expect(isStrictlyNewer(rel('3.10.0'), rel('3.9.0'))).toBe(false);
        expect(isStrictlyNewer(rel('3.10.0'), rel('3.10'))).toBe(false);
        const dev = (s) => describeBuild('3.16.0', s);
        expect(isStrictlyNewer(dev('2026-08-22T15:30:00Z'), dev('2026-08-22T15:31:00Z'))).toBe(true);
        expect(isStrictlyNewer(dev('2026-08-22T15:31:00Z'), dev('2026-08-22T15:30:00Z'))).toBe(false);
        expect(isStrictlyNewer(rel('3.1.0'), dev('2026-08-22T15:30:00Z'))).toBe(false);
        expect(isStrictlyNewer(dev('2026-08-22T15:30:00Z'), rel('9.0.0'))).toBe(false);
        expect(describeBuild('garbage', null)).toBeNull();
    });
});

describe('endings', () => {
    test('announces its own build on a same-origin channel after startup', async () => {
        await vi.advanceTimersByTimeAsync(3100);
        expect(state.channels[0].posted).toEqual([{ type: 'version', version: '3.16.0', buildStamp: null }]);
    });

    test('newer release heard while already hidden: reloads once, two minutes after hearing', async () => {
        await vi.advanceTimersByTimeAsync(60 * 1000); // hidden a while before hearing
        hear('3.17.0');
        await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS - 1000);
        expect(reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1100);
        expect(state.flushes).toBe(1);
        expect(reload).toHaveBeenCalledTimes(1);
        hear('3.17.0');
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('hidden for 1:59 then visible: notice, no reload', async () => {
        hear('3.17.0');
        await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS - 1000);
        setVisibility('visible');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(1);
    });

    test('the notice is logged as a newer-build prompt; Reload settles it, closing it dismisses it', async () => {
        visibility = 'visible';
        hear('3.17.0');
        await settle();
        expect(reloadPrompts).toHaveLength(1);
        expect(reloadPrompts[0]).toMatchObject({ source: 'tab-version', kind: 'newer-build' });
        state.toasts[0].options.onClose('dismiss');
        expect(reloadPrompts[0].outcome).toBe('dismissed');
        state.toasts[0].options.action.onClick();
        expect(reloadPrompts[0].outcome).toBe('reloaded');
    });

    test('heard while visible: notice now, no reload; counts from when it later becomes hidden', async () => {
        visibility = 'visible';
        hear('3.17.0');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(1);
        expect(state.toasts[0].message).toBe('A newer Toolasha version loaded in another tab');
        expect(state.toasts[0].options.action.label).toBe('Reload');
        setVisibility('hidden');
        await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS - 1000);
        expect(reload).not.toHaveBeenCalled();
        setVisibility('visible');
        setVisibility('hidden');
        await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS - 1000);
        expect(reload).not.toHaveBeenCalled(); // the count restarted at the second hide
        await vi.advanceTimersByTimeAsync(1100);
        expect(reload).toHaveBeenCalledTimes(1);
        expect(state.toasts).toHaveLength(1);
    });

    test('the notice Reload button reloads', async () => {
        visibility = 'visible';
        hear('3.17.0');
        state.toasts[0].options.action.onClick();
        await vi.advanceTimersByTimeAsync(10);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('the notice is not shown again for that version, but is for a later one', () => {
        visibility = 'visible';
        hear('3.17.0');
        hear('3.17.0');
        setVisibility('hidden');
        setVisibility('visible');
        expect(state.toasts).toHaveLength(1);
        hear('3.18.0');
        expect(state.toasts).toHaveLength(2);
    });

    test('equal, older, dev-vs-release and garbage do nothing', async () => {
        hear('3.16.0');
        hear('3.15.0');
        hear('3.99.0', '2026-08-22T15:30:00Z');
        hear('nonsense');
        state.channels[0].onmessage({ data: null });
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(0);
    });

    test('a dev tab ignores releases and follows only a newer stamp', async () => {
        feature.cleanup();
        state.version = '3.16.0.20260822153000';
        state.root = { buildStamp: '2026-08-22T15:30:00Z' };
        await feature.initialize();
        hear('99.0.0');
        hear('3.16.0.20260822153000', '2026-08-22T15:30:00Z');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        hear('3.16.0.20260822160000', '2026-08-22T16:00:00Z');
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('a reload that did not upgrade falls back to the notice, with no second reload', async () => {
        hear('3.17.0');
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        // The page "reloaded" and is still 3.16.0; sessionStorage survived
        feature.cleanup();
        await feature.initialize();
        visibility = 'visible';
        hear('3.17.0');
        await settle();
        setVisibility('hidden');
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(state.toasts).toHaveLength(1);
    });

    test('an unreadable record counts as spent: no reload', async () => {
        window.sessionStorage.setItem(RECORD_KEY, '{not json');
        hear('3.17.0');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        setVisibility('visible');
        expect(state.toasts).toHaveLength(1);
    });

    test('becoming visible during the flush cancels the reload', async () => {
        let release;
        state.flush = () => new Promise((resolve) => (release = resolve));
        hear('3.17.0');
        await settle();
        visibility = 'visible';
        release();
        await vi.advanceTimersByTimeAsync(10);
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(1);
    });

    test('a failed or stuck flush never reloads', async () => {
        state.flush = async () => {
            throw new Error('idb');
        };
        hear('3.17.0');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        feature.cleanup();
        await feature.initialize();
        state.flush = () => new Promise(() => {});
        hear('3.18.0');
        await settle();
        await vi.advanceTimersByTimeAsync(6000);
        expect(reload).not.toHaveBeenCalled();
    });

    test('a flush that resolves with writes still queued never reloads; the notice shows when seen', async () => {
        state.flush = async () => {
            state.pending = 1; // a failed write was requeued
        };
        hear('3.17.0');
        await settle();
        expect(state.flushes).toBe(1);
        expect(reload).not.toHaveBeenCalled();
        expect(window.sessionStorage.getItem(RECORD_KEY)).toBeNull();
        setVisibility('visible');
        expect(state.toasts).toHaveLength(1);
    });

    test('visible then hidden again during the flush: the earlier flush cannot reload early', async () => {
        let release;
        state.flush = () => new Promise((resolve) => (release = resolve));
        hear('3.17.0');
        await settle();
        setVisibility('visible');
        setVisibility('hidden'); // new two-minute countdown starts
        release();
        await vi.advanceTimersByTimeAsync(10);
        expect(reload).not.toHaveBeenCalled();
        state.flush = async () => {};
        await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS + 100);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('turned off during the flush: no reload', async () => {
        let release;
        state.flush = () => new Promise((resolve) => (release = resolve));
        hear('3.17.0');
        await settle();
        state.settings.tabVersionSync = 'off';
        tabVersionSync._applyMode();
        release();
        await vi.advanceTimersByTimeAsync(10);
        expect(reload).not.toHaveBeenCalled();
    });

    test('an older build announcing is answered once with its own build', async () => {
        const channel = state.channels.at(-1);
        hear('3.15.0');
        expect(channel.posted).toEqual([{ type: 'version', version: '3.16.0', buildStamp: null }]);
        hear('3.15.0'); // same older build again: no second reply
        expect(channel.posted).toHaveLength(1);
        hear('3.14.0'); // a different older build: one more
        expect(channel.posted).toHaveLength(2);
        // equal, newer, garbage and a dev build against a release are never answered
        hear('3.16.0');
        hear('3.17.0');
        hear('nonsense');
        hear('3.1.0', '2026-08-22T15:30:00Z');
        expect(channel.posted).toHaveLength(2);
    });

    test('an older tab that hears the reply follows the usual rules: one reload, then the notice', async () => {
        feature.cleanup();
        state.version = '3.15.0';
        await feature.initialize();
        hear('3.16.0'); // the reply from the newer tab
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(state.channels.at(-1).posted).toEqual([{ type: 'version', version: '3.15.0', buildStamp: null }]); // only the startup announcement, no reply
        feature.cleanup();
        await feature.initialize(); // reload loaded the old script again
        visibility = 'visible';
        hear('3.16.0');
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(state.toasts).toHaveLength(1);
    });

    test('a disconnected tab (character taken elsewhere) is not reloaded', async () => {
        state.connected = false;
        hear('3.17.0');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.flushes).toBe(0);
    });

    test('setting off: no channel, nothing happens', async () => {
        feature.cleanup();
        state.channels = [];
        state.settings.tabVersionSync = 'off';
        await feature.initialize();
        expect(state.channels).toHaveLength(0);
        expect(reload).not.toHaveBeenCalled();
    });

    test('turned off while a reload is pending: cancelled, channel closed', async () => {
        hear('3.17.0');
        state.settings.tabVersionSync = 'off';
        tabVersionSync._applyMode();
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(0);
        expect(state.channels[0].closed).toBe(true);
    });

    test('always reload reloads even a visible tab, after a short debounce', async () => {
        state.settings.tabVersionSync = 'reload';
        visibility = 'visible';
        hear('3.17.0');
        await vi.advanceTimersByTimeAsync(ALWAYS_RELOAD_DELAY_MS + 100);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('always ask never reloads; a hidden tab asks when it becomes visible', async () => {
        state.settings.tabVersionSync = 'ask';
        hear('3.17.0');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(0);
        setVisibility('visible');
        expect(state.toasts).toHaveLength(1);
    });

    test('by default nothing reloads by itself: a hidden tab waits and asks once looked at', async () => {
        delete state.settings.tabVersionSync;
        hear('3.17.0');
        await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS * 2);
        expect(reload).not.toHaveBeenCalled();
        setVisibility('visible');
        expect(state.toasts).toHaveLength(1);
    });

    test('two tabs announcing to each other do not loop', async () => {
        hear('3.17.0');
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        // The reloaded tab now runs 3.17.0 and hears the peers' announcements
        feature.cleanup();
        state.version = '3.17.0';
        await feature.initialize();
        hear('3.17.0');
        hear('3.16.0');
        await settle();
        expect(reload).toHaveBeenCalledTimes(1);
        expect(state.toasts).toHaveLength(0);
    });

    test('cleanup closes the channel and drops the toast', () => {
        visibility = 'visible';
        hear('3.17.0');
        feature.cleanup();
        expect(state.channels[0].closed).toBe(true);
        expect(state.toasts[0].dismissed).toBe(true);
    });
});

describe('mode changed after a newer build was heard', () => {
    function switchMode(mode) {
        state.settings = { tabVersionSync: mode };
        tabVersionSync._applyMode(); // what config.onSettingChange calls
    }

    test('ask -> reload: starts the short countdown and reloads once', async () => {
        state.settings = { tabVersionSync: 'ask' };
        visibility = 'visible';
        hear('3.17.0');
        expect(state.toasts).toHaveLength(1);
        switchMode('reload');
        await vi.advanceTimersByTimeAsync(ALWAYS_RELOAD_DELAY_MS + 100);
        expect(state.flushes).toBe(1);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('ask -> auto while hidden: starts the hidden countdown', async () => {
        state.settings = { tabVersionSync: 'ask' };
        hear('3.17.0');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        switchMode('auto');
        await vi.advanceTimersByTimeAsync(HIDDEN_RELOAD_DELAY_MS - 1000);
        expect(reload).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1100);
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('ask -> auto while visible: keeps the notice, no countdown', async () => {
        state.settings = { tabVersionSync: 'ask' };
        visibility = 'visible';
        hear('3.17.0');
        switchMode('auto');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(1);
    });

    test('reload -> ask with the countdown running: cancels it and shows the notice', async () => {
        state.settings = { tabVersionSync: 'reload' };
        visibility = 'visible';
        hear('3.17.0');
        expect(state.toasts).toHaveLength(0);
        switchMode('ask');
        expect(state.toasts).toHaveLength(1);
        await settle();
        expect(reload).not.toHaveBeenCalled();
    });

    test('any -> off: tears down, no reload', async () => {
        state.settings = { tabVersionSync: 'reload' };
        hear('3.17.0');
        switchMode('off');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.channels[0].closed).toBe(true);
    });

    test('mode change with nothing heard: nothing happens', async () => {
        switchMode('reload');
        await settle();
        expect(reload).not.toHaveBeenCalled();
        expect(state.toasts).toHaveLength(0);
    });

    test('mode change while a write is pending: reload refused, notice instead', async () => {
        state.settings = { tabVersionSync: 'ask' };
        visibility = 'visible';
        hear('3.17.0');
        state.pending = 1;
        switchMode('reload');
        await vi.advanceTimersByTimeAsync(ALWAYS_RELOAD_DELAY_MS + 100);
        expect(state.flushes).toBe(1);
        expect(reload).not.toHaveBeenCalled();
    });

    test('a reload due while a restore or sync pull is writing asks instead', async () => {
        state.settings = { tabVersionSync: 'ask' };
        visibility = 'visible';
        hear('3.17.0');
        // flushAll() holds during a restore and resolves at once with nothing counted as pending
        state.restoring = true;
        switchMode('reload');
        await vi.advanceTimersByTimeAsync(ALWAYS_RELOAD_DELAY_MS + 100);
        expect(state.flushes).toBe(1);
        expect(reload).not.toHaveBeenCalled();
    });
});
