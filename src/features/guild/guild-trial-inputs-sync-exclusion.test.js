/**
 * Saved Trial Input Capture bundles stay on this browser.
 *
 * The setting says "Keep captured inputs on this browser", and each saved
 * bundle may hold up to 20 MB of opened profiles and trial loadouts, eight to a
 * character. They live in `combatExport`, which the sync otherwise carries
 * whole — past the gist's cap, one capture would fail every push. Asserted
 * against the real payload builder and the real importer, with only
 * `core/storage.js` stubbed, so it is the exclusion's wiring that passes this.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ stores: {}, written: {} }));

vi.mock('../../core/storage.js', () => ({
    default: {
        listStores: async () => Object.keys(state.stores),
        getAll: async (name) => ({ ...(state.stores[name] || {}) }),
        getJSON: async (key, name, fallback = null) => {
            const store = state.stores[name] || {};
            return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : fallback;
        },
        setJSON: async () => true,
        tryGet: async (key, name) => {
            const store = state.stores[name] || {};
            return Object.prototype.hasOwnProperty.call(store, key)
                ? { found: true, value: store[key] }
                : { found: false, value: null };
        },
        delete: async () => true,
        putAll: async (name, entries) => {
            state.written[name] = { ...(state.written[name] || {}), ...entries };
            return Object.keys(entries).length;
        },
        beginRestore: async () => {},
        endRestore: async () => {},
        finishRestore: () => {},
    },
}));

const { applyPayload, buildPayloadJSON } = await import('../sync/sync-payload.js');

const CAPTURE_KEY = 'guild_trial_inputs_603281';
const MARKER = 'a-captured-trial-profile';

describe('saved trial input captures never reach a sync payload', () => {
    beforeEach(() => {
        state.written = {};
        state.stores = {
            settings: { script_settingsMap: JSON.stringify({ guildTrialKeepInputs: true }) },
            combatExport: {
                [CAPTURE_KEY]: [{ format: 'toolasha-guild-trial-inputs', note: MARKER }],
                profile_list: [{ characterID: 1 }],
            },
        };
    });

    test('an everything-scope upload leaves them out and carries the rest of combatExport', async () => {
        const json = await buildPayloadJSON('everything');

        expect(json).not.toContain(CAPTURE_KEY);
        expect(json).not.toContain(MARKER);
        expect(JSON.parse(json).stores.combatExport.profile_list).toEqual([{ characterID: 1 }]);
    });

    test('a payload carrying one — an older build’s — does not plant it here', async () => {
        const payload = JSON.stringify({
            formatVersion: 1,
            exportedAt: new Date().toISOString(),
            syncScope: 'everything',
            stores: {
                combatExport: {
                    [CAPTURE_KEY]: [{ format: 'toolasha-guild-trial-inputs', note: 'another device' }],
                    profile_list: [{ characterID: 2 }],
                },
            },
        });

        await applyPayload(payload);

        expect(state.written.combatExport).toEqual({ profile_list: [{ characterID: 2 }] });
    });
});
