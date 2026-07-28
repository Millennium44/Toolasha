/**
 * Tests for Config setting accessors
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('./storage.js', () => ({
    default: {},
}));

vi.mock('./websocket.js', () => ({
    default: {
        on: vi.fn(),
        off: vi.fn(),
        onSocketEvent: vi.fn(),
        offSocketEvent: vi.fn(),
    },
}));

vi.mock('./settings-storage.js', () => ({
    default: {
        saveSettings: vi.fn(() => Promise.resolve()),
        loadSettings: vi.fn(() => Promise.resolve({})),
        buildDefaults: vi.fn(() => ({})),
    },
}));

const { default: config } = await import('./config.js');

describe('Config.getSetting', () => {
    beforeEach(() => {
        config.settingsMap = {
            checkboxOn: { id: 'checkboxOn', isTrue: true },
            checkboxOff: { id: 'checkboxOff', isTrue: false },
            pricingMode: { id: 'pricingMode', value: 'optimistic' },
            goldPerHour: { id: 'goldPerHour', value: 250000 },
            zeroNumber: { id: 'zeroNumber', value: 0 },
        };
    });

    test('returns booleans for checkbox settings', () => {
        expect(config.getSetting('checkboxOn')).toBe(true);
        expect(config.getSetting('checkboxOff')).toBe(false);
    });

    test('returns stored value for select settings instead of false', () => {
        expect(config.getSetting('pricingMode')).toBe('optimistic');
    });

    test('returns stored value for number settings, including 0', () => {
        expect(config.getSetting('goldPerHour')).toBe(250000);
        expect(config.getSetting('zeroNumber')).toBe(0);
    });

    test('returns provided default for unknown settings', () => {
        expect(config.getSetting('doesNotExist')).toBe(false);
        expect(config.getSetting('doesNotExist', 'fallback')).toBe('fallback');
    });
});

describe('Config.setSetting', () => {
    beforeEach(() => {
        config.settingsMap = {
            checkbox: { id: 'checkbox', isTrue: false },
            pricingMode: { id: 'pricingMode', value: 'hybrid' },
        };
        config.settingChangeCallbacks = {};
    });

    test('writes isTrue for checkbox settings', () => {
        config.setSetting('checkbox', true);
        expect(config.settingsMap.checkbox.isTrue).toBe(true);
        expect(config.getSetting('checkbox')).toBe(true);
    });

    test('writes value for select settings so the write round-trips', () => {
        config.setSetting('pricingMode', 'conservative');
        expect(config.settingsMap.pricingMode.value).toBe('conservative');
        expect(config.settingsMap.pricingMode.isTrue).toBeUndefined();
        expect(config.getSetting('pricingMode')).toBe('conservative');
        expect(config.getSettingValue('pricingMode')).toBe('conservative');
    });

    test('fires registered change callbacks', () => {
        const cb = vi.fn();
        config.onSettingChange('pricingMode', cb);
        config.setSetting('pricingMode', 'optimistic');
        expect(cb).toHaveBeenCalledWith('optimistic');
    });
});
