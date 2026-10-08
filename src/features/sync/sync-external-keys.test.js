import { describe, test, expect, beforeEach, vi } from 'vitest';

/**
 * Another script opting some of its own settings-store keys into the sync.
 *
 * The keys under test belong to "another script" and use neutral names
 * (`otherScriptPrefs_…`, `otherScriptLive`). The storage mock below is one
 * device's IndexedDB; a test that needs two devices swaps its contents and
 * calls `_resetExternalKeys()` the way a fresh page load starts with an empty
 * registry in memory.
 */

const storeState = vi.hoisted(() => ({ stores: {}, putAllCalls: [], unreadable: false }));

vi.mock('../../core/storage.js', () => ({
    default: {
        ready: Promise.resolve(),
        listStores: async () => Object.keys(storeState.stores),
        getAll: async (name) => {
            // Something else running while a build waits on a read
            const during = storeState.duringGetAll;
            storeState.duringGetAll = null;
            if (during) await during();
            return { ...(storeState.stores[name] || {}) };
        },
        tryGet: async (key, name) => {
            if (storeState.unreadable) return null;
            const store = storeState.stores[name] || {};
            return Object.hasOwn(store, key) ? { found: true, value: store[key] } : { found: false, value: null };
        },
        beginRestore: async () => {},
        endRestore: async () => {},
        putAll: async (name, entries, options) => {
            storeState.putAllCalls.push({ name, entries, options });
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
            return Object.keys(entries).length;
        },
    },
}));

vi.mock('../../core/settings-storage.js', () => ({
    default: { reconcileKeyMigrationState: async () => {} },
}));

const importedPayloads = vi.hoisted(() => []);
vi.mock('../../utils/full-backup.js', () => ({
    importEverything: async (payload) => {
        importedPayloads.push(payload);
        for (const [name, entries] of Object.entries(payload.stores || {})) {
            storeState.stores[name] = { ...(storeState.stores[name] || {}), ...entries };
        }
        return { restored: {}, expected: {}, failed: [], complete: true };
    },
    stripExcludedKeys: (storeName, entries) => entries,
}));

const {
    ownsKey,
    partitionOwnedKeys,
    checkExternalPrefix,
    addExternalKeyPrefixes,
    EXTERNAL_PREFIX_LIMIT,
    EXTERNAL_ENTRY_LIMIT,
    OWNED_KEY_PREFIXES,
} = await import('./sync-ownership.js');
const {
    registerSyncKeys,
    unregisterSyncKeys,
    registeredSyncKeys,
    externalKeysSettled,
    KEY_EXTERNAL_KEYS,
    _resetExternalKeys,
} = await import('./sync-external-keys.js');
const { buildPayloadJSON, applyPayload, mergeForUpload, learnExternalKeysFromText, LOCAL_ONLY_KEY_PREFIXES } =
    await import('./sync-payload.js');
const { DEVICE_LOCAL_KEY_PREFIXES } = await vi.importActual('../../utils/full-backup.js');

const OWNER = 'other-script';
const PREFIXES = ['otherScriptPrefs_', 'otherScriptLive'];

/** A payload in the format the sync writes */
const payloadText = (settings, externalKeys) =>
    JSON.stringify({
        formatVersion: 1,
        exportedAt: '2026-10-01T00:00:00.000Z',
        syncScope: 'settings',
        ...(externalKeys ? { externalKeys } : {}),
        stores: { settings },
    });

/** The registered prefixes a payload's (or the record's) registry names for one owner */
const liveIn = (record, owner = OWNER) => Object.keys(record?.[owner]?.prefixes || {}).sort();
/** The removed prefixes it names for one owner */
const removedIn = (record, owner = OWNER) => Object.keys(record?.[owner]?.removed || {}).sort();

beforeEach(() => {
    storeState.stores = { settings: {} };
    storeState.putAllCalls = [];
    storeState.unreadable = false;
    storeState.duringGetAll = null;
    importedPayloads.length = 0;
    _resetExternalKeys();
});

describe('registration validation', () => {
    test('accepts neutral prefixes and reports them', async () => {
        const result = await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        expect(result).toMatchObject({ ok: true, accepted: PREFIXES, added: PREFIXES, rejected: [] });
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: [...PREFIXES].sort() });
        // Registering again is a no-op, not a second copy
        expect((await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES })).added).toEqual([]);
        await externalKeysSettled();
    });

    test.each([
        ['', 'empty'],
        ['short', 'under the minimum length'],
        [42, 'not a string'],
        [null, 'not a string'],
        ['toolasha_anything', "this script's namespace"],
        ['TOOLASHA_upper', "this script's namespace, any case"],
        ['toolas', 'a prefix of the namespace'],
        ['script_', "a prefix of this script's settings map key"],
        ['script_settingsMap_other', "an extension of this script's settings map key"],
        ['settings_', "a prefix of this script's settings bookkeeping"],
        ['x'.repeat(200), 'over the maximum length'],
    ])('refuses %j (%s)', async (prefix) => {
        const result = await registerSyncKeys({ owner: OWNER, prefixes: [prefix] });
        expect(result.ok).toBe(false);
        expect(result.added).toEqual([]);
        expect(result.rejected).toHaveLength(1);
        expect(await registeredSyncKeys()).toEqual({});
    });

    test('refuses every prefix that would overlap a key this script owns, device-local ones included', async () => {
        const ours = [...OWNED_KEY_PREFIXES, ...LOCAL_ONLY_KEY_PREFIXES, ...DEVICE_LOCAL_KEY_PREFIXES];
        for (const prefix of ours) {
            if (prefix.length < 6) continue;
            expect(checkExternalPrefix(prefix), prefix).not.toBeNull();
            expect(checkExternalPrefix(`${prefix}more`), prefix).not.toBeNull();
        }
    });

    test('refuses a bad owner or a non-array of prefixes', async () => {
        expect((await registerSyncKeys({ owner: '', prefixes: PREFIXES })).ok).toBe(false);
        expect((await registerSyncKeys({ owner: 'has space', prefixes: PREFIXES })).ok).toBe(false);
        expect((await registerSyncKeys({ owner: OWNER, prefixes: 'otherScriptPrefs_' })).ok).toBe(false);
        expect((await registerSyncKeys(undefined)).ok).toBe(false);
        expect(await registeredSyncKeys()).toEqual({});
    });

    test('caps the total number of prefixes without evicting earlier ones', async () => {
        const many = Array.from({ length: EXTERNAL_PREFIX_LIMIT + 3 }, (_, index) => `otherScriptKey${index}_`);
        const result = await registerSyncKeys({ owner: OWNER, prefixes: many });
        expect(result.added).toHaveLength(EXTERNAL_PREFIX_LIMIT);
        expect(result.rejected).toHaveLength(3);
        expect((await registerSyncKeys({ owner: 'second-script', prefixes: ['secondScriptPrefs_'] })).added).toEqual(
            []
        );
        expect((await registeredSyncKeys())[OWNER]).toHaveLength(EXTERNAL_PREFIX_LIMIT);
        await externalKeysSettled();
    });

    test('refuses a prefix that overlaps one another owner registered, either way round', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptPrefs_'] });
        // Shorter: would capture the first owner's whole namespace
        expect((await registerSyncKeys({ owner: 'second-script', prefixes: ['otherScript'] })).rejected).toHaveLength(
            1
        );
        // Longer: would sit inside it
        expect(
            (await registerSyncKeys({ owner: 'second-script', prefixes: ['otherScriptPrefs_x'] })).rejected
        ).toHaveLength(1);
        // Identical: never held twice, so never counted twice toward the cap
        expect(
            (await registerSyncKeys({ owner: 'second-script', prefixes: ['otherScriptPrefs_'] })).rejected
        ).toHaveLength(1);
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: ['otherScriptPrefs_'] });
        // The same owner may widen or narrow its own
        expect((await registerSyncKeys({ owner: OWNER, prefixes: ['otherScript', 'otherScriptPrefs_x'] })).ok).toBe(
            true
        );
        await externalKeysSettled();
    });

    test('a payload cannot teach a prefix that overlaps another owner either', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptPrefs_'] });
        learnExternalKeysFromText(payloadText({}, { 'second-script': ['otherScript'] }));
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: ['otherScriptPrefs_'] });
        expect(ownsKey('settings', 'otherScriptCache_big')).toBe(false);
        await externalKeysSettled();
    });
});

describe('ownership', () => {
    test('a registered prefix is owned in the settings store, and only there', async () => {
        expect(ownsKey('settings', 'otherScriptPrefs_main')).toBe(false);
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        expect(ownsKey('settings', 'otherScriptPrefs_main')).toBe(true);
        expect(ownsKey('settings', 'otherScriptLive')).toBe(true);
        expect(ownsKey('settings', 'otherScriptCache_big')).toBe(false);
        // A store this script does not sync stays unsynced whatever is registered
        expect(ownsKey('openableAnalytics', 'otherScriptPrefs_main')).toBe(false);
        const { owned, foreignKeys } = partitionOwnedKeys('settings', {
            otherScriptPrefs_main: 1,
            otherScriptCache_big: 2,
            watchlist: 3,
        });
        expect(Object.keys(owned).sort()).toEqual(['otherScriptPrefs_main', 'watchlist']);
        expect(foreignKeys).toBe(1);
        await externalKeysSettled();
    });
});

describe('the payload', () => {
    test('a registered key travels in the payload, with the registry beside the stores', async () => {
        storeState.stores.settings = {
            watchlist: ['a'],
            otherScriptPrefs_main: { mode: 'x' },
            otherScriptLive: { state: 1 },
            otherScriptCache_big: 'not registered',
        };
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });

        const payload = JSON.parse(await buildPayloadJSON('settings'));
        expect(payload.stores.settings).toEqual({
            watchlist: ['a'],
            otherScriptPrefs_main: { mode: 'x' },
            otherScriptLive: { state: 1 },
        });
        expect(liveIn(payload.externalKeys)).toEqual([...PREFIXES].sort());
        await externalKeysSettled();
    });

    test('a registered key is written back on a pull', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        await externalKeysSettled();
        await applyPayload(
            payloadText({ watchlist: ['b'], otherScriptPrefs_main: { mode: 'remote' }, otherScriptCache_big: 'x' })
        );
        const landed = importedPayloads[0].stores.settings;
        expect(landed.otherScriptPrefs_main).toEqual({ mode: 'remote' });
        expect(Object.hasOwn(landed, 'otherScriptCache_big')).toBe(false);
    });

    test('a device that never registered learns the registry from the payload and applies the keys', async () => {
        // The plain list shape still reads
        await applyPayload(payloadText({ otherScriptLive: { state: 7 } }, { [OWNER]: PREFIXES }));
        expect(importedPayloads[0].stores.settings.otherScriptLive).toEqual({ state: 7 });
        // ...and remembers it, device-local, for the next page load
        expect(liveIn(storeState.stores.settings[KEY_EXTERNAL_KEYS])).toEqual([...PREFIXES].sort());
        // ...so its own next push carries the key on, rather than leaving it out
        const rebuilt = JSON.parse(await buildPayloadJSON('settings'));
        expect(rebuilt.stores.settings.otherScriptLive).toEqual({ state: 7 });
        expect(liveIn(rebuilt.externalKeys)).toEqual([...PREFIXES].sort());
    });

    test("a merged upload from a device that never registered keeps the gist's registered keys", async () => {
        storeState.stores.settings = { watchlist: ['local'] };
        const localText = await buildPayloadJSON('settings');
        const remoteText = payloadText(
            { watchlist: ['remote'], otherScriptLive: { state: 9 } },
            { [OWNER]: { prefixes: { otherScriptLive: 5 }, removed: {} } }
        );
        const merged = JSON.parse(mergeForUpload(localText, remoteText, null).text);
        expect(merged.stores.settings.otherScriptLive).toEqual({ state: 9 });
        expect(merged.externalKeys).toEqual({ [OWNER]: { prefixes: { otherScriptLive: 5 }, removed: {} } });
        await externalKeysSettled();
    });

    test('the registry is never uploaded as a key, only as the payload field', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        await externalKeysSettled();
        expect(storeState.stores.settings[KEY_EXTERNAL_KEYS]).toBeDefined();
        const payload = JSON.parse(await buildPayloadJSON('settings'));
        expect(Object.hasOwn(payload.stores.settings, KEY_EXTERNAL_KEYS)).toBe(false);
    });

    test("the registry is read from a payload's head without its stores", async () => {
        const text = payloadText({ watchlist: ['x'] }, { [OWNER]: ['otherScriptLive'] });
        expect(learnExternalKeysFromText(text)).toBe(true);
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: ['otherScriptLive'] });
        expect(learnExternalKeysFromText(text)).toBe(false);
        expect(learnExternalKeysFromText('not json')).toBe(false);
        await externalKeysSettled();
    });
});

describe('withdrawing a prefix', () => {
    test('unregistering stops the keys travelling and leaves a removal in the payload', async () => {
        storeState.stores.settings = { otherScriptPrefs_main: 1, otherScriptLive: 2 };
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        expect((await unregisterSyncKeys({ owner: OWNER, prefixes: ['otherScriptPrefs_'] })).removed).toEqual([
            'otherScriptPrefs_',
        ]);
        expect(ownsKey('settings', 'otherScriptPrefs_main')).toBe(false);

        const payload = JSON.parse(await buildPayloadJSON('settings'));
        expect(payload.stores.settings).toEqual({ otherScriptLive: 2 });
        expect(liveIn(payload.externalKeys)).toEqual(['otherScriptLive']);
        expect(removedIn(payload.externalKeys)).toEqual(['otherScriptPrefs_']);
        // Kept on this device; only no longer carried
        expect(storeState.stores.settings.otherScriptPrefs_main).toBe(1);
        await externalKeysSettled();
        expect(removedIn(storeState.stores.settings[KEY_EXTERNAL_KEYS])).toEqual(['otherScriptPrefs_']);
    });

    test('with no prefixes named, every prefix of the owner goes', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        await registerSyncKeys({ owner: 'second-script', prefixes: ['secondScriptPrefs_'] });
        expect((await unregisterSyncKeys({ owner: OWNER })).removed.sort()).toEqual([...PREFIXES].sort());
        expect(await registeredSyncKeys()).toEqual({ 'second-script': ['secondScriptPrefs_'] });
        expect((await unregisterSyncKeys({ owner: 'has space' })).ok).toBe(false);
        await externalKeysSettled();
    });

    test('an older copy that still lists the prefix does not teach it back', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        const before = JSON.parse(await buildPayloadJSON('settings')).externalKeys;
        vi.setSystemTime(new Date('2026-10-02T00:00:00Z'));
        await unregisterSyncKeys({ owner: OWNER, prefixes: ['otherScriptPrefs_'] });
        vi.useRealTimers();

        // Another device's payload, from before the removal
        await applyPayload(payloadText({ otherScriptPrefs_main: 'stale' }, before));
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: ['otherScriptLive'] });
        expect(Object.hasOwn(importedPayloads[0].stores.settings, 'otherScriptPrefs_main')).toBe(false);
        // The plain list shape (time 0) loses to the removal too
        learnExternalKeysFromText(payloadText({}, { [OWNER]: PREFIXES }));
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: ['otherScriptLive'] });
        await externalKeysSettled();
    });

    test('a removal in a payload reaches a device that still holds the prefix', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        const later = Date.now() + 60_000;
        await applyPayload(
            payloadText(
                { otherScriptLive: 'x' },
                { [OWNER]: { prefixes: { otherScriptLive: 1 }, removed: { otherScriptPrefs_: later } } }
            )
        );
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: ['otherScriptLive'] });
        await externalKeysSettled();
    });

    test('registering again after a removal wins over the removal', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        await unregisterSyncKeys({ owner: OWNER, prefixes: ['otherScriptPrefs_'] });
        expect((await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptPrefs_'] })).added).toEqual([
            'otherScriptPrefs_',
        ]);
        expect(ownsKey('settings', 'otherScriptPrefs_main')).toBe(true);
        const field = JSON.parse(await buildPayloadJSON('settings')).externalKeys;
        expect(removedIn(field)).toEqual([]);
        await externalKeysSettled();
    });
});

describe('remembered across page loads', () => {
    test('a registration is saved device-local through the restore-latch exemption', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        await externalKeysSettled();
        const write = storeState.putAllCalls.find((call) => Object.hasOwn(call.entries, KEY_EXTERNAL_KEYS));
        expect(write.options).toEqual({ bypassRestoreLatch: true });
        expect(liveIn(write.entries[KEY_EXTERNAL_KEYS])).toEqual([...PREFIXES].sort());
    });

    test('the next load honours the saved prefixes before the other script registers again', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        await externalKeysSettled();
        storeState.stores.settings.otherScriptPrefs_main = { mode: 'kept' };

        _resetExternalKeys(); // a fresh page: nothing registered in memory yet
        const payload = JSON.parse(await buildPayloadJSON('settings'));
        expect(payload.stores.settings.otherScriptPrefs_main).toEqual({ mode: 'kept' });

        _resetExternalKeys();
        await applyPayload(payloadText({ otherScriptPrefs_main: { mode: 'pulled' } }));
        expect(importedPayloads[0].stores.settings.otherScriptPrefs_main).toEqual({ mode: 'pulled' });
    });

    test('a registration made before the saved record is read does not write over it', async () => {
        // The plain list shape an earlier build of this feature wrote
        storeState.stores.settings[KEY_EXTERNAL_KEYS] = { 'first-script': ['firstScriptPrefs_'] };
        await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptLive'] });
        await externalKeysSettled();
        const saved = storeState.stores.settings[KEY_EXTERNAL_KEYS];
        expect(liveIn(saved, 'first-script')).toEqual(['firstScriptPrefs_']);
        expect(liveIn(saved)).toEqual(['otherScriptLive']);
    });

    test('a saved record is loaded whole even when this page already filled the cap', async () => {
        const stored = Array.from({ length: 5 }, (_, index) => `firstScriptKey${index}_`);
        storeState.stores.settings[KEY_EXTERNAL_KEYS] = { 'first-script': stored };
        const many = Array.from({ length: EXTERNAL_PREFIX_LIMIT }, (_, index) => `otherScriptKey${index}_`);
        // Straight into the registry, as nothing public can any more: the public calls load first
        addExternalKeyPrefixes(OWNER, many);
        await externalKeysSettled();
        const saved = storeState.stores.settings[KEY_EXTERNAL_KEYS];
        expect(liveIn(saved, 'first-script')).toEqual([...stored].sort());
        expect(liveIn(saved)).toHaveLength(EXTERNAL_PREFIX_LIMIT);
        expect(ownsKey('settings', 'firstScriptKey3_x')).toBe(true);
    });

    test('an unreadable record is not overwritten', async () => {
        storeState.stores.settings[KEY_EXTERNAL_KEYS] = { 'first-script': ['firstScriptPrefs_'] };
        storeState.unreadable = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptLive'] });
        await externalKeysSettled();
        warn.mockRestore();
        expect(storeState.putAllCalls).toEqual([]);
        expect(storeState.stores.settings[KEY_EXTERNAL_KEYS]).toEqual({ 'first-script': ['firstScriptPrefs_'] });
    });

    test('an unreadable record stops a build or an apply rather than going on without it', async () => {
        storeState.stores.settings = { otherScriptLive: 1 };
        storeState.unreadable = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await expect(buildPayloadJSON('settings')).rejects.toMatchObject({ kind: 'storage' });
        await expect(applyPayload(payloadText({ otherScriptLive: 2 }))).rejects.toMatchObject({ kind: 'storage' });
        warn.mockRestore();
        expect(importedPayloads).toEqual([]);
    });
});

describe('review follow-ups', () => {
    test('unregistering before this page loaded the saved record withdraws the saved prefixes', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: PREFIXES });
        await externalKeysSettled();
        storeState.stores.settings.otherScriptLive = 1;

        _resetExternalKeys(); // a fresh page: the saved record not read yet
        expect(await registeredSyncKeys()).toEqual({ [OWNER]: [...PREFIXES].sort() });
        _resetExternalKeys();
        expect((await unregisterSyncKeys({ owner: OWNER })).removed.sort()).toEqual([...PREFIXES].sort());
        await externalKeysSettled();
        expect(liveIn(storeState.stores.settings[KEY_EXTERNAL_KEYS])).toEqual([]);

        _resetExternalKeys();
        const payload = JSON.parse(await buildPayloadJSON('settings'));
        expect(Object.hasOwn(payload.stores.settings, 'otherScriptLive')).toBe(false);
    });

    test('unregistering is refused when the saved record cannot be read', async () => {
        storeState.stores.settings[KEY_EXTERNAL_KEYS] = { [OWNER]: PREFIXES };
        storeState.unreadable = true;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const result = await unregisterSyncKeys({ owner: OWNER });
        warn.mockRestore();
        expect(result.ok).toBe(false);
        expect(storeState.putAllCalls).toEqual([]);
    });

    test('a damaged payload with a readable registry header teaches nothing', async () => {
        const registry = { [OWNER]: ['otherScriptLive'] };
        const damaged = JSON.stringify({ formatVersion: 1, externalKeys: registry, stores: { settings: [] } });
        expect(learnExternalKeysFromText(damaged)).toBe(false);
        // Cut short after the header: the old header-only read accepted this
        const cut = payloadText({ otherScriptLive: { state: 1 } }, registry).slice(0, -20);
        expect(learnExternalKeysFromText(cut)).toBe(false);
        const newer = JSON.stringify({ formatVersion: 2, externalKeys: registry, stores: { settings: {} } });
        expect(learnExternalKeysFromText(newer)).toBe(false);

        await expect(applyPayload(damaged)).rejects.toThrow();
        storeState.stores.settings = { otherScriptLive: 'local' };
        expect(() => mergeForUpload(payloadText({}), damaged, null)).toThrow();
        expect(await registeredSyncKeys()).toEqual({});
    });

    test('a withdrawn prefix stays withdrawn however many removals follow', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptFirst'] });
        await unregisterSyncKeys({ owner: OWNER, prefixes: ['otherScriptFirst'] });
        for (let index = 0; index < 80; index += 1) {
            const prefix = `otherScriptKey${index}_`;
            await registerSyncKeys({ owner: OWNER, prefixes: [prefix] });
            await unregisterSyncKeys({ owner: OWNER, prefixes: [prefix] });
        }
        // A stale copy, from before the first removal
        learnExternalKeysFromText(payloadText({}, { [OWNER]: { prefixes: { otherScriptFirst: 1 }, removed: {} } }));
        expect(ownsKey('settings', 'otherScriptFirst')).toBe(false);
        expect(removedIn(JSON.parse(await buildPayloadJSON('settings')).externalKeys)).toContain('otherScriptFirst');
        await externalKeysSettled();
    });

    test('a full registry learns no prefix it does not hold, registered or removed', async () => {
        for (let index = 0; index < EXTERNAL_ENTRY_LIMIT; index += 1) {
            const prefix = `otherScriptKey${index}_`;
            await registerSyncKeys({ owner: OWNER, prefixes: [prefix] });
            await unregisterSyncKeys({ owner: OWNER, prefixes: [prefix] });
        }
        const late = Date.now() + 60_000;
        expect(
            learnExternalKeysFromText(
                payloadText({}, { 'second-script': { prefixes: { secondScriptPrefs_: late }, removed: {} } })
            )
        ).toBe(false);
        expect((await registerSyncKeys({ owner: 'second-script', prefixes: ['secondScriptPrefs_'] })).ok).toBe(false);
        expect((await unregisterSyncKeys({ owner: 'second-script', prefixes: ['secondScriptOld_'] })).ok).toBe(false);
        // One it holds can still be registered again
        expect((await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptKey0_'] })).ok).toBe(true);
        await externalKeysSettled();
    });
});

describe('review round 2', () => {
    test("a payload that swaps one of an owner's prefixes for another lands at the cap", async () => {
        const held = Array.from({ length: EXTERNAL_PREFIX_LIMIT }, (_, index) => `otherScriptKey${index}_`);
        await registerSyncKeys({ owner: OWNER, prefixes: held });
        const later = Date.now() + 60_000;
        const prefixes = Object.fromEntries(held.slice(1).map((prefix) => [prefix, later - 1]));
        // Sorts before the prefix it replaces
        prefixes.otherScriptAll_ = later;
        const record = { [OWNER]: { prefixes, removed: { [held[0]]: later } } };
        expect(learnExternalKeysFromText(payloadText({}, record))).toBe(true);
        expect(ownsKey('settings', 'otherScriptAll_x')).toBe(true);
        expect(ownsKey('settings', `${held[0]}x`)).toBe(false);
        await externalKeysSettled();
    });

    test('a prefix one owner withdrew can be claimed by another in the same payload', async () => {
        await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptPrefs_'] });
        const later = Date.now() + 60_000;
        const record = {
            // Sorts before the owner that withdrew it
            'another-script': { prefixes: { otherScriptPrefs_x: later }, removed: {} },
            [OWNER]: { prefixes: {}, removed: { otherScriptPrefs_: later } },
        };
        learnExternalKeysFromText(payloadText({}, record));
        expect(await registeredSyncKeys()).toEqual({ 'another-script': ['otherScriptPrefs_x'] });
        await externalKeysSettled();
    });

    test('a registration landing while a payload is built does not split its registry from its keys', async () => {
        storeState.stores.settings = { otherScriptLive: 1, watchlist: ['a'] };
        storeState.duringGetAll = () => registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptLive'] });
        const payload = JSON.parse(await buildPayloadJSON('settings'));
        // Built under the registry it started with: neither the key nor the prefix
        expect(payload.stores.settings).toEqual({ watchlist: ['a'] });
        expect(payload.externalKeys).toBeUndefined();
        await externalKeysSettled();
    });

    test('a withdrawal landing while a payload is built does not split its registry from its keys', async () => {
        storeState.stores.settings = { otherScriptLive: 1 };
        await registerSyncKeys({ owner: OWNER, prefixes: ['otherScriptLive'] });
        storeState.duringGetAll = () => unregisterSyncKeys({ owner: OWNER });
        const payload = JSON.parse(await buildPayloadJSON('settings'));
        // Built under the registry it started with: the key, and its prefix still registered
        expect(payload.stores.settings).toEqual({ otherScriptLive: 1 });
        expect(liveIn(payload.externalKeys)).toEqual(['otherScriptLive']);
        await externalKeysSettled();
    });
});

describe('nothing registered', () => {
    test('the payload is what it always was: no registry field, another script left out', async () => {
        storeState.stores.settings = { watchlist: ['a'], otherScriptPrefs_main: { mode: 'x' } };
        const text = await buildPayloadJSON('settings');
        expect(text).not.toContain('externalKeys');
        expect(JSON.parse(text).stores.settings).toEqual({ watchlist: ['a'] });

        const merged = mergeForUpload(text, payloadText({ otherScriptPrefs_main: { mode: 'y' } }), null).text;
        expect(merged).not.toContain('externalKeys');
        expect(JSON.parse(merged).stores.settings).toEqual({ watchlist: ['a'] });

        await applyPayload(payloadText({ otherScriptPrefs_main: { mode: 'y' } }));
        expect(importedPayloads[0].stores.settings).toEqual({});
        expect(storeState.putAllCalls).toEqual([]);
    });
});
