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
        parseJSON: vi.fn((raw, _key, defaultValue = null) => {
            if (raw === null || raw === undefined) return defaultValue;
            if (typeof raw === 'object') return raw;
            try {
                return JSON.parse(raw);
            } catch {
                return defaultValue;
            }
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

    describe('cross-tab cost reduction', () => {
        test('two passes with nothing changed between them produce exactly one write', async () => {
            vi.useFakeTimers();
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
            settingsMirror._resetCadenceForTests();

            expect(await settingsMirror.maybeMirror()).toBe(true);
            const writesAfterFirst = GM_setValue.mock.calls.filter(([key]) => key === settingsMirror.MIRROR_KEY).length;
            expect(writesAfterFirst).toBe(1);

            // Next allowed tick, cadence-wise, but nothing in the live store changed.
            vi.advanceTimersByTime(settingsMirror.MIRROR_INTERVAL_MS + 1000);
            expect(await settingsMirror.maybeMirror()).toBe(false);

            const totalWrites = GM_setValue.mock.calls.filter(([key]) => key === settingsMirror.MIRROR_KEY).length;
            expect(totalWrites).toBe(1);
        });

        test('a second tab defers to a write another tab already made inside the interval', async () => {
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });

            // "Tab A": the module instance already imported at file scope.
            settingsMirror._resetCadenceForTests();
            expect(await settingsMirror.maybeMirror()).toBe(true);

            // "Tab B": a fresh module instance (its own module-level lastWriteAttempt
            // starts at 0), sharing the same GM storage and live store as tab A.
            vi.resetModules();
            const { default: tabB } = await import('./settings-mirror.js');
            expect(await tabB.maybeMirror()).toBe(false);

            const totalWrites = GM_setValue.mock.calls.filter(([key]) => key === settingsMirror.MIRROR_KEY).length;
            expect(totalWrites).toBe(1);
        });

        test('a changed map still mirrors promptly on the next allowed pass', async () => {
            vi.useFakeTimers();
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
            settingsMirror._resetCadenceForTests();
            expect(await settingsMirror.maybeMirror()).toBe(true);

            vi.advanceTimersByTime(settingsMirror.MIRROR_INTERVAL_MS + 1000);
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'light' } } });
            expect(await settingsMirror.maybeMirror()).toBe(true);

            expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toEqual({
                theme: { id: 'theme', value: 'light' },
            });
        });

        test('an unreadable live store does not write and does not permanently disable future writes', async () => {
            vi.useFakeTimers();
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
            settingsMirror._resetCadenceForTests();
            expect(await settingsMirror.maybeMirror()).toBe(true);

            vi.advanceTimersByTime(settingsMirror.MIRROR_INTERVAL_MS + 1000);
            unreadable.on = true;
            expect(await settingsMirror.maybeMirror()).toBe(false);

            unreadable.on = false;
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'light' } } });
            vi.advanceTimersByTime(settingsMirror.MIRROR_INTERVAL_MS + 1000);
            expect(await settingsMirror.maybeMirror()).toBe(true);
            expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toEqual({
                theme: { id: 'theme', value: 'light' },
            });
        });
    });

    describe('legacy string-shaped settings maps', () => {
        test('a settings map stored as a JSON string is mirrored', async () => {
            setStore({
                script_settingsMap_char1: JSON.stringify({ theme: { id: 'theme', value: 'dark' } }),
            });

            const wrote = await settingsMirror.maybeMirror(true);
            expect(wrote).toBe(true);
            expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toEqual({
                theme: { id: 'theme', value: 'dark' },
            });
        });

        test('a string that parses to a non-object is still refused', async () => {
            setStore({ script_settingsMap_char1: JSON.stringify('just a string') });
            const wrote = await settingsMirror.maybeMirror(true);
            expect(wrote).toBe(false);
        });

        test('a string that does not parse as JSON at all is still refused', async () => {
            setStore({ script_settingsMap_char1: 'not json at all {' });
            const wrote = await settingsMirror.maybeMirror(true);
            expect(wrote).toBe(false);
        });

        test('a string that parses to an array is refused, not read as a populated map', async () => {
            // `Object.keys` on a non-empty array reports a length, which is the
            // one way something that is not a settings map could still vouch
            // for a store that has nothing real left in it.
            setStore({ script_settingsMap_char1: JSON.stringify(['dark', 'light']) });
            const wrote = await settingsMirror.maybeMirror(true);
            expect(wrote).toBe(false);
        });
    });

    describe('a cadence that must not wedge shut', () => {
        test('a meta stamp from the future does not defer this tab indefinitely', async () => {
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });

            // GM storage is extension-scoped and can arrive from another
            // profile or device; that machine's clock runs an hour ahead.
            GM_setValue(
                settingsMirror.MIRROR_META_KEY,
                JSON.stringify({ writtenAt: Date.now() + 60 * 60 * 1000, fingerprint: 'from-another-machine' })
            );

            expect(await settingsMirror.maybeMirror()).toBe(true);
            expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toEqual({
                theme: { id: 'theme', value: 'dark' },
            });
        });

        test('an unchanged fingerprint does not skip the write when no mirror is actually there', async () => {
            vi.useFakeTimers();
            setStore({ script_settingsMap_char1: { theme: { id: 'theme', value: 'dark' } } });
            settingsMirror._resetCadenceForTests();
            expect(await settingsMirror.maybeMirror()).toBe(true);

            // The meta record survived but the payload did not — a manager that
            // reported a successful GM_setValue and stored nothing, or a synced
            // meta record whose ~1 MB companion never came with it.
            gmData.delete(settingsMirror.MIRROR_KEY);

            vi.advanceTimersByTime(settingsMirror.MIRROR_INTERVAL_MS + 1000);
            expect(await settingsMirror.maybeMirror()).toBe(true);
            expect(settingsMirror.getMirroredEntry('script_settingsMap_char1')).toEqual({
                theme: { id: 'theme', value: 'dark' },
            });
        });
    });
});
