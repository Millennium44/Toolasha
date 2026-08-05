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

/**
 * Colors are interpolated straight into inline styles, so a name Config does not
 * define does not throw — it renders `color: undefined` and the browser drops the
 * declaration. The only way to catch that is to check the names.
 */
describe('Config — color constants', () => {
    const CSS_COLOR = /^(#[0-9a-f]{3,8}|rgba?\(.+\)|hsla?\(.+\)|[a-z]+)$/i;

    const colorMembers = [
        'COLOR_PROFIT',
        'COLOR_LOSS',
        'COLOR_WARNING',
        'COLOR_INFO',
        'COLOR_ESSENCE',
        'COLOR_TEXT_PRIMARY',
        'COLOR_TEXT_SECONDARY',
        'COLOR_BORDER',
        'COLOR_GOLD',
        'COLOR_ACCENT',
        'SCRIPT_COLOR_MAIN',
        'SCRIPT_COLOR_TOOLTIP',
        'SCRIPT_COLOR_ALERT',
    ];

    for (const member of colorMembers) {
        test(`${member} is a usable CSS color`, () => {
            expect(CSS_COLOR.test(String(config[member]).trim())).toBe(true);
        });
    }

    test('SCRIPT_COLOR_PRIMARY and SCRIPT_COLOR_SECONDARY are not defined', () => {
        expect(config.SCRIPT_COLOR_PRIMARY).toBeUndefined();
        expect(config.SCRIPT_COLOR_SECONDARY).toBeUndefined();
    });

    test('and nothing under src/ reads them', async () => {
        // A per-object assertion cannot catch a caller reintroducing the name,
        // which is exactly how the six broken call sites survived.
        const { readdirSync, readFileSync, statSync } = await import('fs');
        const { join, resolve, dirname } = await import('path');
        const { fileURLToPath } = await import('url');

        const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
        const files = [];
        const walk = (dir) => {
            for (const entry of readdirSync(dir)) {
                if (entry === 'node_modules') continue;
                const full = join(dir, entry);
                if (statSync(full).isDirectory()) walk(full);
                else if (entry.endsWith('.js') && !entry.endsWith('.test.js')) files.push(full);
            }
        };
        walk(srcDir);

        const violations = [];
        for (const file of files) {
            const content = readFileSync(file, 'utf8');
            for (const name of ['config.SCRIPT_COLOR_PRIMARY', 'config.SCRIPT_COLOR_SECONDARY']) {
                if (content.includes(name)) violations.push(`${file}: ${name}`);
            }
        }

        expect(violations).toEqual([]);
    });
});
