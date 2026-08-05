/**
 * Tests for SettingsStorage import character matching
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const stored = new Map();

vi.mock('./storage.js', () => ({
    default: {
        getJSON: vi.fn((key, _area, defaultValue) => Promise.resolve(stored.get(`json:${key}`) ?? defaultValue)),
        setJSON: vi.fn((key, value) => {
            stored.set(`json:${key}`, value);
            return Promise.resolve();
        }),
        get: vi.fn((key, _area, defaultValue) => Promise.resolve(stored.get(key) ?? defaultValue)),
        set: vi.fn((key, value) => {
            stored.set(key, value);
            return Promise.resolve();
        }),
        getAll: vi.fn(() => Promise.resolve({})),
    },
}));

const { default: settingsStorage } = await import('./settings-storage.js');

describe('SettingsStorage.importSettings known-character matching', () => {
    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('skips keys suffixed with another known character id (new object format)', async () => {
        stored.set('json:known_character_ids', [
            { id: 'alice', name: 'Alice' },
            { id: 'bob', name: 'Bob' },
        ]);

        const result = await settingsStorage.importSettings(
            JSON.stringify({
                script_settingsMap_alice: { some: 'setting' },
                script_settingsMap_bob: { other: 'setting' },
                globalKey: { shared: true },
            })
        );

        expect(result).toEqual({ imported: 2, skipped: 1 });
        expect(stored.has('json:script_settingsMap_alice')).toBe(true);
        expect(stored.has('json:script_settingsMap_bob')).toBe(false);
        expect(stored.has('json:globalKey')).toBe(true);
    });

    test('recognises known characters listed in the imported payload itself', async () => {
        const result = await settingsStorage.importSettings(
            JSON.stringify({
                known_character_ids: [
                    { id: 'alice', name: 'Alice' },
                    { id: 'carol', name: 'Carol' },
                ],
                script_settingsMap_carol: { other: 'setting' },
            })
        );

        expect(result.skipped).toBe(1);
        expect(stored.has('json:script_settingsMap_carol')).toBe(false);
    });

    test('handles legacy plain-id known-character arrays in imported payloads', async () => {
        const result = await settingsStorage.importSettings(
            JSON.stringify({
                known_character_ids: ['alice', 'dave'],
                script_settingsMap_dave: { other: 'setting' },
            })
        );

        expect(result.skipped).toBe(1);
        expect(stored.has('json:script_settingsMap_dave')).toBe(false);
    });
});

describe('one-time rewrites of superseded schema defaults', () => {
    const KEY = 'script_settingsMap_alice';
    const FLAG = `settings_default_rewrites_v1_${KEY}`;

    /** A saved map holding the old defaults, as an existing user's would */
    const oldDefaults = () => ({
        labyrinthLiveCombatSim: { id: 'labyrinthLiveCombatSim', type: 'checkbox', isTrue: true },
        labyrinthPathUnknownMode: { id: 'labyrinthPathUnknownMode', type: 'select', value: 'clearable' },
    });

    beforeEach(() => {
        stored.clear();
        settingsStorage.currentCharacterId = 'alice';
        settingsStorage.currentCharacterName = 'Alice';
    });

    test('an existing user sitting on the old defaults is moved to the new ones', async () => {
        stored.set(`json:${KEY}`, oldDefaults());

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(settings.labyrinthPathUnknownMode.value).toBe('shroud');
        // and it is persisted, not just applied in memory
        expect(stored.get(`json:${KEY}`).labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(stored.get(`json:${KEY}`).labyrinthPathUnknownMode.value).toBe('shroud');
    });

    test('a value that was never the old default is left alone', async () => {
        stored.set(`json:${KEY}`, {
            labyrinthLiveCombatSim: { id: 'labyrinthLiveCombatSim', type: 'checkbox', isTrue: false },
            labyrinthPathUnknownMode: { id: 'labyrinthPathUnknownMode', type: 'select', value: 'avoid' },
        });

        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthPathUnknownMode.value).toBe('avoid');
    });

    test('re-choosing the old value after the rewrite keeps it — this runs once', async () => {
        stored.set(`json:${KEY}`, oldDefaults());
        await settingsStorage.loadSettings();
        expect(stored.get(FLAG)).toBe(true);

        // The user goes back to the old values on purpose
        stored.set(`json:${KEY}`, oldDefaults());
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(true);
        expect(settings.labyrinthPathUnknownMode.value).toBe('clearable');
    });

    test('a fresh install gets the new defaults and is flagged, so it is never revisited', async () => {
        const settings = await settingsStorage.loadSettings();

        expect(settings.labyrinthLiveCombatSim.isTrue).toBe(false);
        expect(settings.labyrinthPathUnknownMode.value).toBe('shroud');
        expect(stored.get(FLAG)).toBe(true);
    });
});
