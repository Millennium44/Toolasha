/**
 * The Cross-Device Sync group is stored per account, not per character.
 *
 * What these pin: nobody loses a value, a disagreement resolves by the
 * documented rule rather than by chance, the carry-over does not record itself
 * as done when the write was refused, and running it twice changes nothing.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stored = new Map();
/** When set, every read answers "could not be made" and every write is refused */
const outage = { on: false };
/** When set, only writes to these keys are refused */
const refuse = new Set();

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn((key, _area, defaultValue) =>
            Promise.resolve(outage.on ? defaultValue : (stored.get(`json:${key}`) ?? defaultValue))
        ),
        parseJSON: vi.fn((raw, _key, defaultValue) => (raw == null ? defaultValue : raw)),
        setJSON: vi.fn((key, value) => {
            if (outage.on || refuse.has(key)) return Promise.resolve(false);
            stored.set(`json:${key}`, value);
            return Promise.resolve(true);
        }),
        get: vi.fn((key, _area, defaultValue) =>
            Promise.resolve(outage.on ? defaultValue : (stored.get(key) ?? defaultValue))
        ),
        tryGet: vi.fn((key) => {
            if (outage.on) return Promise.resolve(null);
            const value = stored.get(`json:${key}`) ?? stored.get(key);
            return Promise.resolve(value != null ? { found: true, value } : { found: false, value: null });
        }),
        set: vi.fn((key, value) => {
            if (outage.on || refuse.has(key)) return Promise.resolve(false);
            stored.set(key, value);
            return Promise.resolve(true);
        }),
        delete: vi.fn((key) => {
            stored.delete(`json:${key}`);
            stored.delete(key);
            return Promise.resolve(true);
        }),
        getAll: vi.fn(() => Promise.resolve({})),
        tryGetAllKeys: vi.fn(() =>
            Promise.resolve(
                outage.on ? null : [...stored.keys()].map((key) => (key.startsWith('json:') ? key.slice(5) : key))
            )
        ),
    },
}));

vi.mock('./data-manager.js', () => ({
    default: {
        getCurrentCharacterId: () => 'alice',
        getCurrentCharacterName: () => 'Alice',
    },
}));

const { default: settingsStorage } = await import('./settings-storage.js');

const SHARED_KEY = 'script_settingsMap_shared';
const FLAG_KEY = 'settings_shared_scope_v1';
const CONFLICT_KEY = 'settings_shared_scope_conflicts';

/** Write a character's stored settings map */
function putMap(characterId, map) {
    stored.set(`json:script_settingsMap_${characterId}`, map);
}

/** A stored token entry */
function token(value) {
    return { id: 'sync_token', type: 'password', value };
}

function on(id) {
    return { id, type: 'checkbox', isTrue: true };
}

beforeEach(() => {
    stored.clear();
    refuse.clear();
    outage.on = false;
    settingsStorage.currentCharacterId = 'alice';
    settingsStorage.currentCharacterName = 'Alice';
    stored.set('json:known_character_ids', [
        { id: 'alice', name: 'Alice' },
        { id: 'bob', name: 'Bob' },
    ]);
});

describe('the sync group is account-wide', () => {
    test('every setting in the Cross-Device Sync group is shared, and nothing else is', () => {
        const ids = settingsStorage.sharedSettingIds();
        expect(ids).toEqual([
            'sync_enabled',
            'sync_token',
            'sync_passphrase',
            'sync_scope',
            'sync_onSwitch',
            'sync_auto',
        ]);
        // The debatable groups deliberately stayed per character
        expect(ids).not.toContain('color_profit');
        expect(ids).not.toContain('formatting_useKMBFormat');
        expect(ids).not.toContain('notifications_quietHoursEnabled');
    });

    test('a token stored on one character is the one every character loads', async () => {
        putMap('bob', { sync_token: token('ghp_bob'), sync_enabled: on('sync_enabled') });
        putMap('alice', { networth: on('networth') });

        const settings = await settingsStorage.loadSettings();

        expect(settings.sync_token.value).toBe('ghp_bob');
        expect(settings.sync_enabled.isTrue).toBe(true);
        // Bob's own map is untouched — nothing was moved, only copied
        expect(stored.get('json:script_settingsMap_bob').sync_token.value).toBe('ghp_bob');
    });

    test('a token a character never had does not arrive from nowhere', async () => {
        putMap('alice', { networth: on('networth') });
        const settings = await settingsStorage.loadSettings();
        expect(settings.sync_token.value).toBe('');
    });

    test('an untouched default never outvotes a real value', async () => {
        putMap('alice', { sync_token: token('') });
        putMap('bob', { sync_token: token('ghp_bob') });

        const settings = await settingsStorage.loadSettings();

        expect(settings.sync_token.value).toBe('ghp_bob');
        expect(stored.get(`json:${CONFLICT_KEY}`)).toBeUndefined();
    });
});

describe('the conflict rule', () => {
    test('two characters disagreeing resolve to the one in session, visibly', async () => {
        putMap('alice', { sync_token: token('ghp_alice') });
        putMap('bob', { sync_token: token('ghp_bob') });

        const settings = await settingsStorage.loadSettings();

        expect(settings.sync_token.value).toBe('ghp_alice');

        const record = await settingsStorage.sharedScopeConflicts();
        expect(record.conflicts).toHaveLength(1);
        expect(record.conflicts[0]).toMatchObject({ id: 'sync_token', resolved: true, winner: 'Alice' });
        expect(record.conflicts[0].characters).toEqual(expect.arrayContaining(['Alice', 'Bob']));

        // The loser's value is still there to go back to
        expect(stored.get('json:script_settingsMap_bob').sync_token.value).toBe('ghp_bob');
    });

    test('a disagreement the character in session has no stake in is left alone and reported', async () => {
        putMap('alice', { networth: on('networth') });
        putMap('bob', { sync_token: token('ghp_bob') });
        putMap('carol', { sync_token: token('ghp_carol') });
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
            { id: 'carol', name: 'Carol' },
        ]);

        const settings = await settingsStorage.loadSettings();

        // Nothing decided: this character keeps what it had, which is nothing
        expect(settings.sync_token.value).toBe('');
        expect(stored.get(`json:${SHARED_KEY}`)?.sync_token).toBeUndefined();

        const record = await settingsStorage.sharedScopeConflicts();
        expect(record.conflicts[0]).toMatchObject({ id: 'sync_token', resolved: false, winner: null });

        // And both values survive
        expect(stored.get('json:script_settingsMap_bob').sync_token.value).toBe('ghp_bob');
        expect(stored.get('json:script_settingsMap_carol').sync_token.value).toBe('ghp_carol');
    });
});

describe('the carry-over records itself only when it worked', () => {
    test('a refused shared write leaves the flag unset and retries next load', async () => {
        putMap('bob', { sync_token: token('ghp_bob') });
        refuse.add(SHARED_KEY);

        await settingsStorage.loadSettings();

        expect(stored.get(FLAG_KEY)).toBeUndefined();
        expect(stored.get(`json:${SHARED_KEY}`)).toBeUndefined();

        refuse.clear();
        const settings = await settingsStorage.loadSettings();
        expect(settings.sync_token.value).toBe('ghp_bob');
        expect(stored.get(FLAG_KEY)).toBe(true);
    });

    test('a listing that could not be made decides nothing', async () => {
        putMap('bob', { sync_token: token('ghp_bob') });
        await settingsStorage.migrateSharedSettings('script_settingsMap_alice');
        expect(stored.get(FLAG_KEY)).toBe(true);

        // ...and with the store unreadable, it declines rather than writing
        stored.delete(FLAG_KEY);
        stored.delete(`json:${SHARED_KEY}`);
        outage.on = true;
        await settingsStorage.migrateSharedSettings('script_settingsMap_alice');
        outage.on = false;
        expect(stored.get(FLAG_KEY)).toBeUndefined();
    });

    test('running it again changes nothing, and never reconsiders a settled id', async () => {
        putMap('bob', { sync_token: token('ghp_bob') });
        await settingsStorage.loadSettings();
        expect(stored.get(`json:${SHARED_KEY}`).sync_token.value).toBe('ghp_bob');

        // The player picks a new token; a re-run must not undo that
        stored.set(`json:${SHARED_KEY}`, { sync_token: token('ghp_new') });
        stored.delete(FLAG_KEY);
        await settingsStorage.migrateSharedSettings('script_settingsMap_alice');

        expect(stored.get(`json:${SHARED_KEY}`).sync_token.value).toBe('ghp_new');
        const settings = await settingsStorage.loadSettings();
        expect(settings.sync_token.value).toBe('ghp_new');
    });
});

describe('saving an account-wide setting', () => {
    test('a scoped save writes it where every character reads it', async () => {
        putMap('alice', { networth: on('networth') });
        const settings = await settingsStorage.loadSettings();
        settings.sync_token.value = 'ghp_typed';

        await settingsStorage.saveSettings(settings, ['sync_token']);

        expect(stored.get(`json:${SHARED_KEY}`).sync_token.value).toBe('ghp_typed');

        // Now Bob loads: same token, without anyone pasting it again
        settingsStorage.currentCharacterId = 'bob';
        const bobSettings = await settingsStorage.loadSettings();
        expect(bobSettings.sync_token.value).toBe('ghp_typed');
    });

    test('a save that did not touch a shared id leaves the shared map alone', async () => {
        stored.set(`json:${SHARED_KEY}`, { sync_token: token('ghp_kept') });
        stored.set(FLAG_KEY, true);
        putMap('alice', { networth: on('networth') });

        const settings = await settingsStorage.loadSettings();
        settings.sync_token.value = 'stale-in-memory';
        await settingsStorage.saveSettings(settings, ['networth']);

        expect(stored.get(`json:${SHARED_KEY}`).sync_token.value).toBe('ghp_kept');
    });
});
