/**
 * How a cached party profile is judged as a sim loadout: its age, and whether it carries gear.
 *
 * Fixtures follow the `profile_list` entry `websocket.js` stores — the parsed `profile_shared`
 * message with `characterID`, `characterName` and `timestamp` stamped on — and the game's own
 * `wearableItemMap`, keyed by full item location hrid.
 */

import { describe, test, expect } from 'vitest';
import {
    PROFILE_STALE_MS,
    formatProfileAge,
    profileCapturedAt,
    sharedProfileStatus,
    sharedProfileSummary,
    sharedProfileWarning,
} from './shared-profile-status.js';

const NOW = Date.UTC(2026, 8, 22, 12, 0, 0);
const HOUR = 60 * 60 * 1000;

/** A `profile_list` entry as websocket.js stores it */
function cachedProfile({ timestamp = NOW - HOUR, wearableItemMap, hideWearableItems = false } = {}) {
    return {
        type: 'profile_shared',
        characterID: 4242,
        characterName: 'Ally',
        // null stands for an entry cached before capture stamps existed: the key is absent
        ...(timestamp !== null && { timestamp }),
        profile: {
            sharableCharacter: { id: 4242, name: 'Ally' },
            characterSkills: [{ skillHrid: '/skills/attack', level: 95 }],
            hideWearableItems,
            wearableItemMap: wearableItemMap ?? {
                '/item_locations/main_hand': {
                    itemLocationHrid: '/item_locations/main_hand',
                    itemHrid: '/items/granite_bludgeon',
                    enhancementLevel: 7,
                },
            },
        },
    };
}

describe('sharedProfileStatus', () => {
    test('a geared profile from an hour ago is fresh', () => {
        const status = sharedProfileStatus(cachedProfile(), NOW);
        expect(status).toMatchObject({ found: true, capturedAt: NOW - HOUR, ageMs: HOUR, stale: false });
        expect(status.gearless).toBe(false);
        expect(sharedProfileWarning('Ally', status, NOW)).toBeNull();
    });

    test('past a day it is stale', () => {
        const status = sharedProfileStatus(cachedProfile({ timestamp: NOW - PROFILE_STALE_MS - 1 }), NOW);
        expect(status.stale).toBe(true);
        expect(sharedProfileWarning('Ally', status, NOW)).toMatchObject({ level: 'stale' });
    });

    test('an entry cached with no timestamp is of unknown age, never fresh', () => {
        const status = sharedProfileStatus(cachedProfile({ timestamp: null }), NOW);
        expect(status.capturedAt).toBeNull();
        expect(status.ageMs).toBeNull();
        expect(status.stale).toBe(true);
        expect(sharedProfileWarning('Ally', status, NOW).text).toContain('unknown age');
    });

    test('a garbage timestamp counts as unknown too', () => {
        expect(profileCapturedAt({ timestamp: 'yesterday' })).toBeNull();
        expect(profileCapturedAt({ timestamp: 0 })).toBeNull();
    });

    test('a profile that hides its equipment and sent none is gearless and hidden', () => {
        const status = sharedProfileStatus(cachedProfile({ wearableItemMap: {}, hideWearableItems: true }), NOW);
        expect(status).toMatchObject({ gearless: true, hidden: true });
        const warning = sharedProfileWarning('Ally', status, NOW);
        expect(warning.level).toBe('gearless');
        expect(warning.text).toContain('hides equipment');
    });

    test('hiding equipment is harmless when the game sent it anyway (a party member)', () => {
        const status = sharedProfileStatus(cachedProfile({ hideWearableItems: true }), NOW);
        expect(status).toMatchObject({ gearless: false, hidden: false });
    });

    test('no cached profile at all is its own warning', () => {
        const status = sharedProfileStatus(null, NOW);
        expect(status.found).toBe(false);
        expect(sharedProfileWarning('Ghost', status, NOW)).toMatchObject({ level: 'missing' });
    });

    test('a capture stamped slightly in the future by another tab reads as brand new', () => {
        expect(sharedProfileStatus(cachedProfile({ timestamp: NOW + 5000 }), NOW).ageMs).toBe(0);
    });

    test('a status computed earlier is re-aged by the time it is read at', () => {
        const status = sharedProfileStatus(cachedProfile({ timestamp: NOW - 23 * HOUR }), NOW);
        expect(sharedProfileWarning('Ally', status, NOW)).toBeNull();
        expect(sharedProfileWarning('Ally', status, NOW + 2 * HOUR)).toMatchObject({ level: 'stale' });
    });
});

describe('formatProfileAge', () => {
    test.each([
        [0, '1 min old'],
        [59 * 60 * 1000, '59 min old'],
        [HOUR, '1 h old'],
        [47 * HOUR, '47 h old'],
        [3 * 24 * HOUR + HOUR, '3 d old'],
        [null, 'age unknown'],
    ])('%s ms reads "%s"', (ageMs, label) => {
        expect(formatProfileAge(ageMs)).toBe(label);
    });
});

describe('sharedProfileSummary', () => {
    test('names gearless and old members, and leaves missing ones to the caller', () => {
        const statuses = [
            { name: 'Fresh', ...sharedProfileStatus(cachedProfile(), NOW) },
            { name: 'Naked', ...sharedProfileStatus(cachedProfile({ wearableItemMap: {} }), NOW) },
            { name: 'Old', ...sharedProfileStatus(cachedProfile({ timestamp: NOW - 3 * 24 * HOUR }), NOW) },
            { name: 'Ghost', ...sharedProfileStatus(null, NOW) },
        ];
        expect(sharedProfileSummary(statuses, NOW)).toBe('No gear: Naked · Old profiles: Old 3 d old');
    });

    test('says nothing when everyone is fresh and geared', () => {
        expect(sharedProfileSummary([{ name: 'Fresh', ...sharedProfileStatus(cachedProfile(), NOW) }], NOW)).toBe('');
    });
});
