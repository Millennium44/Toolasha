import { describe, test, expect, beforeEach, vi } from 'vitest';

const storeState = vi.hoisted(() => ({ stores: {} }));

vi.mock('../../core/storage.js', () => ({
    default: {
        listStores: async () => Object.keys(storeState.stores),
        getAll: async (name) => ({ ...(storeState.stores[name] || {}) }),
    },
}));

const importedPayloads = vi.hoisted(() => []);
vi.mock('../../utils/full-backup.js', () => ({
    importEverything: async (payload) => {
        importedPayloads.push(payload);
        return { restored: { settings: Object.keys(payload.stores?.settings || {}).length } };
    },
}));

const { buildPayloadJSON, applyPayload, hashPayload, readExportedAt, redactSettingsStore } =
    await import('./sync-payload.js');

beforeEach(() => {
    importedPayloads.length = 0;
    storeState.stores = {
        settings: {
            script_settingsMap_abc: { sync_token: { value: 'ghp_secret' }, chatCommands: { isTrue: true } },
            toolasha_sync_gistId: 'deadbeef',
            some_other_key: 42,
        },
        dungeonRuns: { run1: { kills: 3 } },
    };
});

describe('redaction', () => {
    test('strips the GitHub token out of the settings map', () => {
        const safe = redactSettingsStore(storeState.stores.settings);
        expect(safe.script_settingsMap_abc.sync_token).toBeUndefined();
        expect(safe.script_settingsMap_abc.chatCommands).toEqual({ isTrue: true });
    });

    test('strips device-local sync bookkeeping', () => {
        const safe = redactSettingsStore(storeState.stores.settings);
        expect(safe.toolasha_sync_gistId).toBeUndefined();
        expect(safe.some_other_key).toBe(42);
    });

    test('does not mutate the caller’s live storage read', () => {
        redactSettingsStore(storeState.stores.settings);
        expect(storeState.stores.settings.script_settingsMap_abc.sync_token).toEqual({ value: 'ghp_secret' });
    });

    test('handles a settings map stored as a JSON string', () => {
        const safe = redactSettingsStore({
            script_settingsMap_abc: JSON.stringify({ sync_token: { value: 'x' }, a: 1 }),
        });
        expect(JSON.parse(safe.script_settingsMap_abc)).toEqual({ a: 1 });
    });
});

describe('buildPayloadJSON', () => {
    test('settings scope carries only the settings store', async () => {
        const json = await buildPayloadJSON('settings');
        const parsed = JSON.parse(json);
        expect(Object.keys(parsed.stores)).toEqual(['settings']);
        expect(parsed.syncScope).toBe('settings');
        expect(json).not.toContain('ghp_secret');
    });

    test('everything scope carries every store, still without the token', async () => {
        const json = await buildPayloadJSON('everything');
        const parsed = JSON.parse(json);
        expect(Object.keys(parsed.stores).sort()).toEqual(['dungeonRuns', 'settings']);
        expect(parsed.stores.dungeonRuns.run1).toEqual({ kills: 3 });
        expect(json).not.toContain('ghp_secret');
    });

    test('is readable by the full-backup importer', async () => {
        const parsed = JSON.parse(await buildPayloadJSON('everything'));
        expect(parsed.formatVersion).toBe(1);
        expect(typeof parsed.exportedAt).toBe('string');
    });
});

describe('applyPayload', () => {
    test('keeps this device’s token when the incoming map has none', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { script_settingsMap_abc: { chatCommands: { isTrue: false } } } },
        });

        await applyPayload(json);

        const written = importedPayloads[0].stores.settings.script_settingsMap_abc;
        expect(written.sync_token).toEqual({ value: 'ghp_secret' });
        expect(written.chatCommands).toEqual({ isTrue: false });
    });

    test('never restores sync bookkeeping from a payload', async () => {
        const json = JSON.stringify({
            formatVersion: 1,
            exportedAt: '2026-01-01T00:00:00.000Z',
            stores: { settings: { toolasha_sync_gistId: 'someone-elses-gist', keep: 1 } },
        });

        await applyPayload(json);

        expect(importedPayloads[0].stores.settings.toolasha_sync_gistId).toBeUndefined();
        expect(importedPayloads[0].stores.settings.keep).toBe(1);
    });
});

describe('hashPayload', () => {
    test('is stable and distinguishes different payloads', () => {
        expect(hashPayload('abc')).toBe(hashPayload('abc'));
        expect(hashPayload('abc')).not.toBe(hashPayload('abd'));
    });

    test('produces a fixed-width hex digest', () => {
        expect(hashPayload('')).toMatch(/^[0-9a-f]{8}$/);
    });
});

describe('readExportedAt', () => {
    test('finds the timestamp without parsing the payload', async () => {
        const json = await buildPayloadJSON('everything');
        expect(readExportedAt(json)).toBe(JSON.parse(json).exportedAt);
    });

    test('returns null when there is none', () => {
        expect(readExportedAt('{"stores":{}}')).toBeNull();
    });
});
