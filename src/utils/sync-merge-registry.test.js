import { describe, test, expect, beforeEach, vi } from 'vitest';

import {
    registerSyncMerge,
    mergeForKey,
    listSyncMerges,
    clearSyncMerges,
    scopedKeyMatcher,
    registerSyncRetention,
    retentionDrops,
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

describe('which side wins a tie', () => {
    const second = (a, b) => b;

    test('a merge is incoming-wins everywhere unless it declares otherwise', () => {
        registerSyncMerge({ store: 'settings', key: 'plain', merge: second, label: 'plain' });
        const registration = mergeForKey('settings', 'plain');

        expect(registration.merge('local', 'incoming')).toBe('incoming');
        expect(registration.mergeForPull('local', 'incoming')).toBe('incoming');
    });

    test('localWinsOnPull turns the pull round and leaves the upload fold incoming-wins', () => {
        registerSyncMerge({ store: 'settings', key: 'tabs', merge: second, localWinsOnPull: true, label: 'tabs' });
        const registration = mergeForKey('settings', 'tabs');

        expect(registration.merge('local', 'incoming')).toBe('incoming');
        expect(registration.mergeForPull('local', 'incoming')).toBe('local');
    });
});

describe('a separate pull fold', () => {
    test('a pull folds with `pull`, everything else with `merge`', () => {
        registerSyncMerge({
            store: 'xpHistory',
            base: 'xpHistory',
            merge: () => 'union',
            pull: () => 'pull',
            localWinsOnPull: true,
        });

        const registration = mergeForKey('xpHistory', 'xpHistory_1');
        expect(registration.merge({}, {})).toBe('union');
        expect(registration.mergeForPull({}, {})).toBe('pull');
    });
});

describe('retention rules', () => {
    const parse = (key) => {
        const match = /^snap_(.+)_(\d+)$/.exec(key);
        return match ? { group: match[1], order: Number(match[2]) } : null;
    };

    test('drops all but the newest `keep` keys of each window, and nothing it does not own', () => {
        registerSyncRetention({ store: 'nw', prefix: 'snap_', parse, keep: 2 });

        const drops = retentionDrops('nw', ['snap_a_1', 'snap_a_3', 'snap_a_2', 'snap_b_1', 'snap_a', 'other_a_0']);

        expect([...drops]).toEqual(['snap_a_1']);
        expect(retentionDrops('elsewhere', ['snap_a_1', 'snap_a_2', 'snap_a_3']).size).toBe(0);
    });

    test('a key named on both sides counts once', () => {
        registerSyncRetention({ store: 'nw', prefix: 'snap_', parse, keep: 2 });

        expect(retentionDrops('nw', ['snap_a_1', 'snap_a_2', 'snap_a_1', 'snap_a_2']).size).toBe(0);
    });

    test('a second registration of the same rule is the same rule', () => {
        const off = registerSyncRetention({ store: 'nw', prefix: 'snap_', parse, keep: 1 });
        registerSyncRetention({ store: 'nw', prefix: 'snap_', parse, keep: 1 });
        off();

        expect(retentionDrops('nw', ['snap_a_1', 'snap_a_2']).size).toBe(0);
    });

    test('an age rule drops keys that ended before the cut the owner makes, which is capped by the newest key', () => {
        let clock = 100;
        registerSyncRetention({
            store: 'nw',
            prefix: 'snap_',
            parse: (key) => {
                const match = /^snap_(.+)_(\d+)$/.exec(key);
                return match ? { group: match[1], order: Number(match[2]), end: Number(match[2]) + 1 } : null;
            },
            maxAge: { floor: (newestEnd) => Math.min(clock - 10, newestEnd - 10) },
        });

        // Floor 90: a key ending at 90 stays, one ending at 89 goes
        expect([...retentionDrops('nw', ['snap_a_89', 'snap_a_88', 'snap_a_100'])]).toEqual(['snap_a_88']);
        // A clock past the newest key is capped at it (101): floor 91, so the key ending at 90 goes too
        clock = 500;
        expect([...retentionDrops('nw', ['snap_a_89', 'snap_a_90', 'snap_a_100'])]).toEqual(['snap_a_89']);
        // Rules need a count or an age
        expect(() => registerSyncRetention({ store: 'x', prefix: 'y_', parse })).toThrow();
    });

    describe('floor markers', () => {
        /** `rec_<group>_<n>` is data ending at n; `recFloor_<group>_<n>` marks the floor n */
        const parseWithMarkers = (key) => {
            const data = /^rec_(.+)_(\d+)$/.exec(key);
            if (data) return { group: data[1], order: Number(data[2]) };
            const marker = /^recFloor_(.+)_(\d+)$/.exec(key);
            return marker ? { group: marker[1], floor: Number(marker[2]) } : null;
        };

        test("drop each window's data keys below its highest marker, and the markers it supersedes", () => {
            registerSyncRetention({ store: 's', prefix: 'rec', parse: parseWithMarkers, floorMarkers: true });

            const drops = retentionDrops('s', [
                'rec_a_1',
                'rec_a_2',
                'rec_a_3',
                'recFloor_a_2',
                'recFloor_a_3',
                // Another window, with no marker: nothing of it is judged
                'rec_b_1',
                // Neither data nor marker
                'recSplit_a',
            ]);

            expect([...drops].sort()).toEqual(['recFloor_a_2', 'rec_a_1', 'rec_a_2']);
        });

        test('a marker on one side cuts the keys the other side holds', () => {
            registerSyncRetention({ store: 's', prefix: 'rec', parse: parseWithMarkers, floorMarkers: true });

            // This device holds old days; the gist holds the marker another device's cap wrote
            const local = ['rec_a_1', 'rec_a_5'];
            const remote = ['recFloor_a_4', 'rec_a_4'];

            expect([...retentionDrops('s', [...local, ...remote])]).toEqual(['rec_a_1']);
            // Without the marker, nothing
            expect(retentionDrops('s', local).size).toBe(0);
        });

        test('a rule with markers alone is a rule, and a marker is ignored by a rule without them', () => {
            expect(() =>
                registerSyncRetention({ store: 's', prefix: 'rec', parse: parseWithMarkers, floorMarkers: true })
            ).not.toThrow();
            clearSyncMerges();
            registerSyncRetention({ store: 's', prefix: 'rec', parse: parseWithMarkers, keep: 5 });

            expect(retentionDrops('s', ['rec_a_1', 'recFloor_a_9']).size).toBe(0);
        });
    });
});

describe('index retention rules', () => {
    const rule = () =>
        registerSyncRetention({
            store: 'combatExport',
            prefix: 'body_',
            parse: (key) => {
                const [, group, id] = key.split('_');
                return group && id ? { group, id } : null;
            },
            index: {
                key: (group) => `index_${group}`,
                ids: (value) => (Array.isArray(value) ? value.map((entry) => entry?.id).filter(Boolean) : null),
            },
        });
    const keys = ['index_a', 'body_a_1', 'body_a_2', 'body_a_3', 'body_b_1'];

    test('a body the index in force does not list is dropped, per group', () => {
        rule();
        const values = { index_a: [{ id: '1' }, { id: '3' }], index_b: [{ id: '1' }] };
        expect([...retentionDrops('combatExport', keys, (key) => values[key])]).toEqual(['body_a_2']);
    });

    test('a group with no index, or one that cannot be read, drops nothing', () => {
        rule();
        const values = { index_a: 'not a list' };
        expect(retentionDrops('combatExport', keys, (key) => values[key]).size).toBe(0);
    });

    test('without valueOf an index rule is not judged', () => {
        rule();
        expect(retentionDrops('combatExport', keys).size).toBe(0);
    });

    test('indexOnly leaves the count rules out', () => {
        rule();
        registerSyncRetention({
            store: 'combatExport',
            prefix: 'snap_',
            parse: (key) => ({ group: 'g', order: Number(key.slice(5)) }),
            keep: 1,
        });
        const all = [...keys, 'snap_1', 'snap_2'];
        const values = { index_a: [{ id: '1' }, { id: '2' }, { id: '3' }] };
        expect([...retentionDrops('combatExport', all, (key) => values[key])]).toEqual(['snap_1']);
        expect(retentionDrops('combatExport', all, (key) => values[key], { indexOnly: true }).size).toBe(0);
    });

    test('an index needs both key() and ids()', () => {
        expect(() =>
            registerSyncRetention({ store: 's', prefix: 'p_', parse: () => null, index: { key: () => 'x' } })
        ).toThrow();
    });
});
