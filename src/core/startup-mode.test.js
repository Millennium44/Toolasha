/** @vitest-environment happy-dom */
import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
    MODE_FLAG_KEY,
    MENU_LABELS,
    requestMode,
    consumeMode,
    buildStartupLog,
    recordInitFailures,
    resetInitFailures,
    registerMenuCommands,
    showModeNotice,
} from './startup-mode.js';

function fakeStorage() {
    const map = new Map();
    return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, String(v)),
        removeItem: (k) => map.delete(k),
    };
}

describe('startup mode flag', () => {
    test('requestMode stores the flag and reloads', () => {
        const storage = fakeStorage();
        const reload = vi.fn();
        expect(requestMode('safe', { storage, reload })).toBe(true);
        expect(storage.getItem(MODE_FLAG_KEY)).toBe('safe');
        expect(reload).toHaveBeenCalledTimes(1);
    });

    test('rejects unknown modes without touching storage', () => {
        const storage = fakeStorage();
        const reload = vi.fn();
        expect(requestMode('bogus', { storage, reload })).toBe(false);
        expect(storage.getItem(MODE_FLAG_KEY)).toBeNull();
        expect(reload).not.toHaveBeenCalled();
    });

    test('the flag is one-shot', () => {
        const storage = fakeStorage();
        storage.setItem(MODE_FLAG_KEY, 'debug');
        expect(consumeMode({ storage })).toBe('debug');
        expect(consumeMode({ storage })).toBeNull();
    });

    test('an unrecognized stored value is cleared and ignored', () => {
        const storage = fakeStorage();
        storage.setItem(MODE_FLAG_KEY, 'whatever');
        expect(consumeMode({ storage })).toBeNull();
        expect(storage.getItem(MODE_FLAG_KEY)).toBeNull();
    });

    test('unavailable storage reads as no request', () => {
        expect(consumeMode({ storage: null })).toBeNull();
        const broken = {
            getItem: () => {
                throw new Error('blocked');
            },
        };
        expect(consumeMode({ storage: broken })).toBeNull();
    });
});

describe('menu registration', () => {
    test('is a no-op when GM_registerMenuCommand is absent', () => {
        expect(registerMenuCommands({ mode: null, env: { registerMenuCommand: null } })).toEqual([]);
    });

    test('registers safe start and startup log, plus download in debug mode', () => {
        const register = vi.fn();
        expect(registerMenuCommands({ mode: null, env: { registerMenuCommand: register } })).toEqual([
            MENU_LABELS.safe,
            MENU_LABELS.debug,
        ]);
        const labels = registerMenuCommands({
            mode: 'debug',
            onDownload: () => {},
            env: { registerMenuCommand: register },
        });
        expect(labels).toContain(MENU_LABELS.download);
    });

    test('the commands request the right mode', () => {
        const storage = fakeStorage();
        const reload = vi.fn();
        const register = vi.fn();
        registerMenuCommands({ mode: null, env: { registerMenuCommand: register, storage, reload } });
        register.mock.calls[0][1]();
        expect(storage.getItem(MODE_FLAG_KEY)).toBe('safe');
        register.mock.calls[1][1]();
        expect(storage.getItem(MODE_FLAG_KEY)).toBe('debug');
        expect(reload).toHaveBeenCalledTimes(2);
    });
});

describe('notice', () => {
    beforeEach(() => {
        document.documentElement.querySelector('#toolasha-startup-mode-notice')?.remove();
    });

    test('safe mode shows a notice with a Start normally button that reloads', () => {
        const reload = vi.fn();
        const el = showModeNotice({ mode: 'safe', env: { reload } });
        expect(el.textContent).toContain('safe mode');
        const buttons = [...el.querySelectorAll('button')];
        expect(buttons.map((b) => b.textContent)).toEqual(['Start normally']);
        buttons[0].click();
        expect(reload).toHaveBeenCalled();
    });

    test('debug mode offers the download', () => {
        const onDownload = vi.fn();
        const el = showModeNotice({ mode: 'debug', onDownload, env: { reload: () => {} } });
        const download = [...el.querySelectorAll('button')].find((b) => b.textContent === 'Download startup log');
        download.click();
        expect(onDownload).toHaveBeenCalled();
    });
});

describe('startup log', () => {
    beforeEach(() => resetInitFailures());

    const monitor = {
        getMarks: () => [
            { name: 'script:start', at: 1.234, detail: null },
            // a stray payload-shaped detail must not survive
            { name: 'features:start', at: 50, detail: { registered: 12, items: [{ id: 1 }], name: 'SecretChar' } },
        ],
        getSnapshots: () =>
            new Map([
                ['init:networth', { duration: 12.34, startedAt: 40 }],
                ['init:networth:own', { duration: 2, startedAt: 40 }],
                ['startup:complete', { duration: 900, startedAt: 0 }],
            ]),
        getStalls: () => [
            { sinceBoot: 300, duration: 120, suspects: [{ name: 'dom:x', ms: 60 }], recentEvents: ['ws:a'] },
        ],
        sinceBoot: () => 1000,
    };
    const errorLog = {
        getEntries: () => [
            { ts: 5, kind: 'error', module: 'Foo', message: 'x'.repeat(1000), stack: 'SECRET STACK', count: 2 },
        ],
    };

    test('contains phase and feature timings and errors', () => {
        recordInitFailures([{ key: 'networth', reason: 'boom' }]);
        const log = buildStartupLog({ mode: 'debug', performanceMonitor: monitor, errorLog, version: '1.0.0' });
        expect(log.phases.map((p) => p.name)).toEqual(['script:start', 'features:start']);
        expect(log.features).toEqual([{ key: 'networth', totalMs: 12.3, startedAtMs: 40, ownMs: 2 }]);
        expect(log.timings[0].name).toBe('startup:complete');
        expect(log.errors[0].module).toBe('Foo');
        expect(log.errors[0].message.length).toBeLessThanOrEqual(300);
        expect(log.initFailures).toEqual([{ key: 'networth', reason: 'boom' }]);
        expect(log.stalls[0].durationMs).toBe(120);
    });

    test('error text has its dynamic values taken out', () => {
        const log = buildStartupLog({
            mode: 'debug',
            performanceMonitor: monitor,
            errorLog: {
                getEntries: () => [
                    { module: 'A', message: 'Failed to load character 32030' },
                    { module: 'B', message: 'Snapshot "My Main Build" failed' },
                    { module: 'C', message: 'Unknown item /items/radiant_gloves in loadout' },
                    { module: 'D', message: 'Bad payload: {"characterId":32030,"name":"Bob"}' },
                ],
            },
        });
        const text = JSON.stringify(log.errors);
        for (const leak of ['32030', 'My Main Build', 'radiant_gloves', 'Bob', 'characterId']) {
            expect(text).not.toContain(leak);
        }
        expect(log.errors[0].message).toBe('Failed to load character #');
    });

    test('carries no payload fields', () => {
        const text = JSON.stringify(buildStartupLog({ mode: 'debug', performanceMonitor: monitor, errorLog }));
        expect(text).not.toContain('SecretChar');
        expect(text).not.toContain('SECRET STACK');
        expect(text).not.toContain('"items"');
        expect(buildStartupLog({ mode: 'debug', performanceMonitor: monitor, errorLog }).phases[1].detail).toEqual({
            registered: 12,
        });
    });
});
