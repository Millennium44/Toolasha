// @vitest-environment happy-dom

/**
 * Labyrinth grid scale: runs against the real config singleton (only its storage is mocked) so the
 * slider value goes through the same setSettingValue / change-callback path the settings panel uses.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: { tryGet: async () => ({ found: false }), set: () => {}, isRestorePending: () => false },
}));
vi.mock('../../core/websocket.js', () => ({
    default: { on: vi.fn(), off: vi.fn(), onSocketEvent: vi.fn(), offSocketEvent: vi.fn() },
}));
vi.mock('../../core/settings-storage.js', () => ({
    default: {
        SAVE_ALL_KEYS: Symbol('saveAll'),
        saveSettings: vi.fn(() => Promise.resolve()),
        saveSettingsKeepingStored: vi.fn(() => Promise.resolve(true)),
        loadSettings: vi.fn(() => Promise.resolve({})),
        buildDefaults: vi.fn(() => ({})),
        setCharacterId: vi.fn(),
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterName: () => 'T',
        getCurrentCharacterId: () => 'c1',
        rememberAutoReloadPreference: () => {},
    },
}));

const observer = vi.hoisted(() => ({ unregister: vi.fn() }));
vi.mock('../../core/dom-observer.js', () => ({
    default: { onClass: vi.fn(() => observer.unregister) },
}));

const { default: config } = await import('../../core/config.js');
const { default: domObserver } = await import('../../core/dom-observer.js');
const { initialize, cleanup, injectControl, normalizeScale } = await import('./labyrinth-grid-scale.js');

function renderHeader() {
    document.body.innerHTML = `
        <div class="LabyrinthPanel_chargeLeft__x">
            <div>6 Max Path <button class="Button_button__abc Button_small__def">Upgrade</button></div>
        </div>`;
    return document.querySelector('[class*="LabyrinthPanel_chargeLeft"]');
}

const styleText = () => document.getElementById('mwi-labyrinth-grid-scale-style')?.textContent ?? null;

beforeEach(() => {
    config.settingsMap = {
        labyrinthGridScale: { id: 'labyrinthGridScale', type: 'slider', value: 1 },
        labyrinthGridScaleControl: { id: 'labyrinthGridScaleControl', type: 'checkbox', isTrue: true },
    };
    config.settingChangeCallbacks = {};
    config.characterSettingsLoaded = true;
    domObserver.onClass.mockClear();
    observer.unregister.mockClear();
    document.head.innerHTML = '';
});

afterEach(() => {
    cleanup();
    document.body.innerHTML = '';
});

describe('normalizeScale', () => {
    test('snaps to quarter steps within 1x-2x', () => {
        expect(normalizeScale(1.3)).toBe(1.25);
        expect(normalizeScale('1.5')).toBe(1.5);
        expect(normalizeScale(0.5)).toBe(1);
        expect(normalizeScale(3)).toBe(2);
    });

    test('falls back to 1x for unusable values', () => {
        expect(normalizeScale(undefined)).toBe(1);
        expect(normalizeScale('abc')).toBe(1);
    });
});

describe('labyrinth grid scale', () => {
    test('injects one stepper per header and reuses the native button classes', () => {
        const header = renderHeader();
        injectControl(header);
        injectControl(header);

        expect(header.querySelectorAll('.mwi-labyrinth-grid-scale')).toHaveLength(1);
        expect(header.querySelector('[data-role="larger"]').className).toBe('Button_button__abc Button_small__def');
    });

    test('plus and minus step the scale, persist it in the setting and apply zoom', () => {
        const header = renderHeader();
        initialize();
        const larger = header.querySelector('[data-role="larger"]');
        const smaller = header.querySelector('[data-role="smaller"]');

        expect(smaller.disabled).toBe(true);
        expect(styleText()).toBeNull();

        larger.click();
        expect(config.getSettingValue('labyrinthGridScale')).toBe(1.25);
        expect(header.querySelector('[data-role="value"]').textContent).toBe('125%');
        expect(styleText()).toContain('zoom: 1.25');

        larger.click();
        larger.click();
        larger.click();
        expect(config.getSettingValue('labyrinthGridScale')).toBe(2);
        expect(larger.disabled).toBe(true);

        smaller.click();
        expect(config.getSettingValue('labyrinthGridScale')).toBe(1.75);
    });

    test('the settings-panel slider moves the grid and the stepper readout', () => {
        const header = renderHeader();
        initialize();

        config.setSettingValue('labyrinthGridScale', 1.5);

        expect(styleText()).toContain('zoom: 1.5');
        expect(header.querySelector('[data-role="value"]').textContent).toBe('150%');
    });

    test('a saved scale is applied on initialize', () => {
        config.settingsMap.labyrinthGridScale.value = 1.5;
        initialize();

        expect(styleText()).toContain('zoom: 1.5');
    });

    test('with the control off the saved scale still applies but no stepper is drawn', () => {
        config.settingsMap.labyrinthGridScaleControl.isTrue = false;
        config.settingsMap.labyrinthGridScale.value = 1.5;
        renderHeader();
        initialize();

        expect(domObserver.onClass).not.toHaveBeenCalled();
        expect(document.querySelector('.mwi-labyrinth-grid-scale')).toBeNull();
        expect(styleText()).toContain('zoom: 1.5');
    });

    test('switching the control off removes the stepper and switching it on draws it', () => {
        renderHeader();
        initialize();
        expect(document.querySelector('.mwi-labyrinth-grid-scale')).not.toBeNull();

        config.setSetting('labyrinthGridScaleControl', false);
        expect(document.querySelector('.mwi-labyrinth-grid-scale')).toBeNull();
        expect(observer.unregister).toHaveBeenCalledTimes(1);

        config.setSetting('labyrinthGridScaleControl', true);
        expect(document.querySelector('.mwi-labyrinth-grid-scale')).not.toBeNull();
    });

    test('cleanup restores the grid: no stepper, no style, no listeners, observer released', () => {
        config.settingsMap.labyrinthGridScale.value = 1.5;
        renderHeader();
        initialize();
        cleanup();

        expect(document.querySelector('.mwi-labyrinth-grid-scale')).toBeNull();
        expect(styleText()).toBeNull();
        expect(observer.unregister).toHaveBeenCalledTimes(1);
        expect(config.settingChangeCallbacks.labyrinthGridScale).toHaveLength(0);
        expect(config.settingChangeCallbacks.labyrinthGridScaleControl).toHaveLength(0);

        // A later slider change no longer touches the page
        config.setSettingValue('labyrinthGridScale', 2);
        expect(styleText()).toBeNull();
    });

    test('re-initializing does not stack listeners', () => {
        initialize();
        initialize();

        expect(config.settingChangeCallbacks.labyrinthGridScale).toHaveLength(1);
        expect(config.settingChangeCallbacks.labyrinthGridScaleControl).toHaveLength(1);
    });
});
