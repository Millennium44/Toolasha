/**
 * Tests for settings-mirror.js — the GM-storage mirror of the settings maps.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

const store = new Map();
/** When true, tryGetAllKeys/tryGet answer "could not be made" (null) */
const unreadable = { on: false };

vi.mock('./storage.js', () => ({
    default: {
        tryGetAllKeys: vi.fn(async (_storeName) => {
            if (unreadable.on) return null;
            return [...store.keys()];
        }),
        tryGet: vi.fn(async (key) => {
            if (unreadable.on) return null;
            return store.has(key) ? { found: true, value: store.get(key) } : { found: false, value: null };
        }),
    },
}));

const { default: settingsMirror } = await import('./settings-mirror.js');

function setStore(entries) {
    store.clear();
    for (const [key, value] of Object.entries(entries)) store.set(key, value);
}

beforeEach(() => {
    store.clear();
    unreadable.on = false;
    delete globalThis.GM_getValue;
    delete globalThis.GM_setValue;
    settingsMirror._resetCadenceForTests();
});

afterEach(() => {
    settingsMirror.stopMirroring();
    vi.useRealTimers();
});

describe('GM storage unavailable', () => {
    test('maybeMirror is a no-op without throwing', async () => {
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
        await expect(settingsMirror.maybeMirror(true)).resolves.toBe(false);
    });

    test('getMirroredEntry returns null without throwing', () => {
        expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toBeNull();
    });

    test('startMirroring does not schedule anything', () => {
        vi.useFakeTimers();
        const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
        settingsMirror.startMirroring();
        expect(setIntervalSpy).not.toHaveBeenCalled();
    });
});

describe('with GM storage available', () => {
    let gmData;

    beforeEach(() => {
        gmData = new Map();
        globalThis.GM_getValue = vi.fn((key, defaultValue) => (gmData.has(key) ? gmData.get(key) : defaultValue));
        globalThis.GM_setValue = vi.fn((key, value) => {
            gmData.set(key, value);
        });
    });

    test('mirrors settings-map and bookkeeping keys, never a history key', async () => {
        setStore({
            script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } },
            script_settingsMap_shared: { sync_token: { id: 'sync_token', value: 'redacted-in-real-life' } },
            settings_key_migrations_applied_script_settingsMap_char1: ['patientTickSides'],
            settings_default_rewrites_v2_script_settingsMap_char1: true,
            settings_shared_scope_v3: true,
            known_character_ids: [{ id: 'char1', name: 'Hero' }],
            // Not a settings key at all — must never be mirrored
            alchemyHistory_char1: [{ item: 'gold', count: 5 }],
            networthHistory: [{ at: 1, value: 100 }],
        });

        const wrote = await settingsMirror.maybeMirror(true);
        expect(wrote).toBe(true);

        const raw = GM_getValue(settingsMirror.MIRROR_KEY, null);
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw);
        expect(Object.keys(parsed.data).sort()).toEqual(
            [
                'script_settingsMap_char1',
                'script_settingsMap_shared',
                'settings_key_migrations_applied_script_settingsMap_char1',
                'settings_default_rewrites_v2_script_settingsMap_char1',
                'settings_shared_scope_v3',
                'known_character_ids',
            ].sort()
        );
        expect(parsed.data).not.toHaveProperty('alchemyHistory_char1');
        expect(parsed.data).not.toHaveProperty('networthHistory');
    });

    test('does not overwrite an existing mirror when the live listing fails outright', async () => {
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
        await settingsMirror.maybeMirror(true);
        const goodMirror = GM_getValue(settingsMirror.MIRROR_KEY, null);
        expect(goodMirror).not.toBeNull();

        unreadable.on = true;
        const wrote = await settingsMirror.maybeMirror(true);
        expect(wrote).toBe(false);
        expect(GM_getValue(settingsMirror.MIRROR_KEY, null)).toBe(goodMirror);
    });

    test('does not overwrite an existing mirror when the live store reads back empty (a wipe)', async () => {
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
        await settingsMirror.maybeMirror(true);
        const goodMirror = GM_getValue(settingsMirror.MIRROR_KEY, null);
        expect(goodMirror).not.toBeNull();

        // The live store now answers with nothing — same shape a fresh,
        // recreated IndexedDB gives right after a wipe.
        setStore({});
        const wrote = await settingsMirror.maybeMirror(true);
        expect(wrote).toBe(false);
        expect(GM_getValue(settingsMirror.MIRROR_KEY, null)).toBe(goodMirror);
    });

    test('does not write when only bookkeeping/shared keys exist, no real character map', async () => {
        setStore({
            script_settingsMap_shared: { sync_token: { id: 'sync_token', value: 'x' } },
            known_character_ids: [{ id: 'char1', name: 'Hero' }],
        });
        const wrote = await settingsMirror.maybeMirror(true);
        expect(wrote).toBe(false);
    });

    test('does not write when the only character map is an empty object', async () => {
        setStore({ script_settingsMap_char1: {} });
        const wrote = await settingsMirror.maybeMirror(true);
        expect(wrote).toBe(false);
    });

    test('a live store holding only one character keeps the other characters mirrored', async () => {
        // Two characters mirrored before the wipe.
        setStore({
            script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } },
            script_settingsMap_char2: { theme: { id: 'theme', value: 'light' } },
        });
        await settingsMirror.maybeMirror(true);

        // Chrome wipes the origin; the player logs in as char1 and accepts the
        // restore, so the live store now holds exactly one real map. char2 has
        // not been logged in yet and still needs its own offer.
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
        expect(await settingsMirror.maybeMirror(true)).toBe(true);

        expect(settingsMirror.getMirroredEntry('script_settingsMap_char2')).toEqual({
            theme: { id: 'theme', value: 'light' },
        });
    });

    test('a key the live store still has is updated, not merely kept', async () => {
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
        await settingsMirror.maybeMirror(true);

        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'light' } } });
        expect(await settingsMirror.maybeMirror(true)).toBe(true);

        expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toEqual({
            theme: { id: 'theme', value: 'light' },
        });
    });

    test('respects the cadence: a second unforced call within the interval does not write', async () => {
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
        expect(await settingsMirror.maybeMirror()).toBe(true);
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'light' } } });
        expect(await settingsMirror.maybeMirror()).toBe(false);
    });

    test('getMirroredEntry reads back a mirrored character map', async () => {
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
        await settingsMirror.maybeMirror(true);
        expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toEqual({
            theme: { id: 'theme', value: 'dark' },
        });
        expect(settingsMirror.getMirroredEntry('script_settingsMap_char2')).toBeNull();
    });

    test('startMirroring schedules an initial mirror and a recurring one', async () => {
        vi.useFakeTimers();
        setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });

        settingsMirror.startMirroring();
        expect(GM_getValue(settingsMirror.MIRROR_KEY, null)).toBeNull();

        await vi.advanceTimersByTimeAsync(30 * 1000);
        expect(GM_getValue(settingsMirror.MIRROR_KEY, null)).not.toBeNull();
    });
});
