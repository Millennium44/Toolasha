/**
 * The in-memory cache is the whole point of this module's risk: it is filled
 * once from storage and then read synchronously by `isExcluded`/`getExclusions`
 * on every net worth pass, which only works if it is refilled whenever the
 * character it was filled for is no longer the current one. The feature is
 * torn down and reinitialized on every character switch — see
 * `core/feature-registry.js`'s `character_switching` / `character_switched`
 * handling — and `initExclusions()` runs again on every reinit, so the cache
 * has to notice the character changed on its own rather than trusting a
 * one-shot `cache === null` check.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
    charId: 'main',
    stored: {},
    /** Fired once per read, after the value is in hand — lets a test land a switch inside one */
    onRead: null,
}));

vi.mock('../../core/storage.js', () => ({
    default: {
        getJSON: async (key, _store, fallback) => {
            const value = key in state.stored ? state.stored[key] : fallback;
            state.onRead?.();
            return value;
        },
        setJSON: async (key, value) => {
            state.stored[key] = value;
        },
    },
}));
vi.mock('../../core/data-manager.js', () => ({
    default: { getCurrentCharacterId: () => state.charId },
}));

const { initExclusions, getExclusions, isExcluded, addExclusion, removeExclusion, clearExclusions } =
    await import('./networth-exclusions.js');

beforeEach(() => {
    state.charId = 'main';
    state.onRead = null;
    state.stored = {
        networth_exclusions_main: [{ type: 'assetType', value: 'houses' }],
        networth_exclusions_iron1: [],
    };
});

describe('per-character caching', () => {
    test('initExclusions loads the current character’s own list', async () => {
        await initExclusions();
        expect(getExclusions()).toEqual([{ type: 'assetType', value: 'houses' }]);
    });

    test('switching character and reinitializing picks up the new character’s list, not the old one', async () => {
        await initExclusions();
        expect(isExcluded('assetType', 'houses')).toBe(true);

        // The feature's disable()/initialize() cycle on a character switch —
        // reinitializing is the only hook this module gets, so it has to be
        // the one that notices the character changed
        state.charId = 'iron1';
        await initExclusions();

        expect(getExclusions()).toEqual([]);
        expect(isExcluded('assetType', 'houses')).toBe(false);
    });

    test('an exclusion added after switching is written to the new character’s own key, not merged onto the old one', async () => {
        await initExclusions();
        state.charId = 'iron1';
        await initExclusions();

        await addExclusion('item', '/items/cheese');

        expect(state.stored.networth_exclusions_iron1).toEqual([{ type: 'item', value: '/items/cheese' }]);
        // The character left behind keeps exactly what it had
        expect(state.stored.networth_exclusions_main).toEqual([{ type: 'assetType', value: 'houses' }]);
    });

    test('removing an exclusion after switching touches only the current character’s list', async () => {
        state.stored.networth_exclusions_iron1 = [{ type: 'ability', value: '/abilities/hammer_throw' }];
        await initExclusions();
        state.charId = 'iron1';
        await initExclusions();

        await removeExclusion('ability', '/abilities/hammer_throw');

        expect(state.stored.networth_exclusions_iron1).toEqual([]);
        expect(state.stored.networth_exclusions_main).toEqual([{ type: 'assetType', value: 'houses' }]);
    });

    test('clearExclusions after switching clears the current character, not the previous one', async () => {
        await initExclusions();
        state.charId = 'iron1';
        state.stored.networth_exclusions_iron1 = [{ type: 'category', value: '/item_categories/food' }];
        await initExclusions();

        await clearExclusions();

        expect(state.stored.networth_exclusions_iron1).toEqual([]);
        expect(state.stored.networth_exclusions_main).toEqual([{ type: 'assetType', value: 'houses' }]);
    });
});

describe('a character switch landing inside the load', () => {
    test('the exclusion is not written over the arriving character’s list', async () => {
        // A cold read — the cache is empty or belongs to somebody else — is a
        // real IndexedDB round trip, and the write that follows it is a full
        // overwrite with no merge, so the arriving character's list would be
        // replaced rather than added to.
        state.onRead = () => {
            state.onRead = null;
            state.charId = 'iron1';
        };

        await addExclusion('item', '/items/cheese');

        expect(state.stored.networth_exclusions_iron1).toEqual([]);
        expect(state.stored.networth_exclusions_main).toEqual([{ type: 'assetType', value: 'houses' }]);
    });
});
