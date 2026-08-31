import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
    registerSyncMerge,
    mergeForKey,
    listSyncMerges,
    clearSyncMerges,
    scopedKeyMatcher,
} from './sync-merge-registry.js';

beforeEach(() => {
    clearSyncMerges();
});

describe('matching', () => {
    test('an exact key matches only itself', () => {
        registerSyncMerge({ store: 'leaderboardHistory', key: 'playerXP', merge: (a) => a, label: 'players' });

        expect(mergeForKey('leaderboardHistory', 'playerXP')?.label).toBe('players');
        expect(mergeForKey('leaderboardHistory', 'playerXP_char-A')).toBeNull();
    });

    test('a scoped base matches the bare key and every character suffix', () => {
        registerSyncMerge({ store: 'settings', base: 'treasureTally', merge: (a) => a, label: 'tally' });

        expect(mergeForKey('settings', 'treasureTally')).not.toBeNull();
        expect(mergeForKey('settings', 'treasureTally_char-A')).not.toBeNull();
        // The pre-scoping bare key is worth merging; a different record whose
        // name merely starts the same is not
        expect(mergeForKey('settings', 'treasureTallySettings')).toBeNull();
    });

    test('a prefix matches anything under it', () => {
        registerSyncMerge({ store: 'guildHistory', prefix: 'guildXP_', merge: (a) => a, label: 'guild xp' });

        expect(mergeForKey('guildHistory', 'guildXP_Some Guild')).not.toBeNull();
        expect(mergeForKey('guildHistory', 'guildTrials_Some Guild')).toBeNull();
    });

    test('the store has to match too', () => {
        registerSyncMerge({ store: 'settings', key: 'shared', merge: (a) => a, label: 'settings copy' });

        expect(mergeForKey('settings', 'shared')).not.toBeNull();
        expect(mergeForKey('xpHistory', 'shared')).toBeNull();
    });

    test('an unregistered key has no merge, which is what makes whole-key writes the default', () => {
        expect(mergeForKey('settings', 'watchlist')).toBeNull();
        expect(mergeForKey('settings', 'script_settingsMap_abc')).toBeNull();
        expect(mergeForKey(null, 'anything')).toBeNull();
        expect(mergeForKey('settings', null)).toBeNull();
    });

    test('the first registration wins, so a narrow key can be declared before a broad prefix', () => {
        registerSyncMerge({ store: 's', key: 'a_special', merge: (a) => a, label: 'narrow' });
        registerSyncMerge({ store: 's', prefix: 'a_', merge: (a) => a, label: 'broad' });

        expect(mergeForKey('s', 'a_special')?.label).toBe('narrow');
        expect(mergeForKey('s', 'a_other')?.label).toBe('broad');
    });

    test('a matcher that throws does not take the whole registry down with it', () => {
        registerSyncMerge({
            store: 's',
            match: () => {
                throw new Error('nope');
            },
            merge: (a) => a,
            label: 'broken',
        });
        registerSyncMerge({ store: 's', key: 'k', merge: (a) => a, label: 'fine' });

        expect(mergeForKey('s', 'k')?.label).toBe('fine');
    });
});

describe('registration', () => {
    test('the merge is handed back as `merge(local, incoming)`', () => {
        registerSyncMerge({
            store: 's',
            key: 'k',
            merge: (local, incoming) => [...local, ...incoming],
            label: 'concat',
        });

        expect(mergeForKey('s', 'k').merge([1], [2])).toEqual([1, 2]);
    });

    test('unregistering removes it again', () => {
        const off = registerSyncMerge({ store: 's', key: 'k', merge: (a) => a, label: 'temp' });
        expect(mergeForKey('s', 'k')).not.toBeNull();

        off();
        expect(mergeForKey('s', 'k')).toBeNull();
        // Calling it twice is not an error
        off();
    });

    test('a registration without a matcher or a merge is refused', () => {
        expect(() => registerSyncMerge({ store: 's', merge: (a) => a })).toThrow();
        expect(() => registerSyncMerge({ store: 's', key: 'k' })).toThrow();
        expect(() => registerSyncMerge({ key: 'k', merge: (a) => a })).toThrow();
    });

    test('the label falls back to whatever identified the key', () => {
        registerSyncMerge({ store: 's', key: 'named', merge: (a) => a });
        expect(listSyncMerges()).toEqual([{ store: 's', label: 'named' }]);
    });

    test('a bundle copy making the identical claim is deduped, and either remover clears it', () => {
        // The packaged build loads some modules in more than one bundle; each
        // copy registers the same claim with the same label
        registerSyncMerge({ store: 's', base: 'rec', merge: () => 'first', label: 'records' });
        const offSecond = registerSyncMerge({ store: 's', base: 'rec', merge: () => 'second', label: 'records' });

        expect(listSyncMerges()).toEqual([{ store: 's', label: 'records' }]);
        expect(mergeForKey('s', 'rec_char-A').merge()).toBe('first');

        // The second caller's remover clears the shared registration
        offSecond();
        expect(mergeForKey('s', 'rec_char-A')).toBeNull();
    });

    test('a different claim sharing a defaulted label is not a duplicate', () => {
        // `base: 'rec'` and `prefix: 'rec'` both default their label to 'rec',
        // but they are different claims: only the prefix one covers 'recXYZ'
        registerSyncMerge({ store: 's', base: 'rec', merge: () => 'scoped' });
        registerSyncMerge({ store: 's', prefix: 'rec', merge: () => 'raw' });

        expect(listSyncMerges()).toHaveLength(2);
        // 'recXYZ' is only the prefix claim's; dropping it as a duplicate
        // would silently fall back to a whole-key write
        expect(mergeForKey('s', 'recXYZ')?.merge()).toBe('raw');
    });

    test('two match-only claims on one store both defaulting to label=store both survive', () => {
        registerSyncMerge({ store: 's', match: (k) => k === 'alpha', merge: () => 'alpha merge' });
        registerSyncMerge({ store: 's', match: (k) => k === 'beta', merge: () => 'beta merge' });

        expect(mergeForKey('s', 'alpha')?.merge()).toBe('alpha merge');
        expect(mergeForKey('s', 'beta')?.merge()).toBe('beta merge');
    });

    test("a non-duplicate's remover removes its own claim, not the earlier one", () => {
        registerSyncMerge({ store: 's', base: 'rec', merge: () => 'scoped' });
        const offPrefix = registerSyncMerge({ store: 's', prefix: 'rec', merge: () => 'raw' });

        offPrefix();
        expect(mergeForKey('s', 'recXYZ')).toBeNull();
        expect(mergeForKey('s', 'rec_char-A')?.merge()).toBe('scoped');
    });
});

describe('scopedKeyMatcher', () => {
    test('is the bare key or the key plus a suffix', () => {
        const match = scopedKeyMatcher('xpHistory');
        expect(match('xpHistory')).toBe(true);
        expect(match('xpHistory_char-A')).toBe(true);
        expect(match('xpHistoryOther')).toBe(false);
        expect(match('other_xpHistory')).toBe(false);
    });
});

describe('overlapping matchers are a bug, and are reported as one', () => {
    test('two registrations claiming the same key warn once, and the first still wins', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        clearSyncMerges();

        registerSyncMerge({ store: 's', prefix: 'rec_', merge: () => 'first', label: 'first' });
        registerSyncMerge({ store: 's', key: 'rec_one', merge: () => 'second', label: 'second' });

        // Registration order is bundle import order, which is the build's
        // decision rather than anyone's intent — hence the warning
        expect(mergeForKey('s', 'rec_one').label).toBe('first');
        expect(warnSpy).toHaveBeenCalledTimes(1);
        expect(warnSpy.mock.calls[0][0]).toContain('must not overlap');

        // The same pair again does not fill the console; a payload has
        // thousands of keys
        mergeForKey('s', 'rec_one');
        expect(warnSpy).toHaveBeenCalledTimes(1);

        warnSpy.mockRestore();
    });

    test('a key claimed by exactly one registration says nothing', () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
        clearSyncMerges();

        registerSyncMerge({ store: 's', prefix: 'rec_', merge: () => 'only', label: 'only' });

        expect(mergeForKey('s', 'rec_one').label).toBe('only');
        expect(warnSpy).not.toHaveBeenCalled();

        warnSpy.mockRestore();
    });
});
