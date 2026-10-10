/** @vitest-environment happy-dom */

/**
 * Boots the entrypoint with the one-shot startup flag set, against stub libraries,
 * and checks what did and did not run.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import * as startupMode from './core/startup-mode.js';

function makeStub() {
    return new Proxy(function stub() {}, {
        get: (target, prop) => (prop === 'then' ? undefined : makeStub()),
        apply: () => makeStub(),
    });
}

const calls = { wsInstall: 0, replaceFeatures: 0, domObserverStart: 0, storageInit: 0, initializeFeatures: 0 };
let menu;

function installLibraries() {
    window.Toolasha = {
        Core: {
            storage: {
                initialize: async () => {
                    calls.storageInit += 1;
                },
                diagnostics: () => ({}),
            },
            config: { getSetting: () => undefined, initialize: async () => {}, loadSettings: async () => {} },
            webSocketHook: {
                install: () => {
                    calls.wsInstall += 1;
                },
                captureClientDataFromLocalStorage: () => {},
            },
            domObserver: {
                start: () => {
                    calls.domObserverStart += 1;
                },
            },
            dataManager: { initialize: () => {}, on: () => {} },
            featureRegistry: {
                replaceFeatures: () => {
                    calls.replaceFeatures += 1;
                },
                setupCharacterSwitchHandler: () => {},
                setupLiveFeatureStart: () => () => {},
                initializeFeatures: async () => {
                    calls.initializeFeatures += 1;
                    return [];
                },
            },
            performanceMonitor: { mark: () => {}, startStallWatch: () => {} },
            marketAPI: { fetch: async () => null, startAutoRefresh: () => {} },
            settingsMirror: { startMirroring: () => {} },
            storagePersistence: {},
            errorLog: { install: () => true, getEntries: () => [] },
            dualInstallGuard: { claimPage: () => false },
            startupMode,
        },
        Utils: {
            dom: { setupScrollTooltipDismissal: () => {}, addStyles: () => {} },
            toast: { showToast: () => {} },
            selectors: { GAME: {} },
        },
        Sim: makeStub(),
        Market: makeStub(),
        Actions: makeStub(),
        Combat: makeStub(),
        UI: makeStub(),
    };
}

beforeEach(() => {
    vi.resetModules();
    for (const key of Object.keys(calls)) calls[key] = 0;
    menu = [];
    globalThis.GM_registerMenuCommand = (label, fn) => menu.push({ label, fn });
    document.documentElement.querySelector('#toolasha-startup-mode-notice')?.remove();
    sessionStorage.clear();
    installLibraries();
});

afterEach(() => {
    delete globalThis.GM_registerMenuCommand;
});

describe('safe start', () => {
    test('calls no feature initialize, hooks nothing, shows the notice, and consumes the flag', async () => {
        sessionStorage.setItem(startupMode.MODE_FLAG_KEY, 'safe');
        await import('./entrypoint.js');
        expect(calls.replaceFeatures).toBe(0);
        expect(calls.initializeFeatures).toBe(0);
        expect(calls.wsInstall).toBe(0);
        expect(calls.domObserverStart).toBe(0);
        expect(calls.storageInit).toBe(0);
        const notice = document.getElementById('toolasha-startup-mode-notice');
        expect(notice.textContent).toContain('safe mode');
        expect([...notice.querySelectorAll('button')].map((b) => b.textContent)).toContain('Start normally');
        expect(sessionStorage.getItem(startupMode.MODE_FLAG_KEY)).toBeNull();
        expect(menu.map((m) => m.label)).toEqual([startupMode.MENU_LABELS.safe, startupMode.MENU_LABELS.debug]);
    });
});

describe('normal and debug start', () => {
    test('with no flag the feature layer is wired and there is no notice', async () => {
        await import('./entrypoint.js');
        expect(calls.replaceFeatures).toBe(1);
        expect(calls.wsInstall).toBe(1);
        expect(document.getElementById('toolasha-startup-mode-notice')).toBeNull();
        expect(menu).toHaveLength(2);
    });

    test('debug start wires features too, shows the notice and adds the download command', async () => {
        sessionStorage.setItem(startupMode.MODE_FLAG_KEY, 'debug');
        await import('./entrypoint.js');
        expect(calls.replaceFeatures).toBe(1);
        expect(document.getElementById('toolasha-startup-mode-notice').textContent).toContain('startup log');
        expect(menu.map((m) => m.label)).toContain(startupMode.MENU_LABELS.download);
    });
});
