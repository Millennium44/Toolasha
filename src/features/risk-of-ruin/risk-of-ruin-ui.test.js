/* @vitest-environment happy-dom */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    settings: { riskOfRuin: true, riskOfRuin_showLauncher: true },
    settingChangeHandlers: {},
    /** `{ [panelKey]: boolean }` written by saveOpenState, read by reopenIfLeftOpen */
    openState: {},
    domObserverHandlers: [],
}));

vi.mock('../../core/config.js', () => ({
    default: {
        Z_FLOATING_PANEL: 1000,
        getSetting: vi.fn((key) => mocks.settings[key]),
        getSettingValue: vi.fn((_key, fallback) => fallback),
        setSetting: vi.fn((key, value) => {
            mocks.settings[key] = value;
            mocks.settingChangeHandlers[key]?.(value);
        }),
        onSettingChange: vi.fn((key, callback) => {
            mocks.settingChangeHandlers[key] = callback;
        }),
    },
}));

vi.mock('../../core/data-manager.js', () => ({
    default: {
        getInitClientData: vi.fn(() => ({ itemDetailMap: {} })),
        getItemDetails: vi.fn(() => null),
        getInventory: vi.fn(() => []),
    },
}));

vi.mock('../../core/dom-observer.js', () => ({
    default: {
        onClass: vi.fn((_name, _classes, callback) => {
            const handler = { callback };
            mocks.domObserverHandlers.push(handler);
            return () => {
                const index = mocks.domObserverHandlers.indexOf(handler);
                if (index > -1) mocks.domObserverHandlers.splice(index, 1);
            };
        }),
    },
}));

// Geometry and open state live in IndexedDB, which is never what these tests are
// about — but which panel was left open is, so that half is a real in-memory store.
vi.mock('../../utils/panel-geometry.js', () => ({
    clampPanelToViewport: vi.fn(() => null),
    restoreGeometry: vi.fn(async () => {}),
    saveGeometry: vi.fn(async () => {}),
    saveCollapsed: vi.fn(async () => {}),
    wasCollapsed: vi.fn(async () => false),
    savedSize: vi.fn(async () => null),
    saveOpenState: vi.fn(async (panelKey, open) => {
        mocks.openState[panelKey] = Boolean(open);
    }),
    wasOpen: vi.fn(async (panelKey) => Boolean(mocks.openState[panelKey])),
    reopenIfLeftOpen: vi.fn(async (panelKey, reopen) => {
        if (mocks.openState[panelKey]) reopen();
    }),
}));

const { PANEL_ID, LAUNCHER_ID, TAB_ID, PANEL_KEY } = vi.hoisted(() => ({
    PANEL_ID: 'mwi-risk-of-ruin-panel',
    LAUNCHER_ID: 'mwi-risk-of-ruin-launcher',
    TAB_ID: 'mwi-risk-of-ruin-tab',
    PANEL_KEY: 'riskOfRuin',
}));

import config from '../../core/config.js';
import { reopenIfLeftOpen } from '../../utils/panel-geometry.js';
import riskOfRuinUI from './risk-of-ruin-ui.js';

/** A stand-in for the character column's tab strip, found by its Inventory tab */
function buildTabStrip() {
    const list = document.createElement('div');
    list.setAttribute('role', 'tablist');
    list.className = 'MuiTabs-flexContainer';
    for (const name of ['Inventory', 'Equipment']) {
        const tab = document.createElement('button');
        tab.setAttribute('role', 'tab');
        tab.textContent = name;
        list.appendChild(tab);
    }
    document.body.appendChild(list);
    return list;
}

const panel = () => document.getElementById(PANEL_ID);
const isOpen = () => panel()?.style.display === 'flex';

describe('RiskOfRuinUI feature toggle', () => {
    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
    });

    afterEach(() => {
        riskOfRuinUI.disable();
    });

    test('registers a live setting listener for the riskOfRuin toggle at module load', () => {
        // setupSettingListener() runs once at module load (see the bottom of
        // risk-of-ruin-ui.js), before any test body executes, so by the time this test runs
        // the handler must already be registered - proving the toggle is wired up live, not
        // just read once at startup (which previously required a page refresh to take effect).
        expect(config.onSettingChange).toHaveBeenCalledWith('riskOfRuin', expect.any(Function));
        expect(mocks.settingChangeHandlers.riskOfRuin).toBeTypeOf('function');
    });

    test('initialize() is a no-op when the riskOfRuin setting is disabled', () => {
        mocks.settings.riskOfRuin = false;
        riskOfRuinUI.initialize();

        expect(document.getElementById(PANEL_ID)).toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
    });

    test('toggling the riskOfRuin setting off removes the panel and launcher with no refresh', () => {
        riskOfRuinUI.initialize();
        expect(document.getElementById(PANEL_ID)).not.toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();

        // Simulate the settings panel checkbox being unchecked.
        mocks.settingChangeHandlers.riskOfRuin(false);

        expect(document.getElementById(PANEL_ID)).toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
    });

    test('toggling the riskOfRuin setting back on rebuilds the panel and launcher', () => {
        riskOfRuinUI.initialize();
        mocks.settingChangeHandlers.riskOfRuin(false);
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();

        // Simulate the checkbox being re-checked - this is the live listener's other branch,
        // not feature-registry's own startup pass, which never re-runs mid-session.
        mocks.settings.riskOfRuin = true;
        mocks.settingChangeHandlers.riskOfRuin(true);

        expect(document.getElementById(PANEL_ID)).not.toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();
    });
});

describe('RiskOfRuinUI close and reopen', () => {
    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
    });

    afterEach(() => {
        riskOfRuinUI.disable();
    });

    test('the panel opens closed and its ✕ remembers that it was closed', () => {
        buildTabStrip();
        riskOfRuinUI.initialize();
        expect(isOpen()).toBe(false);

        document.getElementById(`${LAUNCHER_ID}-open`).click();
        expect(isOpen()).toBe(true);
        expect(mocks.openState[PANEL_KEY]).toBe(true);

        panel().querySelector('#mwi-ror-close').click();
        expect(isOpen()).toBe(false);
        expect(mocks.openState[PANEL_KEY]).toBe(false);
    });

    test('a panel left open reopens on the next load, and a closed one stays closed', () => {
        // Left open
        mocks.openState[PANEL_KEY] = true;
        riskOfRuinUI.initialize();
        expect(reopenIfLeftOpen).toHaveBeenCalledWith(PANEL_KEY, expect.any(Function));
        expect(isOpen()).toBe(true);

        // ...and the restore itself must not be mistaken for the user opening it
        riskOfRuinUI.disable();
        mocks.openState[PANEL_KEY] = false;
        riskOfRuinUI.initialize();
        expect(isOpen()).toBe(false);
    });

    test('the panel carries a minimize control that folds its body away', () => {
        riskOfRuinUI.initialize();
        document.getElementById(`${LAUNCHER_ID}-open`).click();

        const minimize = panel().querySelector('.toolasha-minimize-btn');
        expect(minimize).not.toBeNull();

        minimize.click();
        expect(panel().dataset.minimized).toBe('true');
        minimize.click();
        expect(panel().dataset.minimized).toBe('false');
    });

    test("the launcher's ✕ hides it through the setting, and the tab still opens the panel", () => {
        buildTabStrip();
        riskOfRuinUI.initialize();
        expect(document.getElementById(TAB_ID)).not.toBeNull();

        document.getElementById(`${LAUNCHER_ID}-close`).click();
        expect(config.setSetting).toHaveBeenCalledWith('riskOfRuin_showLauncher', false);
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();

        // The tab beside Inventory is the way back in
        document.getElementById(TAB_ID).click();
        expect(isOpen()).toBe(true);
    });

    test('a launcher turned off in settings is never drawn, and turning it back on redraws it', () => {
        mocks.settings.riskOfRuin_showLauncher = false;
        riskOfRuinUI.initialize();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();

        config.setSetting('riskOfRuin_showLauncher', true);
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();
    });

    test('the tab switch is put back when the game rebuilds the tab strip', () => {
        buildTabStrip();
        riskOfRuinUI.initialize();
        expect(document.getElementById(TAB_ID)).not.toBeNull();

        // The column changed view: the old strip goes, a new one arrives
        document.body.innerHTML = '';
        buildTabStrip();
        expect(document.getElementById(TAB_ID)).toBeNull();
        for (const handler of mocks.domObserverHandlers) handler.callback();
        expect(document.getElementById(TAB_ID)).not.toBeNull();
    });

    test('closing and reopening leaks no observer, drag listener or timer', () => {
        buildTabStrip();
        const documentAdd = vi.spyOn(document, 'addEventListener');

        for (let round = 0; round < 3; round += 1) {
            riskOfRuinUI.initialize();
            document.getElementById(`${LAUNCHER_ID}-open`).click();
            panel().querySelector('#mwi-ror-close').click();
            riskOfRuinUI.disable();
        }

        // One tab-strip watcher per initialize, all of them unregistered again
        expect(mocks.domObserverHandlers).toHaveLength(0);
        // Nothing is left on the page for the next round to double up on
        expect(document.getElementById(PANEL_ID)).toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
        expect(document.getElementById(TAB_ID)).toBeNull();
        // The drag is attached to the header, not to the document: a panel that
        // is only sitting still must not be holding document-level move handlers
        expect(documentAdd.mock.calls.filter(([type]) => type === 'pointermove')).toHaveLength(0);
        documentAdd.mockRestore();
    });
});

describe('RiskOfRuinUI tab against a twin from another module copy', () => {
    beforeEach(() => {
        mocks.settings = { riskOfRuin: true, riskOfRuin_showLauncher: true };
        mocks.openState = {};
        document.body.innerHTML = '';
        riskOfRuinUI.disable();
    });

    afterEach(() => {
        riskOfRuinUI.disable();
    });

    test('a strip already carrying our tab id is adopted, never given a second tab', () => {
        // Two bundles once both carried this singleton, and each injected its
        // own tab: live installs showed "Risk of Ruin" twice. A tab with our id
        // that is not ours is adopted instead of twinned.
        const list = buildTabStrip();
        const twin = document.createElement('button');
        twin.setAttribute('role', 'tab');
        twin.id = TAB_ID;
        twin.textContent = '⧉ Risk of Ruin';
        list.appendChild(twin);

        riskOfRuinUI.initialize();

        expect(document.querySelectorAll(`#${TAB_ID}`)).toHaveLength(1);
        expect(document.getElementById(TAB_ID)).toBe(twin);
    });
});
