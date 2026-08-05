/**
 * Tests for Profile Cache Module
 */
import { describe, test, expect, afterEach } from 'vitest';
import { setCurrentProfile, getCurrentProfile, clearCurrentProfile } from './profile-manager.js';

afterEach(() => {
    clearCurrentProfile();
});

describe('profile-manager', () => {
    test('returns null before any profile is set', () => {
        expect(getCurrentProfile()).toBeNull();
    });

    test('setCurrentProfile stores the value returned by getCurrentProfile', () => {
        const profile = { characterID: '123', characterName: 'Alice' };
        setCurrentProfile(profile);
        expect(getCurrentProfile()).toBe(profile);
    });

    test('setCurrentProfile overwrites the previous profile', () => {
        setCurrentProfile({ characterID: '1' });
        setCurrentProfile({ characterID: '2' });
        expect(getCurrentProfile()).toEqual({ characterID: '2' });
    });

    test('clearCurrentProfile resets the cache to null', () => {
        setCurrentProfile({ characterID: '1' });
        clearCurrentProfile();
        expect(getCurrentProfile()).toBeNull();
    });
});
