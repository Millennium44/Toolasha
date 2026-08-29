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

const settingsStorageMock = vi.hoisted(() => ({
    lastLoadReadable: true,
    saveSettings: vi.fn(() => Promise.resolve()),
    saveSettingsKeepingStored: vi.fn(() => Promise.resolve(true)),
    loadSettings: vi.fn(() => Promise.resolve({})),
    buildDefaults: vi.fn(() => ({})),
    setCharacterId: vi.fn(),
}));

const dataManagerMock = vi.hoisted(() => ({
    characterId: 'char-1',
    getCurrentCharacterName: () => 'TestChar',
    getCurrentCharacterId: () => dataManagerMock.characterId,
}));

vi.mock('./settings-storage.js', () => ({ default: settingsStorageMock }));

vi.mock('./data-manager.js', () => ({ default: dataManagerMock }));

const { default: config } = await import('./config.js');
const { settingsGroups } = await import('./settings-schema.js');

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

    test('falls back to the schema default for a setting that has not loaded yet', () => {
        // Nothing is in settingsMap for these, so the answer has to come from
        // the flattened schema-default map rather than from stored settings.
        config.settingsMap = {};

        for (const group of Object.values(settingsGroups)) {
            for (const [key, setting] of Object.entries(group.settings || {})) {
                if (setting.default === undefined || setting.default === null) continue;
                expect(config.getSetting(key)).toEqual(setting.default);
            }
        }
    });

    test('a key absent from the schema still returns the caller default', () => {
        config.settingsMap = {};
        expect(config.getSetting('no_such_setting_anywhere', 'sentinel')).toBe('sentinel');
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

describe('Config.onSettingsLoaded', () => {
    beforeEach(() => {
        config.settingsLoadedCallbacks = [];
        config.settingsMap = {};
    });

    test('fires after loadSettings repopulates the map, even when the previous map was empty', async () => {
        // The character-switch case: the cache is cleared (previous map empty), so
        // no per-key change callback fires — this channel is the only resync signal.
        const cb = vi.fn();
        config.onSettingsLoaded(cb);

        await config.loadSettings('char-1');

        expect(cb).toHaveBeenCalledTimes(1);
    });

    test('offSettingsLoaded unsubscribes', async () => {
        const cb = vi.fn();
        config.onSettingsLoaded(cb);
        config.offSettingsLoaded(cb);

        await config.loadSettings('char-1');

        expect(cb).not.toHaveBeenCalled();
    });

    test('a throwing callback does not stop the others', async () => {
        const boom = vi.fn(() => {
            throw new Error('nope');
        });
        const after = vi.fn();
        config.onSettingsLoaded(boom);
        config.onSettingsLoaded(after);
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

        await config.loadSettings('char-1');

        expect(after).toHaveBeenCalledTimes(1);
        spy.mockRestore();
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

describe('Config and a settings store that cannot be read', () => {
    const userMap = () => ({ checkbox: { id: 'checkbox', type: 'checkbox', isTrue: true } });
    const defaultMap = () => ({ checkbox: { id: 'checkbox', type: 'checkbox', isTrue: false } });

    beforeEach(() => {
        config.settingsMap = {};
        config.settingsOwner = null;
        config.characterSettingsLoaded = false;
        config.settingChangeCallbacks = {};
        config.settingsLoadedCallbacks = [];
        dataManagerMock.characterId = 'char-1';
        settingsStorageMock.lastLoadReadable = true;
        settingsStorageMock.loadSettings
            .mockReset()
            .mockImplementation(async () => (settingsStorageMock.lastLoadReadable ? userMap() : defaultMap()));
        settingsStorageMock.saveSettings.mockClear();
        settingsStorageMock.saveSettingsKeepingStored.mockClear();
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });

    test('a readable load is the settings, and saves write the map whole', async () => {
        await config.loadSettings();
        expect(config.characterSettingsLoaded).toBe(true);
        expect(config.getSetting('checkbox')).toBe(true);

        config.setSetting('checkbox', false);
        expect(settingsStorageMock.saveSettings).toHaveBeenCalledTimes(1);
        expect(settingsStorageMock.saveSettingsKeepingStored).not.toHaveBeenCalled();
    });

    test('a load that cannot be made keeps the settings in hand for the same character', async () => {
        await config.loadSettings();
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(true);
        expect(config.characterSettingsLoaded).toBe(true);
    });

    test("but not another character's, which gives way to defaults that do not count as loaded", async () => {
        await config.loadSettings();
        dataManagerMock.characterId = 'char-2';
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(false);
        expect(config.characterSettingsLoaded).toBe(false);
    });

    test('a save from defaults that stood in for unread settings goes through the merge-save, never whole', async () => {
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();
        config.setSetting('checkbox', true);

        expect(settingsStorageMock.saveSettings).not.toHaveBeenCalled();
        expect(settingsStorageMock.saveSettingsKeepingStored).toHaveBeenCalledTimes(1);
        expect(settingsStorageMock.saveSettingsKeepingStored.mock.calls[0][0].checkbox.isTrue).toBe(true);
    });

    test('once the settings are read back, saves write the map whole again', async () => {
        settingsStorageMock.lastLoadReadable = false;
        await config.loadSettings();
        settingsStorageMock.lastLoadReadable = true;
        await config.loadSettings();

        expect(config.getSetting('checkbox')).toBe(true);
        config.setSetting('checkbox', false);
        expect(settingsStorageMock.saveSettings).toHaveBeenCalledTimes(1);
    });

    test('before a character is known, the defaults are never written whole either', async () => {
        dataManagerMock.characterId = null;
        await config.loadSettings();
        config.settingsMap = defaultMap();
        config.setSetting('checkbox', true);
        expect(settingsStorageMock.saveSettings).not.toHaveBeenCalled();
        expect(settingsStorageMock.saveSettingsKeepingStored).toHaveBeenCalledTimes(1);
    });
});

describe('setting-change listener registration', () => {
    beforeEach(() => {
        config.settingsMap = { probe: { isTrue: false } };
        config.settingChangeCallbacks = {};
        settingsStorageMock.saveSettings.mockClear();
        settingsStorageMock.saveSettingsKeepingStored.mockClear();
    });

    // Every other subscribe in core (domObserver.register/onClass, onQuotaExceeded,
    // inventorySort.onModeChange) hands back an unregister function, and at least one
    // caller already assumed this one did too — custom-tabs-ui pushes the return value
    // onto its teardown list, where `undefined` is silently skipped. Its two setting
    // listeners survived every disable(), so a character switch left another pair
    // behind, each firing into a torn-down panel.
    test('onSettingChange hands back an unregister function', () => {
        const cb = vi.fn();
        const unregister = config.onSettingChange('probe', cb);

        expect(typeof unregister).toBe('function');
        unregister();
        config.setSetting('probe', true);

        expect(cb).not.toHaveBeenCalled();
    });

    test('unregistering one listener leaves the others subscribed', () => {
        const kept = vi.fn();
        const unregister = config.onSettingChange('probe', vi.fn());
        config.onSettingChange('probe', kept);

        unregister();
        config.setSetting('probe', true);

        expect(kept).toHaveBeenCalledWith(true);
    });

    test('unregistering twice is harmless', () => {
        const unregister = config.onSettingChange('probe', vi.fn());
        unregister();
        expect(() => unregister()).not.toThrow();
    });

    test('onSettingsLoaded hands back an unregister function too', () => {
        const cb = vi.fn();
        const unregister = config.onSettingsLoaded(cb);
        expect(typeof unregister).toBe('function');
        unregister();
        expect(config.settingsLoadedCallbacks).not.toContain(cb);
    });
});

describe('setting-change listener dispatch', () => {
    beforeEach(() => {
        config.settingsMap = { probe: { isTrue: false }, probeValue: { value: 1 } };
        config.settingChangeCallbacks = {};
        settingsStorageMock.saveSettings.mockClear();
        settingsStorageMock.saveSettingsKeepingStored.mockClear();
    });

    // The loop was unguarded, so one feature's listener throwing took out every
    // listener registered behind it for that key — and the throw escaped setSetting
    // into whichever toggle handler made the change, which then did not finish
    // either. Both dispatch sites in core that fan out to many subscribers
    // (domObserver, webSocketHook) already isolate each one.
    test('a throwing listener does not starve the ones behind it', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        config.onSettingChange('probe', () => {
            throw new Error('boom');
        });
        const second = vi.fn();
        config.onSettingChange('probe', second);

        expect(() => config.setSetting('probe', true)).not.toThrow();

        expect(second).toHaveBeenCalledWith(true);
        expect(spy).toHaveBeenCalled();
        spy.mockRestore();
    });

    test('setSettingValue isolates its listeners the same way', () => {
        const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
        config.onSettingChange('probeValue', () => {
            throw new Error('boom');
        });
        const second = vi.fn();
        config.onSettingChange('probeValue', second);

        expect(() => config.setSettingValue('probeValue', 7)).not.toThrow();

        expect(second).toHaveBeenCalledWith(7);
        spy.mockRestore();
    });

    test('a listener that unregisters another mid-dispatch does not skip it', () => {
        const third = vi.fn();
        const box = {};
        config.onSettingChange('probe', () => box.unregisterSecond());
        box.unregisterSecond = config.onSettingChange('probe', vi.fn());
        config.onSettingChange('probe', third);

        config.setSetting('probe', true);

        expect(third).toHaveBeenCalledWith(true);
    });
});
