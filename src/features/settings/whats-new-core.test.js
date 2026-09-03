/**
 * What changed between the build you had and the build you have.
 *
 * The part that must be right is the diff: which settings are new, whether the
 * build changed at all, and — this being a fork that shares version numbers
 * with its upstream — whether a matching number is allowed to mean "nothing
 * happened" when the fork underneath it is different code.
 */

import { describe, test, expect } from 'vitest';
import {
    buildIdentity,
    identityChanged,
    describeUpdate,
    newSettingIds,
    conservativeOverrides,
} from './whats-new-core.js';

const MINE = { fork: 'Millennium44/Toolasha', version: '2.88.0' };
const MINE_NEXT = { fork: 'Millennium44/Toolasha', version: '2.89.0' };
const UPSTREAM = { fork: 'Celasha/Toolasha', version: '2.88.0' };

describe('whether the build changed', () => {
    test('a version bump on the same fork is a change', () => {
        expect(identityChanged(MINE, MINE_NEXT)).toBe(true);
    });

    test('the same number on a different fork is a change too', () => {
        // Forks share numbering; 2.88.0 → 2.88.0 across forks is different code
        // wearing the same badge, and treating it as "nothing happened" is
        // exactly the confusion conflicting build numbers cause
        expect(identityChanged(UPSTREAM, MINE)).toBe(true);
    });

    test('the same fork at the same version is not', () => {
        expect(identityChanged(MINE, { ...MINE })).toBe(false);
    });

    test('a first run has nothing to have changed from', () => {
        expect(identityChanged(null, MINE)).toBe(false);
    });
});

describe('how the update is described', () => {
    test('a fork switch is called out as one', () => {
        // "Updated to 2.88.0" would hide the only fact that matters here
        expect(describeUpdate(UPSTREAM, MINE)).toContain('Switched from Celasha/Toolasha');
    });

    test('a same-fork bump reads as an update', () => {
        expect(describeUpdate(MINE, MINE_NEXT)).toBe('Updated 2.88.0 → 2.89.0');
    });

    test('the same version on the same fork is not "Updated X → X"', () => {
        // A dev build, or a release that adds settings without a version bump
        expect(describeUpdate(MINE, MINE)).toBe('New in 2.88.0');
    });

    test('a build that does not say who it is still compares sanely', () => {
        expect(identityChanged(MINE, buildIdentity({}))).toBe(true);
        expect(buildIdentity({}).fork).toBe('unknown-fork');
    });
});

describe('which settings are new', () => {
    test('the ones the user has never been shown', () => {
        expect(newSettingIds(['a', 'b', 'c'], ['a', 'c'])).toEqual(['b']);
    });

    test('a setting removed from the schema is not resurrected', () => {
        expect(newSettingIds(['a'], ['a', 'gone'])).toEqual([]);
    });

    test('a saved settings map from another build works as the baseline', () => {
        // The settings store persists the whole merged map, so its keys are a
        // fingerprint of whichever script wrote it — including upstream, which
        // shares the storage keys. That is how the first-run choice knows what
        // this fork adds without upstream ever running a line of our code.
        const upstreamSaved = ['chatCommands', 'networth', 'marketFilter'];
        const forkSchema = ['chatCommands', 'networth', 'marketFilter', 'labSim', 'treasureTracker'];

        expect(newSettingIds(forkSchema, upstreamSaved)).toEqual(['labSim', 'treasureTracker']);
    });

    test('and the diff owes nothing to version numbers', () => {
        // Two forks at "2.88.0" with different schemas still produce the right
        // list, because the schema is the source of truth rather than the badge
        expect(newSettingIds(['a', 'forkOnly'], ['a'])).toEqual(['forkOnly']);
    });
});

describe('the conservative policy', () => {
    const SCHEMA = {
        newFeature: { type: 'checkbox', default: true },
        newQuietFeature: { type: 'checkbox', default: false },
        newThreshold: { type: 'number', default: 3 },
        newChoice: { type: 'select', default: 'ask' },
    };
    const lookup = (id) => SCHEMA[id] || null;

    test('a switch arriving on is forced off', () => {
        // That switch is the update changing behaviour unasked, which is the
        // one thing the policy exists to stop
        expect(conservativeOverrides(['newFeature'], lookup)).toEqual(['newFeature']);
    });

    test('a switch arriving off is left alone', () => {
        expect(conservativeOverrides(['newQuietFeature'], lookup)).toEqual([]);
    });

    test('numbers and dropdowns keep their defaults', () => {
        // A number has to be something; a default is not a feature turning on
        expect(conservativeOverrides(['newThreshold', 'newChoice'], lookup)).toEqual([]);
    });

    test('an id the schema does not know is skipped rather than thrown on', () => {
        expect(conservativeOverrides(['ghost'], lookup)).toEqual([]);
    });
});
