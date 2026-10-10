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

const calls = {
    wsInstall: 0,
    replaceFeatures: 0,
    domObserverStart: 0,
    storageInit: 0,
    initializeFeatures: 0,
    errorLogInstall: 0,
    claimPage: 0,
    addStyles: 0,
    viewport: 0,
};
let menu;

/** The performance monitor stub; reset per test */
let perf;

function installLibraries() {
    perf = { enabled: false, mark: () => {}, startStallWatch: () => {} };
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
            performanceMonitor: perf,
            marketAPI: { fetch: async () => null, startAutoRefresh: () => {} },
            settingsMirror: { startMirroring: () => {} },
            storagePersistence: {},
            errorLog: {
                install: () => {
                    calls.errorLogInstall += 1;
                    return true;
                },
                getEntries: () => [],
            },
            dualInstallGuard: {
                claimPage: () => {
                    calls.claimPage += 1;
                    return false;
                },
            },
            startupMode,
        },
        Utils: {
            dom: {
                setupScrollTooltipDismissal: () => {},
                addStyles: () => {
                    calls.addStyles += 1;
                },
            },
            visualViewport: {
                initVisualViewportTracking: () => {
                    calls.viewport += 1;
                },
            },
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
        // No page hook of any kind before the notice: error capture, page claim, styles, viewport
        expect(calls.errorLogInstall).toBe(0);
        expect(calls.claimPage).toBe(0);
        expect(calls.addStyles).toBe(0);
        expect(calls.viewport).toBe(0);
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
        // Measurements recorded, so stalls carry suspects and recent events
        expect(perf.enabled).toBe(true);
    });
});
