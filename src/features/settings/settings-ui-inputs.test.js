/** @vitest-environment happy-dom */
import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('../../core/storage.js', () => ({
    default: { setJSON: vi.fn(async () => {}), getJSON: vi.fn(async () => null), get: vi.fn(async () => null) },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: vi.fn(() => 'char-1'), on: vi.fn() },
}));
vi.mock('../../core/settings-storage.js', () => ({
    default: { setSetting: vi.fn(async () => true) },
}));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: vi.fn(() => false),
        setSetting: vi.fn(),
        setSettingValue: vi.fn(),
        applyColorSettings: vi.fn(),
        onSettingChange: vi.fn(),
        offSettingChange: vi.fn(),
        settingsMap: {},
    },
}));

import settingsStorage from '../../core/settings-storage.js';
import config from '../../core/config.js';
import settingsUI, { clampToInputRange } from './settings-ui.js';

describe('number setting range clamping', () => {
    const def = { type: 'number', default: 5, min: 1, max: 100, step: 1 };
    let input;

    beforeEach(() => {
        vi.clearAllMocks();
        settingsUI.currentSettings = {};
        const inputHTML = settingsUI.generateSettingInput('someNumberSetting', def);
        document.body.innerHTML = `<div class="toolasha-setting" data-type="number">${inputHTML}</div>`;
        input = document.getElementById('someNumberSetting');
        settingsUI.config = config;
    });

    test('clampToInputRange applies whichever bounds are present', () => {
        expect(clampToInputRange(2000, '1', '100')).toBe(100);
        expect(clampToInputRange(-5, '1', '100')).toBe(1);
        expect(clampToInputRange(50, '1', '100')).toBe(50);
        expect(clampToInputRange(2000, '', '')).toBe(2000);
        expect(clampToInputRange(0, '1', '')).toBe(1);
        expect(clampToInputRange(2000, '', '100')).toBe(100);
    });

    test('a typed value above max is saved as max and the box is corrected', async () => {
        input.value = '2000';
        await settingsUI.handleSettingChange({ target: input });

        expect(settingsStorage.setSetting).toHaveBeenCalledWith('someNumberSetting', 100);
        expect(input.value).toBe('100');
    });

    test('a typed value below min (or empty) is saved as min', async () => {
        input.value = '0';
        await settingsUI.handleSettingChange({ target: input });
        expect(settingsStorage.setSetting).toHaveBeenLastCalledWith('someNumberSetting', 1);
        expect(input.value).toBe('1');

        input.value = '';
        await settingsUI.handleSettingChange({ target: input });
        expect(settingsStorage.setSetting).toHaveBeenLastCalledWith('someNumberSetting', 1);
    });

    test('an in-range value is saved unchanged', async () => {
        input.value = '25';
        await settingsUI.handleSettingChange({ target: input });
        expect(settingsStorage.setSetting).toHaveBeenCalledWith('someNumberSetting', 25);
        expect(input.value).toBe('25');
    });
});
