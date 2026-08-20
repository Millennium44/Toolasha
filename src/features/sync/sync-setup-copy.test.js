import { describe, test, expect, beforeEach, vi } from 'vitest';

const settings = vi.hoisted(() => ({
    map: {},
    values: {},
}));

vi.mock('../../core/config.js', () => ({
    default: {
        get settingsMap() {
            return settings.map;
        },
        getSetting: (key, fallback = false) => settings.values[key] ?? fallback,
    },
}));

const character = vi.hoisted(() => ({ id: 'char-A', name: 'Main' }));
vi.mock('../../core/data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => character.id,
        getCurrentCharacterName: () => character.name,
    },
}));

// The real settings-storage runs against this fake IndexedDB, so the merge
// under test is the one that ships rather than a restatement of it.
const stored = vi.hoisted(() => ({ map: {} }));
vi.mock('../../core/storage.js', () => ({
    default: {
        get: async (key, _store, fallback = null) => stored.map[key] ?? fallback,
        set: async (key, value) => {
            stored.map[key] = value;
        },
        tryGet: async (key) => ({ found: key in stored.map, value: stored.map[key] }),
        getJSON: async (key, _store, fallback = null) => stored.map[key] ?? fallback,
        setJSON: async (key, value) => {
            stored.map[key] = value;
        },
        delete: async (key) => {
            delete stored.map[key];
        },
    },
}));

const toasts = vi.hoisted(() => []);
vi.mock('../../utils/toast.js', () => ({
    showToast: (message, options) => {
        toasts.push({ message, ...options });
        return null;
    },
}));

const { copySyncSetupToOtherCharacters, SYNC_SETTING_IDS, syncSetupEntries } = await import('./sync-setup-copy.js');
const { default: settingsStorage } = await import('../../core/settings-storage.js');

const KEY = 'script_settingsMap';

/** A configured sync section on the current character */
function configureHere() {
    settings.values = { sync_enabled: true, sync_token: 'ghp_secret' };
    settings.map = {
        sync_enabled: { id: 'sync_enabled', type: 'checkbox', isTrue: true },
        sync_token: { id: 'sync_token', type: 'password', value: 'ghp_secret' },
        sync_passphrase: { id: 'sync_passphrase', type: 'password', value: 'hunter2' },
        sync_scope: { id: 'sync_scope', type: 'select', value: 'everything' },
        sync_onSwitch: { id: 'sync_onSwitch', type: 'checkbox', isTrue: true },
        sync_auto: { id: 'sync_auto', type: 'checkbox', isTrue: true },
        // Not part of the sync group, so it must not travel
        showTooltips: { id: 'showTooltips', type: 'checkbox', isTrue: true },
    };
}

/**
 * Register other characters on this device, with settings of their own.
 * @param {Array<{id: string, name: string, saved?: Object}>} entries - The alts
 */
function otherCharacters(entries) {
    stored.map.known_character_ids = [{ id: 'char-A', name: 'Main' }, ...entries.map(({ id, name }) => ({ id, name }))];
    for (const { id, saved } of entries) {
        if (saved) stored.map[`${KEY}_${id}`] = saved;
    }
}

beforeEach(() => {
    stored.map = {};
    toasts.length = 0;
    settings.map = {};
    settings.values = {};
    character.id = 'char-A';
    character.name = 'Main';
    settingsStorage.setCharacterId('char-A', 'Main');
});

describe('copySyncSetupToOtherCharacters', () => {
    test('the ids it copies are exactly the schema sync group', () => {
        expect(SYNC_SETTING_IDS).toEqual([
            'sync_enabled',
            'sync_token',
            'sync_passphrase',
            'sync_scope',
            'sync_onSwitch',
            'sync_auto',
        ]);
    });

    test('copies the sync setup to both other characters', async () => {
        configureHere();
        otherCharacters([
            { id: 'char-B', name: 'Cow', saved: { showTooltips: { id: 'showTooltips', isTrue: false } } },
            { id: 'char-C', name: 'Alt', saved: { showTooltips: { id: 'showTooltips', isTrue: true } } },
        ]);

        const result = await copySyncSetupToOtherCharacters();

        expect(result.ok).toBe(true);
        expect(result.copied).toBe(2);
        for (const id of ['char-B', 'char-C']) {
            const map = stored.map[`${KEY}_${id}`];
            expect(map.sync_token.value).toBe('ghp_secret');
            expect(map.sync_passphrase.value).toBe('hunter2');
            expect(map.sync_scope.value).toBe('everything');
            expect(map.sync_enabled.isTrue).toBe(true);
            expect(map.sync_auto.isTrue).toBe(true);
            expect(map.sync_onSwitch.isTrue).toBe(true);
        }
        // Their own unrelated settings are untouched, and ours never travelled
        expect(stored.map[`${KEY}_char-B`].showTooltips.isTrue).toBe(false);
        expect(stored.map[`${KEY}_char-C`].showTooltips.isTrue).toBe(true);
        expect(toasts[0].message).toContain('2 characters');
        expect(toasts[0].kind).toBeUndefined();
    });

    test('leaves the current character alone', async () => {
        configureHere();
        otherCharacters([
            { id: 'char-B', name: 'Cow', saved: { showTooltips: { id: 'showTooltips', isTrue: false } } },
        ]);
        stored.map[`${KEY}_char-A`] = { marker: true };

        await copySyncSetupToOtherCharacters();

        expect(stored.map[`${KEY}_char-A`]).toEqual({ marker: true });
    });

    test('refuses when sync is not configured here, and writes nothing', async () => {
        settings.values = { sync_enabled: true, sync_token: '   ' };
        settings.map = { sync_token: { id: 'sync_token', value: '   ' } };
        otherCharacters([
            { id: 'char-B', name: 'Cow', saved: { showTooltips: { id: 'showTooltips', isTrue: false } } },
        ]);

        const result = await copySyncSetupToOtherCharacters();

        expect(result.ok).toBe(false);
        expect(result.copied).toBe(0);
        expect(stored.map[`${KEY}_char-B`]).toEqual({ showTooltips: { id: 'showTooltips', isTrue: false } });
        expect(toasts[0].kind).toBe('warn');
        expect(toasts[0].message).toContain('GitHub token');
    });

    test('refuses when sync is switched off here', async () => {
        configureHere();
        settings.values.sync_enabled = false;
        otherCharacters([
            { id: 'char-B', name: 'Cow', saved: { showTooltips: { id: 'showTooltips', isTrue: false } } },
        ]);

        const result = await copySyncSetupToOtherCharacters();

        expect(result.ok).toBe(false);
        expect(stored.map[`${KEY}_char-B`].sync_token).toBeUndefined();
    });

    test('says so when this device knows no other character', async () => {
        configureHere();
        stored.map.known_character_ids = [{ id: 'char-A', name: 'Main' }];

        const result = await copySyncSetupToOtherCharacters();

        expect(result).toMatchObject({ ok: false, copied: 0 });
        expect(toasts[0].message).toBe('No other characters found on this device.');
    });

    test('skips, and names, a character with no settings saved yet', async () => {
        configureHere();
        otherCharacters([{ id: 'char-B', name: 'Cow' }]);

        const result = await copySyncSetupToOtherCharacters();

        expect(result.ok).toBe(false);
        expect(result.skipped).toEqual(['Cow']);
        // No half-map is seeded, which would read as a foreign settings map later
        expect(stored.map[`${KEY}_char-B`]).toBeUndefined();
        expect(toasts[0].message).toContain('Cow');
    });

    test('only the sync group is gathered', () => {
        configureHere();
        expect(Object.keys(syncSetupEntries())).toEqual(SYNC_SETTING_IDS);
    });

    test('a storage failure is reported, not thrown', async () => {
        configureHere();
        otherCharacters([
            { id: 'char-B', name: 'Cow', saved: { showTooltips: { id: 'showTooltips', isTrue: false } } },
        ]);
        const spy = vi
            .spyOn(settingsStorage, 'copySettingEntriesToOtherCharacters')
            .mockRejectedValue(new Error('nope'));
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = await copySyncSetupToOtherCharacters();

        expect(result.ok).toBe(false);
        expect(toasts[0].kind).toBe('error');
        spy.mockRestore();
        errors.mockRestore();
    });
});
