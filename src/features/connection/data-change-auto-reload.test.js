/** @vitest-environment happy-dom */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const state = vi.hoisted(() => ({
    setting: '30',
    settingCallbacks: [],
    dm: {},
    simBusy: false,
    labBusy: false,
    restoring: false,
    pending: 0,
    flushFails: false,
    flushGate: null,
    logged: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        getSettingValue: (key, fallback) => (key === 'dataChangeAutoReload' ? state.setting : fallback),
        onSettingChange: (key, cb) => {
            state.settingCallbacks.push(cb);
            return () => {
                const i = state.settingCallbacks.indexOf(cb);
                if (i > -1) state.settingCallbacks.splice(i, 1);
            };
        },
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        on: (e, cb) => (state.dm[e] ||= []).push(cb),
        off: (e, cb) => {
            const list = state.dm[e] || [];
            const i = list.indexOf(cb);
            if (i > -1) list.splice(i, 1);
        },
    },
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        flushAll: async () => {
            if (state.flushGate) await state.flushGate;
            if (state.flushFails) throw new Error('flush failed');
        },
        pendingWriteCount: () => state.pending,
        isRestoreInProgress: () => state.restoring,
        update: async (key, mutate) => {
            state.logged = mutate(state.logged);
            return { written: true, value: state.logged };
        },
        get: async () => state.logged,
        onBeforeTeardown: () => () => {},
    },
}));

vi.mock('../../utils/bundle-bridge.js', async (importOriginal) => ({
    ...(await importOriginal()),
    toolashaRoot: () => ({
        Sim: {
            combatSimUI: { _isBusy: () => state.simBusy },
            labSim: { isBusy: () => state.labBusy },
        },
    }),
}));

import auto, { RECORD_KEY, MAX_AUTO_RELOADS, RECHECK_MS } from './data-change-auto-reload.js';
import * as reloadLog from '../../core/reload-log.js';
import { activeToastCount, dismissAllToasts } from '../../utils/toast.js';

const SEC = 1000;
let reloadSpy;

const prompt = (kind = 'data-changed', source = 'sync-pull') =>
    reloadLog.recordReloadPrompt({ source, kind, message: 'Reload now', records: ['Watchlist'] });
const toastText = () => document.querySelector('.toolasha-toast')?.textContent || '';
const flush = async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
};
const advance = async (ms) => {
    await vi.advanceTimersByTimeAsync(ms);
    await flush();
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T10:00:00'));
    state.setting = '30';
    state.simBusy = false;
    state.labBusy = false;
    state.restoring = false;
    state.pending = 0;
    state.flushFails = false;
    state.flushGate = null;
    state.logged = [];
    state.dm = {};
    state.settingCallbacks = [];
    reloadLog.resetReloadLog();
    window.sessionStorage.clear();
    reloadSpy = vi.spyOn(auto, '_performReload').mockImplementation(() => {});
    auto.initialize();
});

afterEach(() => {
    auto.disable();
    dismissAllToasts();
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe('what it reloads for', () => {
    test('a data-changed prompt reloads after the chosen delay and the log says auto-reloaded', async () => {
        const handle = prompt();
        expect(toastText()).toContain('will reload it at');
        await advance(29 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        await advance(2 * SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect(handle.outcome()).toBe('auto-reloaded');
        await flush();
        expect(state.logged[0].outcome).toBe('auto-reloaded');
    });

    test('repair prompts and the newer-build notice are never reloaded for the player', async () => {
        prompt('recovery', 'recovery');
        prompt('newer-build', 'tab-version');
        await advance(10 * 60 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(activeToastCount()).toBe(0);
    });

    test('off: nothing is shown and nothing reloads', async () => {
        state.setting = 'off';
        prompt();
        await advance(10 * 60 * SEC);
        expect(activeToastCount()).toBe(0);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('two prompts in one wait share one countdown and both are settled', async () => {
        const a = prompt();
        const b = prompt();
        expect(activeToastCount()).toBe(1);
        await advance(31 * SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect([a.outcome(), b.outcome()]).toEqual(['auto-reloaded', 'auto-reloaded']);
    });
});

describe('what holds it back', () => {
    test('using the page during the wait turns it into an offer', async () => {
        const handle = prompt();
        window.dispatchEvent(new Event('keydown'));
        await advance(31 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(toastText()).toContain('you were using the page');
        expect(handle.outcome()).toBe('unknown');
    });

    test('a running Combat Sim delays it and it goes once the run ends', async () => {
        prompt();
        state.simBusy = true;
        await advance(31 * SEC);
        await advance(RECHECK_MS * 3);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(toastText()).toContain('simulator run');
        state.simBusy = false;
        await advance(RECHECK_MS + SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('a running Lab Sim delays it', async () => {
        prompt();
        state.labBusy = true;
        await advance(40 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        state.labBusy = false;
        await advance(RECHECK_MS + SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('a focused text box inside a Toolasha window delays it; one outside does not', async () => {
        const panel = document.createElement('div');
        panel.setAttribute('data-toolasha-surface', 'panel');
        const input = document.createElement('input');
        panel.appendChild(input);
        document.body.appendChild(panel);
        input.focus();
        prompt();
        await advance(40 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(toastText()).toContain('text box');
        input.blur();
        await advance(RECHECK_MS + SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('a text box outside Toolasha does not block', async () => {
        const input = document.createElement('input');
        document.body.appendChild(input);
        input.focus();
        prompt();
        await advance(31 * SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('a restore still writing delays it', async () => {
        prompt();
        state.restoring = true;
        await advance(40 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        state.restoring = false;
        await advance(RECHECK_MS + SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('saves that did not finish turn it into an offer', async () => {
        state.pending = 2;
        prompt();
        await advance(31 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(toastText()).toContain('saves had not finished');
        dismissAllToasts();
        state.flushFails = true;
        state.pending = 0;
        prompt();
        await advance(31 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('the loop guard stops the third reload inside ten minutes and says so', async () => {
        for (let i = 0; i < MAX_AUTO_RELOADS; i++) {
            prompt();
            await advance(31 * SEC);
            expect(reloadSpy).toHaveBeenCalledTimes(i + 1);
            dismissAllToasts();
        }
        prompt();
        expect(toastText()).toContain('stopped reloading by itself');
        await advance(60 * SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(MAX_AUTO_RELOADS);
        // Ten minutes after the first, the window has moved on
        await advance(11 * 60 * SEC);
        dismissAllToasts();
        prompt();
        await advance(31 * SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(MAX_AUTO_RELOADS + 1);
    });

    test('an unreadable record counts as spent', async () => {
        window.sessionStorage.setItem(RECORD_KEY, '{not json');
        prompt();
        expect(toastText()).toContain('cannot keep count');
        await advance(60 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('a record that cannot be written means no reload', async () => {
        const setItem = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
            throw new Error('full');
        });
        prompt();
        await advance(31 * SEC);
        setItem.mockRestore();
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(toastText()).toContain('could not safely reload');
    });
});

describe('ending the wait', () => {
    test('Cancel stops it and the log says cancelled', async () => {
        const handle = prompt();
        document.querySelector('.toolasha-data-change-cancel').click();
        await advance(60 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(activeToastCount()).toBe(0);
        expect(handle.outcome()).toBe('cancelled');
    });

    test('Reload now reloads at once and the log says reloaded', async () => {
        const handle = prompt();
        document.querySelector('.toolasha-toast').click();
        expect(reloadSpy).toHaveBeenCalledTimes(1);
        expect(handle.outcome()).toBe('reloaded');
        await advance(60 * SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });

    test('turning the setting off during the wait cancels it', async () => {
        prompt();
        state.setting = 'off';
        state.settingCallbacks.forEach((cb) => cb());
        await advance(60 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
        expect(activeToastCount()).toBe(0);
    });

    test('a character switch cancels it', async () => {
        prompt();
        state.dm.character_switching.forEach((cb) => cb());
        await advance(60 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('disable clears timers, notice and listeners', async () => {
        prompt();
        window.dispatchEvent(new Event('keydown'));
        auto.disable();
        expect(vi.getTimerCount()).toBe(0);
        expect(activeToastCount()).toBe(0);
        expect(auto.interactionHandler).toBeNull();
        expect(state.settingCallbacks).toHaveLength(0);
        expect(state.dm.character_switching).toHaveLength(0);
        prompt();
        await advance(60 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('disable during the final flush stops the reload', async () => {
        let open;
        state.flushGate = new Promise((resolve) => {
            open = resolve;
        });
        prompt();
        await advance(30 * SEC);
        auto.disable();
        open();
        await advance(10 * SEC);
        expect(reloadSpy).not.toHaveBeenCalled();
    });

    test('re-enabling after a disable works', async () => {
        auto.disable();
        auto.initialize();
        prompt();
        await advance(31 * SEC);
        expect(reloadSpy).toHaveBeenCalledTimes(1);
    });
});
