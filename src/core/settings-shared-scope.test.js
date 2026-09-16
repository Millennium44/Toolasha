/**
 * Cross-device sync, the color palette, number formatting and quiet hours are
 * stored per device, not per character.
 *
 * What these pin: nobody loses a value, a disagreement resolves by the
 * documented rule rather than by chance, a palette everyone left on its
 * defaults is not 28 disagreements, the carry-over does not record itself as
 * done when the write was refused, and running it twice changes nothing.
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
const { settingsGroups } = await import('./settings-schema.js');

const SHARED_KEY = 'script_settingsMap_shared';
const FLAG_KEY = 'settings_shared_scope_v2';
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

describe('the shared scope is device-wide', () => {
    test('the shared scope is sync, colors, number formatting and quiet hours — and nothing else', () => {
        const ids = settingsStorage.sharedSettingIds();

        expect(ids).toEqual(
            expect.arrayContaining([
                'sync_enabled',
                'sync_token',
                'sync_passphrase',
                'sync_scope',
                'sync_onSwitch',
                'sync_auto',
            ])
        );
        expect(Object.keys(settingsGroups.colors.settings).every((id) => ids.includes(id))).toBe(true);
        expect(ids).toEqual(
            expect.arrayContaining([
                'formatting_useKMBFormat',
                'formatting_precision',
                'notifications_quietHoursEnabled',
                'notifications_quietHoursStart',
                'notifications_quietHoursEnd',
            ])
        );

        // The rest of the notifications group stays per character: a combat alt
        // wanting death alerts while a crafting alt does not is a real choice
        const perCharacterNotifications = Object.keys(settingsGroups.notifications.settings).filter(
            (id) => !id.startsWith('notifications_quietHours')
        );
        expect(perCharacterNotifications.length).toBeGreaterThan(0);
        for (const id of perCharacterNotifications) expect(ids).not.toContain(id);

        // No duplicates, and nothing the schema does not have
        expect(new Set(ids).size).toBe(ids.length);
        const known = new Set(Object.values(settingsGroups).flatMap((group) => Object.keys(group.settings ?? {})));
        for (const id of ids) expect(known.has(id)).toBe(true);
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

describe('colors, number formatting and quiet hours came along too', () => {
    /** A stored entry with a `.value` */
    function entry(id, type, value) {
        return { id, type, value };
    }

    test('a palette themed on one character is the one every character loads', async () => {
        putMap('bob', {
            color_profit: entry('color_profit', 'color', '#123456'),
            color_loss: entry('color_loss', 'color', '#abcdef'),
        });
        putMap('alice', { networth: on('networth') });

        const settings = await settingsStorage.loadSettings();

        expect(settings.color_profit.value).toBe('#123456');
        expect(settings.color_loss.value).toBe('#abcdef');
        // Copied, never moved
        expect(stored.get('json:script_settingsMap_bob').color_profit.value).toBe('#123456');
    });

    test('number formatting and quiet hours carry across as well', async () => {
        putMap('bob', {
            formatting_useKMBFormat: entry('formatting_useKMBFormat', 'select', 'full'),
            formatting_precision: entry('formatting_precision', 'number', 4),
            notifications_quietHoursEnabled: on('notifications_quietHoursEnabled'),
            notifications_quietHoursStart: entry('notifications_quietHoursStart', 'text', '21:30'),
        });
        putMap('alice', { networth: on('networth') });

        const settings = await settingsStorage.loadSettings();

        expect(settings.formatting_useKMBFormat.value).toBe('full');
        expect(settings.formatting_precision.value).toBe(4);
        expect(settings.notifications_quietHoursEnabled.isTrue).toBe(true);
        expect(settings.notifications_quietHoursStart.value).toBe('21:30');
    });

    test('the rest of the notifications group stays on the character that set it', async () => {
        const perCharacter = Object.keys(settingsGroups.notifications.settings).find(
            (id) => !id.startsWith('notifications_quietHours') && settingsGroups.notifications.settings[id].default
        );
        putMap('bob', { [perCharacter]: { id: perCharacter, type: 'checkbox', isTrue: false } });
        putMap('alice', { networth: on('networth') });

        await settingsStorage.loadSettings();

        expect(stored.get(`json:${SHARED_KEY}`)?.[perCharacter]).toBeUndefined();
    });

    test('characters all sitting on the stored defaults raise no conflicts at all', async () => {
        // Every character has a stored entry for all 28 swatches, because the
        // map is written whole — that must not read as 28 disagreements
        const palette = {};
        for (const [id, def] of Object.entries(settingsGroups.colors.settings)) {
            palette[id] = { id, type: 'color', value: def.default };
        }
        putMap('alice', { ...palette });
        putMap('bob', { ...palette });
        putMap('carol', { ...palette });
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
            { id: 'carol', name: 'Carol' },
        ]);

        await settingsStorage.loadSettings();

        expect(await settingsStorage.sharedScopeConflicts()).toBeNull();
        expect(stored.get(`json:${SHARED_KEY}`)).toBeUndefined();
        expect(stored.get(FLAG_KEY)).toBe(true);
    });

    test('a color spelt in the other case is the same color, not a disagreement', async () => {
        // The schema writes color_remaining_xp's default as #FFFFFF; a color
        // input hands back #ffffff. Two characters, same white.
        const id = 'color_remaining_xp';
        putMap('alice', { [id]: { id, type: 'color', value: '#FFFFFF' } });
        putMap('bob', { [id]: { id, type: 'color', value: '#ffffff' } });

        await settingsStorage.loadSettings();

        expect(await settingsStorage.sharedScopeConflicts()).toBeNull();
        expect(stored.get(`json:${SHARED_KEY}`)?.[id]).toBeUndefined();
    });

    test('one character customising and the others leaving defaults decides it silently', async () => {
        const stayed = {
            id: 'color_profit',
            type: 'color',
            value: settingsGroups.colors.settings.color_profit.default,
        };
        putMap('alice', { color_profit: stayed });
        putMap('bob', { color_profit: { id: 'color_profit', type: 'color', value: '#ff0000' } });

        const settings = await settingsStorage.loadSettings();

        expect(settings.color_profit.value).toBe('#ff0000');
        expect(await settingsStorage.sharedScopeConflicts()).toBeNull();
    });

    test('a device that already ran the sync carry-over picks the new groups up without redeciding sync', async () => {
        // The v1 flag is gone but the shared map already answers sync_token
        stored.set(`json:${SHARED_KEY}`, { sync_token: token('ghp_settled') });
        stored.set('settings_shared_scope_v1', true);
        putMap('alice', { sync_token: token('ghp_alice_old') });
        putMap('bob', { color_profit: { id: 'color_profit', type: 'color', value: '#00ff00' } });

        const settings = await settingsStorage.loadSettings();

        expect(settings.sync_token.value).toBe('ghp_settled');
        expect(settings.color_profit.value).toBe('#00ff00');
        expect(await settingsStorage.sharedScopeConflicts()).toBeNull();
    });

    test('a saved color reaches every character', async () => {
        putMap('alice', { networth: on('networth') });
        const settings = await settingsStorage.loadSettings();
        settings.color_gold.value = '#101010';

        await settingsStorage.saveSettings(settings, ['color_gold']);

        settingsStorage.currentCharacterId = 'bob';
        const bobSettings = await settingsStorage.loadSettings();
        expect(bobSettings.color_gold.value).toBe('#101010');
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

describe('a palette that genuinely disagrees', () => {
    test('two themed characters resolve to the one in session and are all reported once', async () => {
        const ids = Object.keys(settingsGroups.colors.settings).slice(0, 5);
        const paint = (value) => Object.fromEntries(ids.map((id) => [id, { id, type: 'color', value }]));
        putMap('alice', paint('#111111'));
        putMap('bob', paint('#222222'));

        const settings = await settingsStorage.loadSettings();

        for (const id of ids) expect(settings[id].value).toBe('#111111');

        const record = await settingsStorage.sharedScopeConflicts();
        expect(record.conflicts).toHaveLength(ids.length);
        expect(record.conflicts.every((conflict) => conflict.resolved && conflict.winner === 'Alice')).toBe(true);

        // Bob's palette is still his to go back to
        for (const id of ids) expect(stored.get('json:script_settingsMap_bob')[id].value).toBe('#222222');
    });

    test('a record still waiting to be shown is added to, not replaced', async () => {
        stored.set(`json:${CONFLICT_KEY}`, {
            at: 1,
            conflicts: [{ id: 'sync_token', resolved: false, winner: null, characters: ['Bob', 'Carol'] }],
        });
        putMap('alice', { color_profit: { id: 'color_profit', type: 'color', value: '#111111' } });
        putMap('bob', { color_profit: { id: 'color_profit', type: 'color', value: '#222222' } });

        await settingsStorage.loadSettings();

        const record = await settingsStorage.sharedScopeConflicts();
        expect(record.conflicts.map((conflict) => conflict.id).sort()).toEqual(['color_profit', 'sync_token']);
    });
});

describe('the carry-over records itself only when it worked', () => {
    test('a refused write with the new groups in play leaves the flag unset and retries', async () => {
        putMap('bob', { color_profit: { id: 'color_profit', type: 'color', value: '#ff0000' } });
        refuse.add(SHARED_KEY);

        await settingsStorage.loadSettings();

        expect(stored.get(FLAG_KEY)).toBeUndefined();
        expect(stored.get(`json:${SHARED_KEY}`)).toBeUndefined();

        refuse.clear();
        const settings = await settingsStorage.loadSettings();
        expect(settings.color_profit.value).toBe('#ff0000');
        expect(stored.get(FLAG_KEY)).toBe(true);

        // ...and a third pass leaves the settled value exactly where it is
        stored.delete(FLAG_KEY);
        await settingsStorage.migrateSharedSettings('script_settingsMap_alice');
        expect(stored.get(`json:${SHARED_KEY}`).color_profit.value).toBe('#ff0000');
    });

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
