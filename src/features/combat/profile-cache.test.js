import { describe, test, expect, beforeEach } from 'vitest';
import { setCurrentProfile, getCurrentProfile, clearCurrentProfile } from './profile-cache.js';

describe('profile cache', () => {
    beforeEach(() => {
        clearCurrentProfile();
    });

    test('starts empty', () => {
        expect(getCurrentProfile()).toBeNull();
    });

    test('remembers the last profile set', () => {
        const profile = { characterId: 'abc', name: 'Millennium44' };
        setCurrentProfile(profile);

        expect(getCurrentProfile()).toBe(profile);
    });

    test('a later set replaces the earlier one, not merges with it', () => {
        setCurrentProfile({ characterId: 'abc' });
        setCurrentProfile({ characterId: 'def' });

        expect(getCurrentProfile()).toEqual({ characterId: 'def' });
    });

    test('clear empties the cache', () => {
        setCurrentProfile({ characterId: 'abc' });
        clearCurrentProfile();

        expect(getCurrentProfile()).toBeNull();
    });
});
