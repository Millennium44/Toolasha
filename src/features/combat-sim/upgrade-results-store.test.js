import { describe, test, expect, vi, beforeEach } from 'vitest';

const settings = vi.hoisted(() => ({ enabled: false }));
vi.mock('../../core/config.js', () => ({
    default: {
        getSetting: (key, fallback = false) =>
            key === 'combatSim_rememberUpgradeResults' ? settings.enabled : fallback,
    },
}));

const store = vi.hoisted(() => ({ data: {} }));
vi.mock('../../utils/character-key.js', () => ({
    characterKey: (base) => `${base}_char1`,
    writeScoped: vi.fn(async (key, value) => {
        store.data[key] = value;
        return true;
    }),
    readScoped: vi.fn(async (key, _store, def = null) => (key in store.data ? store.data[key] : def)),
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        delete: vi.fn(async (key) => {
            delete store.data[key];
            return true;
        }),
    },
}));

import {
    saveUpgradeResults,
    loadUpgradeResults,
    clearUpgradeResults,
    rememberUpgradeResultsEnabled,
} from './upgrade-results-store.js';

const KEY = 'combatSimUpgradeResults';
const sampleResults = () => ({ baseline: { dps: 1 }, results: [{ candidate: { type: 'tier' }, cost: 5 }] });

describe('upgrade-results-store', () => {
    beforeEach(() => {
        settings.enabled = false;
        store.data = {};
    });

    test('does not save when the option is off', async () => {
        await saveUpgradeResults(KEY, sampleResults());
        expect(store.data[KEY]).toBeUndefined();
    });

    test('saves a wrapped payload with a timestamp when the option is on', async () => {
        settings.enabled = true;
        await saveUpgradeResults(KEY, sampleResults());
        expect(store.data[KEY]).toBeTruthy();
        expect(store.data[KEY].data.results).toHaveLength(1);
        expect(typeof store.data[KEY].savedAt).toBe('number');
    });

    test('does not save an empty result set', async () => {
        settings.enabled = true;
        await saveUpgradeResults(KEY, { baseline: {}, results: [] });
        expect(store.data[KEY]).toBeUndefined();
    });

    test('load returns null when the option is off, even with a stored payload', async () => {
        store.data[KEY] = { data: sampleResults(), savedAt: 123 };
        expect(await loadUpgradeResults(KEY)).toBeNull();
    });

    test('load returns the payload when the option is on', async () => {
        settings.enabled = true;
        store.data[KEY] = { data: sampleResults(), savedAt: 123 };
        const payload = await loadUpgradeResults(KEY);
        expect(payload.savedAt).toBe(123);
        expect(payload.data.results).toHaveLength(1);
    });

    test('load returns null for an empty stored result set', async () => {
        settings.enabled = true;
        store.data[KEY] = { data: { results: [] }, savedAt: 1 };
        expect(await loadUpgradeResults(KEY)).toBeNull();
    });

    test('two sims keep separate keys', async () => {
        settings.enabled = true;
        await saveUpgradeResults('combatSimUpgradeResults', sampleResults());
        await saveUpgradeResults('labSimUpgradeResults', sampleResults());
        expect(store.data['combatSimUpgradeResults']).toBeTruthy();
        expect(store.data['labSimUpgradeResults']).toBeTruthy();
    });

    test('rememberUpgradeResultsEnabled reflects the setting', () => {
        settings.enabled = true;
        expect(rememberUpgradeResultsEnabled()).toBe(true);
        settings.enabled = false;
        expect(rememberUpgradeResultsEnabled()).toBe(false);
    });

    test("clearUpgradeResults deletes this character's scoped key", async () => {
        store.data[`${KEY}_char1`] = { data: sampleResults(), savedAt: 1 };
        await clearUpgradeResults(KEY);
        expect(store.data[`${KEY}_char1`]).toBeUndefined();
    });

    test("clearUpgradeResults leaves the other sim's key untouched", async () => {
        store.data[`${KEY}_char1`] = { data: sampleResults(), savedAt: 1 };
        store.data['labSimUpgradeResults_char1'] = { data: sampleResults(), savedAt: 1 };
        await clearUpgradeResults(KEY);
        expect(store.data['labSimUpgradeResults_char1']).toBeTruthy();
    });

    test('clearUpgradeResults swallows a storage failure rather than throwing', async () => {
        const storageModule = await import('../../core/storage.js');
        storageModule.default.delete.mockRejectedValueOnce(new Error('boom'));
        await expect(clearUpgradeResults(KEY)).resolves.toBeUndefined();
    });
});
